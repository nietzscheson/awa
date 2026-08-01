"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { type SpeechSession, streamingSpeechSession } from "@/lib/avatarSpeech";
import { base64ToPcm16 } from "@/lib/livePcm";

/**
 * Gives the ADK agent a face: a LiveAvatar session in LITE mode that lip-syncs
 * the audio Gemini Live already produced.
 *
 * The division of labour is deliberate — the agent keeps the conversation, the
 * avatar only renders it:
 *
 *   mic ──► /adk/run_live ──► Gemini Live ──► PCM16 24 kHz
 *                                                  │
 *                              pushSpeech(chunk) ───┘
 *                                    │
 *                                    ▼
 *                          LiveAvatar (LITE): video + lips + that same audio
 *
 * So the interview tools, the session state (first_name / last_name /
 * ine_address) and the transcript all stay where they were. Nothing about the
 * agent changes; we only tee its audio to a renderer.
 *
 * Two encoding details make this work, and both are easy to get wrong:
 *
 *  1. The wire wants 16-bit LE PCM at 24 kHz as standard base64. Gemini, via
 *     google-genai, emits *URL-safe, unpadded* base64. Handing that over verbatim
 *     would ship `-`/`_` to a decoder expecting `+`/`/`, so every chunk is decoded
 *     here with `base64ToPcm16` (which normalises) and re-encoded per frame by
 *     `lib/avatarSpeech.ts`.
 *
 *  2. Audio is streamed into ONE utterance per turn rather than sent as a
 *     finished block — that is what keeps the voice continuous while still
 *     starting fast. See `lib/avatarSpeech.ts` for why the public `repeatAudio()`
 *     cannot do it: `feed`/`endTurn`/`interrupt` here map onto
 *     `pushSpeech`/`endSpeech`/`interruptSpeech` there.
 */

export interface UseAvatarLipSync {
  /** Callback ref for the `<video>` that shows the avatar. */
  attachVideo: (element: HTMLVideoElement | null) => void;
  connected: boolean;
  connecting: boolean;
  /** Why the avatar isn't there, ready to display. Never fatal to the interview. */
  error: string | null;
  /** Sandbox sessions are free but end after ~1 minute. */
  isSandbox: boolean;
  speaking: boolean;
  /**
   * Bring the avatar up. Resolves `true` when it is live; `false` means the
   * caller should play the agent's audio locally instead.
   */
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
  /**
   * Hand over one base64 PCM chunk from the agent. Returns `true` if the avatar
   * took ownership of it, `false` if the caller must play it itself.
   */
  feed: (base64Pcm24k: string) => boolean;
  /** End of the agent's turn — close the utterance. */
  endTurn: () => void;
  /** Barge-in: drop pending audio and cut the avatar off mid-sentence. */
  interrupt: () => void;
}

