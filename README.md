# Awa

**Awa** is a real-time voice interview conducted by an AI. A [Google ADK](https://google.github.io/adk-docs/) agent runs the interview over the [Gemini Live API](https://ai.google.dev/gemini-api/docs/live) — it listens, asks and answers while you speak — and [LiveAvatar](https://liveavatar.com) gives it a face that lip-syncs that same audio. The agent keeps the conversation, its tools keep the state, and the avatar only renders it.

```
  mic ──► /adk/run_live (WebSocket) ──► Gemini Live ──► PCM16 24 kHz ──┐
                                             ▲                        │
                                    interview tools                   ▼
                                    (session state)          LiveAvatar (LITE)
                                                             video + lips + voice
```

Two screens and nothing else: a setup screen that takes the candidate's details, the interview language and one camera/microphone permission, then the call itself.

## Installation

Clone and install both halves of the repo:

```bash
git clone https://github.com/nietzscheson/awa
cd awa
task setup
```

`task setup` creates `.env` from `.env.dist` (it never overwrites an existing one), then installs Python dependencies with `uv` and web dependencies with `npm`. Fill in the API keys before running anything — see [Environment variables](#environment-variables).

### Prerequisites

| Tool | Purpose |
|------|---------|
| [Task](https://taskfile.dev/installation/) | Every command in this repo is a task (`task` with no arguments lists them) |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | Python 3.13 environment and dependencies for `core/` |
| [Node.js 20+](https://nodejs.org/) + npm | The `web/` npm-workspaces monorepo |
| [Docker](https://docs.docker.com/get-docker/) | Postgres, where ADK stores sessions |

Run `task doctor` to check what is actually installed.

There is also a Nix flake, if you prefer it — `nix develop` (or `direnv allow`, since `.envrc` is `use flake`) gives you Python, uv, Node, Lerna, Docker and pre-commit, and its `shellHook` starts the compose stack for you. Note that `task` itself is not in the flake yet; install it separately.

## Environment variables

Everything lives in one **`.env` at the repo root** — `taskfile.yaml` loads it for the API, and the Next.js app reads the same file through `src/lib/rootEnv.ts` so keys are never duplicated under `web/`. `.env` is gitignored; `.env.dist` is the committed template.

### The interview agent (`core/`)

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | **Yes** | [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key). Without it the agent cannot answer. |
| `DATABASE_URL` | No | ADK session storage. Defaults to the compose Postgres (`postgresql+psycopg://postgres:postgres@localhost:5432/postgres`). |
| `GEMINI_STREAMING_MODEL_NAME` | No | Default `gemini-3.1-flash-live-preview`. Must be a `*-live` model: the interview is bidirectional audio. |
| `GEMINI_VOICE_NAME` | No | One of the prebuilt Live voices (default `Aoede`). See `core/src/enums.py`. |
| `GEMINI_LANGUAGE_CODE` | No | *Default* interview language (`en-US`). The setup screen picks the real one per session; this only applies when it doesn't. |
| `GEMINI_THINKING_LEVEL` | No | `MINIMAL` (default), `LOW`, `MEDIUM`, `HIGH`. The model emits no audio while it thinks, so anything above `MINIMAL` is dead air before the avatar answers. |

### The talking head (LiveAvatar)

| Variable | Required | Description |
|----------|----------|-------------|
| `LIVEAVATAR_API_KEY` | For a face | Create one at [app.liveavatar.com/developers](https://app.liveavatar.com/developers). Stays server-side: the browser only ever gets a per-session token from `POST /api/liveavatar/token`. |
| `LIVEAVATAR_SANDBOX` | No | `true` (template default) is free, pins the "Wayne" avatar and self-closes after ~1 minute. Set `false` for a real avatar — it bills by the minute. |
| `LIVEAVATAR_AVATAR_ID` | With `SANDBOX=false` | Pick one from `GET https://api.liveavatar.com/v1/avatars/public`. Ignored in sandbox mode. |
| `LIVEAVATAR_VIDEO_QUALITY` | No | `very_high` \| `high` (default) \| `medium` \| `low`. |
| `LIVEAVATAR_MAX_SESSION_DURATION` | No | Seconds. A hard cap on a paid session. |
| `LIVEAVATAR_API_URL` | No | Default `https://api.liveavatar.com`. |

The avatar is optional decoration: if the key is missing, the session fails, or the sandbox expires mid-interview, the client falls back to playing the agent's audio itself and the interview carries on.

### The web client (`web/packages/app`)

| Variable | Required | Description |
|----------|----------|-------------|
| `ADK_API_ORIGIN` | No | Where Next proxies `/adk/*`. Default `http://localhost:8000` — the port `task api` listens on. |
| `NEXT_PUBLIC_ADK_BASE` | No | Set to an absolute origin to talk to ADK directly instead of through the proxy. Then the ADK server needs `--allow_origins`. |
| `NEXT_PUBLIC_LIVE_DEBUG` | No | Console trace of every live event with per-turn latency, tool calls and thought summaries. On by default under `next dev`; `0` silences it. |
| `NEXT_DIST_DIR` | No | Build output directory. Use `NEXT_DIST_DIR=.next-build` to run `next build` **without** clobbering a running dev server. |

`.env.dist` lists only what Awa reads. The sibling apps under `web/packages/` (see [Project structure](#project-structure)) have their own variables — `@awa/liveavatar`, for instance, runs LiveAvatar in FULL mode and also wants `LIVEAVATAR_CONTEXT_ID`, `LIVEAVATAR_LANGUAGE` and `LIVEAVATAR_VOICE_ID`.

> **Watch out for exported variables.** With direnv/Nix the `.env` is exported into your shell, and a variable already in the environment wins over the file (deliberately, so `LIVEAVATAR_SANDBOX=false npm run dev` works). Edit `.env` and a long-lived shell keeps serving the old value — run `direnv reload`, or open a new terminal, before wondering why your change did nothing.

## Usage

### Running the stack

```bash
# Postgres + the ADK API + every web app
task dev
```

Or one piece at a time, in separate terminals:

```bash
task docker:up   # Postgres (compose.yaml)
task api         # ADK API with reload  → http://127.0.0.1:8000
task app         # the interview client → http://localhost:5173
```

Open **http://localhost:5173**, fill in the details, choose English or Spanish, allow the camera and microphone, and press **Start interview**. The interviewer greets you as soon as you join — the app hands it the first turn.

### Testing

```bash
task test        # both suites

task core:test   # pytest in core/  (no Gemini, no Postgres — SQLite + fakes)
task web:test    # jest across every web package
```

### Linting and formatting

```bash
task lint          # ruff + pycln + isort in core/, next lint in web/
task core:format   # rewrite: ruff --fix, ruff format, isort, pycln
```

### Building

```bash
task build   # every web app (Nx-cached)
```

To check a production build while `task app` is running, keep them apart — they share `.next`:

```bash
cd web/packages/app && NEXT_DIST_DIR=.next-build npx next build
```

### Other useful tasks

```bash
task              # list every task
task doctor       # versions of the tools this repo needs
task web:list     # the packages lerna sees
task clean        # drop Next build output and caches
task clean:deps   # drop node_modules and core/.venv
```

## How the interview runs

The agent is a plain ADK `Agent` wired in `core/src/container.py`; the questionnaire and all progress live in **session state**, not in the model's memory, so the model never has to remember which question came last. The tools in `core/src/services.py` are the whole protocol:

| Tool | What it does |
|------|--------------|
| `start_interview` | Begins (or restarts) and returns the first question |
| `submit_answer` | Stores the answer, advances the cursor, returns the next question |
| `review_answers` | Reads back everything answered, for the candidate to confirm |
| `correct_answer` | Replaces one answer without re-opening the questionnaire; drops any confirmation |
| `confirm_interview` | Seals the record — and tells the client the call is over |
| `get_current_question` / `get_interview_status` / `get_interview_questions` / `reset_interview` | Inspection and recovery |

The end of the interview is a loop, not a full stop: the answers are read back **and shown in the chat** (a spoken list cannot be checked), corrections are applied and re-confirmed for as long as the candidate wants, and only then does the agent say goodbye. The client closes the microphone the moment the record is confirmed, and the call once the goodbye has actually been heard.

The interview language is chosen on the setup screen and posted as session state. The agent's instruction is an ADK *instruction provider*, resolved per session, so the same singleton agent conducts an English interview for one candidate and a Spanish one for the next.

### The transport

There is no REST chat API in front of this. The client talks to ADK's **live bidirectional WebSocket**, and audio flows both ways over that one socket. Two steps:

```
1. POST /adk/apps/streaming/users/{user}/sessions/{session}
      the request body IS the session state dict — the applicant's details and
      the chosen language go here, and the interview tools read them from state

2. WS   /adk/run_live?app_name=streaming&user_id=…&session_id=…&modalities=AUDIO
```

Then, on that socket:

| Direction | Frame | Meaning |
|-----------|-------|---------|
| → | `{"blob":{"mimeType":"audio/pcm;rate=16000","data":"<base64>"}}` | A microphone frame, PCM16 mono at 16 kHz |
| → | `{"content":{"role":"user","parts":[{"text":"…"}]}}` | A typed turn (and the opening cue that makes the agent speak first) |
| → | `{"close":true}` | Hang up |
| ← | `content.parts[].inlineData` | The agent's voice: PCM16 at 24 kHz, base64 — **URL-safe and unpadded** |
| ← | `outputTranscription.text` / `inputTranscription.text` | What the agent is saying / what it heard, as deltas |
| ← | `content.parts[].functionCall` / `functionResponse` | Tool use — this is where the interview's state changes |
| ← | `partial` / `turnComplete` / `interrupted` | Turn boundaries and barge-in |

`modalities=AUDIO` is not a choice: the live models reject `TEXT` output, which is why the transcript is read from `outputTranscription` rather than from text parts.

The details that are easy to get wrong — the base64 dialect, the Web Audio graph, streaming one utterance to the avatar instead of many, closing the call without cutting the goodbye — are documented where they are implemented: `web/packages/app/src/components/StreamingAgentClient.tsx`, `src/lib/liveEvents.ts`, `src/lib/livePcm.ts` and `src/lib/avatarSpeech.ts`.

If you are integrating against this transport rather than running it, three longer documents go all the way down:

| Document | Audience |
|----------|----------|
| [`RUN_LIVE.md`](./RUN_LIVE.md) | The short version — open a session, push audio, read the answer, with a checklist |
| [`STREAMING.md`](./STREAMING.md) | Browser clients: the full audio graph, every `Event` field, the traps |
| [`DOC.md`](./DOC.md) | Putting a backend of your own between a client and the agent |

## Project structure

| Path | Role |
|------|------|
| `core/src/main.py` | ASGI app: ADK's own `get_fast_api_app`, so every built-in route (`/run_live`, `/sessions`, `/list-apps` …) is preserved |
| `core/src/container.py` | DI wiring: model, voice, thinking level, tools, and the language-aware instruction |
| `core/src/services.py` | `InterviewService` — the questionnaire and every tool the agent drives it with |
| `core/src/settings.py` | Typed settings, read from the root `.env` |
| `core/tests/` | pytest over the tools and the wiring |
| `web/packages/app/` | **`@awa/my`** — the interview client (`task app`, :5173) |
| `web/packages/app/src/components/StreamingAgentClient.tsx` | The whole client: socket, turn state, audio routing, closing sequence |
| `web/packages/app/src/hooks/useAvatarLipSync.ts` | The LiveAvatar session that lip-syncs the agent's audio |
| `web/packages/app/src/lib/avatarSpeech.ts` | Streams one utterance per turn so the voice never sounds chopped |
| `web/packages/app/src/lib/liveEvents.ts` | The live event shape, and the console trace of it |
| `web/packages/app/src/app/api/liveavatar/token/` | Mints the avatar session token server-side |
| `taskfile.yaml` | Every command in this repo |
| `compose.yaml` | Local Postgres |
| `flake.nix` | Optional Nix dev shell |

Sibling apps in `web/packages/` (`@awa/avatar`, `@awa/gemini-live-avatar`, `@awa/liveavatar`, ports 5174–5176) are separate experiments against the same APIs; they have their own env vars and are not needed to run the interview.

## Troubleshooting

**The avatar is the wrong one, or "Wayne" shows up instead of the one you configured**

`LIVEAVATAR_SANDBOX=true` pins Wayne and ignores `LIVEAVATAR_AVATAR_ID`. If `.env` already says `false`, check the shell: `env | grep LIVEAVATAR` — an exported value overrides the file (see the warning above).

**"Avatar unavailable… The interview continues with audio."**

Expected whenever LiveAvatar cannot come up: no key, no credits, expired sandbox. The interview still works, voice-only. The browser console has the real error.

**`Loading chunk … failed` in dev**

Something ran `next build` against the same `.next` the dev server is using. Stop the dev server, `rm -rf web/packages/app/.next`, start it again — and build with `NEXT_DIST_DIR=.next-build` next time.

**"Could not create the session" on the setup screen**

The ADK API isn't reachable. Start it with `task api` and confirm `ADK_API_ORIGIN` points at it (`http://localhost:8000` by default). In direct mode (`NEXT_PUBLIC_ADK_BASE`) the ADK server also needs `--allow_origins`.

**The avatar answers slowly**

Check the console trace (`NEXT_PUBLIC_LIVE_DEBUG`): every line is stamped from the moment you stopped talking. A gap before the first tool call is the model thinking — lower `GEMINI_THINKING_LEVEL`. A gap after `♪ first agent audio` with a still face is LiveAvatar.

**Postgres errors on session create**

`docker compose ps` to confirm it is up, and that `DATABASE_URL` matches the compose credentials. The first request creates the ADK schema.
