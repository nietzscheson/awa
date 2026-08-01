import type { LiveAvatarSession } from "@heygen/liveavatar-web-sdk";

import { pcm16ToBase64 } from "@/lib/livePcm";

/**
 * A LiveAvatarSession that can stream ONE utterance while it is still being
 * generated, instead of only being able to send a finished one.
 *
 * Why this exists. The public `repeatAudio()` sends every audio frame of its
 * argument and then an `agent.speak_end`, so one call is one complete utterance.
 * Driving a live conversation through it forces a choice between two bad
 * options: buffer the whole agent turn and the avatar sits frozen until the last
 * word has been generated, or call it repeatedly and every call boundary becomes
 * an end-of-speech — the avatar stops, resets, and starts again, which is what
 * "the voice sounds chopped up" is.
 *
 * The wire protocol has no such limitation, and the SDK's own chunking is the
 * proof: `repeatAudio` splits its audio into a 400 ms frame followed by 1 s
 * frames, all sharing one `event_id`, and only then sends `speak_end`. Frames are
 * additive; the utterance ends when we say it ends. So we do exactly that, just
 * spread over time: `pushSpeech()` as Gemini produces audio, `endSpeech()` on
 * `turnComplete`. The avatar starts talking ~400 ms in and never hears an
 * end-of-speech mid-sentence.
 *
 * The frame sizes are the SDK's, deliberately:
 *
 *  - 400 ms first, so the mouth starts moving as early as the protocol allows.
 *  - 1 s after that, because by then it is only about keeping the buffer fed.
 *
 * Both are multiples of 3 samples (6 bytes), which is what keeps every frame's
 * base64 unpadded — the SDK slices one padded string at 4-char boundaries, so a
 * server that concatenates frames before decoding gets identical bytes either
 * way. Only the last frame of an utterance may carry padding, exactly as in the
 * SDK's final slice.
 *
 * Extending the class is how the transport becomes reachable: the socket, the
 * event-id generator and the connection check are all `protected` (the SDK ships
 * its own `ElevenLabsAgentSession` subclass on the same members).
 */

/*
 * Frame sizes, in samples, matching what the SDK actually puts on the wire.
 *
 * Read `splitPcm24kStringToChunks` carefully: it slices the *base64 string* at
 * 19200 and 48000 characters while naming those numbers as byte counts. So the
 * frames the server really receives are 19200 chars = 14400 bytes = 7200 samples
 * = 300 ms, then 48000 chars = 36000 bytes = 18000 samples = 750 ms — not the
 * 400 ms / 1 s the comment claims.
 *
 * Sending larger frames than the SDK ever does is not worth the bet: this is the
 * shape the server is known to accept, and both sizes are still multiples of 3
 * samples, so every frame's base64 stays unpadded.
 */

/** 300 ms at 24 kHz — the SDK's first slice, and our reaction time. */
const FIRST_FRAME_SAMPLES = 7200;

/** 750 ms at 24 kHz — every frame after the first. */
const NEXT_FRAME_SAMPLES = 18000;

/**
 * How long a partial frame may wait for more audio before being sent anyway.
 *
 * This is what keeps the end of a sentence from clipping. Gemini emits audio in
 * bursts and then pauses — between sentences, or while a tool runs — so the tail
 * of a phrase is often smaller than a frame. Holding it until the next burst
 * arrives starves the avatar right at the phrase boundary: it plays up to the
 * last full frame, stops, and resumes when the rest finally comes. Flushing the
 * tail after a short idle keeps the pipeline continuously fed.
 */
const IDLE_FLUSH_MS = 120;

/**
 * Frames must be a multiple of this many samples (6 bytes → 8 base64 chars) so
 * their base64 carries no padding. An idle flush therefore leaves at most two
 * samples behind — 83 µs, which is not audible and goes out with the next frame.
 */
const ALIGN_SAMPLES = 3;

type SpeechFrame =
  | { type: "agent.speak"; event_id: string; audio: string }
  | { type: "agent.speak_end"; event_id: string };

/**
 * Build the subclass over the runtime SDK class.
 *
 * A factory rather than a plain `class … extends`: the SDK touches browser
 * globals on import, so it is loaded with a dynamic `import()` and the base class
 * only exists at call time.
 */
