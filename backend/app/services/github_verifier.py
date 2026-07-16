from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Mapping, Protocol
from urllib.parse import urlparse


VerificationStatus = Literal["verified", "needs_attention"]


class MissionEvidenceClient(Protocol):
    async def file_exists(self, repository_id: int, path: str) -> bool: ...

    async def has_matching_pull_request(
        self,
        repository_id: int,
        required_files: tuple[str, ...],
    ) -> bool: ...

    async def default_branch_checks_passed(self, repository_id: int) -> bool: ...


@dataclass(frozen=True)
class VerificationResult:
    status: VerificationStatus
    evidence: list[str]
    reason: str | None = None


def _required_files(evidence: Mapping[str, object]) -> tuple[str, ...]:
    files = evidence.get("requiredFiles")
    if not isinstance(files, list) or not all(isinstance(path, str) and path for path in files):
        raise ValueError("Mission evidence must define authored required files")
    return tuple(files)


def _requires(evidence: Mapping[str, object], field: str) -> bool:
    value = evidence.get(field)
    if not isinstance(value, bool):
        raise ValueError("Mission evidence has an invalid requirement")
    return value


def _is_valid_deployment_url(value: str | None) -> bool:
    if not isinstance(value, str) or len(value) > 2_048:
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


async def verify_mission(
    *,
    client: MissionEvidenceClient,
    repository_id: int,
    evidence: Mapping[str, object],
    deployment_url: str | None,
) -> VerificationResult:
    """Evaluate only authored mission evidence without executing code or fetching URLs."""
    required_files = _required_files(evidence)
    for path in required_files:
        if not await client.file_exists(repository_id, path):
            return VerificationResult(
                status="needs_attention",
                evidence=[],
                reason=f"Required file missing: {path}",
            )

    confirmed_evidence = ["Required files found"] if required_files else []
    if _requires(evidence, "requirePullRequest"):
        if not await client.has_matching_pull_request(repository_id, required_files):
            return VerificationResult(
                status="needs_attention",
                evidence=confirmed_evidence,
                reason="No matching pull request found for this mission.",
            )
        confirmed_evidence.append("Matching pull request found")

    if _requires(evidence, "requirePassingChecks"):
        if not await client.default_branch_checks_passed(repository_id):
            return VerificationResult(
                status="needs_attention",
                evidence=confirmed_evidence,
                reason="Latest default-branch checks have not passed.",
            )
        confirmed_evidence.append("Latest default-branch checks passed")

    if _requires(evidence, "requireDeploymentUrl") and not _is_valid_deployment_url(deployment_url):
        return VerificationResult(
            status="needs_attention",
            evidence=confirmed_evidence,
            reason="Add a valid deployment URL before verification.",
        )

    return VerificationResult(status="verified", evidence=confirmed_evidence)
