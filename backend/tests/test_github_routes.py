import asyncio
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy import func, select, update

import app.services.github_client as github_client_module
from app.models import (
    GitHubOAuthTransaction,
    GitHubRepository,
    MissionVerification,
    Session,
    TopicProgress,
    User,
)
from app.security.sessions import new_session_token
from app.services.github_connections import OAuthTransactionLimitError, create_oauth_transaction
from app.services.github_client import (
    AuthorizationSnapshot,
    GitHubProviderUnavailableError,
    InstallationSnapshot,
    RepositorySnapshot,
)


class FakeRepositoryEvidence:
    def __init__(
        self,
        *,
        missing_file: str | None = None,
        matching_pull_request: bool = True,
        checks_passed: bool = True,
    ) -> None:
        self.missing_file = missing_file
        self.matching_pull_request = matching_pull_request
        self.checks_passed = checks_passed

    async def file_exists(self, repository_id: int, path: str) -> bool:
        assert repository_id == 42
        return path != self.missing_file

    async def has_matching_pull_request(
        self,
        repository_id: int,
        required_files: tuple[str, ...],
    ) -> bool:
        assert repository_id == 42
        assert required_files == ("backend/app/main.py", "README.md")
        return self.matching_pull_request

    async def default_branch_checks_passed(self, repository_id: int) -> bool:
        assert repository_id == 42
        return self.checks_passed


class FakeGitHub:
    def __init__(
        self,
        *,
        evidence: FakeRepositoryEvidence | None = None,
        snapshot: AuthorizationSnapshot | None = None,
        fail_evidence: bool = False,
    ) -> None:
        self.evidence = evidence or FakeRepositoryEvidence()
        self.snapshot = snapshot or AuthorizationSnapshot(
            github_user_id="99",
            installations=(
                InstallationSnapshot(
                    installation_id=7,
                    account_login="octo-org",
                    repositories=(RepositorySnapshot(42, "octo-org/refocus", "main"),),
                ),
            ),
        )
        self.fail_evidence = fail_evidence
        self.authorization_calls: list[tuple[str, str]] = []
        self.repository_calls: list[tuple[int, RepositorySnapshot]] = []

    async def authorization_snapshot(self, *, code: str, code_verifier: str) -> AuthorizationSnapshot:
        self.authorization_calls.append((code, code_verifier))
        return self.snapshot

    async def repository_client(
        self,
        *,
        installation_id: int,
        repository: RepositorySnapshot,
    ) -> FakeRepositoryEvidence:
        if self.fail_evidence:
            raise GitHubProviderUnavailableError()
        self.repository_calls.append((installation_id, repository))
        return self.evidence


class BlockingAuthorizationGitHub:
    def __init__(self) -> None:
        self.cancelled = asyncio.Event()

    async def authorization_snapshot(self, *, code: str, code_verifier: str) -> AuthorizationSnapshot:
        del code, code_verifier
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


class BlockingVerificationGitHub:
    def __init__(self) -> None:
        self.cancelled = asyncio.Event()

    async def repository_client(
        self,
        *,
        installation_id: int,
        repository: RepositorySnapshot,
    ) -> FakeRepositoryEvidence:
        del installation_id, repository
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


class CountBarrierSession:
    """Make the legacy read-before-write capacity race deterministic in a real database."""

    def __init__(self, database, barrier: asyncio.Barrier) -> None:
        self._database = database
        self._barrier = barrier

    async def execute(self, statement, *args, **kwargs):
        rendered_statement = str(statement)
        if rendered_statement.startswith("DELETE FROM github_oauth_transactions"):
            # The test database starts empty. Skipping this no-op mirrors PostgreSQL's
            # non-blocking read path instead of letting SQLite take an eager writer lock.
            return None
        result = await self._database.execute(statement, *args, **kwargs)
        if "count(" in rendered_statement and "github_oauth_transactions" in rendered_statement:
            # Release SQLite's shared read lock before both transactions continue to
            # the independent insert/commit phase. PostgreSQL's READ COMMITTED mode
            # permits this interleaving without the test harness.
            await self._database.rollback()
            await self._barrier.wait()
        return result

    def __getattr__(self, name: str):
        return getattr(self._database, name)


