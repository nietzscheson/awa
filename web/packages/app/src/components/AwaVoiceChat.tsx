"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  endingCallShortStatus,
  extractAllTranscriptLines,
  extractTranscript,
  fmtRawTime,
  formatSessionWhen,
  interviewEndedShellStatus,
  isLikelyNonSpeechTranscript,
  looksLikeInterviewFinishedReply,
  replayFailedStatus,
  replayingAwaVoiceStatus,
  replayVoiceButtonLabel,
  sessionAlreadyFinishedStatus,
  shortSessionLabel,
  sttErrorMessage,
  truncateDetail,
} from "@/lib/voiceChatUtils";

const AWA = "/api/awa";
const STT_MODEL =
  process.env.NEXT_PUBLIC_ELEVENLABS_STT_MODEL || "scribe_v1";
/** Must match ``VOICE_SESSION_OPENING_SIGNAL`` in ``core/src/main.py``. */
const AWA_VOICE_SESSION_OPENING = "__AWA_VOICE_SESSION_OPENING__";
/**
 * Length of each mic segment (ms). We stop/start MediaRecorder each segment so
 * each upload is a full playable WebM/MP4 — timeslice blobs alone are often
 * invalid for ElevenLabs STT ("corrupted" / invalid_audio).
 */
/** Mic segment length; longer = fewer cuts, slightly less accidental noise per clip. */
const RECORD_SEGMENT_MS = 4500;

const VOICE_DEBUG_DEFAULT =
  process.env.NEXT_PUBLIC_AWA_VOICE_DEBUG === "1" ||
  process.env.NEXT_PUBLIC_AWA_VOICE_DEBUG === "true";

const RAW_LOG_MAX = 200;

type ChatRole = "you" | "awa" | "meta";

type Line = { id: string; role: ChatRole; text: string };

type RawLogLine = { id: string; t: number; kind: string; detail: string };

type AdkSessionRow = {
  session_id: string;
  user_id: string;
  last_update_time: number;
};

type StreamTurnResult = {
  reply: string;
  interviewComplete: boolean;
  closeConversation: boolean;
};

type StopLiveOptions = { clearTranscript?: boolean; silent?: boolean };

function readVoiceUserId(): string {
  try {
    const k = "awa_voice_user_id";
    let v = localStorage.getItem(k);
    if (!v) {
      v = crypto.randomUUID();
      localStorage.setItem(k, v);
    }
    return v;
  } catch {
    return crypto.randomUUID();
  }
}

function uid(): string {
  return crypto.randomUUID();
}

async function playMp3Blob(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (e?: unknown) =>
        reject(e instanceof Error ? e : new Error("Audio playback failed"));
      audio.addEventListener("ended", () => resolve(), { once: true });
      audio.addEventListener("error", () => fail(), { once: true });
      const start = () => {
        void audio.play().catch(fail);
      };
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        start();
      } else {
        audio.addEventListener("canplaythrough", start, { once: true });
        audio.load();
      }
    });
  } finally {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}

function pickRecorderMime(): string | undefined {
  if (!MediaRecorder.isTypeSupported) return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c));
}

