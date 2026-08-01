import {
  base64ToPcm16,
  floatToPcm16,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  pcm16ToBase64,
} from "@/lib/livePcm";

/** Bytes → binary string → standard base64 (browser-style, via btoa). */
function bytesToStdBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Standard base64 → URL-safe, padding stripped (how google-genai emits audio). */
function toUrlSafeNoPad(std: string): string {
  return std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

describe("livePcm constants", () => {
  it("uses 24kHz output and 16kHz input", () => {
    expect(OUTPUT_SAMPLE_RATE).toBe(24000);
    expect(INPUT_SAMPLE_RATE).toBe(16000);
  });
});

describe("base64ToPcm16", () => {
  it("decodes standard, padded base64", () => {
    const bytes = new Uint8Array([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80]); // 1, 32767, -32768
    const pcm = base64ToPcm16(bytesToStdBase64(bytes));
    expect(Array.from(pcm)).toEqual([1, 32767, -32768]);
  });

  it("decodes URL-safe base64 WITHOUT padding (the Gemini Live format)", () => {
    // Bytes chosen so standard base64 contains both '+' and '/'.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x10, 0x20, 0x30, 0x40]);
    const std = bytesToStdBase64(bytes);
    const urlSafe = toUrlSafeNoPad(std);

    // Sanity: the URL-safe form really exercises the '-'/'_' branch.
    expect(urlSafe).toMatch(/[-_]/);
    expect(urlSafe).not.toContain("=");

    const pcm = base64ToPcm16(urlSafe);
    expect(pcm16ToBytes(pcm)).toEqual(bytes);
  });

  it("matches what raw atob() canNOT do (regression guard)", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x55]);
    const urlSafe = toUrlSafeNoPad(bytesToStdBase64(bytes));
    // Raw atob on the URL-safe string throws — proving the normalisation matters.
    expect(() => atob(urlSafe)).toThrow();
    expect(pcm16ToBytes(base64ToPcm16(urlSafe))).toEqual(bytes);
  });

  it("drops a trailing odd byte rather than misaligning samples", () => {
    // 3 bytes → 1 whole Int16 sample (last byte ignored).
    const bytes = new Uint8Array([0x34, 0x12, 0xff]);
    const pcm = base64ToPcm16(bytesToStdBase64(bytes));
    expect(pcm.length).toBe(1);
    expect(pcm[0]).toBe(0x1234);
  });
});

describe("pcm16ToBase64", () => {
  it("round-trips through base64ToPcm16", () => {
    const original = new Int16Array([0, 1, -1, 32767, -32768, 12345, -6789]);
    const b64 = pcm16ToBase64(original);
    const back = base64ToPcm16(b64);
    expect(Array.from(back)).toEqual(Array.from(original));
  });

  it("emits standard base64 that the browser atob() accepts directly", () => {
    const b64 = pcm16ToBase64(new Int16Array([1000, -1000, 2000]));
    expect(() => atob(b64)).not.toThrow();
    expect(b64).not.toMatch(/[-_]/);
  });

  it("handles a large buffer without blowing the call stack", () => {
    const big = new Int16Array(200_000).fill(1234);
    const back = base64ToPcm16(pcm16ToBase64(big));
    expect(back.length).toBe(big.length);
    expect(back[0]).toBe(1234);
    expect(back[big.length - 1]).toBe(1234);
  });
});

describe("floatToPcm16", () => {
  it("scales [-1, 1] to full Int16 range", () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 0.5]), 16000, 16000);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767); // +1 → 0x7fff
    expect(out[2]).toBe(-32768); // -1 → -0x8000
    // Int16Array assignment truncates toward zero (16383.5 → 16383).
    expect(out[3]).toBe(Math.trunc(0.5 * 0x7fff));
  });

  it("clamps values outside [-1, 1]", () => {
    const out = floatToPcm16(new Float32Array([2, -2]), 16000, 16000);
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it("downsamples 48kHz → 16kHz by averaging windows of 3", () => {
    // ratio = 3 → outLen = 2; window 0 = avg(0,0,0)=0, window 1 = avg(1,1,1)≈1.
    const input = new Float32Array([0, 0, 0, 1, 1, 1]);
    const out = floatToPcm16(input, 48000, 16000);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767);
  });

  it("keeps length when source and target rates match", () => {
    const out = floatToPcm16(new Float32Array(100).fill(0.25), 16000, 16000);
    expect(out.length).toBe(100);
    expect(out[0]).toBe(Math.trunc(0.25 * 0x7fff));
  });
});
