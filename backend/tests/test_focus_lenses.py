import asyncio
import json

from httpx import AsyncClient
import pytest


def lens_payload(
    *,
    kind: str = "job",
    original_text: str = "Build a reliable Python API with tests.",
    skills: list[dict[str, object]] | None = None,
    is_active: bool = True,
) -> dict[str, object]:
    return {
        "kind": kind,
        "originalText": original_text,
        "skills": skills if skills is not None else [{"topicId": "apis", "weight": 0.8}],
        "isActive": is_active,
    }


@pytest.mark.asyncio
async def test_preview_is_public_deterministic_and_never_persists_raw_text(
    authenticated_client: AsyncClient,
) -> None:
    original_text = "Build a Python API with Docker and Postgres."

    preview = await authenticated_client.post(
        "/api/focus-lenses/preview",
        json={"kind": "job", "originalText": original_text},
    )
    saved_lenses = await authenticated_client.get("/api/focus-lenses")

    assert preview.status_code == 200
    assert "originalText" not in preview.json()
    assert {skill["topicId"] for skill in preview.json()["skills"]} >= {
        "python-beyond-scripts",
        "apis",
        "docker",
        "sql",
    }
    assert saved_lenses.status_code == 200
    assert saved_lenses.json() == {"lenses": []}


@pytest.mark.asyncio
async def test_focus_lens_mutations_and_private_reads_require_authentication(client: AsyncClient) -> None:
    preview = await client.post(
        "/api/focus-lenses/preview",
        json={"kind": "development", "originalText": "Practice SQL query design."},
    )
    created = await client.post("/api/focus-lenses", json=lens_payload())
    listed = await client.get("/api/focus-lenses")
    patched = await client.patch("/api/focus-lenses/00000000-0000-0000-0000-000000000001", json={"isActive": False})

    assert preview.status_code == 200
    assert created.status_code == 401
    assert listed.status_code == 401
    assert patched.status_code == 401


@pytest.mark.asyncio
async def test_same_origin_is_required_to_save_a_focus_lens(authenticated_client_factory) -> None:
    attacker = await authenticated_client_factory("learner", "https://attacker.example")

    response = await attacker.post("/api/focus-lenses", json=lens_payload())

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_owner_can_create_list_and_partially_update_a_focus_lens(
    authenticated_client: AsyncClient,
) -> None:
    created = await authenticated_client.post("/api/focus-lenses", json=lens_payload())

    assert created.status_code == 201
    lens = created.json()
    assert set(lens) == {"id", "kind", "originalText", "skills", "isActive", "createdAt", "updatedAt"}
    assert lens["originalText"] == "Build a reliable Python API with tests."
    assert "userId" not in lens

    updated = await authenticated_client.patch(
        f"/api/focus-lenses/{lens['id']}",
        json={"skills": [{"topicId": "testing", "weight": 1.0}]},
    )
    listed = await authenticated_client.get("/api/focus-lenses")

    assert updated.status_code == 200
    assert updated.json()["originalText"] == lens["originalText"]
    assert updated.json()["skills"] == [{"topicId": "testing", "weight": 1.0}]
    assert listed.status_code == 200
    assert listed.json()["lenses"] == [updated.json()]


@pytest.mark.asyncio
async def test_focus_lens_is_invisible_and_uneditable_to_another_user(authenticated_client_factory) -> None:
    owner = await authenticated_client_factory("owner")
    other = await authenticated_client_factory("other")
    created = await owner.post("/api/focus-lenses", json=lens_payload())

    listed = await other.get("/api/focus-lenses")
    patched = await other.patch(
        f"/api/focus-lenses/{created.json()['id']}",
        json={"isActive": False},
    )

    assert created.status_code == 201
    assert listed.status_code == 200
    assert listed.json() == {"lenses": []}
    assert patched.status_code == 404


@pytest.mark.asyncio
async def test_replacing_an_active_lens_retains_inactive_history_and_allows_both_kinds(
    authenticated_client: AsyncClient,
) -> None:
    first = await authenticated_client.post("/api/focus-lenses", json=lens_payload(original_text="First job"))
    second = await authenticated_client.post("/api/focus-lenses", json=lens_payload(original_text="Second job"))
    development = await authenticated_client.post(
        "/api/focus-lenses",
        json=lens_payload(kind="development", original_text="Build portfolio projects"),
    )
    listed = await authenticated_client.get("/api/focus-lenses")

    assert first.status_code == 201
    assert second.status_code == 201
    assert development.status_code == 201
    by_id = {lens["id"]: lens for lens in listed.json()["lenses"]}
    assert by_id[first.json()["id"]]["isActive"] is False
    assert by_id[second.json()["id"]]["isActive"] is True
    assert by_id[development.json()["id"]]["isActive"] is True


