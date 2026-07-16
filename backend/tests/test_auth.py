from secrets import token_urlsafe

from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
import pytest

from app.config import Settings
from app.main import create_app

@pytest.mark.asyncio
async def test_me_is_safe_for_anonymous_learners(client: AsyncClient) -> None:
    response = await client.get("/api/me")

    assert response.status_code == 200
    assert response.json() == {"authenticated": False}


@pytest.mark.asyncio
async def test_me_returns_only_a_safe_user_view_for_an_authenticated_session(
    authenticated_client: AsyncClient,
) -> None:
    response = await authenticated_client.get("/api/me")

    assert response.status_code == 200
    payload = response.json()
    assert payload["authenticated"] is True
    assert set(payload["user"]) == {"id", "githubConnected"}
    assert payload["user"]["githubConnected"] is False


@pytest.mark.asyncio
async def test_logout_revokes_the_server_side_session(authenticated_client: AsyncClient) -> None:
    response = await authenticated_client.post("/api/auth/logout")

    assert response.status_code == 204
    assert response.content == b""
    assert (await authenticated_client.get("/api/me")).json() == {"authenticated": False}


@pytest.mark.asyncio
async def test_github_login_is_guarded_until_all_app_settings_exist(client: AsyncClient) -> None:
    response = await client.get("/api/auth/github/login")

    assert response.status_code == 503
    assert response.json() == {"code": "github_not_configured"}


@pytest.mark.asyncio
async def test_github_login_remains_safely_disabled_when_production_omits_all_github_settings() -> None:
    app = create_app(
        Settings(
            app_environment="production",
            app_origin="https://learn.refocus.example",
            database_url="postgresql+psycopg://refocus:password@managed-db.example/refocus",
            session_secret=SecretStr(token_urlsafe(32)),
        )
    )
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="https://learn.refocus.example",
        ) as production_client:
            response = await production_client.get("/api/auth/github/login")
    finally:
        await app.state.database_engine.dispose()

    assert response.status_code == 503
    assert response.json() == {"code": "github_not_configured"}


@pytest.mark.asyncio
async def test_configured_github_login_starts_the_server_side_authorization_flow(
    configured_github_client,
) -> None:
    configured_client, _app = configured_github_client

    response = await configured_client.get("/api/auth/github/login")

    assert response.status_code == 307
    assert response.headers["location"].startswith("https://github.com/login/oauth/authorize?")


@pytest.mark.asyncio
async def test_expired_server_session_cannot_authenticate(authenticated_client_factory) -> None:
    expired_client = await authenticated_client_factory("expired", expires_in_seconds=-1)

    response = await expired_client.get("/api/me")

    assert response.status_code == 200
    assert response.json() == {"authenticated": False}
