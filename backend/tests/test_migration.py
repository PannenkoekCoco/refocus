import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys


def test_initial_migration_declares_only_the_four_refocus_domain_tables() -> None:
    migration = Path(__file__).parents[1] / "alembic" / "versions" / "0001_initial_schema.py"
    text = migration.read_text(encoding="utf-8")

    assert re.findall(r'op\.create_table\("([^"]+)"', text) == [
        "users",
        "sessions",
        "topic_progress",
        "quiz_attempts",
    ]
    assert "uq_topic_progress_user_topic" in text
    assert "ondelete=\"CASCADE\"" in text
    assert "sa.Uuid" in text
    assert "timezone=True" in text


def test_focus_lens_migration_uses_a_partial_unique_index_for_active_lenses() -> None:
    migration = Path(__file__).parents[1] / "alembic" / "versions" / "0002_focus_lenses.py"
    text = migration.read_text(encoding="utf-8")

    assert 'revision: str = "0002_focus_lenses"' in text
    assert 'down_revision: str | None = "0001_initial_schema"' in text
    assert re.search(r'op\.create_table\(\s*"focus_lenses"', text)
    assert "ondelete=\"CASCADE\"" in text
    assert "uq_focus_lenses_active_user_kind" in text
    assert "postgresql_where" in text
    assert "sqlite_where" in text


def test_github_mission_migration_keeps_only_safe_connection_metadata() -> None:
    migration = Path(__file__).parents[1] / "alembic" / "versions" / "0003_github_missions.py"
    text = migration.read_text(encoding="utf-8")

    assert 'revision: str = "0003_github_missions"' in text
    assert 'down_revision: str | None = "0002_focus_lenses"' in text
    assert 'sa.Column("github_user_id", sa.String(length=64), nullable=True)' in text
    assert "github_authorized_at" in text
    assert "github_verification_started_at" in text
    assert 'with op.batch_alter_table("users")' in text
    assert 'batch_op.drop_column("github_login")' in text
    assert 'sa.Column("user_id", sa.Uuid(), nullable=True)' in text
    assert 'ondelete="CASCADE"' in text
    assert re.findall(r'op\.create_table\(\s*"([^"]+)"', text) == [
        "github_oauth_transactions",
        "github_installations",
        "github_repositories",
        "mission_verifications",
    ]
    assert "state_hash" in text
    assert "repository_ids" not in text
    assert "access_token" not in text
    assert "refresh_token" not in text
    assert "uq_github_repositories_selected_user" in text
    assert "ix_github_oauth_transactions_expires_at" in text
    assert "postgresql_where" in text
    assert "sqlite_where" in text


def test_github_oauth_capacity_migration_reserves_database_owned_slots() -> None:
    migration = Path(__file__).parents[1] / "alembic" / "versions" / "0004_oauth_transaction_slots.py"

    assert migration.exists()
    text = migration.read_text(encoding="utf-8")
    assert 'revision: str = "0004_oauth_transaction_slots"' in text
    assert 'down_revision: str | None = "0003_github_missions"' in text
    assert '"github_oauth_transaction_slots"' in text
    assert '"transaction_id"' in text
    assert 'ondelete="SET NULL"' in text
    assert "10000" in text


def test_learning_progress_snapshot_migration_adds_owner_scoped_mission_state() -> None:
    migration = Path(__file__).parents[1] / "alembic" / "versions" / "0005_learning_progress_snapshot.py"

    assert migration.exists()
    text = migration.read_text(encoding="utf-8")
    assert 'revision: str = "0005_learning_progress_snapshot"' in text
    assert 'down_revision: str | None = "0004_oauth_transaction_slots"' in text
    assert re.search(r'op\.create_table\(\s*"mission_progress"', text)
    assert 'sa.Column("user_id", sa.Uuid(), nullable=False)' in text
    assert 'sa.Column("mission_id", sa.String(length=120), nullable=False)' in text
    assert 'ondelete="CASCADE"' in text
    assert "uq_mission_progress_user_mission" in text
    assert "self_reviewed" in text


def test_all_migrations_apply_on_sqlite_for_local_development(tmp_path: Path) -> None:
    backend_root = Path(__file__).parents[1]
    database_path = tmp_path / "refocus-migrations.db"
    environment = os.environ | {"DATABASE_URL": f"sqlite:///{database_path.as_posix()}"}

    subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "upgrade", "head"],
        cwd=backend_root,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )

    connection = sqlite3.connect(database_path)
    try:
        user_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(users)")
        }
        transaction_foreign_keys = list(
            connection.execute("PRAGMA foreign_key_list(github_oauth_transactions)")
        )
        transaction_slot_foreign_keys = list(
            connection.execute("PRAGMA foreign_key_list(github_oauth_transaction_slots)")
        )
        transaction_slot_count = connection.execute(
            "SELECT COUNT(*) FROM github_oauth_transaction_slots"
        ).fetchone()[0]
        mission_progress_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(mission_progress)")
        }
        mission_progress_foreign_keys = list(
            connection.execute("PRAGMA foreign_key_list(mission_progress)")
        )
        head = connection.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    finally:
        connection.close()

    assert "github_login" not in user_columns
    assert {"github_user_id", "github_authorized_at", "github_verification_started_at"} <= user_columns
    assert any(
        foreign_key[3] == "user_id" and foreign_key[6].upper() == "CASCADE"
        for foreign_key in transaction_foreign_keys
    )
    assert transaction_slot_count == 10_000
    assert any(
        foreign_key[3] == "transaction_id" and foreign_key[6].upper() == "SET NULL"
        for foreign_key in transaction_slot_foreign_keys
    )
    assert head == "0005_learning_progress_snapshot"
    assert {"id", "user_id", "mission_id", "approach", "reflection", "status", "updated_at"} <= mission_progress_columns
    assert any(
        foreign_key[3] == "user_id" and foreign_key[6].upper() == "CASCADE"
        for foreign_key in mission_progress_foreign_keys
    )
