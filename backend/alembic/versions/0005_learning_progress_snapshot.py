"""Persist owner-scoped mission self-review state for learning snapshots.

Revision ID: 0005_learning_progress_snapshot
Revises: 0004_oauth_transaction_slots
Create Date: 2026-07-17
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0005_learning_progress_snapshot"
down_revision: str | None = "0004_oauth_transaction_slots"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mission_progress",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("mission_id", sa.String(length=120), nullable=False),
        sa.Column("approach", sa.String(length=16), nullable=False),
        sa.Column("reflection", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "approach IN ('guided', 'byop')",
            name="ck_mission_progress_approach",
        ),
        sa.CheckConstraint(
            "status = 'self_reviewed'",
            name="ck_mission_progress_status",
        ),
        sa.CheckConstraint(
            "length(reflection) <= 500",
            name="ck_mission_progress_reflection_length",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "mission_id", name="uq_mission_progress_user_mission"),
    )


def downgrade() -> None:
    op.drop_table("mission_progress")
