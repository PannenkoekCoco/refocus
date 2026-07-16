from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from fastapi.responses import JSONResponse

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
    GithubConfigurationResponse,
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


@router.get("/auth/github/login", response_model=GithubConfigurationResponse)
async def github_login(settings: SettingsDependency) -> JSONResponse:
    if not settings.github_is_configured:
        payload = GithubConfigurationResponse(code="github_not_configured")
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content=payload.model_dump())
    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content={"code": "github_login_not_implemented"},
    )
