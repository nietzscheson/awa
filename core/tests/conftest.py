"""Pytest must set DATABASE_URL before importing `src.main` (Settings is built at import time)."""

from __future__ import annotations

import os
from pathlib import Path

_test_sqlite = Path(__file__).resolve().parent / ".test_adk.sqlite"
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_test_sqlite}"

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from src.main import MainContainer, app


@pytest.fixture(scope="session", autouse=True)
def _app_container():
    """httpx ASGITransport does not run FastAPI lifespan; mirror startup from `lifespan`."""
    container = MainContainer()
    app.container = container
    container.wire()
    yield
    container.unwire()


@pytest.fixture
def main_container():
    return app.container


@pytest_asyncio.fixture
async def http_client():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client
