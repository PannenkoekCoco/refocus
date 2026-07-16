from httpx import AsyncClient
import pytest

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
