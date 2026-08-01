"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Line } from "@/components/Conversation";
import type { AvatarState, Intent, UserState } from "@/components/IntentPanel";
import { InterviewRoom } from "@/components/InterviewRoom";
import { type Applicant, SetupScreen } from "@/components/SetupScreen";
import { useAvatarLipSync } from "@/hooks/useAvatarLipSync";
import { useMediaDevices } from "@/hooks/useMediaDevices";
import { ADK_APP, ADK_BASE, isAbsolute, liveWsUrl, sessionUrl } from "@/lib/adkUrls";
import {
  createLiveTrace,
  isThoughtPart,
  type LiveEvent,
  type LiveTrace,
} from "@/lib/liveEvents";
import {
  isInterviewConfirmed,
  reviewedAnswers,
  type ReviewedAnswer,
} from "@/lib/interviewReview";
import {
  DEFAULT_INTERVIEW_LANGUAGE,
  type InterviewLanguage,
} from "@/lib/languages";
import { base64ToPcm16, floatToPcm16, INPUT_SAMPLE_RATE, pcm16ToBase64 } from "@/lib/livePcm";
import { PcmPlayer } from "@/lib/pcmPlayer";

/**
 * The interview client for the ADK live (bidirectional) WebSocket agent.
 *
 * Two screens and nothing else: `SetupScreen` collects the candidate's details
 * and creates the session, `InterviewRoom` runs it. Everything that used to be a
 * form field — base URL, app name, user id, session id, modality — is now a
 * constant or derived, because none of it is a decision the person being
 * interviewed should be making. `ADK_BASE` remains overridable at build time
 * (see lib/adkUrls.ts) for direct, non-proxied mode.
 *
 * Protocol (see core/.venv/.../google/adk/cli/api_server.py `run_agent_live`):
 *   1. POST /apps/{app}/users/{user}/sessions/{session}     create the session
 *        the body IS the session state dict → applicant metadata goes here
 *   2. WS   /run_live?app_name=&user_id=&session_id=&modalities=AUDIO
 *        send LiveRequest JSON:
 *          - text turn : {"content":{"role":"user","parts":[{"text":"..."}]}}
 *          - mic frame : {"blob":{"mimeType":"audio/pcm;rate=16000","data":"<b64>"}}
 *        recv Event JSON (camelCase aliases):
 *          - content.parts[].inlineData  -> 24kHz PCM16 audio chunk (base64)
 *          - outputTranscription.text    -> what the agent is saying (deltas)
 *          - inputTranscription.text     -> transcript of mic audio
 *          - partial / turnComplete / interrupted flags
 *          - functionCall / functionResponse parts (tool use)
 *
 * The event shape itself, and a console trace of the whole stream (latency per
 * turn, tool calls, thought summaries), live in lib/liveEvents.ts.
 *
 * The configured live model (gemini-*-live) only supports AUDIO output — TEXT
 * modality is rejected — so we read text from `outputTranscription` and play the
 * PCM audio.
 *
 * The agent's audio has two possible destinations and exactly one is used at a
 * time: the LiveAvatar talking head (`useAvatarLipSync`, which lip-syncs it) or
 * a local `PcmPlayer` when there is no avatar. `feed()` returning `false` is what
 * selects the fallback, so a missing API key or a dropped avatar session degrades
 * to voice-only instead of breaking the interview.
 *
 * A note on `ws.onmessage`: it is assigned once, so the handler it captures never
 * sees later renders' state. Every flag the event stream needs to *read* lives in
 * a ref for that reason; React state here is strictly for rendering.
 */

/** The live model rejects TEXT output, so the modality is not a choice. */
const MODALITY = "AUDIO";

/**
 * The turn that makes the interviewer speak first.
 *
 * It goes in as a user turn because that is the only input a live session takes,
 * so the bracket convention is what keeps it from being mistaken for the
 * candidate's words: the agent's instruction says cues in brackets come from the
 * app and are never read aloud (see `build_interviewer_instruction` in
 * core/src/container.py). It is also never added to the transcript — nobody said
 * it, and the greeting it triggers is what the candidate actually sees.
 */
const OPENING_CUE =
  "[interview_start] The candidate has just joined the call and can see and hear you. " +
  "Greet them, introduce yourself, and begin the interview.";

/** Quiet for this long and the goodbye is over. */
const FAREWELL_TAIL_MS = 900;

