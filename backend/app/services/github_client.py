from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

import httpx
import jwt

from app.config import Settings


GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_API_URL = "https://api.github.com"
GITHUB_API_VERSION = "2026-03-10"
GITHUB_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
READ_ONLY_GITHUB_PERMISSIONS = {
    "metadata": "read",
    "contents": "read",
    "pull_requests": "read",
    "checks": "read",
    "statuses": "read",
}


class GitHubClientError(Exception):
    message = "GitHub could not be contacted."

    def __init__(self) -> None:
        super().__init__(self.message)


class GitHubNotConfiguredError(GitHubClientError):
    message = "GitHub is not configured."


class GitHubUnauthorizedError(GitHubClientError):
    message = "GitHub authorization was not accepted."


class GitHubForbiddenError(GitHubClientError):
    message = "GitHub did not allow this request."


class GitHubNotFoundError(GitHubClientError):
    message = "GitHub could not find the requested resource."


class GitHubRateLimitedError(GitHubClientError):
    message = "GitHub is temporarily unavailable."


class GitHubProviderUnavailableError(GitHubClientError):
    message = "GitHub is temporarily unavailable."


class GitHubRequestTimeoutError(GitHubClientError):
    message = "GitHub did not respond in time."


@dataclass(frozen=True)
class RepositorySnapshot:
    repository_id: int
    full_name: str
    default_branch: str


@dataclass(frozen=True)
class InstallationSnapshot:
    installation_id: int
    account_login: str
    repositories: tuple[RepositorySnapshot, ...]


@dataclass(frozen=True)
class AuthorizationSnapshot:
    github_user_id: str
    installations: tuple[InstallationSnapshot, ...]


HttpClientFactory = Callable[..., httpx.AsyncClient]


def create_app_jwt(settings: Settings, now: datetime) -> str:
    if not settings.github_app_id or settings.github_private_key is None:
        raise GitHubNotConfiguredError()
    payload = {
        "iat": int((now - timedelta(seconds=30)).timestamp()),
        "exp": int((now + timedelta(minutes=9)).timestamp()),
        "iss": settings.github_app_id,
    }
    return jwt.encode(
        payload,
        settings.github_private_key.get_secret_value(),
        algorithm="RS256",
    )


def _github_headers(*, token: str | None = None) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _error_for_status(status_code: int) -> GitHubClientError:
    if status_code == 401:
        return GitHubUnauthorizedError()
    if status_code == 403:
        return GitHubForbiddenError()
    if status_code == 404:
        return GitHubNotFoundError()
    if status_code == 429:
        return GitHubRateLimitedError()
    return GitHubProviderUnavailableError()


async def _request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    **kwargs: object,
) -> httpx.Response:
    try:
        response = await client.request(method, url, **kwargs)
    except httpx.TimeoutException as error:
        raise GitHubRequestTimeoutError() from error
    except httpx.HTTPError as error:
        raise GitHubProviderUnavailableError() from error
    if not 200 <= response.status_code < 300:
        raise _error_for_status(response.status_code)
    return response


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as error:
        raise GitHubProviderUnavailableError() from error
    if not isinstance(payload, dict):
        raise GitHubProviderUnavailableError()
    return payload


