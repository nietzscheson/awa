"""ASGI entry point that extends the default ADK ``api_server`` app.

``adk api_server`` is just ``uvicorn`` running ``get_fast_api_app(...)`` (see
``google.adk.cli.cli_tools_click.cli_api_server``). We call that same factory so
every built-in resource (``/run``, ``/sessions``, ``/list-apps`` …) is preserved.

Run it instead of ``adk api_server``:

    uv run uvicorn src.main:app --port 8000 --reload

Equivalent of the previous command's flags:
    * ``src/agents``              -> ``AGENTS_DIR`` (default below)
    * ``--reload_agents``         -> ``RELOAD_AGENTS=1`` (ADK agent hot-reload)
    * ``--session_service_uri``   -> taken from ``Settings.DATABASE_URL``
"""

from __future__ import annotations

import os

from google.adk.cli.fast_api import get_fast_api_app

from src.container import MainContainer

container = MainContainer()
settings = container.settings()

app = get_fast_api_app(
    agents_dir=os.path.abspath("src/agents"),
    session_service_uri=settings["DATABASE_URL"],
    # web=False matches `adk api_server` (no bundled dev UI; use --with_ui for that).
    web=True,
    reload_agents=True,
)
