import hashlib
import secrets

from app.config import Settings


def new_session_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    return token, session_token_hash(token)


def session_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def session_cookie_kwargs(settings: Settings) -> dict[str, object]:
    return {
        "httponly": True,
        "samesite": "lax",
        "secure": settings.secure_session_cookie,
        "max_age": settings.session_max_age_seconds,
        "path": "/",
    }


def github_transaction_cookie_kwargs(settings: Settings) -> dict[str, object]:
    return {
        "httponly": True,
        "samesite": "lax",
        "secure": settings.secure_session_cookie,
        "max_age": settings.github_oauth_max_age_seconds,
        "path": "/api/auth/github",
    }
