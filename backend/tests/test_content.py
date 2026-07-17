import json
import sys
from pathlib import Path

from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
import pytest


BACKEND_ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.content_repository import ContentRepository
from app.main import create_app
from app.schemas import Topic


CONTENT_ROOT = BACKEND_ROOT.parent / "content"
FULL_LESSON_IDS = {
    "python-beyond-scripts",
    "git-and-github",
    "apis",
    "sql",
    "testing",
    "ship-secure-backend",
}
ROUTE_TOPIC_IDS = {
    "python-beyond-scripts",
    "git-and-github",
    "apis",
    "structured-output-tool-calling",
    "sql",
    "cloud-deployment",
    "docker",
    "authentication-and-permissions",
    "testing",
    "logging-and-monitoring",
    "llm-evaluation",
    "retrieval-augmented-generation",
    "asynchronous-jobs-and-queues",
    "software-architecture",
}
STARTER_TOPIC_IDS = {
    "structured-output-tool-calling",
    "cloud-deployment",
    "docker",
    "authentication-and-permissions",
    "logging-and-monitoring",
    "llm-evaluation",
    "retrieval-augmented-generation",
    "asynchronous-jobs-and-queues",
    "software-architecture",
}


def test_repository_lists_each_selectable_route_topic_once() -> None:
    topics = ContentRepository(CONTENT_ROOT).topics()

    assert {topic["id"] for topic in topics} == ROUTE_TOPIC_IDS
    assert len(topics) == len(ROUTE_TOPIC_IDS)
    assert all(topic["speechText"] for topic in topics)


def test_repository_requires_authored_starter_actions_for_each_starter_topic() -> None:
    topics = ContentRepository(CONTENT_ROOT).topics()
    starter_topics = [topic for topic in topics if topic["contentStatus"] == "starter"]

    assert {topic["id"] for topic in starter_topics} == STARTER_TOPIC_IDS
    assert len(starter_topics) == 9
    for topic in starter_topics:
        starter_action = topic["starterAction"]
        assert set(starter_action) == {"id", "title", "description", "speechText"}
        assert all(
            isinstance(starter_action[field], str) and starter_action[field].strip()
            for field in starter_action
        )


def test_starter_topic_schema_rejects_a_missing_starter_action() -> None:
    starter_topic = next(
        topic
        for topic in ContentRepository(CONTENT_ROOT).topics()
        if topic["id"] == "docker"
    )
    starter_topic = dict(starter_topic)
    starter_topic.pop("starterAction", None)

    with pytest.raises(ValidationError, match="starterAction"):
        Topic.model_validate(starter_topic)


@pytest.mark.parametrize("field", ("id", "title", "description", "speechText"))
def test_starter_action_schema_rejects_whitespace_only_required_text(field: str) -> None:
    starter_topic = next(
        topic
        for topic in ContentRepository(CONTENT_ROOT).topics()
        if topic["id"] == "docker"
    )
    starter_topic = dict(starter_topic)
    starter_action = dict(starter_topic["starterAction"])
    starter_action[field] = " \t "
    starter_topic["starterAction"] = starter_action

    with pytest.raises(ValidationError, match=field):
        Topic.model_validate(starter_topic)


def test_repository_reads_each_full_lesson_pack() -> None:
    repository = ContentRepository(CONTENT_ROOT)

    for topic_id in FULL_LESSON_IDS:
        lesson = repository.lesson(topic_id)

        assert lesson is not None
        assert lesson["topicId"] == topic_id
        assert lesson["title"]
        assert lesson["speechText"]
        assert len(lesson["sections"]) >= 3
        assert all(section["title"] and section["speechText"] for section in lesson["sections"])
        assert len(lesson["questions"]) >= 3
        for question in lesson["questions"]:
            assert question["prompt"]
            assert question["speechText"]
            assert len(question["options"]) == 4
            assert all(option["text"] and option["speechText"] for option in question["options"])
            assert question["explanation"]
            assert question["explanationSpeechText"]
        assert lesson["starterAction"]["title"]
        assert lesson["starterAction"]["description"]
        assert lesson["starterAction"]["speechText"]


def test_repository_returns_none_for_an_unknown_lesson() -> None:
    assert ContentRepository(CONTENT_ROOT).lesson("missing-topic") is None


def test_repository_rejects_path_like_lesson_ids() -> None:
    assert ContentRepository(CONTENT_ROOT).lesson("../topics") is None


