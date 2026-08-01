/**
 * Reading the interview's closing tools off the event stream.
 *
 * The agent reads the answers back out loud, but speech is a bad medium for
 * checking a list of facts — you cannot scan it, and the candidate is being asked
 * to confirm it. So the client renders the same list in the chat, taken from the
 * tool response rather than from the transcript: `review_answers`,
 * `correct_answer` and `confirm_interview` all return the full record (see
 * `InterviewService` in core/src/services.py), which means the chat shows exactly
 * what the agent is working from, corrections included.
 *
 * `confirm_interview` is also the signal that the interview is over: the app
 * closes the microphone and the call once the goodbye has been spoken.
 */

/** Tool responses that carry the answer record. */
const REVIEW_TOOLS = new Set(["review_answers", "correct_answer", "confirm_interview"]);

const CONFIRM_TOOL = "confirm_interview";

export interface ReviewedAnswer {
  id: string;
  question: string;
  answer: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * ADK hands a tool's return value through as `functionResponse.response`, but
 * wraps some returns in `{result: …}`. Look through both rather than betting on
 * one.
 */
function payloadOf(response: unknown): Record<string, unknown> | null {
  const outer = asRecord(response);
  if (!outer) return null;
  const inner = asRecord(outer.result);
  // Unwrap when the inner object is the one carrying the payload. Missing this
  // would be silent and expensive: a wrapped `confirm_interview` would never be
  // recognised, and the call would stay open after the goodbye.
  if (inner && ("answers" in inner || "status" in inner)) return inner;
  return outer;
}

/**
 * The answer record from a closing tool's response, or null if this response
 * isn't one (or carries nothing worth showing).
 */
export function reviewedAnswers(
  name: string | undefined,
  response: unknown,
): ReviewedAnswer[] | null {
  if (!name || !REVIEW_TOOLS.has(name)) return null;

  const payload = payloadOf(response);
  const answers = payload?.answers;
  if (!Array.isArray(answers) || answers.length === 0) return null;

  const items: ReviewedAnswer[] = [];
  for (const entry of answers) {
    const item = asRecord(entry);
    if (!item) continue;
    const question = typeof item.question === "string" ? item.question : null;
    const answer = typeof item.answer === "string" ? item.answer : null;
    if (!question || !answer) continue;
    items.push({
      id: typeof item.id === "string" ? item.id : question,
      question,
      answer,
    });
  }
  return items.length > 0 ? items : null;
}

/** True when the candidate has just confirmed the record and the call should end. */
export function isInterviewConfirmed(name: string | undefined, response: unknown): boolean {
  if (name !== CONFIRM_TOOL) return false;
  return payloadOf(response)?.status === "confirmed";
}
