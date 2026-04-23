"""Interview answer extraction via a Gemini structured-output agent (normalization sub-agent).

LangGraph's ``validate_answer`` node calls :class:`InterviewAnswerNormalizer`.

- **Gemini path**: model reasons over the question JSON and returns
  :class:`InterviewAnswerNormalizationAgentOutput`; stored values are checked with Pydantic-shaped
  gates (see ``_finalize_agent_output_to_response``).
- **Deterministic path** (no API key / tests): minimal rules—digits for numbers, small yes/no sets,
  exact choice/synonym match—no regex banks or fuzzy string matchers.
"""

from __future__ import annotations

import json
import re
from typing import Any, Protocol, runtime_checkable

from google import genai
from google.genai import types
from pydantic import BaseModel, Field, ValidationError

_DETERMINISTIC_YES = frozenset({"yes", "y", "true", "1", "sí", "si"})
_DETERMINISTIC_NO = frozenset({"no", "n", "false", "0"})


def _boolean_stored_from_token(token: str) -> str | None:
    x = token.strip().lower()
    if x in _DETERMINISTIC_YES:
        return "yes"
    if x in _DETERMINISTIC_NO:
        return "no"
    return None


def _format_stored_number(value: float) -> str:
    if value.is_integer():
        return str(int(value))
    return str(value).rstrip("0").rstrip(".")


def deterministic_parse_interview_response(
    question_payload: dict[str, Any],
    raw_user_text: str,
) -> dict[str, Any]:
    """Offline/tests parser: digits-only NUMBER; compact yes/no BOOLEAN; exact CHOICE labels."""
    from src.main import InterviewQuestionResponse, InterviewQuestionType

    stripped = raw_user_text.strip()
    if question_payload.get("answer_required", True) and not stripped:
        raise ValueError("answer_required")

    qt = InterviewQuestionType(question_payload["question_type"])

    if qt == InterviewQuestionType.TEXT:
        return InterviewQuestionResponse(
            raw_user_text=stripped,
            stored_answer_text=stripped,
        ).model_dump(mode="json")

    if qt == InterviewQuestionType.NUMBER:
        cleaned = stripped.replace(",", ".")
        m = re.search(r"-?\d+(?:\.\d+)?", cleaned)
        if not m:
            raise ValueError("unrecognized_number")
        stored = _format_stored_number(float(m.group(0)))
        return InterviewQuestionResponse(
            raw_user_text=stripped,
            stored_answer_text=stored,
        ).model_dump(mode="json")

    if qt == InterviewQuestionType.BOOLEAN:
        stored_b = _boolean_stored_from_token(stripped)
        if stored_b is None:
            raise ValueError("unrecognized_boolean")
        stored = stored_b
        return InterviewQuestionResponse(
            raw_user_text=stripped,
            stored_answer_text=stored,
        ).model_dump(mode="json")

    if qt == InterviewQuestionType.CHOICE:
        low = stripped.lower()
        options = list(question_payload.get("choice_options") or [])
        labels = question_payload.get("choice_option_labels") or {}
        for opt in options:
            if opt.lower() == low:
                return InterviewQuestionResponse(
                    raw_user_text=stripped,
                    stored_answer_text=opt.lower(),
                ).model_dump(mode="json")
        for canonical, syns in labels.items():
            for syn in syns:
                if syn.lower() == low:
                    return InterviewQuestionResponse(
                        raw_user_text=stripped,
                        stored_answer_text=str(canonical).lower(),
                    ).model_dump(mode="json")
        raise ValueError("unrecognized_choice")

    raise ValueError("unsupported_question_type")


# --- Agent output (Gemini JSON schema) --------------------------------------


class InterviewAnswerNormalizationAgentOutput(BaseModel):
    """Structured output from the normalization sub-agent."""

    reasoning: str = Field(
        default="",
        description="Brief rationale for how the message maps to the question.",
    )
    accepted: bool = Field(
        description="True only if the user clearly answered this interview step.",
    )
    stored_answer_text: str | None = Field(
        default=None,
        description=(
            "Canonical value to persist (typed per question). Required when accepted is true."
        ),
    )
    retry_guidance: str | None = Field(
        default=None,
        description="One short sentence for the user when accepted is false.",
    )


class InterviewNormalizationRejected(Exception):
    """Raised when the agent or schema gates reject a candidate answer."""

    def __init__(self, *, code: str, user_message: str) -> None:
        self.code = code
        self.user_message = user_message
        super().__init__(code)


