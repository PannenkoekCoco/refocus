import test from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_PROGRESS_MESSAGE,
  createProgressClient,
} from "../static/js/api/client.js";
import {
  LEARNING_ROUTE_STORAGE_KEY,
  createStore,
  loadLearningState,
  persistLearningState,
} from "../static/js/state/store.js";

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue) values.set(LEARNING_ROUTE_STORAGE_KEY, JSON.stringify(initialValue));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function createStateBackedQueue(storage) {
  const store = createStore(loadLearningState(storage));
  let latestPersistenceSucceeded = true;
  store.subscribe((state) => {
    latestPersistenceSucceeded = persistLearningState(storage, state);
  });
  return {
    store,
    queuePendingProgress(record) {
      store.dispatch({ type: "queuePendingProgress", record });
      return latestPersistenceSucceeded;
    },
  };
}

const attempt = {
  attemptId: "5dd72f13-4d53-4a7d-9d07-c17b9e8ff89b",
  lessonId: "apis-1",
  answers: [{ questionId: "invalid-input", choiceIndex: 1, correct: true }],
};

test("a failed progress save keeps a narrow pending record and exposes the sync message", async () => {
  const storage = createStorage({ pinnedTopicId: "apis" });
  const messages = [];
  const { queuePendingProgress } = createStateBackedQueue(storage);
  const client = createProgressClient({
    fetchImpl: async () => { throw new TypeError("offline"); },
    queuePendingProgress,
    onPending: (message) => messages.push(message),
  });

  const result = await client.saveQuizAttempt(attempt);
  const persisted = JSON.parse(storage.getItem(LEARNING_ROUTE_STORAGE_KEY));

  assert.equal(result, null);
  assert.deepEqual(messages, [PENDING_PROGRESS_MESSAGE]);
  assert.equal(PENDING_PROGRESS_MESSAGE, "Saved locally; sign in or retry to sync.");
  assert.deepEqual(persisted.pendingProgress, [{ kind: "quizAttempt", payload: attempt }]);
  assert.equal("session" in persisted, false);
});

test("a queued offline save survives a later ordinary learning-state update", async () => {
  const storage = createStorage({ pinnedTopicId: "apis" });
  const { store, queuePendingProgress } = createStateBackedQueue(storage);
  const client = createProgressClient({
    fetchImpl: async () => { throw new TypeError("offline"); },
    queuePendingProgress,
  });

  await client.saveQuizAttempt(attempt);
  store.dispatch({ type: "pin", topicId: "sql" });

  const persisted = JSON.parse(storage.getItem(LEARNING_ROUTE_STORAGE_KEY));
  assert.deepEqual(persisted.pendingProgress, [{ kind: "quizAttempt", payload: attempt }]);
  assert.equal(persisted.pinnedTopicId, "sql");
});

test("a failed progress save does not claim a local sync record when storage rejects it", async () => {
  const messages = [];
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error("storage blocked"); },
  };
  const { queuePendingProgress } = createStateBackedQueue(storage);
  const client = createProgressClient({
    fetchImpl: async () => { throw new TypeError("offline"); },
    queuePendingProgress,
    onPending: (message) => messages.push(message),
  });

  const result = await client.saveQuizAttempt(attempt);

  assert.equal(result, null);
  assert.deepEqual(messages, [
    "Progress could not be saved locally. It is available for this session only.",
  ]);
});

test("a quiz attempt is saved before a caller refreshes recommendations", async () => {
  const events = [];
  const client = createProgressClient({
    fetchImpl: async (url, options) => {
      events.push([url, options]);
      return {
        ok: true,
        json: async () => ({ id: attempt.attemptId, lessonId: attempt.lessonId, answers: attempt.answers }),
      };
    },
    storage: createStorage(),
  });

  const result = await client.saveQuizAttemptAndRefresh(attempt, async () => {
    events.push(["refresh"]);
    return { topicId: "sql" };
  });

  assert.equal(events[0][0], "/api/progress/quiz-attempts");
  assert.equal(events[0][1].credentials, "same-origin");
  assert.equal(events[1][0], "refresh");
  assert.deepEqual(result.recommendation, { topicId: "sql" });
});

test("a failed quiz save records local pending progress before refreshing recommendations", async () => {
  const storage = createStorage();
  const { queuePendingProgress } = createStateBackedQueue(storage);
  let rejectSave;
  let refreshCalls = 0;
  const client = createProgressClient({
    fetchImpl: () => new Promise((resolve, reject) => {
      rejectSave = reject;
    }),
    queuePendingProgress,
  });

  const completion = client.saveQuizAttemptAndRefresh(attempt, async () => {
    refreshCalls += 1;
    const persisted = JSON.parse(storage.getItem(LEARNING_ROUTE_STORAGE_KEY));
    assert.deepEqual(persisted.pendingProgress, [{ kind: "quizAttempt", payload: attempt }]);
    return { topicId: "sql" };
  });

  await Promise.resolve();
  assert.equal(refreshCalls, 0);

  rejectSave(new TypeError("offline"));
  const result = await completion;

  assert.equal(refreshCalls, 1);
  assert.equal(result.attempt, null);
  assert.deepEqual(result.recommendation, { topicId: "sql" });
});
