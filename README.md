# Awa

**Awa** is a small FastAPI service that exposes a [Google Agent Development Kit (ADK)](https://google.github.io/adk-docs/) assistant over HTTP: create ADK-backed sessions in Postgres, then send chat turns through a Gemini model. The codebase is intentionally compact (see [`AGENTS.md`](./AGENTS.md) for layout and conventions).

## Development environment

This project uses **[uv](https://docs.astral.sh/uv/)** for Python version pinning, dependency lockfiles, and virtual environments. There is no Nix flake; use a normal shell plus `uv`.

### Prerequisites

| Tool | Purpose |
|------|---------|
| [Python 3.13+](https://www.python.org/downloads/) | Runtime (`requires-python` in `pyproject.toml`) |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | Sync deps, run commands (`uv sync`, `uv run …`) |
| [Docker](https://docs.docker.com/get-docker/) (optional) | Local Postgres via `compose.yaml` |

### First-time setup

```bash
git clone <repository-url>
cd awa
uv sync --all-groups
```

Copy environment template and add your Gemini API key:

```bash
cp .env.dist .env
# Edit .env: set GOOGLE_API_KEY or GEMINI_API_KEY (see Environment variables).
```

Start Postgres when you want the default `DATABASE_URL` to work (matches `compose.yaml`):

```bash
docker compose up -d
```

### Running the API

```bash
uv run uvicorn src.main:app --host 0.0.0.0 --port 8080 --reload
```

Open `http://127.0.0.1:8080/docs` for interactive OpenAPI, or import the Bruno collection under `bruno/awa` (default `baseUrl` is `http://0.0.0.0:8080`; run **Create Session** before **Chat** so random `session_id` / `user_id` line up).

### Running tests

```bash
uv run pytest
```

Tests use a file-backed SQLite database under `tests/` (see `tests/conftest.py`) and stub the model for the happy-path chat test, so they do not call Gemini or Postgres by default.

### Lint and format

```bash
uv run ruff check .
uv run ruff format --check .
uv run pycln --config pyproject.toml --check --all src tests
uv run isort src tests --check-only --diff
```

Configuration lives in `pyproject.toml` (`[tool.ruff]`, `[tool.isort]`, `[tool.pycln]`).

### GitHub Actions

| Workflow | When it runs |
|----------|----------------|
| [`.github/workflows/pr.yml`](./.github/workflows/pr.yml) | Pull requests targeting `main` |
| [`.github/workflows/main.yml`](./.github/workflows/main.yml) | Pushes to `main` |

Both install dependencies with **uv**, then run **Ruff** (lint + format check), **pycln** (`--check --all`), **isort** (`--check-only`), and **pytest**.

### Pre-commit (optional)

```bash
uv run pre-commit install
uv run pre-commit run --all-files
```

Hooks mirror CI: **isort** and **pycln** first, then **Ruff** (fix + format), then **pytest** (`-x`).

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_API_KEY` or `GEMINI_API_KEY` | Yes for `/chat` | [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key). Loaded from `.env` at startup and synced into the process environment for `google-genai`. |
| `DATABASE_URL` | For Postgres sessions | Default matches Docker Compose (`postgresql+psycopg://postgres:postgres@localhost:5432/postgres`). |
| `GOOGLE_GEMINI_MODEL_NAME` | No | Default `gemini-2.5-flash`. |
| `ADK_APP_NAME` | No | Default `awa`; must stay consistent between session rows and the ADK `Runner`. |

Optional: root **`.env`** is read by `Settings` (`env_file` in `src/main.py`). Secrets stay out of git (`.env` is ignored; `.env.dist` is committed as a template).

### Project layout (high level)

| Path | Role |
|------|------|
| `src/main.py` | FastAPI app, DI container, ADK agent/runner, routes |
| `tests/` | Pytest + `httpx` against the ASGI app |
| `bruno/awa/` | Bruno requests for manual API checks |
| `compose.yaml` | Local Postgres |
| `AGENTS.md` | Notes for contributors and AI agents (MVP scope, DI pattern) |

### VS Code / Cursor

Point the Python interpreter at the environment uv creates (`.venv` after `uv sync`), or run everything through `uv run …` so the correct interpreter and dependencies are always used.

### Troubleshooting

**`/chat` returns 503 about the API key**

Set `GOOGLE_API_KEY` or `GEMINI_API_KEY` in `.env` or the shell, restart Uvicorn, and confirm `_sync_gemini_api_key_to_environ` runs (it is invoked from the FastAPI lifespan).

**`/sessions` or `/chat` fails against the database**

Ensure Postgres is up (`docker compose ps`), `DATABASE_URL` matches your compose credentials, and the ADK schema can be created (first request may migrate tables).

**Bruno cannot reach the API**

Many clients cannot use `http://0.0.0.0:8080` as a request URL; switch the Bruno **local** environment `baseUrl` to `http://127.0.0.1:8080` while keeping Uvicorn bound to `0.0.0.0`.

**Pytest import / settings issues**

`tests/conftest.py` sets `DATABASE_URL` to SQLite **before** importing `src.main` so `Settings` matches the test database; do not import `src.main` earlier in test modules without the same guard.