def github_authorization_params(response) -> dict[str, str]:
    location = response.headers["location"]
    parsed = urlparse(location)
    assert parsed.scheme == "https"
    assert parsed.netloc == "github.com"
    assert parsed.path == "/login/oauth/authorize"
    return {key: values[0] for key, values in parse_qs(parsed.query).items()}


async def start_github_authorization(client: AsyncClient) -> str:
    response = await client.get("/api/auth/github/login")
    assert response.status_code == 307
    return github_authorization_params(response)["state"]


async def connect_github(client: AsyncClient, app, fake: FakeGitHub) -> None:
    app.state.github_client_factory = lambda _settings: fake
    state = await start_github_authorization(client)
    response = await client.get(
        "/api/auth/github/callback",
        params={"state": state, "code": "opaque-code"},
    )
    assert response.status_code == 307
    assert response.headers["location"] == "http://testserver/"


async def other_authenticated_client(app) -> AsyncClient:
    token, token_hash = new_session_token()
    async with app.state.session_factory() as database:
        user = User()
        database.add(user)
        await database.flush()
        database.add(
            Session(
                user_id=user.id,
                token_hash=token_hash,
                expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
        )
        await database.commit()
    client = AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
        headers={"Origin": "http://testserver"},
    )
    client.cookies.set("refocus_session", token)
    return client


@pytest.mark.asyncio
async def test_github_login_uses_pkce_a_single_use_hashed_state_and_http_only_transaction_cookies(
    configured_github_client,
) -> None:
    client, app = configured_github_client

    response = await client.get("/api/auth/github/login")

    assert response.status_code == 307
    params = github_authorization_params(response)
    assert set(params) == {
        "client_id",
        "redirect_uri",
        "state",
        "code_challenge",
        "code_challenge_method",
    }
    assert params["client_id"] == "github-client-id"
    assert params["redirect_uri"] == "http://testserver/api/auth/github/callback"
    assert params["code_challenge_method"] == "S256"
    assert len(params["state"]) >= 43
    assert len(params["code_challenge"]) == 43
    assert "repo" not in response.headers["location"]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["referrer-policy"] == "no-referrer"
    set_cookies = "\n".join(response.headers.get_list("set-cookie")).lower()
    assert "refocus_github_oauth_state=" in set_cookies
    assert "refocus_github_pkce_verifier=" in set_cookies
    assert "httponly" in set_cookies
    assert "samesite=lax" in set_cookies
    assert "secure" not in set_cookies

    async with app.state.session_factory() as database:
        transaction = (await database.execute(select(GitHubOAuthTransaction))).scalar_one()

    assert transaction.state_hash != params["state"]
    assert len(transaction.state_hash) == 64
    assert transaction.consumed_at is None
    assert transaction.expires_at.replace(tzinfo=UTC) > datetime.now(UTC)


