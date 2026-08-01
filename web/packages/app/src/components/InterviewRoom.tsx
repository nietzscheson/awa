"use client";

import { useState } from "react";

import { AvatarStage } from "@/components/AvatarStage";
import { CallControls } from "@/components/CallControls";
import { CameraStage } from "@/components/CameraStage";
import { Conversation, type Line } from "@/components/Conversation";
import {
  type AvatarState,
  type Intent,
  PeerStates,
  SignalFeed,
  type UserState,
} from "@/components/IntentPanel";

interface InterviewRoomProps {
  avatar: {
    attachVideo: (element: HTMLVideoElement | null) => void;
    connected: boolean;
    connecting: boolean;
    speaking: boolean;
    error: string | null;
    isSandbox: boolean;
  };
  camera: {
    attachVideo: (element: HTMLVideoElement | null) => void;
    active: boolean;
    error: string | null;
    off: boolean;
    onToggle: () => void;
  };
  live: boolean;
  status: string;
  micMuted: boolean;
  onToggleMic: () => void;
  avatarState: AvatarState;
  userState: UserState;
  intents: Intent[];
  lines: Line[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onClose: () => void;
}

type Tab = "chat" | "signals";

/**
 * Second screen: the interview, laid out as a video call.
 *
 * One stage and one rail. The interviewer's feed *is* the stage — it fills it
 * edge to edge — and everything else about the call floats on top of that feed:
 * the candidate's own tile in the top-right corner, the status pill top-left,
 * the mic / camera / hang-up controls at the bottom. That stacking is the whole
 * reason it reads as a call rather than a dashboard: no chrome bar competing
 * with the face, and the candidate's self-view where every video app puts it.
 *
 * The rail holds what a call has beside the video: the two participants' live
 * state, and the conversation. The signal feed shares that space as a second tab
 * instead of a permanent column, because it is instrumentation — useful, but not
 * something to stare at while being interviewed.
 *
 * Sizing is still fixed: `.room` is pinned to the viewport, every cell is
 * `overflow: hidden`, and the two feeds show their own tail. Nothing on this
 * screen scrolls.
 */
export function InterviewRoom({
  avatar,
  camera,
  live,
  status,
  micMuted,
  onToggleMic,
  avatarState,
  userState,
  intents,
  lines,
  draft,
  onDraftChange,
  onSend,
  onClose,
}: InterviewRoomProps) {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <div className="room">
      <main className="stage">
        <AvatarStage
          attachVideo={avatar.attachVideo}
          connected={avatar.connected}
          connecting={avatar.connecting}
          speaking={avatar.speaking}
          audioOnly={live && !avatar.connected}
        />

        <div className="stage__head">
          <span className="pill">
            <span className={`dot ${live ? "dot--live" : "dot--off"}`} aria-hidden />
            {status}
          </span>
        </div>

        {/*
         * "Thinking" over the interviewer's own image, because that is the
         * question the silence raises: the model emits nothing at all while it
         * reasons or runs a tool, so without this the avatar just stares.
         */}
        {avatarState === "thinking" ? (
          <div className="stage__thinking">
            <span className="thinking" role="status">
              <em className="thinking__dots" aria-hidden>
                <i />
                <i />
                <i />
              </em>
              Thinking
            </span>
          </div>
        ) : null}

        {/* Floated, so a notice appearing mid-interview cannot resize anything. */}
        <div className="stage__notices">
          {avatar.error ? (
            <p className="alert alert--warn" role="status">
              {avatar.error}
            </p>
          ) : null}
          {avatar.isSandbox && avatar.connected ? (
            <p className="alert alert--info" role="status">
              Avatar in sandbox mode: it closes itself after ~1 minute.
            </p>
          ) : null}
        </div>

        <div className="stage__pip">
          <CameraStage
            attachVideo={camera.attachVideo}
            active={camera.active}
            error={camera.error}
            speaking={userState === "speaking"}
            muted={micMuted}
            cameraOff={camera.off}
          />
        </div>

        <div className="stage__controls">
          <CallControls
            micMuted={micMuted}
            onToggleMic={onToggleMic}
            cameraOff={camera.off}
            onToggleCamera={camera.onToggle}
            onClose={onClose}
          />
        </div>
      </main>

      <aside className="rail">
        <PeerStates avatarState={avatarState} userState={userState} />

        <div className="rail__card">
          <div className="tabs" role="tablist" aria-label="Side panel">
            <button
              type="button"
              role="tab"
              id="tab-chat"
              aria-selected={tab === "chat"}
              aria-controls="panel-chat"
              className={`tab${tab === "chat" ? " is-active" : ""}`}
              onClick={() => setTab("chat")}
            >
              Conversation
            </button>
            <button
              type="button"
              role="tab"
              id="tab-signals"
              aria-selected={tab === "signals"}
              aria-controls="panel-signals"
              className={`tab${tab === "signals" ? " is-active" : ""}`}
              onClick={() => setTab("signals")}
            >
              Signals
              {intents.length > 0 ? <em className="tab__count">{intents.length}</em> : null}
            </button>
          </div>

          {tab === "chat" ? (
            <div className="rail__panel" role="tabpanel" id="panel-chat" aria-labelledby="tab-chat">
              <Conversation
                lines={lines}
                draft={draft}
                onDraftChange={onDraftChange}
                onSend={onSend}
                canSend={live}
              />
            </div>
          ) : (
            <div
              className="rail__panel"
              role="tabpanel"
              id="panel-signals"
              aria-labelledby="tab-signals"
            >
              <SignalFeed intents={intents} />
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
