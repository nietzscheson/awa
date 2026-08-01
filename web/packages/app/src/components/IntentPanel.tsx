"use client";

/** What each side is doing right now. */
export type AvatarState = "idle" | "thinking" | "speaking" | "listening";
export type UserState = "idle" | "speaking";

/**
 * One thing that happened, as opposed to a state that is true now.
 *
 * `actor` drives the colour; `label` is the headline; `detail` is optional
 * context (a tool's arguments, a stop reason).
 */
export interface Intent {
  id: string;
  t: number;
  actor: "avatar" | "user" | "system";
  label: string;
  detail?: string;
}

/** The room never scrolls, so the feed is a window onto its own tail. */
const VISIBLE_INTENTS = 12;

const AVATAR_LABEL: Record<AvatarState, string> = {
  idle: "waiting",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
};

const USER_LABEL: Record<UserState, string> = {
  idle: "silent",
  speaking: "speaking",
};

const ACTOR_LABEL: Record<Intent["actor"], string> = {
  avatar: "Interviewer",
  user: "You",
  system: "Session",
};

/**
 * Who holds the turn, as a two-up header for the side rail.
 *
 * This is the one piece of instrumentation that stays visible at all times: in a
 * call where one participant is a machine, "listening" is the difference between
 * a pause and a hang.
 */
export function PeerStates({
  avatarState,
  userState,
}: {
  avatarState: AvatarState;
  userState: UserState;
}) {
  return (
    <div className="peers" aria-label="Call state">
      <div className={`state is-${avatarState}`}>
        <span className="state__who">Interviewer</span>
        <span className="state__what">{AVATAR_LABEL[avatarState]}</span>
      </div>
      <div className={`state is-${userState}`}>
        <span className="state__who">You</span>
        <span className="state__what">{USER_LABEL[userState]}</span>
      </div>
    </div>
  );
}

/**
 * The trail of what each side did — the second tab of the rail.
 *
 * There is no intent classifier in the pipeline, so "intents" here are the
 * signals the agent actually emits: the tools it decides to call (`functionCall`
 * — its intent in the most literal sense), interruptions, and turn boundaries.
 * The exhaustive version of this, with per-turn latency, is the browser console
 * trace (see lib/liveEvents.ts); this panel is the at-a-glance one.
 */
export function SignalFeed({ intents }: { intents: Intent[] }) {
  const visible = intents.slice(-VISIBLE_INTENTS);

  return (
    <ol className="feed" aria-label="Signals">
      {visible.length === 0 ? (
        <li className="feed__empty">No signals yet.</li>
      ) : (
        visible.map((intent) => (
          <li key={intent.id} className={`intent intent--${intent.actor}`}>
            <span className="intent__actor">{ACTOR_LABEL[intent.actor]}</span>
            <span className="intent__label">{intent.label}</span>
            {intent.detail ? <span className="intent__detail">{intent.detail}</span> : null}
          </li>
        ))
      )}
    </ol>
  );
}
