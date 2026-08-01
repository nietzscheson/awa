# RUN_LIVE.md — Integrating with `/run_live` (implementer's summary)

A short guide for anyone **writing a client** against ADK's Live API: create the
session, keep it, **push audio in** and **get the agent's audio out**.

The full detail is in **[STREAMING.md](./STREAMING.md)**; this is the minimum you
need to write the code.

---

## The essentials in 5 lines

1. You create the session over **HTTP** (once).
2. You open a **WebSocket** to `/run_live` with those same ids.
3. Over that socket you send **JSON**, one object per message. Audio goes in
   base64 inside a `blob` field.
4. Over that same socket you receive **JSON**. The agent's audio arrives in base64
   inside `content.parts[].inlineData`.
5. **In at 16 kHz, out at 24 kHz.** That is not a typo.

There is no HTTP audio-streaming endpoint. All audio, in both directions, goes
over that single WebSocket.

---

## Step 1 — Create the session (mandatory)

```http
POST http://localhost:8000/apps/streaming/users/{userId}/sessions/{sessionId}
Content-Type: application/json

{ "first_name": "Ada", "last_name": "Lovelace", "ine_address": "…", "language": "en-US" }
```

- `streaming` is the **`app_name`** (the agent's folder under `core/src/agents/`).
- `userId` and `sessionId` are **yours to invent** (free strings; use UUIDs).
- **The whole body IS the session's initial state.** Do not wrap it in
  `{"state": {...}}`. The agent reads these keys to build its questions, and
  `language` decides which language the interview is conducted in.
- If the session already exists you get **400/409** → treat it as success and
  carry on.

⚠️ **Skip this step and the WebSocket closes with code `1002` "Session not
found".** `/run_live` does not create sessions.

### What "keeping the session" means

The session lives in **Postgres**, not in the WebSocket. Which means:

- If the socket drops, **you lose no progress**: reopen it with the same
  `userId` + `sessionId` and the conversation continues where it was.
- You do **not** need to `POST` again when reconnecting (it would return 400/409,
  harmless).
- A new `sessionId` = a conversation from scratch.

---

## Step 2 — Open the WebSocket

```
ws://localhost:8000/run_live?app_name=streaming&user_id={userId}&session_id={sessionId}&modalities=AUDIO
```

The three ids **must be identical** to the ones in the `POST` above.

Useful optional params: `explicit_vad_signal=true` (you mark where each turn
starts and ends, instead of letting Gemini detect the silence),
`enable_session_resumption=true`, `save_live_blob=true`.

As soon as `onopen` fires you can send audio. **There is no prior handshake.**

**Close codes:** `1000` normal · `1002` no such session · `1008` missing
`app_name` or blocked `Origin` · `1011` internal error (the `reason` carries the
message).

---

## Step 3 — Pushing audio in (client → agent)

One text message per frame, with this JSON:

```json
{ "blob": { "mimeType": "audio/pcm;rate=16000", "data": "<base64>" } }
```

### The input audio format — exactly

| | |
|---|---|
| Codec | Linear PCM, **no container** (no WAV, MP3 or Opus) |
| Bits | 16-bit **signed** |
| Endianness | **little-endian** |
| Channels | **1 (mono)** |
| Sample rate | **16 000 Hz** |
| `data` field encoding | **standard** base64 |

If your source is not that, **you resample before sending**. The API does not
convert.

### Cadence

Send chunks of **~80–100 ms** as you capture them. Do not accumulate more than
~200 ms or you add audible latency.

For reference: 100 ms of audio = 1600 samples = 3200 bytes ≈ 4.3 KB of base64.

### Example (browser)

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
});

const ctx = new AudioContext();                      // careful: usually 48 kHz, NOT 16 k
const source = ctx.createMediaStreamSource(stream);
const node = ctx.createScriptProcessor(4096, 1, 1);  // ~85 ms per callback @48 kHz

node.onaudioprocess = (e) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const input = e.inputBuffer.getChannelData(0);              // Float32Array [-1,1]
  const pcm = floatToPcm16(input, ctx.sampleRate, 16000);     // downsample + Int16
  ws.send(JSON.stringify({
    blob: { mimeType: "audio/pcm;rate=16000", data: pcm16ToBase64(pcm) },
  }));
};

