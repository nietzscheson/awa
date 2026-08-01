import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { StreamingAgentClient } from "@/components/StreamingAgentClient";
import { base64ToPcm16 } from "@/lib/livePcm";

// ── Mocks ────────────────────────────────────────────────────────────────

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }
  // test-only drivers
  _open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  _message(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  _close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
  sentObjects() {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

class MockBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect = jest.fn();
  start = jest.fn();
  stop = jest.fn();
}

class MockAudioBuffer {
  channelData: Float32Array;
  duration: number;
  constructor(len: number, rate: number) {
    this.channelData = new Float32Array(len);
    this.duration = len / rate;
  }
  getChannelData() {
    return this.channelData;
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  state: AudioContextState = "suspended";
  currentTime = 0;
  sampleRate: number;
  destination = {};
  sources: MockBufferSource[] = [];
  lastBuffer: MockAudioBuffer | null = null;
  lastProcessor: {
    connect: jest.Mock;
    disconnect: jest.Mock;
    onaudioprocess: ((e: unknown) => void) | null;
  } | null = null;
  resume = jest.fn(async () => {
    this.state = "running";
  });
  close = jest.fn(async () => {
    this.state = "closed";
  });
  createMediaStreamSource = jest.fn(() => ({ connect: jest.fn() }));
  createGain = jest.fn(() => ({ gain: { value: 0 }, connect: jest.fn() }));

  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 44100;
    MockAudioContext.instances.push(this);
  }
  createBuffer(_ch: number, len: number, rate: number) {
    this.lastBuffer = new MockAudioBuffer(len, rate);
    return this.lastBuffer;
  }
  createBufferSource() {
    const s = new MockBufferSource();
    this.sources.push(s);
    return s;
  }
  createScriptProcessor() {
    this.lastProcessor = { connect: jest.fn(), disconnect: jest.fn(), onaudioprocess: null };
    return this.lastProcessor;
  }
}

/**
 * Every fetch succeeds but returns `{}`. That is deliberate: the LiveAvatar
 * token route yields no `session_token`, so the avatar never comes up and the
 * agent's audio takes the local-playback fallback — the path these tests assert.
 */
function okFetch() {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => "{}",
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

/** The ADK session-create call, wherever it landed among the fetches. */
function adkSessionCall(): [string, RequestInit] {
  const call = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
    String(url).includes("/apps/"),
  );
  if (!call) throw new Error("no ADK session POST was made");
  return [String(call[0]), call[1] as RequestInit];
}

const micTrack = { stop: jest.fn(), enabled: true };
const camTrack = { stop: jest.fn(), enabled: true };

function mockMedia() {
  const stream = {
    getTracks: () => [micTrack, camTrack],
    getAudioTracks: () => [micTrack],
    getVideoTracks: () => [camTrack],
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: jest.fn(async () => stream) },
  });
}

/** Bytes → URL-safe base64 without padding (how google-genai emits audio). */
function bytesToUrlSafeNoPad(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  MockWebSocket.instances = [];
  MockAudioContext.instances = [];
  micTrack.stop.mockClear();
  micTrack.enabled = true;
  camTrack.stop.mockClear();
  camTrack.enabled = true;
  (global as unknown as { fetch: typeof fetch }).fetch = okFetch();
  (global as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  (window as unknown as { AudioContext: unknown }).AudioContext = MockAudioContext;
  mockMedia();
  localStorage.clear();
});

/** Grant camera + mic, which the start button is gated on. */
async function grantPermission() {
  fireEvent.click(screen.getByRole("button", { name: /allow access/i }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /start interview/i })).toBeEnabled(),
  );
}

/** Click through the setup screen and land in the room with an open socket. */
async function enterRoom() {
  await grantPermission();
  fireEvent.click(screen.getByRole("button", { name: /start interview/i }));
  await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
  const ws = MockWebSocket.instances.at(-1)!;
  await act(async () => {
    ws._open();
  });
  return ws;
}

