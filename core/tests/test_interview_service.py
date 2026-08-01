"""Unit tests for the live streaming agent's interview tool (``InterviewService``).

These exercise the tool functions directly with a minimal fake ``ToolContext``
(only ``.state`` is used), so no Gemini / database is needed.
"""

from __future__ import annotations

from types import SimpleNamespace

from src.services import InterviewService


def _ctx(**state):
    """A stand-in ToolContext exposing the seeded session ``state`` dict."""
    return SimpleNamespace(state=dict(state))


def test_confirmation_questions_lead_the_questionnaire():
    questions = InterviewService._questions()
    assert [q.id for q in questions[:2]] == ["confirm_name", "confirm_address"]


def test_start_interview_fills_name_from_metadata():
    ctx = _ctx(first_name="Cristian", last_name="Angulo")
    reply = InterviewService.start_interview(ctx)

    assert reply["status"] == "started"
    assert reply["question"]["id"] == "confirm_name"
    assert "Cristian Angulo" in reply["question"]["question"]


def test_address_confirmation_uses_ine_address_metadata():
    ctx = _ctx(
        first_name="Cristian",
        last_name="Angulo",
        ine_address="Monte Leon de Piedad 237. Ciudad de México",
    )
    InterviewService.start_interview(ctx)
    # Answer the name confirmation → next question is the address confirmation.
    reply = InterviewService.submit_answer(ctx, "yes")

    assert reply["next_question"]["id"] == "confirm_address"
    assert "Monte Leon de Piedad 237" in reply["next_question"]["question"]


def test_get_current_question_renders_with_metadata():
    ctx = _ctx(first_name="Ada", last_name="Lovelace")
    InterviewService.start_interview(ctx)
    current = InterviewService.get_current_question(ctx)
    assert "Ada Lovelace" in current["question"]["question"]


def test_missing_metadata_falls_back_to_placeholders():
    ctx = _ctx()  # no first_name / last_name / ine_address
    reply = InterviewService.start_interview(ctx)
    text = reply["question"]["question"]
    # No leftover "{...}" template markers, and a friendly fallback is used.
    assert "{" not in text and "}" not in text
    assert "your name" in text


def test_plain_questions_pass_through_unchanged():
    ctx = _ctx(first_name="Ada", last_name="Lovelace")
    InterviewService.start_interview(ctx)
    # The name confirmation already captures the name, so the first plain
    # question after the two confirmations is "What is your age?".
    InterviewService.submit_answer(ctx, "yes")  # confirm_name
    third = InterviewService.submit_answer(ctx, "yes")  # confirm_address
    assert third["next_question"]["question"] == "What is your age?"


def test_full_flow_completes_after_all_questions():
    ctx = _ctx(first_name="Ada", last_name="Lovelace", ine_address="Calle 1")
    InterviewService.start_interview(ctx)
    total = len(InterviewService._questions())
    last = None
    for _ in range(total):
        last = InterviewService.submit_answer(ctx, "respuesta")
    assert last is not None and last["is_complete"] is True
    assert ctx.state["total_answered"] == total


def _complete_interview(**metadata):
    """Answer every question, so the confirmation step is reachable."""
    ctx = _ctx(**metadata)
    reply = InterviewService.start_interview(ctx)
    answers = ["yes", "yes", "31", "ada@example.com", "555-0100"]
    for answer in answers:
        reply = InterviewService.submit_answer(ctx, answer)
    assert reply["is_complete"] is True
    return ctx


def test_review_answers_reads_back_every_answer_in_order():
    ctx = _complete_interview(first_name="Ada", last_name="Lovelace")
    review = InterviewService.review_answers(ctx)

    assert review["is_complete"] is True
    assert review["confirmed"] is False
    assert [item["id"] for item in review["answers"]] == [
        "confirm_name",
        "confirm_address",
        "2",
        "3",
        "4",
    ]
    # The question text is the rendered one — what was actually asked.
    assert "Ada Lovelace" in review["answers"][0]["question"]
    assert review["answers"][3]["answer"] == "ada@example.com"


def test_correct_answer_replaces_one_answer_without_advancing():
    ctx = _complete_interview()
    before = ctx.state["current_question_index"]

    reply = InterviewService.correct_answer(
        ctx, question_id="3", answer="ada@lovelace.io"
    )

    assert reply["status"] == "success"
    assert reply["corrected"]["answer"] == "ada@lovelace.io"
    assert ctx.state["answers"]["3"] == "ada@lovelace.io"
    # A correction is not a new answer: the questionnaire stays finished.
    assert ctx.state["current_question_index"] == before
    assert ctx.state["total_answered"] == 5


def test_correction_after_confirmation_reopens_the_confirmation():
    ctx = _complete_interview()
    assert InterviewService.confirm_interview(ctx)["status"] == "confirmed"

    InterviewService.correct_answer(ctx, question_id="2", answer="32")

    # What was confirmed is no longer what is stored, so it must be asked again.
    assert ctx.state["interview_confirmed"] is False
    assert InterviewService.review_answers(ctx)["confirmed"] is False


def test_correct_answer_rejects_an_unknown_question_and_lists_the_valid_ones():
    ctx = _complete_interview()

    reply = InterviewService.correct_answer(ctx, question_id="nope", answer="x")

    assert reply["status"] == "error"
    assert "nope" in reply["error_message"]
    assert "confirm_name" in reply["valid_question_ids"]
    assert ctx.state["answers"].get("nope") is None


def test_confirm_interview_refuses_before_the_questions_are_done():
    ctx = _ctx()
    InterviewService.start_interview(ctx)
    InterviewService.submit_answer(ctx, "yes")

    reply = InterviewService.confirm_interview(ctx)

    assert reply["status"] == "error"
    assert reply["questions_remaining"] == 4
    assert ctx.state["interview_confirmed"] is False


def test_confirm_interview_seals_the_interview_and_returns_the_record():
    ctx = _complete_interview(first_name="Ada")

    reply = InterviewService.confirm_interview(ctx)

    assert reply["status"] == "confirmed"
    assert ctx.state["interview_confirmed"] is True
    assert len(reply["answers"]) == 5


def test_restarting_clears_a_previous_confirmation():
    ctx = _complete_interview()
    InterviewService.confirm_interview(ctx)

    InterviewService.start_interview(ctx)
    assert ctx.state["interview_confirmed"] is False

    InterviewService.reset_interview(ctx)
    assert ctx.state["interview_confirmed"] is False