@pytest.mark.asyncio
async def test_github_callback_creates_an_opaque_app_session_and_persists_only_the_safe_snapshot(
    configured_github_client,
) -> None:
    client, app = configured_github_client
    fake = FakeGitHub()
    app.state.github_client_factory = lambda _settings: fake
    state = await start_github_authorization(client)
    verifier = client.cookies.get("refocus_github_pkce_verifier")

    response = await client.get(
        "/api/auth/github/callback",
        params={"state": state, "code": "opaque-code"},
    )

    assert response.status_code == 307
    assert response.headers["location"] == "http://testserver/"
    assert response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert fake.authorization_calls == [("opaque-code", verifier)]
    set_cookies = "\n".join(response.headers.get_list("set-cookie")).lower()
    assert "refocus_session=" in set_cookies
    assert "httponly" in set_cookies
    assert "samesite=lax" in set_cookies
    assert "access_token" not in set_cookies
    assert "refresh_token" not in set_cookies
    assert "opaque-code" not in response.text

    session_token = client.cookies.get("refocus_session")
    async with app.state.session_factory() as database:
        user = (await database.execute(select(User))).scalar_one()
        installation = (await database.execute(select(GitHubRepository))).scalar_one()
        session = (await database.execute(select(Session))).scalar_one()
        transaction_count = (
            await database.execute(select(func.count(GitHubOAuthTransaction.id)))
        ).scalar_one()

    assert user.github_user_id == "99"
    assert not hasattr(user, "github_login")
    assert installation.github_repository_id == 42
    assert session.token_hash != session_token
    assert transaction_count == 0
    assert (await client.get("/api/me")).json()["user"] == {
        "id": str(user.id),
        "githubConnected": True,
    }


@pytest.mark.asyncio
async def test_github_callback_links_the_signed_in_refocus_user_to_the_stable_github_identity(
    configured_github_client,
) -> None:
    client, app = configured_github_client
    async with app.state.session_factory() as database:
        existing_user = User()
        database.add(existing_user)
        await database.flush()
        database.add(TopicProgress(user_id=existing_user.id, topic_id="apis", status="explored"))
        raw_session_token, session_token_hash = new_session_token()
        database.add(
            Session(
                user_id=existing_user.id,
                token_hash=session_token_hash,
                expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
        )
        existing_user_id = existing_user.id
        await database.commit()

    client.cookies.set("refocus_session", raw_session_token)
    fake = FakeGitHub()
    app.state.github_client_factory = lambda _settings: fake
    state = await start_github_authorization(client)

    async with app.state.session_factory() as database:
        transaction = (await database.execute(select(GitHubOAuthTransaction))).scalar_one()
    assert transaction.user_id == existing_user_id

    response = await client.get(
        "/api/auth/github/callback",
        params={"state": state, "code": "opaque-code"},
    )
    assert response.status_code == 307

    async with app.state.session_factory() as database:
        linked_user = (await database.execute(select(User))).scalar_one()
        progress = (await database.execute(select(TopicProgress))).scalar_one()
        sessions = (await database.execute(select(Session))).scalars().all()

    assert linked_user.id == existing_user_id
    assert linked_user.github_user_id == "99"
    assert linked_user.github_authorized_at is not None
    assert progress.user_id == existing_user_id
    assert [session.token_hash for session in sessions] == [session_token_hash]
    assert client.cookies.get("refocus_session") == raw_session_token


@pytest.mark.asyncio
async def test_github_callback_rejects_a_pending_link_after_logout(configured_github_client) -> None:
    _configured_client, app = configured_github_client
    client = await other_authenticated_client(app)
    try:
        fake = FakeGitHub()
        app.state.github_client_factory = lambda _settings: fake
        state = await start_github_authorization(client)

        assert (await client.post("/api/auth/logout")).status_code == 204
        callback = await client.get(
            "/api/auth/github/callback",
            params={"state": state, "code": "opaque-code"},
        )

        assert callback.status_code == 307
        assert callback.headers["location"] == "http://testserver/"
        assert fake.authorization_calls == []
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_github_callback_rejects_a_pending_link_after_switching_refocus_accounts(
    configured_github_client,
) -> None:
    _configured_client, app = configured_github_client
    first_client = await other_authenticated_client(app)
    second_client = await other_authenticated_client(app)
    try:
        fake = FakeGitHub()
        app.state.github_client_factory = lambda _settings: fake
        state = await start_github_authorization(first_client)
        first_client.cookies.set("refocus_session", second_client.cookies.get("refocus_session"))

        callback = await first_client.get(
            "/api/auth/github/callback",
            params={"state": state, "code": "opaque-code"},
        )

        assert callback.status_code == 307
        assert callback.headers["location"] == "http://testserver/"
        assert fake.authorization_calls == []
    finally:
        await first_client.aclose()
        await second_client.aclose()


@pytest.mark.asyncio
async def test_disconnect_cancels_a_pending_github_link_before_any_provider_request(
    configured_github_client,
) -> None:
    _configured_client, app = configured_github_client
    client = await other_authenticated_client(app)
    try:
        app.state.settings.github_oauth_max_pending_transactions = 1
        fake = FakeGitHub()
        app.state.github_client_factory = lambda _settings: fake
        state = await start_github_authorization(client)

        assert (await client.delete("/api/github/connection")).status_code == 204
        replacement = await client.get("/api/auth/github/login")
        callback = await client.get(
            "/api/auth/github/callback",
            params={"state": state, "code": "opaque-code"},
        )

        assert replacement.status_code == 307
        assert callback.status_code == 307
        assert callback.headers["location"] == "http://testserver/"
        assert fake.authorization_calls == []
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_github_login_removes_expired_transactions_and_bounds_open_transactions(
    configured_github_client,
) -> None:
    client, app = configured_github_client
    first_state = await start_github_authorization(client)
    async with app.state.session_factory() as database:
        await database.execute(
            update(GitHubOAuthTransaction).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await database.commit()

    second_state = await start_github_authorization(client)
    async with app.state.session_factory() as database:
        transactions = (await database.execute(select(GitHubOAuthTransaction))).scalars().all()
    assert len(transactions) == 1
    assert transactions[0].state_hash != first_state
    assert transactions[0].state_hash != second_state

    app.state.settings.github_oauth_max_pending_transactions = 1
    other = AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
        follow_redirects=False,
    )
    try:
        saturated = await other.get("/api/auth/github/login")
    finally:
        await other.aclose()
    assert saturated.status_code == 429


@pytest.mark.asyncio
async def test_parallel_github_logins_are_database_bounded_and_busy_starts_never_return_500(
    configured_github_client,
) -> None:
    _client, app = configured_github_client
    app.state.settings.github_oauth_max_pending_transactions = 2
    clients = [
        AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
            follow_redirects=False,
        )
        for _ in range(8)
    ]
    start = asyncio.Event()

    async def begin(client: AsyncClient):
        await start.wait()
        return await client.get("/api/auth/github/login")

    tasks = [asyncio.create_task(begin(client)) for client in clients]
    await asyncio.sleep(0)
    start.set()
    try:
        responses = await asyncio.gather(*tasks)
    finally:
        await asyncio.gather(*(client.aclose() for client in clients))

    status_codes = [response.status_code for response in responses]
    assert status_codes.count(307) == 2
    assert status_codes.count(429) == 6
    assert set(status_codes) <= {307, 429}
    async with app.state.session_factory() as database:
        transaction_count = (
            await database.execute(select(func.count(GitHubOAuthTransaction.id)))
        ).scalar_one()
    assert transaction_count == 2


