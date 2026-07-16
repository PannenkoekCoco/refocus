import test from "node:test";
import assert from "node:assert/strict";
import {
  selectRecommendedTopic,
  selectRouteView,
} from "../static/js/state/selectors.js";

test("a pinned topic wins over a job-relevant prerequisite", () => {
  const next = selectRecommendedTopic({
    pinnedTopicId: "retrieval-augmented-generation",
    topics: [
      { id: "apis", prerequisites: [] },
      { id: "retrieval-augmented-generation", prerequisites: ["apis"] },
    ],
    jobScores: { apis: 100, "retrieval-augmented-generation": 90 },
    mastery: {},
  });

  assert.equal(next.id, "retrieval-augmented-generation");
  assert.equal(next.reason, "You pinned this topic.");
  assert.deepEqual(next.advisoryPrerequisites, ["apis"]);
});

test("development scores outrank job scores while preserving authored ties", () => {
  const topics = [
    { id: "python", prerequisites: [] },
    { id: "apis", prerequisites: ["python"] },
    { id: "sql", prerequisites: ["python"] },
  ];
  const next = selectRecommendedTopic({
    topics,
    developmentScores: { apis: 0.11 },
    jobScores: { sql: 1 },
    mastery: { python: 0, apis: 1, sql: 1 },
  });

  assert.equal(next.id, "apis");
  assert.deepEqual(next.advisoryPrerequisites, ["python"]);
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
