"use client";

import type { ReviewedAnswer } from "@/lib/interviewReview";

export type Speaker = "you" | "agent";

export interface Line {
  id: string;
  role: Speaker;
  text: string;
  /**
   * The answer record, when this line is the interviewer's read-back rather than
   * speech. Rendered as a list: it exists to be checked, not listened to.
   */
  answers?: ReviewedAnswer[];
}

interface ConversationProps {
  lines: Line[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  canSend: boolean;
}

/**
 * How many turns stay on screen.
 *
 * The room is a fixed-size surface with nothing scrollable in it, so the
 * conversation shows a window onto the end of itself — like live captions —
 * instead of growing a scrollbar. Older turns are clipped from view but remain
 * in state, so nothing is actually lost if this ever needs a history view.
 */
const VISIBLE_TURNS = 8;

/**
 * The conversation as it happens.
 *
 * Both sides arrive as transcription deltas over the ADK socket, so lines grow
 * in place while a turn is being spoken and settle when it finishes. The text
 * box is a secondary path — useful when the microphone isn't an option — and the
 * agent treats a typed turn exactly like a spoken one.
 *
 * One line is not speech: the answer record the interviewer asks the candidate to
 * confirm at the end (see lib/interviewReview.ts). A spoken list is impossible to
 * check, so it is shown as one.
 */
export function Conversation({
  lines,
  draft,
  onDraftChange,
  onSend,
  canSend,
}: ConversationProps) {
  const visible = lines.slice(-VISIBLE_TURNS);

  return (
    <section className="conversation" aria-label="Conversation">
      <div className="conversation__view">
        {visible.length === 0 ? (
          <p className="conversation__empty">
            The conversation will appear here as soon as the interview starts.
          </p>
        ) : (
          visible.map((line) =>
            line.answers ? (
              <div key={line.id} className="line line--agent line--review">
                <span className="line__who">Interviewer</span>
                <dl className="review" aria-label="Answers to confirm">
                  {line.answers.map((item) => (
                    <div key={item.id} className="review__row">
                      <dt>{item.question}</dt>
                      <dd>{item.answer}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : (
              <p key={line.id} className={`line line--${line.role}`}>
                <span className="line__who">{line.role === "you" ? "You" : "Interviewer"}</span>
                <span className="line__text">{line.text}</span>
              </p>
            ),
          )
        )}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Type a message…"
          disabled={!canSend}
          spellCheck={false}
        />
        <button type="submit" className="btn" disabled={!canSend || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
