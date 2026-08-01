"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PermissionState = "idle" | "requesting" | "granted" | "denied";

export interface UseMediaDevices {
  state: PermissionState;
  /** Denial or missing-device message, ready to display. */
  error: string | null;
  granted: boolean;
  muted: boolean;
  /** True when the candidate turned their own camera off. */
  cameraOff: boolean;
  /**
   * Callback ref for whichever `<video>` should show the self-view.
   *
   * A callback ref rather than a `RefObject` on purpose: the preview lives on
   * the setup screen *and* in the room, so the element is unmounted and a new
   * one created halfway through the session's life. Assigning `srcObject` once
   * at capture time would leave the second element black.
   */
  attachVideo: (element: HTMLVideoElement | null) => void;
  /** Ask the browser for camera + microphone. Resolves to the stream, or null. */
  request: () => Promise<MediaStream | null>;
  /** The live capture, for building the microphone graph. */
  stream: () => MediaStream | null;
  setMuted: (muted: boolean) => void;
  /**
   * Turn the self-view off without dropping the track — the interview is audio
   * from the agent's point of view, so this is purely for the candidate.
   */
  setCameraOff: (off: boolean) => void;
  stop: () => void;
}

/**
 * One permission prompt for both devices.
 *
 * Camera and microphone are requested in a single `getUserMedia` call so the
 * browser shows one dialog instead of two at different moments — and so the
 * interview can't start half-permitted. The video track feeds the self-view; the
 * audio track is what gets encoded to 16 kHz PCM for the agent.
 */
export function useMediaDevices(): UseMediaDevices {
  const streamRef = useRef<MediaStream | null>(null);
  const elementRef = useRef<HTMLVideoElement | null>(null);
  const mutedRef = useRef(false);
  const cameraOffRef = useRef(false);

  const [state, setState] = useState<PermissionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [cameraOff, setCameraOffState] = useState(false);

  /** Point the given element at the current capture, if we have both. */
  const bind = useCallback(() => {
    const element = elementRef.current;
    const stream = streamRef.current;
    if (!element || !stream) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    void (async () => {
      try {
        await element.play();
      } catch {
        /* muted autoplay is allowed; a stalled play still shows a frame */
      }
    })();
  }, []);

  const attachVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      elementRef.current = element;
      if (element) bind();
    },
    [bind],
  );

  const request = useCallback(async (): Promise<MediaStream | null> => {
    if (streamRef.current) return streamRef.current;
    setState("requesting");
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      // Honour a mute / camera-off chosen before the stream existed.
      for (const track of stream.getAudioTracks()) track.enabled = !mutedRef.current;
      for (const track of stream.getVideoTracks()) track.enabled = !cameraOffRef.current;
      setState("granted");
      bind();
      return stream;
    } catch (cause) {
      const name = cause instanceof DOMException ? cause.name : "";
      setState("denied");
      setError(
        name === "NotAllowedError"
          ? "Permission denied. Allow the camera and microphone in your browser to continue."
          : name === "NotFoundError"
            ? "No camera or microphone was found."
            : "Could not access the camera and microphone.",
      );
      return null;
    }
  }, [bind]);

  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    setMutedState(next);
    // Disabling the track is what makes the OS recording indicator tell the
    // truth — gating our own sending alone would leave the mic light on.
    for (const track of streamRef.current?.getAudioTracks() ?? []) track.enabled = !next;
  }, []);

  const setCameraOff = useCallback((next: boolean) => {
    cameraOffRef.current = next;
    setCameraOffState(next);
    // Same reasoning as the mic: disable the track so the camera light goes out.
    for (const track of streamRef.current?.getVideoTracks() ?? []) track.enabled = !next;
  }, []);

  const stop = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (elementRef.current) elementRef.current.srcObject = null;
    setState("idle");
    setMutedState(false);
    mutedRef.current = false;
    setCameraOffState(false);
    cameraOffRef.current = false;
  }, []);

  // Release the devices (and their indicator lights) on unmount.
  useEffect(() => stop, [stop]);

  return {
    state,
    error,
    granted: state === "granted",
    muted,
    cameraOff,
    attachVideo,
    request,
    stream: () => streamRef.current,
    setMuted,
    setCameraOff,
    stop,
  };
}