@pytest.mark.asyncio
async def test_oauth_capacity_claim_remains_atomic_when_legacy_count_reads_interleave(
    configured_github_client,
) -> None:
    _client, app = configured_github_client
    barrier = asyncio.Barrier(2)
    async with app.state.session_factory() as first_database, app.state.session_factory() as second_database:
        first = CountBarrierSession(first_database, barrier)
        second = CountBarrierSession(second_database, barrier)

        async def begin(database, state: str) -> str:
            try:
                await create_oauth_transaction(
                    database,
                    state=state,
                    max_age_seconds=60,
                    user_id=None,
                    previous_state=None,
                    max_pending_transactions=1,
                )
            except OAuthTransactionLimitError:
                return "full"
            return "created"

        results = await asyncio.gather(
            begin(first, "first-state"),
            begin(second, "second-state"),
            return_exceptions=True,
        )

    assert results.count("created") == 1
    assert results.count("full") == 1
    assert not any(isinstance(result, Exception) for result in results)
    async with app.state.session_factory() as database:
        transaction_count = (
            await database.execute(select(func.count(GitHubOAuthTransaction.id)))
        ).scalar_one()
    assert transaction_count == 1


@pytest.mark.asyncio
async def test_github_callback_uses_the_hard_operation_deadline_and_cleans_its_transaction(
    configured_github_client,
    monkeypatch,
) -> None:
    client, app = configured_github_client
    blocking = BlockingAuthorizationGitHub()
    app.state.github_client_factory = lambda _settings: blocking
    app.state.settings.github_callback_timeout_seconds = 60
    monkeypatch.setattr(
        github_client_module,
        "MAX_GITHUB_OPERATION_TIMEOUT_SECONDS",
        0.01,
        raising=False,
    )
    state = await start_github_authorization(client)

    response = await asyncio.wait_for(
        client.get(
            "/api/auth/github/callback",
            params={"state": state, "code": "opaque-code"},
        ),
        timeout=0.2,
    )

    assert response.status_code == 307
    assert response.headers["location"] == "http://testserver/"
    assert "opaque-code" not in response.text
    await asyncio.wait_for(blocking.cancelled.wait(), timeout=0.1)
    assert client.cookies.get("refocus_github_oauth_state") is None
    assert client.cookies.get("refocus_github_pkce_verifier") is None
    async with app.state.session_factory() as database:
        transaction_count = (
            await database.execute(select(func.count(GitHubOAuthTransaction.id)))
        ).scalar_one()
    assert transaction_count == 0


