from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.database import get_database_session
from app.models import Session, User
from app.security.sessions import session_token_hash


DatabaseSession = Annotated[AsyncSession, Depends(get_database_session)]


@dataclass(frozen=True)
class CurrentSession:
    user: User
    session: Session


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


SettingsDependency = Annotated[Settings, Depends(get_settings)]


async def get_current_session(request: Request, database: DatabaseSession) -> CurrentSession | None:
    settings = get_settings(request)
    raw_token = request.cookies.get(settings.session_cookie_name)
    if not raw_token or len(raw_token) > 512:
        return None

    result = await database.execute(
        select(Session, User)
        .join(User, Session.user_id == User.id)
        .where(
            Session.token_hash == session_token_hash(raw_token),
            Session.revoked_at.is_(None),
            Session.expires_at > datetime.now(UTC),
        )
        .limit(1)
    )
    row = result.one_or_none()
    if row is None:
        return None
    session, user = row
    return CurrentSession(user=user, session=session)


async def get_current_user(
    request: Request,
    database: DatabaseSession,
) -> User | None:
    current_session = await get_current_session(request, database)
    return current_session.user if current_session is not None else None


async def require_current_user(current_user: Annotated[User | None, Depends(get_current_user)]) -> User:
    if current_user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return current_user


async def require_same_origin_current_user(
    request: Request,
    current_user: Annotated[User, Depends(require_current_user)],
) -> User:
    expected_origin = get_settings(request).app_origin.rstrip("/")
    actual_origin = request.headers.get("origin", "").rstrip("/")
    if not actual_origin or actual_origin != expected_origin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid request origin")
    return current_user


async def require_same_origin_current_session(
    request: Request,
    database: DatabaseSession,
    current_user: Annotated[User, Depends(require_same_origin_current_user)],
) -> CurrentSession:
    current_session = await get_current_session(request, database)
    if current_session is None or current_session.user.id != current_user.id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return current_session


CurrentUser = Annotated[User, Depends(require_current_user)]
WriteCurrentUser = Annotated[User, Depends(require_same_origin_current_user)]
WriteCurrentSession = Annotated[CurrentSession, Depends(require_same_origin_current_session)]
