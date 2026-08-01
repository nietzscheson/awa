"""Pytest must set DATABASE_URL before importing app modules (Settings is built at import)."""

from __future__ import annotations

import os
from pathlib import Path

_test_sqlite = Path(__file__).resolve().parent / ".test_adk.sqlite"
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_test_sqlite}"
# Keep unit tests offline — no live Gemini calls.
os.environ.pop("GOOGLE_API_KEY", None)
os.environ.pop("GEMINI_API_KEY", None)
