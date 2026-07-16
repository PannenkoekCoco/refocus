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
from app.config import Settings


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
                github_user_id VARCHAR(64) UNIQUE,
                github_authorized_at DATETIME,
                github_verification_started_at DATETIME,
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
            CREATE TABLE focus_lenses (
                id CHAR(32) PRIMARY KEY,
                user_id CHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                kind VARCHAR(16) NOT NULL,
                original_text TEXT NOT NULL,
                skill_weights_json JSON NOT NULL,
                is_active BOOLEAN NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            );
            CREATE UNIQUE INDEX uq_focus_lenses_active_user_kind
                ON focus_lenses (user_id, kind)
                WHERE is_active = 1;
            CREATE TABLE github_oauth_transactions (
                id CHAR(32) PRIMARY KEY,
                user_id CHAR(32) REFERENCES users(id) ON DELETE CASCADE,
                state_hash VARCHAR(64) NOT NULL UNIQUE,
                expires_at DATETIME NOT NULL,
                consumed_at DATETIME,
                created_at DATETIME NOT NULL
            );
            CREATE INDEX ix_github_oauth_transactions_expires_at
                ON github_oauth_transactions (expires_at);
            CREATE TABLE github_oauth_transaction_slots (
                slot_number INTEGER PRIMARY KEY
                    CHECK (slot_number >= 1 AND slot_number <= 10000),
                transaction_id CHAR(32) UNIQUE
                    REFERENCES github_oauth_transactions(id) ON DELETE SET NULL
            );
            CREATE TABLE github_installations (
                id CHAR(32) PRIMARY KEY,
                user_id CHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                github_installation_id BIGINT NOT NULL,
                account_login VARCHAR(255) NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_github_installations_user_installation
                    UNIQUE (user_id, github_installation_id)
            );
            CREATE TABLE github_repositories (
                id CHAR(32) PRIMARY KEY,
                user_id CHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                installation_id CHAR(32) NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
                github_repository_id BIGINT NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                default_branch VARCHAR(255) NOT NULL,
                is_selected BOOLEAN NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_github_repositories_user_repository
                    UNIQUE (user_id, github_repository_id)
            );
            CREATE UNIQUE INDEX uq_github_repositories_selected_user
                ON github_repositories (user_id)
                WHERE is_selected = 1;
            CREATE TABLE mission_verifications (
                id CHAR(32) PRIMARY KEY,
                user_id CHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                mission_id VARCHAR(120) NOT NULL,
                github_repository_id BIGINT NOT NULL,
                status VARCHAR(32) NOT NULL,
                evidence_json JSON NOT NULL,
                reason TEXT,
                checked_at DATETIME NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_mission_verifications_user_mission UNIQUE (user_id, mission_id)
            );
            """
        )
        connection.execute(
            """
            WITH RECURSIVE slot_numbers(slot_number) AS (
                SELECT 1
                UNION ALL
                SELECT slot_number + 1
                FROM slot_numbers
                WHERE slot_number < 10000
            )
            INSERT INTO github_oauth_transaction_slots (slot_number)
            SELECT slot_number FROM slot_numbers
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
async def configured_github_client(tmp_path: Path) -> AsyncIterator[tuple[AsyncClient, object]]:
    database_path = tmp_path / "refocus-github-test.db"
    _create_schema(database_path)
    app = create_app(
        Settings(
            database_url=f"sqlite+aiosqlite:///{database_path.as_posix()}",
            app_origin=APP_ORIGIN,
            github_app_id="12345",
            github_client_id="github-client-id",
            github_client_secret="github-client-secret",
            github_private_key="not-used-by-the-fake-client",
        )
    )
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url=APP_ORIGIN,
        headers={"Origin": APP_ORIGIN},
        follow_redirects=False,
    ) as async_client:
        yield async_client, app

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
                """
                INSERT INTO users (
                    id, github_user_id, github_authorized_at,
                    github_verification_started_at, created_at
                ) VALUES (?, NULL, NULL, NULL, ?)
                """,
                (user_id.hex, _utc_sql_timestamp(now)),
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
