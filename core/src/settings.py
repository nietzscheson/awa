from pydantic import Field
from pydantic_settings import BaseSettings

from src.enums import GeminiModelVoiceName, GeminiSessionLanguage, GeminiThinkingLevel


class Settings(BaseSettings):
    GEMINI_STREAMING_MODEL_NAME: str = Field(
        default="gemini-3.1-flash-live-preview",
        description="Google Gemini Live model for the streaming agent.",
    )

    GEMINI_VOICE_NAME: GeminiModelVoiceName = Field(
        default=GeminiModelVoiceName.AOEDE,
        description="Prebuilt Gemini Live voice used for native audio output.",
    )

    GEMINI_LANGUAGE_CODE: str = Field(
        default=GeminiSessionLanguage.EN_US,
        description=(
            "Default BCP-47 language for the interview, used when the session "
            "does not choose one. The setup screen does choose (English or "
            "Spanish), and that choice wins for the whole session."
        ),
    )

    GEMINI_THINKING_LEVEL: GeminiThinkingLevel = Field(
        default=GeminiThinkingLevel.NO_THINKING,
        description=(
            "Gemini thinking level for the streaming agent. This is a live, "
            "spoken conversation: no audio is emitted while the model thinks, so "
            "anything above MINIMAL is dead air before the avatar answers. The "
            "interview logic lives in the tools, not in the model's reasoning."
        ),
    )

    DATABASE_URL: str = Field(
        default="postgresql+psycopg://postgres:postgres@localhost:5432/postgres",
        description="Database URL for ADK session storage.",
    )
