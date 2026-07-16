from datetime import UTC, datetime
import json
from urllib.parse import parse_qs

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
import pytest

from app.config import Settings
from app.services.github_client import (
    GitHubClient,
    GitHubForbiddenError,
    GitHubNotConfiguredError,
    GitHubNotFoundError,
    GitHubProviderUnavailableError,
    GitHubRateLimitedError,
    GitHubRequestTimeoutError,
    GitHubRepositoryClient,
    GitHubUnauthorizedError,
    RepositorySnapshot,
    create_app_jwt,
)
from app.services.github_verifier import verify_mission


class FakeGitHub:
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
        self.deployment_calls = 0

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


EVIDENCE = {
    "requiredFiles": ["backend/app/main.py", "README.md"],
    "requirePullRequest": True,
    "requirePassingChecks": True,
    "requireDeploymentUrl": False,
}


@pytest.mark.asyncio
async def test_verifier_reports_the_specific_missing_file() -> None:
    result = await verify_mission(
        client=FakeGitHub(missing_file="README.md"),
        repository_id=42,
        evidence=EVIDENCE,
        deployment_url=None,
    )

    assert result.status == "needs_attention"
    assert result.evidence == []
    assert result.reason == "Required file missing: README.md"


@pytest.mark.asyncio
async def test_verifier_requires_a_pull_request_that_covers_the_authored_files() -> None:
    result = await verify_mission(
        client=FakeGitHub(matching_pull_request=False),
        repository_id=42,
        evidence=EVIDENCE,
        deployment_url=None,
    )

    assert result.status == "needs_attention"
    assert result.reason == "No matching pull request found for this mission."


@pytest.mark.asyncio
async def test_verifier_treats_missing_or_failing_default_branch_checks_conservatively() -> None:
    result = await verify_mission(
        client=FakeGitHub(checks_passed=False),
        repository_id=42,
        evidence=EVIDENCE,
        deployment_url=None,
    )

    assert result.status == "needs_attention"
    assert result.reason == "Latest default-branch checks have not passed."


@pytest.mark.asyncio
async def test_verifier_only_syntax_checks_a_required_deployment_url() -> None:
    evidence = {**EVIDENCE, "requireDeploymentUrl": True}
    result = await verify_mission(
        client=FakeGitHub(),
        repository_id=42,
        evidence=evidence,
        deployment_url="not-a-url",
    )

    assert result.status == "needs_attention"
    assert result.reason == "Add a valid deployment URL before verification."


@pytest.mark.asyncio
async def test_verifier_returns_only_authored_generic_evidence_when_all_checks_pass() -> None:
    result = await verify_mission(
        client=FakeGitHub(),
        repository_id=42,
        evidence=EVIDENCE,
        deployment_url=None,
    )

    assert result.status == "verified"
    assert result.evidence == [
        "Required files found",
        "Matching pull request found",
        "Latest default-branch checks passed",
    ]
    assert result.reason is None


def generated_private_key() -> str:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")


def github_settings(private_key: str | None = None) -> Settings:
    return Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        app_origin="http://testserver",
        github_app_id="12345",
        github_client_id="github-client-id",
        github_client_secret="github-client-secret",
        github_private_key=private_key or generated_private_key(),
    )


class RecordingHttpClientFactory:
    def __init__(self, handler) -> None:
        self.handler = handler
        self.kwargs: dict[str, object] | None = None

    def __call__(self, **kwargs):
        self.kwargs = kwargs
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler), **kwargs)


def test_app_jwt_uses_rs256_and_a_short_lived_app_identity() -> None:
    private_key = generated_private_key()
    settings = github_settings(private_key)
    now = datetime.now(UTC)

    token = create_app_jwt(settings, now)
    public_key = serialization.load_pem_private_key(
        private_key.encode("utf-8"), password=None
    ).public_key()
    claims = jwt.decode(token, public_key, algorithms=["RS256"])

    assert claims["iss"] == "12345"
    assert claims["iat"] == int(now.timestamp()) - 30
    assert claims["exp"] == int(now.timestamp()) + 9 * 60


def test_app_jwt_refuses_to_start_without_app_credentials() -> None:
    settings = Settings(database_url="sqlite+aiosqlite:///:memory:")

    with pytest.raises(GitHubNotConfiguredError):
        create_app_jwt(settings, datetime.now(UTC))


