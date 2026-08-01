"""Smoke tests for the container-wired streaming interviewer agent."""

import asyncio
from types import MappingProxyType, SimpleNamespace

from src.container import (
    INTERVIEWER_TOOLS,
    MainContainer,
    build_interviewer_instruction,
    interviewer_instruction,
)
from src.services import InterviewService


def test_container_wires_streaming_agent():
    container = MainContainer()
    agent = container.streaming_agent()

    assert agent.name == "streaming_agent"
    assert agent.before_agent_callback is InterviewService.before_agent_callback
    assert list(agent.tools) == INTERVIEWER_TOOLS


def test_streaming_settings_defaults():
    settings = MainContainer().settings()

    assert settings["GEMINI_STREAMING_MODEL_NAME"]
    assert settings["GEMINI_VOICE_NAME"]
    assert settings["GEMINI_LANGUAGE_CODE"]
    assert settings["GEMINI_THINKING_LEVEL"]
    assert settings["DATABASE_URL"]


def test_instruction_names_the_interview_language():
    # Naming the language in the prompt is what makes the model compose in it;
    # SpeechConfig alone only ever configured the voice.
    english = build_interviewer_instruction("en-US")
    assert "American English" in english
    assert "Mexican Spanish" not in english

    spanish = build_interviewer_instruction("es-MX")
    assert "Mexican Spanish" in spanish

    # An unrecognised tag still reaches the prompt rather than being dropped.
    assert "fr-FR" in build_interviewer_instruction("fr-FR")


def test_instruction_tells_the_agent_to_open_the_interview():
    text = build_interviewer_instruction("en-US")

    # It must not wait to be spoken to, and must not read the app's cue aloud.
    assert "Do not wait to be spoken to" in text
    assert "[interview_start]" in text
    assert "never read one aloud" in text
    # State injection stays literal in the prompt; ADK fills it per session.
    assert "{first_name?}" in text


def _readonly_ctx(**state):
    """A stand-in ReadonlyContext: `.state` plus what state injection reads."""
    session = SimpleNamespace(
        state=dict(state), app_name="streaming", user_id="u", id="s"
    )
    return SimpleNamespace(
        state=MappingProxyType(session.state),
        _invocation_context=SimpleNamespace(session=session, artifact_service=None),
    )


def _resolve(provider, **state):
    return asyncio.run(provider(_readonly_ctx(**state)))


def test_session_state_chooses_the_interview_language():
    # The agent is a process-wide singleton, so the language cannot be baked in at
    # wiring time — the setup screen's choice arrives as session state.
    provider = interviewer_instruction("en-US")

    assert "Mexican Spanish" in _resolve(provider, language="es-MX")
    assert "American English" in _resolve(provider, language="en-US")


def test_language_falls_back_to_the_configured_default():
    provider = interviewer_instruction("es-MX")

    assert "Mexican Spanish" in _resolve(provider)  # nothing in state
    assert "Mexican Spanish" in _resolve(provider, language="")  # blank is nothing


def test_instruction_provider_injects_the_candidate_name():
    provider = interviewer_instruction("en-US")

    assert "greet Ada by name" in _resolve(provider, first_name="Ada")
    # An unnamed candidate leaves no template marker behind.
    assert "{first_name?}" not in _resolve(provider)


def test_agent_uses_the_state_aware_instruction_provider():
    agent = MainContainer().streaming_agent()

    assert callable(agent.instruction)
    assert "Mexican Spanish" in _resolve(agent.instruction, language="es-MX")


def test_speech_config_pins_the_voice_but_not_the_language():
    # A pinned language_code is per process and would contradict a per-session
    # choice; the language reaches the model through the instruction instead.
    speech = MainContainer().streaming_agent().canonical_model.speech_config

    assert speech.voice_config is not None
    assert speech.language_code is None
