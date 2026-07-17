import test from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  pendingProgressKey,
} from "../static/js/state/store.js";

const offlineQuizAttempt = {
  attemptId: "5dd72f13-4d53-4a7d-9d07-c17b9e8ff89b",
  lessonId: "apis",
  answers: [{ questionId: "invalid-input", choiceIndex: 1, correct: true }],
};

const olderMissionReview = {
  kind: "missionProgress",
  payload: {
    missionId: "api-service-v1",
    approach: "guided",
    reflection: "Ship the smallest API first.",
    status: "self_reviewed",
  },
};

const newerMissionReview = {
  kind: "missionProgress",
  payload: {
    missionId: "api-service-v1",
    approach: "byop",
    reflection: "Add authentication before deployment.",
    status: "self_reviewed",
  },
};

const localMissionState = {
  approach: olderMissionReview.payload.approach,
  reflection: olderMissionReview.payload.reflection,
  status: olderMissionReview.payload.status,
};

test("a progress snapshot hydrates server progress without replacing local unsynced quiz and mission work", () => {
  const store = createStore({
    pinnedTopicId: "retrieval-augmented-generation",
    exploredLessonIds: ["apis"],
    quizAttempts: { apis: { correct: 3, total: 3 } },
    missionStates: {
      "api-service-v1": localMissionState,
    },
    pendingProgress: [{ kind: "quizAttempt", payload: offlineQuizAttempt }, olderMissionReview],
  });

  store.dispatch({
    type: "hydrateServerProgress",
    snapshot: {
      topics: [{
        id: "00000000-0000-0000-0000-000000000001",
        topicId: "sql",
        status: "explored",
        updatedAt: "2026-07-17T00:00:00Z",
      }],
      quizAttempts: [{ lessonId: "python-beyond-scripts", correct: 1, total: 3 }],
      missions: [{
        id: "00000000-0000-0000-0000-000000000002",
        missionId: "api-service-v1",
        approach: "guided",
        reflection: "This older server reflection must not replace the local work.",
        status: "self_reviewed",
        updatedAt: "2026-07-17T00:00:00Z",
      }, {
        id: "00000000-0000-0000-0000-000000000003",
        missionId: "python-tool-v1",
        approach: "guided",
        reflection: "Use a typed command interface.",
        status: "self_reviewed",
        updatedAt: "2026-07-17T00:00:00Z",
      }],
    },
  });

  assert.deepEqual(store.getState(), {
    pinnedTopicId: "retrieval-augmented-generation",
    exploredLessonIds: ["apis", "sql"],
    quizAttempts: {
      apis: { correct: 3, total: 3 },
      "python-beyond-scripts": { correct: 1, total: 3 },
    },
    missionStates: {
      "api-service-v1": localMissionState,
      "python-tool-v1": {
        approach: "guided",
        reflection: "Use a typed command interface.",
        status: "self_reviewed",
      },
    },
    pendingProgress: [{ kind: "quizAttempt", payload: offlineQuizAttempt }, olderMissionReview],
  });
});

test("a progress snapshot refreshes cached synced outcomes while retaining records with queued writes", () => {
  const store = createStore({
    pinnedTopicId: "retrieval-augmented-generation",
    exploredLessonIds: ["apis"],
    quizAttempts: {
      apis: { correct: 3, total: 3 },
      "python-beyond-scripts": { correct: 3, total: 3 },
    },
    missionStates: {
      "api-service-v1": localMissionState,
      "python-tool-v1": localMissionState,
    },
    pendingProgress: [{ kind: "quizAttempt", payload: offlineQuizAttempt }, olderMissionReview],
  });

  store.dispatch({
    type: "hydrateServerProgress",
    snapshot: {
      topics: [],
      quizAttempts: [
        { lessonId: "apis", correct: 1, total: 3 },
        { lessonId: "python-beyond-scripts", correct: 1, total: 3 },
      ],
      missions: [{
        missionId: "api-service-v1",
        approach: "byop",
        reflection: "The offline reflection must stay.",
        status: "self_reviewed",
      }, {
        missionId: "python-tool-v1",
        approach: "byop",
        reflection: "A newer server reflection should hydrate.",
        status: "self_reviewed",
      }],
    },
  });

  assert.deepEqual(store.getState().quizAttempts, {
    apis: { correct: 3, total: 3 },
    "python-beyond-scripts": { correct: 1, total: 3 },
  });
  assert.deepEqual(store.getState().missionStates, {
    "api-service-v1": localMissionState,
    "python-tool-v1": {
      approach: "byop",
      reflection: "A newer server reflection should hydrate.",
      status: "self_reviewed",
    },
  });
  assert.equal(store.getState().pinnedTopicId, "retrieval-augmented-generation");
});

test("a pending replay acknowledgement removes only the exact payload version that succeeded", () => {
  const exploredTopic = {
    kind: "topicProgress",
    payload: { topicId: "apis", status: "explored" },
  };
  const store = createStore({
    pinnedTopicId: null,
    exploredLessonIds: [],
    quizAttempts: {},
    missionStates: {},
    pendingProgress: [exploredTopic, olderMissionReview, newerMissionReview],
  });

  store.dispatch({
    type: "ackPendingProgress",
    keys: [pendingProgressKey(olderMissionReview)],
  });

  assert.deepEqual(store.getState().pendingProgress, [exploredTopic, newerMissionReview]);
  assert.notEqual(pendingProgressKey(olderMissionReview), pendingProgressKey(newerMissionReview));
});