def _required_string(payload: dict[str, Any], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value:
        raise GitHubProviderUnavailableError()
    return value


def _required_positive_integer(payload: dict[str, Any], field: str) -> int:
    value = payload.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise GitHubProviderUnavailableError()
    return value


class GitHubClient:
    """Fixed-host, short-lived GitHub App requests with no token persistence."""

    _PAGE_SIZE = 100
    _MAX_SNAPSHOT_PAGES = 10
    _MAX_SNAPSHOT_INSTALLATIONS = 10
    _MAX_REPOSITORIES_PER_INSTALLATION = 50

    def __init__(
        self,
        settings: Settings,
        *,
        http_client_factory: HttpClientFactory = httpx.AsyncClient,
    ) -> None:
        self._settings = settings
        self._http_client_factory = http_client_factory

    @property
    def _callback_url(self) -> str:
        return self._settings.github_callback_url

    def _open_client(self) -> httpx.AsyncClient:
        return self._http_client_factory(
            follow_redirects=False,
            timeout=GITHUB_TIMEOUT,
        )

    async def _snapshot_pages(
        self,
        client: httpx.AsyncClient,
        *,
        url: str,
        user_access_token: str,
        item_field: str,
        max_items: int,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page = 1
        expected_pages: int | None = None
        while True:
            response = await _request(
                client,
                "GET",
                url,
                headers=_github_headers(token=user_access_token),
                params={"per_page": self._PAGE_SIZE, "page": page},
            )
            payload = _json_object(response)
            page_items = payload.get(item_field)
            if not isinstance(page_items, list) or not all(
                isinstance(item, dict) for item in page_items
            ):
                raise GitHubProviderUnavailableError()
            items.extend(page_items)
            if len(items) > max_items:
                raise GitHubProviderUnavailableError()
            if expected_pages is None:
                total_count = payload.get("total_count")
                if isinstance(total_count, int) and not isinstance(total_count, bool) and total_count >= 0:
                    if total_count > max_items:
                        raise GitHubProviderUnavailableError()
                    expected_pages = max(1, (total_count + self._PAGE_SIZE - 1) // self._PAGE_SIZE)
                    if expected_pages > self._MAX_SNAPSHOT_PAGES:
                        raise GitHubProviderUnavailableError()
                elif len(page_items) < self._PAGE_SIZE:
                    return items
            if expected_pages is not None and page >= expected_pages:
                return items
            if expected_pages is None and len(page_items) < self._PAGE_SIZE:
                return items
            if page >= self._MAX_SNAPSHOT_PAGES:
                raise GitHubProviderUnavailableError()
            page += 1

    async def authorization_snapshot(
        self,
        *,
        code: str,
        code_verifier: str,
    ) -> AuthorizationSnapshot:
        if not self._settings.github_is_configured:
            raise GitHubNotConfiguredError()
        async with self._open_client() as client:
            token_response = await _request(
                client,
                "POST",
                GITHUB_ACCESS_TOKEN_URL,
                headers={"Accept": "application/json"},
                data={
                    "client_id": self._settings.github_client_id,
                    "client_secret": self._settings.github_client_secret.get_secret_value()
                    if self._settings.github_client_secret is not None
                    else "",
                    "code": code,
                    "redirect_uri": self._callback_url,
                    "code_verifier": code_verifier,
                },
            )
            user_access_token = _required_string(_json_object(token_response), "access_token")
            user_response = await _request(
                client,
                "GET",
                f"{GITHUB_API_URL}/user",
                headers=_github_headers(token=user_access_token),
            )
            user_payload = _json_object(user_response)
            github_user_id = str(_required_positive_integer(user_payload, "id"))
            raw_installations = await self._snapshot_pages(
                client,
                url=f"{GITHUB_API_URL}/user/installations",
                user_access_token=user_access_token,
                item_field="installations",
                max_items=self._MAX_SNAPSHOT_INSTALLATIONS,
            )

            installations: list[InstallationSnapshot] = []
            for raw_installation in raw_installations:
                installation_id = _required_positive_integer(raw_installation, "id")
                if raw_installation.get("target_type") == "Enterprise":
                    # GitHub cannot scope Enterprise installation tokens to one repository.
                    continue
                account = raw_installation.get("account")
                if not isinstance(account, dict):
                    raise GitHubProviderUnavailableError()
                account_login = _required_string(account, "login")
                raw_repositories = await self._snapshot_pages(
                    client,
                    url=f"{GITHUB_API_URL}/user/installations/{installation_id}/repositories",
                    user_access_token=user_access_token,
                    item_field="repositories",
                    max_items=self._MAX_REPOSITORIES_PER_INSTALLATION,
                )
                repositories = tuple(
                    RepositorySnapshot(
                        repository_id=_required_positive_integer(repository, "id"),
                        full_name=_required_string(repository, "full_name"),
                        default_branch=_required_string(repository, "default_branch"),
                    )
                    for repository in raw_repositories
                )
                installations.append(
                    InstallationSnapshot(
                        installation_id=installation_id,
                        account_login=account_login,
                        repositories=repositories,
                    )
                )
            return AuthorizationSnapshot(
                github_user_id=github_user_id,
                installations=tuple(installations),
            )

    async def installation_access_token(
        self,
        *,
        installation_id: int,
        repository_id: int,
    ) -> str:
        if installation_id < 1 or repository_id < 1:
            raise GitHubNotFoundError()
        app_jwt = create_app_jwt(self._settings, datetime.now(UTC))
        async with self._open_client() as client:
            response = await _request(
                client,
                "POST",
                f"{GITHUB_API_URL}/app/installations/{installation_id}/access_tokens",
                headers=_github_headers(token=app_jwt),
                json={
                    "repository_ids": [repository_id],
                    "permissions": READ_ONLY_GITHUB_PERMISSIONS,
                },
            )
            return _required_string(_json_object(response), "token")

    async def repository_client(
        self,
        *,
        installation_id: int,
        repository: RepositorySnapshot,
    ) -> "GitHubRepositoryClient":
        access_token = await self.installation_access_token(
            installation_id=installation_id,
            repository_id=repository.repository_id,
        )
        return GitHubRepositoryClient(
            access_token=access_token,
            repository=repository,
            http_client_factory=self._http_client_factory,
        )


class GitHubRepositoryClient:
    """Read-only evidence reader for one already-authorized repository."""

    _PAGE_SIZE = 100
    _MAX_PAGES = 10
    _MAX_EVIDENCE_REQUESTS = 40
    _PASSING_CHECK_CONCLUSIONS = frozenset({"success", "neutral", "skipped"})

    def __init__(
        self,
        *,
        access_token: str,
        repository: RepositorySnapshot,
        http_client_factory: HttpClientFactory = httpx.AsyncClient,
    ) -> None:
        self._access_token = access_token
        self._repository = repository
        self._http_client_factory = http_client_factory
        self._remaining_evidence_requests = self._MAX_EVIDENCE_REQUESTS

    def _open_client(self) -> httpx.AsyncClient:
        return self._http_client_factory(
            follow_redirects=False,
            timeout=GITHUB_TIMEOUT,
        )

    def _repository_path(self, repository_id: int) -> str:
        if repository_id != self._repository.repository_id:
            raise GitHubNotFoundError()
        owner_and_name = self._repository.full_name.split("/")
        if len(owner_and_name) != 2 or any(not value or value in {".", ".."} for value in owner_and_name):
            raise GitHubNotFoundError()
        owner, name = (quote(value, safe="") for value in owner_and_name)
        return f"{owner}/{name}"

    @staticmethod
    def _authored_path(path: str) -> str:
        parts = path.split("/")
        if not path or path.startswith("/") or any(not part or part in {".", ".."} for part in parts):
            raise GitHubNotFoundError()
        return "/".join(quote(part, safe="") for part in parts)

    async def _get_json(
        self,
        client: httpx.AsyncClient,
        path: str,
        *,
        params: dict[str, object] | None = None,
    ) -> object:
        if self._remaining_evidence_requests <= 0:
            raise GitHubProviderUnavailableError()
        self._remaining_evidence_requests -= 1
        response = await _request(
            client,
            "GET",
            f"{GITHUB_API_URL}{path}",
            headers=_github_headers(token=self._access_token),
            params=params,
        )
        try:
            return response.json()
        except ValueError as error:
            raise GitHubProviderUnavailableError() from error

    async def _all_commit_evidence_pages(
        self,
        client: httpx.AsyncClient,
        path: str,
        item_field: str,
    ) -> list[dict[str, Any]]:
        """Read every bounded check/status page instead of treating a first page as complete."""
        items: list[dict[str, Any]] = []
        expected_pages: int | None = None
        for page in range(1, self._MAX_PAGES + 1):
            payload = await self._get_json(
                client,
                path,
                params={"per_page": self._PAGE_SIZE, "page": page},
            )
            if not isinstance(payload, dict):
                raise GitHubProviderUnavailableError()
            page_items = payload.get(item_field)
            if not isinstance(page_items, list) or not all(
                isinstance(item, dict) for item in page_items
            ):
                raise GitHubProviderUnavailableError()
            items.extend(page_items)

            total_count = payload.get("total_count")
            if isinstance(total_count, int) and not isinstance(total_count, bool) and total_count >= 0:
                expected_pages = max(1, (total_count + self._PAGE_SIZE - 1) // self._PAGE_SIZE)
                if expected_pages > self._MAX_PAGES:
                    raise GitHubProviderUnavailableError()
            if expected_pages is not None and page >= expected_pages:
                return items
            if expected_pages is None and len(page_items) < self._PAGE_SIZE:
                return items
        raise GitHubProviderUnavailableError()

    async def file_exists(self, repository_id: int, path: str) -> bool:
        repository_path = self._repository_path(repository_id)
        authored_path = self._authored_path(path)
        try:
            async with self._open_client() as client:
                content = await self._get_json(
                    client,
                    f"/repos/{repository_path}/contents/{authored_path}",
                )
        except GitHubNotFoundError:
            return False
        if isinstance(content, list):
            return False
        if not isinstance(content, dict):
            raise GitHubProviderUnavailableError()
        return content.get("type") == "file"

    async def has_matching_pull_request(
        self,
        repository_id: int,
        required_files: tuple[str, ...],
    ) -> bool:
        repository_path = self._repository_path(repository_id)
        required_file_set = set(required_files)
        if not required_file_set:
            return True
        async with self._open_client() as client:
            for pull_page in range(1, self._MAX_PAGES + 1):
                pulls = await self._get_json(
                    client,
                    f"/repos/{repository_path}/pulls",
                    params={
                        "state": "all",
                        "per_page": self._PAGE_SIZE,
                        "page": pull_page,
                        "sort": "updated",
                        "direction": "desc",
                    },
                )
                if not isinstance(pulls, list):
                    raise GitHubProviderUnavailableError()
                for pull_request in pulls:
                    if not isinstance(pull_request, dict):
                        raise GitHubProviderUnavailableError()
                    pull_number = _required_positive_integer(pull_request, "number")
                    changed_files = await self._pull_request_files(
                        client,
                        repository_path,
                        pull_number,
                    )
                    if required_file_set.issubset(changed_files):
                        return True
                if len(pulls) < self._PAGE_SIZE:
                    return False
        return False

    async def _pull_request_files(
        self,
        client: httpx.AsyncClient,
        repository_path: str,
        pull_number: int,
    ) -> set[str]:
        changed_files: set[str] = set()
        for page in range(1, self._MAX_PAGES + 1):
            files = await self._get_json(
                client,
                f"/repos/{repository_path}/pulls/{pull_number}/files",
                params={"per_page": self._PAGE_SIZE, "page": page},
            )
            if not isinstance(files, list):
                raise GitHubProviderUnavailableError()
            for file in files:
                if not isinstance(file, dict):
                    raise GitHubProviderUnavailableError()
                changed_files.add(_required_string(file, "filename"))
            if len(files) < self._PAGE_SIZE:
                break
        return changed_files

    async def default_branch_checks_passed(self, repository_id: int) -> bool:
        repository_path = self._repository_path(repository_id)
        default_branch = self._authored_path(self._repository.default_branch)
        async with self._open_client() as client:
            commit = await self._get_json(
                client,
                f"/repos/{repository_path}/commits/{default_branch}",
            )
            if not isinstance(commit, dict):
                raise GitHubProviderUnavailableError()
            commit_sha = _required_string(commit, "sha")
            check_runs = await self._all_commit_evidence_pages(
                client,
                f"/repos/{repository_path}/commits/{quote(commit_sha, safe='')}/check-runs",
                "check_runs",
            )
            for check_run in check_runs:
                if check_run.get("status") != "completed":
                    return False
                if check_run.get("conclusion") not in self._PASSING_CHECK_CONCLUSIONS:
                    return False
            statuses = await self._all_commit_evidence_pages(
                client,
                f"/repos/{repository_path}/commits/{quote(commit_sha, safe='')}/status",
                "statuses",
            )

        if not check_runs and not statuses:
            return False
        for status in statuses:
            if status.get("state") != "success":
                return False
        return True
