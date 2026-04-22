# AGENTS.md — Awa

## What this is

**Awa** is a small MVP: a FastAPI service backed by **Google Agent Development Kit (ADK)** with Postgres for ADK session storage. There is no LangGraph and no multi-package layout.

## Where code lives

- **`src/main.py`** — All application logic in one place: settings, dependency-injector `MainContainer`, FastAPI `lifespan`, the ADK `Agent` / `Runner` / `DatabaseSessionService` wiring, Pydantic models, and an **`AwaApiService`** class that implements use cases. HTTP handlers live on an **`APIRouter`**, use **`@inject`** with **`Depends(Provide[MainContainer.api_service])`** (not ad hoc `request.app` accessors). `lifespan` calls **`container.wire()`** / **`container.unwire()`** so injections resolve. When you add behavior, default to extending this file.
- **`tests/`** — Pytest + `httpx.AsyncClient` against the ASGI app. CI and pre-commit run **Ruff**, **pycln**, **isort**, and **pytest** (see `.github/workflows/` and `pyproject.toml`). `conftest.py` forces a file-backed **SQLite** `DATABASE_URL` before importing `src.main`, and assigns `app.container` because `httpx`’s `ASGITransport` does not run FastAPI lifespan. Chat tests stub `_run_turn_text` so they do not call Gemini.

Do **not** grow a large tree of modules, routers, and service layers for this repo unless the maintainers explicitly change direction.

## Runtime

- **Python**: 3.13+ (see `.python-version` / `pyproject.toml`).
- **Dependencies**: managed with **`uv`** (`uv sync`, `uv run …`).
- **Database**: `DATABASE_URL` (default matches local Docker Postgres in `compose.yaml`). ADK uses it for `DatabaseSessionService`.
- **Model**: `GOOGLE_GEMINI_MODEL_NAME` (Gemini id for the agent).
- **Gemini API key**: `GOOGLE_API_KEY` or `GEMINI_API_KEY` ([create a key](https://ai.google.dev/gemini-api/docs/api-key)). Optional entries in a root **`.env`** file are loaded by `Settings` and copied into `os.environ` at app startup so `google-genai` sees them.
- **ADK app id**: `ADK_APP_NAME` (must match between session rows and `Runner.app_name`).

## HTTP API (MVP)

| Method | Path | Purpose |
|--------|------|--------|
| `GET` | `/health` | Liveness |
| `POST` | `/sessions` | Create an ADK session (`session_id`, `user_id`, optional `language`, `metadata`) |
| `POST` | `/chat` | Send a user turn; runs `Runner.run_async` for that session |

Session must exist before `/chat` (runner does not auto-create sessions).

## Manual API checks

Import the **`bruno/awa`** folder in [Bruno](https://www.usebruno.com/). The collection defaults to the **`local`** environment with **`baseUrl`** `http://0.0.0.0:8080` (see `bruno/awa/environments/local.bru`); `collection.bru` defines the same fallback if no environment is active. **Create Session** generates random `sessionId` / `userId` (stored as request vars); run it before **Chat** so chat reuses those ids.

## Next steps (when you extend the MVP)

1. **Streaming** — Expose ADK events over SSE or WebSockets instead of collapsing to a single string in `/chat`.
2. **Auth** — Add API keys or OAuth on `/sessions` and `/chat` before any public deployment.
3. **Split files** — Only if `main.py` becomes hard to navigate; until then, keep the flat layout.