/** Never close sooner than this: the avatar's audio starts with a lag. */
const FAREWELL_FLOOR_MS = 2500;

/** And never hang on longer than this, however stuck the pipeline is. */
const FAREWELL_CEILING_MS = 25_000;

type Phase = "setup" | "room";

function uid(): string {
  return crypto.randomUUID();
}

/** Stable per browser, so the agent can recognise a returning candidate. */
function readUserId(): string {
  try {
    const k = "adk_live_user_id";
    let v = localStorage.getItem(k);
    if (!v) {
      v = `u_${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem(k, v);
    }
    return v;
  } catch {
    return `u_${crypto.randomUUID().slice(0, 8)}`;
  }
}

export function StreamingAgentClient() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [applicant, setApplicant] = useState<Applicant>({
    firstName: "Cristian",
    lastName: "Angulo",
    address: "Monte Leon de Piedad 237. Ciudad de México",
  });
  const [language, setLanguage] = useState<InterviewLanguage>(DEFAULT_INTERVIEW_LANGUAGE);

  const [starting, setStarting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState("Interview in progress");

  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const avatarSpeakingRef = useRef(false);

  const [lines, setLines] = useState<Line[]>([]);
  const [intents, setIntents] = useState<Intent[]>([]);
  const [draft, setDraft] = useState("");

  // Turn state: mirrored into refs because `ws.onmessage` reads it.
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [agentTalking, setAgentTalking] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const userSpeakingRef = useRef(false);
  const agentTalkingRef = useRef(false);
  const awaitingReplyRef = useRef(false);

  const avatar = useAvatarLipSync();
  const media = useMediaDevices();

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  /** Console trace of the live stream; a no-op object when debugging is off. */
  const traceRef = useRef<LiveTrace | null>(null);
  const trace = (traceRef.current ??= createLiveTrace());
  const agentBubbleRef = useRef<string | null>(null);
  const youBubbleRef = useRef<string | null>(null);
  const micMutedRef = useRef(false);

  // Mic encode graph (the track itself lives in `useMediaDevices`).
  const micCtxRef = useRef<AudioContext | null>(null);
  const micNodeRef = useRef<ScriptProcessorNode | null>(null);

  const pushIntent = useCallback(
    (actor: Intent["actor"], label: string, detail?: string) => {
      setIntents((prev) => [...prev, { id: uid(), t: Date.now(), actor, label, detail }]);
    },
    [],
  );

  const setUserSpeakingFlag = useCallback((value: boolean) => {
    if (userSpeakingRef.current === value) return;
    userSpeakingRef.current = value;
    setUserSpeaking(value);
  }, []);

  const setAgentTalkingFlag = useCallback((value: boolean) => {
    if (agentTalkingRef.current === value) return;
    agentTalkingRef.current = value;
    setAgentTalking(value);
  }, []);

  const setAwaitingReplyFlag = useCallback((value: boolean) => {
    if (awaitingReplyRef.current === value) return;
    awaitingReplyRef.current = value;
    setAwaitingReply(value);
  }, []);

  const pushLine = useCallback((role: Line["role"], text: string) => {
    setLines((prev) => [...prev, { id: uid(), role, text }]);
  }, []);

  /** Append/replace text on a per-role streaming bubble (agent or you). */
  const writeBubble = useCallback((role: Line["role"], text: string, replace: boolean) => {
    const ref = role === "agent" ? agentBubbleRef : youBubbleRef;
    const existing = ref.current;
    if (!existing) {
      const id = uid();
      ref.current = id;
      setLines((prev) => [...prev, { id, role, text }]);
      return;
    }
    setLines((prev) =>
      prev.map((l) => (l.id === existing ? { ...l, text: replace ? text : l.text + text } : l)),
    );
  }, []);

  /**
   * Tear down the microphone's encode graph. Declared up here because closing the
   * interview needs it; the tracks belong to `useMediaDevices`, so stopping them
   * here would kill the self-view too.
   */
  const stopMic = useCallback(() => {
    micNodeRef.current?.disconnect();
    micNodeRef.current = null;
    if (micCtxRef.current) {
      void micCtxRef.current.close().catch(() => {});
      micCtxRef.current = null;
    }
  }, []);

  /**
   * Put the answer record in the chat, unless it is already the last thing there.
   *
   * `review_answers`, `correct_answer` and `confirm_interview` all return the full
   * record, so a confirmation round would otherwise print the same list three
   * times. A record that *changed* is worth showing again — that is how a
   * correction becomes visible.
   */
  const showAnswers = useCallback((answers: ReviewedAnswer[]) => {
    setLines((prev) => {
      const last = prev.at(-1);
      if (last?.answers && JSON.stringify(last.answers) === JSON.stringify(answers)) {
        return prev;
      }
      return [...prev, { id: uid(), role: "agent", text: "", answers }];
    });
    // The record is its own line, so whatever bubble was growing is finished.
    agentBubbleRef.current = null;
  }, []);

  /**
   * The candidate confirmed their answers: the interview is over.
   *
   * The microphone goes now — nothing said after this is wanted, and leaving it
   * open would keep the recording light on while the agent says goodbye. The call
   * itself waits: see the effect below, which closes it once the goodbye has
   * actually been heard.
   */
  const beginClosing = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    stopMic();
    media.setMuted(true);
    micMutedRef.current = true;
    setStatus("Answers confirmed — closing the interview");
    pushIntent("system", "answers confirmed", "closing after the goodbye");
    trace.note("interview confirmed", "mic closed; waiting for the goodbye");
  }, [media, pushIntent, stopMic, trace]);

  /**
   * Stop the agent's voice mid-sentence: local playback, the avatar's queued
   * audio, and the bubble it was still growing.
   *
   * Called from two places — the candidate starting to talk, and the server
   * saying the turn was interrupted — and safe to call twice for the same
   * barge-in, which is why the intent is only recorded while the agent was
   * actually talking.
   */
  const cutAgentOff = useCallback(
    (reason: string) => {
      const wasTalking = agentTalkingRef.current;
      playerRef.current?.stop();
      avatar.interrupt();
      agentBubbleRef.current = null;
      setAgentTalkingFlag(false);
      setAwaitingReplyFlag(false);
      if (wasTalking) pushIntent("system", "interrupted", reason);
    },
    [avatar, pushIntent, setAgentTalkingFlag, setAwaitingReplyFlag],
  );

  const handleEvent = useCallback(
    (raw: string) => {
      let ev: LiveEvent;
      try {
        ev = JSON.parse(raw) as LiveEvent;
      } catch {
        trace.malformed(raw);
        return;
      }
      trace.event(ev);

      for (const p of ev.content?.parts ?? []) {
        if (p.inlineData?.data) {
          // The avatar gets first refusal on the agent's voice; only if it isn't
          // there do we play the audio ourselves.
          if (!avatar.feed(p.inlineData.data)) {
            try {
              const player = playerRef.current;
              if (player) {
                // Re-arm if the context lost its running state mid-stream.
                if (player.state !== "running") void player.unlock();
                player.enqueue(base64ToPcm16(p.inlineData.data));
              }
            } catch {
              /* a dropped chunk is not worth interrupting the interview for */
            }
          }
          if (!agentTalkingRef.current) {
            setAgentTalkingFlag(true);
            setAwaitingReplyFlag(false);
            pushIntent("avatar", "starts answering");
          }
        }
        // TEXT modality (if the model supports it) streams text in parts too.
        // Thought summaries arrive on this same channel and are NOT speech: they
        // are the model reasoning about the candidate, so they belong in the
        // console (see the trace above), never in the transcript.
        if (typeof p.text === "string" && p.text.length > 0 && !isThoughtPart(p)) {
          writeBubble("agent", p.text, !ev.partial);
        }
        if (p.functionCall) {
          // The most literal intent the agent has: the tool it chose to run.
          pushIntent(
            "avatar",
            `calls ${p.functionCall.name}`,
            JSON.stringify(p.functionCall.args ?? {}).slice(0, 120),
          );
        }
        if (p.functionResponse) {
          pushIntent(
            "avatar",
            `${p.functionResponse.name} returned`,
            JSON.stringify(p.functionResponse.response ?? {}).slice(0, 120),
          );

          // The closing tools carry the answer record. Put it in the chat: the
          // candidate is being asked to confirm a list of facts, and a spoken
          // list cannot be checked.
          const answers = reviewedAnswers(p.functionResponse.name, p.functionResponse.response);
          if (answers) showAnswers(answers);

          if (isInterviewConfirmed(p.functionResponse.name, p.functionResponse.response)) {
            beginClosing();
          }
        }
      }

      // Agent words come as transcription deltas; the final frame (finished)
      // carries the full aggregated text → replace the bubble with it.
      if (ev.outputTranscription?.text) {
        writeBubble("agent", ev.outputTranscription.text, Boolean(ev.outputTranscription.finished));
        if (!agentTalkingRef.current) {
          setAgentTalkingFlag(true);
          setAwaitingReplyFlag(false);
          pushIntent("avatar", "starts answering");
        }
      }
      if (ev.inputTranscription?.text) {
        writeBubble("you", ev.inputTranscription.text, Boolean(ev.inputTranscription.finished));
        if (!userSpeakingRef.current && !ev.inputTranscription.finished) {
          setUserSpeakingFlag(true);
          pushIntent("user", "starts speaking");
          // Barge-in, locally and immediately. Gemini's VAD will stop generating
          // and send `interrupted` a moment later, but the candidate is already
          // talking over the avatar: waiting for the round trip is what makes an
          // interruption feel like it didn't work.
          if (agentTalkingRef.current) cutAgentOff("candidate spoke over the avatar");
        }
        if (ev.inputTranscription.finished) {
          youBubbleRef.current = null;
          setUserSpeakingFlag(false);
          setAwaitingReplyFlag(true);
          pushIntent("user", "yields the turn");
          trace.userTurnEnd("voice");
        }
      }

      if (ev.errorCode || ev.errorMessage) {
        pushIntent("system", "agent error", ev.errorMessage ?? ev.errorCode);
      }
      if (ev.interrupted) {
        // The server agrees the turn was cut short. Idempotent with the local
        // barge-in above: whichever gets here first, the audio stops once.
        cutAgentOff("signalled by the model");
      }
      if (ev.turnComplete) {
        // No more audio is coming for this turn — close the utterance so the
        // avatar knows the sentence ended.
        avatar.endTurn();
        agentBubbleRef.current = null;
        youBubbleRef.current = null;
        if (agentTalkingRef.current) pushIntent("avatar", "ends the turn");
        setAgentTalkingFlag(false);
        setAwaitingReplyFlag(false);
        setUserSpeakingFlag(false);
      }
    },
    [
      avatar,
      beginClosing,
      cutAgentOff,
      pushIntent,
      showAnswers,
      setAgentTalkingFlag,
      setAwaitingReplyFlag,
      setUserSpeakingFlag,
      trace,
      writeBubble,
    ],
  );

  // ── Microphone ─────────────────────────────────────────────────────────

  /**
   * Start encoding the already-granted microphone track and streaming it.
   *
   * No `getUserMedia` here: permission was taken once on the setup screen for
   * both devices, so this only builds the encode graph over that existing track.
   */
  const startMic = useCallback(() => {
    if (micCtxRef.current) return;
    const stream = media.stream();
    if (!stream || stream.getAudioTracks().length === 0) return;

    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    micCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    micNodeRef.current = node;
    node.onaudioprocess = (e) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || micMutedRef.current) return;
      const pcm = floatToPcm16(e.inputBuffer.getChannelData(0), ctx.sampleRate, INPUT_SAMPLE_RATE);
      ws.send(
        JSON.stringify({
          blob: { mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`, data: pcm16ToBase64(pcm) },
        }),
      );
    };
    source.connect(node);
    // Sink at zero gain so the processor fires without echoing to speakers.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
  }, [media]);

  /** Mute without tearing the graph down, so unmuting is instant. */
  const toggleMic = useCallback(() => {
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    media.setMuted(next);
    pushIntent("user", next ? "mutes the mic" : "unmutes the mic");
  }, [media, pushIntent]);

  /**
   * The candidate's camera is theirs alone — nothing in the pipeline consumes the
   * video track — so this only turns off the self-view (and the camera light).
   */
  const toggleCamera = useCallback(() => {
    const next = !media.cameraOff;
    media.setCameraOff(next);
    pushIntent("user", next ? "turns the camera off" : "turns the camera on");
  }, [media, pushIntent]);

  // ── Session lifecycle ──────────────────────────────────────────────────

  /**
   * Create the ADK session, bring up the avatar, open the socket.
   *
   * Devices are already granted by this point — the setup screen gates on it —
   * so the only failure this has to report is the session POST, which is why
   * that error belongs to the setup screen.
   */
  const start = useCallback(async () => {
    if (starting || !media.granted) return;
    setStarting(true);
    setSetupError(null);
    setLines([]);
    setIntents([]);
    media.setMuted(false);
    micMutedRef.current = false;
    agentBubbleRef.current = null;
    youBubbleRef.current = null;
    setUserSpeakingFlag(false);
    setAgentTalkingFlag(false);
    setAwaitingReplyFlag(false);
    trace.reset();

    // Unlock audio inside the click gesture (before any await) so the browser
    // autoplay policy lets the context run. Cheap insurance even when the avatar
    // ends up carrying the voice.
    const player = new PcmPlayer();
    playerRef.current = player;
    void player.unlock();

    const userId = readUserId();
    const sessionId = `s_${uid().slice(0, 8)}`;

    // Session metadata → ADK session state (the create-with-id body IS the
    // state dict). The interview tools read these keys.
    const metadata: Record<string, string> = {};
    if (applicant.firstName.trim()) metadata.first_name = applicant.firstName.trim();
    if (applicant.lastName.trim()) metadata.last_name = applicant.lastName.trim();
    if (applicant.address.trim()) metadata.ine_address = applicant.address.trim();
    // The interviewer's instruction is resolved per invocation from this key, so
    // the language the candidate picked governs the whole session.
    metadata.language = language;

    try {
      const res = await fetch(sessionUrl(ADK_BASE, ADK_APP, userId, sessionId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      });
      // 400/409 mean "already exists", which is fine — we reuse it.
      if (!res.ok && res.status !== 400 && res.status !== 409) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "session create failed";
      setSetupError(
        isAbsolute(ADK_BASE)
          ? `Could not create the session (${msg}). In direct mode the ADK server needs --allow_origins ${window.location.origin}.`
          : `Could not create the session (${msg}). Is the ADK server running? (proxied via ADK_API_ORIGIN, http://localhost:8000 by default)`,
      );
      setStarting(false);
      return;
    }

    pushIntent("system", "session created", sessionId);
    trace.note("session created", sessionId);

    const avatarUp = await avatar.start();
    if (avatarUp) pushIntent("system", "avatar connected");
    trace.note("avatar", avatarUp ? "connected" : "unavailable (local audio)");

    const query =
      `app_name=${encodeURIComponent(ADK_APP)}` +
      `&user_id=${encodeURIComponent(userId)}` +
      `&session_id=${encodeURIComponent(sessionId)}` +
      `&modalities=${MODALITY}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(liveWsUrl(ADK_BASE, query));
    } catch (cause) {
      setSetupError(
        `Could not open the WebSocket (${cause instanceof Error ? cause.message : "error"}).`,
      );
      setStarting(false);
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setLive(true);
      setStatus("Interview in progress");
      setPhase("room");
      setStarting(false);
      pushIntent("system", "interview started");
      trace.note("socket open", "interview in progress");
      startMic();

      // Hand the agent the first turn. A live model says nothing until it has
      // input, so without this the interview opens with both sides waiting for
      // the other — and the candidate is the one who came to be interviewed.
      ws.send(JSON.stringify({ content: { role: "user", parts: [{ text: OPENING_CUE }] } }));
      setAwaitingReplyFlag(true);
      pushIntent("system", "asks the interviewer to open");
      trace.userTurnEnd("opening cue");
    };
    ws.onmessage = (evt) => handleEvent(String(evt.data));
    ws.onerror = () => {
      setStatus("Connection error with the agent");
    };
    ws.onclose = (evt) => {
      if (wsRef.current === ws) wsRef.current = null;
      stopMic();
      // The interview is over however the socket died, so release the avatar
      // too — outside sandbox it bills by the minute for a face nobody is
      // talking to. Safe to call twice; `close` may have got here first.
      void avatar.stop();
      setLive(false);
      setStarting(false);
      setStatus(
        evt.code === 1000 ? "Session closed" : `Session closed (code ${evt.code})`,
      );
      pushIntent("system", "session closed", evt.reason || undefined);
      trace.note("socket closed", `code ${evt.code}${evt.reason ? ` — ${evt.reason}` : ""}`);
    };
  }, [
    applicant,
    avatar,
    handleEvent,
    language,
    media,
    pushIntent,
    setAgentTalkingFlag,
    setAwaitingReplyFlag,
    setUserSpeakingFlag,
    startMic,
    starting,
    stopMic,
    trace,
  ]);

  /**
   * Tear everything down: socket, avatar, player, devices.
   *
   * `returnToSetup` is false when the interview ended of its own accord. The room
   * stays on screen, closed, because the last thing in it is the record of what
   * the candidate just confirmed — throwing them back to a blank form the instant
   * the goodbye ends would take that away.
   */
  const close = useCallback(
    async (returnToSetup = true) => {
      stopMic();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ close: true }));
        } catch {
          /* the socket is going away regardless */
        }
        ws.close();
      }
      void playerRef.current?.close();
      playerRef.current = null;
      await avatar.stop();
      media.stop();
      setLive(false);
      if (returnToSetup) {
        setPhase("setup");
        setClosing(false);
        closingRef.current = false;
        setStatus("Session closed");
      } else {
        setStatus("Interview complete — session closed");
      }
    },
    [avatar, media, stopMic],
  );

  /**
   * Close the call once the goodbye has actually been heard.
   *
   * `confirm_interview` returns before the farewell is even generated, so closing
   * on it would cut the avatar off mid-sentence. Instead we wait for everything
   * that can still be speaking to fall quiet — the event stream, the avatar's own
   * queue, the local player's scheduled audio — and then a beat longer. The floor
   * covers the gap before the avatar starts moving (its audio is queued, not
   * instant); the ceiling means a stuck pipeline still ends the session.
   */
  useEffect(() => {
    if (!closing) return;

    const startedAt = Date.now();
    let quietSince: number | null = null;

    const id = window.setInterval(() => {
      const speaking =
        agentTalkingRef.current ||
        avatarSpeakingRef.current ||
        (playerRef.current?.remainingSeconds ?? 0) > 0.05;
      const now = Date.now();

      if (speaking) quietSince = null;
      else if (quietSince === null) quietSince = now;

      const settled = quietSince !== null && now - quietSince >= FAREWELL_TAIL_MS;
      const waited = now - startedAt;
      if ((settled && waited >= FAREWELL_FLOOR_MS) || waited >= FAREWELL_CEILING_MS) {
        window.clearInterval(id);
        void close(false);
      }
    }, 200);

    return () => window.clearInterval(id);
  }, [close, closing]);

  // Mirrored for the closing loop above, which reads it from inside an interval.
  useEffect(() => {
    avatarSpeakingRef.current = avatar.speaking;
  }, [avatar.speaking]);

  const sendMessage = useCallback(() => {
    const text = draft.trim();
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ content: { role: "user", parts: [{ text }] } }));
    pushLine("you", text);
    setDraft("");
    setAwaitingReplyFlag(true);
    pushIntent("user", "sends a message");
    trace.userTurnEnd("text");
  }, [draft, pushIntent, pushLine, setAwaitingReplyFlag, trace]);

  useEffect(() => {
    return () => {
      stopMic();
      const ws = wsRef.current;
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
      void playerRef.current?.close();
    };
  }, [stopMic]);

  if (phase === "setup") {
    return (
      <SetupScreen
        applicant={applicant}
        onChange={(patch) => setApplicant((prev) => ({ ...prev, ...patch }))}
        language={language}
        onLanguageChange={setLanguage}
        starting={starting}
        error={setupError}
        onStart={() => void start()}
        permission={media.state}
        permissionError={media.error}
        onRequestPermission={() => void media.request()}
        attachVideo={media.attachVideo}
      />
    );
  }

  const avatarState: AvatarState = !live
    ? "idle"
    : avatar.speaking || agentTalking
      ? "speaking"
      : awaitingReply
        ? "thinking"
        : "listening";
  const userState: UserState = userSpeaking ? "speaking" : "idle";

  return (
    <InterviewRoom
      avatar={{
        attachVideo: avatar.attachVideo,
        connected: avatar.connected,
        connecting: avatar.connecting,
        speaking: avatar.speaking || agentTalking,
        error: avatar.error,
        isSandbox: avatar.isSandbox,
      }}
      camera={{
        attachVideo: media.attachVideo,
        active: media.granted,
        error: media.error,
        off: media.cameraOff,
        onToggle: toggleCamera,
      }}
      live={live}
      status={status}
      micMuted={media.muted}
      onToggleMic={toggleMic}
      avatarState={avatarState}
      userState={userState}
      intents={intents}
      lines={lines}
      draft={draft}
      onDraftChange={setDraft}
      onSend={sendMessage}
      onClose={() => void close()}
    />
  );
}
