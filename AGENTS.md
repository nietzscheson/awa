# AGENTS.md — Awa

## What this is

**Awa** is a small MVP: a FastAPI service backed by **Google Agent Development Kit (ADK)** with Postgres for ADK session storage. A **LangGraph** state machine in `core/src/main.py` drives the structured **interview** logic (validation, ordering, prerequisite questions); answers are normalized through **`InterviewQuestionResponse`** (Pydantic) via flexible parsing (synonyms, Spanish labels on `InterviewQuestion.choice_option_labels`, loose numbers and yes/no phrasing). Successful tool replies include **`structured_answer`**. Users reach interviews only through **`/chat`** and tools—there are no separate interview HTTP routes.

## Where code lives

- **`core/src/main.py`** — All application logic in one place: settings, dependency-injector `MainContainer`, FastAPI `lifespan`, the ADK `Agent` / `Runner` / `DatabaseSessionService` wiring, Pydantic models, and an **`AwaApiService`** class that implements use cases. HTTP handlers live on an **`APIRouter`**, use **`@inject`** with **`Depends(Provide[MainContainer.api_service])`** (not ad hoc `request.app` accessors). `lifespan` calls **`container.wire()`** / **`container.unwire()`** so injections resolve. When you add behavior, default to extending this file.
- **`core/tests/`** — Pytest + `httpx.AsyncClient` against the ASGI app. CI and pre-commit run **Ruff**, **pycln**, **isort**, and **pytest** on `core/`, plus **`tsc`**, **`next lint`**, and **Jest** on `web/packages/app/` when those paths change (see `.github/workflows/` and `pyproject.toml`). `conftest.py` forces a file-backed **SQLite** `DATABASE_URL` before importing `src.main`, and assigns `app.container` because `httpx`’s `ASGITransport` does not run FastAPI lifespan. Chat tests stub `_run_turn_text` so they do not call Gemini.
- **`web/packages/app/`** — **Next.js** (App Router) voice client: **`src/components/AwaVoiceChat.tsx`** (client), **`src/app/`** (pages, layout, global CSS), **`src/app/api/elevenlabs/*`** (server-side STT/TTS proxy). **`next.config.ts`** rewrites **`/api/awa/*`** to the FastAPI base URL (`AWA_API_ORIGIN`, default `http://127.0.0.1:8080`) and loads the **repo-root** `.env` via `@next/env`. Use **`npm run dev --workspace=@awa/my`** from **`web/`** (port **5173**). Do not reintroduce Vite for this UI unless maintainers explicitly change direction.

Do **not** grow a large tree of modules, routers, and service layers for this repo unless the maintainers explicitly change direction.

**Voice opener sync:** the magic string **`__AWA_VOICE_SESSION_OPENING__`** must stay identical in **`core/src/main.py`** (`VOICE_SESSION_OPENING_SIGNAL`) and **`web/packages/app/src/components/AwaVoiceChat.tsx`** (`AWA_VOICE_SESSION_OPENING`).

## Runtime

- **Python**: 3.13+ (see `.python-version` / `core/pyproject.toml`).
- **Dependencies**: managed with **`uv`** from **`core/`** (`uv sync`, `uv run …`).
- **Database**: `DATABASE_URL` (default matches local Docker Postgres in `compose.yaml`). ADK uses it for `DatabaseSessionService`.
- **Model**: `GOOGLE_GEMINI_MODEL_NAME` (Gemini id for the agent).
- **Gemini API key**: `GOOGLE_API_KEY` or `GEMINI_API_KEY` ([create a key](https://ai.google.dev/gemini-api/docs/api-key)). Optional entries in a root **`.env`** file are loaded by `Settings` and copied into `os.environ` at app startup so `google-genai` sees them.
- **ADK app id**: `ADK_APP_NAME` (must match between session rows and `Runner.app_name`).

## HTTP API (MVP)

| Method | Path | Purpose |
|--------|------|--------|
| `GET` | `/health` | Liveness |
| `GET` | `/sessions?user_id=` | List ADK sessions for that user (newest first): `session_id`, `user_id`, `last_update_time`. Backed by `DatabaseSessionService.list_sessions`. |
| `POST` | `/sessions` | Create an ADK session (`session_id`, `user_id`, optional `language`, `metadata`). `language` is stored as session state `user:language` (and always wins over a conflicting key in `metadata`). `metadata` entries such as `user_name` are copied into session state and appear in the agent instruction via placeholders (`{user:language}`, `{user_name?}`) for locale and greetings only; the structured interview still collects **full name** via the normal `full_name` step (display name is not auto-submitted as the legal name). On success, any **in-memory interview progress** for that same `user_id` + `session_id` pair is cleared so a new ADK session always starts a fresh interview. |
| `POST` | `/chat` | Send a user turn; runs `Runner.run_async` for that session. Before each model call, the service reads LangGraph-backed interview state keyed by **`user_id` + `session_id`** (same as this request) and may prepend an **Interview turn context** block. Interview tools must receive **both** `user_id` and `session_id` matching **Chat** / **Create Session** so state cannot leak across users who reuse the same `session_id` string. After each turn, interview captures are merged into ADK user state when present: **`user:profession_description`**, **`user:years_in_profession`**, and **`user:employment_type`** (canonical `UserTypeProfession` value inferred by the agent via **`record_identified_employment_type`** from the profession answer—not a separate user-facing enum step). |
| `POST` | `/chat/stream` | Same body as `/chat`; streams SSE with `model` partial chunks and a final `done` frame: `response`, `interview_is_complete`, and `close_conversation` (true when the model invoked the **`close_conversation`** tool in that turn—voice UI hangs up). Used by the Next.js voice client. |

Session must exist before `/chat` (runner does not auto-create sessions).

## Manual API checks

Import the **`bruno/awa`** folder in [Bruno](https://www.usebruno.com/). The collection defaults to the **`local`** environment with **`baseUrl`** `http://0.0.0.0:8080` (see `bruno/awa/environments/local.bru`); `collection.bru` defines the same fallback if no environment is active. **Create Session** generates random `sessionId` / `userId` (stored as request vars); run it before **Chat** so chat reuses those ids. **Chat** drives a short structured interview (confirm full name, profession with agent-inferred employment type, years of experience, then close); the model uses tools (not extra HTTP endpoints) to advance steps. If the in-memory interview was already finished for that `user_id` + `session_id`, a **short greeting** (e.g. hola / hi) on the next `/chat` **resets** the questionnaire so the user is not stuck on “already complete” without a new `POST /sessions`.

## Next steps (when you extend the MVP)

1. **Auth** — Add API keys or OAuth on `/sessions` and `/chat` before any public deployment.
2. **Split files** — Only if `main.py` becomes hard to navigate; until then, keep the flat layout.
