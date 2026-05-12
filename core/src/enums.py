from enum import StrEnum


class SessionLanguage(StrEnum):
    """BCP-47 style tags the API accepts for `CreateSessionRequest.language`."""

    ES_MX = "es-MX"
    EN_US = "en-US"
    ES = "es"
    EN = "en"


class UserTypeProfession(StrEnum):
    """Work situation the agent infers from the profession answer; stored as ``user:employment_type``.

    Primary buckets for most candidates: ``self_employed`` (includes freelance), ``employee``,
    ``business_owner``. Other values remain for edge cases (student, retired, etc.).
    """

    SELF_EMPLOYED = "self_employed"
    EMPLOYEE = "employee"
    BUSINESS_OWNER = "business_owner"
    STUDENT = "student"
    RETIRED = "retired"
    UNEMPLOYED_SEEKING = "unemployed_seeking"
    OTHER = "other"
