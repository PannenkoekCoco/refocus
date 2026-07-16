from pathlib import Path


def test_project_declares_python_312_and_postgres_dependencies() -> None:
    pyproject = Path(__file__).parents[1] / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")

    assert 'requires-python = ">=3.12"' in text
    assert '"fastapi' in text
    assert '"sqlalchemy' in text.lower()
    assert '"psycopg' in text