@pytest.mark.asyncio
async def test_concurrent_active_lens_replacements_leave_exactly_one_active_lens(
    authenticated_client: AsyncClient,
) -> None:
    first, second = await asyncio.gather(
        authenticated_client.post("/api/focus-lenses", json=lens_payload(original_text="First concurrent job")),
        authenticated_client.post("/api/focus-lenses", json=lens_payload(original_text="Second concurrent job")),
    )
    listed = await authenticated_client.get("/api/focus-lenses")

    assert sorted((first.status_code, second.status_code)) == [201, 201]
    active_jobs = [
        lens
        for lens in listed.json()["lenses"]
        if lens["kind"] == "job" and lens["isActive"]
    ]
    assert len(active_jobs) == 1


@pytest.mark.asyncio
async def test_focus_lens_rejects_extra_fields_and_invalid_skill_weights(
    authenticated_client: AsyncClient,
) -> None:
    invalid_payloads = [
        {**lens_payload(), "userId": "another-user"},
        lens_payload(original_text="   "),
        lens_payload(original_text="x" * 10_001),
        lens_payload(skills=[{"topicId": "unknown-topic", "weight": 0.5}]),
        lens_payload(skills=[{"topicId": "apis", "weight": 0.5}, {"topicId": "apis", "weight": 0.7}]),
    ]

    for payload in invalid_payloads:
        response = await authenticated_client.post("/api/focus-lenses", json=payload)
        assert response.status_code == 422
        assert "input" not in response.json()["detail"][0]

    for nonfinite_weight in (float("nan"), float("inf")):
        response = await authenticated_client.post(
            "/api/focus-lenses",
            content=json.dumps(
                lens_payload(skills=[{"topicId": "apis", "weight": nonfinite_weight}]),
                allow_nan=True,
            ),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422
        assert "input" not in response.json()["detail"][0]


@pytest.mark.asyncio
async def test_focus_lens_patch_cannot_mutate_kind_or_audit_identity(
    authenticated_client: AsyncClient,
) -> None:
    created = await authenticated_client.post("/api/focus-lenses", json=lens_payload())
    lens_id = created.json()["id"]

    kind_update = await authenticated_client.patch(
        f"/api/focus-lenses/{lens_id}",
        json={"kind": "development"},
    )
    audit_update = await authenticated_client.patch(
        f"/api/focus-lenses/{lens_id}",
        json={"createdAt": "2020-01-01T00:00:00Z"},
    )

    assert kind_update.status_code == 422
    assert audit_update.status_code == 422


@pytest.mark.asyncio
async def test_recommendations_are_private_and_honor_a_valid_optional_pin(
    authenticated_client_factory,
) -> None:
    owner = await authenticated_client_factory("owner")
    other = await authenticated_client_factory("other")
    owner_lens = await owner.post(
        "/api/focus-lenses",
        json=lens_payload(skills=[{"topicId": "apis", "weight": 1.0}]),
    )
    other_lens = await other.post(
        "/api/focus-lenses",
        json=lens_payload(
            kind="development",
            skills=[{"topicId": "sql", "weight": 1.0}],
        ),
    )

    owner_recommendation = await owner.get("/api/recommendations/next")
    owner_pinned = await owner.get("/api/recommendations/next", params={"pinnedTopicId": "sql"})
    other_recommendation = await other.get("/api/recommendations/next")

    assert owner_lens.status_code == 201
    assert other_lens.status_code == 201
    assert owner_recommendation.status_code == 200
    assert owner_recommendation.json() == {
        "topicId": "apis",
        "reason": "Recommended from your goals and current mastery.",
        "advisoryPrerequisites": ["python-beyond-scripts"],
    }
    assert owner_pinned.status_code == 200
    assert owner_pinned.json() == {
        "topicId": "sql",
        "reason": "You pinned this topic.",
        "advisoryPrerequisites": ["python-beyond-scripts"],
    }
    assert other_recommendation.status_code == 200
    assert other_recommendation.json()["topicId"] == "sql"
    assert "originalText" not in owner_recommendation.json()


@pytest.mark.asyncio
async def test_recommendations_require_authentication(client: AsyncClient) -> None:
    anonymous = await client.get("/api/recommendations/next")

    assert anonymous.status_code == 401


@pytest.mark.asyncio
async def test_recommendations_reject_unknown_pins(authenticated_client: AsyncClient) -> None:
    response = await authenticated_client.get(
        "/api/recommendations/next",
        params={"pinnedTopicId": "not-an-authored-topic"},
    )

    assert response.status_code == 422
