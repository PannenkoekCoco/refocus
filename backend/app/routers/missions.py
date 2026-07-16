import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request, status

from app.content_repository import ContentRepository
from app.dependencies import DatabaseSession, SettingsDependency, WriteCurrentUser
from app.schemas import MissionVerificationInput, MissionVerificationView
from app.services.github_client import (
    GitHubClient,
    GitHubClientError,
    RepositorySnapshot,
)
from app.services.github_connections import (
    github_authorization_is_fresh,
    reserve_github_verification,
    selected_owned_repository,
    upsert_verification,
)
from app.services.github_verifier import VerificationResult, verify_mission


router = APIRouter()
MissionId = Annotated[
    str,
    Path(min_length=1, max_length=120, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$"),
]


def get_repository(request: Request) -> ContentRepository:
    return request.app.state.content_repository


Repository = Annotated[ContentRepository, Depends(get_repository)]


def _github_client(request: Request, settings: SettingsDependency):
    factory = getattr(request.app.state, "github_client_factory", GitHubClient)
    return factory(settings)


@router.post("/missions/{mission_id}/verify", response_model=MissionVerificationView)
async def verify_portfolio_mission(
    mission_id: MissionId,
    payload: MissionVerificationInput,
    request: Request,
    user: WriteCurrentUser,
    database: DatabaseSession,
    settings: SettingsDependency,
    repository: Repository,
) -> MissionVerificationView:
    mission = repository.mission(mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    evidence = mission.get("evidence")
    if not isinstance(evidence, dict):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    if not github_authorization_is_fresh(
        user,
        max_age_seconds=settings.github_authorization_max_age_seconds,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Refresh GitHub authorization before verification.",
        )

    owned_repository = await selected_owned_repository(database, user_id=user.id)
    if owned_repository is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Select a connected GitHub repository before verification.",
        )
    selected_repository, installation = owned_repository
    if not await reserve_github_verification(
        database,
        user_id=user.id,
        minimum_interval_seconds=settings.github_verification_min_interval_seconds,
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Wait before checking GitHub evidence again.",
        )
    repository_snapshot = RepositorySnapshot(
        repository_id=selected_repository.github_repository_id,
        full_name=selected_repository.full_name,
        default_branch=selected_repository.default_branch,
    )
    try:
        async with asyncio.timeout(settings.github_verification_timeout_seconds):
            evidence_client = await _github_client(request, settings).repository_client(
                installation_id=installation.github_installation_id,
                repository=repository_snapshot,
            )
            result = await verify_mission(
                client=evidence_client,
                repository_id=selected_repository.github_repository_id,
                evidence=evidence,
                deployment_url=payload.deployment_url,
            )
    except (GitHubClientError, TimeoutError, ValueError):
        result = VerificationResult(
            status="needs_attention",
            evidence=[],
            reason="GitHub evidence could not be checked right now.",
        )
    persisted = await upsert_verification(
        database,
        user_id=user.id,
        mission_id=mission_id,
        github_repository_id=selected_repository.github_repository_id,
        result=result,
    )
    if persisted is None:
        result = VerificationResult(
            status="needs_attention",
            evidence=[],
            reason="GitHub connection changed before verification could be saved.",
        )
    return MissionVerificationView(
        status=result.status,
        evidence=result.evidence,
        reason=result.reason,
    )
