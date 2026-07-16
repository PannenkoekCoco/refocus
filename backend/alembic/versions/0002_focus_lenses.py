"""Add private job and development focus lenses.

Revision ID: 0002_focus_lenses
Revises: 0001_initial_schema
Create Date: 2026-07-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0002_focus_lenses"
down_revision: str | None = "0001_initial_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "focus_lenses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("original_text", sa.Text(), nullable=False),
        sa.Column("skill_weights_json", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('job', 'development')", name="ck_focus_lenses_kind"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_focus_lenses_active_user_kind",
        "focus_lenses",
        ["user_id", "kind"],
        unique=True,
        postgresql_where=sa.text("is_active"),
        sqlite_where=sa.text("is_active = 1"),
    )


def downgrade() -> None:
    op.drop_index("uq_focus_lenses_active_user_kind", table_name="focus_lenses")
    op.drop_table("focus_lenses")
