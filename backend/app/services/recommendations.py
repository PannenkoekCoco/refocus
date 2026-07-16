from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any


KEYWORDS: dict[str, tuple[str, ...]] = {
    "python-beyond-scripts": ("python", "fastapi", "pydantic", "backend"),
    "git-and-github": ("git", "github", "pull request", "continuous integration", "ci"),
    "apis": ("api", "apis", "rest", "http", "endpoint", "endpoints"),
    "structured-output-tool-calling": (
        "structured output",
        "structured outputs",
        "tool calling",
        "function calling",
    ),
    "sql": ("sql", "postgres", "postgresql", "database", "schema"),
    "cloud-deployment": ("cloud", "deploy", "deployment", "hosting"),
    "docker": ("docker", "container", "containers"),
    "authentication-and-permissions": (
        "auth",
        "authentication",
        "authorization",
        "permission",
        "permissions",
        "oauth",
    ),
    "testing": ("test", "tests", "pytest", "quality"),
    "logging-and-monitoring": ("logging", "monitoring", "observability", "metrics", "tracing"),
    "llm-evaluation": ("llm evaluation", "evaluation", "eval", "benchmark"),
    "retrieval-augmented-generation": ("rag", "retrieval", "grounded generation"),
    "asynchronous-jobs-and-queues": (
        "queue",
        "queues",
        "asynchronous",
        "background job",
        "worker",
    ),
    "software-architecture": ("architecture", "modular", "service boundary", "design pattern"),
}


@dataclass(frozen=True)
class Recommendation:
    topic_id: str
    reason: str
    advisory_prerequisites: list[str]


@lru_cache(maxsize=None)
def _term_pattern(term: str) -> re.Pattern[str]:
    escaped = re.escape(term.casefold()).replace(r"\ ", r"\s+")
    return re.compile(rf"(?<![a-z0-9-]){escaped}(?![a-z0-9-])")


def preview_skill_weights(text: str) -> dict[str, float]:
    """Return reviewable word and phrase matches without external side effects."""
    normalized = text.casefold()
    weights: dict[str, float] = {}
    for topic_id, terms in KEYWORDS.items():
        matches = sum(len(_term_pattern(term).findall(normalized)) for term in terms)
        if matches:
            weights[topic_id] = min(1.0, matches / 3)
    return weights


def recommend_next(
    *,
    topics: Sequence[Mapping[str, Any]],
    pinned_topic_id: str | None,
    development_weights: Mapping[str, float],
    job_weights: Mapping[str, float],
    mastery: Mapping[str, float],
) -> Recommendation:
    """Rank authored topics with pins first and authored order as the stable tie breaker."""
    by_id = {
        topic_id: topic
        for topic in topics
        if isinstance((topic_id := topic.get("id")), str)
    }
    if pinned_topic_id in by_id:
        topic = by_id[pinned_topic_id]
        prerequisites = topic.get("prerequisites", [])
        return Recommendation(
            topic_id=pinned_topic_id,
            reason="You pinned this topic.",
            advisory_prerequisites=list(prerequisites) if isinstance(prerequisites, list) else [],
        )

    if not topics:
        raise ValueError("At least one authored topic is required for a recommendation.")

    def score(topic: Mapping[str, Any]) -> float:
        topic_id = topic.get("id")
        if not isinstance(topic_id, str):
            return float("-inf")
        return (
            development_weights.get(topic_id, 0.0) * 1000
            + job_weights.get(topic_id, 0.0) * 100
            + (1.0 - mastery.get(topic_id, 0.0)) * 10
        )

    topic = max(topics, key=score)
    topic_id = topic.get("id")
    if not isinstance(topic_id, str):
        raise ValueError("Authored topics must have string identifiers.")
    prerequisites = topic.get("prerequisites", [])
    return Recommendation(
        topic_id=topic_id,
        reason="Recommended from your goals and current mastery.",
        advisory_prerequisites=list(prerequisites) if isinstance(prerequisites, list) else [],
    )


def aggregate_mastery(
    *,
    attempts: Sequence[tuple[str, Sequence[Mapping[str, object]]]],
    lesson_topic_ids: Mapping[str, str],
) -> dict[str, float]:
    """Aggregate completed answers through an exact, content-supplied lesson mapping."""
    totals: defaultdict[str, list[int]] = defaultdict(lambda: [0, 0])
    for lesson_id, answers in attempts:
        topic_id = lesson_topic_ids.get(lesson_id)
        if topic_id is None:
            continue
        for answer in answers:
            correct = answer.get("correct")
            if type(correct) is not bool:
                continue
            totals[topic_id][0] += int(correct)
            totals[topic_id][1] += 1
    return {
        topic_id: correct / total
        for topic_id, (correct, total) in totals.items()
        if total > 0
    }
