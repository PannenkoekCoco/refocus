from pathlib import Path
import re


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
