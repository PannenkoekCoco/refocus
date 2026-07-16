import test from "node:test";
import assert from "node:assert/strict";
import {
  LEARNING_ROUTE_STORAGE_KEY,
  createStore,
  loadLearningState,
  persistLearningState,
} from "../static/js/state/store.js";

test("a corrupted learning-route cache falls back to a safe empty state", () => {
  const storage = {
    getItem: () => "{not valid json",
  };

  assert.deepEqual(loadLearningState(storage), {
    pinnedTopicId: null,
    exploredLessonIds: [],
    quizAttempts: {},
    missionStates: {},
  });
});

test("a malformed nested cache record does not become usable learning state", () => {
  const storage = {
    getItem: () => JSON.stringify({
      pinnedTopicId: 12,
      exploredLessonIds: ["apis", null, "apis"],
      quizAttempts: { apis: null },
      missionStates: { "api-service-v1": "not-an-object" },
    }),
  };

  assert.deepEqual(loadLearningState(storage), {
    pinnedTopicId: null,
    exploredLessonIds: ["apis"],
    quizAttempts: {},
    missionStates: {},
  });
});

test("cached quiz attempts reject impossible or imprecise scores", () => {
  const storage = {
    getItem: () => JSON.stringify({
      quizAttempts: {
        valid: { correct: 2, total: 3 },
        zero: { correct: 0, total: 0 },
        fractionalCorrect: { correct: 1.5, total: 2 },
        fractionalTotal: { correct: 1, total: 2.5 },
        negativeCorrect: { correct: -1, total: 2 },
        exceedsTotal: { correct: 3, total: 2 },
      },
    }),
  };

  assert.deepEqual(loadLearningState(storage).quizAttempts, {
    valid: { correct: 2, total: 3 },
    zero: { correct: 0, total: 0 },
  });
});

test("persistence never claims success when storage is unavailable or rejects a write", () => {
  const state = {
    pinnedTopicId: "apis",
    exploredLessonIds: [],
    quizAttempts: {},
    missionStates: {},
  };

  assert.equal(persistLearningState(null, state), false);
  assert.equal(
    persistLearningState({ setItem: () => { throw new Error("quota exceeded"); } }, state),
    false,
  );
});

test("the store records learning progress and persists only its route key", () => {
  const store = createStore({
    pinnedTopicId: null,
    exploredLessonIds: [],
    quizAttempts: {},
    missionStates: {},
  });
  const writes = [];
  const storage = {
    setItem: (key, value) => writes.push([key, value]),
  };

  store.dispatch({ type: "pin", topicId: "apis" });
  store.dispatch({ type: "exploreLesson", topicId: "apis" });
  store.dispatch({
    type: "recordQuiz",
    topicId: "apis",
    attempt: { correct: 2, total: 3 },
  });
  persistLearningState(storage, store.getState());

  assert.deepEqual(store.getState(), {
    pinnedTopicId: "apis",
    exploredLessonIds: ["apis"],
    quizAttempts: { apis: { correct: 2, total: 3 } },
    missionStates: {},
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], LEARNING_ROUTE_STORAGE_KEY);
  assert.deepEqual(JSON.parse(writes[0][1]), store.getState());
});
