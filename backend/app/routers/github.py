from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Response, status

from app.dependencies import CurrentUser, DatabaseSession, SettingsDependency, WriteCurrentUser
from app.models import GitHubRepository
from app.schemas import (
    GitHubInstallationView,
    GitHubInstallationsResponse,
    GitHubRepositoryView,
)
from app.services.github_connections import (
    disconnect_github,
    github_authorization_is_fresh,
    list_installations,
    select_owned_repository,
)


router = APIRouter()
RepositoryId = Annotated[int, Path(ge=1)]


def _repository_view(repository: GitHubRepository) -> GitHubRepositoryView:
    return GitHubRepositoryView(
        id=repository.github_repository_id,
        full_name=repository.full_name,
        default_branch=repository.default_branch,
        selected=repository.is_selected,
    )


@router.get("/github/installations", response_model=GitHubInstallationsResponse)
async def github_installations(
    user: CurrentUser,
    database: DatabaseSession,
    settings: SettingsDependency,
) -> GitHubInstallationsResponse:
    if not github_authorization_is_fresh(
        user,
        max_age_seconds=settings.github_authorization_max_age_seconds,
    ):
        return GitHubInstallationsResponse(connected=False, installations=[])
    installations = await list_installations(database, user_id=user.id)
    return GitHubInstallationsResponse(
        connected=True,
        installations=[
            GitHubInstallationView(
                id=installation.github_installation_id,
                account_login=installation.account_login,
                repositories=[_repository_view(repository) for repository in repositories],
            )
            for installation, repositories in installations
        ],
    )


@router.put("/github/repositories/{repository_id}", response_model=GitHubRepositoryView)
async def select_github_repository(
    repository_id: RepositoryId,
    user: WriteCurrentUser,
    database: DatabaseSession,
    settings: SettingsDependency,
) -> GitHubRepositoryView:
    if not github_authorization_is_fresh(
        user,
        max_age_seconds=settings.github_authorization_max_age_seconds,
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Repository not found")
    repository = await select_owned_repository(
        database,
        user_id=user.id,
        github_repository_id=repository_id,
    )
    if repository is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Repository not found")
    return _repository_view(repository)


@router.delete("/github/connection", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_github_connection(
    user: WriteCurrentUser,
    database: DatabaseSession,
) -> Response:
    await disconnect_github(database, user=user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
