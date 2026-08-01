/**
 * The languages an interview can be conducted in.
 *
 * The code goes into the ADK session state as `language`, where the agent's
 * instruction provider reads it (see `interviewer_instruction` in
 * core/src/container.py) — so these tags must be ones the agent knows how to
 * name: `core/src/enums.py::GeminiSessionLanguage`.
 *
 * Each option is labelled in its own language, which is what a person scanning a
 * language picker is looking for.
 */
export const INTERVIEW_LANGUAGES = [
  { code: "en-US", label: "English" },
  { code: "es-MX", label: "Español" },
] as const;

export type InterviewLanguage = (typeof INTERVIEW_LANGUAGES)[number]["code"];

export const DEFAULT_INTERVIEW_LANGUAGE: InterviewLanguage = "en-US";
