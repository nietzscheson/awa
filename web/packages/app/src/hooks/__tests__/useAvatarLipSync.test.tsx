import { act, renderHook, waitFor } from "@testing-library/react";

import { useAvatarLipSync } from "@/hooks/useAvatarLipSync";
import { base64ToPcm16, OUTPUT_SAMPLE_RATE, pcm16ToBase64 } from "@/lib/livePcm";

// ── SDK double ───────────────────────────────────────────────────────────

/**
 * Stands in for `LiveAvatarSession`, including the `protected` members the
 * streaming-speech subclass builds on: the event socket, the id generator and
 * the connection check. `sentFrames()` is what the real transport would see.
 */
class FakeSession {
  static last: FakeSession | null = null;

  handlers = new Map<string, (...args: unknown[]) => void>();
  interrupt = jest.fn();
  attach = jest.fn();
  start = jest.fn(async () => {});
  stop = jest.fn(async () => {});
  removeAllListeners = jest.fn();

  /** Frames the subclass pushed over the session socket. */
  frames: Array<Record<string, unknown>> = [];
  ids = 0;

  protected _sessionEventSocket: { readyState: number; send: (data: string) => void } | null = {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => {
      this.frames.push(JSON.parse(data) as Record<string, unknown>);
    },
  };

  constructor(
    public token: string,
    public config: unknown,
  ) {
    FakeSession.last = this;
  }

  on(event: string, cb: (...args: unknown[]) => void) {
    this.handlers.set(event, cb);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args);
  }

  protected generateEventId() {
    return `evt-${++this.ids}`;
  }

  protected assertConnected() {
    return this._sessionEventSocket !== null;
  }

  /** Simulate the socket going away under us. */
  dropSocket() {
    this._sessionEventSocket = null;
  }

  speakFrames() {
    return this.frames.filter((f) => f.type === "agent.speak");
  }

  endFrames() {
    return this.frames.filter((f) => f.type === "agent.speak_end");
  }

  /** Every `agent.speak` payload of one utterance, decoded and concatenated. */
  spokenSamples(): number {
    return this.speakFrames().reduce(
      (total, f) => total + base64ToPcm16(String(f.audio)).length,
      0,
    );
  }
}

