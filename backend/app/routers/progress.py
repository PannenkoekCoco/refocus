from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.content_repository import ContentRepository
from app.database import get_database_session
from app.dependencies import CurrentUser, WriteCurrentUser
from app.models import MissionProgress, TopicProgress
from app.progress_service import (
    create_quiz_attempt,
    get_progress_snapshot,
    get_topic_progress,
    upsert_mission_progress,
    upsert_topic_progress,
)
from app.schemas import (
    MissionProgressInput,
    MissionProgressView,
    ProgressSnapshotView,
    QuizAnswerInput,
    QuizAttemptInput,
    QuizAttemptView,
    QuizOutcomeView,
    TopicProgressInput,
    TopicProgressView,
)


router = APIRouter()
DatabaseSession = Annotated[AsyncSession, Depends(get_database_session)]
TopicId = Annotated[
    str,
    Path(min_length=1, max_length=80, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$"),
]
MissionId = Annotated[
    str,
    Path(min_length=1, max_length=120, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$"),
]


def get_repository(request: Request) -> ContentRepository:
    return request.app.state.content_repository


Repository = Annotated[ContentRepository, Depends(get_repository)]


def topic_progress_view(progress: TopicProgress) -> TopicProgressView:
    return TopicProgressView(
        id=progress.id,
        topic_id=progress.topic_id,
        status=progress.status,
        updated_at=progress.updated_at,
    )


def mission_progress_view(progress: MissionProgress) -> MissionProgressView:
    return MissionProgressView(
        id=progress.id,
        mission_id=progress.mission_id,
        approach=progress.approach,
        reflection=progress.reflection,
        status=progress.status,
        updated_at=progress.updated_at,
    )


@router.get("", response_model=ProgressSnapshotView)
async def read_progress_snapshot(
    user: CurrentUser,
    database: DatabaseSession,
) -> ProgressSnapshotView:
    snapshot = await get_progress_snapshot(database, user_id=user.id)
    return ProgressSnapshotView(
        topics=[topic_progress_view(progress) for progress in snapshot.topics],
        quiz_attempts=[
            QuizOutcomeView(
                lesson_id=outcome.lesson_id,
                correct=outcome.correct,
                total=outcome.total,
            )
            for outcome in snapshot.quiz_outcomes
        ],
        missions=[mission_progress_view(progress) for progress in snapshot.missions],
    )


@router.put("/missions/{mission_id}", response_model=MissionProgressView)
async def save_mission_progress(
    mission_id: MissionId,
    payload: MissionProgressInput,
    user: WriteCurrentUser,
    database: DatabaseSession,
    repository: Repository,
) -> MissionProgressView:
    if repository.mission(mission_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    progress = await upsert_mission_progress(
        database,
        user_id=user.id,
        mission_id=mission_id,
        payload=payload,
    )
    return mission_progress_view(progress)


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
    return topic_progress_view(progress)


@router.get("/topics/{topic_id}", response_model=TopicProgressView)
async def read_topic_progress(
    topic_id: TopicId,
    user: CurrentUser,
    database: DatabaseSession,
) -> TopicProgressView:
    progress = await get_topic_progress(database, user_id=user.id, topic_id=topic_id)
    if progress is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Progress not found")
    return topic_progress_view(progress)


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
