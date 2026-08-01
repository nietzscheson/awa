/**
 * PCM helpers for the ADK live (Gemini Live) WebSocket.
 *
 * - Model output audio is 16-bit signed PCM, mono, 24 kHz (`audio/pcm;rate=24000`).
 * - Model input audio must be 16-bit signed PCM, mono, 16 kHz (`audio/pcm;rate=16000`).
 *
 * The ADK `LiveRequest`/`Event` JSON encodes `bytes` fields as base64.
 */

export const OUTPUT_SAMPLE_RATE = 24000;
export const INPUT_SAMPLE_RATE = 16000;

/**
 * base64 → Int16Array (little-endian PCM16).
 *
 * The Gemini Live API (via google-genai) serialises audio bytes as
 * **URL-safe base64 without padding** (`-`/`_`, no `=`). Browser `atob()` only
 * accepts standard base64 (`+`/`/` with padding), so we normalise first —
 * otherwise `atob()` throws / yields garbage and nothing plays.
 */
export function base64ToPcm16(b64: string): Int16Array {
  let s = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  // PCM16 is little-endian; reinterpret the byte buffer as Int16.
  return new Int16Array(bytes.buffer, 0, len >> 1);
}

/** Int16 PCM → base64 string. */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Float32 [-1,1] mic samples → Int16 PCM, downsampled from `fromRate` to `toRate`. */
export function floatToPcm16(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // Average the source window into one output sample (cheap anti-alias).
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      n++;
    }
    const s = n > 0 ? sum / n : input[start] || 0;
    const clamped = Math.max(-1, Math.min(1, s));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}
