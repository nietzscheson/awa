# STREAMING.md — the `streaming` agent's flow over `/run_live`

Reference for the **full bidirectional audio flow** of the `streaming` agent:
session creation, pushing audio from the browser, and the exact shape of the Live
API's response.

> **Relation to [DOC.md](./DOC.md):** DOC.md describes the same transport written
> for a team putting a backend of their own in the middle. This file is the
> **browser client's** view, with the Web Audio graph, the complete `Event` object
> and the implementation details. Integrating from a server → read DOC.md; from the
> browser → read this.

> **Source of truth:** `core/src/main.py`, `core/src/container.py`
> (`streaming_agent`), `core/src/services.py` (`InterviewService`),
> `core/.venv/.../google/adk/cli/api_server.py` (`run_agent_live`),
> `core/.venv/.../google/adk/agents/live_request_queue.py`,
> `core/.venv/.../google/adk/events/event.py`, and the client under
> `web/packages/app/src/` (`components/StreamingAgentClient.tsx`, `lib/livePcm.ts`).

---

## 0. Topology

```
browser                  Next.js (proxy)              ADK api_server            Gemini Live API
   │                          │                            │                         │
   │  POST /adk/apps/.../sessions/{id}                      │                         │
   ├─────────────────────────►│──── POST :8000 ───────────►│  DatabaseSessionService │
   │                          │                            │  → Postgres             │
   │  WS  /adk/run_live?…     │                            │                         │
   ├═════════════════════════►│═══ WS :8000/run_live ═════►│═══ live connect ═══════►│
   │   {blob: pcm16 16k}      │                            │  LiveRequestQueue       │
   │ ◄═══════════════════════ │ ◄═══════════════════════   │ ◄══ Event(audio 24k) ═══│
```

The server is **not** hand-written FastAPI: `core/src/main.py` calls
`get_fast_api_app(agents_dir="src/agents", session_service_uri=DATABASE_URL, web=True, reload_agents=True)`,
so **every endpoint is defined by ADK**.

The `app_name` is the name of the folder under `core/src/agents/` containing
`agent.py` → **`streaming`** (`core/src/agents/streaming/agent.py` exports
`root_agent`).

Startup:

```bash
task api                 # or, from core/
uv run uvicorn src.main:app --port 8000 --reload
```

The browser never talks to `:8000` directly: it goes through the
`/adk/:path*` → `ADK_API_ORIGIN` rewrite (default `http://localhost:8000`), which
also proxies the **WebSocket upgrade**. That is why the ADK server needs no
`--allow_origins` (its `_OriginCheckMiddleware` accepts requests without an
`Origin` header, and a server-side proxy sends none).

### Agent configuration

From `core/src/container.py` and `core/src/settings.py`:

| | |
|---|---|
| model | `GEMINI_STREAMING_MODEL_NAME` — default `gemini-3.1-flash-live-preview` |
| voice | `types.PrebuiltVoiceConfig(voice_name=GEMINI_VOICE_NAME)` — default `Aoede` |
| language | session state key `language`, falling back to `GEMINI_LANGUAGE_CODE` (default `en-US`). `SpeechConfig.language_code` is deliberately unset — see below |
| planner | `BuiltInPlanner(thinking_level=GEMINI_THINKING_LEVEL, include_thoughts=False)` — default level `MINIMAL` |
| tools | the nine `InterviewService` tools |
| hook | `before_agent_callback` → seeds the interview state |

Two of those are load-bearing for a live conversation:

- **`thinking_level=MINIMAL`.** The model emits no audio while it thinks, so every
  level above minimal is silence the candidate sits through.
- **`include_thoughts=False`.** Thought summaries arrive as ordinary text parts, on
  the same channel the transcript is built from — with them on, the model's
  reasoning about the candidate ends up in front of the candidate.

And `SpeechConfig.language_code` is left unset on purpose: it belongs to the
process-wide model instance, and `run_agent_live` builds its own `RunConfig` with
no way to override it per session. Pinning it would contradict the per-session
language, so the language reaches the model through the instruction instead, which
**is** per session (an ADK instruction provider, resolved per invocation).

---

## 1. Creating the session

**Mandatory before opening the WebSocket.** `run_agent_live` calls
`get_session(...)`; if it does not exist, it closes the socket with
`1002 "Session not found"`. `/run_live` does **not** create sessions.

### Request

```http
POST /adk/apps/streaming/users/{user_id}/sessions/{session_id}
Content-Type: application/json

{
  "first_name": "Ada",
  "last_name": "Lovelace",
  "ine_address": "Monte Leon de Piedad 237. Ciudad de México",
  "language": "en-US"
}
```

