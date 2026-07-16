from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from app.dependencies import (
    DatabaseSession,
    SettingsDependency,
    WriteCurrentSession,
    get_current_user,
)
from app.models import User, utcnow
from app.schemas import (
    AnonymousMeResponse,
    AuthenticatedMeResponse,
    GithubLoginNotEnabledResponse,
    GithubNotConfiguredResponse,
    UserView,
)


router = APIRouter()


@router.get("/me", response_model=AnonymousMeResponse | AuthenticatedMeResponse)
async def me(
    current_user: Annotated[User | None, Depends(get_current_user)],
) -> AnonymousMeResponse | AuthenticatedMeResponse:
    if current_user is None:
        return AnonymousMeResponse()
    return AuthenticatedMeResponse(user=UserView(id=current_user.id, github_login=current_user.github_login))


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    current_session: WriteCurrentSession,
    database: DatabaseSession,
) -> Response:
    current_session.session.revoked_at = utcnow()
    await database.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/auth/github/login",
    status_code=status.HTTP_501_NOT_IMPLEMENTED,
    response_model=GithubNotConfiguredResponse | GithubLoginNotEnabledResponse,
    responses={
        status.HTTP_501_NOT_IMPLEMENTED: {"model": GithubLoginNotEnabledResponse},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"model": GithubNotConfiguredResponse},
    },
)
async def github_login(
    response: Response,
    settings: SettingsDependency,
) -> GithubNotConfiguredResponse | GithubLoginNotEnabledResponse:
    if not settings.github_is_configured:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return GithubNotConfiguredResponse(code="github_not_configured")
    return GithubLoginNotEnabledResponse(code="github_login_not_enabled")
