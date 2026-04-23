/** Pure helpers for the voice chat client (unit-tested). */

export function formatSessionWhen(t: number): string {
  if (!t || Number.isNaN(t)) return "—";
  const ms = t < 1e11 ? t * 1000 : t;
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return "—";
  }
}

export function shortSessionLabel(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

export function interviewEndedShellStatus(languageTag: string): string {
  return languageTag.toLowerCase().startsWith("en")
    ? "Call ended. Start a new conversation when you're ready."
    : "Llamada finalizada. Puedes iniciar una nueva conversación cuando quieras.";
}

export function sessionAlreadyFinishedStatus(languageTag: string): string {
  return languageTag.toLowerCase().startsWith("en")
    ? "This session's interview was already complete. Pick another or start new."
    : "Esta sesión ya tenía la entrevista completa. Elige otra o inicia una nueva.";
}

export function endingCallShortStatus(languageTag: string): string {
  return languageTag.toLowerCase().startsWith("en")
    ? "Ending the call…"
    : "Colgando la llamada…";
}

export function replayVoiceButtonLabel(languageTag: string): string {
  return languageTag.toLowerCase().startsWith("en") ? "Hear again" : "Oír de nuevo";
}

export function replayingAwaVoiceStatus(languageTag: string): string {
  return languageTag.toLowerCase().startsWith("en")
    ? "Replaying Awa voice…"
    : "Repitiendo la voz de Awa…";
}

export function replayFailedStatus(languageTag: string): string {
  return languageTag.toLowerCase().startsWith("en")
    ? "Replay failed"
    : "No se pudo repetir el audio";
}

/** Fallback when the model says the interview is over but SSE omits the flag. */
export function looksLikeInterviewFinishedReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/entrevista\s+ha\s+concluido/i.test(t)) return true;
  if (/entrevista\s+ha\s+finalizado/i.test(t)) return true;
  if (/entrevista\s+ha\s+terminado/i.test(t)) return true;
  if (/la\s+entrevista\s+ha\s+concluido/i.test(t)) return true;
  if (/interview\s+is\s+complete/i.test(t)) return true;
  if (/interview\s+has\s+(?:ended|concluded)/i.test(t)) return true;
  if (/the\s+interview\s+is\s+complete/i.test(t)) return true;
  return false;
}

export function extractTranscript(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const o = data as Record<string, unknown>;
  if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
  const transcripts = o.transcripts;
  if (Array.isArray(transcripts) && transcripts.length > 0) {
    const first = transcripts[0];
    if (first && typeof first === "object") {
      const t = (first as Record<string, unknown>).text;
      if (typeof t === "string") return t.trim();
    }
  }
  return "";
}

/** Every transcript line ElevenLabs returned (for raw debug; primary line may match ``extractTranscript``). */
export function extractAllTranscriptLines(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const o = data as Record<string, unknown>;
  const out: string[] = [];
  if (typeof o.text === "string" && o.text.trim()) out.push(o.text.trim());
  const transcripts = o.transcripts;
  if (Array.isArray(transcripts)) {
    for (const item of transcripts) {
      if (item && typeof item === "object") {
        const t = (item as Record<string, unknown>).text;
        if (typeof t === "string" && t.trim()) out.push(t.trim());
      }
    }
  }
  return [...new Set(out)];
}

export function truncateDetail(s: string, max = 480): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export function fmtRawTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

export function sttErrorMessage(sttJson: unknown, fallback: string): string {
  if (!sttJson || typeof sttJson !== "object") return fallback;
  const o = sttJson as Record<string, unknown>;
  const detail = o.detail;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.message === "string") return d.message;
  }
  if (typeof o.message === "string") return o.message;
  if ("error" in o && typeof o.error === "string") return o.error;
  return fallback;
}

/** Skip STT lines that are silence / SFX / scene captions so we do not spam the API. */
export function isLikelyNonSpeechTranscript(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 2) return true;
  if (/^\([^)]{0,120}(silencio|silence|pausa)[^)]*\)$/i.test(s)) return true;
  if (/^\([^)]*segundos[^)]*\)$/i.test(s)) return true;
  if (
    /\[som|sound of |ruido de |\(órtgen:|water|água corrente|applause|coughing|menelan|kicau|burung|jangkauan|suara\s|musica|música|\bmusic\b|音楽|笑い|咳|ノイズ/i.test(
      s,
    )
  )
    return true;
  if (/短い|黙る|間/i.test(s)) return true;

  const paren = /^\(([^)]+)\)$/.exec(s);
  if (paren) {
    const inner = paren[1].trim();
    const wordish = inner.split(/\s+/).filter((w) => /[a-zA-ZÀ-ÿ\u00c0-\u024f]{3,}/.test(w));
    if (wordish.length >= 2) return false;
    if (inner.length <= 48 && wordish.length <= 1) return true;
  }

  if (s.length >= 160) {
    const t = s.toLowerCase();
    if (
      /thank(s)?\s+you\s+for\s+watching|thanks\s+for\s+watching|like\s+and\s+subscribe|hit\s+the\s+bell|don'?t\s+forget\s+to\s+subscribe|see\s+you\s+next\s+time|good\s+night.{0,60}(bye|guys)/i.test(
        t,
      )
    )
      return true;
  }
  return false;
}
