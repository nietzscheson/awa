from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from httpx import AsyncClient

from src.main import (
    DEFAULT_INTERVIEW_QUESTIONNAIRE,
    AwaApiService,
    InterviewEngine,
    InterviewQuestion,
    InterviewQuestionnaire,
    InterviewQuestionType,
    MainContainer,
    Settings,
    UserTypeProfession,
    _looks_like_short_conversation_opener,
    parse_interview_answer,
)

# Stable user_id for InterviewEngine unit tests (must match ADK identity semantics).
_INTERVIEW_USER_ID = "pytest-interview-user"


def test_settings_normalizes_plain_postgresql_database_url():
    raw = "postgresql://postgres:postgres@localhost:6543/postgres"
    assert (
        Settings(DATABASE_URL=raw).DATABASE_URL
        == "postgresql+psycopg://postgres:postgres@localhost:6543/postgres"
    )
    assert (
        Settings(DATABASE_URL="postgres://h:p@host:1/db").DATABASE_URL
        == "postgresql+psycopg://h:p@host:1/db"
    )
    unchanged = "postgresql+asyncpg://u:p@localhost/db"
    assert unchanged == Settings(DATABASE_URL=unchanged).DATABASE_URL


async def test_health(http_client: AsyncClient, main_container: MainContainer):
    response = await http_client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"message": "healthy"}


async def test_create_session(http_client: AsyncClient):
    session_id = f"s-{uuid.uuid4().hex}"
    user_id = f"u-{uuid.uuid4().hex}"
    response = await http_client.post(
        "/sessions",
        json={
            "session_id": session_id,
            "user_id": user_id,
            "language": "es-MX",
            "metadata": {"pytest": True},
        },
    )
    assert response.status_code == 200
    assert response.json() == {"session_id": session_id, "user_id": user_id}


async def test_create_session_conflict(http_client: AsyncClient):
    session_id = f"s-{uuid.uuid4().hex}"
    user_id = f"u-{uuid.uuid4().hex}"
    first = await http_client.post(
        "/sessions",
        json={"session_id": session_id, "user_id": user_id},
    )
    assert first.status_code == 200
    second = await http_client.post(
        "/sessions",
        json={"session_id": session_id, "user_id": user_id},
    )
    assert second.status_code == 409


async def test_chat_requires_nonempty_text(http_client: AsyncClient):
    session_id = f"s-{uuid.uuid4().hex}"
    user_id = f"u-{uuid.uuid4().hex}"
    await http_client.post(
        "/sessions",
        json={"session_id": session_id, "user_id": user_id},
    )
    response = await http_client.post(
        "/chat",
        json={
            "user_id": user_id,
            "session_id": session_id,
            "new_message": {"parts": [{"text": "   "}]},
        },
    )
    assert response.status_code == 400


async def test_chat_unknown_session(http_client: AsyncClient):
    response = await http_client.post(
        "/chat",
        json={
            "user_id": "no-such-user",
            "session_id": "no-such-session",
            "new_message": {"parts": [{"text": "hello"}]},
        },
    )
    assert response.status_code == 404


