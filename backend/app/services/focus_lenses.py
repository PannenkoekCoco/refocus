from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from math import isfinite
from uuid import UUID, uuid4

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import FocusLens, utcnow
from app.schemas import FocusLensInput, FocusLensPatch, SkillWeight


class UnknownFocusTopicError(ValueError):
    """A submitted score refers to a topic outside the authored route."""


class FocusLensConflictError(RuntimeError):
    """A concurrent active-lens replacement could not settle safely."""


def ensure_authored_skill_topics(
    skills: Sequence[SkillWeight],
    authored_topic_ids: set[str],
) -> None:
    unknown_topic_ids = sorted({skill.topic_id for skill in skills} - authored_topic_ids)
    if unknown_topic_ids:
        raise UnknownFocusTopicError("Unknown authored topic")


def skill_weight_map(skills: Iterable[SkillWeight]) -> dict[str, float]:
    return {skill.topic_id: skill.weight for skill in skills}


def skill_weights_from_json(value: object) -> list[SkillWeight]:
    if not isinstance(value, Mapping):
        return []
    skills: list[SkillWeight] = []
    for topic_id, weight in value.items():
        if not isinstance(topic_id, str) or isinstance(weight, bool):
            continue
        if not isinstance(weight, (int, float)) or not isfinite(weight) or not 0 <= weight <= 1:
            continue
        skills.append(SkillWeight(topic_id=topic_id, weight=float(weight)))
    return skills


async def list_focus_lenses(database: AsyncSession, *, user_id: UUID) -> list[FocusLens]:
    result = await database.execute(
        select(FocusLens)
        .where(FocusLens.user_id == user_id)
        .order_by(FocusLens.updated_at.desc(), FocusLens.created_at.desc())
    )
    return list(result.scalars())


async def get_focus_lens(database: AsyncSession, *, user_id: UUID, lens_id: UUID) -> FocusLens | None:
    result = await database.execute(
        select(FocusLens).where(FocusLens.id == lens_id, FocusLens.user_id == user_id).limit(1)
    )
    return result.scalar_one_or_none()


async def _deactivate_existing_lenses(
    database: AsyncSession,
    *,
    user_id: UUID,
    kind: str,
    exclude_lens_id: UUID | None = None,
) -> None:
    conditions = [
        FocusLens.user_id == user_id,
        FocusLens.kind == kind,
        FocusLens.is_active.is_(True),
    ]
    if exclude_lens_id is not None:
        conditions.append(FocusLens.id != exclude_lens_id)
    await database.execute(
        update(FocusLens).where(*conditions).values(is_active=False, updated_at=utcnow())
    )


async def create_focus_lens(
    database: AsyncSession,
    *,
    user_id: UUID,
    payload: FocusLensInput,
) -> FocusLens:
    """Create history rows while atomically leaving at most one active kind per user."""
    for attempt in range(2):
        try:
            if payload.is_active:
                await _deactivate_existing_lenses(database, user_id=user_id, kind=payload.kind)
            lens = FocusLens(
                id=uuid4(),
                user_id=user_id,
                kind=payload.kind,
                original_text=payload.original_text,
                skill_weights_json=skill_weight_map(payload.skills),
                is_active=payload.is_active,
                created_at=utcnow(),
                updated_at=utcnow(),
            )
            database.add(lens)
            await database.commit()
            await database.refresh(lens)
            return lens
        except IntegrityError as error:
            await database.rollback()
            if not payload.is_active or attempt == 1:
                raise FocusLensConflictError("Focus lens replacement conflicted") from error
    raise FocusLensConflictError("Focus lens replacement conflicted")


async def update_focus_lens(
    database: AsyncSession,
    *,
    lens: FocusLens,
    payload: FocusLensPatch,
) -> FocusLens:
    """Update only mutable lens fields and safely replace another active lens when needed."""
    for attempt in range(2):
        try:
            if payload.is_active is True:
                await _deactivate_existing_lenses(
                    database,
                    user_id=lens.user_id,
                    kind=lens.kind,
                    exclude_lens_id=lens.id,
                )
            if payload.original_text is not None:
                lens.original_text = payload.original_text
            if payload.skills is not None:
                lens.skill_weights_json = skill_weight_map(payload.skills)
            if payload.is_active is not None:
                lens.is_active = payload.is_active
            lens.updated_at = utcnow()
            await database.commit()
            await database.refresh(lens)
            return lens
        except IntegrityError as error:
            await database.rollback()
            if payload.is_active is not True or attempt == 1:
                raise FocusLensConflictError("Focus lens update conflicted") from error
            refreshed = await get_focus_lens(database, user_id=lens.user_id, lens_id=lens.id)
            if refreshed is None:
                raise FocusLensConflictError("Focus lens update conflicted") from error
            lens = refreshed
    raise FocusLensConflictError("Focus lens update conflicted")


async def active_focus_weights(database: AsyncSession, *, user_id: UUID) -> dict[str, dict[str, float]]:
    result = await database.execute(
        select(FocusLens.kind, FocusLens.skill_weights_json).where(
            FocusLens.user_id == user_id,
            FocusLens.is_active.is_(True),
        )
    )
    weights = {"job": {}, "development": {}}
    for kind, skill_weights_json in result.all():
        if kind not in weights:
            continue
        weights[kind] = skill_weight_map(skill_weights_from_json(skill_weights_json))
    return weights
