from pathlib import Path
import tomllib


def test_project_declares_python_312_and_postgres_dependencies() -> None:
    pyproject = Path(__file__).parents[1] / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")

    assert 'requires-python = ">=3.12"' in text
    assert '"fastapi' in text
    assert '"sqlalchemy' in text.lower()
    assert '"psycopg' in text


def test_project_exposes_dev_tools_as_an_installable_extra() -> None:
    pyproject = Path(__file__).parents[1] / "pyproject.toml"
    metadata = tomllib.loads(pyproject.read_text(encoding="utf-8"))

    assert metadata["project"]["optional-dependencies"]["dev"] == [
        "pytest>=8.3,<9",
        "pytest-asyncio>=0.25,<1",
        "pytest-cov>=6,<7",
        "respx>=0.22,<1",
    ]
    assert "dependency-groups" not in metadata
