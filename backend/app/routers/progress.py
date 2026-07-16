from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_database_session
from app.dependencies import CurrentUser, WriteCurrentUser
from app.progress_service import create_quiz_attempt, get_topic_progress, upsert_topic_progress
from app.schemas import (
    QuizAnswerInput,
    QuizAttemptInput,
    QuizAttemptView,
    TopicProgressInput,
    TopicProgressView,
)


router = APIRouter()
DatabaseSession = Annotated[AsyncSession, Depends(get_database_session)]
TopicId = Annotated[
    str,
    Path(min_length=1, max_length=80, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$"),
]


@router.put("/topic/{topic_id}", response_model=TopicProgressView)
async def save_topic_progress(
    topic_id: TopicId,
    payload: TopicProgressInput,
    user: WriteCurrentUser,
    database: DatabaseSession,
) -> TopicProgressView:
    progress = await upsert_topic_progress(
        database,
        user_id=user.id,
        topic_id=topic_id,
        status=payload.status,
    )
    return TopicProgressView(
        id=progress.id,
        topic_id=progress.topic_id,
        status=progress.status,
        updated_at=progress.updated_at,
    )


@router.get("/topics/{topic_id}", response_model=TopicProgressView)
async def read_topic_progress(
    topic_id: TopicId,
    user: CurrentUser,
    database: DatabaseSession,
) -> TopicProgressView:
    progress = await get_topic_progress(database, user_id=user.id, topic_id=topic_id)
    if progress is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Progress not found")
    return TopicProgressView(
        id=progress.id,
        topic_id=progress.topic_id,
        status=progress.status,
        updated_at=progress.updated_at,
    )


@router.post("/quiz-attempts", response_model=QuizAttemptView)
async def save_quiz_attempt(
    payload: QuizAttemptInput,
    response: Response,
    user: WriteCurrentUser,
    database: DatabaseSession,
) -> QuizAttemptView:
    quiz_attempt, created = await create_quiz_attempt(database, user_id=user.id, payload=payload)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return QuizAttemptView(
        id=quiz_attempt.id,
        lesson_id=quiz_attempt.lesson_id,
        answers=[QuizAnswerInput.model_validate(answer) for answer in quiz_attempt.answers_json],
        created_at=quiz_attempt.created_at,
    )
