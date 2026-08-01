import contextlib
from typing import Any

from google.adk.agents.callback_context import CallbackContext
from google.adk.tools.tool_context import ToolContext

from src.schemas import Question, Questions


class InterviewService:
    """Stateful interview conductor (python-tutor quiz pattern).

    Progress lives in the ADK session state (``ToolContext.state``), not in the
    model's memory: a ``current_question_index`` cursor, the collected ``answers``
    keyed by question id, and an ``interview_started`` flag. Tools advance the
    cursor themselves, so the model never has to remember which question came last.

    State keys (all session-scoped, JSON-serializable for ``DatabaseSessionService``):
    - ``interview_initialized``: set once by :meth:`before_agent_callback`.
    - ``interview_started``: ``True`` after :meth:`start_interview`.
    - ``current_question_index``: 0-based cursor into ``QUESTIONS``.
    - ``answers``: ``{question_id: stored_answer_text}``.
    - ``total_answered``: count of accepted answers.
    - ``interview_confirmed``: ``True`` once the candidate has checked the
      answers read back to them. Any correction clears it again.
    """

    QUESTIONS: Questions = Questions(
        questions=[
            # Confirmation questions seeded from the session metadata
            # (``first_name``/``last_name``/``ine_address`` passed at session
            # creation). ``{...}`` placeholders are filled by ``_render_question``.
            Question(
                id="confirm_name",
                question="To start, can you confirm your name is {full_name}?",
                type="BOOLEAN",
            ),
            Question(
                id="confirm_address",
                question="And is your registered address {ine_address}? Is that correct?",
                type="BOOLEAN",
            ),
            Question(id="2", question="What is your age?", type="NUMBER"),
            Question(id="3", question="What is your email?", type="CHOICE"),
            Question(id="4", question="What is your phone number?", type="BOOLEAN"),
        ],
    )

    @staticmethod
    def _questions() -> list[Question]:
        return InterviewService.QUESTIONS.questions

    @staticmethod
    def _render_question(question: Question, state: dict[str, Any]) -> dict[str, Any]:
        """Return ``question`` as a dict with ``{...}`` placeholders filled from state.

        The session metadata seeds ``first_name``, ``last_name`` and
        ``ine_address``; questions without placeholders pass through unchanged.
        """
        data = question.model_dump()
        first = (state.get("first_name") or "").strip()
        last = (state.get("last_name") or "").strip()
        full_name = " ".join(part for part in (first, last) if part)
        # Leave the raw text if a template references an unknown placeholder.
        with contextlib.suppress(KeyError, IndexError, ValueError):
            data["question"] = data["question"].format(
                first_name=first,
                last_name=last,
                full_name=full_name or "your name",
                ine_address=(state.get("ine_address") or "").strip()
                or "your registered address",
            )
        return data

    @staticmethod
    def _collected_answers(state: dict[str, Any]) -> list[dict[str, str]]:
        """The answers so far, in questionnaire order, with their question text.

        Shaped for reading back to the candidate — and for the client, which
        renders this same list in the chat when it sees the tool response. Hence
        the rendered question text rather than the raw template: what is confirmed
        should be what was asked.
        """
        answers = state.get("answers") or {}
        return [
            {
                "id": question.id,
                "question": InterviewService._render_question(question, state)[
                    "question"
                ],
                "answer": answers[question.id],
            }
            for question in InterviewService._questions()
            if question.id in answers
        ]

    @staticmethod
    def initialize_interview_state(state: dict[str, Any]) -> None:
        """Seed interview keys once per session (idempotent)."""
        if state.get("interview_initialized"):
            return
        state["interview_initialized"] = True
        state["interview_started"] = False
        state["current_question_index"] = 0
        state["total_answered"] = 0
        state["answers"] = {}
        state["interview_confirmed"] = False

    @staticmethod
    def before_agent_callback(callback_context: CallbackContext) -> None:
        """``before_agent_callback`` hook: ensure interview state exists."""
        InterviewService.initialize_interview_state(callback_context.state)
        return None

    @staticmethod
    def get_interview_questions() -> dict[str, Any]:
        """Return the full questionnaire (inspect-only; does not change progress)."""
        questions = InterviewService._questions()
        return {
            "status": "success",
            "total_questions": len(questions),
            "questions": [question.model_dump() for question in questions],
        }

    @staticmethod
    def start_interview(tool_context: ToolContext) -> dict[str, Any]:
        """Begin the interview from question 1, resetting any prior progress."""
        state = tool_context.state
        state["interview_started"] = True
        state["current_question_index"] = 0
        state["total_answered"] = 0
        state["answers"] = {}
        state["interview_confirmed"] = False

        questions = InterviewService._questions()
        if not questions:
            return {"status": "error", "error_message": "No questions available."}

        return {
            "status": "started",
            "question": InterviewService._render_question(questions[0], state),
            "question_number": 1,
            "total_questions": len(questions),
        }

    @staticmethod
    def get_current_question(tool_context: ToolContext) -> dict[str, Any]:
        """Return the question currently pointed at by the cursor."""
        state = tool_context.state
        if not state.get("interview_started", False):
            return {
                "status": "error",
                "error_message": "Interview not started. Call start_interview first.",
            }

        questions = InterviewService._questions()
        index = state.get("current_question_index", 0)
        if index < len(questions):
            return {
                "status": "success",
                "question": InterviewService._render_question(questions[index], state),
                "question_number": index + 1,
                "total_questions": len(questions),
                "is_complete": False,
            }
        return {
            "status": "complete",
            "is_complete": True,
            "message": "All interview questions have been answered.",
        }

    @staticmethod
    def submit_answer(tool_context: ToolContext, answer: str) -> dict[str, Any]:
        """Store ``answer`` for the current question and advance to the next one."""
        state = tool_context.state
        if not state.get("interview_started", False):
            return {
                "status": "error",
                "error_message": "Interview not started. Call start_interview first.",
            }

        questions = InterviewService._questions()
        index = state.get("current_question_index", 0)
        if index >= len(questions):
            return {
                "status": "error",
                "error_message": "Interview already complete.",
                "is_complete": True,
                "answers": state.get("answers", {}),
            }

        current = questions[index]
        answers = dict(state.get("answers") or {})
        answers[current.id] = answer.strip()
        state["answers"] = answers
        state["total_answered"] = state.get("total_answered", 0) + 1
        state["current_question_index"] = index + 1

        response: dict[str, Any] = {
            "status": "success",
            "answered_question": InterviewService._render_question(current, state),
            "stored_answer": answer.strip(),
            "questions_answered": state["total_answered"],
            "questions_remaining": len(questions) - state["current_question_index"],
        }

        if state["current_question_index"] < len(questions):
            following = questions[state["current_question_index"]]
            response["is_complete"] = False
            response["next_question"] = InterviewService._render_question(
                following, state
            )
            response["next_question_number"] = state["current_question_index"] + 1
        else:
            response["is_complete"] = True
            response["message"] = "All interview questions have been answered."
            response["answers"] = answers

        return response

    @staticmethod
    def get_interview_status(tool_context: ToolContext) -> dict[str, Any]:
        """Report progress: started flag, cursor, counts, and collected answers."""
        state = tool_context.state
        questions = InterviewService._questions()
        index = state.get("current_question_index", 0)
        return {
            "status": "success",
            "interview_started": state.get("interview_started", False),
            "current_question_index": index,
            "questions_answered": state.get("total_answered", 0),
            "questions_remaining": max(len(questions) - index, 0),
            "total_questions": len(questions),
            "is_complete": index >= len(questions),
            "answers": state.get("answers", {}),
        }

    @staticmethod
    def review_answers(tool_context: ToolContext) -> dict[str, Any]:
        """Read back everything the candidate answered, for them to confirm.

        The last step of the interview is not "thank you, goodbye" but "is this
        right?", so this is what the agent calls once the questions run out.
        """
        state = tool_context.state
        questions = InterviewService._questions()
        index = state.get("current_question_index", 0)
        return {
            "status": "success",
            "is_complete": index >= len(questions),
            "confirmed": bool(state.get("interview_confirmed", False)),
            "answers": InterviewService._collected_answers(state),
            "message": (
                "Read these back to the candidate and ask whether everything is "
                "correct. Use correct_answer for anything they want changed."
            ),
        }

    @staticmethod
    def correct_answer(
        tool_context: ToolContext, question_id: str, answer: str
    ) -> dict[str, Any]:
        """Replace one stored answer, without moving the interview forward.

        Separate from ``submit_answer`` on purpose: that one advances the cursor,
        which is wrong here — a correction happens after the questionnaire is
        done and must not re-open it. A correction also drops any confirmation
        already given, since what was confirmed is no longer what is stored.
        """
        state = tool_context.state
        answers = dict(state.get("answers") or {})
        wanted = question_id.strip()

        if wanted not in answers:
            return {
                "status": "error",
                "error_message": (
                    f"No answer stored for question_id {question_id!r}. "
                    "Call review_answers and use one of the ids it returns."
                ),
                "valid_question_ids": list(answers),
            }

        answers[wanted] = answer.strip()
        state["answers"] = answers
        state["interview_confirmed"] = False

        corrected = next(
            item
            for item in InterviewService._collected_answers(state)
            if item["id"] == wanted
        )
        return {
            "status": "success",
            "corrected": corrected,
            "answers": InterviewService._collected_answers(state),
            "message": (
                "Confirm the corrected answer with the candidate and ask again "
                "whether everything is now correct."
            ),
        }

    @staticmethod
    def confirm_interview(tool_context: ToolContext) -> dict[str, Any]:
        """Seal the interview: the candidate says the answers are correct.

        Call it only after they have actually confirmed. The client watches for
        this response to close the call, so it doubles as "we are done here".
        """
        state = tool_context.state
        questions = InterviewService._questions()
        if state.get("current_question_index", 0) < len(questions):
            return {
                "status": "error",
                "error_message": (
                    "The questionnaire is not finished; keep asking questions "
                    "before confirming."
                ),
                "questions_remaining": len(questions)
                - state.get("current_question_index", 0),
            }

        state["interview_confirmed"] = True
        return {
            "status": "confirmed",
            "answers": InterviewService._collected_answers(state),
            "message": (
                "Answers confirmed. Say goodbye now and stop; the interview is "
                "over and the call will close."
            ),
        }

    @staticmethod
    def reset_interview(tool_context: ToolContext) -> dict[str, Any]:
        """Clear all progress so the interview can start over."""
        state = tool_context.state
        state["interview_started"] = False
        state["current_question_index"] = 0
        state["total_answered"] = 0
        state["answers"] = {}
        state["interview_confirmed"] = False
        return {
            "status": "success",
            "message": "Interview has been reset. Call start_interview to begin again.",
        }
