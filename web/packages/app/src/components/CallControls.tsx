"use client";

interface CallControlsProps {
  micMuted: boolean;
  onToggleMic: () => void;
  cameraOff: boolean;
  onToggleCamera: () => void;
  onClose: () => void;
}

/**
 * The call controls, floating over the bottom of the stage.
 *
 * Every button here does something to a real device or to the session — mic
 * track, camera track, hang up. There is deliberately no decorative control
 * (record, share screen, …): a button that looks live and isn't is worse than an
 * absent one, and this bar sits over the interviewer's face where it gets read.
 *
 * Icon-only buttons carry their meaning in `aria-label`, and the label states
 * the action rather than the state ("Mute" / "Unmute microphone"), because
 * that is what a screen reader user is choosing to do. `aria-pressed` carries the
 * state itself.
 */
export function CallControls({
  micMuted,
  onToggleMic,
  cameraOff,
  onToggleCamera,
  onClose,
}: CallControlsProps) {
  return (
    <div className="controls" role="group" aria-label="Call controls">
      <button
        type="button"
        className={`ctrl${micMuted ? " is-off" : ""}`}
        onClick={onToggleMic}
        aria-pressed={micMuted}
        aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
        title={micMuted ? "Unmute microphone" : "Mute microphone"}
      >
        {micMuted ? <MicOffIcon /> : <MicIcon />}
      </button>

      <button
        type="button"
        className={`ctrl${cameraOff ? " is-off" : ""}`}
        onClick={onToggleCamera}
        aria-pressed={cameraOff}
        aria-label={cameraOff ? "Turn camera on" : "Turn camera off"}
        title={cameraOff ? "Turn camera on" : "Turn camera off"}
      >
        {cameraOff ? <CamOffIcon /> : <CamIcon />}
      </button>

      <button
        type="button"
        className="ctrl ctrl--leave"
        onClick={onClose}
        aria-label="Leave the interview"
        title="Leave the interview"
      >
        <HangUpIcon />
        <span>Leave</span>
      </button>
    </div>
  );
}

/*
 * Inline SVG, stroke-based, 24-grid: no icon dependency and no network request
 * for three glyphs. `aria-hidden` because the button already has a label.
 */

const SVG = {
  className: "ctrl__icon",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function MicIcon() {
  return (
    <svg {...SVG}>
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg {...SVG}>
      <path d="M15 6a3 3 0 0 0-6 0v3m0 3a3 3 0 0 0 5.2 2.1" />
      <path d="M5 11a7 7 0 0 0 10.7 6M19 11v1M12 18v3" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function CamIcon() {
  return (
    <svg {...SVG}>
      <rect x="2.5" y="6.5" width="12.5" height="11" rx="2.5" />
      <path d="M15 11.2l5.2-3a.6.6 0 0 1 .9.5v6.6a.6.6 0 0 1-.9.5l-5.2-3Z" />
    </svg>
  );
}

function CamOffIcon() {
  return (
    <svg {...SVG}>
      <path d="M15 10.5V9a2.5 2.5 0 0 0-2.5-2.5H8m-3.6.8A2.5 2.5 0 0 0 2.5 9v6a2.5 2.5 0 0 0 2.5 2.5h7.5" />
      <path d="M15 11.2l5.2-3a.6.6 0 0 1 .9.5v6.6a.6.6 0 0 1-.9.5L18 14" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg {...SVG}>
      {/* A handset rotated down — the universal "end call" glyph. */}
      <path d="M21 15.5a13.5 13.5 0 0 0-18 0l1.6 2.6a2 2 0 0 0 2.5.7l1.4-.7a1.5 1.5 0 0 0 .8-1.6l-.2-1.2a9 9 0 0 1 5.8 0l-.2 1.2a1.5 1.5 0 0 0 .8 1.6l1.4.7a2 2 0 0 0 2.5-.7L21 15.5Z" />
    </svg>
  );
}