**The whole body IS the session's `state` dict.** In `create_session_with_id` the
parameter is called `state` and FastAPI takes it as the entire body — there is no
`{"state": {...}}` wrapper on this route.

`user_id` and `session_id` are the client's choice. The web client generates
`u_<uuid8>` persisted in `localStorage` and a fresh `s_<uuid8>` per session.

### The non-deprecated variant

The route above is marked `@deprecated` in ADK. The current one is:

```http
POST /adk/apps/streaming/users/{user_id}/sessions
{ "session_id": "s_abc", "state": { "first_name": "..." }, "events": [] }
```

Here there *is* a wrapper: `CreateSessionRequest` with `session_id`, `state` and
`events`.

### What that state is for

`InterviewService._render_question` fills the questions' placeholders from those
keys:

- `confirm_name` → `"To start, can you confirm your name is {full_name}?"`, built
  from `first_name` + `last_name`
- `confirm_address` → `"And is your registered address {ine_address}?"`

If they are missing there are fallbacks (`"your name"`, `"your registered
address"`), and `contextlib.suppress(KeyError, IndexError, ValueError)` leaves the
raw text alone on an unknown placeholder — it does not blow up.

`language` is read by the instruction provider, so the same agent conducts the
interview in the language this session chose.

When the run starts, `before_agent_callback` adds, **idempotently**:

```json
{
  "interview_initialized": true,
  "interview_started": false,
  "current_question_index": 0,
  "total_answered": 0,
  "answers": {},
  "interview_confirmed": false
}
```

All of it persists in Postgres through `DatabaseSessionService`, so **the session
survives WebSocket reconnections**: reopening the socket with the same
`session_id` continues the interview where it was.

### Client-side error handling

The client accepts `res.ok || status === 400 || status === 409` — "already exists"
is not a failure. Necessary if you reconnect against a previous session.

---

## 2. Opening the WebSocket

```
ws://localhost:5173/adk/run_live
  ?app_name=streaming
  &user_id=u_abc
  &session_id=s_xyz
  &modalities=AUDIO
```

`{user_id, session_id, app_name}` must be **identical** to the ones used when
creating the session.

Supported parameters:

| Param | Default | Notes |
|---|---|---|
| `user_id` | — | **required**; without it FastAPI answers 422 |
| `session_id` | — | **required** |
| `app_name` | `ADK_DEFAULT_APP_NAME` | if neither is set → close `1008` |
| `modalities` | `["AUDIO"]` | **only `TEXT` \| `AUDIO`**; repeatable (`&modalities=TEXT&modalities=AUDIO`) |
| `proactive_audio` | `None` | → `types.ProactivityConfig` |
| `enable_affective_dialog` | `None` | bool |
| `enable_session_resumption` | `None` | → `SessionResumptionConfig(transparent=…)` |
| `save_live_blob` | `false` | stores audio blobs in the session history |
| `explicit_vad_signal` | `None` | `true` = you delimit the turns |

The server builds the `RunConfig` **per connection** and launches two concurrent
tasks — `forward_events()` (model → ws) and `process_messages()`
(ws → `LiveRequestQueue`) — with `FIRST_EXCEPTION`, so if one fails the other is
cancelled.

### Close codes

| Code | Cause |
|---|---|
| `1000` | clean close |
| `1002` | no such session |
| `1008` | missing `app_name`, or `Origin` not allowed |
| `1011` | internal exception (the `reason` carries the first 123 chars of the error) |

---

## 3. Pushing audio from the browser

### 3.1 The contract

Every client message is **one text frame** whose JSON validates against
`LiveRequest`. If you set several fields at once the priority is
`activity_start > activity_end > blob > content`; `state_delta` is always applied.

**Realtime audio:**

```json
{ "blob": { "mimeType": "audio/pcm;rate=16000", "data": "<base64>" } }
```

**Required format: linear PCM, 16-bit signed, little-endian, mono, 16 000 Hz.** No
WAV header, no container. Standard base64 (`btoa`).

Other frames:

```json
{ "content": { "role": "user", "parts": [{ "text": "hello" }] } }  // text turn
{ "activityStart": {} }                                            // manual VAD: start
{ "activityEnd": {} }                                              // manual VAD: end
{ "stateDelta": { "key": "value" } }                               // mutates the session state
{ "close": true }                                                  // closes the queue
```

> `LiveRequest` declares `populate_by_name`, so both `activity_start` and
> `activityStart` validate.

