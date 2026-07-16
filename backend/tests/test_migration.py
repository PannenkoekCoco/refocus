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
