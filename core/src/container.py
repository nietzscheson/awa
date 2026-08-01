from collections.abc import Awaitable, Callable

from dependency_injector import containers, providers
from google.adk import Agent
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.models import Gemini
from google.adk.planners import BuiltInPlanner
from google.adk.utils.instructions_utils import inject_session_state
from google.genai import types

from src.enums import language_display_name
from src.services import InterviewService
from src.settings import Settings

#: Session-state key the setup screen writes the chosen interview language to.
LANGUAGE_STATE_KEY = "language"


def build_interviewer_instruction(language_code: str) -> str:
    """The interviewer's prompt, bound to the language of the interview.

    The language is a parameter rather than a sentence typed into the prompt so
    that ``GEMINI_LANGUAGE_CODE`` is the single place it is decided: the same
    setting configures the voice (``SpeechConfig.language_code``) and tells the
    model what to compose in.

    ``{first_name?}`` is ADK state injection, filled from the session state the
    setup screen posts. The ``?`` makes it optional — an unnamed candidate gets an
    empty string, not a crash.
    """
    language = language_display_name(language_code)

    return f"""You are an interviewer agent conducting a live, spoken interview
    in {language}. The candidate hears you through a talking avatar and answers
    out loud, so everything you produce is speech.

    LANGUAGE
    - Conduct the whole interview in {language}, including the greeting.
    - If the candidate answers in another language, stay in {language}.

    OPENING
    - Open the interview yourself. Do not wait to be spoken to: the app sends a
      cue in square brackets (e.g. `[interview_start] ...`) the moment the
      candidate joins, and that is your turn to speak.
    - Bracketed cues come from the app, never from the candidate. Act on them and
      never read one aloud.
    - Introduce yourself briefly as the interviewer, greet {{first_name?}} by name
      if you have one, say you will ask a few short questions, then call
      `start_interview` and ask the first question it returns — all in the same
      turn, without pausing for permission.
    - Keep that opening to two or three sentences. It is a greeting, not a speech.

    CONDUCTING IT
    Interview progress is tracked for you in session state, so you never need to
    remember which question came last—just drive it with the tools:

    - Call `start_interview` once to begin (or to restart from the top). It
      returns the first `question`.
    - When the user answers the current question, call `submit_answer` with
      their reply as `answer`. It stores the answer and returns the
      `next_question` plus `is_complete`.
    - Ask the question text returned by the tools, in natural language.
    - Use `get_current_question` if you need to re-read the active question,
      `get_interview_status` to check progress and collected answers, and
      `reset_interview` to start over. `get_interview_questions` returns the
      full questionnaire for inspection only.

    Never call `submit_answer` before `start_interview` has been called.

    CONFIRMING AND CLOSING
    When a tool returns `is_complete: true` the questions are done, but the
    interview is not: nothing is final until the candidate has checked it.

    - Call `review_answers`, then read every answer back — one short line per
      question and answer, in the same order — and ask whether everything is
      correct. The app also shows this list in the chat, so read it briskly
      instead of spelling out every word.
    - If they want something changed, call `correct_answer` with that question's
      `id` and the new answer, read the corrected item back, and ask again whether
      everything is now correct. Repeat for as many corrections as they ask for.
      Do not call `submit_answer` for a correction; it would re-open the
      questionnaire.
    - Only once they say everything is correct, call `confirm_interview`. In that
      same turn, say goodbye: thank them, tell them the interview is complete, and
      stop. The app closes the microphone and the call as soon as you finish
      speaking, so ask nothing after the goodbye.
"""


def interviewer_instruction(
    default_language_code: str,
) -> Callable[[ReadonlyContext], Awaitable[str]]:
    """An ADK instruction provider that reads the language from session state.

    The language is a per-interview choice (the setup screen offers it), and the
    agent is a process-wide singleton — so it cannot be baked into the prompt at
    wiring time. An instruction provider is resolved per invocation instead, which
    is exactly the granularity we need: the candidate picks a language, the setup
    screen posts it as session state, and every turn of that session is prompted
    in it. ``GEMINI_LANGUAGE_CODE`` remains the default for a session that says
    nothing.

    A provider bypasses ADK's automatic state injection (see
    ``LlmAgent.canonical_instruction``), so ``{first_name?}`` is substituted here.
    """

    async def provider(ctx: ReadonlyContext) -> str:
        chosen = str(ctx.state.get(LANGUAGE_STATE_KEY) or "").strip()
        template = build_interviewer_instruction(chosen or default_language_code)
        return await inject_session_state(template, ctx)

    return provider


INTERVIEWER_TOOLS = [
    InterviewService.get_interview_questions,
    InterviewService.start_interview,
    InterviewService.submit_answer,
    InterviewService.get_current_question,
    InterviewService.get_interview_status,
    InterviewService.review_answers,
    InterviewService.correct_answer,
    InterviewService.confirm_interview,
    InterviewService.reset_interview,
]


class MainContainer(containers.DeclarativeContainer):
    wiring_config = containers.WiringConfiguration(modules=[__name__])

    settings = providers.Configuration(pydantic_settings=[Settings()])

    streaming_agent = providers.Singleton(
        Agent,
        name="streaming_agent",
        model=providers.Singleton(
            Gemini,
            model=settings.GEMINI_STREAMING_MODEL_NAME,
            # No `language_code` here on purpose: it is a property of this
            # process-wide model instance, and the ADK live endpoint gives no way
            # to override it per session (`run_agent_live` builds its own
            # RunConfig). Pinning it would fight the per-session choice — a
            # candidate picking Spanish would be composed in Spanish and voiced as
            # if it were English. The language now reaches the model through the
            # instruction, which IS per session.
            speech_config=providers.Singleton(
                types.SpeechConfig,
                voice_config=providers.Singleton(
                    types.VoiceConfig,
                    prebuilt_voice_config=providers.Singleton(
                        types.PrebuiltVoiceConfig,
                        voice_name=settings.GEMINI_VOICE_NAME,
                    ),
                ),
            ),
        ),
        planner=providers.Singleton(
            BuiltInPlanner,
            thinking_config=providers.Singleton(
                types.ThinkingConfig,
                thinking_level=settings.GEMINI_THINKING_LEVEL,
                # Thought summaries arrive as ordinary text parts, i.e. in the
                # same stream the transcript is built from — the candidate would
                # read the model reasoning about them, in English. Debug them in
                # the browser console instead (NEXT_PUBLIC_LIVE_DEBUG).
                include_thoughts=False,
            ),
        ),
        instruction=providers.Callable(
            interviewer_instruction,
            default_language_code=settings.GEMINI_LANGUAGE_CODE,
        ),
        tools=INTERVIEWER_TOOLS,
        before_agent_callback=InterviewService.before_agent_callback,
    )
