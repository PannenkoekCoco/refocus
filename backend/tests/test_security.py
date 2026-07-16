import io
import json
import logging
from collections.abc import Callable
from pathlib import Path
from secrets import token_hex, token_urlsafe
from uuid import UUID

from fastapi import Request
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
import pytest
from starlette.routing import Route

from app.config import Settings
from app.logging import REQUEST_LOGGER_NAME, SecurityJsonFormatter
from app.main import create_app
from app.security.redaction import redact_log_fields


def production_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "app_environment": "production",
        "app_origin": "https://learn.refocus.example",
        "database_url": "postgresql+psycopg://refocus:password@managed-db.example/refocus",
        "session_secret": token_urlsafe(32),
        "github_app_id": "12345",
        "github_client_id": "github-client-id",
        "github_client_secret": "github-client-secret",
        "github_private_key": "test-private-key",
    }
    values.update(overrides)
    return Settings(**values)


def test_log_redaction_removes_recursive_secret_aliases() -> None:
    secret_values = {
        "authorization": "Bearer top-secret",
        "originalText": "Private job description",
        "nested": {
            "clientSecret": "client-secret",
            "github_private_key": "private-key",
        },
        "items": [{"accessToken": "access-token"}, {"password": "password-value"}],
        "topic_id": "apis",
    }

    result = redact_log_fields(secret_values)

    assert result == {
        "authorization": "[REDACTED]",
        "originalText": "[REDACTED]",
        "nested": {
            "clientSecret": "[REDACTED]",
            "github_private_key": "[REDACTED]",
        },
        "items": [{"accessToken": "[REDACTED]"}, {"password": "[REDACTED]"}],
        "topic_id": "apis",
    }
    rendered = json.dumps(result)
    for value in (
        "Bearer top-secret",
        "Private job description",
        "client-secret",
        "private-key",
        "access-token",
        "password-value",
    ):
        assert value not in rendered


def test_json_log_formatter_keeps_only_the_controlled_request_fields() -> None:
    record = logging.LogRecord(
        name=REQUEST_LOGGER_NAME,
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="private message with top-secret",
        args=(),
        exc_info=None,
    )
    record.security_fields = {
        "event": "request_completed",
        "request_id": "d6e144ba-2e11-4ce9-acf5-63840276fa20",
        "method": "POST",
        "path": "/api/focus-lenses/preview",
        "status": 200,
        "duration_ms": 3,
        "original_text": "Private job description",
        "headers": {"authorization": "Bearer top-secret"},
    }

    payload = json.loads(SecurityJsonFormatter().format(record))

    assert payload == {
        "duration_ms": 3,
        "event": "request_completed",
        "method": "POST",
        "path": "/api/focus-lenses/preview",
        "request_id": "d6e144ba-2e11-4ce9-acf5-63840276fa20",
        "status": 200,
    }


@pytest.mark.asyncio
async def test_request_ids_are_canonicalized_and_returned_for_normal_validation_and_not_found_responses() -> None:
    app = create_app()
    incoming_request_id = "D6E144BA-2E11-4CE9-ACF5-63840276FA20"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        health_response = await client.get("/health", headers={"X-Request-ID": incoming_request_id})
        validation_response = await client.post(
            "/api/focus-lenses/preview",
            headers={"X-Request-ID": "not-a-uuid"},
            json={"kind": "job"},
        )
        not_found_response = await client.get("/missing?token=query-secret")

    assert health_response.status_code == 200
    assert health_response.headers["X-Request-ID"] == incoming_request_id.lower()
    assert validation_response.status_code == 422
    assert not_found_response.status_code == 404
    for response in (validation_response, not_found_response):
        assert UUID(response.headers["X-Request-ID"])


@pytest.mark.asyncio
async def test_request_logger_never_records_headers_query_values_or_focus_text() -> None:
    app = create_app()
    logger = logging.getLogger(REQUEST_LOGGER_NAME)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(SecurityJsonFormatter())
    logger.addHandler(handler)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
            response = await client.post(
                "/api/focus-lenses/preview?state=raw-state&code=raw-code",
                headers={
                    "Authorization": "Bearer raw-token",
                    "Cookie": "refocus_session=raw-cookie",
                },
                json={
                    "kind": "job",
                    "originalText": "Private job description with raw-password",
                },
            )
    finally:
        logger.removeHandler(handler)

    assert response.status_code == 200
    payload = json.loads(stream.getvalue().strip())
    assert payload["path"] == "/api/focus-lenses/preview"
    assert set(payload) == {"event", "request_id", "method", "path", "status", "duration_ms"}
    for value in (
        "raw-state",
        "raw-code",
        "raw-token",
        "raw-cookie",
        "Private job description",
        "raw-password",
    ):
        assert value not in stream.getvalue()


