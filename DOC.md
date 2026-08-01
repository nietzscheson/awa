# DOC.md — Awa live agent integration

How a client talks to the **ADK agent**, written for a team putting **a backend of
their own in the middle** (client → your orchestrator → ADK agent). The examples
lean .NET, but nothing here is .NET-specific.

The transport is **not** a `/chat` REST/SSE API. The streaming client
(`web/packages/app/src/components/StreamingAgentClient.tsx`) uses the **ADK live
bidirectional WebSocket** (`/run_live`) exposed by the ADK `api_server`. Audio
flows both ways over that single WebSocket.

> Source of truth: `core/src/main.py`, `core/src/container.py` (`streaming_agent`),
> `core/src/settings.py`, the ADK endpoint at
> `core/.venv/.../google/adk/cli/api_server.py` (`run_agent_live`), and the web
> client plus `web/packages/app/src/lib/livePcm.ts`.

---

## 1. The two endpoints you must integrate with

The ADK server (started by `task api`, i.e.
`uv run uvicorn src.main:app --port 8000 --reload`) serves the standard ADK
surface. Integration needs exactly two of its routes.

### 1a. Create the session (REST, one-shot, before connecting)

```
POST  {ADK_BASE}/apps/{app_name}/users/{user_id}/sessions/{session_id}
Content-Type: application/json

<body = the initial session STATE dict>
```

- The **JSON body IS the session state** (`create_session_with_id`). The interview
  tools read these keys. The web client sends the applicant's details and the
  interview language:

  ```json
  {
    "first_name": "Ada",
    "last_name": "Lovelace",
    "ine_address": "Monte Leon de Piedad 237. Ciudad de México",
    "language": "en-US"
  }
  ```

- The session **must exist before** opening the WebSocket — `run_live` closes with
  code **1002 "Session not found"** otherwise.
- Idempotency: the web client treats HTTP **400/409** as "already exists" and
  proceeds.
- `app_name` = the subfolder under `core/src/agents` that holds `agent.py`. For the
  streaming agent that is **`streaming`**. `user_id` / `session_id` are
  caller-chosen strings.

### 1b. The live WebSocket (bidirectional audio + text + events)

```
WS  {ADK_WS_BASE}/run_live?app_name={app}&user_id={user}&session_id={session}&modalities=AUDIO
```

Endpoint: `@app.websocket("/run_live")` → `run_agent_live` in ADK's `api_server.py`.

Query parameters:

| Param | Required | Notes |
|-------|----------|-------|
| `user_id` | yes | Must match the created session. |
| `session_id` | yes | Must match the created session. |
| `app_name` | yes* | `streaming`. *Optional only if `ADK_DEFAULT_APP_NAME` env is set. |
| `modalities` | no (default `AUDIO`) | `AUDIO` or `TEXT`. The configured live model only emits **AUDIO**; TEXT output is rejected. Repeatable. |
| `proactive_audio` | no | bool |
| `enable_affective_dialog` | no | bool |
| `enable_session_resumption` | no | bool |
| `save_live_blob` | no | bool, default false |
| `explicit_vad_signal` | no | bool — you delimit the turns instead of Gemini's VAD |

`{user_id, session_id, app_name}` on the WS **must be identical** to the ones used
at session creation.

---

## 2. What the client SENDS over the WebSocket

Each WS message is a JSON-encoded ADK **`LiveRequest`** (one JSON object per
`websocket.send_text`, validated with `LiveRequest.model_validate_json`). The
fields are mutually prioritized: `activity_start > activity_end > blob > content`.
The three the client uses:

**1. Microphone audio frame (realtime mode)** — sent continuously while the mic is on:

```json
{ "blob": { "mimeType": "audio/pcm;rate=16000", "data": "<base64 PCM16>" } }
```

- **Input audio format: 16-bit signed PCM, mono, 16 kHz, little-endian**,
  base64-encoded (`livePcm.ts`, `INPUT_SAMPLE_RATE = 16000`). The browser
  downsamples mic → 16 kHz and base64-encodes (`floatToPcm16` + `pcm16ToBase64`),
  in ~4096-sample chunks (`ScriptProcessorNode(4096)`).

**2. Text turn (turn-by-turn mode)** — when the user types instead of speaking:

