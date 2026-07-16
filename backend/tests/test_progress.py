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
