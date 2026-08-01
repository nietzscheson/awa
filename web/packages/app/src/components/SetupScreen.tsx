"use client";

import { CameraStage } from "@/components/CameraStage";
import type { PermissionState } from "@/hooks/useMediaDevices";
import { INTERVIEW_LANGUAGES, type InterviewLanguage } from "@/lib/languages";

export interface Applicant {
  firstName: string;
  lastName: string;
  address: string;
}

interface SetupScreenProps {
  applicant: Applicant;
  onChange: (patch: Partial<Applicant>) => void;
  /** The language the interview will be conducted in. */
  language: InterviewLanguage;
  onLanguageChange: (language: InterviewLanguage) => void;
  starting: boolean;
  /** Why the last attempt didn't get off the ground. */
  error: string | null;
  onStart: () => void;
  permission: PermissionState;
  permissionError: string | null;
  onRequestPermission: () => void;
  attachVideo: (element: HTMLVideoElement | null) => void;
}

/** What the interview is actually built on, named where it can be read. */
const STACK = ["Google ADK", "Gemini Live API", "LiveAvatar"] as const;

const PERMISSION_LABEL: Record<PermissionState, string> = {
  idle: "Camera and microphone not allowed yet",
  requesting: "Waiting for your answer…",
  granted: "Camera and microphone ready",
  denied: "Permission denied",
};

/**
 * First screen: who is being interviewed, and consent to use their devices.
 *
 * The three fields become the ADK session state at creation — `first_name`,
 * `last_name` and `ine_address` — which the interview agent's tools read to
 * confirm the candidate's name and address out loud. Pre-filled deliberately;
 * blank fields are simply omitted from the session state.
 *
 * Permission is a gate rather than a surprise mid-interview: both devices are
 * requested here, in one prompt, and the self-view doubles as proof the camera
 * actually works before anyone commits to a session.
 *
 * Full-bleed, like the room it leads into: the preview is big enough to actually
 * check your framing on, which is the point of showing it at all.
 */
export function SetupScreen({
  applicant,
  onChange,
  language,
  onLanguageChange,
  starting,
  error,
  onStart,
  permission,
  permissionError,
  onRequestPermission,
  attachVideo,
}: SetupScreenProps) {
  const granted = permission === "granted";

  return (
    <div className="setup">
      <form
        className="setup__card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!starting && granted) onStart();
        }}
      >
        <header className="setup__head">
          <p className="wordmark">Awa</p>

          {/*
           * The stack, up front. This screen is a demo as much as an onboarding
           * step: whoever opens it should know what is about to talk to them and
           * which pieces make it work, before deciding to hand over a camera.
           */}
          <ul className="setup__stack" aria-label="Built with">
            {STACK.map((piece) => (
              <li key={piece} className="chip">
                {piece}
              </li>
            ))}
          </ul>
          <h1>A real-time interview, conducted by an AI</h1>
          <p className="setup__lede">
            A <strong>Google ADK</strong> agent runs the interview over the{" "}
            <strong>Gemini Live API</strong> — it listens, asks, and answers as you speak — and{" "}
            <strong>LiveAvatar</strong> gives it a face that lip-syncs the same voice. Confirm your
            details below, allow your camera and microphone, and the interviewer will greet you as
            soon as you join.
          </p>
        </header>

        <div className="setup__body">
          <div className="setup__form">
            <div className="setup__fields">
              <label className="field">
                <span>First name</span>
                <input
                  value={applicant.firstName}
                  onChange={(event) => onChange({ firstName: event.target.value })}
                  disabled={starting}
                  autoComplete="given-name"
                  spellCheck={false}
                />
              </label>

              <label className="field">
                <span>Last name</span>
                <input
                  value={applicant.lastName}
                  onChange={(event) => onChange({ lastName: event.target.value })}
                  disabled={starting}
                  autoComplete="family-name"
                  spellCheck={false}
                />
              </label>

              <label className="field">
                <span>Address</span>
                <input
                  value={applicant.address}
                  onChange={(event) => onChange({ address: event.target.value })}
                  disabled={starting}
                  autoComplete="street-address"
                  spellCheck={false}
                />
              </label>

              {/*
               * A radio group rather than a select: two options, and the one in
               * effect should be readable without opening anything — it decides
               * what language the interviewer greets you in.
               */}
              <fieldset className="field field--choice" disabled={starting}>
                <legend>Interview language</legend>
                <div className="choices">
                  {INTERVIEW_LANGUAGES.map((option) => (
                    <label
                      key={option.code}
                      className={`choice${language === option.code ? " is-active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="interview-language"
                        value={option.code}
                        checked={language === option.code}
                        onChange={() => onLanguageChange(option.code)}
                        disabled={starting}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="setup__actions">
              {permissionError ? (
                <p className="alert alert--warn" role="status">
                  {permissionError}
                </p>
              ) : null}
              {error ? (
                <p className="alert alert--error" role="alert">
                  {error}
                </p>
              ) : null}

              <div className={`perm perm--${permission}`}>
                <span className="perm__dot" aria-hidden />
                <span className="perm__label">{PERMISSION_LABEL[permission]}</span>
              </div>

              {granted ? null : (
                <button
                  type="button"
                  className="btn btn--block"
                  onClick={onRequestPermission}
                  disabled={permission === "requesting"}
                >
                  {permission === "denied" ? "Try again" : "Allow access"}
                </button>
              )}

              <button
                type="submit"
                className="btn btn--primary btn--block"
                disabled={starting || !granted}
              >
                {starting ? "Creating the session…" : "Start interview"}
              </button>
            </div>
          </div>

          <div className="setup__preview">
            <CameraStage
              attachVideo={attachVideo}
              active={granted}
              error={permission === "denied" ? "No camera" : "Camera off"}
              speaking={false}
              muted={false}
              variant="self"
            />
          </div>
        </div>
      </form>
    </div>
  );
}