```json
{ "content": { "role": "user", "parts": [{ "text": "let's start" }] } }
```

The same form carries the **opening cue**: a live model says nothing until it has
input, so the client sends one bracketed turn on connect
(`[interview_start] …`) and the agent's instruction tells it to greet the
candidate and never read a bracketed cue aloud.

**3. Close the stream** — on hang-up:

```json
{ "close": true }
```

> A relay that proxies audio from its own client sends form **1** for every audio
> frame and form **3** to end. It needs form **2** only if you support typed input
> or want the agent to open the conversation.

---

## 3. What the client RECEIVES over the WebSocket

Each WS message is a JSON-encoded ADK **`Event`**, serialized with
`model_dump_json(exclude_none=True, by_alias=True)` — so keys are **camelCase**
and `None` fields are absent. The web client (`handleEvent` in
`StreamingAgentClient.tsx`) reads:

| Field | Meaning | Integration use |
|-------|---------|-----------------|
| `content.parts[].inlineData` | `{ mimeType: "audio/pcm;rate=24000", data: "<base64 PCM16>" }` — a chunk of the agent's **spoken** audio | **Play this.** Output is **16-bit PCM, mono, 24 kHz, little-endian** (`OUTPUT_SAMPLE_RATE = 24000`). |
| `outputTranscription.text` | Streaming transcript of what the **agent** is saying (deltas; `finished:true` carries the final aggregate) | Show as agent subtitle / transcript. |
| `inputTranscription.text` | Transcript of the **user's** mic audio (deltas; `finished` flag) | Show as user subtitle; `finished` is the turn boundary. |
| `content.parts[].text` | Text output. In AUDIO modality this is where **thought summaries** would appear if the planner emitted them | Filter on `part.thought === true` — never show it as dialogue. |
| `content.parts[].functionCall` | Agent invoked a tool: `{ name, args }` | Interview step transitions. Observability. |
| `content.parts[].functionResponse` | Tool result: `{ name, response }` | Observability — and the end of the interview: `confirm_interview` returning `status: "confirmed"` is the signal to close. |
| `partial` | bool — this is a partial (streaming) frame | Don't treat as final. |
| `turnComplete` | bool — agent finished its turn | Reset UI state; close the avatar's utterance. |
| `interrupted` | bool — barge-in: user spoke over the agent | **Stop playback immediately** (flush queued audio). |
| `errorCode` / `errorMessage` | model/agent error | Surface / log. |
| `goAway` | the server is about to close | Reconnect with the same `session_id`. |
| `author` | who emitted the event | Logging. |

> **base64 caveat (important):** Gemini Live serializes audio bytes as **URL-safe
> base64 without padding** (`-`/`_`, no `=`) — see `livePcm.ts`. The browser
> normalizes back to standard base64 before `atob`. Any other decoder must do the
> same: replace `-`→`+`, `_`→`/`, re-pad to a multiple of 4, then decode. In .NET:
>
> ```csharp
> Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/')
>                           .PadRight((s.Length + 3) / 4 * 4, '='));
> ```

### Audio formats at a glance

| Direction | Format | mimeType |
|-----------|--------|----------|
| Client mic → agent (input) | PCM16, mono, **16 kHz**, LE, standard base64 | `audio/pcm;rate=16000` |
| Agent → client speaker (output) | PCM16, mono, **24 kHz**, LE, **URL-safe base64, unpadded** | `audio/pcm;rate=24000` |

---

## 4. Connection lifecycle (what a relay must replicate)

This is exactly what `start()` in `StreamingAgentClient.tsx` does:

1. `POST .../sessions/{session_id}` with the state body → create the session
   (accept 200/400/409).
2. Open WS `.../run_live?app_name=&user_id=&session_id=&modalities=AUDIO`.
3. On open: send the opening cue if you want the agent to speak first, then stream
   `{"blob": {...}}` frames as audio arrives; relay `{"content": {...}}` for typed
   text.
4. On each inbound `Event`: play `inlineData` audio; forward transcriptions and
   flags to the UI; on `interrupted`, flush playback.
5. When `confirm_interview` returns `status: "confirmed"`: stop sending microphone
   audio, let the goodbye finish playing, **then** hang up.
6. On hang-up: send `{"close": true}`, then close the socket.