@pytest.mark.asyncio
async def test_authorization_snapshot_uses_only_fixed_github_endpoints_and_discards_user_tokens() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url == httpx.URL("https://github.com/login/oauth/access_token"):
            form = parse_qs(request.content.decode("utf-8"))
            assert form == {
                "client_id": ["github-client-id"],
                "client_secret": ["github-client-secret"],
                "code": ["opaque-code"],
                "redirect_uri": ["http://testserver/api/auth/github/callback"],
                "code_verifier": ["pkce-verifier"],
            }
            return httpx.Response(
                200,
                json={"access_token": "user-access-token", "refresh_token": "refresh-token"},
            )
        if request.url == httpx.URL("https://api.github.com/user"):
            assert request.headers["authorization"] == "Bearer user-access-token"
            return httpx.Response(200, json={"id": 99, "login": "mutable-login"})
        if request.url == httpx.URL("https://api.github.com/user/installations?per_page=100&page=1"):
            return httpx.Response(
                200,
                json={"installations": [{"id": 7, "account": {"login": "octo-org"}}]},
            )
        if request.url == httpx.URL(
            "https://api.github.com/user/installations/7/repositories?per_page=100&page=1"
        ):
            return httpx.Response(
                200,
                json={
                    "repositories": [
                        {"id": 42, "full_name": "octo-org/refocus", "default_branch": "main"}
                    ]
                },
            )
        raise AssertionError(f"Unexpected GitHub request: {request.url}")

    factory = RecordingHttpClientFactory(handler)
    snapshot = await GitHubClient(github_settings(), http_client_factory=factory).authorization_snapshot(
        code="opaque-code",
        code_verifier="pkce-verifier",
    )

    assert snapshot.github_user_id == "99"
    assert snapshot.installations[0].installation_id == 7
    assert snapshot.installations[0].account_login == "octo-org"
    assert snapshot.installations[0].repositories[0].repository_id == 42
    assert snapshot.installations[0].repositories[0].full_name == "octo-org/refocus"
    assert "user-access-token" not in repr(snapshot)
    assert "refresh-token" not in repr(snapshot)
    assert factory.kwargs is not None
    assert factory.kwargs["follow_redirects"] is False
    timeout = factory.kwargs["timeout"]
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.connect == 5
    assert timeout.read == 15
    assert {request.url.host for request in requests} == {"github.com", "api.github.com"}
    assert {request.headers["x-github-api-version"] for request in requests if request.url.host == "api.github.com"} == {
        "2026-03-10"
    }


@pytest.mark.asyncio
async def test_authorization_snapshot_rejects_callback_time_snapshots_beyond_the_explicit_budget() -> None:
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_paths.append(request.url.path)
        if request.url == httpx.URL("https://github.com/login/oauth/access_token"):
            return httpx.Response(200, json={"access_token": "user-access-token"})
        if request.url == httpx.URL("https://api.github.com/user"):
            return httpx.Response(200, json={"id": 99})
        if request.url.path == "/user/installations":
            return httpx.Response(
                200,
                json={
                    "total_count": 11,
                    "installations": [
                        {"id": installation_id, "account": {"login": f"org-{installation_id}"}}
                        for installation_id in range(1, 12)
                    ],
                },
            )
        raise AssertionError(f"Unexpected GitHub request: {request.url}")

    with pytest.raises(GitHubProviderUnavailableError):
        await GitHubClient(
            github_settings(),
            http_client_factory=RecordingHttpClientFactory(handler),
        ).authorization_snapshot(code="opaque-code", code_verifier="pkce-verifier")

    assert requested_paths == ["/login/oauth/access_token", "/user", "/user/installations"]


@pytest.mark.asyncio
async def test_authorization_snapshot_excludes_enterprise_installations_that_cannot_be_repo_scoped() -> None:
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_paths.append(request.url.path)
        if request.url == httpx.URL("https://github.com/login/oauth/access_token"):
            return httpx.Response(200, json={"access_token": "user-access-token"})
        if request.url == httpx.URL("https://api.github.com/user"):
            return httpx.Response(200, json={"id": 99})
        if request.url.path == "/user/installations":
            return httpx.Response(
                200,
                json={
                    "installations": [
                        {"id": 7, "target_type": "Enterprise", "account": {"login": "enterprise"}},
                        {"id": 8, "target_type": "Organization", "account": {"login": "octo-org"}},
                    ],
                },
            )
        if request.url.path == "/user/installations/8/repositories":
            return httpx.Response(
                200,
                json={
                    "repositories": [
                        {"id": 42, "full_name": "octo-org/refocus", "default_branch": "main"}
                    ],
                },
            )
        raise AssertionError(f"Unexpected GitHub request: {request.url}")

    snapshot = await GitHubClient(
        github_settings(),
        http_client_factory=RecordingHttpClientFactory(handler),
    ).authorization_snapshot(code="opaque-code", code_verifier="pkce-verifier")

    assert [installation.installation_id for installation in snapshot.installations] == [8]
    assert "/user/installations/7/repositories" not in requested_paths


