import test from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_PROGRESS_MESSAGE,
  createFocusLensClient,
  createGitHubMissionClient,
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

test("focus-lens preview, save, and reload use same-origin requests and report unavailable saves honestly", async () => {
  const requests = [];
  const client = createFocusLensClient({
    fetchImpl: async (url, options = {}) => {
      requests.push([url, options]);
      if (url === "/api/focus-lenses" && options.method === "GET") {
        return { ok: true, json: async () => ({ lenses: [] }) };
      }
      if (url === "/api/focus-lenses/preview") {
        return { ok: true, json: async () => ({ skills: [{ topicId: "apis", weight: 0.7 }] }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });

  const preview = await client.preview({ kind: "job", originalText: "Build an API" });
  const saved = await client.save({
    kind: "job",
    originalText: "Build an API",
    skills: [{ topicId: "apis", weight: 0.7 }],
    isActive: true,
  });
  const lenses = await client.list();

  assert.deepEqual(preview, { skills: [{ topicId: "apis", weight: 0.7 }] });
  assert.equal(saved, null);
  assert.deepEqual(lenses, []);
  assert.equal(requests[0][0], "/api/focus-lenses/preview");
  assert.equal(requests[0][1].credentials, "same-origin");
  assert.equal(requests[1][0], "/api/focus-lenses");
  assert.equal(requests[1][1].method, "POST");
  assert.equal(requests[2][1].method, "GET");
});

test("GitHub mission verification uses only server-returned repository choices and a fixed authorization route", async () => {
  const requests = [];
  const navigations = [];
  const client = createGitHubMissionClient({
    fetchImpl: async (url, options = {}) => {
      requests.push([url, options]);
      if (url === "/api/auth/github/login") {
        return { ok: false, status: 0, type: "opaqueredirect" };
      }
      if (url === "/api/github/installations") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            connected: true,
            installations: [{
              id: 7,
              accountLogin: "octo-org",
              repositories: [{
                id: 42,
                fullName: "octo-org/refocus",
                defaultBranch: "main",
                selected: false,
              }],
            }],
          }),
        };
      }
      if (url === "/api/github/repositories/42") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 42,
            fullName: "octo-org/refocus",
            defaultBranch: "main",
            selected: true,
          }),
        };
      }
      if (url === "/api/missions/api-service-v1/verify") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "verified",
            evidence: ["Required files found"],
            reason: null,
          }),
        };
      }
      if (url === "/api/github/connection") {
        return { ok: true, status: 204, json: async () => ({}) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    navigate: (url) => navigations.push(url),
  });

  const installations = await client.listInstallations();
  const selected = await client.selectRepository(42);
  const rejectedSelection = await client.selectRepository("42");
  const verification = await client.verifyMission("api-service-v1");
  const rejectedMission = await client.verifyMission("not/a-mission");
  const disconnected = await client.disconnect();
  const authorization = await client.startConnection();

  assert.equal(installations.installations[0].repositories[0].id, 42);
  assert.equal(selected.selected, true);
  assert.equal(rejectedSelection, null);
  assert.deepEqual(verification, {
    status: "verified",
    evidence: ["Required files found"],
    reason: null,
  });
  assert.equal(rejectedMission, null);
  assert.equal(disconnected, true);
  assert.deepEqual(authorization, { started: true });
  assert.deepEqual(navigations, ["/api/auth/github/login"]);

  assert.equal(requests[0][0], "/api/github/installations");
  assert.equal(requests[0][1].credentials, "same-origin");
  assert.equal(requests[1][0], "/api/github/repositories/42");
  assert.equal(requests[1][1].method, "PUT");
  assert.equal("body" in requests[1][1], false);
  assert.equal(requests[2][0], "/api/missions/api-service-v1/verify");
  assert.equal(requests[2][1].body, "{}");
  assert.equal(requests[3][0], "/api/github/connection");
  assert.equal(requests[3][1].method, "DELETE");
  assert.equal(requests[4][0], "/api/auth/github/login");
  assert.equal(requests[4][1].redirect, "manual");
});

test("GitHub mission authorization does not navigate when the app is not configured", async () => {
  const navigations = [];
  const client = createGitHubMissionClient({
    fetchImpl: async () => ({ ok: false, status: 503, type: "basic" }),
    navigate: (url) => navigations.push(url),
  });

  const authorization = await client.startConnection();

  assert.deepEqual(authorization, { started: false, reason: "not_configured" });
  assert.deepEqual(navigations, []);
});
