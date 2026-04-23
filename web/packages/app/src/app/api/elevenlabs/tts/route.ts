import { NextResponse } from "next/server";

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

  try {
    const upstream = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: ttsModel,
      }),
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