@pytest.mark.asyncio
async def test_installation_token_is_repository_scoped_and_only_requests_read_permissions() -> None:
    received_body: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url == httpx.URL("https://api.github.com/app/installations/7/access_tokens")
        assert request.headers["authorization"].startswith("Bearer ")
        received_body.update(json.loads(request.content))
        return httpx.Response(201, json={"token": "ghs_variable_length_token"})

    token = await GitHubClient(
        github_settings(),
        http_client_factory=RecordingHttpClientFactory(handler),
    ).installation_access_token(installation_id=7, repository_id=42)

    assert token == "ghs_variable_length_token"
    assert received_body == {
        "repository_ids": [42],
        "permissions": {
            "metadata": "read",
            "contents": "read",
            "pull_requests": "read",
            "checks": "read",
            "statuses": "read",
        },
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "error_type"),
    [
        (401, GitHubUnauthorizedError),
        (403, GitHubForbiddenError),
        (404, GitHubNotFoundError),
        (429, GitHubRateLimitedError),
        (500, GitHubProviderUnavailableError),
    ],
)
async def test_github_http_errors_are_typed_without_provider_response_details(
    status_code: int,
    error_type: type[Exception],
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, text="provider details must stay private")

    client = GitHubClient(github_settings(), http_client_factory=RecordingHttpClientFactory(handler))

    with pytest.raises(error_type) as raised:
        await client.authorization_snapshot(code="opaque-code", code_verifier="pkce-verifier")

    assert "provider details" not in str(raised.value)
    assert "opaque-code" not in str(raised.value)


@pytest.mark.asyncio
async def test_github_timeouts_are_translated_without_a_raw_transport_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("network path", request=_request)

    client = GitHubClient(github_settings(), http_client_factory=RecordingHttpClientFactory(handler))

    with pytest.raises(GitHubRequestTimeoutError) as raised:
        await client.authorization_snapshot(code="opaque-code", code_verifier="pkce-verifier")

    assert "network path" not in str(raised.value)


@pytest.mark.asyncio
async def test_repository_client_requires_a_pull_request_with_all_authored_files() -> None:
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_paths.append(request.url.path)
        assert request.method == "GET"
        if request.url.path == "/repos/octo-org/refocus/pulls":
            return httpx.Response(200, json=[{"number": 1}, {"number": 2}])
        if request.url.path == "/repos/octo-org/refocus/pulls/1/files":
            return httpx.Response(200, json=[{"filename": "README.md"}])
        if request.url.path == "/repos/octo-org/refocus/pulls/2/files":
            return httpx.Response(
                200,
                json=[{"filename": "README.md"}, {"filename": "backend/app/main.py"}],
            )
        raise AssertionError(f"Unexpected GitHub request: {request.url}")

    client = GitHubRepositoryClient(
        access_token="transient-installation-token",
        repository=RepositorySnapshot(42, "octo-org/refocus", "main"),
        http_client_factory=RecordingHttpClientFactory(handler),
    )

    assert await client.has_matching_pull_request(
        42,
        ("backend/app/main.py", "README.md"),
    ) is True
    assert requested_paths == [
        "/repos/octo-org/refocus/pulls",
        "/repos/octo-org/refocus/pulls/1/files",
        "/repos/octo-org/refocus/pulls/2/files",
    ]


@pytest.mark.asyncio
async def test_repository_client_does_not_treat_a_directory_as_an_authored_required_file() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo-org/refocus/contents/README.md"
        return httpx.Response(200, json=[])

    client = GitHubRepositoryClient(
        access_token="transient-installation-token",
        repository=RepositorySnapshot(42, "octo-org/refocus", "main"),
        http_client_factory=RecordingHttpClientFactory(handler),
    )

    assert await client.file_exists(42, "README.md") is False


@pytest.mark.asyncio
async def test_repository_client_fails_closed_when_pull_request_evidence_exceeds_its_request_budget() -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        if request.url.path == "/repos/octo-org/refocus/pulls":
            return httpx.Response(200, json=[{"number": number} for number in range(1, 101)])
        if request.url.path.startswith("/repos/octo-org/refocus/pulls/"):
            return httpx.Response(200, json=[{"filename": "not-the-required-file"}])
        raise AssertionError(f"Unexpected GitHub request: {request.url}")

    client = GitHubRepositoryClient(
        access_token="transient-installation-token",
        repository=RepositorySnapshot(42, "octo-org/refocus", "main"),
        http_client_factory=RecordingHttpClientFactory(handler),
    )

    with pytest.raises(GitHubProviderUnavailableError):
        await client.has_matching_pull_request(42, ("README.md",))

    assert len(requests) == client._MAX_EVIDENCE_REQUESTS


