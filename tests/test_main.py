from __future__ import annotations

import uuid

from httpx import AsyncClient

from src.main import AwaApiService, MainContainer


async def test_health(http_client: AsyncClient, main_container: MainContainer):
    response = await http_client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"message": "healthy"}


async def test_create_session(http_client: AsyncClient):
    session_id = f"s-{uuid.uuid4().hex}"
    user_id = f"u-{uuid.uuid4().hex}"
    response = await http_client.post(
        "/sessions",
        json={
            "session_id": session_id,
            "user_id": user_id,
            "language": "es-MX",
            "metadata": {"pytest": True},
        },
    )
    assert response.status_code == 200
    assert response.json() == {"session_id": session_id, "user_id": user_id}


async def test_create_session_conflict(http_client: AsyncClient):
    session_id = f"s-{uuid.uuid4().hex}"
    user_id = f"u-{uuid.uuid4().hex}"
    first = await http_client.post(
        "/sessions",
        json={"session_id": session_id, "user_id": user_id},
    )
    assert first.status_code == 200
    second = await http_client.post(
        "/sessions",
        json={"session_id": session_id, "user_id": user_id},
    )
    assert second.status_code == 409


async def test_chat_requires_nonempty_text(http_client: AsyncClient):
    session_id = f"s-{uuid.uuid4().hex}"
    user_id = f"u-{uuid.uuid4().hex}"
    await http_client.post(
        "/sessions",
        json={"session_id": session_id, "user_id": user_id},
    )
    response = await http_client.post(
        "/chat",
        json={
            "user_id": user_id,
            "session_id": session_id,
            "new_message": {"parts": [{"text": "   "}]},
        },
    )
    assert response.status_code == 400


async def test_chat_unknown_session(http_client: AsyncClient):
    response = await http_client.post(
        "/chat",
        json={
            "user_id": "no-such-user",
            "session_id": "no-such-session",
            "new_message": {"parts": [{"text": "hello"}]},
        },
    )
    assert response.status_code == 404


async def test_chat_with_session_uses_stubbed_turn(
    http_client: AsyncClient, monkeypatch
):
    async def _stub_run_turn(
        self, *, user_id: str, session_id: str, user_text: str
    ) -> str:
        return "stub-model-reply"

    monkeypatch.setattr(AwaApiService, "_run_turn_text", _stub_run_turn)

    session_id = f"s-{uuid.uuid4().hex}"
    user_id = f"u-{uuid.uuid4().hex}"
    await http_client.post(
        "/sessions",
        json={"session_id": session_id, "user_id": user_id},
    )
    response = await http_client.post(
        "/chat",
        json={
            "user_id": user_id,
            "session_id": session_id,
            "new_message": {"parts": [{"text": "ping"}]},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["session_id"] == session_id
    assert body["response"] == "stub-model-reply"