source.connect(node);

// A ScriptProcessor only fires while connected to the destination, but we do not
// want to hear our own microphone → sink at zero gain.
const sink = ctx.createGain();
sink.gain.value = 0;
node.connect(sink);
sink.connect(ctx.destination);
```

`floatToPcm16` and `pcm16ToBase64` are already written in
`web/packages/app/src/lib/livePcm.ts` — copy them, don't rewrite them.

**Traps in this part:**

- `echoCancellation: true` is not optional. Without it the agent's audio comes out
  of the speakers, back in through the mic, and the agent interrupts itself.
- The `AudioContext` almost never runs at 16 kHz. **Always** pass the real
  `ctx.sampleRate` to the downsampler; never assume 48 000.
- Float32 → Int16 scaling is asymmetric: `s < 0 ? s * 0x8000 : s * 0x7fff`.

### Other messages you can send

```json
{ "content": { "role": "user", "parts": [{ "text": "hello" }] } }  // text turn
{ "activityStart": {} }   /   { "activityEnd": {} }                // only with explicit_vad_signal
{ "close": true }                                                  // end the session
```

A live model says nothing until it has input, so a text turn is also how you get
the agent to **speak first**: this app sends a bracketed cue
(`[interview_start] …`) on connect, and the agent's instruction tells it to greet
the candidate and never read a bracketed cue aloud.

Keep sending audio **even while the agent is talking** — that is how barge-in
(interrupting it by speaking over it) works.

---

## Step 4 — Receiving the agent's audio (agent → client)

Every socket message is JSON. The one carrying voice looks like this:

```json
{
  "id": "ev_9f2c1a",
  "author": "streaming_agent",
  "partial": true,
  "content": {
    "role": "model",
    "parts": [
      {
        "inlineData": {
          "mimeType": "audio/pcm;rate=24000",
          "data": "AAD__wEA_v8CAP3_…"
        }
      }
    ]
  }
}
```

### The output audio format — exactly

| | |
|---|---|
| Codec | Linear PCM, no container |
| Bits | 16-bit signed |
| Endianness | little-endian |
| Channels | 1 (mono) |
| Sample rate | **24 000 Hz** ← different from the input |
| `data` field encoding | **URL-safe base64, NO padding** |

### 🚨 The base64 trap

The outgoing audio uses the **URL-safe** alphabet (`-` and `_` instead of `+` and
`/`) and **no `=` padding**. Most standard base64 decoders — including the
browser's `atob()` — **fail or return garbage**.

Always normalize before decoding:

```ts
// JS
let s = b64.replace(/-/g, "+").replace(/_/g, "/");
const pad = s.length % 4;
if (pad) s += "=".repeat(4 - pad);
const bytes = Uint8Array.from(atob(s), c => c.charCodeAt(0));
const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);  // native LE
```

```python
# Python
base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
```

```csharp
// .NET
Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/').PadRight((s.Length + 3) / 4 * 4, '='));
```

**If it sounds like static, or silent, this is the first suspect.**

### Playback

The audio arrives in many small chunks. Chain them: don't play each one "now",
schedule them one after another.

```ts
const ctx = new AudioContext({ sampleRate: 24000 });  // matching avoids resampling
let nextTime = 0;

