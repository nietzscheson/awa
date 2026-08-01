"use client";

interface CameraStageProps {
  /** Callback ref from `useMediaDevices` — binds the capture on mount. */
  attachVideo: (element: HTMLVideoElement | null) => void;
  active: boolean;
  error: string | null;
  speaking: boolean;
  muted: boolean;
  /** The candidate turned their own camera off. */
  cameraOff?: boolean;
  /** `pip` floats over the stage in the room; `self` is the setup preview. */
  variant?: "pip" | "self";
}

/**
 * The candidate, as a picture-in-picture tile over the interviewer's stage.
 *
 * `muted` is mandatory — playing our own capture back would loop it into the
 * speakers. It's also what lets the browser autoplay the preview without a
 * gesture. Mirrored, because that's what people expect to see of themselves.
 *
 * The ref is a callback for the same reason as the avatar's: this element is
 * created twice, once for the setup preview and again in the room, and a
 * `srcObject` assigned at capture time would only ever reach the first one.
 */
export function CameraStage({
  attachVideo,
  active,
  error,
  speaking,
  muted,
  cameraOff = false,
  variant = "pip",
}: CameraStageProps) {
  return (
    <div className={`frame frame--${variant} ${speaking ? "is-speaking" : ""}`}>
      <video
        ref={attachVideo}
        className="frame__video frame__video--mirror"
        autoPlay
        playsInline
        muted
        data-testid="camera-video"
      />

      {!active || cameraOff ? (
        <p className="frame__empty">{!active ? (error ?? "Camera off.") : "Camera off."}</p>
      ) : null}

      {variant === "pip" ? (
        <span className="frame__tag">
          You
          {muted ? <em className="frame__muted" aria-hidden /> : null}
        </span>
      ) : null}
    </div>
  );
}