// ── Screen 1 ─────────────────────────────────────────────────────────────

describe("setup screen", () => {
  it("asks only for the applicant's details, pre-filled", () => {
    render(<StreamingAgentClient />);

    // The screen says what it is, and what is about to talk to you, before
    // asking for a camera.
    expect(screen.getByText("Awa")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/conducted by an AI/i);
    const stack = screen.getByLabelText("Built with");
    expect(stack).toHaveTextContent("Google ADK");
    expect(stack).toHaveTextContent("Gemini Live API");
    expect(stack).toHaveTextContent("LiveAvatar");

    expect(screen.getByDisplayValue("Cristian")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Angulo")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("Monte Leon de Piedad 237. Ciudad de México"),
    ).toBeInTheDocument();
    // Devices are a gate, not a mid-interview surprise.
    expect(screen.getByRole("button", { name: /start interview/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /allow access/i })).toBeInTheDocument();
    expect(screen.getByText(/not allowed yet/i)).toBeInTheDocument();

    // The plumbing is gone from the UI entirely — no base URL, ids or modality.
    expect(screen.queryByDisplayValue("/adk")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("streaming")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    // No avatar yet: the room only exists once the socket is open. The self-view
    // is present from the start, though — it is how you check your camera.
    expect(screen.queryByTestId("avatar-video")).not.toBeInTheDocument();
    expect(screen.getByTestId("camera-video")).toBeInTheDocument();
  });

  it("creates the session with the applicant metadata as its state", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    const [url, init] = adkSessionCall();
    expect(url).toMatch(/\/adk\/apps\/streaming\/users\/.+\/sessions\/.+/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      first_name: "Cristian",
      last_name: "Angulo",
      ine_address: "Monte Leon de Piedad 237. Ciudad de México",
      language: "en-US",
    });

    expect(ws.url).toMatch(/^ws:\/\/localhost\/adk\/run_live\?/);
    expect(ws.url).toContain("app_name=streaming");
    expect(ws.url).toContain("modalities=AUDIO");
  });

  it("reflects edited metadata and omits blank fields", async () => {
    render(<StreamingAgentClient />);

    fireEvent.change(screen.getByDisplayValue("Cristian"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByDisplayValue("Monte Leon de Piedad 237. Ciudad de México"), {
      target: { value: "   " }, // whitespace → omitted
    });

    await enterRoom();
    const body = JSON.parse(adkSessionCall()[1].body as string);
    expect(body.first_name).toBe("Ada");
    expect(body.last_name).toBe("Angulo");
    expect(body).not.toHaveProperty("ine_address");
  });

  it("offers the interview language and sends the chosen one as session state", async () => {
    // The agent is one process-wide singleton, so this key is how a per-interview
    // language reaches it: its instruction is resolved per session from state.
    render(<StreamingAgentClient />);

    const english = screen.getByRole("radio", { name: "English" });
    const spanish = screen.getByRole("radio", { name: "Español" });
    expect(english).toBeChecked();
    expect(spanish).not.toBeChecked();

    fireEvent.click(spanish);
    expect(spanish).toBeChecked();

    await enterRoom();
    expect(JSON.parse(adkSessionCall()[1].body as string).language).toBe("es-MX");
  });

  it("stays on the setup screen and explains a failed session create", async () => {
    (global as unknown as { fetch: typeof fetch }).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    render(<StreamingAgentClient />);
    await grantPermission();
    fireEvent.click(screen.getByRole("button", { name: /start interview/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not create the session/i);
    expect(MockWebSocket.instances.length).toBe(0);
    expect(screen.getByRole("button", { name: /start interview/i })).toBeEnabled();
    expect(screen.queryByTestId("avatar-video")).not.toBeInTheDocument();
  });
});

// ── Permissions ──────────────────────────────────────────────────────────

describe("device permissions", () => {
  it("asks for camera and microphone together, in one prompt", async () => {
    render(<StreamingAgentClient />);
    await grantPermission();

    // One call, both devices: two separate prompts at different moments is a
    // worse experience and lets the interview start half-permitted.
    const calls = (navigator.mediaDevices.getUserMedia as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
  });

  it("explains a denial and offers a retry without unlocking the start button", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: jest.fn(async () => {
          throw new DOMException("denied", "NotAllowedError");
        }),
      },
    });

    render(<StreamingAgentClient />);
    fireEvent.click(screen.getByRole("button", { name: /allow access/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/permission denied/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start interview/i })).toBeDisabled();
  });

  it("does not re-prompt for the microphone when the interview starts", async () => {
    render(<StreamingAgentClient />);
    await enterRoom();

    // The mic graph is built over the track granted on the setup screen.
    expect((navigator.mediaDevices.getUserMedia as jest.Mock).mock.calls).toHaveLength(1);
    const micCtx = MockAudioContext.instances[1];
    await waitFor(() => expect(micCtx.lastProcessor).not.toBeNull());
  });
});

