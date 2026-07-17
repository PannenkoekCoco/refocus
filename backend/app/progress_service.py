from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MissionProgress, QuizAttempt, TopicProgress, utcnow
from app.schemas import MissionProgressInput, QuizAttemptInput


@dataclass(frozen=True)
class QuizOutcome:
    lesson_id: str
    correct: int
    total: int


@dataclass(frozen=True)
class ProgressSnapshot:
    topics: list[TopicProgress]
    quiz_outcomes: list[QuizOutcome]
    missions: list[MissionProgress]


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


async def upsert_mission_progress(
    database: AsyncSession,
    *,
    user_id: UUID,
    mission_id: str,
    payload: MissionProgressInput,
) -> MissionProgress:
    now = utcnow()
    statement = (
        conflict_aware_insert(database, MissionProgress)
        .values(
            id=uuid4(),
            user_id=user_id,
            mission_id=mission_id,
            approach=payload.approach,
            reflection=payload.reflection,
            status=payload.status,
            updated_at=now,
        )
        .on_conflict_do_update(
            index_elements=["user_id", "mission_id"],
            set_={
                "approach": payload.approach,
                "reflection": payload.reflection,
                "status": payload.status,
                "updated_at": now,
            },
        )
    )
    await database.execute(statement)
    await database.commit()
    return (await database.execute(
        select(MissionProgress).where(
            MissionProgress.user_id == user_id,
            MissionProgress.mission_id == mission_id,
        )
    )).scalar_one()


def quiz_outcome(attempt: QuizAttempt) -> QuizOutcome:
    answers = attempt.answers_json if isinstance(attempt.answers_json, list) else []
    answer_records = [answer for answer in answers if isinstance(answer, dict)]
    return QuizOutcome(
        lesson_id=attempt.lesson_id,
        correct=sum(answer.get("correct") is True for answer in answer_records),
        total=len(answer_records),
    )


async def get_progress_snapshot(
    database: AsyncSession,
    *,
    user_id: UUID,
) -> ProgressSnapshot:
    topics = list((await database.execute(
        select(TopicProgress)
        .where(TopicProgress.user_id == user_id)
        .order_by(TopicProgress.topic_id.asc())
    )).scalars())
    attempts = list((await database.execute(
        select(QuizAttempt)
        .where(QuizAttempt.user_id == user_id)
        .order_by(
            QuizAttempt.lesson_id.asc(),
            QuizAttempt.created_at.desc(),
            QuizAttempt.id.desc(),
        )
    )).scalars())
    latest_attempts: dict[str, QuizAttempt] = {}
    for attempt in attempts:
        latest_attempts.setdefault(attempt.lesson_id, attempt)
    missions = list((await database.execute(
        select(MissionProgress)
        .where(MissionProgress.user_id == user_id)
        .order_by(MissionProgress.mission_id.asc())
    )).scalars())
    return ProgressSnapshot(
        topics=topics,
        quiz_outcomes=[quiz_outcome(attempt) for attempt in latest_attempts.values()],
        missions=missions,
    )
