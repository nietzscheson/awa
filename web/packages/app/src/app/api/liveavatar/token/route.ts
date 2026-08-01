import { NextResponse } from "next/server";

import { buildLiteTokenRequest, LiveAvatarConfigError } from "@/lib/liveAvatarToken";
import { rootEnv } from "@/lib/rootEnv";

/**
 * Mints a short-lived LiveAvatar session token for the talking head.
 *
 * This hop exists purely so `LIVEAVATAR_API_KEY` stays on the server: the
 * browser receives only a per-session JWT, which the Web SDK then exchanges for
 * LiveKit credentials via `POST /v1/sessions/start` on its own.
 *
 * The avatar is optional decoration for this app — the interview itself runs
 * over the ADK WebSocket. So every failure here is reported as a message the UI
 * can show while carrying on without a face.
 */

// Reads process.env and calls a third party — must never be prerendered.
export const dynamic = "force-dynamic";

export async function POST() {
  let request;
  try {
    request = buildLiteTokenRequest(rootEnv());
  } catch (error) {
    if (error instanceof LiveAvatarConfigError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }

  let upstream: Response;
  try {
    upstream = await fetch(request.url, {
      method: "POST",
      headers: {
        "X-API-KEY": request.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request.body),
      cache: "no-store",
    });
  } catch (cause) {
    console.error("[liveavatar] token request failed", cause);
    return NextResponse.json(
      { error: "No se pudo contactar con la API de LiveAvatar." },
      { status: 502 },
    );
  }

  const payload = (await upstream.json().catch(() => null)) as {
    code?: number;
    message?: string | null;
    data?: { session_id?: string; session_token?: string };
  } | null;

  if (!upstream.ok || !payload?.data?.session_token) {
    // `message` carries LiveAvatar's own explanation (bad avatar id, no
    // credits, …); pass it through so the UI can show something actionable.
    const detail = payload?.message || `HTTP ${upstream.status}`;
    console.error("[liveavatar] token rejected", upstream.status, detail);
    return NextResponse.json(
      { error: `LiveAvatar rejected the session: ${detail}` },
      { status: upstream.status === 200 ? 502 : upstream.status },
    );
  }

  return NextResponse.json({
    session_id: payload.data.session_id,
    session_token: payload.data.session_token,
    is_sandbox: request.body.is_sandbox === true,
  });
}
