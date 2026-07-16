from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.content_repository import ContentRepository
from app.database import get_database_session
from app.dependencies import CurrentUser
from app.models import QuizAttempt
from app.schemas import RecommendationView
from app.services.focus_lenses import active_focus_weights
from app.services.recommendations import aggregate_mastery, recommend_next


router = APIRouter()
DatabaseSession = Annotated[AsyncSession, Depends(get_database_session)]
PinnedTopicId = Annotated[
    str | None,
    Query(
        alias="pinnedTopicId",
        min_length=2,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    ),
]


def get_repository(request: Request) -> ContentRepository:
    return request.app.state.content_repository


Repository = Annotated[ContentRepository, Depends(get_repository)]


@router.get("/recommendations/next", response_model=RecommendationView)
async def read_next_recommendation(
    user: CurrentUser,
    database: DatabaseSession,
    repository: Repository,
    pinned_topic_id: PinnedTopicId = None,
) -> RecommendationView:
    topics = repository.topics()
    authored_topic_ids = {
        topic["id"]
        for topic in topics
        if isinstance(topic.get("id"), str)
    }
    if pinned_topic_id is not None and pinned_topic_id not in authored_topic_ids:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unknown topic")

    lens_weights = await active_focus_weights(database, user_id=user.id)
    attempt_rows = await database.execute(
        select(QuizAttempt.lesson_id, QuizAttempt.answers_json).where(QuizAttempt.user_id == user.id)
    )
    mastery = aggregate_mastery(
        attempts=[(lesson_id, answers) for lesson_id, answers in attempt_rows.all()],
        lesson_topic_ids=repository.lesson_topic_ids(),
    )
    recommendation = recommend_next(
        topics=topics,
        pinned_topic_id=pinned_topic_id,
        development_weights=lens_weights["development"],
        job_weights=lens_weights["job"],
        mastery=mastery,
    )
    return RecommendationView(
        topic_id=recommendation.topic_id,
        reason=recommendation.reason,
        advisory_prerequisites=recommendation.advisory_prerequisites,
    )
