from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    GEMINI_MODEL_NAME: str = Field(
        default="gemini-2.5-flash", description="Google Gemini Model Name"
    )
    DATABASE_URL: str = Field(
        default="postgresql+psycopg://postgres:postgres@localhost:5432/postgres",
        description="Database URL",
    )

    APP_NAME: str = Field(
        default="awa", description="Application name stored with ADK sessions"
    )
    GOOGLE_API_KEY: str | None = Field(
        default=None,
        description="Gemini API key (https://ai.google.dev/gemini-api/docs/api-key)",
    )
    GEMINI_API_KEY: str | None = Field(
        default=None,
        description="Alternate env var for the Gemini API key; GOOGLE_API_KEY wins if both are set.",
    )
    ELEVENLABS_API_KEY: str | None = Field(
        default=None,
        description="ElevenLabs API key",
    )
    OPENAI_API_KEY: str | None = Field(
        default=None,
        description="OpenAI API key",
    )
    ELEVENLABS_TTS_VOICE_ID: str | None = Field(
        default=None,
        description="ElevenLabs TTS voice ID",
    )
    ELEVENLABS_TTS_MODEL: str | None = Field(
        default=None,
        description="ElevenLabs TTS model",
    )
