from fastapi import Response

from app.config import Settings
from app.security.sessions import (
    new_session_token,
    session_cookie_kwargs,
    session_token_hash,
)


def test_opaque_session_tokens_are_hashed_before_persistence() -> None:
    token, token_hash = new_session_token()

    assert token != token_hash
    assert len(token_hash) == 64
    assert token_hash == session_token_hash(token)


def test_session_cookie_is_http_only_lax_and_secure_only_when_configured_for_tls() -> None:
    local_options = session_cookie_kwargs(Settings(app_environment="development"))
    production_options = session_cookie_kwargs(Settings(app_environment="production"))
    explicit_http_options = session_cookie_kwargs(
        Settings(app_environment="production", session_cookie_secure=False)
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
