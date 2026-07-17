from pathlib import Path
from secrets import token_urlsafe

from fastapi import Response

import app.config as config_module
from app.config import Settings
from app.security.sessions import (
    new_session_token,
    session_cookie_kwargs,
    session_token_hash,
)


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


def test_opaque_session_tokens_are_hashed_before_persistence() -> None:
    token, token_hash = new_session_token()

    assert token != token_hash
    assert len(token_hash) == 64
    assert token_hash == session_token_hash(token)


def test_session_cookie_is_http_only_lax_and_secure_only_when_configured_for_tls() -> None:
    local_options = session_cookie_kwargs(Settings(app_environment="development"))
    production_options = session_cookie_kwargs(production_settings())
    explicit_http_options = session_cookie_kwargs(
        Settings(app_environment="test", session_cookie_secure=False)
    )

    assert local_options["httponly"] is True
    assert local_options["samesite"] == "lax"
    assert local_options["secure"] is False
    assert production_options["secure"] is True
    assert explicit_http_options["secure"] is False

    response = Response()
    response.set_cookie("refocus_session", "opaque", **local_options)
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie
    assert "SameSite=lax" in cookie
    assert "Secure" not in cookie


def test_blank_local_environment_values_keep_safe_local_defaults() -> None:
    settings = Settings(app_origin="", database_url="")

    assert settings.app_origin == "http://127.0.0.1:8000"
    assert settings.database_url.startswith("postgresql+psycopg://")


def test_settings_environment_file_is_anchored_to_the_application_root(monkeypatch) -> None:
    backend_root = Path(__file__).parents[1]
    monkeypatch.chdir(backend_root)

    environment_file = Path(Settings.model_config["env_file"])

    assert environment_file.is_absolute()
    assert environment_file == backend_root.parent / ".env"


def test_migration_database_url_ignores_an_empty_environment_override(monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "")
    settings = Settings(database_url="sqlite+aiosqlite:///configured.db")

    assert config_module.migration_database_url(settings) == "sqlite+aiosqlite:///configured.db"