async def test_chat_with_session_uses_stubbed_turn(
    http_client: AsyncClient, monkeypatch
):
    async def _stub_run_turn(
        self, *, user_id: str, session_id: str, user_text: str
    ) -> str:
        return "stub-model-reply"

    monkeypatch.setattr(AwaApiService, "_run_turn_text", _stub_run_turn)

    session_id = f"s-{uuid.uuid4().hex}"
    user_id = f"u-{uuid.uuid4().hex}"
    await http_client.post(
        "/sessions",
        json={"session_id": session_id, "user_id": user_id},
    )
    response = await http_client.post(
        "/chat",
        json={
            "user_id": user_id,
            "session_id": session_id,
            "new_message": {"parts": [{"text": "ping"}]},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["session_id"] == session_id
    assert body["response"] == "stub-model-reply"


def test_interview_engine_start_returns_first_question():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    session_identifier = f"interview-{uuid.uuid4().hex}"
    reply = engine.start_interview(_INTERVIEW_USER_ID, session_identifier)
    assert reply.reply_accepted is True
    assert reply.interview_is_complete is False
    assert reply.current_question_identifier == "full_name"
    assert reply.assistant_reply_message == (
        "Please confirm your full legal name as it should appear on official records."
    )


def test_interview_engine_start_is_idempotent_for_existing_session():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    session_identifier = f"interview-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, session_identifier)
    engine.submit_answer(_INTERVIEW_USER_ID, session_identifier, "Ada Lovelace")
    second = engine.start_interview(_INTERVIEW_USER_ID, session_identifier)
    assert second.current_question_identifier != "full_name"


def test_interview_engine_short_questionnaire_completes_after_years():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    session_identifier = f"interview-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, session_identifier)
    engine.submit_answer(_INTERVIEW_USER_ID, session_identifier, "Test User")
    desc = engine.submit_answer(
        _INTERVIEW_USER_ID,
        session_identifier,
        "Plumber, employed full-time at a small company",
    )
    assert desc.reply_accepted is True
    assert desc.next_question_identifier == "years_in_profession"
    rec = engine.record_identified_employment_type(
        _INTERVIEW_USER_ID, session_identifier, UserTypeProfession.EMPLOYEE.value
    )
    assert rec["ok"] is True
    years = engine.submit_answer(_INTERVIEW_USER_ID, session_identifier, "8")
    assert years.reply_accepted is True
    assert years.interview_is_complete is True
    assert years.next_question_identifier is None


def test_interview_engine_validation_rejects_non_numeric_years():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    session_identifier = f"interview-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, session_identifier)
    engine.submit_answer(_INTERVIEW_USER_ID, session_identifier, "Test User")
    engine.submit_answer(_INTERVIEW_USER_ID, session_identifier, "Welder at a factory")
    engine.record_identified_employment_type(
        _INTERVIEW_USER_ID, session_identifier, UserTypeProfession.EMPLOYEE.value
    )
    invalid = engine.submit_answer(
        _INTERVIEW_USER_ID, session_identifier, "not-a-number"
    )
    assert invalid.reply_accepted is False
    assert invalid.validation_error_message == "unrecognized_number"
    assert "número" in invalid.assistant_reply_message.lower()


def test_parse_interview_choice_accepts_spanish_synonyms_inline():
    question = InterviewQuestion(
        question_identifier="level",
        question_text="Level?",
        question_type=InterviewQuestionType.CHOICE,
        choice_options=["beginner", "intermediate", "advanced"],
        choice_option_labels={
            "beginner": ["principiante"],
            "intermediate": ["intermedio", "medio"],
        },
    )
    parsed = parse_interview_answer(question, "  principiante  ")
    assert parsed.stored_answer_text == "beginner"
    parsed_mid = parse_interview_answer(question, "soy nivel intermedio")
    assert parsed_mid.stored_answer_text == "intermediate"


def test_record_identified_employment_type_accepts_and_rejects():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    sid = f"interview-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, sid)
    ok = engine.record_identified_employment_type(
        _INTERVIEW_USER_ID, sid, UserTypeProfession.RETIRED.value
    )
    assert ok["ok"] is True
    assert (
        engine.export_answers(_INTERVIEW_USER_ID, sid)["identified_employment_type"]
        == UserTypeProfession.RETIRED.value
    )
    bad = engine.record_identified_employment_type(
        _INTERVIEW_USER_ID, sid, "pensionado"
    )
    assert bad["ok"] is False


def test_parse_interview_number_extracts_embedded_digit():
    question = DEFAULT_INTERVIEW_QUESTIONNAIRE.get_question_by_identifier(
        "years_in_profession"
    )
    assert question is not None
    parsed = parse_interview_answer(question, "unos 12 años en total")
    assert parsed.stored_answer_text == "12"


def test_parse_interview_number_accepts_spanish_cardinal_words():
    question = DEFAULT_INTERVIEW_QUESTIONNAIRE.get_question_by_identifier(
        "years_in_profession"
    )
    assert question is not None
    parsed = parse_interview_answer(question, "Quince años")
    assert parsed.stored_answer_text == "15"


def test_parse_interview_number_accepts_treinta_y_cinco():
    question = DEFAULT_INTERVIEW_QUESTIONNAIRE.get_question_by_identifier(
        "years_in_profession"
    )
    assert question is not None
    parsed = parse_interview_answer(question, "llevo treinta y cinco años")
    assert parsed.stored_answer_text == "35"


def test_submit_interview_returns_structured_answer_on_success():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    session_identifier = f"interview-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, session_identifier)
    reply = engine.submit_answer(_INTERVIEW_USER_ID, session_identifier, "Ada")
    assert reply.structured_answer is not None
    assert reply.structured_answer.stored_answer_text == "Ada"
    assert reply.structured_answer.raw_user_text == "Ada"


def test_interview_engine_reset_clears_progress():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    session_identifier = f"interview-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, session_identifier)
    engine.submit_answer(_INTERVIEW_USER_ID, session_identifier, "Someone")
    reset = engine.reset_interview(_INTERVIEW_USER_ID, session_identifier)
    assert reset.current_question_identifier == "full_name"


def test_interview_engine_export_includes_answers():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    session_identifier = f"interview-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, session_identifier)
    engine.submit_answer(_INTERVIEW_USER_ID, session_identifier, "Exported User")
    exported = engine.export_answers(_INTERVIEW_USER_ID, session_identifier)
    assert exported["answers_by_question_identifier"]["full_name"] == "Exported User"


def test_awa_api_service_interview_turn_context_block_matches_engine():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    service = AwaApiService(
        runner=MagicMock(),
        session_service=MagicMock(),
        interview_engine=engine,
    )
    session_id = f"s-{uuid.uuid4().hex}"
    block = service._interview_turn_context_block(_INTERVIEW_USER_ID, session_id)
    assert block is not None
    assert "question_text_verbatim:" in block
    assert "Please confirm your full legal name" in block
    assert "current_question_identifier: full_name" in block


def test_interview_engine_graph_skips_ineligible_follow_up_question():
    questionnaire = InterviewQuestionnaire(
        question_list=[
            InterviewQuestion(
                question_identifier="gate",
                question_text="Gate?",
                question_type=InterviewQuestionType.BOOLEAN,
            ),
            InterviewQuestion(
                question_identifier="follow_up_only_if_yes",
                question_text="Follow up?",
                question_type=InterviewQuestionType.TEXT,
                prerequisite_question_identifier="gate",
                prerequisite_expected_answer_text="yes",
            ),
            InterviewQuestion(
                question_identifier="always_asked",
                question_text="Final?",
                question_type=InterviewQuestionType.TEXT,
            ),
        ]
    )
    engine = InterviewEngine(questionnaire=questionnaire)
    session_identifier = "graph-unit-test"
    engine.start_interview(_INTERVIEW_USER_ID, session_identifier)
    engine.submit_answer(_INTERVIEW_USER_ID, session_identifier, "no")
    reply = engine.get_current_question(_INTERVIEW_USER_ID, session_identifier)
    assert reply.next_question_identifier == "always_asked"


def test_interview_engine_state_isolated_by_user_id_same_session_id():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    session_id = "shared-session-identifier"
    engine.start_interview("user-alice", session_id)
    engine.submit_answer("user-alice", session_id, "Alice A.")
    isabella = engine.get_current_question("user-isabella", session_id)
    assert isabella.interview_is_complete is False
    assert isabella.current_question_identifier == "full_name"


def test_looks_like_short_conversation_opener():
    assert _looks_like_short_conversation_opener("Hola")
    assert _looks_like_short_conversation_opener("Hola Isabella")
    assert _looks_like_short_conversation_opener("Buenos días")
    assert _looks_like_short_conversation_opener("  hi there  ")
    assert not _looks_like_short_conversation_opener("Me llamo Juan Pérez")
    assert not _looks_like_short_conversation_opener("x" * 200)


def test_greeting_soft_restarts_after_interview_complete_in_ram():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    sid = f"interview-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, sid)
    engine.submit_answer(_INTERVIEW_USER_ID, sid, "Ada Lovelace")
    engine.submit_answer(_INTERVIEW_USER_ID, sid, "Teacher, school employee")
    engine.record_identified_employment_type(
        _INTERVIEW_USER_ID, sid, UserTypeProfession.EMPLOYEE.value
    )
    engine.submit_answer(_INTERVIEW_USER_ID, sid, "10")
    assert (
        engine.export_answers(_INTERVIEW_USER_ID, sid)["interview_is_complete"] is True
    )
    if engine.export_answers(_INTERVIEW_USER_ID, sid)[
        "interview_is_complete"
    ] and _looks_like_short_conversation_opener("Hola"):
        engine.reset_interview(_INTERVIEW_USER_ID, sid)
    again = engine.get_current_question(_INTERVIEW_USER_ID, sid)
    assert again.interview_is_complete is False
    assert again.current_question_identifier == "full_name"


def test_forget_interview_state_clears_ram_progress():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    user_id, session_id = "user-reset", f"s-{uuid.uuid4().hex}"
    engine.start_interview(user_id, session_id)
    engine.submit_answer(user_id, session_id, "Step One")
    engine.forget_interview_state(user_id, session_id)
    again = engine.get_current_question(user_id, session_id)
    assert again.current_question_identifier == "full_name"


def test_submit_current_if_primitive_parses_accepts_spanish_quince_on_years():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    sid = f"s-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, sid)
    engine.submit_answer(_INTERVIEW_USER_ID, sid, "Full Name Test")
    engine.submit_answer(_INTERVIEW_USER_ID, sid, "Shop assistant, part-time retail")
    engine.record_identified_employment_type(
        _INTERVIEW_USER_ID, sid, UserTypeProfession.EMPLOYEE.value
    )
    auto = engine.submit_current_if_primitive_parses(_INTERVIEW_USER_ID, sid, "Quince")
    assert auto is not None
    assert auto.reply_accepted is True
    assert auto.interview_is_complete is True
    assert auto.next_question_identifier is None
    nxt = engine.get_current_question(_INTERVIEW_USER_ID, sid)
    assert nxt.interview_is_complete is True


def test_submit_current_if_primitive_parses_returns_none_when_number_does_not_parse():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    sid = f"s-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, sid)
    engine.submit_answer(_INTERVIEW_USER_ID, sid, "X")
    engine.submit_answer(_INTERVIEW_USER_ID, sid, "Cook in a restaurant")
    engine.record_identified_employment_type(
        _INTERVIEW_USER_ID, sid, UserTypeProfession.EMPLOYEE.value
    )
    assert (
        engine.submit_current_if_primitive_parses(_INTERVIEW_USER_ID, sid, "xyzabc")
        is None
    )


def test_submit_current_if_primitive_parses_returns_none_on_text_question():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    sid = f"s-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, sid)
    assert (
        engine.submit_current_if_primitive_parses(_INTERVIEW_USER_ID, sid, "Hola")
        is None
    )


def test_submit_current_if_primitive_parses_accepts_numeric_years_then_interview_done():
    engine = InterviewEngine(questionnaire=DEFAULT_INTERVIEW_QUESTIONNAIRE)
    sid = f"s-{uuid.uuid4().hex}"
    engine.start_interview(_INTERVIEW_USER_ID, sid)
    engine.submit_answer(_INTERVIEW_USER_ID, sid, "A")
    engine.submit_answer(_INTERVIEW_USER_ID, sid, "Plumber, full-time employee")
    engine.record_identified_employment_type(
        _INTERVIEW_USER_ID, sid, UserTypeProfession.EMPLOYEE.value
    )
    auto = engine.submit_current_if_primitive_parses(_INTERVIEW_USER_ID, sid, "3")
    assert auto is not None
    assert auto.reply_accepted is True
    assert auto.interview_is_complete is True
    assert auto.next_question_identifier is None