export function useAvatarLipSync(): UseAvatarLipSync {
  const elementRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<SpeechSession | null>(null);
  /** Set once `SESSION_STREAM_READY` has fired; attaching before it is a no-op. */
  const streamReadyRef = useRef(false);
  /** Guards against React 18 double-invocation and impatient double clicks. */
  const startingRef = useRef(false);

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSandbox, setIsSandbox] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  /** Hand the remote track to the element, whichever arrived last. */
  const bind = useCallback(() => {
    const element = elementRef.current;
    const session = sessionRef.current;
    if (!element || !session || !streamReadyRef.current) return;
    session.attach(element);
    // Autoplay is safe: we only ever get here off the user's start click, so the
    // gesture requirement is already satisfied.
    void (async () => {
      try {
        await element.play();
      } catch {
        /* a paused element still shows the first frame; not worth surfacing */
      }
    })();
  }, []);

  /**
   * Callback ref for the avatar `<video>`.
   *
   * The session comes up on the setup screen, before the room (and its video
   * element) exists, so the track has to be attachable from either direction:
   * whichever of "stream ready" and "element mounted" happens second triggers it.
   */
  const attachVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      elementRef.current = element;
      if (element) bind();
    },
    [bind],
  );

  const feed = useCallback((base64Pcm24k: string): boolean => {
    const session = sessionRef.current;
    if (!session) return false;

    let pcm: Int16Array;
    try {
      pcm = base64ToPcm16(base64Pcm24k);
    } catch (cause) {
      console.error("[avatar] could not decode agent audio", cause);
      return false;
    }
    if (pcm.length === 0) return true;

    try {
      session.pushSpeech(pcm);
    } catch (cause) {
      // Thrown when the session dropped between arriving audio and sending it.
      // Handing the chunk back keeps the interview audible.
      console.error("[avatar] could not send agent audio", cause);
      return false;
    }
    return true;
  }, []);

  const endTurn = useCallback(() => {
    try {
      sessionRef.current?.endSpeech();
    } catch (cause) {
      console.error("[avatar] could not end the utterance", cause);
    }
  }, []);

  const interrupt = useCallback(() => {
    try {
      sessionRef.current?.interruptSpeech();
    } catch (cause) {
      console.error("[avatar] could not interrupt", cause);
    }
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (startingRef.current || sessionRef.current) return sessionRef.current !== null;
    startingRef.current = true;
    setError(null);
    setConnecting(true);

    try {
      const response = await fetch("/api/liveavatar/token", { method: "POST" });
      const payload = (await response.json().catch(() => null)) as {
        session_token?: string;
        is_sandbox?: boolean;
        error?: string;
      } | null;

      if (!response.ok || !payload?.session_token) {
        throw new Error(payload?.error ?? `Could not create the avatar session (HTTP ${response.status}).`);
      }

      // Imported here, not at module scope: the SDK pulls in `livekit-client`,
      // which touches browser globals on import. A static import would run
      // during prerendering and break `next build`.
      const { AgentEventsEnum, LiveAvatarSession, SessionEvent } = await import(
        "@heygen/liveavatar-web-sdk"
      );

      // `voiceChat: false` is the whole point of LITE here — the microphone
      // belongs to the ADK socket. Letting the SDK publish it too would send
      // the candidate's voice to a second pipeline for no reason.
      const Session = streamingSpeechSession(LiveAvatarSession);
      const session = new Session(payload.session_token, { voiceChat: false });
      sessionRef.current = session;

      setIsSandbox(payload.is_sandbox === true);

      // Tracks only exist once this fires; attaching earlier is a no-op.
      session.on(SessionEvent.SESSION_STREAM_READY, () => {
        streamReadyRef.current = true;
        bind();
      });

      session.on(SessionEvent.SESSION_DISCONNECTED, () => {
        sessionRef.current?.removeAllListeners();
        sessionRef.current = null;
        streamReadyRef.current = false;
        setConnected(false);
        setSpeaking(false);
      });

      session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => setSpeaking(true));
      session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => setSpeaking(false));

      await session.start();
      setConnected(true);
      return true;
    } catch (cause) {
      sessionRef.current?.removeAllListeners();
      sessionRef.current = null;
      setConnected(false);
      setError(
        cause instanceof Error
          ? `Avatar unavailable: ${cause.message} The interview continues with audio.`
          : "Avatar unavailable. The interview continues with audio.",
      );
      return false;
    } finally {
      setConnecting(false);
      startingRef.current = false;
    }
  }, [bind]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    streamReadyRef.current = false;
    setConnected(false);
    setSpeaking(false);
    if (!session) return;
    try {
      await session.stop();
    } catch (cause) {
      console.error("[avatar] stop failed", cause);
    } finally {
      session.removeAllListeners();
    }
  }, []);

  // Never leave a paid session running because the tab navigated away.
  useEffect(
    () => () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      session?.removeAllListeners();
      void session?.stop().catch(() => {
        /* unmount teardown — nothing left to report to */
      });
    },
    [],
  );

  return {
    attachVideo,
    connected,
    connecting,
    error,
    isSandbox,
    speaking,
    start,
    stop,
    feed,
    endTurn,
    interrupt,
  };
}