// ── Screen 2 ─────────────────────────────────────────────────────────────

describe("interview room", () => {
  it("opens both feeds and the call controls once the socket is live", async () => {
    render(<StreamingAgentClient />);
    await enterRoom();

    expect(screen.getByTestId("avatar-video")).toBeInTheDocument();
    expect(screen.getByTestId("camera-video")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /leave the interview/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mute microphone/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /turn camera off/i })).toBeInTheDocument();
    expect(screen.getByText("Interview in progress")).toBeInTheDocument();
  });

  it("turns the candidate's camera off without touching the track's life", async () => {
    // The video track feeds nothing but the self-view, so this is the candidate's
    // own privacy control — disabling the track is what puts the camera light out.
    render(<StreamingAgentClient />);
    await enterRoom();

    fireEvent.click(screen.getByRole("button", { name: /turn camera off/i }));

    expect(camTrack.enabled).toBe(false);
    expect(camTrack.stop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /turn camera on/i })).toBeInTheDocument();
    expect(screen.getByText("Camera off.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /turn camera on/i }));
    expect(camTrack.enabled).toBe(true);
  });

  it("closes everything and returns to the setup screen", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /leave the interview/i }));
    });

    expect(ws.closed).toBe(true);
    expect(ws.sentObjects().some((m) => m.close === true)).toBe(true);
    expect(micTrack.stop).toHaveBeenCalled();
    // Back to screen 1, with the form still there.
    expect(screen.getByRole("button", { name: /start interview/i })).toBeInTheDocument();
    expect(screen.queryByTestId("avatar-video")).not.toBeInTheDocument();
  });

  it("reports an abnormal socket close", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      ws._close(1011, "internal error");
    });
    expect(await screen.findByText(/session closed \(code 1011\)/i)).toBeInTheDocument();
  });
});

// ── Conversation ─────────────────────────────────────────────────────────

