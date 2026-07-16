from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import QuizAttempt, TopicProgress
from app.schemas import QuizAttemptInput


async def upsert_topic_progress(
    database: AsyncSession,
    *,
    user_id: UUID,
    topic_id: str,
    status: str,
) -> TopicProgress:
    result = await database.execute(
        select(TopicProgress).where(
            TopicProgress.user_id == user_id,
            TopicProgress.topic_id == topic_id,
        )
    )
    progress = result.scalar_one_or_none()
    if progress is None:
        progress = TopicProgress(user_id=user_id, topic_id=topic_id, status=status)
        database.add(progress)
    else:
        progress.status = status

    await database.commit()
    await database.refresh(progress)
    return progress


async def get_topic_progress(
    database: AsyncSession,
    *,
    user_id: UUID,
    topic_id: str,
) -> TopicProgress | None:
    result = await database.execute(
        select(TopicProgress).where(
            TopicProgress.user_id == user_id,
            TopicProgress.topic_id == topic_id,
        )
    )
    return result.scalar_one_or_none()


async def create_quiz_attempt(
    database: AsyncSession,
    *,
    user_id: UUID,
    payload: QuizAttemptInput,
) -> tuple[QuizAttempt, bool]:
    if payload.attempt_id is not None:
        result = await database.execute(
            select(QuizAttempt).where(
                QuizAttempt.client_attempt_id == payload.attempt_id,
                QuizAttempt.user_id == user_id,
            )
        )
        existing_attempt = result.scalar_one_or_none()
        if existing_attempt is not None:
            return existing_attempt, False

    quiz_attempt = QuizAttempt(
        user_id=user_id,
        client_attempt_id=payload.attempt_id,
        lesson_id=payload.lesson_id,
        answers_json=[answer.model_dump(by_alias=True) for answer in payload.answers],
    )
    database.add(quiz_attempt)
    await database.commit()
    await database.refresh(quiz_attempt)
    return quiz_attempt, True