export function streamingSpeechSession(Base: typeof LiveAvatarSession) {
  return class StreamingSpeechSession extends Base {
    /** Audio accepted but not yet big enough to be worth a frame. */
    private pending: Int16Array[] = [];
    private pendingSamples = 0;
    /** The utterance in progress; null between turns. */
    private utteranceId: string | null = null;
    private framesSent = 0;
    /** Pending timer for the tail of a burst; see `IDLE_FLUSH_MS`. */
    private idleFlush: ReturnType<typeof setTimeout> | null = null;

    /**
     * Add audio to the current utterance, opening one if this is the first chunk
     * of a turn. Whole frames go out as soon as they are complete, and whatever
     * is left over follows shortly after the burst ends rather than waiting for
     * the next one.
     */
    pushSpeech(pcm: Int16Array): void {
      if (pcm.length === 0) return;
      this.pending.push(pcm);
      this.pendingSamples += pcm.length;

      // The first frame of a turn is the short one; everything after is longer.
      let frame = this.framesSent === 0 ? FIRST_FRAME_SAMPLES : NEXT_FRAME_SAMPLES;
      while (this.pendingSamples >= frame) {
        this.sendFrame(this.take(frame));
        frame = NEXT_FRAME_SAMPLES;
      }

      this.armIdleFlush();
    }

    /** End of the agent's turn: flush the tail and close the utterance. */
    endSpeech(): void {
      this.cancelIdleFlush();
      if (this.pendingSamples > 0) this.sendFrame(this.take(this.pendingSamples));
      const id = this.utteranceId;
      this.utteranceId = null;
      this.framesSent = 0;
      if (id) this.send({ type: "agent.speak_end", event_id: id });
    }

    /** Send the tail of a burst once the audio stops arriving. */
    private armIdleFlush(): void {
      this.cancelIdleFlush();
      if (this.pendingSamples < ALIGN_SAMPLES) return;
      this.idleFlush = setTimeout(() => {
        this.idleFlush = null;
        const aligned = this.pendingSamples - (this.pendingSamples % ALIGN_SAMPLES);
        if (aligned < ALIGN_SAMPLES) return;
        try {
          this.sendFrame(this.take(aligned));
        } catch (cause) {
          // Nobody is waiting on this timer, so a dropped session cannot be
          // reported upwards — the next `pushSpeech` will fail loudly instead.
          console.error("[avatar] could not flush the tail of a phrase", cause);
        }
      }, IDLE_FLUSH_MS);
    }

    private cancelIdleFlush(): void {
      if (this.idleFlush === null) return;
      clearTimeout(this.idleFlush);
      this.idleFlush = null;
    }

    /**
     * Barge-in: drop what hasn't been sent and cut the avatar off mid-word.
     *
     * The utterance is abandoned without a `speak_end` — it is not finished, it
     * is cancelled, and `agent.interrupt` is what says so.
     */
    interruptSpeech(): void {
      this.cancelIdleFlush();
      this.pending = [];
      this.pendingSamples = 0;
      this.utteranceId = null;
      this.framesSent = 0;
      this.interrupt();
    }

    /** Pull exactly `samples` from the head of the pending queue. */
    private take(samples: number): Int16Array {
      const out = new Int16Array(samples);
      let offset = 0;
      while (offset < samples) {
        const head = this.pending[0];
        const room = samples - offset;
        if (head.length <= room) {
          out.set(head, offset);
          offset += head.length;
          this.pending.shift();
        } else {
          out.set(head.subarray(0, room), offset);
          this.pending[0] = head.subarray(room);
          offset += room;
        }
      }
      this.pendingSamples -= samples;
      return out;
    }

    private sendFrame(pcm: Int16Array): void {
      this.utteranceId ??= this.generateEventId();
      this.send({
        type: "agent.speak",
        event_id: this.utteranceId,
        audio: pcm16ToBase64(pcm),
      });
      this.framesSent += 1;
    }

    private send(frame: SpeechFrame): void {
      const socket = this._sessionEventSocket;
      if (!this.assertConnected() || !socket || socket.readyState !== WebSocket.OPEN) {
        // Same contract as `repeatAudio`: LITE speech needs the event socket, and
        // the caller (the hook) treats a throw as "play this audio yourself".
        throw new Error("LiveAvatar session is not connected; cannot send speech");
      }
      socket.send(JSON.stringify(frame));
    }
  };
}

/** The session type the app actually holds. */
export type SpeechSession = InstanceType<ReturnType<typeof streamingSpeechSession>>;
