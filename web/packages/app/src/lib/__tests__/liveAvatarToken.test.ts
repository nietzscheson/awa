import {
  buildLiteTokenRequest,
  LiveAvatarConfigError,
  LIVEAVATAR_API_URL,
  SANDBOX_AVATAR_ID,
} from "@/lib/liveAvatarToken";

describe("buildLiteTokenRequest", () => {
  it("asks for LITE mode and no persona — the agent owns the conversation", () => {
    const { url, apiKey, body } = buildLiteTokenRequest({
      LIVEAVATAR_API_KEY: "key-123",
      LIVEAVATAR_AVATAR_ID: "avatar-abc",
    });

    expect(url).toBe(`${LIVEAVATAR_API_URL}/v1/sessions/token`);
    expect(apiKey).toBe("key-123");
    expect(body).toEqual({
      mode: "LITE",
      avatar_id: "avatar-abc",
      is_sandbox: false,
      video_settings: { quality: "high", encoding: "H264" },
    });
    // A persona would configure LiveAvatar's own LLM and voice, which LITE
    // never runs — sending one invites confusion about who is talking.
    expect(body).not.toHaveProperty("avatar_persona");
    expect(body).not.toHaveProperty("voice_agent");
  });

  it("pins the sandbox avatar and ignores any configured id", () => {
    const { body } = buildLiteTokenRequest({
      LIVEAVATAR_API_KEY: "key-123",
      LIVEAVATAR_AVATAR_ID: "avatar-abc",
      LIVEAVATAR_SANDBOX: "true",
    });

    expect(body.avatar_id).toBe(SANDBOX_AVATAR_ID);
    expect(body.is_sandbox).toBe(true);
  });

  it.each(["1", "TRUE", "yes", "on"])("treats %s as sandbox", (value) => {
    const { body } = buildLiteTokenRequest({
      LIVEAVATAR_API_KEY: "key-123",
      LIVEAVATAR_SANDBOX: value,
    });
    expect(body.is_sandbox).toBe(true);
  });

  it("falls back to high quality for an unknown value", () => {
    const { body } = buildLiteTokenRequest({
      LIVEAVATAR_API_KEY: "key-123",
      LIVEAVATAR_AVATAR_ID: "avatar-abc",
      LIVEAVATAR_VIDEO_QUALITY: "ultra",
    });
    expect(body.video_settings).toEqual({ quality: "high", encoding: "H264" });
  });

  it("passes a positive max_session_duration through and drops junk", () => {
    const withDuration = buildLiteTokenRequest({
      LIVEAVATAR_API_KEY: "key-123",
      LIVEAVATAR_AVATAR_ID: "a",
      LIVEAVATAR_MAX_SESSION_DURATION: "600",
    });
    expect(withDuration.body.max_session_duration).toBe(600);

    for (const value of ["0", "-5", "abc", ""]) {
      const { body } = buildLiteTokenRequest({
        LIVEAVATAR_API_KEY: "key-123",
        LIVEAVATAR_AVATAR_ID: "a",
        LIVEAVATAR_MAX_SESSION_DURATION: value,
      });
      expect(body).not.toHaveProperty("max_session_duration");
    }
  });

  it("honours a custom API origin without doubling the slash", () => {
    const { url } = buildLiteTokenRequest({
      LIVEAVATAR_API_KEY: "key-123",
      LIVEAVATAR_AVATAR_ID: "a",
      LIVEAVATAR_API_URL: "https://staging.example.com/",
    });
    expect(url).toBe("https://staging.example.com/v1/sessions/token");
  });

  it("refuses to build a request without an API key", () => {
    expect(() => buildLiteTokenRequest({ LIVEAVATAR_AVATAR_ID: "a" })).toThrow(
      LiveAvatarConfigError,
    );
    expect(() => buildLiteTokenRequest({ LIVEAVATAR_API_KEY: "  " })).toThrow(
      /LIVEAVATAR_API_KEY/,
    );
  });

  it("refuses a non-sandbox request with no avatar id", () => {
    expect(() => buildLiteTokenRequest({ LIVEAVATAR_API_KEY: "key-123" })).toThrow(
      /LIVEAVATAR_AVATAR_ID/,
    );
  });
});
