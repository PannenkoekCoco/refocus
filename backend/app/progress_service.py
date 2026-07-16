from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import QuizAttempt, TopicProgress, utcnow
from app.schemas import QuizAttemptInput


def conflict_aware_insert(database: AsyncSession, model: type[Any]) -> Any:
    dialect_name = database.get_bind().dialect.name
    if dialect_name == "postgresql":
        return postgresql_insert(model)
    if dialect_name == "sqlite":
        return sqlite_insert(model)
    raise RuntimeError(f"Unsupported progress persistence database: {dialect_name}")


async def upsert_topic_progress(
    database: AsyncSession,
    *,
    user_id: UUID,
    topic_id: str,
    status: str,
) -> TopicProgress:
    now = utcnow()
    statement = (
        conflict_aware_insert(database, TopicProgress)
        .values(
            id=uuid4(),
            user_id=user_id,
            topic_id=topic_id,
            status=status,
            created_at=now,
            updated_at=now,
        )
        .on_conflict_do_update(
            index_elements=["user_id", "topic_id"],
            set_={"status": status, "updated_at": now},
        )
    )
    await database.execute(statement)
    await database.commit()
    return (await database.execute(
        select(TopicProgress).where(
            TopicProgress.user_id == user_id,
            TopicProgress.topic_id == topic_id,
        )
    )).scalar_one()


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
    statement = (
        conflict_aware_insert(database, QuizAttempt)
        .values(
            id=uuid4(),
            user_id=user_id,
            client_attempt_id=payload.attempt_id,
            lesson_id=payload.lesson_id,
            answers_json=[answer.model_dump(by_alias=True) for answer in payload.answers],
        )
        .on_conflict_do_nothing(index_elements=["user_id", "client_attempt_id"])
        .returning(QuizAttempt.id)
    )
    inserted_id = (await database.execute(statement)).scalar_one_or_none()
    await database.commit()
    quiz_attempt = (await database.execute(
        select(QuizAttempt).where(
            QuizAttempt.user_id == user_id,
            QuizAttempt.client_attempt_id == payload.attempt_id,
        )
    )).scalar_one()
    return quiz_attempt, inserted_id is not None
