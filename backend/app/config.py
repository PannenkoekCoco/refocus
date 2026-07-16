from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_DATABASE_URL = "postgresql+psycopg://learning:learning_local_only@127.0.0.1:5432/learning_companion"
DEFAULT_APP_ORIGIN = "http://127.0.0.1:8000"
MINIMUM_PRODUCTION_SESSION_SECRET_LENGTH = 32
MAX_REPEATED_SESSION_SECRET_PATTERN_LENGTH = 4
KNOWN_NON_PRODUCTION_SESSION_SECRETS = frozenset(
    {
        "development-only-replace-before-deploy",
        "ci-session-secret-only",
        "ci-session-secret-only-not-for-production",
    }
)


def has_short_repeated_pattern(value: str) -> bool:
    """Reject only obvious, whole-secret repetitions without restricting generated formats."""
    max_pattern_length = min(MAX_REPEATED_SESSION_SECRET_PATTERN_LENGTH, len(value) // 2)
    return any(
        len(value) % pattern_length == 0
        and value == value[:pattern_length] * (len(value) // pattern_length)
        for pattern_length in range(1, max_pattern_length + 1)
    )


class Settings(BaseSettings):
    database_url: str = DEFAULT_DATABASE_URL
    session_secret: SecretStr | None = None
    github_app_id: str | None = None
    github_client_id: str | None = None
    github_client_secret: SecretStr | None = None
    github_private_key: SecretStr | None = None
    app_origin: str = DEFAULT_APP_ORIGIN
    app_environment: Literal["development", "production", "test"] = "development"
    session_cookie_secure: bool | None = None
    session_cookie_name: str = "refocus_session"
    session_max_age_seconds: int = 60 * 60 * 24 * 7
    github_oauth_state_cookie_name: str = "refocus_github_oauth_state"
    github_pkce_cookie_name: str = "refocus_github_pkce_verifier"
    github_oauth_max_age_seconds: int = Field(default=10 * 60, ge=60, le=60 * 60)
    github_oauth_max_pending_transactions: int = Field(default=1_000, ge=1, le=10_000)
    github_authorization_max_age_seconds: int = Field(default=15 * 60, ge=60, le=24 * 60 * 60)
    github_callback_timeout_seconds: int = Field(default=15, ge=5, le=60)
    github_verification_timeout_seconds: int = Field(default=15, ge=5, le=60)
    github_verification_min_interval_seconds: int = Field(default=60, ge=1, le=60 * 60)
    content_root: Path = Path(__file__).parents[2] / "content"
    static_root: Path = Path(__file__).parents[2] / "app" / "static"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @field_validator("session_cookie_secure", mode="before")
    @classmethod
    def empty_cookie_secure_setting_is_unset(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator("database_url", "app_origin", mode="before")
    @classmethod
    def blank_local_values_use_their_safe_defaults(cls, value: object, info) -> object:
        if value != "":
            return value
        return DEFAULT_DATABASE_URL if info.field_name == "database_url" else DEFAULT_APP_ORIGIN

    @property
    def secure_session_cookie(self) -> bool:
        if self.session_cookie_secure is not None:
            return self.session_cookie_secure
        return self.app_environment == "production"

    @property
    def github_is_configured(self) -> bool:
        return all(self._github_credential_values())

    def _github_credential_values(self) -> tuple[str, str, str, str]:
        return (
            (self.github_app_id or "").strip(),
            (self.github_client_id or "").strip(),
            (self.github_client_secret.get_secret_value() if self.github_client_secret else "").strip(),
            (self.github_private_key.get_secret_value() if self.github_private_key else "").strip(),
        )

    @property
    def github_configuration_is_partial(self) -> bool:
        credential_values = self._github_credential_values()
        return any(credential_values) and not all(credential_values)

    @model_validator(mode="after")
    def production_settings_are_safe_to_deploy(self) -> "Settings":
        if self.app_environment != "production":
            return self

        parsed_origin = urlsplit(self.app_origin)
        if (
            parsed_origin.scheme != "https"
            or not parsed_origin.netloc
            or parsed_origin.path not in ("", "/")
            or parsed_origin.query
            or parsed_origin.fragment
        ):
            raise ValueError("APP_ORIGIN must be an HTTPS origin without a path in production")
        if not self.database_url.startswith("postgresql+psycopg://") or self.database_url == DEFAULT_DATABASE_URL:
            raise ValueError("DATABASE_URL must point to the managed PostgreSQL database in production")
        session_secret = self.session_secret.get_secret_value() if self.session_secret else ""
        if (
            len(session_secret) < MINIMUM_PRODUCTION_SESSION_SECRET_LENGTH
            or session_secret.strip().casefold() in KNOWN_NON_PRODUCTION_SESSION_SECRETS
            or has_short_repeated_pattern(session_secret)
        ):
            raise ValueError("SESSION_SECRET must be a safely generated value in production")
        if self.session_cookie_secure is False:
            raise ValueError("SESSION_COOKIE_SECURE cannot be disabled in production")
        if self.github_configuration_is_partial:
            raise ValueError("GitHub configuration is incomplete in production")
        return self

    @property
    def github_callback_url(self) -> str:
        return f"{self.app_origin.rstrip('/')}/api/auth/github/callback"

    @property
    def github_return_url(self) -> str:
        return f"{self.app_origin.rstrip('/')}/"
