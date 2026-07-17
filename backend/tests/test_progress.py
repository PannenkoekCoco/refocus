import asyncio
from uuid import uuid4

from httpx import AsyncClient
import pytest


def quiz_attempt_payload() -> dict[str, object]:
    return {
        "attemptId": str(uuid4()),
        "lessonId": "apis-1",
        "answers": [{"questionId": "invalid-input", "choiceIndex": 1, "correct": True}],
    }


@pytest.mark.asyncio
async def test_anonymous_users_cannot_write_progress(client: AsyncClient) -> None:
    response = await client.post("/api/progress/quiz-attempts", json={"lessonId": "apis-1", "answers": []})

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_progress_write_rejects_cross_origin_cookie_requests(authenticated_client_factory) -> None:
    client = await authenticated_client_factory("learner", "https://attacker.example")

    response = await client.put("/api/progress/topic/apis", json={"status": "explored"})

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_progress_write_rejects_cookie_requests_without_an_origin(authenticated_client_factory) -> None:
    client = await authenticated_client_factory("learner", None)

    response = await client.put("/api/progress/topic/apis", json={"status": "explored"})

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_same_origin_authenticated_progress_is_idempotent(authenticated_client: AsyncClient) -> None:
    first = await authenticated_client.put("/api/progress/topic/apis", json={"status": "explored"})
    second = await authenticated_client.put("/api/progress/topic/apis", json={"status": "completed"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["status"] == "completed"
    assert set(second.json()) == {"id", "topicId", "status", "updatedAt"}


@pytest.mark.asyncio
async def test_user_cannot_read_another_users_progress(authenticated_client_factory) -> None:
    owner = await authenticated_client_factory("owner")
    other = await authenticated_client_factory("other")
    saved = await owner.put("/api/progress/topic/apis", json={"status": "explored"})

    response = await other.get("/api/progress/topics/apis")

    assert saved.status_code == 200
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_quiz_attempts_are_owned_and_deduplicated_by_client_attempt_id(
    authenticated_client: AsyncClient,
) -> None:
    payload = quiz_attempt_payload()
    first = await authenticated_client.post("/api/progress/quiz-attempts", json=payload)
    second = await authenticated_client.post("/api/progress/quiz-attempts", json=payload)

    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert set(first.json()) == {"id", "lessonId", "answers", "createdAt"}


@pytest.mark.asyncio
async def test_authenticated_quiz_attempt_requires_a_client_generated_attempt_id(
    authenticated_client: AsyncClient,
) -> None:
    response = await authenticated_client.post(
        "/api/progress/quiz-attempts",
        json={
            "lessonId": "apis-1",
            "answers": [{"questionId": "invalid-input", "choiceIndex": 1, "correct": True}],
        },
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_concurrent_quiz_retries_return_one_created_attempt_and_one_existing_attempt(
    authenticated_client: AsyncClient,
) -> None:
    payload = quiz_attempt_payload()

    first, second = await asyncio.gather(
        authenticated_client.post("/api/progress/quiz-attempts", json=payload),
        authenticated_client.post("/api/progress/quiz-attempts", json=payload),
    )

    assert sorted((first.status_code, second.status_code)) == [200, 201]
    assert first.json()["id"] == second.json()["id"]


@pytest.mark.asyncio
async def test_concurrent_topic_saves_do_not_surface_a_uniqueness_error(
    authenticated_client: AsyncClient,
) -> None:
    first, second = await asyncio.gather(
        authenticated_client.put("/api/progress/topic/apis", json={"status": "explored"}),
        authenticated_client.put("/api/progress/topic/apis", json={"status": "explored"}),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]


@pytest.mark.asyncio
async def test_quiz_attempt_idempotency_key_is_scoped_to_its_owner(
    authenticated_client_factory,
) -> None:
    owner = await authenticated_client_factory("owner")
    other = await authenticated_client_factory("other")
    payload = quiz_attempt_payload()

    owner_response = await owner.post("/api/progress/quiz-attempts", json=payload)
    other_response = await other.post("/api/progress/quiz-attempts", json=payload)

    assert owner_response.status_code == 201
    assert other_response.status_code == 201
    assert owner_response.json()["id"] != other_response.json()["id"]


@pytest.mark.asyncio
async def test_progress_inputs_reject_unexpected_fields(authenticated_client: AsyncClient) -> None:
    response = await authenticated_client.put(
        "/api/progress/topic/apis",
        json={"status": "explored", "userId": "another-user"},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_mission_self_review_requires_authentication_and_the_exact_origin(
    client: AsyncClient,
    authenticated_client_factory,
) -> None:
    payload = {
        "approach": "guided",
        "reflection": "I checked the API contract and tests.",
        "status": "self_reviewed",
    }
    anonymous_snapshot = await client.get("/api/progress")
    anonymous = await client.put("/api/progress/missions/api-service-v1", json=payload)
    cross_origin_client = await authenticated_client_factory("learner", "https://attacker.example")
    cross_origin = await cross_origin_client.put("/api/progress/missions/api-service-v1", json=payload)

    assert anonymous_snapshot.status_code == 401
    assert anonymous.status_code == 401
    assert cross_origin.status_code == 403


@pytest.mark.asyncio
async def test_mission_self_review_upserts_only_authored_missions_and_rejects_extra_fields(
    authenticated_client: AsyncClient,
) -> None:
    first = await authenticated_client.put(
        "/api/progress/missions/api-service-v1",
        json={
            "approach": "guided",
            "reflection": "I wrote and tested the API service.",
            "status": "self_reviewed",
        },
    )
    second = await authenticated_client.put(
        "/api/progress/missions/api-service-v1",
        json={
            "approach": "byop",
            "reflection": "I adapted my own service and checked its contract.",
            "status": "self_reviewed",
        },
    )
    unknown_mission = await authenticated_client.put(
        "/api/progress/missions/unpublished-mission",
        json={
            "approach": "guided",
            "reflection": "This must not create learner state.",
            "status": "self_reviewed",
        },
    )
    extra_field = await authenticated_client.put(
        "/api/progress/missions/api-service-v1",
        json={
            "approach": "guided",
            "reflection": "No GitHub metadata belongs in this record.",
            "status": "self_reviewed",
            "githubRepositoryId": 123,
        },
    )
    too_long_reflection = await authenticated_client.put(
        "/api/progress/missions/api-service-v1",
        json={
            "approach": "guided",
            "reflection": "x" * 501,
            "status": "self_reviewed",
        },
    )
    snapshot = await authenticated_client.get("/api/progress")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["approach"] == "byop"
    assert second.json()["reflection"] == "I adapted my own service and checked its contract."
    assert second.json()["status"] == "self_reviewed"
    assert set(second.json()) == {"id", "missionId", "approach", "reflection", "status", "updatedAt"}
    assert unknown_mission.status_code == 404
    assert extra_field.status_code == 422
    assert too_long_reflection.status_code == 422
    assert snapshot.status_code == 200
    assert [mission["missionId"] for mission in snapshot.json()["missions"]] == ["api-service-v1"]


@pytest.mark.asyncio
async def test_progress_snapshot_is_owner_scoped_ordered_and_uses_latest_quiz_outcome(
    authenticated_client_factory,
) -> None:
    owner = await authenticated_client_factory("owner")
    other = await authenticated_client_factory("other")

    for topic_id in ("sql", "apis"):
        response = await owner.put(f"/api/progress/topic/{topic_id}", json={"status": "explored"})
        assert response.status_code == 200
    other_topic = await other.put("/api/progress/topic/docker", json={"status": "completed"})

    first_attempt = await owner.post(
        "/api/progress/quiz-attempts",
        json={
            "attemptId": str(uuid4()),
            "lessonId": "apis-1",
            "answers": [{"questionId": "one", "choiceIndex": 0, "correct": False}],
        },
    )
    latest_attempt = await owner.post(
        "/api/progress/quiz-attempts",
        json={
            "attemptId": str(uuid4()),
            "lessonId": "apis-1",
            "answers": [
                {"questionId": "one", "choiceIndex": 1, "correct": True},
                {"questionId": "two", "choiceIndex": 2, "correct": True},
            ],
        },
    )
    second_lesson = await owner.post(
        "/api/progress/quiz-attempts",
        json={
            "attemptId": str(uuid4()),
            "lessonId": "python-1",
            "answers": [{"questionId": "one", "choiceIndex": 0, "correct": True}],
        },
    )
    other_attempt = await other.post(
        "/api/progress/quiz-attempts",
        json={
            "attemptId": str(uuid4()),
            "lessonId": "docker-1",
            "answers": [{"questionId": "one", "choiceIndex": 0, "correct": True}],
        },
    )
    owner_mission = await owner.put(
        "/api/progress/missions/secure-backend-capstone",
        json={
            "approach": "guided",
            "reflection": "I reviewed the security and deployment checklist.",
            "status": "self_reviewed",
        },
    )
    other_mission = await other.put(
        "/api/progress/missions/api-service-v1",
        json={
            "approach": "byop",
            "reflection": "Other learner state must stay private.",
            "status": "self_reviewed",
        },
    )

    response = await owner.get("/api/progress")

    assert all(
        item.status_code == 201
        for item in (first_attempt, latest_attempt, second_lesson, other_attempt)
    )
    assert other_topic.status_code == 200
    assert owner_mission.status_code == 200
    assert other_mission.status_code == 200
    assert response.status_code == 200
    snapshot = response.json()
    assert set(snapshot) == {"topics", "quizAttempts", "missions"}
    assert [topic["topicId"] for topic in snapshot["topics"]] == ["apis", "sql"]
    assert all(set(topic) == {"id", "topicId", "status", "updatedAt"} for topic in snapshot["topics"])
    assert snapshot["quizAttempts"] == [
        {"lessonId": "apis-1", "correct": 2, "total": 2},
        {"lessonId": "python-1", "correct": 1, "total": 1},
    ]
    assert len(snapshot["missions"]) == 1
    mission = snapshot["missions"][0]
    assert set(mission) == {"id", "missionId", "approach", "reflection", "status", "updatedAt"}
    assert mission["missionId"] == "secure-backend-capstone"
    assert mission["approach"] == "guided"
    assert mission["status"] == "self_reviewed"
    assert mission["reflection"] == "I reviewed the security and deployment checklist."