WebSocket close codes from the server: **1002** session not found, **1008** origin
not allowed, **1011** internal error (reason truncated to 123 bytes), **1000**
normal.

---

## 5. Routing / CORS — where your backend sits

Today the browser never hits the ADK server directly. Next.js proxies same-origin
`/adk/*` → ADK (`web/packages/app/next.config.ts`), **including the `/run_live`
WebSocket upgrade**. Upstream is `ADK_API_ORIGIN` (default `http://localhost:8000`).

ADK has an `_OriginCheckMiddleware`: a request **with no `Origin` header, or an
allowed one**, is accepted — so a server-side proxy works **without** starting ADK
with `--allow_origins`. A browser hitting ADK **directly** with an absolute URL
(`NEXT_PUBLIC_ADK_BASE`) **does** require `--allow_origins <origin>`.

**Implication for a custom backend:** it takes the place of the Next proxy, as a
server-side WebSocket relay:

```
your client  ⇄  your backend (orchestrator)  ⇄  ADK /run_live WebSocket
 (audio in/out)   (proxy + business logic)        (Gemini Live agent)
```

Because the relay connects server-side, ADK needs no CORS flag. That backend is
free to:

- own session creation (`POST .../sessions/...`) and inject applicant metadata and
  the interview language into session state;
- enforce auth — **ADK has none today**;
- translate between whatever protocol its client speaks and the ADK
  `LiveRequest`/`Event` JSON described above. It can pass the JSON straight
  through, or re-frame the audio if its client uses a different codec or sample
  rate — resample to 16 kHz inbound, from 24 kHz outbound.

---

## 6. Agent configuration (context for behavior, not transport)

From `core/src/container.py` (`streaming_agent`) and `core/src/settings.py`:

- **Model:** `GEMINI_STREAMING_MODEL_NAME` (default
  `gemini-3.1-flash-live-preview`).
- **Voice:** `GEMINI_VOICE_NAME` (default `Aoede`) via `SpeechConfig`. Note that
  `SpeechConfig.language_code` is deliberately **not** set: it is a property of the
  process-wide model instance, and the interview language is chosen per session.
- **Language:** `GEMINI_LANGUAGE_CODE` (default `en-US`) is only the fallback. The
  real language comes from the session state key `language`, and reaches the model
  through the instruction, which is an ADK *instruction provider* resolved per
  invocation.
- **Thinking:** `BuiltInPlanner`, level `GEMINI_THINKING_LEVEL` (default
  `MINIMAL`), `include_thoughts=False`. Both matter for a live conversation: the
  model emits no audio while it thinks, and thought summaries would otherwise
  arrive as ordinary text parts in the transcript.
- **Behavior:** an interview agent. Progress lives in session state; the agent
  drives it with the `InterviewService` tools — `start_interview`,
  `submit_answer`, `review_answers`, `correct_answer`, `confirm_interview`,
  `get_current_question`, `get_interview_status`, `get_interview_questions`,
  `reset_interview`. A `before_agent_callback` seeds the state each run. All of
  these surface to a relay as `functionCall` / `functionResponse` events.

---

## 7. Quick reference — concrete URLs (local)

```
ADK base (HTTP):  http://localhost:8000
ADK base (WS):    ws://localhost:8000
Through Next:     http://localhost:5173/adk   (@awa/my)

Create session:
  POST http://localhost:8000/apps/streaming/users/{userId}/sessions/{sessionId}
       body: { "first_name": "...", "last_name": "...", "ine_address": "...", "language": "en-US" }

Live socket:
  ws://localhost:8000/run_live?app_name=streaming&user_id={userId}&session_id={sessionId}&modalities=AUDIO

Send (mic):   {"blob":{"mimeType":"audio/pcm;rate=16000","data":"<b64 pcm16>"}}
Send (text):  {"content":{"role":"user","parts":[{"text":"hello"}]}}
Send (end):   {"close":true}

Recv (audio): event.content.parts[].inlineData -> {mimeType:"audio/pcm;rate=24000", data:"<b64 pcm16>"}
Recv (text):  event.outputTranscription.text / event.inputTranscription.text
Recv (tools): event.content.parts[].functionCall / .functionResponse
Recv (flags): event.partial / event.turnComplete / event.interrupted
```
