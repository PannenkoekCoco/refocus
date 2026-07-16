from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.content_repository import ContentRepository
from app.database import get_database_session
from app.dependencies import CurrentUser, WriteCurrentUser
from app.schemas import (
    FocusLensInput,
    FocusLensPatch,
    FocusLensPreviewInput,
    FocusLensPreviewResponse,
    FocusLensesResponse,
    FocusLensView,
    SkillWeight,
)
from app.services.focus_lenses import (
    FocusLensConflictError,
    UnknownFocusTopicError,
    create_focus_lens,
    ensure_authored_skill_topics,
    get_focus_lens,
    list_focus_lenses,
    skill_weights_from_json,
    update_focus_lens,
)
from app.services.recommendations import preview_skill_weights


router = APIRouter()
DatabaseSession = Annotated[AsyncSession, Depends(get_database_session)]


def get_repository(request: Request) -> ContentRepository:
    return request.app.state.content_repository


Repository = Annotated[ContentRepository, Depends(get_repository)]


def _authored_topic_ids(repository: ContentRepository) -> set[str]:
    return {
        topic["id"]
        for topic in repository.topics()
        if isinstance(topic.get("id"), str)
    }


def _as_view(lens) -> FocusLensView:
    return FocusLensView(
        id=lens.id,
        kind=lens.kind,
        original_text=lens.original_text,
        skills=skill_weights_from_json(lens.skill_weights_json),
        is_active=lens.is_active,
        created_at=lens.created_at,
        updated_at=lens.updated_at,
    )


def _validate_authored_skills(skills: list[SkillWeight], repository: ContentRepository) -> None:
    try:
        ensure_authored_skill_topics(skills, _authored_topic_ids(repository))
    except UnknownFocusTopicError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unknown topic") from error


@router.post("/focus-lenses/preview", response_model=FocusLensPreviewResponse)
async def preview_focus_lens(
    payload: FocusLensPreviewInput,
    repository: Repository,
) -> FocusLensPreviewResponse:
    authored_topic_ids = _authored_topic_ids(repository)
    skills = [
        SkillWeight(topic_id=topic_id, weight=weight)
        for topic_id, weight in preview_skill_weights(payload.original_text).items()
        if topic_id in authored_topic_ids
    ]
    return FocusLensPreviewResponse(skills=skills)


@router.get("/focus-lenses", response_model=FocusLensesResponse)
async def read_focus_lenses(
    user: CurrentUser,
    database: DatabaseSession,
) -> FocusLensesResponse:
    lenses = await list_focus_lenses(database, user_id=user.id)
    return FocusLensesResponse(lenses=[_as_view(lens) for lens in lenses])


@router.post("/focus-lenses", response_model=FocusLensView, status_code=status.HTTP_201_CREATED)
async def save_focus_lens(
    payload: FocusLensInput,
    user: WriteCurrentUser,
    database: DatabaseSession,
    repository: Repository,
) -> FocusLensView:
    _validate_authored_skills(payload.skills, repository)
    try:
        lens = await create_focus_lens(database, user_id=user.id, payload=payload)
    except FocusLensConflictError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Focus lens update conflicted") from error
    return _as_view(lens)


@router.patch("/focus-lenses/{lens_id}", response_model=FocusLensView)
async def patch_focus_lens(
    lens_id: UUID,
    payload: FocusLensPatch,
    user: WriteCurrentUser,
    database: DatabaseSession,
    repository: Repository,
) -> FocusLensView:
    if payload.skills is not None:
        _validate_authored_skills(payload.skills, repository)
    lens = await get_focus_lens(database, user_id=user.id, lens_id=lens_id)
    if lens is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Focus lens not found")
    try:
        updated_lens = await update_focus_lens(database, lens=lens, payload=payload)
    except FocusLensConflictError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Focus lens update conflicted") from error
    return _as_view(updated_lens)