export function AwaVoiceChat() {
  const [userId] = useState(readVoiceUserId);
  const [sessions, setSessions] = useState<AdkSessionRow[]>([]);
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  const [voiceSessionId, setVoiceSessionId] = useState<string | null>(null);

  const [showRawTrace, setShowRawTrace] = useState(() => {
    try {
      if (VOICE_DEBUG_DEFAULT) return true;
      return localStorage.getItem("awa_voice_raw_trace") === "1";
    } catch {
      return VOICE_DEBUG_DEFAULT;
    }
  });
  const [rawLog, setRawLog] = useState<RawLogLine[]>([]);
  const [replayBusy, setReplayBusy] = useState(false);

  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [live, setLive] = useState(false);

  const liveRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const mrRef = useRef<MediaRecorder | null>(null);
  const segmentChunksRef = useRef<BlobPart[]>([]);
  const segmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sliceQueueRef = useRef<Blob[]>([]);
  const drainRunningRef = useRef(false);
  const sessionRef = useRef<{ sessionId: string; userId: string } | null>(null);
  const beginNewSegmentRef = useRef<() => void>(() => {});
  const streamingBubbleIdRef = useRef<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stopLiveRef = useRef<(opts?: StopLiveOptions) => Promise<void>>(async () => {});
  const appendRawLogRef = useRef<(kind: string, detail: string) => void>(() => {});
  /** True while the raw panel is open or ``NEXT_PUBLIC_AWA_VOICE_DEBUG`` forces trace on. */
  const rawLogCaptureRef = useRef(showRawTrace || VOICE_DEBUG_DEFAULT);
  const streamModelCharsRef = useRef(0);
  /** Last Assistant text from SSE ``model`` frames (covers ``done.response`` omissions after tool calls). */
  const lastStreamedModelTextRef = useRef("");
  /** Matches ``CreateSessionRequest.language`` for this voice client (STT/TTS sign-off). */
  const sessionLanguageRef = useRef("es-MX");

  useEffect(() => {
    rawLogCaptureRef.current = showRawTrace || VOICE_DEBUG_DEFAULT;
  }, [showRawTrace]);

  const appendRawLog = useCallback((kind: string, detail: string) => {
    if (!rawLogCaptureRef.current) return;
    const line: RawLogLine = {
      id: uid(),
      t: Date.now(),
      kind,
      detail: truncateDetail(detail),
    };
    setRawLog((prev) => [line, ...prev].slice(0, RAW_LOG_MAX));
  }, []);

  appendRawLogRef.current = appendRawLog;

  const setRawTraceEnabled = useCallback((on: boolean) => {
    setShowRawTrace(on);
    try {
      localStorage.setItem("awa_voice_raw_trace", on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);

  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await fetch(
        `${AWA}/sessions?user_id=${encodeURIComponent(userId)}`,
      );
      if (!r.ok) return;
      const data = (await r.json()) as AdkSessionRow[];
      setSessions(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    }
  }, [userId]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const pushLine = useCallback((role: ChatRole, text: string) => {
    setLines((prev) => [...prev, { id: uid(), role, text }]);
  }, []);

  const streamAwaChat = useCallback(
    async (userMessage: string): Promise<StreamTurnResult> => {
      const pair = sessionRef.current;
      if (!pair) throw new Error("No active session");

      streamingBubbleIdRef.current = null;
      lastStreamedModelTextRef.current = "";
      setStatus("Replying…");
      streamModelCharsRef.current = 0;
      appendRawLogRef.current(
        "awa_sse",
        `POST /chat/stream user_message_chars=${userMessage.length}`,
      );

      const res = await fetch(`${AWA}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: pair.userId,
          session_id: pair.sessionId,
          new_message: { parts: [{ text: userMessage }] },
        }),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || res.statusText);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const dec = new TextDecoder();
      let carry = "";
      let finalText = "";
      let interviewComplete = false;
      let closeConversation = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        carry += dec.decode(value, { stream: true });
        const parts = carry.split("\n\n");
        carry = parts.pop() ?? "";
        for (const frame of parts) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
          if (payload.type === "model" && typeof payload.text === "string") {
            const text = payload.text;
            lastStreamedModelTextRef.current = text;
            streamModelCharsRef.current += text.length;
            let bid: string | null = streamingBubbleIdRef.current;
            if (!bid) {
              bid = uid();
              streamingBubbleIdRef.current = bid;
            }
            const bubbleId = bid;
            setLines((prev) => {
              const exists = prev.some((l) => l.id === bubbleId);
              if (!exists) return [...prev, { id: bubbleId, role: "awa", text }];
              return prev.map((l) => (l.id === bubbleId ? { ...l, text } : l));
            });
          }
          if (payload.type === "done") {
            finalText =
              typeof payload.response === "string" ? payload.response : "";
            interviewComplete = Boolean(payload.interview_is_complete);
            closeConversation = Boolean(payload.close_conversation);
            appendRawLogRef.current(
              "awa_sse_done",
              `model_stream_chars=${streamModelCharsRef.current} interview_is_complete=${interviewComplete} close_conversation=${closeConversation} final_chars=${(typeof payload.response === "string" ? payload.response : "").length}`,
            );
            const sid = streamingBubbleIdRef.current;
            if (sid) {
              setLines((prev) =>
                prev.map((l) => (l.id === sid ? { ...l, text: finalText || l.text } : l)),
              );
            } else if (finalText.trim()) {
              setLines((prev) => [...prev, { id: uid(), role: "awa", text: finalText }]);
            }
            streamingBubbleIdRef.current = null;
          }
          if (payload.type === "error") {
            streamingBubbleIdRef.current = null;
            const msg =
              typeof payload.message === "string" ? payload.message : "Chat error";
            throw new Error(msg);
          }
        }
      }

      streamingBubbleIdRef.current = null;
      const replyText =
        finalText.trim() || lastStreamedModelTextRef.current.trim();
      return {
        reply: replyText,
        interviewComplete,
        closeConversation,
      };
    },
    [],
  );

  const speakTextWithTts = useCallback(async (plainText: string) => {
    if (!plainText.trim()) return;
    const ttsRes = await fetch("/api/elevenlabs/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: plainText }),
    });
    if (!ttsRes.ok) {
      throw new Error(await ttsRes.text());
    }
    await playMp3Blob(await ttsRes.blob());
    appendRawLog(
      "tts_elevenlabs",
      `Played TTS audio (${plainText.length} chars). If STT picks this up from speakers, it appears as stt_* lines below.`,
    );
  }, [appendRawLog]);

  const replayAwaVoice = useCallback(
    async (plain: string) => {
      const text = plain.trim();
      if (!text || liveRef.current || starting) return;
      setReplayBusy(true);
      setStatus(replayingAwaVoiceStatus(sessionLanguageRef.current));
      try {
        await speakTextWithTts(text);
      } catch (e) {
        setStatus(
          e instanceof Error ? e.message : replayFailedStatus(sessionLanguageRef.current),
        );
        return;
      } finally {
        setReplayBusy(false);
      }
      setStatus("");
    },
    [speakTextWithTts, starting],
  );

  const clearSegmentTimer = () => {
    if (segmentTimerRef.current != null) {
      clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
  };

  const transcribeAndChat = useCallback(
    async (audioBlob: Blob) => {
      const pair = sessionRef.current;
      if (!pair) return;
      if (!liveRef.current) return;

      if (audioBlob.size < 400) {
        appendRawLogRef.current(
          "stt_skipped",
          `Mic slice not sent to ElevenLabs STT: blob ${audioBlob.size} B (< 400). Often silence or tail noise.`,
        );
        return;
      }

      setStatus("Transcribing…");
      const ext =
        audioBlob.type.includes("mp4") || audioBlob.type.includes("aac")
          ? "m4a"
          : "webm";
      const fd = new FormData();
      fd.append("model_id", STT_MODEL);
      // Fewer "(music)", "(laughter)"-style tags in the transcript (ElevenLabs STT).
      fd.append("tag_audio_events", "false");
      fd.append("file", audioBlob, `speech.${ext}`);

      const sttRes = await fetch("/api/elevenlabs/stt", { method: "POST", body: fd });
      const sttJson: unknown = await sttRes.json();
      const sttKeys =
        sttJson && typeof sttJson === "object"
          ? Object.keys(sttJson as object).join(",")
          : "";
      const allLines = extractAllTranscriptLines(sttJson);
      appendRawLogRef.current(
        "stt_elevenlabs",
        `HTTP ${sttRes.status} keys=[${sttKeys}] transcripts=${JSON.stringify(allLines)}`,
      );
      if (!sttRes.ok) {
        throw new Error(sttErrorMessage(sttJson, "STT failed"));
      }
      const transcript = extractTranscript(sttJson);
      if (!transcript) {
        appendRawLogRef.current(
          "stt_empty",
          "ElevenLabs returned no usable text (empty transcript — not added to chat).",
        );
        if (liveRef.current) setStatus("Listening…");
        return;
      }
      if (isLikelyNonSpeechTranscript(transcript)) {
        appendRawLogRef.current(
          "stt_filtered",
          `Filtered as non-speech (not sent to Awa): ${JSON.stringify(transcript)}`,
        );
        if (liveRef.current) setStatus("Listening… (skipped non-speech caption)");
        else setStatus("Skipped non-speech caption");
        return;
      }

      if (!liveRef.current) return;
      appendRawLogRef.current(
        "stt_to_chat",
        `Sent to Awa as user text: ${JSON.stringify(transcript)}`,
      );
      pushLine("you", transcript);
      const out = await streamAwaChat(transcript);
      if (!liveRef.current) return;

      setStatus("Synthesizing speech…");
      await speakTextWithTts(out.reply);
      const interviewDone =
        out.interviewComplete ||
        out.closeConversation ||
        looksLikeInterviewFinishedReply(out.reply);
      if (interviewDone && liveRef.current) {
        setStatus(endingCallShortStatus(sessionLanguageRef.current));
        setResumeSessionId(null);
        await stopLiveRef.current({ clearTranscript: false, silent: true });
        setStatus(interviewEndedShellStatus(sessionLanguageRef.current));
        return;
      }
      if (liveRef.current) setStatus("Listening…");
      else setStatus("");
    },
    [pushLine, speakTextWithTts, streamAwaChat],
  );

  const drainSliceQueue = useCallback(async () => {
    if (drainRunningRef.current) return;
    drainRunningRef.current = true;
    try {
      while (sliceQueueRef.current.length > 0) {
        const blob = sliceQueueRef.current.shift();
        if (!blob) continue;
        try {
          await transcribeAndChat(blob);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Pipeline failed";
          appendRawLogRef.current("pipeline_error", msg);
          setStatus(msg);
        }
      }
    } finally {
      drainRunningRef.current = false;
      // Half-duplex: only open the mic again after this queue (STT → Awa → TTS) is done.
      if (liveRef.current && streamRef.current) {
        beginNewSegmentRef.current();
      }
    }
  }, [transcribeAndChat]);

  const enqueueSlice = useCallback(
    (blob: Blob) => {
      sliceQueueRef.current.push(blob);
      void drainSliceQueue();
    },
    [drainSliceQueue],
  );

  const stopStreamTracks = () => {
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    streamRef.current = null;
  };

  /** Stop this MediaRecorder once → one self-contained Blob (valid for STT). */
  const closeSegmentRecorder = useCallback(
    (mr: MediaRecorder, afterBlob: (blob: Blob) => void) => {
      clearSegmentTimer();
      const finalize = () => {
        const blobType = mr.mimeType || "audio/webm";
        const blob = new Blob(segmentChunksRef.current, { type: blobType });
        segmentChunksRef.current = [];
        if (mrRef.current === mr) mrRef.current = null;
        afterBlob(blob);
      };
      mr.onstop = finalize;
      if (mr.state !== "inactive") mr.stop();
      else finalize();
    },
    [],
  );

  const scheduleSegmentEnd = useCallback(
    (mr: MediaRecorder) => {
      clearSegmentTimer();
      segmentTimerRef.current = setTimeout(() => {
        segmentTimerRef.current = null;
        if (!liveRef.current || mrRef.current !== mr) return;
        closeSegmentRecorder(mr, (blob) => {
          if (!liveRef.current) {
            stopStreamTracks();
            return;
          }
          if (blob.size >= 400) {
            enqueueSlice(blob);
          } else if (streamRef.current) {
            appendRawLogRef.current(
              "stt_skipped",
              `Mic segment closed without STT: ${blob.size} B (<400).`,
            );
            // Quiet slice: go listen again without hitting the API.
            beginNewSegmentRef.current();
          }
        });
      }, RECORD_SEGMENT_MS);
    },
    [closeSegmentRecorder, enqueueSlice],
  );

  beginNewSegmentRef.current = () => {
    const stream = streamRef.current;
    if (!stream || !liveRef.current) return;

    const mime = pickRecorderMime();
    const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    segmentChunksRef.current = [];
    mr.ondataavailable = (ev) => {
      if (ev.data.size > 0) segmentChunksRef.current.push(ev.data);
    };
    mr.onerror = () => setStatus("Recorder error");
    mrRef.current = mr;
    mr.start();
    scheduleSegmentEnd(mr);
  };

  const stopLive = useCallback(
    async (opts?: StopLiveOptions) => {
      const clearTranscript = opts?.clearTranscript !== false;
      const silent = opts?.silent === true;
      liveRef.current = false;
      setLive(false);
      if (!silent) setStatus("Stopping…");
      clearSegmentTimer();
      sliceQueueRef.current = [];
      streamingBubbleIdRef.current = null;

      const mr = mrRef.current;
      mrRef.current = null;

      if (mr && mr.state !== "inactive") {
        await new Promise<void>((resolve) => {
          closeSegmentRecorder(mr, () => {
            stopStreamTracks();
            resolve();
          });
        });
      } else {
        stopStreamTracks();
      }

      while (sliceQueueRef.current.length > 0 || drainRunningRef.current) {
        await drainSliceQueue();
        await new Promise((r) => setTimeout(r, 80));
      }

      sessionRef.current = null;
      setVoiceSessionId(null);
      if (clearTranscript) {
        setLines([]);
        setRawLog([]);
      }
      void refreshSessions();
      if (!silent && clearTranscript) setStatus("");
    },
    [closeSegmentRecorder, drainSliceQueue, refreshSessions],
  );

  stopLiveRef.current = stopLive;

  const startLive = useCallback(async () => {
    setStarting(true);
    setLines([]);
    setRawLog([]);
    const resumeId = resumeSessionId;
    const sid = resumeId ?? uid();

    try {
      sessionLanguageRef.current = "es-MX";
      if (resumeId) {
        setStatus("Connecting to session…");
        sessionRef.current = { sessionId: resumeId, userId };
        setVoiceSessionId(resumeId);
      } else {
        setStatus("Creating session…");
        const res = await fetch(`${AWA}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sid,
            user_id: userId,
            language: sessionLanguageRef.current,
            metadata: { source: "web-voice-chat" },
          }),
        });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || res.statusText);
        }
        sessionRef.current = { sessionId: sid, userId };
        setVoiceSessionId(sid);
        void refreshSessions();
      }

      setStatus("Introducing the call…");
      const intro = await streamAwaChat(AWA_VOICE_SESSION_OPENING);
      setStatus("Synthesizing speech…");
      await speakTextWithTts(intro.reply);
      if (intro.interviewComplete) {
        setStatus(endingCallShortStatus(sessionLanguageRef.current));
        setResumeSessionId(null);
        await stopLiveRef.current({ clearTranscript: false, silent: true });
        setStatus(sessionAlreadyFinishedStatus(sessionLanguageRef.current));
        return;
      }

      setStatus("Starting microphone…");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      liveRef.current = true;
      setLive(true);
      beginNewSegmentRef.current();
      setStatus("Listening…");
    } catch (e) {
      liveRef.current = false;
      sessionRef.current = null;
      setVoiceSessionId(null);
      stopStreamTracks();
      setStatus(e instanceof Error ? e.message : "Could not start");
    } finally {
      setStarting(false);
    }
  }, [resumeSessionId, speakTextWithTts, streamAwaChat, userId, refreshSessions]);

  const toggleConversation = useCallback(() => {
    if (starting) return;
    if (live || liveRef.current) {
      void stopLive();
      return;
    }
    void startLive();
  }, [live, startLive, starting, stopLive]);

  const showVoiceMeter =
    live ||
    starting ||
    /introduc|synthesiz|reply|transcrib|colgando|ending the call|repitiendo|replaying|replying/i.test(
      status,
    );

  return (
    <div className="voice-shell">
      <aside className="session-sidebar" aria-label="Your sessions">
        <div className="session-sidebar__head">
          <span className="session-sidebar__label">Sessions</span>
          <button
            type="button"
            className="session-sidebar__new"
            disabled={live || starting}
            onClick={() => setResumeSessionId(null)}
          >
            New
          </button>
        </div>
        <p className="session-sidebar__hint">
          {resumeSessionId
            ? "Resume selected — Start uses that ADK session."
            : "Start creates a new session."}
        </p>
        <ul className="session-sidebar__list">
          {sessions.map((s) => {
            const active = live && voiceSessionId === s.session_id;
            const picked = resumeSessionId === s.session_id;
            return (
              <li key={s.session_id}>
                <button
                  type="button"
                  className={`session-sidebar__item${picked ? " session-sidebar__item--picked" : ""}${active ? " session-sidebar__item--active" : ""}`}
                  disabled={live || starting}
                  onClick={() => setResumeSessionId(s.session_id)}
                >
                  <span className="session-sidebar__id">{shortSessionLabel(s.session_id)}</span>
                  <span className="session-sidebar__when">
                    {formatSessionWhen(s.last_update_time)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="voice-chat" aria-label="Voice chat">
        <header className="voice-chat__header">
          <div className="status-line">{status}</div>
          <div className="actions actions--with-meter">
            <button
              type="button"
              className={`primary${live ? " active" : ""}`}
              disabled={starting}
              onClick={() => toggleConversation()}
            >
              {starting ? "Starting…" : live ? "Stop" : "Start"}
            </button>
            {showVoiceMeter ? (
              <div
                className={`voice-meter${live ? " voice-meter--live" : ""}`}
                aria-hidden
                title={live ? "Listening" : "Working"}
              >
                {Array.from({ length: 9 }, (_, i) => (
                  <span
                    key={i}
                    className="voice-meter__bar"
                    style={{ animationDelay: `${i * 0.08}s` }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </header>

        <div ref={messagesRef} className="messages">
          {lines.map((m) =>
            m.role === "awa" ? (
              <div key={m.id} className="bubble-awa-row">
                <div className={`bubble ${m.role}`}>
                  Awa: {m.text}
                </div>
                <button
                  type="button"
                  className="bubble-awa-row__replay"
                  disabled={live || starting || replayBusy}
                  aria-label={replayVoiceButtonLabel(sessionLanguageRef.current)}
                  onClick={() => void replayAwaVoice(m.text)}
                >
                  {replayVoiceButtonLabel(sessionLanguageRef.current)}
                </button>
              </div>
            ) : (
              <div key={m.id} className={`bubble ${m.role}`}>
                {m.role === "you" ? "You: " : ""}
                {m.text}
              </div>
            ),
          )}
        </div>

        <details
          className="raw-trace"
          open={showRawTrace}
          onToggle={(e) => {
            const el = e.target as HTMLDetailsElement;
            setRawTraceEnabled(el.open);
          }}
        >
          <summary>Raw trace</summary>
          <div className="raw-trace__head">
            <button
              type="button"
              className="bubble-awa-row__replay"
              onClick={() => setRawLog([])}
            >
              Clear log
            </button>
          </div>
          <pre className="raw-trace__log">
            {rawLog.length === 0 ? (
              <span className="raw-trace__line">No entries yet.</span>
            ) : (
              rawLog.map((row) => (
                <p key={row.id} className="raw-trace__line">
                  <time dateTime={new Date(row.t).toISOString()}>{fmtRawTime(row.t)}</time>
                  <strong>{row.kind}</strong> {row.detail}
                </p>
              ))
            )}
          </pre>
        </details>
      </section>
    </div>
  );
}
