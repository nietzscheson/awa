from enum import StrEnum


class GeminiSessionLanguage(StrEnum):
    """BCP-47 style tags accepted for Gemini Live ``SpeechConfig.language_code``."""

    ES_MX = "es-MX"
    EN_US = "en-US"
    ES = "es"
    EN = "en"

    @property
    def display_name(self) -> str:
        """The language as a person would name it, for use in a prompt."""
        return _LANGUAGE_DISPLAY_NAMES[self]


_LANGUAGE_DISPLAY_NAMES = {
    GeminiSessionLanguage.ES_MX: "Mexican Spanish",
    GeminiSessionLanguage.EN_US: "American English",
    GeminiSessionLanguage.ES: "Spanish",
    GeminiSessionLanguage.EN: "English",
}


def language_display_name(code: str) -> str:
    """Human name for a BCP-47 code, for the interviewer's instruction.

    ``SpeechConfig.language_code`` is what makes the *voice* speak a language;
    it says nothing to the model about which language to compose in. Both have to
    come from the same setting or they drift apart, which is how you end up with
    an English prompt read aloud by a Spanish voice.

    An unrecognised code is passed through as-is: naming it in the prompt is
    still better than saying nothing, and it keeps ``GEMINI_LANGUAGE_CODE`` open
    to any tag Gemini accepts.
    """
    try:
        return GeminiSessionLanguage(code).display_name
    except ValueError:
        return code


class GeminiModelVoiceName(StrEnum):
    """Prebuilt Gemini Live API voices selectable for native-audio output.

    Values map 1:1 to ``PrebuiltVoiceConfig.voice_name``. Voices are
    language-agnostic; the spoken language is driven by ``SpeechConfig.language_code``
    (see ``Settings.GEMINI_LANGUAGE_CODE``). Full list / audio previews:
    https://ai.google.dev/gemini-api/docs/live-guide#change-voice
    """

    ZEPHYR = "Zephyr"
    PUCK = "Puck"
    CHARON = "Charon"
    KORE = "Kore"
    FENRIR = "Fenrir"
    LEDA = "Leda"
    ORUS = "Orus"
    AOEDE = "Aoede"
    ENCELADUS = "Enceladus"
    IAPETUS = "Iapetus"
    UMBRIEL = "Umbriel"
    ALGIEBA = "Algieba"
    DESPINA = "Despina"
    ERINOME = "Erinome"
    ALGENIB = "Algenib"
    RASALGETHI = "Rasalgethi"
    LAOMEDEIA = "Laomedeia"
    ACHERNAR = "Achernar"
    ALNILAM = "Alnilam"
    SCHEDAR = "Schedar"
    GACRUX = "Gacrux"
    PULCHERRIMA = "Pulcherrima"
    ACHIRD = "Achird"
    ZUBENELGENUBI = "Zubenelgenubi"
    VINDEMIATRIX = "Vindemiatrix"
    SADACHBIA = "Sadachbia"
    SADALTAGER = "Sadaltager"
    SULAFAT = "Sulafat"


class GeminiThinkingLevel(StrEnum):
    """Gemini thinking level for the streaming agent."""

    NO_THINKING = "MINIMAL"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