describe("conversation", () => {
  it("grows the agent's line from deltas, then settles on the final text", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      ws._message({ outputTranscription: { text: "Hi", finished: false } });
    });
    await act(async () => {
      ws._message({ outputTranscription: { text: "Hello, how are you?", finished: true } });
    });

    expect(screen.getByText("Hello, how are you?")).toBeInTheDocument();
    expect(screen.queryByText("Hi")).not.toBeInTheDocument();
  });

  it("makes the interviewer speak first, without putting the cue in the transcript", async () => {
    // A live model says nothing until it has input, so somebody has to take the
    // first turn. It is the app, not the candidate — which is why the cue is
    // bracketed and never rendered.
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    const first = ws.sentObjects().find((m) => m.content);
    const parts = (first!.content as { role: string; parts: Array<{ text: string }> }).parts;
    expect(parts[0].text).toMatch(/^\[interview_start\]/);
    expect(screen.queryByText(/interview_start/)).not.toBeInTheDocument();

    // And the room shows the agent as busy while it composes the greeting.
    expect(screen.getByText("thinking")).toBeInTheDocument();
  });

  it("keeps the model's thought summaries out of the transcript", async () => {
    // Thoughts arrive as ordinary text parts on the same channel as speech. They
    // are English reasoning *about* the candidate ("I've registered the Spanish
    // greeting; I'll respond appropriately…") and were being rendered as if the
    // interviewer had said them.
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      ws._message({
        content: {
          parts: [{ text: "**Acknowledge and Initiate**\n\nOkay, I've registered", thought: true }],
        },
      });
      ws._message({ outputTranscription: { text: "Good afternoon.", finished: true } });
    });

    expect(screen.queryByText(/Acknowledge and Initiate/)).not.toBeInTheDocument();
    expect(screen.getByText("Good afternoon.")).toBeInTheDocument();
  });

  it("renders the candidate's mic transcript", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      ws._message({ inputTranscription: { text: "hi my name is Ana", finished: true } });
    });
    expect(screen.getByText("hi my name is Ana")).toBeInTheDocument();
  });

  it("sends a typed turn and echoes it", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    fireEvent.change(screen.getByPlaceholderText("Type a message…"), {
      target: { value: "hi" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    // The last content turn: the first one is the opening cue sent on connect.
    const turn = ws.sentObjects().filter((m) => m.content).at(-1);
    const content = turn!.content as { role: string; parts: Array<{ text: string }> };
    expect(content.role).toBe("user");
    expect(content.parts[0].text).toBe("hi");
    expect(screen.getByText("hi")).toBeInTheDocument();
  });
});

// ── Intents ──────────────────────────────────────────────────────────────

describe("intents", () => {
  /** The feed shares the rail with the chat, which is the tab shown first. */
  function openSignals() {
    fireEvent.click(screen.getByRole("tab", { name: /signals/i }));
  }

  it("keeps the signal feed behind a tab, with the conversation in front", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      ws._message({ outputTranscription: { text: "Hi", finished: true } });
    });

    // The interview is what the candidate should be looking at; the signals are
    // instrumentation, one click away.
    expect(screen.getByText("Hi")).toBeInTheDocument();
    expect(screen.queryByLabelText("Signals")).not.toBeInTheDocument();

    openSignals();
    expect(screen.getByLabelText("Signals")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Type a message…")).not.toBeInTheDocument();
  });

  it("shows the tool the agent decided to call", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      ws._message({
        content: { parts: [{ functionCall: { name: "start_interview", args: { step: 1 } } }] },
      });
    });
    openSignals();

    expect(screen.getByText("calls start_interview")).toBeInTheDocument();
    expect(screen.getByText('{"step":1}')).toBeInTheDocument();
  });

  it("tracks who holds the turn across a full exchange", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    // The state read-out stays visible whichever tab is open: in a call with a
    // machine, "listening" is what tells a pause apart from a hang.

    // Candidate starts talking → the user side is speaking.
    await act(async () => {
      ws._message({ inputTranscription: { text: "hi", finished: false } });
    });
    expect(screen.getByText("speaking")).toBeInTheDocument();

    // Candidate stops → the agent is thinking.
    await act(async () => {
      ws._message({ inputTranscription: { text: "hi", finished: true } });
    });
    expect(screen.getByText("thinking")).toBeInTheDocument();

    await act(async () => {
      ws._message({ outputTranscription: { text: "Hello", finished: false } });
    });

    // Turn ends → back to listening.
    await act(async () => {
      ws._message({ turnComplete: true });
    });
    expect(screen.getByText("listening")).toBeInTheDocument();

    // …and the whole exchange is in the trail.
    openSignals();
    expect(screen.getByText("starts speaking")).toBeInTheDocument();
    expect(screen.getByText("yields the turn")).toBeInTheDocument();
    expect(screen.getByText("starts answering")).toBeInTheDocument();
    expect(screen.getByText("ends the turn")).toBeInTheDocument();
  });

  it("records a barge-in, and only while the agent was talking", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    // An `interrupted` with nobody talking is bookkeeping, not an event worth a line.
    await act(async () => {
      ws._message({ interrupted: true });
    });
    openSignals();
    expect(screen.queryByText("interrupted")).not.toBeInTheDocument();

    await act(async () => {
      ws._message({ outputTranscription: { text: "As I was saying", finished: false } });
      ws._message({ interrupted: true });
    });
    expect(screen.getByText("interrupted")).toBeInTheDocument();
  });
});

