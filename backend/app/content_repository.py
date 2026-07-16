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
