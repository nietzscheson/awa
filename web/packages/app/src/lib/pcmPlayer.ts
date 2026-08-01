import { OUTPUT_SAMPLE_RATE } from "@/lib/livePcm";

/**
 * Sequential PCM16 player over a single AudioContext, with barge-in support.
 *
 * This is the fallback path for the agent's voice: when the LiveAvatar session
 * is up, the avatar plays that audio itself (see `useAvatarLipSync`), and this
 * player stays idle. It takes over whenever there is no avatar — the API key is
 * missing, LiveAvatar is down, or the sandbox session expired — so the interview
 * never goes silent just because the face went away.
 */
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();

  private ensure(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      // Match the model's 24 kHz output so the context doesn't resample.
      try {
        this.ctx = new Ctor({ sampleRate: OUTPUT_SAMPLE_RATE });
      } catch {
        this.ctx = new Ctor();
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /**
   * Create + resume the context. MUST be called from a user gesture (the start
   * click) or the browser autoplay policy leaves it `suspended` and nothing ever
   * plays. Returns the resulting state for diagnostics.
   */
  async unlock(): Promise<AudioContextState> {
    const ctx = this.ensure();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* ignore — will retry on next gesture */
      }
    }
    return ctx.state;
  }

  get state(): AudioContextState | "none" {
    return this.ctx?.state ?? "none";
  }

  /**
   * Seconds of audio still scheduled to play.
   *
   * Used to tell whether the agent has actually finished speaking, which is what
   * the end of the interview waits for before closing the call — without it the
   * goodbye gets cut off mid-word.
   */
  get remainingSeconds(): number {
    if (!this.ctx) return 0;
    return Math.max(0, this.nextTime - this.ctx.currentTime);
  }

  enqueue(pcm: Int16Array, sampleRate = OUTPUT_SAMPLE_RATE) {
    if (pcm.length === 0) return;
    const ctx = this.ensure();
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    // A small lead avoids scheduling into the past (which plays late/overlapped).
    const start = Math.max(ctx.currentTime + 0.02, this.nextTime);
    src.start(start);
    this.nextTime = start + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** Stop everything currently scheduled (barge-in / interruption). */
  stop() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = this.ctx ? this.ctx.currentTime : 0;
  }

  async close() {
    this.stop();
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
  }
}