function enqueue(pcm: Int16Array) {
  const buf = ctx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;  // Int16 → Float32

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const start = Math.max(ctx.currentTime + 0.02, nextTime);  // 20 ms lead
  src.start(start);
  nextTime = start + buf.duration;
  sources.add(src);
  src.onended = () => sources.delete(src);
}
```

**Traps in this part:**

- The `AudioContext` must be created and `resume()`d **inside the user's click**,
  before any `await`. Otherwise the autoplay policy leaves it `suspended` and
  nothing plays — with no visible error.
- The 20 ms lead avoids scheduling into the past, which plays late or overlapped.
- Keep the live `AudioBufferSourceNode`s in a `Set`: you will need them to cut
  playback on barge-in.

### The flags you must handle

| Field | What to do |
|---|---|
| `interrupted: true` | **Barge-in.** Cut playback NOW: `stop()` every live source and set `nextTime = ctx.currentTime`. Otherwise the agent keeps talking over the user. |
| `turnComplete: true` | The agent finished its turn. Reset UI state. |
| `partial: true` | An intermediate chunk. Normal, not a special case. |
| `errorCode` / `errorMessage` | Model error. Show it / log it. |
| `goAway` | The server is about to close. Reconnect (same `sessionId`). |

### Other things that arrive on the same socket

Because the agent uses tools, you will see messages **with no audio**:

- `content.parts[].functionCall` → `{name: "submit_answer", args: {...}}`
- `content.parts[].functionResponse` → `{name, response: {...}}`

That is the interview's logic advancing. Useful for logs and for syncing your UI
with the current step. **Ignore them if you only care about the audio** — with one
exception: `confirm_interview` returning `status: "confirmed"` means the candidate
approved their answers, and it is your cue to stop the microphone and hang up once
the goodbye has finished playing.

⚠️ Text parts flagged **`"thought": true`** may also arrive: that is the model's
internal reasoning. **Filter them.** Treat them as dialogue and you will show the
user the agent thinking about them. This app configures the planner with
`include_thoughts=False`, so they should not appear — the filter is there so a
flipped flag cannot leak reasoning into the transcript.

---

## Subtitles

`outputTranscription` (what the agent says) and `inputTranscription` (what the
user said) are the obvious way to caption the call, and in this ADK version they
**are enabled by default**: `RunConfig` defaults both
`output_audio_transcription` and `input_audio_transcription` to
`AudioTranscriptionConfig()`, so the model is asked for transcripts even though
`/run_live` exposes no query parameter for them.

Both arrive as deltas, with `finished: true` on the frame carrying the final
aggregate — which also makes `inputTranscription.finished` the cleanest signal
that the user's turn is over. It is still worth confirming at runtime before you
build a feature on top of it: a future ADK or model change is a server-side
change, not a client one.

---

## Implementation checklist

- [ ] `POST` the session before opening the socket, accepting 400/409
- [ ] `app_name` / `user_id` / `session_id` identical over HTTP and WS
- [ ] Reconnect reusing the same `sessionId` (don't recreate the session)
- [ ] Input audio: PCM16 LE mono **16 kHz**, standard base64
- [ ] Resample from the device's real rate, not an assumed one
- [ ] Chunks of ~80–100 ms
- [ ] `echoCancellation` enabled on the microphone
- [ ] Decode the outgoing base64 as **URL-safe, unpadded**
- [ ] Play at **24 kHz**, chaining buffers rather than one at a time
- [ ] `AudioContext` unlocked inside a user gesture
- [ ] `interrupted` → cut playback immediately
- [ ] Filter parts with `thought: true`
- [ ] `confirm_interview` confirmed → mic off, let the goodbye finish, then close
- [ ] `{"close": true}` before closing the socket

---

## Final table

| | Client → Agent | Agent → Client |
|---|---|---|
| Where | `blob.data` | `content.parts[].inlineData.data` |
| mimeType | `audio/pcm;rate=16000` | `audio/pcm;rate=24000` |
| Format | PCM16 LE mono | PCM16 LE mono |
| Sample rate | **16 000 Hz** | **24 000 Hz** |
| Base64 | standard | **URL-safe, unpadded** |
| Field naming | snake or camelCase | **camelCase** |

## Quick reference

```
POST http://localhost:8000/apps/streaming/users/{userId}/sessions/{sessionId}
     body: { "first_name": "...", "last_name": "...", "ine_address": "...", "language": "en-US" }

ws://localhost:8000/run_live?app_name=streaming&user_id={userId}&session_id={sessionId}&modalities=AUDIO

→ {"blob":{"mimeType":"audio/pcm;rate=16000","data":"<standard b64>"}}
→ {"content":{"role":"user","parts":[{"text":"hello"}]}}
→ {"close":true}

← event.content.parts[].inlineData  → {mimeType:"audio/pcm;rate=24000", data:"<url-safe b64>"}
← event.interrupted / turnComplete / partial / errorMessage
```

Code already written that you can copy, all under `web/packages/app/src/`:
`components/StreamingAgentClient.tsx` (the whole protocol),
`lib/livePcm.ts` (PCM/base64 helpers),
`lib/pcmPlayer.ts` (chained playback),
`lib/avatarSpeech.ts` (feeding a talking head one utterance per turn).
