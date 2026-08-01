"use client";

interface AvatarStageProps {
  /** Callback ref from `useAvatarLipSync` — attaches the track on mount. */
  attachVideo: (element: HTMLVideoElement | null) => void;
  connected: boolean;
  connecting: boolean;
  speaking: boolean;
  /** True when the interview is running but the avatar could not be brought up. */
  audioOnly: boolean;
}

/**
 * The interviewer: the main video feed, filling the stage behind everything else
 * (the self-view tile, the status pill and the call controls all sit on top).
 *
 * The `<video>` is always mounted, and the ref is a callback so the SDK can
 * attach whenever both the element and the remote track exist — the session
 * comes up before this screen does. Not muted: in LITE mode the avatar plays
 * back the very audio we sent it, so this element is how the candidate hears
 * the agent.
 */
export function AvatarStage({
  attachVideo,
  connected,
  connecting,
  speaking,
  audioOnly,
}: AvatarStageProps) {
  return (
    <div className={`frame frame--stage ${speaking ? "is-speaking" : ""}`}>
      <video
        ref={attachVideo}
        className="frame__video frame__video--avatar"
        autoPlay
        playsInline
        data-testid="avatar-video"
      />

      {!connected ? (
        <p className="frame__empty">
          {connecting
            ? "Connecting to the interviewer…"
            : audioOnly
              ? "The interviewer is continuing with voice only."
              : "Interviewer disconnected."}
        </p>
      ) : null}

      <span className="frame__tag">
        Interviewer
        {speaking ? <em className="frame__pulse" aria-hidden /> : null}
      </span>
    </div>
  );
}
