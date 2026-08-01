import { createLiveTrace, isThoughtPart } from "@/lib/liveEvents";

describe("isThoughtPart", () => {
  it("only flags parts the model marked as reasoning", () => {
    expect(isThoughtPart({ text: "pensando…", thought: true })).toBe(true);
    expect(isThoughtPart({ text: "Hola" })).toBe(false);
    expect(isThoughtPart({ text: "Hola", thought: false })).toBe(false);
  });
});

describe("createLiveTrace", () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  const output = () => log.mock.calls.map((c) => String(c[0])).join("\n");

  it("says nothing at all when debugging is off", () => {
    const trace = createLiveTrace(false);
    trace.reset();
    trace.userTurnEnd("voice");
    trace.event({ turnComplete: true });
    expect(log).not.toHaveBeenCalled();
  });

  it("reports the tool calls and the wait, which is where the latency hides", () => {
    const trace = createLiveTrace(true);
    trace.userTurnEnd("voice");
    trace.event({
      content: { parts: [{ functionCall: { name: "start_interview", args: { restart: false } } }] },
    });
    trace.event({ content: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAAA" } }] } });
    trace.event({ outputTranscription: { text: "Hola", finished: false } });
    trace.event({ turnComplete: true });

    const text = output();
    expect(text).toContain("candidate turn closed (voice)");
    expect(text).toContain("calls start_interview");
    expect(text).toContain("first agent audio");
    expect(text).toContain("turn end");
    // Every line after a turn boundary carries its own +Xms stamp.
    expect(text).toMatch(/\+\d+ms/);
  });

  it("logs a thought summary but marks it as not shown", () => {
    const trace = createLiveTrace(true);
    trace.event({ content: { parts: [{ text: "I'll respond in Spanish", thought: true }] } });

    const text = output();
    expect(text).toContain("thought (not shown)");
    expect(log.mock.calls.some((c) => c.join(" ").includes("I'll respond in Spanish"))).toBe(true);
  });
});