@pytest.mark.asyncio
async def test_mission_verification_uses_the_hard_operation_deadline(
    configured_github_client,
    monkeypatch,
) -> None:
    client, app = configured_github_client
    await connect_github(client, app, FakeGitHub())
    assert (await client.put("/api/github/repositories/42")).status_code == 200
    blocking = BlockingVerificationGitHub()
    app.state.github_client_factory = lambda _settings: blocking
    app.state.settings.github_verification_timeout_seconds = 60
    monkeypatch.setattr(
        github_client_module,
        "MAX_GITHUB_OPERATION_TIMEOUT_SECONDS",
        0.01,
        raising=False,
    )

    response = await asyncio.wait_for(
        client.post("/api/missions/api-service-v1/verify", json={}),
        timeout=0.2,
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "needs_attention",
        "evidence": [],
        "reason": "GitHub evidence could not be checked right now.",
    }
    await asyncio.wait_for(blocking.cancelled.wait(), timeout=0.1)


@pytest.mark.asyncio
async def test_github_callback_rejects_mismatched_expired_replayed_and_denied_transactions_without_leaking_provider_data(
    configured_github_client,
) -> None:
    client, app = configured_github_client
    fake = FakeGitHub()
    app.state.github_client_factory = lambda _settings: fake

    state = await start_github_authorization(client)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
        follow_redirects=False,
    ) as mismatched_client:
        mismatched_client.cookies.set("refocus_github_oauth_state", "wrong-state")
        mismatched_client.cookies.set("refocus_github_pkce_verifier", "wrong-verifier")
        mismatch = await mismatched_client.get(
            "/api/auth/github/callback",
            params={"state": state, "code": "opaque-code"},
        )
    assert mismatch.status_code == 307
    assert mismatch.headers["location"] == "http://testserver/"
    assert fake.authorization_calls == []

    async with app.state.session_factory() as database:
        await database.execute(
            update(GitHubOAuthTransaction).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await database.commit()
    expired = await client.get(
        "/api/auth/github/callback",
        params={"state": state, "code": "opaque-code"},
    )
    assert expired.status_code == 307
    assert expired.headers["location"] == "http://testserver/"
    assert fake.authorization_calls == []

    denied_state = await start_github_authorization(client)
    denied = await client.get(
        "/api/auth/github/callback",
        params={
            "state": denied_state,
            "error": "access_denied",
            "error_description": "raw provider detail",
        },
    )
    assert denied.status_code == 307
    assert denied.headers["location"] == "http://testserver/"
    assert "access_denied" not in denied.headers["location"]
    assert "raw provider detail" not in denied.text
    assert fake.authorization_calls == []

    success_state = await start_github_authorization(client)
    successful = await client.get(
        "/api/auth/github/callback",
        params={"state": success_state, "code": "opaque-code"},
    )
    replay = await client.get(
        "/api/auth/github/callback",
        params={"state": success_state, "code": "opaque-code"},
    )
    assert successful.status_code == 307
    assert replay.status_code == 307
    assert replay.headers["location"] == "http://testserver/"
    assert len(fake.authorization_calls) == 1


@pytest.mark.asyncio
async def test_github_connection_snapshot_and_repository_selection_are_user_owned(configured_github_client) -> None:
    client, app = configured_github_client
    fake = FakeGitHub()
    await connect_github(client, app, fake)

    snapshot = await client.get("/api/github/installations")
    selected = await client.put("/api/github/repositories/42", json={"repositoryUrl": "https://attacker.example"})
    unknown = await client.put("/api/github/repositories/999")
    refreshed = await client.get("/api/github/installations")
    other = await other_authenticated_client(app)
    try:
        outsider_snapshot = await other.get("/api/github/installations")
        outsider_select = await other.put("/api/github/repositories/42")
    finally:
        await other.aclose()

    assert snapshot.status_code == 200
    assert snapshot.json() == {
        "connected": True,
        "installations": [{
            "id": 7,
            "accountLogin": "octo-org",
            "repositories": [{
                "id": 42,
                "fullName": "octo-org/refocus",
                "defaultBranch": "main",
                "selected": False,
            }],
        }],
    }
    assert selected.status_code == 200
    assert selected.json() == {
        "id": 42,
        "fullName": "octo-org/refocus",
        "defaultBranch": "main",
        "selected": True,
    }
    assert unknown.status_code == 404
    assert refreshed.json()["installations"][0]["repositories"][0]["selected"] is True
    assert outsider_snapshot.json() == {"connected": False, "installations": []}
    assert outsider_select.status_code == 404


@pytest.mark.asyncio
async def test_github_connection_writes_require_an_authenticated_same_origin_session(configured_github_client) -> None:
    client, app = configured_github_client
    anonymous = AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")
    try:
        assert (await anonymous.get("/api/github/installations")).status_code == 401
        assert (await anonymous.put("/api/github/repositories/42")).status_code == 401
        assert (await anonymous.delete("/api/github/connection")).status_code == 401
        assert (await anonymous.post("/api/missions/api-service-v1/verify", json={})).status_code == 401
    finally:
        await anonymous.aclose()

    await connect_github(client, app, FakeGitHub())
    client.headers["Origin"] = "https://attacker.example"
    assert (await client.put("/api/github/repositories/42")).status_code == 403
    assert (await client.delete("/api/github/connection")).status_code == 403
    assert (await client.post("/api/missions/api-service-v1/verify", json={})).status_code == 403


@pytest.mark.asyncio
async def test_stale_github_authorization_cannot_list_select_or_verify_snapshot_repositories(
    configured_github_client,
) -> None:
    client, app = configured_github_client
    fake = FakeGitHub()
    await connect_github(client, app, fake)
    assert (await client.put("/api/github/repositories/42")).status_code == 200

    async with app.state.session_factory() as database:
        await database.execute(
            update(User).values(github_authorized_at=datetime.now(UTC) - timedelta(minutes=16))
        )
        await database.commit()

    installations = await client.get("/api/github/installations")
    me = await client.get("/api/me")
    selection = await client.put("/api/github/repositories/42")
    verification = await client.post("/api/missions/api-service-v1/verify", json={})

    assert installations.json() == {"connected": False, "installations": []}
    assert me.json()["user"]["githubConnected"] is False
    assert selection.status_code == 404
    assert verification.status_code == 409
    assert fake.repository_calls == []


@pytest.mark.asyncio
async def test_github_verification_is_rate_limited_per_user_before_another_token_is_minted(
    configured_github_client,
) -> None:
    client, app = configured_github_client
    fake = FakeGitHub()
    await connect_github(client, app, fake)
    assert (await client.put("/api/github/repositories/42")).status_code == 200

    first = await client.post("/api/missions/api-service-v1/verify", json={})
    second = await client.post("/api/missions/api-service-v1/verify", json={})

    assert first.status_code == 200
    assert second.status_code == 429
    assert fake.repository_calls == [(7, RepositorySnapshot(42, "octo-org/refocus", "main"))]


@pytest.mark.asyncio
async def test_mission_verification_uses_only_authored_evidence_and_upserts_the_user_owned_result(
    configured_github_client,
) -> None:
    client, app = configured_github_client
    evidence = FakeRepositoryEvidence()
    fake = FakeGitHub(evidence=evidence)
    await connect_github(client, app, fake)
    assert (await client.put("/api/github/repositories/42")).status_code == 200

    verified = await client.post("/api/missions/api-service-v1/verify", json={})
    unsafe_body = await client.post(
        "/api/missions/api-service-v1/verify",
        json={"evidence": {"requiredFiles": ["anything"]}},
    )
    async with app.state.session_factory() as database:
        await database.execute(
            update(User).values(
                github_verification_started_at=datetime.now(UTC) - timedelta(minutes=2)
            )
        )
        await database.commit()
    evidence.missing_file = "README.md"
    needs_attention = await client.post("/api/missions/api-service-v1/verify", json={})
    unknown = await client.post("/api/missions/unknown-mission/verify", json={})

    assert verified.status_code == 200
    assert verified.json() == {
        "status": "verified",
        "evidence": [
            "Required files found",
            "Matching pull request found",
            "Latest default-branch checks passed",
        ],
        "reason": None,
    }
    assert fake.repository_calls == [
        (7, RepositorySnapshot(42, "octo-org/refocus", "main")),
        (7, RepositorySnapshot(42, "octo-org/refocus", "main")),
    ]
    assert unsafe_body.status_code == 422
    assert needs_attention.json() == {
        "status": "needs_attention",
        "evidence": [],
        "reason": "Required file missing: README.md",
    }
    assert unknown.status_code == 404

    async with app.state.session_factory() as database:
        records = (await database.execute(select(MissionVerification))).scalars().all()
    assert len(records) == 1
    assert records[0].status == "needs_attention"
    assert records[0].reason == "Required file missing: README.md"


@pytest.mark.asyncio
async def test_verification_requires_a_selected_snapshot_repository_and_disconnect_removes_it(
    configured_github_client,
) -> None:
    client, app = configured_github_client
    fake = FakeGitHub(fail_evidence=True)
    await connect_github(client, app, fake)

    no_repository = await client.post("/api/missions/api-service-v1/verify", json={})
    assert no_repository.status_code == 409
    assert fake.repository_calls == []

    assert (await client.put("/api/github/repositories/42")).status_code == 200
    unavailable = await client.post("/api/missions/api-service-v1/verify", json={})
    disconnected = await client.delete("/api/github/connection")
    after_disconnect = await client.post("/api/missions/api-service-v1/verify", json={})

    assert unavailable.status_code == 200
    assert unavailable.json() == {
        "status": "needs_attention",
        "evidence": [],
        "reason": "GitHub evidence could not be checked right now.",
    }
    assert disconnected.status_code == 204
    assert (await client.get("/api/github/installations")).json() == {
        "connected": False,
        "installations": [],
    }
    assert after_disconnect.status_code == 409

    async with app.state.session_factory() as database:
        assert (await database.execute(select(func.count(GitHubRepository.id)))).scalar_one() == 0
        assert (await database.execute(select(func.count(MissionVerification.id)))).scalar_one() == 0
