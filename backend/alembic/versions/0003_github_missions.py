"""Add read-only GitHub snapshots and mission verification records.

Revision ID: 0003_github_missions
Revises: 0002_focus_lenses
Create Date: 2026-07-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0003_github_missions"
down_revision: str | None = "0002_focus_lenses"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("github_user_id", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("github_authorized_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "users",
        sa.Column("github_verification_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    with op.batch_alter_table("users") as batch_op:
        batch_op.create_unique_constraint("uq_users_github_user_id", ["github_user_id"])
        batch_op.drop_constraint("uq_users_github_login", type_="unique")
        batch_op.drop_column("github_login")

    op.create_table(
        "github_oauth_transactions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("state_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("state_hash", name="uq_github_oauth_transactions_state_hash"),
    )
    op.create_index(
        "ix_github_oauth_transactions_expires_at",
        "github_oauth_transactions",
        ["expires_at"],
    )
    op.create_table(
        "github_installations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("github_installation_id", sa.BigInteger(), nullable=False),
        sa.Column("account_login", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "github_installation_id",
            name="uq_github_installations_user_installation",
        ),
    )
    op.create_table(
        "github_repositories",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("installation_id", sa.Uuid(), nullable=False),
        sa.Column("github_repository_id", sa.BigInteger(), nullable=False),
        sa.Column("full_name", sa.String(length=255), nullable=False),
        sa.Column("default_branch", sa.String(length=255), nullable=False),
        sa.Column("is_selected", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["installation_id"], ["github_installations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "github_repository_id",
            name="uq_github_repositories_user_repository",
        ),
    )
    op.create_index(
        "uq_github_repositories_selected_user",
        "github_repositories",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("is_selected"),
        sqlite_where=sa.text("is_selected = 1"),
    )
    op.create_table(
        "mission_verifications",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("mission_id", sa.String(length=120), nullable=False),
        sa.Column("github_repository_id", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("evidence_json", sa.JSON(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "mission_id",
            name="uq_mission_verifications_user_mission",
        ),
    )


def downgrade() -> None:
    op.drop_table("mission_verifications")
    op.drop_index("uq_github_repositories_selected_user", table_name="github_repositories")
    op.drop_table("github_repositories")
    op.drop_table("github_installations")
    op.drop_index("ix_github_oauth_transactions_expires_at", table_name="github_oauth_transactions")
    op.drop_table("github_oauth_transactions")
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("github_login", sa.String(length=80), nullable=True))
        batch_op.create_unique_constraint("uq_users_github_login", ["github_login"])
        batch_op.drop_constraint("uq_users_github_user_id", type_="unique")
        batch_op.drop_column("github_verification_started_at")
        batch_op.drop_column("github_authorized_at")
        batch_op.drop_column("github_user_id")