def test_portfolio_mission_contracts_are_readable_without_execution() -> None:
    payload = json.loads(
        (CONTENT_ROOT / "missions" / "foundation-missions.json").read_text(encoding="utf-8")
    )

    assert payload["version"] == 1
    assert {mission["id"] for mission in payload["missions"]} == {
        "python-tool-v1",
        "api-service-v1",
        "secure-backend-capstone",
    }
    missions = {mission["id"]: mission for mission in payload["missions"]}
    assert missions["python-tool-v1"] == {
        "id": "python-tool-v1",
        "topicId": "python-beyond-scripts",
        "title": "Ship a small Python tool",
        "speechText": "Build a small Python tool with a clear command and automated tests.",
        "evidence": {
            "requiredFiles": ["pyproject.toml", "README.md"],
            "requirePullRequest": True,
            "requirePassingChecks": True,
            "requireDeploymentUrl": False,
        },
    }
    assert missions["api-service-v1"] == {
        "id": "api-service-v1",
        "topicId": "apis",
        "title": "Ship a small API service",
        "speechText": "Build a small API service with a deliberate contract.",
        "evidence": {
            "requiredFiles": ["backend/app/main.py", "README.md"],
            "requirePullRequest": True,
            "requirePassingChecks": True,
            "requireDeploymentUrl": False,
        },
    }
    assert missions["secure-backend-capstone"] == {
        "id": "secure-backend-capstone",
        "topicId": "apis",
        "title": "Ship a secure backend capstone",
        "speechText": "Deploy a secure backend with deliberate evidence and a working URL.",
        "evidence": {
            "requiredFiles": ["backend/app/main.py", "Dockerfile", "README.md"],
            "requirePullRequest": True,
            "requirePassingChecks": True,
            "requireDeploymentUrl": True,
        },
    }


def test_repository_returns_missions_only_from_the_current_versioned_contract(tmp_path: Path) -> None:
    missions_directory = tmp_path / "missions"
    missions_directory.mkdir()
    (missions_directory / "foundation-missions.json").write_text(
        json.dumps(
            {
                "version": 2,
                "missions": [{"id": "unversioned-mission"}],
            }
        ),
        encoding="utf-8",
    )

    assert ContentRepository(tmp_path).mission("unversioned-mission") is None


@pytest.mark.asyncio
async def test_content_api_returns_typed_route_topics() -> None:
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.get("/api/content/topics")

    assert response.status_code == 200
    payload = response.json()
    assert {topic["id"] for topic in payload["topics"]} == ROUTE_TOPIC_IDS
    topic = next(candidate for candidate in payload["topics"] if candidate["id"] == "apis")
    assert set(topic) == {
        "id",
        "title",
        "category",
        "contentStatus",
        "prerequisites",
        "summary",
        "speechText",
        "starterAction",
    }
    assert isinstance(topic["prerequisites"], list)
    assert all(isinstance(prerequisite, str) for prerequisite in topic["prerequisites"])
    assert topic["starterAction"] is None


@pytest.mark.asyncio
async def test_content_api_returns_a_typed_starter_action() -> None:
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.get("/api/content/topics")

    assert response.status_code == 200
    docker = next(topic for topic in response.json()["topics"] if topic["id"] == "docker")
    assert set(docker["starterAction"]) == {"id", "title", "description", "speechText"}
    assert docker["starterAction"]["id"] == "docker-first-image"


@pytest.mark.asyncio
async def test_content_api_returns_a_typed_full_lesson() -> None:
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.get("/api/content/lessons/apis")

    assert response.status_code == 200
    lesson = response.json()
    assert set(lesson) == {"topicId", "title", "speechText", "sections", "questions", "starterAction"}
    assert lesson["topicId"] == "apis"
    assert set(lesson["sections"][0]) == {"id", "title", "body", "speechText"}
    assert set(lesson["questions"][0]) == {
        "id",
        "prompt",
        "speechText",
        "options",
        "correctOption",
        "explanation",
        "explanationSpeechText",
    }
    assert set(lesson["questions"][0]["options"][0]) == {"id", "text", "speechText"}
    assert set(lesson["starterAction"]) == {"id", "title", "description", "speechText"}


@pytest.mark.asyncio
@pytest.mark.parametrize("topic_id", ["missing-topic", "%2E%2E%2Ftopics"])
async def test_content_api_returns_not_found_for_unknown_or_invalid_lessons(topic_id: str) -> None:
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.get(f"/api/content/lessons/{topic_id}")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_static_root_serves_the_learning_shell() -> None:
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "<title>Refocus</title>" in response.text


@pytest.mark.asyncio
async def test_static_content_mount_serves_the_versioned_mission_contract() -> None:
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.get("/content/missions/foundation-missions.json")

    assert response.status_code == 200
    assert response.json()["missions"][0]["id"] == "api-service-v1"
