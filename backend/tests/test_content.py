import json
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.content_repository import ContentRepository


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


def test_repository_lists_each_selectable_route_topic_once() -> None:
    topics = ContentRepository(CONTENT_ROOT).topics()

    assert {topic["id"] for topic in topics} == ROUTE_TOPIC_IDS
    assert len(topics) == len(ROUTE_TOPIC_IDS)
    assert all(topic["speechText"] for topic in topics)


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


def test_api_service_mission_contract_is_readable_without_execution() -> None:
    payload = json.loads(
        (CONTENT_ROOT / "missions" / "foundation-missions.json").read_text(encoding="utf-8")
    )

    assert payload["version"] == 1
    assert payload["missions"] == [
        {
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
    ]
