from app.services.recommendations import (
    aggregate_mastery,
    preview_skill_weights,
    recommend_next,
)


TOPICS = [
    {"id": "python-beyond-scripts", "prerequisites": []},
    {"id": "apis", "prerequisites": ["python-beyond-scripts"]},
    {"id": "sql", "prerequisites": ["python-beyond-scripts"]},
]


def test_pinned_topic_overrides_all_other_signals() -> None:
    result = recommend_next(
        topics=TOPICS,
        pinned_topic_id="apis",
        development_weights={"sql": 1.0},
        job_weights={"sql": 1.0},
        mastery={"apis": 1.0},
    )

    assert result.topic_id == "apis"
    assert result.reason == "You pinned this topic."
    assert result.advisory_prerequisites == ["python-beyond-scripts"]


def test_development_weights_outrank_job_weights_and_low_mastery() -> None:
    result = recommend_next(
        topics=TOPICS,
        pinned_topic_id=None,
        development_weights={"apis": 0.11},
        job_weights={"sql": 1.0},
        mastery={"python-beyond-scripts": 0.0, "apis": 1.0, "sql": 1.0},
    )

    assert result.topic_id == "apis"
    assert result.reason == "Recommended from your goals and current mastery."


def test_low_mastery_breaks_an_unweighted_recommendation_tie() -> None:
    result = recommend_next(
        topics=TOPICS,
        pinned_topic_id=None,
        development_weights={},
        job_weights={},
        mastery={"python-beyond-scripts": 1.0, "apis": 0.0, "sql": 0.5},
    )

    assert result.topic_id == "apis"


def test_recommendation_ties_keep_authored_topic_order() -> None:
    result = recommend_next(
        topics=TOPICS,
        pinned_topic_id=None,
        development_weights={},
        job_weights={},
        mastery={},
    )

    assert result.topic_id == "python-beyond-scripts"


def test_preview_detects_explicit_engineering_terms_without_a_model() -> None:
    weights = preview_skill_weights("Build Python APIs with Docker, Postgres, tests, and GitHub.")

    assert weights["python-beyond-scripts"] > 0
    assert weights["apis"] > 0
    assert weights["sql"] > 0
    assert weights["docker"] > 0
    assert weights["git-and-github"] > 0


def test_preview_does_not_match_keywords_inside_unrelated_words() -> None:
    weights = preview_skill_weights("We need a rapid apiary inspection before lunch.")

    assert "apis" not in weights


def test_preview_is_a_pure_local_keyword_matcher(monkeypatch) -> None:
    """Lens previews must stay deterministic and cannot open an outbound connection."""
    import socket

    def reject_network(*_args, **_kwargs):
        raise AssertionError("a focus-lens preview must not use the network")

    monkeypatch.setattr(socket, "create_connection", reject_network)

    assert preview_skill_weights("Python and Docker") == preview_skill_weights("Python and Docker")


def test_mastery_uses_an_explicit_content_backed_lesson_mapping() -> None:
    mastery = aggregate_mastery(
        attempts=[
            ("apis", [{"correct": True}, {"correct": False}]),
            ("apis", [{"correct": True}, {"correct": True}]),
            ("apis-follow-up", [{"correct": False}]),
        ],
        lesson_topic_ids={"apis": "apis"},
    )

    assert mastery == {"apis": 0.75}
