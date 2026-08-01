import { isInterviewConfirmed, reviewedAnswers } from "@/lib/interviewReview";

const RECORD = {
  status: "success",
  answers: [
    { id: "confirm_name", question: "Is your name Ada Lovelace?", answer: "yes" },
    { id: "3", question: "What is your email?", answer: "ada@example.com" },
  ],
};

describe("reviewedAnswers", () => {
  it("reads the record out of a closing tool's response", () => {
    expect(reviewedAnswers("review_answers", RECORD)).toEqual([
      { id: "confirm_name", question: "Is your name Ada Lovelace?", answer: "yes" },
      { id: "3", question: "What is your email?", answer: "ada@example.com" },
    ]);
    // A correction and a confirmation return the same shape, and both are shown.
    expect(reviewedAnswers("correct_answer", RECORD)).toHaveLength(2);
    expect(reviewedAnswers("confirm_interview", RECORD)).toHaveLength(2);
  });

  it("looks inside a `result` wrapper, since ADK sometimes adds one", () => {
    expect(reviewedAnswers("review_answers", { result: RECORD })).toHaveLength(2);
  });

  it("ignores tools that aren't part of the closing loop", () => {
    expect(reviewedAnswers("submit_answer", RECORD)).toBeNull();
    expect(reviewedAnswers(undefined, RECORD)).toBeNull();
  });

  it("returns null rather than an empty card when there is nothing to show", () => {
    expect(reviewedAnswers("review_answers", { status: "success", answers: [] })).toBeNull();
    expect(reviewedAnswers("review_answers", { status: "error" })).toBeNull();
    expect(reviewedAnswers("review_answers", "nonsense")).toBeNull();
    expect(reviewedAnswers("review_answers", null)).toBeNull();
  });

  it("drops malformed entries instead of rendering holes", () => {
    const mixed = {
      answers: [
        { question: "Kept", answer: "yes" },
        { question: "No answer" },
        "not an object",
      ],
    };
    expect(reviewedAnswers("review_answers", mixed)).toEqual([
      { id: "Kept", question: "Kept", answer: "yes" },
    ]);
  });
});

describe("isInterviewConfirmed", () => {
  it("fires only on a confirmed confirm_interview", () => {
    expect(isInterviewConfirmed("confirm_interview", { status: "confirmed" })).toBe(true);
    // Wrapped the same way ADK may wrap it: missing this would leave the call
    // open after the goodbye.
    expect(isInterviewConfirmed("confirm_interview", { result: { status: "confirmed" } })).toBe(
      true,
    );
    // Refused because the questionnaire wasn't finished: not a confirmation.
    expect(isInterviewConfirmed("confirm_interview", { status: "error" })).toBe(false);
    expect(isInterviewConfirmed("review_answers", { status: "confirmed" })).toBe(false);
  });
});