A text turn is also how the agent is made to **speak first**. A live model
produces nothing until it has input, so on `onopen` the client sends one bracketed
cue — `[interview_start] The candidate has just joined…` — and the agent's
instruction says bracketed cues come from the app, are acted on, and are never read
aloud. It is not added to the transcript either: nobody said it.

### 3.2 The full chain in the browser

Four steps, all in `StreamingAgentClient.tsx` (`startMic`):

**a) Capture the microphone**

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
});
```

`echoCancellation` matters: without it the agent's audio leaves the speakers,
comes back in through the mic, and the model interrupts itself.

**b) Get Float32 out of the Web Audio graph**

```ts
const ctx = new AudioContext();                       // typically 48 kHz, NOT 16 k
const source = ctx.createMediaStreamSource(stream);
const node = ctx.createScriptProcessor(4096, 1, 1);   // ~85 ms per callback @48k
node.onaudioprocess = (e) => {
  const input = e.inputBuffer.getChannelData(0);      // Float32Array [-1, 1]
  /* … */
};
source.connect(node);

// Sink at zero gain: a ScriptProcessor only fires while connected to the
// destination, but we do not want to hear our own microphone.
const sink = ctx.createGain();
sink.gain.value = 0;
node.connect(sink);
sink.connect(ctx.destination);
```

**c) Float32 → PCM16 at 16 kHz** (`lib/livePcm.ts`)

```ts
const pcm = floatToPcm16(input, ctx.sampleRate, INPUT_SAMPLE_RATE); // 16000
```

The downsample averages the source window into one output sample (cheap
anti-aliasing); it is not a polyphase resampler. The integer scaling is asymmetric,
and correct: `s < 0 ? s * 0x8000 : s * 0x7fff`.

**d) PCM16 → base64 → `ws.send`** (`lib/livePcm.ts`)

```ts
ws.send(JSON.stringify({
  blob: {
    mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
    data: pcm16ToBase64(pcm),
  },
}));
```

`pcm16ToBase64` chunks in blocks of `0x8000` samples before
`String.fromCharCode(...)`, or the spread would blow the stack on large arrays.

### 3.3 Details that matter

- **No prior handshake.** As soon as `onopen` fires you can send blobs; ADK has
  already opened the connection to the model.
- **Cadence:** one frame per `ScriptProcessor` callback. With 4096 frames at
  48 kHz that is ~85 ms of audio per message (≈1365 samples at 16 kHz ≈ 2730 bytes
  ≈ 3.6 KB of base64). A good latency balance; don't accumulate beyond ~200 ms.
- **Automatic VAD by default:** Gemini detects when you stopped talking. Only if
  you open with `explicit_vad_signal=true` must you wrap each turn in
  `activityStart` / `activityEnd`.
- **Barge-in:** keep sending blobs while the agent talks; the model will emit
  `interrupted: true` and you must drop the audio you have already queued locally.
  This client does not wait for that round trip — the first partial
  `inputTranscription` is enough to cut the agent off, because by then the user is
  already speaking.
- **`ScriptProcessorNode` is deprecated.** It works in every browser today, but it
  runs on the main thread; `AudioWorklet` is the replacement if glitches show up
  under load.

---

## 4. How the Live API responds

### 4.1 Serialization

Every frame received is an ADK `Event`:

```python
await websocket.send_text(event.model_dump_json(exclude_none=True, by_alias=True))
```

Two direct consequences:

- **`by_alias=True` → camelCase.** `inline_data` arrives as `inlineData`,
  `turn_complete` as `turnComplete`, `output_transcription` as
  `outputTranscription`.
- **`exclude_none=True` → `None` fields are absent.** Everything is optional except
  the ones with a non-null default: `id`, `timestamp`, `author`, `invocationId`,
  `actions` and `nodeInfo` always come.

### 4.2 The `Event` object

`Event` inherits from `LlmResponse` (`events/event.py`, `models/llm_response.py`).

**`Event`'s own fields:**

| Field | Type | What for |
|---|---|---|
| `id` | `str` | unique event id |
| `timestamp` | `float` | epoch seconds |
| `invocationId` | `str` | groups every event of one turn |
| `author` | `str` | `"user"` or `"streaming_agent"` |
| `actions` | `EventActions` | `stateDelta`, `artifactDelta`, `transferToAgent`, `escalate`… |
| `branch` | `str?` | sub-agent hierarchy |
| `longRunningToolIds` | `set[str]?` | ids of long-running function calls |
| `nodeInfo` | `NodeInfo` | workflow metadata (empty for this agent) |
| `output` | `Any?` | generic workflow-node output |

**Inherited from `LlmResponse`:**

| Field | Type | What for |
|---|---|---|
| `content` | `types.Content` | **the payload**: `role` + `parts[]` |
| `partial` | `bool?` | intermediate chunk of a turn |
| `turnComplete` | `bool?` | the model finished its turn |
| `turnCompleteReason` | enum? | why it finished |
| `interrupted` | `bool?` | **barge-in** — the user spoke over it |
| `errorCode` / `errorMessage` | `str?` | model error |
| `inputTranscription` | `Transcription?` | `{text, finished}` of what the user said |
| `outputTranscription` | `Transcription?` | `{text, finished}` of what the agent is saying |
| `voiceActivity` | `VoiceActivity?` | VAD signals |
| `usageMetadata` | | token counts |
| `liveSessionId` | `str?` | the model's live session id |
| `goAway` | `LiveServerGoAway?` | the server is about to close → reconnect |
| `liveSessionResumptionUpdate` | | resumption handle |
| `finishReason` / `groundingMetadata` / `cacheMetadata` / `customMetadata` | | |

### 4.3 The audio

It arrives inside `content.parts[].inlineData`:

```json
{
  "id": "ev_9f2c1a",
  "timestamp": 1785432101.882,
  "invocationId": "e-4d2b…",
  "author": "streaming_agent",
  "actions": {},
  "nodeInfo": { "path": "" },
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

**Output format: linear PCM, 16-bit signed, little-endian, mono, 24 000 Hz.** Mind
the asymmetry: **in at 16 kHz, out at 24 kHz.**

> ⚠️ **The outgoing base64 is URL-safe and unpadded.** google-genai serializes the
> bytes with `-` and `_` and no `=`; the browser's `atob()` only accepts standard
> base64. That is why `base64ToPcm16` normalizes before decoding
> (`lib/livePcm.ts`):
>
> ```ts
> let s = b64.replace(/-/g, "+").replace(/_/g, "/");
> const pad = s.length % 4;
> if (pad) s += "=".repeat(4 - pad);
> const bin = atob(s);
> // …then reinterpret the Uint8Array as an Int16Array (native LE on x86/ARM)
> return new Int16Array(bytes.buffer, 0, len >> 1);
> ```
>
> From Python: `base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))`.
> From .NET: `-`→`+`, `_`→`/`, re-pad to a multiple of 4, `Convert.FromBase64String`.

### 4.4 Playback

`PcmPlayer.enqueue` — the pattern is scheduling **consecutive** buffers on a single
`AudioContext`:

```ts
const ctx = new AudioContext({ sampleRate: 24000 });  // matching the rate avoids resampling
const buf = ctx.createBuffer(1, pcm.length, 24000);
const ch = buf.getChannelData(0);
for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;   // Int16 → Float32

const src = ctx.createBufferSource();
src.buffer = buf;
src.connect(ctx.destination);
const start = Math.max(ctx.currentTime + 0.02, this.nextTime);  // 20 ms lead
src.start(start);
this.nextTime = start + buf.duration;                            // chain
```

The 20 ms lead avoids scheduling into the past (which plays late or overlapped). On
`interrupted` you must `stop()` every live `AudioBufferSourceNode` and reset
`nextTime` to `ctx.currentTime`.

The `AudioContext` must be **unlocked inside the click gesture**, before any
`await`, or the autoplay policy leaves it `suspended` and nothing ever plays.

`nextTime - ctx.currentTime` also tells you how much audio is still scheduled,
which is how the client knows the agent has actually finished speaking before it
closes the call.

### 4.5 When a talking head plays the audio instead

If a LiveAvatar session is up, that same PCM is forwarded to it rather than played
locally (`hooks/useAvatarLipSync.ts` → `lib/avatarSpeech.ts`), and the avatar
lip-syncs it. One detail is worth borrowing if you do the same: the wire protocol
groups audio frames into an utterance by `event_id` and ends it with
`agent.speak_end`, so a whole agent turn must be streamed as **one** utterance —
sending each flush as its own utterance makes every boundary an end-of-speech, and
the voice comes out chopped. Frames go out at 300 ms then 750 ms, and a partial
frame is flushed after ~120 ms of silence so the tail of a sentence never waits for
the next burst.

### 4.6 Other events on the same stream

Because the agent uses tools, parts that are **not audio** arrive on the same
WebSocket:

- **Function calls / responses** — `content.parts[].functionCall =
  {name: "start_interview", args: {…}}` and then
  `functionResponse = {name, response: {…}}`, with `author: "streaming_agent"`.
  This is the interview advancing; useful for observability and for syncing the UI
  with the current step. The client also reads two of them as protocol:
  `review_answers` / `correct_answer` / `confirm_interview` carry the answer record
  it renders in the chat, and a confirmed `confirm_interview` is what ends the call.
- **Thoughts** — text parts flagged `"thought": true`. The planner runs with
  `include_thoughts=False`, so they should not appear; the client filters on the
  flag anyway, because **concatenating them as dialogue shows the user the model's
  internal reasoning**.
- **`actions.stateDelta`** — when a tool mutates the state
  (`current_question_index`, `answers`), the delta travels in the event.

### 4.7 Transcription is on by default

`outputTranscription` / `inputTranscription` are what the transcript panel is built
from, and in this ADK version they arrive without being asked for:
`RunConfig.output_audio_transcription` and `input_audio_transcription` both default
to `AudioTranscriptionConfig()` (`agents/run_config.py`), and
`flows/llm_flows/basic.py` copies them into the `live_connect_config`. `/run_live`
exposes no query parameter for them, so those defaults are the whole mechanism.

`runners.py` additionally forces both on when the agent has `sub_agents` (a live
multi-agent system needs the text as context for the agent it transfers to), which
does not apply to this flat agent — it is a guard, not the source of the behavior.

Both fields arrive as deltas, with `finished: true` on the frame that carries the
full aggregate text. The client replaces its bubble on that frame, and treats
`inputTranscription.finished` as the end of the user's turn.

---

## 5. Full lifecycle

| Phase | Client | Server |
|---|---|---|
| 1 | `POST /apps/streaming/users/{u}/sessions/{s}` with the metadata | creates the row in Postgres |
| 2 | `new WebSocket(/run_live?…&modalities=AUDIO)` | validates the session, `accept()`, builds the `RunConfig`, connects to Gemini |
| 3 | `onopen` → unlock the `AudioContext`, `startMic()`, send the opening cue | `before_agent_callback` seeds the state |
| 4 | `{blob:…}` every ~85 ms | `LiveRequestQueue.send` → model |
| 5 | `onmessage` → decode `inlineData` → play or forward to the avatar | one `Event` per chunk |
| 6 | first partial `inputTranscription`, or `interrupted` → cut playback | barge-in |
| 7 | `turnComplete` → close the avatar's utterance, reset UI state | end of turn |
| 8 | `confirm_interview` confirmed → mic off, wait for the goodbye | the interview is sealed in state |
| 9 | `{close:true}` + `ws.close()` | cancels both tasks |

The state persists, so reconnecting with the same `session_id` **resumes the
interview** without recreating the session (the `POST` would return 400/409, which
the client already ignores).

---

## 6. Format summary

| | Input (browser → API) | Output (API → browser) |
|---|---|---|
| Transport | WS text frame, JSON `LiveRequest` | WS text frame, JSON `Event` |
| Field | `blob.data` | `content.parts[].inlineData.data` |
| mimeType | `audio/pcm;rate=16000` | `audio/pcm;rate=24000` |
| Codec | PCM16 LE mono, no container | PCM16 LE mono, no container |
| Sample rate | **16 000 Hz** | **24 000 Hz** |
| Base64 | standard (`btoa`) | **URL-safe, unpadded** |
| Naming | snake or camel (both valid) | **camelCase** (`by_alias=True`) |

---

## 7. Quick reference — local URLs

```
ADK base (HTTP):  http://localhost:8000
ADK base (WS):    ws://localhost:8000
Through Next:     http://localhost:5173/adk   (@awa/my)

Create session:
  POST http://localhost:8000/apps/streaming/users/{userId}/sessions/{sessionId}
       body: { "first_name": "...", "last_name": "...", "ine_address": "...", "language": "en-US" }

Live socket:
  ws://localhost:8000/run_live?app_name=streaming&user_id={userId}&session_id={sessionId}&modalities=AUDIO

Send (mic):    {"blob":{"mimeType":"audio/pcm;rate=16000","data":"<b64 pcm16>"}}
Send (text):   {"content":{"role":"user","parts":[{"text":"hello"}]}}
Send (end):    {"close":true}

Recv (audio):  event.content.parts[].inlineData -> {mimeType:"audio/pcm;rate=24000", data:"<url-safe b64>"}
Recv (text):   event.outputTranscription.text / event.inputTranscription.text
Recv (tools):  event.content.parts[].functionCall / .functionResponse
Recv (flags):  event.partial / event.turnComplete / event.interrupted
Recv (error):  event.errorCode / event.errorMessage
```
