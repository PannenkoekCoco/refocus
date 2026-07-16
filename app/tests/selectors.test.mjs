import test from "node:test";
import assert from "node:assert/strict";
import {
  selectRecommendedTopic,
  selectRouteView,
} from "../static/js/state/selectors.js";

test("a pinned topic wins over a job-relevant prerequisite", () => {
  const next = selectRecommendedTopic({
    pinnedTopicId: "retrieval-augmented-generation",
    topics: [{ id: "apis" }, { id: "retrieval-augmented-generation" }],
    jobScores: { apis: 100, "retrieval-augmented-generation": 90 },
    mastery: {},
  });

  assert.equal(next.id, "retrieval-augmented-generation");
  assert.equal(next.reason, "You pinned this topic.");
});

test("a route keeps starter topics selectable and prerequisites advisory", () => {
  const route = selectRouteView(
    [
      {
        id: "python",
        title: "Python",
        contentStatus: "full",
        prerequisites: [],
      },
      {
        id: "rag",
        title: "Retrieval-augmented generation",
        contentStatus: "starter",
        prerequisites: ["python"],
      },
    ],
    { exploredLessonIds: [], quizAttempts: {}, missionStates: {} },
    { pinnedTopicId: "rag", recommendedTopicId: "rag" },
  );

  assert.equal(route[0].badge, "Full path");
  assert.equal(route[0].actionLabel, "Open Python");
  assert.equal(route[1].badge, "Starter exploration");
  assert.equal(route[1].actionLabel, "Explore now");
  assert.match(route[1].prerequisiteText, /Advisory prerequisite: Python\./);
  assert.equal(route[1].isPinned, true);
  assert.equal(route[1].isRecommended, true);
});
