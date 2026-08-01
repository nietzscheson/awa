/**
 * The ADK live socket's event shape, plus a console trace for it.
 *
 * Two jobs, one module, because they are the same knowledge: what the server
 * sends, and how to read it while debugging.
 *
 * The type mirrors the `Event` model that `run_agent_live` dumps with camelCase
 * aliases (see core/.venv/.../google/adk/cli/api_server.py). Only the fields the
 * client actually acts on are declared.
 *
 * The trace answers "where did the time go?": the live API stays completely
 * silent while the model thinks and while it runs a tool, so a slow answer is
 * indistinguishable from a broken one unless you can see the gaps. Every line is
 * stamped relative to the moment the candidate stopped talking, which is the
 * latency the person in front of the avatar is actually feeling.
 *
 * On by default in `next dev`. Force it either way with `NEXT_PUBLIC_LIVE_DEBUG`
 * (`1`/`true` to enable, anything else to silence it) — useful for a deployed
 * build you need to diagnose.
 */

export interface LivePart {
  text?: string;
  /** True on a thought summary. Model reasoning, never the spoken answer. */
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType?: string; data?: string };
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
}

export interface LiveEvent {
  author?: string;
  partial?: boolean;
  turnComplete?: boolean;
  interrupted?: boolean;
  errorCode?: string;
  errorMessage?: string;
  content?: {
    role?: string;
    parts?: LivePart[];
  };
  inputTranscription?: { text?: string; finished?: boolean };
  outputTranscription?: { text?: string; finished?: boolean };
}

/**
 * Model reasoning, not speech.
 *
 * The server asks for `include_thoughts=False`, so in practice this filters
 * nothing — it is here so a flipped flag on the agent side can never put English
 * chain-of-thought in front of the candidate.
 */
export function isThoughtPart(part: LivePart): boolean {
  return part.thought === true;
}

const FLAG = (process.env.NEXT_PUBLIC_LIVE_DEBUG ?? "").trim().toLowerCase();

/** Default on in development; jest (`NODE_ENV=test`) stays quiet. */
export const LIVE_DEBUG =
  FLAG === "" ? process.env.NODE_ENV === "development" : ["1", "true", "on", "yes"].includes(FLAG);

export interface LiveTrace {
  /** New interview: drop the previous session's counters. */
  reset(): void;
  /** Something happened outside the socket (session created, avatar up, …). */
  note(label: string, detail?: string): void;
  /**
   * The candidate's turn just closed — start the clock every following line is
   * measured against. `how` distinguishes a spoken turn from a typed one.
   */
  userTurnEnd(how: string): void;
  /** One event off the socket. */
  event(ev: LiveEvent): void;
  /** The socket delivered something that isn't JSON. */
  malformed(raw: string): void;
}

const BADGE = "background:#1d4ed8;color:#fff;border-radius:3px;padding:0 5px;font-weight:600";
const DIM = "color:#94a3b8";
const RESET = "color:inherit;font-weight:normal";

function bytesOfBase64(data: string): number {
  // Close enough for a byte counter, and it never touches the payload: 4 chars
  // of base64 carry 3 bytes.
  return Math.floor((data.length * 3) / 4);
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** No-op trace, so callers never branch on whether debugging is on. */
const SILENT: LiveTrace = {
  reset() {},
  note() {},
  userTurnEnd() {},
  event() {},
  malformed() {},
};

export function createLiveTrace(enabled: boolean = LIVE_DEBUG): LiveTrace {
  if (!enabled) return SILENT;

  /** When the candidate's turn ended; 0 before the first turn. */
  let turnStart = 0;
  let firstAudioMs = -1;
  let firstWordMs = -1;
  let audioChunks = 0;
  let audioBytes = 0;
  let thoughtChars = 0;

  const elapsed = () => (turnStart === 0 ? -1 : Date.now() - turnStart);
  const stamp = () => {
    const ms = elapsed();
    return ms < 0 ? "" : `+${ms}ms`;
  };

  const log = (label: string, detail: string, raw?: unknown) => {
    const args: unknown[] = [`%clive%c ${stamp()} %c${label}%c ${detail}`, BADGE, DIM, RESET, RESET];
    if (raw !== undefined) args.push(raw);
    console.log(...args);
  };

  const startTurn = () => {
    turnStart = Date.now();
    firstAudioMs = -1;
    firstWordMs = -1;
    audioChunks = 0;
    audioBytes = 0;
    thoughtChars = 0;
  };

  return {
    reset() {
      turnStart = 0;
      console.log(
        `%clive%c trace on — silence it with NEXT_PUBLIC_LIVE_DEBUG=0`,
        BADGE,
        DIM,
      );
    },

    note(label, detail) {
      log(`· ${label}`, detail ?? "");
    },

    userTurnEnd(how) {
      startTurn();
      log(`▲ candidate turn closed (${how})`, "waiting for the agent…");
    },

    event(ev) {
      for (const part of ev.content?.parts ?? []) {
        if (part.inlineData?.data) {
          audioChunks += 1;
          audioBytes += bytesOfBase64(part.inlineData.data);
          if (firstAudioMs < 0) {
            firstAudioMs = elapsed();
            log("♪ first agent audio", firstAudioMs < 0 ? "" : `latency ${firstAudioMs}ms`);
          }
        }
        if (isThoughtPart(part) && part.text) {
          thoughtChars += part.text.length;
          log("🧠 thought (not shown)", JSON.stringify(part.text.slice(0, 160)));
        } else if (part.text) {
          log("💬 text", JSON.stringify(part.text));
        }
        if (part.functionCall) {
          log(
            `🔧 calls ${part.functionCall.name}`,
            JSON.stringify(part.functionCall.args ?? {}).slice(0, 200),
          );
        }
        if (part.functionResponse) {
          log(
            `↩︎ ${part.functionResponse.name} returned`,
            JSON.stringify(part.functionResponse.response ?? {}).slice(0, 200),
          );
        }
      }

      if (ev.inputTranscription?.text) {
        log(
          ev.inputTranscription.finished ? "🎙 candidate (final)" : "🎙 candidate",
          JSON.stringify(ev.inputTranscription.text),
        );
      }
      if (ev.outputTranscription?.text) {
        if (firstWordMs < 0) firstWordMs = elapsed();
        log(
          ev.outputTranscription.finished ? "📝 agent (final)" : "📝 agent",
          JSON.stringify(ev.outputTranscription.text),
        );
      }
      if (ev.errorCode || ev.errorMessage) {
        console.error(`%clive%c ${stamp()} ✖ agent error`, BADGE, DIM, ev);
      }
      if (ev.interrupted) {
        log("✂︎ interrupted", "the candidate spoke over the avatar");
      }
      if (ev.turnComplete) {
        const parts = [
          firstWordMs >= 0 ? `first word ${firstWordMs}ms` : null,
          firstAudioMs >= 0 ? `first audio ${firstAudioMs}ms` : null,
          `turn complete ${elapsed()}ms`,
          `${audioChunks} chunks / ${kb(audioBytes)}`,
          thoughtChars > 0 ? `${thoughtChars} chars of thought` : null,
        ].filter(Boolean);
        log("■ turn end", parts.join(" · "));
        // The agent's answer is the reference point for the next turn's wait.
        turnStart = 0;
      }
    },

    malformed(raw) {
      console.warn(`%clive%c non-JSON message`, BADGE, DIM, raw.slice(0, 200));
    },
  };
}
