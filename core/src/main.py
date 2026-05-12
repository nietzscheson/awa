# from __future__ import annotations
#
# import json
# import logging
# import re
# import warnings
# from contextlib import aclosing, asynccontextmanager
# from dataclasses import dataclass, field
# from typing import Any, Literal, TypedDict
#
# from authlib.deprecate import AuthlibDeprecationWarning
# from dependency_injector import providers
# from dependency_injector.wiring import Provide, inject
# from fastapi import APIRouter, Depends, FastAPI, HTTPException
# from fastapi.responses import StreamingResponse
# from langgraph.graph import END, START, StateGraph
# from pydantic import BaseModel, ConfigDict, Field, model_validator
#
# warnings.filterwarnings("ignore", category=AuthlibDeprecationWarning)
# warnings.filterwarnings(
#    "ignore",
#    category=UserWarning,
#    module="google.adk.features._feature_decorator",
# )
#
#
# def _suppress_google_genai_mixed_candidate_parts_warning() -> None:
#    """Drop the SDK warning when ``response.text`` concatenates text alongside tool calls.
#
#    Gemini often returns ``function_call`` parts in the same candidate as assistant text.
#    Using only the text parts is correct for speech/UI; the warning is noisy for agents.
#    """
#
#    class _DropMixedPartsTextWarning(logging.Filter):
#        def filter(self, record: logging.LogRecord) -> bool:
#            if record.levelno != logging.WARNING:
#                return True
#            msg = record.getMessage()
#            return not msg.startswith(
#                "Warning: there are non-text parts in the response:"
#            )
#
#    logging.getLogger("google_genai.types").addFilter(_DropMixedPartsTextWarning())
#
#
# _suppress_google_genai_mixed_candidate_parts_warning()
#
# from google.adk.errors.already_exists_error import AlreadyExistsError
# from google.adk.errors.session_not_found_error import SessionNotFoundError
# from google.adk.events.event import Event
# from google.adk.events.event_actions import EventActions
# from google.adk.runners import Runner
# from google.adk.sessions.base_session_service import (
#    BaseSessionService,
#    GetSessionConfig,
# )
# from google.adk.sessions.state import State
# from google.genai import types
#
# from src.interview_answer_agent import (
#    DeterministicInterviewAnswerNormalizer,
#    InterviewAnswerNormalizer,
#    InterviewNormalizationRejected,
#    build_interview_answer_normalizer,
#    deterministic_parse_interview_response,
# )
#
# _EMPLOYMENT_TYPE_ENUM_DOC = ", ".join(m.value for m in UserTypeProfession)
#
## Voice web client sends this as the first ``/chat`` body so the model speaks first (no user hello).
# VOICE_SESSION_OPENING_SIGNAL = "__AWA_VOICE_SESSION_OPENING__"
#
#
# def _sse_data(payload: dict[str, Any]) -> bytes:
#    """One Server-Sent Events frame (UTF-8 JSON in ``data:``)."""
#    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()
#
#
# def _event_is_assistant_speech(event: Event) -> bool:
#    """True for model output events.
#
#    Gemini often omits ``content.role`` on assistant turns; ADK sets ``author`` to the
#    agent name (e.g. ``awa_agent``). Relying only on ``role == \"model\"`` misses
#    those events and breaks streaming / final reply extraction.
#    """
#    if not event.content:
#        return False
#    role = getattr(event.content, "role", None)
#    if role == "user":
#        return False
#    if role == "model":
#        return True
#    return bool(event.author and event.author not in ("user", "awa_api"))
#
#
# def _event_mentions_close_conversation(event: Event) -> bool:
#    """True if this ADK event carries a ``close_conversation`` tool call or response."""
#    for fc in event.get_function_calls():
#        if getattr(fc, "name", None) == "close_conversation":
#            return True
#    for fr in event.get_function_responses():
#        if getattr(fr, "name", None) == "close_conversation":
#            return True
#    return False
#
#
# class CreateSessionRequest(BaseModel):
#    model_config = ConfigDict(extra="ignore")
#
#    session_id: str
#    user_id: str
#    language: SessionLanguage = Field(default=SessionLanguage.ES_MX)
#    metadata: dict[str, Any] = Field(default_factory=dict)
#
#
# class CreateSessionResponse(BaseModel):
#    session_id: str
#    user_id: str
#
#
# class AdkSessionListItem(BaseModel):
#    """Summary row for ``GET /sessions`` (ADK-backed sessions for one user)."""
#
#    session_id: str
#    user_id: str
#    last_update_time: float = 0.0
#
#
# class ChatMessagePart(BaseModel):
#    model_config = ConfigDict(extra="ignore")
#
#    text: str | None = None
#
#
# class ChatMessage(BaseModel):
#    model_config = ConfigDict(extra="ignore")
#
#    parts: list[ChatMessagePart] = Field(default_factory=list)
#
#
# class ChatRequest(BaseModel):
#    model_config = ConfigDict(extra="ignore")
#
#    user_id: str
#    session_id: str
#    new_message: ChatMessage = Field(default_factory=ChatMessage)
#
#
# class ChatResponse(BaseModel):
#    session_id: str
#    response: str
#
#
## --- Structured interview (LangGraph state machine) -------------------------
#
#
# class InterviewQuestionType(StrEnum):
#    TEXT = "text"
#    NUMBER = "number"
#    BOOLEAN = "boolean"
#    CHOICE = "choice"
#
#
# class InterviewQuestionResponse(BaseModel):
#    """Pydantic shape of a successfully interpreted user answer for a question."""
#
#    model_config = ConfigDict(extra="ignore")
#
#    raw_user_text: str = Field(
#        min_length=1, description="Wording the user actually used."
#    )
#    stored_answer_text: str = Field(
#        min_length=1,
#        description="Canonical value persisted on the session (prerequisites use this).",
#    )
#
#
# class InterviewQuestion(BaseModel):
#    question_identifier: str
#    question_text: str
#    question_type: InterviewQuestionType = InterviewQuestionType.TEXT
#    answer_required: bool = True
#    choice_options: list[str] = Field(default_factory=list)
#    choice_option_labels: dict[str, list[str]] = Field(
#        default_factory=dict,
#        description=(
#            "For CHOICE questions only: map each canonical option string to synonym phrases "
#            "(any language) used for flexible matching."
#        ),
#    )
#    retry_prompt_text: str | None = None
#    question_metadata: dict[str, Any] = Field(default_factory=dict)
#    prerequisite_question_identifier: str | None = None
#    prerequisite_expected_answer_text: str | None = None
#    response: InterviewQuestionResponse | None = Field(
#        default=None,
#        description=(
#            "Optional example of one valid parsed answer for this question (documentation, "
#            "tests, or tooling). Runtime validation uses the same InterviewQuestionResponse model."
#        ),
#    )
#
#    @model_validator(mode="after")
#    def validate_choice_configuration(self) -> InterviewQuestion:
#        if (
#            self.question_type == InterviewQuestionType.CHOICE
#            and not self.choice_options
#        ):
#            raise ValueError("Choice questions must define at least one option.")
#        return self
#
#    @model_validator(mode="after")
#    def validate_choice_option_labels(self) -> InterviewQuestion:
#        if (
#            self.question_type != InterviewQuestionType.CHOICE
#            and self.choice_option_labels
#        ):
#            raise ValueError(
#                "choice_option_labels is only allowed for CHOICE questions."
#            )
#        if self.question_type != InterviewQuestionType.CHOICE:
#            return self
#        allowed = {option.lower() for option in self.choice_options}
#        for key in self.choice_option_labels:
#            if key not in self.choice_options and key.lower() not in allowed:
#                raise ValueError(
#                    f"choice_option_labels key {key!r} must match an entry in choice_options."
#                )
#        return self
#
#    @model_validator(mode="after")
#    def validate_prerequisite_configuration(self) -> InterviewQuestion:
#        if (
#            self.prerequisite_expected_answer_text is not None
#            and not (self.prerequisite_question_identifier or "").strip()
#        ):
#            raise ValueError(
#                "When prerequisite_expected_answer_text is set, "
#                "prerequisite_question_identifier must also be set."
#            )
#        return self
#
#
# def _soft_parse_failure_assistant_message(question: InterviewQuestion) -> str:
#    if question.question_type == InterviewQuestionType.CHOICE:
#        return (
#            "Elige una de las opciones indicadas (o su sinónimo exacto si aparece en la lista). "
#            f"{question.question_text}"
#        )
#    if question.question_type == InterviewQuestionType.NUMBER:
#        return (
#            "No encontré un número claro en tu mensaje; incluye cifras "
#            "(por ejemplo 12 o 15 años). "
#            f"{question.question_text}"
#        )
#    if question.question_type == InterviewQuestionType.BOOLEAN:
#        return f"Responde con sí o no (o yes/no). {question.question_text}"
#    return (
#        question.retry_prompt_text or f"Intentemos de nuevo: {question.question_text}"
#    )
#
#
# def parse_interview_answer(
#    question: InterviewQuestion, raw_user_text: str
# ) -> InterviewQuestionResponse:
#    """Validate user text into ``InterviewQuestionResponse`` (delegates to deterministic parser)."""
#    return InterviewQuestionResponse.model_validate(
#        deterministic_parse_interview_response(
#            question.model_dump(mode="json"),
#            raw_user_text,
#        )
#    )
#
#
# class InterviewQuestionnaire(BaseModel):
#    question_list: list[InterviewQuestion] = Field(default_factory=list)
#
#    def get_question_by_identifier(
#        self, question_identifier: str
#    ) -> InterviewQuestion | None:
#        for question in self.question_list:
#            if question.question_identifier == question_identifier:
#                return question
#        return None
#
#    def get_question_by_index(self, index: int) -> InterviewQuestion | None:
#        if index < 0 or index >= len(self.question_list):
#            return None
#        return self.question_list[index]
#
#    def question_is_eligible(
#        self,
#        question: InterviewQuestion,
#        answers_by_question_identifier: dict[str, Any],
#    ) -> bool:
#        prerequisite_identifier = question.prerequisite_question_identifier
#        if prerequisite_identifier is None:
#            return True
#        if prerequisite_identifier not in answers_by_question_identifier:
#            return False
#        expected_text = question.prerequisite_expected_answer_text
#        if expected_text is None:
#            return True
#        stored_text = (
#            str(answers_by_question_identifier[prerequisite_identifier]).strip().lower()
#        )
#        return stored_text == expected_text.strip().lower()
#
#    def first_eligible_question_index(
#        self, answers_by_question_identifier: dict[str, Any]
#    ) -> int | None:
#        for index, question in enumerate(self.question_list):
#            if self.question_is_eligible(question, answers_by_question_identifier):
#                return index
#        return None
#
#    def next_eligible_question_index_after(
#        self,
#        current_question_index: int,
#        answers_by_question_identifier: dict[str, Any],
#    ) -> int | None:
#        for candidate_index in range(
#            current_question_index + 1, len(self.question_list)
#        ):
#            candidate_question = self.question_list[candidate_index]
#            if self.question_is_eligible(
#                candidate_question, answers_by_question_identifier
#            ):
#                return candidate_index
#        return None
#
#
# class InterviewAnswerSubmission(BaseModel):
#    answer_text: str = Field(min_length=1)
#
#
# class InterviewTurnReply(BaseModel):
#    reply_accepted: bool
#    interview_is_complete: bool
#    current_question_identifier: str | None = None
#    next_question_identifier: str | None = None
#    assistant_reply_message: str
#    submitted_answer_text: str | None = None
#    validation_error_message: str | None = None
#    structured_answer: InterviewQuestionResponse | None = None
#
#
# class InterviewGraphState(TypedDict, total=False):
#    user_answer_text: str
#    current_question_index: int
#    current_question_payload: dict[str, Any] | None
#    answers_by_question_identifier: dict[str, Any]
#    reply_is_accepted: bool
#    interview_is_done: bool
#    validation_error_message: str | None
#    assistant_reply_message: str
#    next_question_index: int | None
#    structured_answer: dict[str, Any] | None
#
#
# @dataclass
# class InterviewSessionState:
#    questionnaire: InterviewQuestionnaire
#    current_question_index: int = 0
#    answers_by_question_identifier: dict[str, Any] = field(default_factory=dict)
#    interview_is_complete: bool = False
#    # Set by the agent via ``record_identified_employment_type`` (not chosen from a user menu).
#    identified_employment_type: str | None = None
#
#
# def interview_structured_answer_from_graph_result(
#    result_state: dict[str, Any],
# ) -> InterviewQuestionResponse | None:
#    payload = result_state.get("structured_answer")
#    if not payload:
#        return None
#    return InterviewQuestionResponse.model_validate(payload)
#
#
# def interview_storage_key(user_id: str, session_id: str) -> str:
#    """Isolate in-memory interview state per ADK identity (same pair as Create Session / Chat)."""
#    return f"{user_id}\x1f{session_id}"
#
#
# _MAX_GREETING_SOFT_RESTART_LEN = 120
#
#
# def _looks_like_short_conversation_opener(message: str) -> bool:
#    """Short hello-style openers used to restart a finished in-RAM interview on a new greeting."""
#    stripped = (message or "").strip()
#    if not stripped or len(stripped) > _MAX_GREETING_SOFT_RESTART_LEN:
#        return False
#    lowered = stripped.lower()
#    compact = re.sub(r"\s+", " ", lowered).strip()
#    prefixes = (
#        "hola",
#        "hi",
#        "hello",
#        "hey",
#        "buenos",
#        "buenas",
#        "good morning",
#        "good afternoon",
#        "good evening",
#        "saludos",
#        "qué tal",
#        "que tal",
#        "buen día",
#        "buen dia",
#    )
#    return any(compact.startswith(p) or compact.startswith(f"{p} ") for p in prefixes)
#
#
# class InterviewEngine:
#    """Runs validation and advancement through a compiled LangGraph workflow."""
#
#    def __init__(
#        self,
#        questionnaire: InterviewQuestionnaire,
#        logger: logging.Logger | None = None,
#        answer_normalizer: InterviewAnswerNormalizer | None = None,
#    ) -> None:
#        self._questionnaire = questionnaire
#        self._logger = logger or logging.getLogger(__name__)
#        self._answer_normalizer: InterviewAnswerNormalizer = (
#            answer_normalizer or DeterministicInterviewAnswerNormalizer()
#        )
#        self._sessions_by_storage_key: dict[str, InterviewSessionState] = {}
#        self._compiled_graph = self._build_graph()
#
#    def forget_interview_state(self, user_id: str, session_id: str) -> None:
#        """Drop RAM interview progress (for example when a new ADK session is created)."""
#        self._sessions_by_storage_key.pop(
#            interview_storage_key(user_id, session_id), None
#        )
#
#    def record_identified_employment_type(
#        self, user_id: str, session_id: str, employment_type: str
#    ) -> dict[str, Any]:
#        """Store the agent's classification for the user's natural-language work situation."""
#        stripped = (employment_type or "").strip()
#        if not stripped:
#            return {
#                "ok": False,
#                "error": "employment_type is required.",
#                "allowed": [m.value for m in UserTypeProfession],
#            }
#        try:
#            canon = UserTypeProfession(stripped).value
#        except ValueError:
#            return {
#                "ok": False,
#                "error": "employment_type must be exactly one canonical enum string.",
#                "allowed": [m.value for m in UserTypeProfession],
#            }
#        session = self._get_or_create_session(user_id, session_id)
#        session.identified_employment_type = canon
#        return {"ok": True, "employment_type": canon}
#
#    def start_interview(self, user_id: str, session_id: str) -> InterviewTurnReply:
#        storage_key = interview_storage_key(user_id, session_id)
#        if storage_key not in self._sessions_by_storage_key:
#            session = InterviewSessionState(questionnaire=self._questionnaire)
#            self._sessions_by_storage_key[storage_key] = session
#            first_index = self._questionnaire.first_eligible_question_index(
#                session.answers_by_question_identifier
#            )
#            if first_index is None:
#                session.interview_is_complete = True
#                return InterviewTurnReply(
#                    reply_accepted=True,
#                    interview_is_complete=True,
#                    assistant_reply_message="The interview has no questions to ask.",
#                )
#            session.current_question_index = first_index
#            session.interview_is_complete = False
#            question = self._questionnaire.get_question_by_index(first_index)
#            assert question is not None
#            return InterviewTurnReply(
#                reply_accepted=True,
#                interview_is_complete=False,
#                current_question_identifier=question.question_identifier,
#                next_question_identifier=question.question_identifier,
#                assistant_reply_message=question.question_text,
#            )
#
#        return self.get_current_question(user_id, session_id)
#
#    def get_current_question(self, user_id: str, session_id: str) -> InterviewTurnReply:
#        session = self._get_or_create_session(user_id, session_id)
#
#        if session.interview_is_complete:
#            return InterviewTurnReply(
#                reply_accepted=True,
#                interview_is_complete=True,
#                assistant_reply_message="The interview is already complete.",
#            )
#
#        question = self._questionnaire.get_question_by_index(
#            session.current_question_index
#        )
#        if question is None or not self._questionnaire.question_is_eligible(
#            question, session.answers_by_question_identifier
#        ):
#            next_index = self._questionnaire.first_eligible_question_index(
#                session.answers_by_question_identifier
#            )
#            if next_index is None:
#                session.interview_is_complete = True
#                return InterviewTurnReply(
#                    reply_accepted=True,
#                    interview_is_complete=True,
#                    assistant_reply_message="The interview is complete.",
#                )
#            session.current_question_index = next_index
#            question = self._questionnaire.get_question_by_index(next_index)
#            assert question is not None
#
#        return InterviewTurnReply(
#            reply_accepted=True,
#            interview_is_complete=False,
#            current_question_identifier=question.question_identifier,
#            next_question_identifier=question.question_identifier,
#            assistant_reply_message=question.question_text,
#        )
#
#    def submit_current_if_primitive_parses(
#        self, user_id: str, session_id: str, answer_text: str
#    ) -> InterviewTurnReply | None:
#        """If the active question is numeric or boolean and ``answer_text`` parses, submit it.
#
#        Short-circuits a tool round when the deterministic parser accepts the text (digits for
#        NUMBER; sí/no-style for BOOLEAN). Only active for deterministic normalizers (offline/tests).
#        """
#        session = self._get_or_create_session(user_id, session_id)
#        if session.interview_is_complete:
#            return None
#        question = self._questionnaire.get_question_by_index(
#            session.current_question_index
#        )
#        if question is None or not self._questionnaire.question_is_eligible(
#            question, session.answers_by_question_identifier
#        ):
#            return None
#        if question.question_type not in (
#            InterviewQuestionType.NUMBER,
#            InterviewQuestionType.BOOLEAN,
#        ):
#            return None
#        if not self._answer_normalizer.is_deterministic:
#            return None
#        try:
#            parse_interview_answer(question, answer_text)
#        except ValueError:
#            return None
#        return self.submit_answer(user_id, session_id, answer_text)
#
#    def submit_answer(
#        self, user_id: str, session_id: str, answer_text: str
#    ) -> InterviewTurnReply:
#        session = self._get_or_create_session(user_id, session_id)
#
#        if session.interview_is_complete:
#            return InterviewTurnReply(
#                reply_accepted=False,
#                interview_is_complete=True,
#                assistant_reply_message=(
#                    "The interview is already complete. Reset it to start again."
#                ),
#                validation_error_message="Interview already completed.",
#                structured_answer=None,
#            )
#
#        graph_state: InterviewGraphState = {
#            "user_answer_text": answer_text,
#            "current_question_index": session.current_question_index,
#            "answers_by_question_identifier": dict(
#                session.answers_by_question_identifier
#            ),
#            "interview_is_done": session.interview_is_complete,
#        }
#
#        current_q = self._questionnaire.get_question_by_index(
#            session.current_question_index
#        )
#        current_qid = current_q.question_identifier if current_q else None
#        self._logger.info(
#            "interview_langgraph invoke user_id=%s session_id=%s "
#            "question_identifier=%s answer_len=%s",
#            user_id,
#            session_id,
#            current_qid,
#            len(answer_text),
#        )
#
#        result_state = self._compiled_graph.invoke(graph_state)
#
#        self._logger.info(
#            "interview_langgraph done user_id=%s session_id=%s "
#            "reply_accepted=%s interview_done=%s validation_error=%s",
#            user_id,
#            session_id,
#            result_state.get("reply_is_accepted"),
#            result_state.get("interview_is_done"),
#            result_state.get("validation_error_message"),
#        )
#
#        current_question = self._questionnaire.get_question_by_index(
#            session.current_question_index
#        )
#        current_question_identifier = (
#            current_question.question_identifier if current_question else None
#        )
#
#        if result_state.get("reply_is_accepted"):
#            updated_answers = result_state.get(
#                "answers_by_question_identifier",
#                session.answers_by_question_identifier,
#            )
#            session.answers_by_question_identifier = dict(updated_answers)
#
#            next_question_index = result_state.get("next_question_index")
#            if next_question_index is None or result_state.get("interview_is_done"):
#                session.interview_is_complete = True
#                return InterviewTurnReply(
#                    reply_accepted=True,
#                    interview_is_complete=True,
#                    current_question_identifier=current_question_identifier,
#                    next_question_identifier=None,
#                    assistant_reply_message=str(
#                        result_state.get("assistant_reply_message", "")
#                    ),
#                    submitted_answer_text=answer_text,
#                    structured_answer=interview_structured_answer_from_graph_result(
#                        result_state
#                    ),
#                )
#
#            session.current_question_index = int(next_question_index)
#            next_question = self._questionnaire.get_question_by_index(
#                int(next_question_index)
#            )
#            next_question_identifier = (
#                next_question.question_identifier if next_question else None
#            )
#
#            return InterviewTurnReply(
#                reply_accepted=True,
#                interview_is_complete=False,
#                current_question_identifier=current_question_identifier,
#                next_question_identifier=next_question_identifier,
#                assistant_reply_message=str(
#                    result_state.get("assistant_reply_message", "")
#                ),
#                submitted_answer_text=answer_text,
#                structured_answer=interview_structured_answer_from_graph_result(
#                    result_state
#                ),
#            )
#
#        return InterviewTurnReply(
#            reply_accepted=False,
#            interview_is_complete=False,
#            current_question_identifier=current_question_identifier,
#            next_question_identifier=current_question_identifier,
#            assistant_reply_message=str(
#                result_state.get("assistant_reply_message", "")
#            ),
#            submitted_answer_text=answer_text,
#            validation_error_message=result_state.get("validation_error_message"),
#            structured_answer=None,
#        )
#
#    def reset_interview(self, user_id: str, session_id: str) -> InterviewTurnReply:
#        self._sessions_by_storage_key[interview_storage_key(user_id, session_id)] = (
#            InterviewSessionState(questionnaire=self._questionnaire)
#        )
#        return self.start_interview(user_id, session_id)
#
#    def export_answers(self, user_id: str, session_id: str) -> dict[str, Any]:
#        session = self._get_or_create_session(user_id, session_id)
#        return {
#            "interview_is_complete": session.interview_is_complete,
#            "answers_by_question_identifier": session.answers_by_question_identifier,
#            "current_question_index": session.current_question_index,
#            "identified_employment_type": session.identified_employment_type,
#        }
#
#    def _get_or_create_session(
#        self, user_id: str, session_id: str
#    ) -> InterviewSessionState:
#        storage_key = interview_storage_key(user_id, session_id)
#        if storage_key in self._sessions_by_storage_key:
#            return self._sessions_by_storage_key[storage_key]
#        created = InterviewSessionState(questionnaire=self._questionnaire)
#        self._sessions_by_storage_key[storage_key] = created
#        return created
#
#    def _build_graph(self):
#        questionnaire = self._questionnaire
#
#        builder = StateGraph(InterviewGraphState)
#
#        def load_question(state: InterviewGraphState) -> InterviewGraphState:
#            index = int(state["current_question_index"])
#            question = questionnaire.get_question_by_index(index)
#            payload = question.model_dump(mode="json") if question else None
#            self._logger.debug(
#                "interview_langgraph node=load_question index=%s identifier=%s",
#                index,
#                question.question_identifier if question else None,
#            )
#            return {"current_question_payload": payload}
#
#        def validate_answer(state: InterviewGraphState) -> InterviewGraphState:
#            question_payload = state.get("current_question_payload")
#            answer_text = (state.get("user_answer_text") or "").strip()
#            answers_snapshot = dict(state.get("answers_by_question_identifier") or {})
#
#            if question_payload is None:
#                self._logger.debug(
#                    "interview_langgraph node=validate_answer accepted=False reason=no_payload"
#                )
#                return {
#                    "reply_is_accepted": False,
#                    "validation_error_message": "No active question found.",
#                    "assistant_reply_message": (
#                        "I could not find the current interview question."
#                    ),
#                    "structured_answer": None,
#                }
#
#            question = InterviewQuestion.model_validate(question_payload)
#
#            if not answer_text and question.answer_required:
#                retry_prompt = (
#                    question.retry_prompt_text
#                    or f"Please answer this question: {question.question_text}"
#                )
#                self._logger.debug(
#                    "interview_langgraph node=validate_answer "
#                    "identifier=%s accepted=False reason=required_empty",
#                    question.question_identifier,
#                )
#                return {
#                    "reply_is_accepted": False,
#                    "validation_error_message": "Answer is required.",
#                    "assistant_reply_message": retry_prompt,
#                    "structured_answer": None,
#                }
#
#            try:
#                parsed_dict = self._answer_normalizer.normalize(
#                    question.model_dump(mode="json"),
#                    answer_text,
#                )
#                parsed = InterviewQuestionResponse.model_validate(parsed_dict)
#            except InterviewNormalizationRejected as exc:
#                self._logger.debug(
#                    "interview_langgraph node=validate_answer "
#                    "identifier=%s accepted=False agent_reject=%s",
#                    question.question_identifier,
#                    exc.code,
#                )
#                return {
#                    "reply_is_accepted": False,
#                    "validation_error_message": exc.code,
#                    "assistant_reply_message": exc.user_message,
#                    "structured_answer": None,
#                }
#            except ValueError as exc:
#                error_code = str(exc.args[0]) if exc.args else "parse_error"
#                assistant_message = _soft_parse_failure_assistant_message(question)
#                self._logger.debug(
#                    "interview_langgraph node=validate_answer "
#                    "identifier=%s accepted=False parse_error=%s",
#                    question.question_identifier,
#                    error_code,
#                )
#                return {
#                    "reply_is_accepted": False,
#                    "validation_error_message": error_code,
#                    "assistant_reply_message": assistant_message,
#                    "structured_answer": None,
#                }
#
#            updated_answers = dict(answers_snapshot)
#            updated_answers[question.question_identifier] = parsed.stored_answer_text
#
#            self._logger.debug(
#                "interview_langgraph node=validate_answer identifier=%s accepted=True",
#                question.question_identifier,
#            )
#            return {
#                "reply_is_accepted": True,
#                "validation_error_message": None,
#                "answers_by_question_identifier": updated_answers,
#                "structured_answer": parsed.model_dump(mode="json"),
#            }
#
#        def route_after_validation(
#            state: InterviewGraphState,
#        ) -> Literal["advance_question", "retry_question"]:
#            branch = (
#                "advance_question"
#                if state.get("reply_is_accepted")
#                else "retry_question"
#            )
#            self._logger.debug(
#                "interview_langgraph route_after_validation branch=%s", branch
#            )
#            if branch == "advance_question":
#                return "advance_question"
#            return "retry_question"
#
#        def retry_question(state: InterviewGraphState) -> InterviewGraphState:
#            idx = state["current_question_index"]
#            self._logger.debug("interview_langgraph node=retry_question index=%s", idx)
#            return {
#                "next_question_index": idx,
#                "interview_is_done": False,
#            }
#
#        def advance_question(state: InterviewGraphState) -> InterviewGraphState:
#            current_index = int(state["current_question_index"])
#            answers_after = dict(state.get("answers_by_question_identifier") or {})
#            following_index = questionnaire.next_eligible_question_index_after(
#                current_index, answers_after
#            )
#            if following_index is None:
#                self._logger.debug(
#                    "interview_langgraph node=advance_question "
#                    "from_index=%s interview_done=True",
#                    current_index,
#                )
#                return {
#                    "interview_is_done": True,
#                    "next_question_index": None,
#                }
#            self._logger.debug(
#                "interview_langgraph node=advance_question from_index=%s next_index=%s",
#                current_index,
#                following_index,
#            )
#            return {
#                "interview_is_done": False,
#                "next_question_index": following_index,
#            }
#
#        def build_reply(state: InterviewGraphState) -> InterviewGraphState:
#            current_payload = state.get("current_question_payload")
#            current_question: InterviewQuestion | None = None
#            if current_payload is not None:
#                current_question = InterviewQuestion.model_validate(current_payload)
#
#            if not state.get("reply_is_accepted"):
#                if state.get("assistant_reply_message"):
#                    self._logger.debug(
#                        "interview_langgraph node=build_reply mode=rejected_existing_message"
#                    )
#                    return state
#                fallback_text = (
#                    current_question.retry_prompt_text
#                    if current_question
#                    else "Please try again."
#                )
#                self._logger.debug(
#                    "interview_langgraph node=build_reply mode=rejected_fallback"
#                )
#                return {"assistant_reply_message": fallback_text}
#
#            if state.get("interview_is_done"):
#                self._logger.debug(
#                    "interview_langgraph node=build_reply mode=complete_after_advance"
#                )
#                return {
#                    "assistant_reply_message": "Thank you. The interview is complete.",
#                }
#
#            next_index = state.get("next_question_index")
#            if next_index is None:
#                self._logger.debug(
#                    "interview_langgraph node=build_reply mode=complete_no_next"
#                )
#                return {
#                    "assistant_reply_message": "Thank you. The interview is complete.",
#                    "interview_is_done": True,
#                    "next_question_index": None,
#                }
#
#            next_question = questionnaire.get_question_by_index(int(next_index))
#            if next_question is None:
#                self._logger.debug(
#                    "interview_langgraph node=build_reply mode=complete_missing_question"
#                )
#                return {
#                    "assistant_reply_message": "Thank you. The interview is complete.",
#                    "interview_is_done": True,
#                    "next_question_index": None,
#                }
#
#            self._logger.debug(
#                "interview_langgraph node=build_reply mode=next_question identifier=%s",
#                next_question.question_identifier,
#            )
#            return {
#                "assistant_reply_message": next_question.question_text,
#            }
#
#        builder.add_node("load_question", load_question)
#        builder.add_node("validate_answer", validate_answer)
#        builder.add_node("retry_question", retry_question)
#        builder.add_node("advance_question", advance_question)
#        builder.add_node("build_reply", build_reply)
#
#        builder.add_edge(START, "load_question")
#        builder.add_edge("load_question", "validate_answer")
#        builder.add_conditional_edges(
#            "validate_answer",
#            route_after_validation,
#            {
#                "advance_question": "advance_question",
#                "retry_question": "retry_question",
#            },
#        )
#        builder.add_edge("retry_question", "build_reply")
#        builder.add_edge("advance_question", "build_reply")
#        builder.add_edge("build_reply", END)
#
#        return builder.compile()
#
#
# DEFAULT_INTERVIEW_QUESTIONNAIRE = InterviewQuestionnaire(
#    question_list=[
#        InterviewQuestion(
#            question_identifier="full_name",
#            question_text="Please confirm your full legal name.",
#            question_type=InterviewQuestionType.TEXT,
#        ),
#        InterviewQuestion(
#            question_identifier="profession_description",
#            question_text="What is your profession or trade?",
#            question_type=InterviewQuestionType.TEXT,
#        ),
#        InterviewQuestion(
#            question_identifier="years_in_profession",
#            question_text="How many years of professional experience do you have?",
#            question_type=InterviewQuestionType.NUMBER,
#            retry_prompt_text="Please provide the number of years of experience.",
#        ),
#    ]
# )
#
#
# def build_interview_tool_functions(engine: InterviewEngine) -> list[Any]:
#    """Return plain callables for the ADK agent tool list."""
#
#    def start_interview(user_id: str, session_id: str) -> dict[str, Any]:
#        """Start an interview and return the first eligible question."""
#        return engine.start_interview(user_id, session_id).model_dump()
#
#    def get_current_interview_question(user_id: str, session_id: str) -> dict[str, Any]:
#        """Return the current active interview question."""
#        return engine.get_current_question(user_id, session_id).model_dump()
#
#    def submit_interview_answer(
#        user_id: str, session_id: str, answer_text: str
#    ) -> dict[str, Any]:
#        """Submit the user's answer for the current question and advance when valid."""
#        submission = InterviewAnswerSubmission(answer_text=answer_text)
#        return engine.submit_answer(
#            user_id, session_id, submission.answer_text
#        ).model_dump()
#
#    def reset_interview(user_id: str, session_id: str) -> dict[str, Any]:
#        """Reset the interview for a session and ask the first eligible question again."""
#        return engine.reset_interview(user_id, session_id).model_dump()
#
#    def export_interview_answers(user_id: str, session_id: str) -> dict[str, Any]:
#        """Export the interview answers collected so far."""
#        return engine.export_answers(user_id, session_id)
#
#    def close_conversation(user_id: str, session_id: str) -> dict[str, Any]:
#        """Mark this turn as finished so voice clients may hang up after TTS.
#
#        Call **exactly once** per hang-up, after:
#
#        - the structured interview is done (``export_interview_answers`` shows
#          ``interview_is_complete``) **and** you have spoken your short thank-you; **or**
#        - the user sends only a brief thanks or goodbye (e.g. gracias, gràcies, thanks) **after**
#          completion—reply with one warm line, **without** saying the interview was \"already\"
#          complete or \"had already finished\", then call this tool.
#
#        Do **not** call before ``submit_interview_answer`` has stored the final step. This tool
#        does not write interview answers; it only signals clients.
#        """
#        return {
#            "ok": True,
#            "closed": True,
#            "user_id": user_id,
#            "session_id": session_id,
#        }
#
#    def record_identified_employment_type(
#        user_id: str, session_id: str, employment_type: str
#    ) -> dict[str, Any]:
#        return engine.record_identified_employment_type(
#            user_id, session_id, employment_type
#        )
#
#    record_identified_employment_type.__doc__ = (
#        "Infer how they work from their profession answer (you pick the enum—no user-facing "
#        "pick list). Most people map to one of: self_employed (freelance / own account), "
#        "employee, business_owner.\n\n"
#        "When they have answered `profession_description` (or their message makes it clear), "
#        "call this with exactly one canonical value: "
#        + _EMPLOYMENT_TYPE_ENUM_DOC
#        + ". Use `submit_interview_answer` to store their profession text first if needed, then "
#        "this tool in the same turn when appropriate."
#    )
#
#    return [
#        start_interview,
#        get_current_interview_question,
#        submit_interview_answer,
#        record_identified_employment_type,
#        reset_interview,
#        export_interview_answers,
#        close_conversation,
#    ]
#
#
# class AwaApiService:
#    """HTTP-facing use cases; injected via `MainContainer.api_service`."""
#
#    def __init__(
#        self,
#        runner: Runner,
#        session_service: BaseSessionService,
#        interview_engine: InterviewEngine,
#    ) -> None:
#        self._runner = runner
#        self._session_service = session_service
#        self._interview_engine = interview_engine
#
#    def _interview_turn_context_block(
#        self, user_id: str, session_id: str
#    ) -> str | None:
#        """Authoritative snapshot from LangGraph-backed interview state (same engine as tools)."""
#        reply = self._interview_engine.get_current_question(user_id, session_id)
#        if reply.interview_is_complete:
#            return None
#        if not reply.current_question_identifier:
#            return None
#        question_text = (reply.assistant_reply_message or "").strip()
#        if not question_text:
#            return None
#        return (
#            "--- Interview turn context (do not show this header or these field names to the "
#            "user) ---\n"
#            f"interview_is_complete: {reply.interview_is_complete}\n"
#            f"current_question_identifier: {reply.current_question_identifier}\n"
#            f"question_text_verbatim: {question_text}\n"
#            "--- End interview turn context ---"
#        )
#
#    def health(self) -> dict[str, str]:
#        return {"message": "healthy"}
#
#    async def list_adk_sessions(self, user_id: str) -> list[AdkSessionListItem]:
#        listed = await self._session_service.list_sessions(
#            app_name=self._runner.app_name,
#            user_id=user_id,
#        )
#        rows = [
#            AdkSessionListItem(
#                session_id=s.id,
#                user_id=s.user_id,
#                last_update_time=float(s.last_update_time or 0.0),
#            )
#            for s in listed.sessions
#        ]
#        rows.sort(key=lambda r: r.last_update_time, reverse=True)
#        return rows
#
#    async def create_session(self, body: CreateSessionRequest) -> CreateSessionResponse:
#        state = dict(body.metadata)
#        state[f"{State.USER_PREFIX}language"] = body.language.value
#        try:
#            await self._session_service.create_session(
#                app_name=self._runner.app_name,
#                user_id=body.user_id,
#                session_id=body.session_id,
#                state=state or None,
#            )
#        except AlreadyExistsError as exc:
#            raise HTTPException(status_code=409, detail=str(exc)) from exc
#        self._interview_engine.forget_interview_state(body.user_id, body.session_id)
#        return CreateSessionResponse(session_id=body.session_id, user_id=body.user_id)
#
#    async def chat(self, body: ChatRequest) -> ChatResponse:
#        message_text = " ".join(
#            (part.text or "").strip() for part in body.new_message.parts if part.text
#        ).strip()
#        if not message_text:
#            raise HTTPException(
#                status_code=400,
#                detail="new_message.parts must include at least one non-empty text part.",
#            )
#        try:
#            response_text = await self._run_turn_text(
#                user_id=body.user_id,
#                session_id=body.session_id,
#                user_text=message_text,
#            )
#        except SessionNotFoundError as exc:
#            raise HTTPException(status_code=404, detail=str(exc)) from exc
#        except ValueError as exc:
#            if "No API key was provided" in str(exc):
#                raise HTTPException(
#                    status_code=503,
#                    detail=(
#                        "Gemini API key is not configured. Set GOOGLE_API_KEY or GEMINI_API_KEY "
#                        "(https://ai.google.dev/gemini-api/docs/api-key)."
#                    ),
#                ) from exc
#            raise
#        return ChatResponse(session_id=body.session_id, response=response_text)
#
#    @staticmethod
#    def _text_from_event(event: Event) -> str:
#        """Visible assistant text only (no tool I/O, chain-of-thought, or code blocks)."""
#        if not event.content or not event.content.parts:
#            return ""
#        pieces: list[str] = []
#        for part in event.content.parts:
#            if getattr(part, "thought", None):
#                continue
#            if (
#                part.function_call
#                or part.function_response
#                or part.tool_call
#                or part.tool_response
#                or part.executable_code
#                or part.code_execution_result
#            ):
#                continue
#            if part.text:
#                pieces.append(part.text)
#        return "".join(pieces)
#
#    async def _sync_interview_capture_to_session_user_state(
#        self, user_id: str, session_id: str
#    ) -> None:
#        """Persist profession answers from the interview engine into ADK user session state."""
#        exported = self._interview_engine.export_answers(user_id, session_id)
#        answers: dict[str, Any] = exported.get("answers_by_question_identifier") or {}
#        delta: dict[str, str] = {}
#        raw_prof = answers.get("profession_description")
#        if raw_prof is not None and str(raw_prof).strip():
#            delta[f"{State.USER_PREFIX}profession_description"] = str(raw_prof).strip()
#        identified = exported.get("identified_employment_type")
#        if identified is not None and str(identified).strip():
#            delta[f"{State.USER_PREFIX}employment_type"] = str(identified).strip()
#        raw_years = answers.get("years_in_profession")
#        if raw_years is not None and str(raw_years).strip():
#            delta[f"{State.USER_PREFIX}years_in_profession"] = str(raw_years).strip()
#        if not delta:
#            return
#        session = await self._session_service.get_session(
#            app_name=self._runner.app_name,
#            user_id=user_id,
#            session_id=session_id,
#            config=GetSessionConfig(num_recent_events=0),
#        )
#        if session is None:
#            return
#        to_write = {k: v for k, v in delta.items() if session.state.get(k) != v}
#        if not to_write:
#            return
#        sync_event = Event(
#            invocation_id="awa-interview-state",
#            author="awa_api",
#            content=types.Content(role="user", parts=[]),
#            actions=EventActions(
#                state_delta=to_write,
#                skip_summarization=True,
#            ),
#        )
#        await self._session_service.append_event(session, sync_event)
#
#    async def _prepare_user_content_for_turn(
#        self,
#        *,
#        user_id: str,
#        session_id: str,
#        user_text: str,
#    ) -> types.Content:
#        if user_text.strip() == VOICE_SESSION_OPENING_SIGNAL:
#            self._interview_engine.get_current_question(user_id, session_id)
#            interview_block = self._interview_turn_context_block(user_id, session_id)
#            if interview_block:
#                combined_user_text = (
#                    f"{interview_block}\n\n"
#                    "[Voice session start — not the candidate's spoken words.]\n"
#                    "They tapped **Start conversation** on a voice client. Speak first: greet briefly "
#                    "in the session language, explain in one or two sentences that this is a short "
#                    "questionnaire about their full legal name, profession with work context, and "
#                    "years in that profession, then ask the active step in natural "
#                    "language. Do **not** wait for them to say hello. Do **not** call "
#                    "submit_interview_answer on this turn; no answer has been given yet.\n"
#                )
#            else:
#                combined_user_text = (
#                    "[Voice session start — not the candidate's spoken words.]\n"
#                    "They began a voice session. Greet warmly in the session language and explain "
#                    "you are here to help. If there is no active interview question in context, "
#                    "keep the reply short.\n"
#                )
#            return types.Content(
#                role="user",
#                parts=[types.Part(text=combined_user_text)],
#            )
#
#        exported_pre = self._interview_engine.export_answers(user_id, session_id)
#        if exported_pre.get(
#            "interview_is_complete"
#        ) and _looks_like_short_conversation_opener(user_text):
#            self._interview_engine.reset_interview(user_id, session_id)
#        self._interview_engine.get_current_question(user_id, session_id)
#        server_primitive = self._interview_engine.submit_current_if_primitive_parses(
#            user_id, session_id, user_text
#        )
#        interview_block = self._interview_turn_context_block(user_id, session_id)
#        if server_primitive is not None and server_primitive.reply_accepted:
#            if server_primitive.interview_is_complete:
#                combined_user_text = (
#                    "[Assistant instruction for this reply only] The interview is complete: "
#                    "the user's last message was already stored as the final answer. Do not call "
#                    "submit_interview_answer, start_interview, or reset_interview. Thank them "
#                    "warmly in the session language and close briefly. Do **not** tell them the "
#                    "interview was 'already complete' or 'had already finished'—treat this as the "
#                    "normal successful ending. After your closing line, call **close_conversation** "
#                    "exactly once (same user_id and session_id). Never tell the user that "
#                    "'the system' failed, could not process their reply, or that they should retry "
#                    "because of a technical or internal error.\n\n"
#                    f"Their last answer (already stored): {user_text!r}\n"
#                )
#            elif interview_block:
#                combined_user_text = (
#                    f"{interview_block}\n\n"
#                    "[Assistant instruction for this reply only] The interview backend has "
#                    "already recorded the user's last message as a valid answer for the prior "
#                    "step. Do not call submit_interview_answer, start_interview, or reset_interview. "
#                    "Acknowledge briefly in the session language, then ask using the interview "
#                    "context line below as a direct question in natural wording (same meaning and "
#                    "expected answer shape). Do not introduce it with meta phrases such as "
#                    '"the next question is", "la siguiente pregunta es", "ahora te pregunto", '
#                    "or similar—just ask. Never tell the user that 'the system' failed, could not "
#                    "process their reply, or that they should retry because of a technical or "
#                    "internal error.\n\n"
#                    f"The answer already stored from the user: {user_text!r}\n"
#                )
#            else:
#                combined_user_text = user_text
#        elif interview_block:
#            combined_user_text = (
#                f"{interview_block}\n\nUser message:\n{user_text}\n\n"
#                "[Turn guidance] If current_question_identifier is `profession_description`, ask "
#                "only for their profession or trade (no situación-laboral pick-list); you classify "
#                "with `record_identified_employment_type` from what they said.\n\n"
#                "[Turn guidance] If the user is asking what the job is, what the interview is for, "
#                "or what a question means—rather than answering the active step—do not call "
#                "submit_interview_answer. Explain briefly (this is a structured questionnaire flow; "
#                "no separate job description unless they provide it), then restate the active "
#                "question in natural language with the same meaning as question_text_verbatim. "
#                'Do not prefix with "la siguiente pregunta" / "the next question is"—ask '
#                "directly.\n\n"
#                "[Tone] Never tell the user that 'the system' or a server failed, could not process "
#                "their message, or that they should retry for a vague technical reason. If an "
#                "interview tool returns guidance, use that wording in the user's language.\n"
#            )
#        else:
#            combined_user_text = user_text
#        return types.Content(
#            role="user",
#            parts=[types.Part(text=combined_user_text)],
#        )
#
#    async def _run_turn_text(
#        self,
#        *,
#        user_id: str,
#        session_id: str,
#        user_text: str,
#    ) -> str:
#        new_message = await self._prepare_user_content_for_turn(
#            user_id=user_id, session_id=session_id, user_text=user_text
#        )
#        last_final = ""
#        last_model_text = ""
#        async with aclosing(
#            self._runner.run_async(
#                user_id=user_id,
#                session_id=session_id,
#                new_message=new_message,
#            )
#        ) as agen:
#            async for event in agen:
#                if _event_is_assistant_speech(event):
#                    chunk = self._text_from_event(event)
#                    if chunk:
#                        last_model_text = chunk
#                if event.is_final_response():
#                    chunk = self._text_from_event(event)
#                    if chunk:
#                        last_final = chunk
#        await self._sync_interview_capture_to_session_user_state(user_id, session_id)
#        return (last_model_text or last_final).strip()
#
#    async def chat_stream(self, body: ChatRequest) -> StreamingResponse:
#        """Stream ADK ``run_async`` model events as SSE (see ADK streaming docs)."""
#        message_text = " ".join(
#            (part.text or "").strip() for part in body.new_message.parts if part.text
#        ).strip()
#        if not message_text:
#            raise HTTPException(
#                status_code=400,
#                detail="new_message.parts must include at least one non-empty text part.",
#            )
#
#        async def sse_events():
#            last_final = ""
#            last_model_text = ""
#            try:
#                new_message = await self._prepare_user_content_for_turn(
#                    user_id=body.user_id,
#                    session_id=body.session_id,
#                    user_text=message_text,
#                )
#                saw_close_conversation = False
#                async with aclosing(
#                    self._runner.run_async(
#                        user_id=body.user_id,
#                        session_id=body.session_id,
#                        new_message=new_message,
#                    )
#                ) as agen:
#                    async for event in agen:
#                        if _event_mentions_close_conversation(event):
#                            saw_close_conversation = True
#                        if _event_is_assistant_speech(event):
#                            chunk = self._text_from_event(event)
#                            if chunk:
#                                last_model_text = chunk
#                                yield _sse_data(
#                                    {
#                                        "type": "model",
#                                        "text": chunk,
#                                        "partial": bool(event.partial),
#                                    }
#                                )
#                        if event.is_final_response():
#                            final_chunk = self._text_from_event(event)
#                            if final_chunk:
#                                last_final = final_chunk
#                await self._sync_interview_capture_to_session_user_state(
#                    body.user_id, body.session_id
#                )
#                exported = self._interview_engine.export_answers(
#                    body.user_id, body.session_id
#                )
#                yield _sse_data(
#                    {
#                        "type": "done",
#                        "session_id": body.session_id,
#                        "response": (last_model_text or last_final).strip(),
#                        "interview_is_complete": bool(
#                            exported.get("interview_is_complete")
#                        ),
#                        "close_conversation": saw_close_conversation,
#                    }
#                )
#            except SessionNotFoundError as exc:
#                yield _sse_data({"type": "error", "code": 404, "message": str(exc)})
#            except ValueError as exc:
#                if "No API key was provided" in str(exc):
#                    yield _sse_data(
#                        {
#                            "type": "error",
#                            "code": 503,
#                            "message": (
#                                "Gemini API key is not configured. Set GOOGLE_API_KEY or "
#                                "GEMINI_API_KEY (https://ai.google.dev/gemini-api/docs/api-key)."
#                            ),
#                        }
#                    )
#                else:
#                    yield _sse_data({"type": "error", "code": 500, "message": str(exc)})
#
#        return StreamingResponse(
#            sse_events(),
#            media_type="text/event-stream",
#            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
#        )
#
#
# def _make_interview_answer_normalizer() -> InterviewAnswerNormalizer:
#    s = Settings()
#    return build_interview_answer_normalizer(
#        gemini_api_key=(s.GOOGLE_API_KEY or s.GEMINI_API_KEY),
#        model_name=s.GOOGLE_GEMINI_MODEL_NAME,
#    )
#
#    api_service = providers.Singleton(
#        AwaApiService,
#        runner=runner,
#        session_service=database_session_service,
#        interview_engine=interview_engine,
#    )
#
#
# router = APIRouter()
#
#
# @router.get("/health")
# @inject
# async def health(
#    api: AwaApiService = Depends(Provide[MainContainer.api_service]),
# ):
#    return api.health()
#
#
# @router.post("/sessions", response_model=CreateSessionResponse)
# @inject
# async def create_session(
#    body: CreateSessionRequest,
#    api: AwaApiService = Depends(Provide[MainContainer.api_service]),
# ):
#    return await api.create_session(body)
#
#
# @router.get("/sessions", response_model=list[AdkSessionListItem])
# @inject
# async def list_sessions(
#    user_id: str,
#    api: AwaApiService = Depends(Provide[MainContainer.api_service]),
# ):
#    return await api.list_adk_sessions(user_id)
#
#
# @router.post("/chat", response_model=ChatResponse)
# @inject
# async def chat(
#    body: ChatRequest,
#    api: AwaApiService = Depends(Provide[MainContainer.api_service]),
# ):
#    return await api.chat(body)
#
#
# @router.post("/chat/stream")
# @inject
# async def chat_stream(
#    body: ChatRequest,
#    api: AwaApiService = Depends(Provide[MainContainer.api_service]),
# ):
#    return await api.chat_stream(body)
#
#
# @asynccontextmanager
# async def lifespan(app: FastAPI):
#    container = MainContainer()
#    app.container = container
#    container.wire()
#    yield
#    container.unwire()
#
#
# app = FastAPI(lifespan=lifespan)
# app.include_router(router)
