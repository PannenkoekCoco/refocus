from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_origin: str = "http://127.0.0.1:8000"
    content_root: Path = Path(__file__).parents[2] / "content"
    static_root: Path = Path(__file__).parents[2] / "app" / "static"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
