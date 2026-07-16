from pathlib import Path
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_DATABASE_URL = "postgresql+psycopg://learning:learning_local_only@127.0.0.1:5432/learning_companion"
DEFAULT_APP_ORIGIN = "http://127.0.0.1:8000"


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
        return all(
            (
                self.github_app_id,
                self.github_client_id,
                self.github_client_secret,
                self.github_private_key,
            )
        )
