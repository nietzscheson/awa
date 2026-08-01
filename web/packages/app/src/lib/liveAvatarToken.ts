/**
 * Pure builder for the LiveAvatar "create session token" request — LITE mode.
 *
 * LITE is the mode where LiveAvatar renders *only* the avatar: no VAD, no STT,
 * no LLM, no TTS. We drive it by pushing raw PCM with
 * `LiveAvatarSession.repeatAudio()`, and it lip-syncs whatever we send.
 *
 * That is exactly what this app needs: the interview is conducted by the ADK
 * agent (Gemini Live) over `/adk/run_live`, so the brain, the tools and the
 * session state already live there. The avatar is a face for audio we already
 * have — not a second conversational agent.
 *
 * Consequently, and unlike the FULL-mode sibling in `@awa/liveavatar`, there is
 * no `avatar_persona` / `voice_agent` here: those configure LiveAvatar's own
 * LLM and voice, which LITE never runs. (FULL rejects a request that omits
 * both; LITE rejects nothing and ignores them.)
 *
 * Reference: POST https://api.liveavatar.com/v1/sessions/token
 * (docs.liveavatar.com/api-reference/sessions/create-session-token)
 */

/** Default LiveAvatar API origin; override with `LIVEAVATAR_API_URL`. */
export const LIVEAVATAR_API_URL = "https://api.liveavatar.com";

/**
 * "Wayne" — the only avatar sandbox mode accepts. Sandbox sessions burn no
 * credits but self-terminate after ~1 minute.
 * (docs.liveavatar.com/docs/sandbox-mode)
 */
export const SANDBOX_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";

/** Video qualities accepted by `video_settings.quality`. */
const VIDEO_QUALITIES = ["very_high", "high", "medium", "low"] as const;

export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

/**
 * The subset of `process.env` this module reads. The index signature keeps the
 * type assignable from `ProcessEnv` (which is itself a string map).
 */
export interface LiveAvatarEnv {
  readonly [key: string]: string | undefined;
  LIVEAVATAR_API_KEY?: string;
  LIVEAVATAR_API_URL?: string;
  LIVEAVATAR_AVATAR_ID?: string;
  LIVEAVATAR_SANDBOX?: string;
  LIVEAVATAR_VIDEO_QUALITY?: string;
  LIVEAVATAR_MAX_SESSION_DURATION?: string;
}

export interface LiteTokenRequest {
  /** Absolute URL to POST to. */
  url: string;
  /** Value for the `X-API-KEY` header. */
  apiKey: string;
  /** JSON body for the request. */
  body: Record<string, unknown>;
}

/** Thrown when the environment can't produce a valid request at all. */
export class LiveAvatarConfigError extends Error {}

const isTruthy = (value: string | undefined): boolean =>
  /^(1|true|yes|on)$/i.test((value ?? "").trim());

/**
 * Translate env vars into a ready-to-send LITE token request.
 *
 * @throws {LiveAvatarConfigError} when the API key is missing, or when no
 *   avatar id is available outside sandbox mode.
 */
export function buildLiteTokenRequest(env: LiveAvatarEnv): LiteTokenRequest {
  const apiKey = env.LIVEAVATAR_API_KEY?.trim();
  if (!apiKey) {
    throw new LiveAvatarConfigError(
      "LIVEAVATAR_API_KEY is missing. Create one at https://app.liveavatar.com/developers and add it to .env.",
    );
  }

  const isSandbox = isTruthy(env.LIVEAVATAR_SANDBOX);
  // In sandbox only Wayne is allowed, so pin it and ignore any other id.
  const avatarId = isSandbox ? SANDBOX_AVATAR_ID : env.LIVEAVATAR_AVATAR_ID?.trim();

  if (!avatarId) {
    throw new LiveAvatarConfigError(
      "LIVEAVATAR_AVATAR_ID is missing. Pick one from GET /v1/avatars/public, " +
        "or set LIVEAVATAR_SANDBOX=true to try it for free with the Wayne avatar.",
    );
  }

  const quality = env.LIVEAVATAR_VIDEO_QUALITY?.trim() as VideoQuality | undefined;
  const videoQuality = quality && VIDEO_QUALITIES.includes(quality) ? quality : "high";

  const body: Record<string, unknown> = {
    mode: "LITE",
    avatar_id: avatarId,
    is_sandbox: isSandbox,
    video_settings: { quality: videoQuality, encoding: "H264" },
  };

  const maxDuration = Number.parseInt(env.LIVEAVATAR_MAX_SESSION_DURATION ?? "", 10);
  if (Number.isFinite(maxDuration) && maxDuration > 0) {
    body.max_session_duration = maxDuration;
  }

  const apiUrl = (env.LIVEAVATAR_API_URL?.trim() || LIVEAVATAR_API_URL).replace(/\/$/, "");

  return { url: `${apiUrl}/v1/sessions/token`, apiKey, body };
}