// ── Closing the interview ────────────────────────────────────────────────

describe("confirmation and close", () => {
  const RECORD = [
    { id: "confirm_name", question: "Is your name Ada Lovelace?", answer: "yes" },
    { id: "3", question: "What is your email?", answer: "ada@example.com" },
  ];

  /** A `functionResponse` event, as ADK sends it. */
  function toolReturned(ws: MockWebSocket, name: string, response: unknown) {
    ws._message({ content: { parts: [{ functionResponse: { name, response } }] } });
  }

  it("shows the answers in the chat when the agent reads them back", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      toolReturned(ws, "review_answers", { status: "success", answers: RECORD });
    });

    // The list is shown, not just spoken: it is what the candidate must check.
    expect(screen.getByLabelText("Answers to confirm")).toBeInTheDocument();
    expect(screen.getByText("Is your name Ada Lovelace?")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("shows the corrected record again, but not an unchanged one twice", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      toolReturned(ws, "review_answers", { status: "success", answers: RECORD });
      // `confirm_interview` returns the same record — no point repeating it.
      toolReturned(ws, "review_answers", { status: "success", answers: RECORD });
    });
    expect(screen.getAllByLabelText("Answers to confirm")).toHaveLength(1);

    const corrected = [RECORD[0], { ...RECORD[1], answer: "ada@lovelace.io" }];
    await act(async () => {
      toolReturned(ws, "correct_answer", { status: "success", answers: corrected });
    });

    // A change is worth a new card: that is how the correction becomes visible.
    expect(screen.getAllByLabelText("Answers to confirm")).toHaveLength(2);
    expect(screen.getByText("ada@lovelace.io")).toBeInTheDocument();
  });

  it("closes the mic on confirmation but waits for the goodbye to end the call", async () => {
    jest.useFakeTimers();
    try {
      render(<StreamingAgentClient />);
      const ws = await enterRoom();

      await act(async () => {
        toolReturned(ws, "confirm_interview", { status: "confirmed", answers: RECORD });
      });

      // The mic goes immediately: nothing said after this is wanted.
      expect(micTrack.enabled).toBe(false);
      expect(screen.getByText(/closing the interview/i)).toBeInTheDocument();
      // …but the call is still open, because the goodbye hasn't been said yet.
      expect(ws.closed).toBe(false);

      // The farewell arrives and plays out.
      await act(async () => {
        ws._message({
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: bytesToUrlSafeNoPad(new Uint8Array([0x10, 0x20, 0x30, 0x40])),
                },
              },
            ],
          },
        });
        ws._message({ turnComplete: true });
      });
      expect(ws.closed).toBe(false);

      await act(async () => {
        jest.advanceTimersByTime(4000);
      });

      expect(ws.closed).toBe(true);
      expect(ws.sentObjects().some((m) => m.close === true)).toBe(true);
      expect(micTrack.stop).toHaveBeenCalled();
      // The room stays: the record of what was just confirmed is still readable.
      expect(screen.getByText(/interview complete/i)).toBeInTheDocument();
      expect(screen.getByLabelText("Answers to confirm")).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not close on a refused confirmation", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      // The agent jumped the gun; the tool refused.
      toolReturned(ws, "confirm_interview", {
        status: "error",
        error_message: "The questionnaire is not finished",
      });
    });

    expect(ws.closed).toBe(false);
    expect(micTrack.enabled).toBe(true);
  });
});

