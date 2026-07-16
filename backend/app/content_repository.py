from __future__ import annotations

import json
from pathlib import Path


LESSON_TOPIC_IDS = frozenset(
    {
        "python-beyond-scripts",
        "git-and-github",
        "apis",
        "sql",
        "testing",
        "ship-secure-backend",
    }
)


class ContentRepository:
    def __init__(self, content_root: Path) -> None:
        self._content_root = content_root

    def topics(self) -> list[dict[str, object]]:
        payload = json.loads((self._content_root / "topics.json").read_text(encoding="utf-8"))
        return list(payload["topics"])

    def lesson(self, topic_id: str) -> dict[str, object] | None:
        if topic_id not in LESSON_TOPIC_IDS:
            return None
        path = self._content_root / "lessons" / f"{topic_id}.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

    def lesson_topic_ids(self) -> dict[str, str]:
        """Map persisted lesson identifiers to topics only from exact authored content."""
        authored_topic_ids = {
            topic["id"]
            for topic in self.topics()
            if isinstance(topic.get("id"), str)
        }
        mapping: dict[str, str] = {}
        for lesson_id in LESSON_TOPIC_IDS:
            lesson = self.lesson(lesson_id)
            if lesson is None:
                continue
            topic_id = lesson.get("topicId")
            if lesson_id in authored_topic_ids and isinstance(topic_id, str) and topic_id in authored_topic_ids:
                mapping[lesson_id] = topic_id
        return mapping
