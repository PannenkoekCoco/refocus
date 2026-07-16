"""Reserve a bounded set of database-owned GitHub OAuth transaction slots.

Revision ID: 0004_oauth_transaction_slots
Revises: 0003_github_missions
Create Date: 2026-07-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0004_oauth_transaction_slots"
down_revision: str | None = "0003_github_missions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # OAuth states are transient, one-time records. Invalidating pre-slot states is
    # safer than attempting to retrofit a reservation onto an in-flight callback.
    op.execute("DELETE FROM github_oauth_transactions")
    op.create_table(
        "github_oauth_transaction_slots",
        sa.Column("slot_number", sa.Integer(), nullable=False),
        sa.Column("transaction_id", sa.Uuid(), nullable=True),
        sa.CheckConstraint(
            "slot_number >= 1 AND slot_number <= 10000",
            name="ck_github_oauth_transaction_slots_number",
        ),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["github_oauth_transactions.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("slot_number"),
        sa.UniqueConstraint(
            "transaction_id",
            name="uq_github_oauth_transaction_slots_transaction",
        ),
    )
    op.execute(
        """
        WITH RECURSIVE slot_numbers(slot_number) AS (
            SELECT 1
            UNION ALL
            SELECT slot_number + 1
            FROM slot_numbers
            WHERE slot_number < 10000
        )
        INSERT INTO github_oauth_transaction_slots (slot_number)
        SELECT slot_number FROM slot_numbers
        """
    )


def downgrade() -> None:
    op.drop_table("github_oauth_transaction_slots")
