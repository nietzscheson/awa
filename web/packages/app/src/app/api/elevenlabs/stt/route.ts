import { NextResponse } from "next/server";

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

export async function POST(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "ELEVENLABS_API_KEY is missing. Set it in the repo-root .env (loaded by Next.js config).",
      },
      { status: 503 },
    );
  }

  const contentType = req.headers.get("content-type") || "multipart/form-data";
  const body = await req.arrayBuffer();

  try {
    const upstream = await fetch(STT_URL, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": contentType,
      },
      body,
    });
    const buf = await upstream.arrayBuffer();
    const ct = upstream.headers.get("content-type") || "application/json";
    return new NextResponse(buf, {
      status: upstream.status,
      headers: { "Content-Type": ct },
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "ElevenLabs STT proxy failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }
}