def _finalize_agent_output_to_response(
    agent: InterviewAnswerNormalizationAgentOutput,
    *,
    question_payload: dict[str, Any],
    raw_user_text: str,
) -> dict[str, Any]:
    """Turn agent JSON + question schema into ``InterviewQuestionResponse`` dict."""
    from src.main import InterviewQuestionResponse, InterviewQuestionType

    stripped = raw_user_text.strip()
    if question_payload.get("answer_required", True) and not stripped:
        raise InterviewNormalizationRejected(
            code="answer_required",
            user_message="Please answer this question.",
        )

    if not agent.accepted:
        raise InterviewNormalizationRejected(
            code="agent_rejected",
            user_message=(
                (agent.retry_guidance or "").strip()
                or "Please clarify your answer so it fits this question."
            ),
        )

    if agent.stored_answer_text is None or not str(agent.stored_answer_text).strip():
        raise InterviewNormalizationRejected(
            code="missing_stored_answer",
            user_message="I could not derive a clear value from your message.",
        )

    qt = InterviewQuestionType(question_payload["question_type"])
    raw_stored = str(agent.stored_answer_text).strip()

    if qt == InterviewQuestionType.TEXT:
        stored = raw_stored
        if not stored:
            raise InterviewNormalizationRejected(
                code="empty_text",
                user_message="Please provide a non-empty answer.",
            )

    elif qt == InterviewQuestionType.NUMBER:
        s = raw_stored.replace(",", ".")
        m = re.search(r"-?\d+(?:\.\d+)?", s)
        if not m:
            raise InterviewNormalizationRejected(
                code="not_a_number",
                user_message=(
                    "Please answer with a number (digits or a decimal the model can read)."
                ),
            )
        stored = str(m.group(0))

    elif qt == InterviewQuestionType.BOOLEAN:
        gated = _boolean_stored_from_token(raw_stored)
        if gated is None:
            raise InterviewNormalizationRejected(
                code="not_yes_no",
                user_message="Please answer with yes or no (or sí / no).",
            )
        stored = gated

    elif qt == InterviewQuestionType.CHOICE:
        opts = [str(o) for o in (question_payload.get("choice_options") or [])]
        cand = raw_stored.lower()
        match = next((o for o in opts if o.lower() == cand), None)
        if match is None:
            raise InterviewNormalizationRejected(
                code="choice_not_in_options",
                user_message="Please pick one of the listed options.",
            )
        stored = match.lower()

    else:
        raise InterviewNormalizationRejected(
            code="unsupported_question_type",
            user_message="Unsupported question type.",
        )

    return InterviewQuestionResponse(
        raw_user_text=stripped,
        stored_answer_text=stored,
    ).model_dump(mode="json")


def _normalization_prompt(question_payload: dict[str, Any], raw_user_text: str) -> str:
    qjson = json.dumps(question_payload, ensure_ascii=False, indent=2)
    return (
        "You normalize a single user reply for one structured interview question.\n"
        "Infer intent; prefer concise canonical stored_answer_text values.\n\n"
        "Rules:\n"
        "- TEXT: stored_answer_text = substantive reply (trimmed).\n"
        "- NUMBER: stored_answer_text must contain digits the backend can parse "
        "(e.g. '15', '12.5'); rewrite phrases like 'quince años' to digits.\n"
        "- BOOLEAN: stored_answer_text must be exactly 'yes' or 'no' (English).\n"
        "- CHOICE: stored_answer_text must match one choice_options entry (case-insensitive).\n"
        "- If the user did not answer this step, set accepted=false and retry_guidance.\n\n"
        f"Question JSON:\n{qjson}\n\n"
        f"User message:\n{raw_user_text}\n"
    )


@runtime_checkable
class InterviewAnswerNormalizer(Protocol):
    """LangGraph validation delegates here."""

    is_deterministic: bool

    def normalize(
        self,
        question_payload: dict[str, Any],
        raw_user_text: str,
    ) -> dict[str, Any]: ...


class DeterministicInterviewAnswerNormalizer:
    """Strict offline parser (shared rules with ``deterministic_parse_interview_response``)."""

    is_deterministic = True

    def normalize(
        self,
        question_payload: dict[str, Any],
        raw_user_text: str,
    ) -> dict[str, Any]:
        return deterministic_parse_interview_response(
            question_payload,
            raw_user_text,
        )


class GeminiInterviewAnswerNormalizer:
    """Gemini JSON-schema agent — reasoning + structured fields."""

    is_deterministic = False

    def __init__(self, *, api_key: str, model_name: str) -> None:
        self._client = genai.Client(api_key=api_key)
        self._model_name = model_name

    def normalize(
        self,
        question_payload: dict[str, Any],
        raw_user_text: str,
    ) -> dict[str, Any]:
        prompt = _normalization_prompt(question_payload, raw_user_text)
        schema = InterviewAnswerNormalizationAgentOutput.model_json_schema()
        resp = self._client.models.generate_content(
            model=self._model_name,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.1,
                response_mime_type="application/json",
                response_json_schema=schema,
            ),
        )
        text = (resp.text or "").strip()
        if not text:
            raise InterviewNormalizationRejected(
                code="agent_empty_response",
                user_message="Could not interpret that reply; please try again.",
            )
        try:
            agent_out = InterviewAnswerNormalizationAgentOutput.model_validate_json(
                text
            )
        except ValidationError as exc:
            raise InterviewNormalizationRejected(
                code="agent_invalid_json",
                user_message="Could not interpret that reply; please try again.",
            ) from exc

        return _finalize_agent_output_to_response(
            agent_out,
            question_payload=question_payload,
            raw_user_text=raw_user_text,
        )


def build_interview_answer_normalizer(
    *,
    gemini_api_key: str | None,
    model_name: str,
) -> InterviewAnswerNormalizer:
    key = (gemini_api_key or "").strip()
    if key:
        return GeminiInterviewAnswerNormalizer(api_key=key, model_name=model_name)
    return DeterministicInterviewAnswerNormalizer()
