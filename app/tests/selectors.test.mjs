import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  selectRecommendedTopic,
  selectRouteGroups,
  selectRouteView,
  selectTodayMomentum,
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

test("Today momentum counts explored, practised, and applied work", () => {
  assert.deepEqual(selectTodayMomentum({
    topics: [{ id: "python" }, { id: "apis" }],
    progress: {
      exploredLessonIds: ["python"],
      quizAttempts: { python: { correct: 2, total: 3 } },
      missionStates: { "api-service-v1": { status: "self_reviewed" } },
    },
    missions: [{ id: "api-service-v1", topicId: "apis" }],
  }), { explored: 1, practised: 1, applied: 1, total: 2 });
});

test("route groups search title and summary without removing a free topic", () => {
  const groups = selectRouteGroups([
    { id: "apis", title: "APIs", summary: "Build a service", category: "foundation" },
    { id: "docker", title: "Docker", summary: "Package an app", category: "production" },
  ], { query: "service", category: "all" });

  assert.equal(groups[0].nodes[0].id, "apis");
});

test("route groups cover every shipped lower-case category in stage order", () => {
  const { topics } = JSON.parse(readFileSync(
    new URL("../../content/topics.json", import.meta.url),
    "utf8",
  ));
  const groups = selectRouteGroups(topics);
  const groupedNodes = groups.flatMap((group) => group.nodes);

  assert.equal(topics.length, 14);
  assert.deepEqual(groups.map(({ id, title, nodes }) => ({ id, title, count: nodes.length })), [
    { id: "foundations", title: "Foundations", count: 6 },
    { id: "build-and-ship", title: "Build and ship", count: 5 },
    { id: "ai-systems", title: "AI systems", count: 3 },
  ]);
  assert.equal(groupedNodes.length, topics.length);
  assert.deepEqual(
    groupedNodes.map((node) => node.id).sort(),
    topics.map((topic) => topic.id).sort(),
  );
});