@pytest.mark.asyncio
async def test_repository_client_uses_only_the_latest_default_branch_commit_for_checks() -> None:
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_paths.append(request.url.path)
        assert request.method == "GET"
        if request.url.path == "/repos/octo-org/refocus/commits/main":
            return httpx.Response(200, json={"sha": "default-branch-commit"})
        if request.url.path == "/repos/octo-org/refocus/commits/default-branch-commit/check-runs":
            return httpx.Response(
                200,
                json={"check_runs": [{"status": "completed", "conclusion": "success"}]},
            )
        if request.url.path == "/repos/octo-org/refocus/commits/default-branch-commit/status":
            return httpx.Response(200, json={"statuses": [{"state": "success"}]})
        raise AssertionError(f"Unexpected GitHub request: {request.url}")

    client = GitHubRepositoryClient(
        access_token="transient-installation-token",
        repository=RepositorySnapshot(42, "octo-org/refocus", "main"),
        http_client_factory=RecordingHttpClientFactory(handler),
    )

    assert await client.default_branch_checks_passed(42) is True
    assert requested_paths == [
        "/repos/octo-org/refocus/commits/main",
        "/repos/octo-org/refocus/commits/default-branch-commit/check-runs",
        "/repos/octo-org/refocus/commits/default-branch-commit/status",
    ]


@pytest.mark.asyncio
async def test_repository_client_reads_every_default_branch_check_page_before_verifying() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo-org/refocus/commits/main":
            return httpx.Response(200, json={"sha": "default-branch-commit"})
        if request.url.path.endswith("/check-runs"):
            assert request.url.params["per_page"] == "100"
            if request.url.params["page"] == "1":
                return httpx.Response(
                    200,
                    json={
                        "total_count": 101,
                        "check_runs": [
                            {"status": "completed", "conclusion": "success"}
                            for _ in range(100)
                        ],
                    },
                )
            if request.url.params["page"] == "2":
                return httpx.Response(
                    200,
                    json={
                        "total_count": 101,
                        "check_runs": [{"status": "completed", "conclusion": "failure"}],
                    },
                )
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"statuses": [{"state": "success"}]})
        raise AssertionError(f"Unexpected GitHub request: {request.url}")

    client = GitHubRepositoryClient(
        access_token="transient-installation-token",
        repository=RepositorySnapshot(42, "octo-org/refocus", "main"),
        http_client_factory=RecordingHttpClientFactory(handler),
    )

    assert await client.default_branch_checks_passed(42) is False


@pytest.mark.asyncio
async def test_repository_client_reads_every_default_branch_commit_status_page_before_verifying() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo-org/refocus/commits/main":
            return httpx.Response(200, json={"sha": "default-branch-commit"})
        if request.url.path.endswith("/check-runs"):
            return httpx.Response(
                200,
                json={"check_runs": [{"status": "completed", "conclusion": "success"}]},
            )
        if request.url.path.endswith("/status"):
            assert request.url.params["per_page"] == "100"
            if request.url.params["page"] == "1":
                return httpx.Response(
                    200,
                    json={
                        "total_count": 101,
                        "statuses": [{"state": "success"} for _ in range(100)],
                    },
                )
            if request.url.params["page"] == "2":
                return httpx.Response(
                    200,
                    json={"total_count": 101, "statuses": [{"state": "pending"}]},
                )
        raise AssertionError(f"Unexpected GitHub request: {request.url}")

    client = GitHubRepositoryClient(
        access_token="transient-installation-token",
        repository=RepositorySnapshot(42, "octo-org/refocus", "main"),
        http_client_factory=RecordingHttpClientFactory(handler),
    )

    assert await client.default_branch_checks_passed(42) is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("check_runs", "statuses"),
    [([], []), ([{"status": "completed", "conclusion": "failure"}], []), ([{"status": "in_progress", "conclusion": None}], []), ([], [{"state": "failure"}]), ([], [{"state": "pending"}])],
)
async def test_repository_client_does_not_treat_absent_pending_or_failed_checks_as_verified(
    check_runs: list[dict[str, object]],
    statuses: list[dict[str, object]],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo-org/refocus/commits/main":
            return httpx.Response(200, json={"sha": "default-branch-commit"})
        if request.url.path.endswith("/check-runs"):
            return httpx.Response(200, json={"check_runs": check_runs})
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"statuses": statuses})
        raise AssertionError(f"Unexpected GitHub request: {request.url}")

    client = GitHubRepositoryClient(
        access_token="transient-installation-token",
        repository=RepositorySnapshot(42, "octo-org/refocus", "main"),
        http_client_factory=RecordingHttpClientFactory(handler),
    )

    assert await client.default_branch_checks_passed(42) is False
