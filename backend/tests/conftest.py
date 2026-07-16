import hashlib
import secrets
import sqlite3
import sys
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from httpx import ASGITransport, AsyncClient
import pytest_asyncio


BACKEND_ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.main import create_app


APP_ORIGIN = "http://testserver"
SESSION_COOKIE_NAME = "refocus_session"


def _utc_sql_timestamp(value: datetime) -> str:
    return value.astimezone(UTC).replace(tzinfo=None).isoformat(sep=" ")


def _create_schema(database_path: Path) -> None:
    connection = sqlite3.connect(database_path)
    try:
        connection.executescript(
            """
            PRAGMA foreign_keys = ON;
            CREATE TABLE users (
                id CHAR(32) PRIMARY KEY,
                github_login VARCHAR(80) UNIQUE,
                created_at DATETIME NOT NULL
            );
            CREATE TABLE sessions (
                id CHAR(32) PRIMARY KEY,
                user_id CHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash VARCHAR(64) NOT NULL UNIQUE,
                expires_at DATETIME NOT NULL,
                revoked_at DATETIME,
                created_at DATETIME NOT NULL
            );
            CREATE TABLE topic_progress (
                id CHAR(32) PRIMARY KEY,
                user_id CHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                topic_id VARCHAR(80) NOT NULL,
                status VARCHAR(24) NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_topic_progress_user_topic UNIQUE (user_id, topic_id)
            );
            CREATE TABLE quiz_attempts (
                id CHAR(32) PRIMARY KEY,
                user_id CHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                client_attempt_id CHAR(32) NOT NULL,
                lesson_id VARCHAR(120) NOT NULL,
                answers_json JSON NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_quiz_attempt_user_client_attempt UNIQUE (user_id, client_attempt_id)
            );
            """
        )
        connection.commit()
    finally:
        connection.close()


@pytest_asyncio.fixture
async def client(tmp_path: Path, monkeypatch) -> AsyncIterator[AsyncClient]:
    database_path = tmp_path / "refocus-test.db"
    _create_schema(database_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database_path.as_posix()}")
    monkeypatch.setenv("APP_ORIGIN", APP_ORIGIN)
    app = create_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url=APP_ORIGIN,
        headers={"Origin": APP_ORIGIN},
    ) as async_client:
        yield async_client

    engine = getattr(app.state, "database_engine", None)
    if engine is not None:
        await engine.dispose()


@pytest_asyncio.fixture
async def authenticated_client_factory(
    tmp_path: Path,
    monkeypatch,
) -> AsyncIterator[Callable[[str, str | None], AsyncClient]]:
    database_path = tmp_path / "refocus-authenticated-test.db"
    _create_schema(database_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database_path.as_posix()}")
    monkeypatch.setenv("APP_ORIGIN", APP_ORIGIN)
    app = create_app()
    clients: list[AsyncClient] = []

    async def create_authenticated_client(
        label: str,
        origin: str | None = APP_ORIGIN,
        expires_in_seconds: int = 60 * 60,
    ) -> AsyncClient:
        user_id = uuid4()
        token = secrets.token_urlsafe(32)
        now = datetime.now(UTC)
        connection = sqlite3.connect(database_path)
        try:
            connection.execute(
                "INSERT INTO users (id, github_login, created_at) VALUES (?, ?, ?)",
                (user_id.hex, label, _utc_sql_timestamp(now)),
            )
            connection.execute(
                """
                INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at, created_at)
                VALUES (?, ?, ?, ?, NULL, ?)
                """,
                (
                    uuid4().hex,
                    user_id.hex,
                    hashlib.sha256(token.encode("utf-8")).hexdigest(),
                    _utc_sql_timestamp(now + timedelta(seconds=expires_in_seconds)),
                    _utc_sql_timestamp(now),
                ),
            )
            connection.commit()
        finally:
            connection.close()

        headers = {"Origin": origin} if origin is not None else {}
        async_client = AsyncClient(
            transport=ASGITransport(app=app),
            base_url=APP_ORIGIN,
            headers=headers,
        )
        async_client.cookies.set(SESSION_COOKIE_NAME, token)
        clients.append(async_client)
        return async_client

    yield create_authenticated_client

    for async_client in clients:
        await async_client.aclose()
    engine = getattr(app.state, "database_engine", None)
    if engine is not None:
        await engine.dispose()


@pytest_asyncio.fixture
async def authenticated_client(authenticated_client_factory) -> AsyncIterator[AsyncClient]:
    async_client = await authenticated_client_factory("learner")
    yield async_client
