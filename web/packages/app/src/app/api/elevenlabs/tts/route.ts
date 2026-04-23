import { NextResponse } from "next/server";

/** Parse optional float env; invalid or empty → undefined (caller skips the field). */
function envFloat(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse optional boolean env (``true``/``1`` vs ``false``/``0``); invalid or empty → undefined. */
function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

/** Per-request ElevenLabs overrides; omitted keys use the voice's stored defaults upstream. */
function voiceSettingsFromEnv(): Record<string, number | boolean> | undefined {
  const out: Record<string, number | boolean> = {};
  const stability = envFloat("ELEVENLABS_TTS_STABILITY");
  const similarityBoost = envFloat("ELEVENLABS_TTS_SIMILARITY_BOOST");
  const style = envFloat("ELEVENLABS_TTS_STYLE");
  const speed = envFloat("ELEVENLABS_TTS_SPEED");
  const useSpeakerBoost = envBool("ELEVENLABS_TTS_USE_SPEAKER_BOOST");
  if (stability !== undefined) out.stability = stability;
  if (similarityBoost !== undefined) out.similarity_boost = similarityBoost;
  if (style !== undefined) out.style = style;
  if (speed !== undefined) out.speed = speed;
  if (useSpeakerBoost !== undefined) out.use_speaker_boost = useSpeakerBoost;
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function POST(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_TTS_VOICE_ID;
  const ttsModel =
    process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2";

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "ELEVENLABS_API_KEY is missing. Set it in the repo-root .env (loaded by Next.js config).",
      },
      { status: 503 },
    );
  }
  if (!voiceId) {
    return NextResponse.json(
      {
        error:
          "ELEVENLABS_TTS_VOICE_ID is missing. Set it in the repo-root .env.",
      },
      { status: 503 },
    );
  }

  let text = "";
  try {
    const parsed = (await req.json()) as { text?: string };
    text = (parsed.text ?? "").trim();
  } catch {
    return NextResponse.json(
      { error: "Expected JSON body { text: string }" },
      { status: 400 },
    );
  }

  if (!text) {
    return NextResponse.json(
      { error: "Expected JSON body { text: string }" },
      { status: 400 },
    );
  }

  const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const voiceSettings = voiceSettingsFromEnv();
  const payload: Record<string, unknown> = { text, model_id: ttsModel };
  if (voiceSettings) payload.voice_settings = voiceSettings;

  try {
    const upstream = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const buf = await upstream.arrayBuffer();
    const ct = upstream.headers.get("content-type") || "audio/mpeg";
    return new NextResponse(buf, {
      status: upstream.status,
      headers: { "Content-Type": ct },
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "ElevenLabs TTS proxy failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }
}