jest.mock("@heygen/liveavatar-web-sdk", () => ({
  LiveAvatarSession: FakeSession,
  SessionEvent: {
    SESSION_STREAM_READY: "session.stream_ready",
    SESSION_DISCONNECTED: "session.disconnected",
  },
  AgentEventsEnum: {
    AVATAR_SPEAK_STARTED: "avatar.speak_started",
    AVATAR_SPEAK_ENDED: "avatar.speak_ended",
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────

/** How google-genai actually encodes audio: URL-safe base64, no padding. */
function toUrlSafeNoPad(pcm: Int16Array): string {
  return pcm16ToBase64(pcm).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pcmFromBytes(bytes: number[]): Int16Array {
  const u8 = new Uint8Array(bytes);
  return new Int16Array(u8.buffer, 0, u8.length >> 1);
}

function tokenFetch(payload: Record<string, unknown> = { session_token: "jwt-abc" }) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

async function startedHook() {
  const hook = renderHook(() => useAvatarLipSync());
  await act(async () => {
    await hook.result.current.start();
  });
  await waitFor(() => expect(hook.result.current.connected).toBe(true));
  return hook;
}

beforeEach(() => {
  FakeSession.last = null;
  (global as unknown as { fetch: typeof fetch }).fetch = tokenFetch();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("useAvatarLipSync — session setup", () => {
  it("starts a LITE session with the minted token and no voice chat", async () => {
    const { result } = await startedHook();

    expect(global.fetch).toHaveBeenCalledWith("/api/liveavatar/token", { method: "POST" });
    expect(FakeSession.last?.token).toBe("jwt-abc");
    // The microphone belongs to the ADK socket; the SDK must not publish it too.
    expect(FakeSession.last?.config).toEqual({ voiceChat: false });
    expect(FakeSession.last?.start).toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("attaches when the element is already mounted and the stream then arrives", async () => {
    const { result } = await startedHook();
    const session = FakeSession.last!;
    const video = document.createElement("video");

    act(() => result.current.attachVideo(video));
    // Nothing to attach yet — the track does not exist before stream_ready.
    expect(session.attach).not.toHaveBeenCalled();

    act(() => session.emit("session.stream_ready"));
    expect(session.attach).toHaveBeenCalledWith(video);
  });

  it("attaches when the stream is ready first and the element mounts later", async () => {
    // This is the real order in the app: the session comes up on the setup
    // screen, and the room's <video> is not created until the socket opens.
    // Attaching only on stream_ready left the avatar panel black.
    const { result } = await startedHook();
    const session = FakeSession.last!;

    act(() => session.emit("session.stream_ready"));
    expect(session.attach).not.toHaveBeenCalled();

    const video = document.createElement("video");
    act(() => result.current.attachVideo(video));
    expect(session.attach).toHaveBeenCalledWith(video);
  });

  it("re-attaches when the element is swapped for a new one", async () => {
    const { result } = await startedHook();
    const session = FakeSession.last!;
    act(() => session.emit("session.stream_ready"));

    const first = document.createElement("video");
    const second = document.createElement("video");
    act(() => result.current.attachVideo(first));
    act(() => result.current.attachVideo(null)); // unmount
    act(() => result.current.attachVideo(second)); // remount elsewhere

    expect(session.attach).toHaveBeenNthCalledWith(1, first);
    expect(session.attach).toHaveBeenNthCalledWith(2, second);
  });

  it("reports a failure as non-fatal so the interview can carry on", async () => {
    (global as unknown as { fetch: typeof fetch }).fetch = tokenFetch({
      error: "LiveAvatar rejected the session: out of credits",
    });

    const { result } = renderHook(() => useAvatarLipSync());
    let live: boolean | undefined;
    await act(async () => {
      live = await result.current.start();
    });

    expect(live).toBe(false);
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toMatch(/out of credits/);
    expect(result.current.error).toMatch(/continues with audio/);
  });

  it("tracks speaking state from the avatar's own events", async () => {
    const { result } = await startedHook();
    const session = FakeSession.last!;

    act(() => session.emit("avatar.speak_started"));
    expect(result.current.speaking).toBe(true);
    act(() => session.emit("avatar.speak_ended"));
    expect(result.current.speaking).toBe(false);
  });
});

describe("useAvatarLipSync — audio routing", () => {
  /** 300 ms at 24 kHz: the first frame's worth of audio (19200 base64 chars). */
  const FIRST = 7200;
  /** 750 ms at 24 kHz: every frame after the first (48000 base64 chars). */
  const NEXT = 18000;

  it("declines audio before the session exists, so the caller plays it locally", () => {
    const { result } = renderHook(() => useAvatarLipSync());
    expect(result.current.feed(toUrlSafeNoPad(pcmFromBytes([0x10, 0x20])))).toBe(false);
  });

  it("holds audio too short to be a frame until the turn ends", async () => {
    const { result } = await startedHook();
    const session = FakeSession.last!;

    const first = pcmFromBytes([0xfb, 0xff, 0xbf, 0x00, 0x10, 0x20]);
    const second = pcmFromBytes([0x30, 0x40, 0x50, 0x60]);

    act(() => {
      expect(result.current.feed(toUrlSafeNoPad(first))).toBe(true);
      expect(result.current.feed(toUrlSafeNoPad(second))).toBe(true);
    });
    expect(session.frames).toHaveLength(0);

    act(() => result.current.endTurn());

    // One utterance: the tail, then the end marker.
    expect(session.speakFrames()).toHaveLength(1);
    expect(session.endFrames()).toHaveLength(1);
    const joined = new Int16Array([...first, ...second]);
    expect(session.speakFrames()[0].audio).toBe(pcm16ToBase64(joined));
  });

  it("streams ONE utterance per turn, starting 300 ms in", async () => {
    // This is the whole point of `lib/avatarSpeech.ts`: the avatar starts talking
    // early AND never hears an end-of-speech mid-sentence, which is what made the
    // voice sound chopped up when each flush was its own `repeatAudio`.
    const { result } = await startedHook();
    const session = FakeSession.last!;

    act(() => result.current.feed(toUrlSafeNoPad(new Int16Array(FIRST))));
    expect(session.speakFrames()).toHaveLength(1);
    expect(session.endFrames()).toHaveLength(0); // the sentence is not over

    // Frames grow once the mouth is moving.
    act(() => result.current.feed(toUrlSafeNoPad(new Int16Array(NEXT - 1))));
    expect(session.speakFrames()).toHaveLength(1);
    act(() => result.current.feed(toUrlSafeNoPad(new Int16Array(1))));
    expect(session.speakFrames()).toHaveLength(2);

    act(() => result.current.endTurn());

    // Every frame of the turn carries the same event id — one utterance.
    const ids = new Set(session.frames.map((f) => f.event_id));
    expect(ids.size).toBe(1);
    expect(session.endFrames()).toHaveLength(1);
    // And not a sample was lost or duplicated along the way.
    expect(session.spokenSamples()).toBe(FIRST + NEXT);

    // The next turn is a new utterance, with its own fast first frame.
    act(() => result.current.feed(toUrlSafeNoPad(new Int16Array(FIRST))));
    expect(new Set(session.frames.map((f) => f.event_id)).size).toBe(2);
  });

  it("sends the tail of a phrase instead of holding it for the next burst", async () => {
    // This is the audible bug it fixes: Gemini emits a sentence, then pauses.
    // A tail smaller than a frame used to wait for the following burst, so the
    // avatar played up to the last full frame and clipped at the phrase boundary.
    jest.useFakeTimers();
    try {
      const { result } = await startedHook();
      const session = FakeSession.last!;

      // One full frame plus a 100 ms tail, then silence from the model.
      act(() => result.current.feed(toUrlSafeNoPad(new Int16Array(FIRST + 2400))));
      expect(session.speakFrames()).toHaveLength(1);

      act(() => {
        jest.advanceTimersByTime(200);
      });

      // The tail is on its way without a new burst, and the utterance is still
      // open — flushing early must not look like the end of a sentence.
      expect(session.speakFrames()).toHaveLength(2);
      expect(session.endFrames()).toHaveLength(0);
      expect(session.spokenSamples()).toBe(FIRST + 2400);
      expect(String(session.speakFrames()[1].audio)).not.toMatch(/=/);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not flush a tail it has already sent, nor one that was interrupted", async () => {
    jest.useFakeTimers();
    try {
      const { result } = await startedHook();
      const session = FakeSession.last!;

      act(() => result.current.feed(toUrlSafeNoPad(new Int16Array(600))));
      act(() => result.current.endTurn());
      const afterTurn = session.frames.length;

      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(session.frames).toHaveLength(afterTurn); // nothing left to flush

      act(() => result.current.feed(toUrlSafeNoPad(new Int16Array(600))));
      act(() => result.current.interrupt());
      const afterBargeIn = session.frames.length;

      act(() => {
        jest.advanceTimersByTime(500);
      });
      // A cancelled utterance must not come back to life on a timer.
      expect(session.frames).toHaveLength(afterBargeIn);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps every frame but the last unpadded, so the server can concatenate", async () => {
    // The SDK slices one padded base64 string at 4-char boundaries. Frames sized
    // in multiples of 3 samples reproduce exactly that, so a server that joins
    // frames before decoding gets identical bytes.
    const { result } = await startedHook();
    const session = FakeSession.last!;

    act(() => result.current.feed(toUrlSafeNoPad(new Int16Array(FIRST + 5))));
    expect(session.speakFrames()).toHaveLength(1);
    expect(String(session.speakFrames()[0].audio)).not.toMatch(/=/);

    act(() => result.current.endTurn());
    // Only the trailing frame may pad — it is the end of the utterance.
    expect(session.speakFrames()).toHaveLength(2);
  });

  it("re-encodes Gemini's URL-safe base64 into the standard base64 the wire wants", async () => {
    const { result } = await startedHook();
    const session = FakeSession.last!;

    // Bytes chosen so standard base64 contains both '+' and '/'.
    const pcm = pcmFromBytes([0xfb, 0xff, 0xbf, 0x00]);
    const incoming = toUrlSafeNoPad(pcm);
    expect(incoming).toMatch(/[-_]/); // genuinely URL-safe
    expect(incoming).not.toMatch(/=/); // genuinely unpadded

    act(() => {
      result.current.feed(incoming);
      result.current.endTurn();
    });

    const sent = String(session.speakFrames()[0].audio);
    expect(sent).not.toMatch(/[-_]/);
    expect(sent).toBe(pcm16ToBase64(pcm));
  });

  it("abandons the utterance on barge-in and cuts the avatar off", async () => {
    const { result } = await startedHook();
    const session = FakeSession.last!;

    act(() => {
      result.current.feed(toUrlSafeNoPad(new Int16Array(FIRST)));
      result.current.interrupt();
      result.current.endTurn();
    });

    expect(session.interrupt).toHaveBeenCalled();
    // A cancelled utterance is never completed: no speak_end, and the audio that
    // hadn't been sent is gone rather than queued behind the interruption.
    expect(session.endFrames()).toHaveLength(0);
    expect(session.speakFrames()).toHaveLength(1);
  });

  it("hands audio back to the caller when the socket is gone", async () => {
    const { result } = await startedHook();
    const session = FakeSession.last!;

    session.dropSocket();

    expect(result.current.feed(toUrlSafeNoPad(new Int16Array(FIRST)))).toBe(false);
  });

  it("hands audio back to the caller once the session is stopped", async () => {
    const { result } = await startedHook();

    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.connected).toBe(false);
    expect(result.current.feed(toUrlSafeNoPad(pcmFromBytes([0x10, 0x20])))).toBe(false);
  });

  it("hands audio back when the avatar drops on its own", async () => {
    const { result } = await startedHook();
    const session = FakeSession.last!;

    act(() => session.emit("session.disconnected", "SERVER_INITIATED"));

    expect(result.current.connected).toBe(false);
    expect(result.current.feed(toUrlSafeNoPad(pcmFromBytes([0x10, 0x20])))).toBe(false);
  });
});