// ── Audio ────────────────────────────────────────────────────────────────

describe("agent audio without an avatar", () => {
  it("decodes URL-safe PCM and schedules local playback", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    // Bytes whose standard base64 contains '+' and '/', so URL-safe is exercised.
    const data = bytesToUrlSafeNoPad(new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x10, 0x20]));
    expect(data).toMatch(/[-_]/);

    await act(async () => {
      ws._message({
        content: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data } }] },
      });
    });

    const ctx = MockAudioContext.instances[0]; // the player's context
    expect(ctx.sources.length).toBe(1);
    expect(ctx.sources[0].start).toHaveBeenCalledTimes(1);

    const expected = base64ToPcm16(data);
    expect(ctx.lastBuffer?.channelData[0]).toBeCloseTo(expected[0] / 0x8000, 5);
  });

  it("stops playback on a barge-in", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      ws._message({
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/pcm;rate=24000",
                data: bytesToUrlSafeNoPad(new Uint8Array([0x10, 0x20, 0x30, 0x40])),
              },
            },
          ],
        },
      });
    });
    const source = MockAudioContext.instances[0].sources[0];

    await act(async () => {
      ws._message({ interrupted: true });
    });
    expect(source.stop).toHaveBeenCalled();
  });

  it("cuts the agent off the moment the candidate starts talking", async () => {
    // Waiting for the server's `interrupted` round trip is what makes talking over
    // the avatar feel like it did nothing: the candidate is already speaking, so
    // the first partial transcript of their voice is the signal to stop.
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    await act(async () => {
      ws._message({
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/pcm;rate=24000",
                data: bytesToUrlSafeNoPad(new Uint8Array([0x10, 0x20, 0x30, 0x40])),
              },
            },
          ],
        },
      });
    });
    const source = MockAudioContext.instances[0].sources[0];

    await act(async () => {
      ws._message({ inputTranscription: { text: "wait—", finished: false } });
    });

    expect(source.stop).toHaveBeenCalled();
  });
});

// ── Microphone ───────────────────────────────────────────────────────────

describe("microphone", () => {
  it("opens itself when the room does and streams 16kHz PCM", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();

    // No "talk" button to find first: capture starts with the interview.
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
    const micCtx = MockAudioContext.instances[1];
    await waitFor(() => expect(micCtx.lastProcessor).not.toBeNull());

    await act(async () => {
      micCtx.lastProcessor!.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) },
      });
    });

    const blob = ws.sentObjects().find((m) => m.blob)!.blob as {
      mimeType: string;
      data: string;
    };
    expect(blob.mimeType).toBe("audio/pcm;rate=16000");
    expect(blob.data.length).toBeGreaterThan(0);
  });

  it("stops sending frames while muted, and resumes after", async () => {
    render(<StreamingAgentClient />);
    const ws = await enterRoom();
    const micCtx = MockAudioContext.instances[1];
    await waitFor(() => expect(micCtx.lastProcessor).not.toBeNull());

    const frame = () =>
      act(() => {
        micCtx.lastProcessor!.onaudioprocess?.({
          inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) },
        });
      });

    fireEvent.click(screen.getByRole("button", { name: /mute/i }));
    const before = ws.sentObjects().filter((m) => m.blob).length;
    frame();
    expect(ws.sentObjects().filter((m) => m.blob).length).toBe(before);
    // The OS recording indicator should reflect the mute, not just our sending.
    expect(micTrack.enabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /unmute microphone/i }));
    frame();
    expect(ws.sentObjects().filter((m) => m.blob).length).toBe(before + 1);
    expect(micTrack.enabled).toBe(true);
  });
});