@pytest.mark.asyncio
async def test_unexpected_errors_are_generic_and_keep_request_headers() -> None:
    app = create_app()

    async def unexpected_error(_request: Request) -> None:
        raise RuntimeError("private upstream token failure")

    app.router.routes.insert(0, Route("/security-test-unexpected-error", unexpected_error))
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(
            "/security-test-unexpected-error",
            headers={"X-Request-ID": "D6E144BA-2E11-4CE9-ACF5-63840276FA20"},
        )

    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error"}
    assert response.headers["X-Request-ID"] == "d6e144ba-2e11-4ce9-acf5-63840276fa20"
    assert "private upstream token failure" not in response.text


@pytest.mark.asyncio
async def test_security_headers_cover_the_static_app_without_blocking_local_tts() -> None:
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.get("/")

    assert response.status_code == 200
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Permissions-Policy"] == "camera=(), geolocation=(), microphone=()"
    assert "connect-src 'self' http://127.0.0.1:8767" in response.headers["Content-Security-Policy"]
    assert "media-src 'self' blob:" in response.headers["Content-Security-Policy"]
    assert "Strict-Transport-Security" not in response.headers


def test_production_settings_require_tls_database_secret_and_secure_cookies() -> None:
    settings = production_settings()

    assert settings.github_callback_url == "https://learn.refocus.example/api/auth/github/callback"
    assert settings.secure_session_cookie is True

    for overrides in (
        {"app_origin": "http://learn.refocus.example"},
        {"database_url": "sqlite+aiosqlite:///./refocus.db"},
        {"session_secret": "too-short"},
        {"session_cookie_secure": False},
    ):
        with pytest.raises(ValidationError):
            production_settings(**overrides)


@pytest.mark.parametrize(
    "new_secret_factory",
    (token_urlsafe, token_hex),
    ids=("urlsafe", "hex"),
)
def test_production_settings_accept_generated_urlsafe_and_hex_session_secrets(
    new_secret_factory: Callable[[int], str],
) -> None:
    settings = production_settings(session_secret=new_secret_factory(32))

    assert settings.secure_session_cookie is True


@pytest.mark.parametrize(
    "unsafe_secret",
    (
        "development-only-replace-before-deploy",
        "ci-session-secret-only",
        "ci-session-secret-only-not-for-production",
        "a" * 48,
        "abcd" * 12,
        pytest.param("password" * 6, id="eight-character-pattern"),
        pytest.param("abcde" * 10, id="five-character-pattern"),
    ),
)
def test_production_settings_reject_known_or_repeated_session_secrets(unsafe_secret: str) -> None:
    with pytest.raises(ValidationError, match="SESSION_SECRET must be a safely generated value") as error:
        production_settings(session_secret=unsafe_secret)

    assert unsafe_secret not in str(error.value)


@pytest.mark.parametrize(
    "partial_github_settings",
    (
        {"github_app_id": "12345"},
        {"github_client_id": "test-client-id"},
        {"github_client_secret": "partial-test-client-secret"},
        {"github_private_key": "partial-test-private-key"},
    ),
)
def test_production_settings_make_github_optional_but_reject_partial_configuration(
    partial_github_settings: dict[str, str],
) -> None:
    disabled_github_settings = {
        "github_app_id": None,
        "github_client_id": None,
        "github_client_secret": None,
        "github_private_key": None,
    }
    disabled_github = production_settings(**disabled_github_settings)

    assert disabled_github.github_is_configured is False

    with pytest.raises(ValidationError, match="GitHub configuration is incomplete in production") as error:
        production_settings(**(disabled_github_settings | partial_github_settings))

    assert next(iter(partial_github_settings.values())) not in str(error.value)


def test_container_and_ci_configuration_keep_runtime_secrets_and_access_logs_out_of_the_image() -> None:
    app_root = Path(__file__).parents[2]
    dockerfile = (app_root / "Dockerfile").read_text(encoding="utf-8")
    dockerignore = (app_root / ".dockerignore").read_text(encoding="utf-8")
    compose = (app_root / "docker-compose.yml").read_text(encoding="utf-8")
    workflow = (app_root.parents[0] / ".github" / "workflows" / "learning-companion-ci.yml").read_text(
        encoding="utf-8"
    )

    assert "USER refocus" in dockerfile
    assert "--no-access-log" in dockerfile
    assert "alembic upgrade head" not in dockerfile
    for excluded_path in (
        ".env",
        "backend/.venv/",
        "node_modules/",
        "local-tts/python/",
        "reports/",
    ):
        assert excluded_path in dockerignore
    assert "127.0.0.1:8000:8000" in compose
    assert "postgres:16-alpine" in compose
    assert "migrate:" in compose
    assert "service_completed_successfully" in compose
    assert "permissions:" in workflow
    assert "contents: read" in workflow
    assert "npm --prefix ema-cram-app ci" in workflow
    assert "docker build -t refocus ema-cram-app" in workflow
