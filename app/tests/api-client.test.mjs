import test from "node:test";
import assert from "node:assert/strict";
import {
  createFocusLensClient,
  createGitHubMissionClient,
  createProgressClient,
} from "../static/js/api/client.js";
import {
  LEARNING_ROUTE_STORAGE_KEY,
  createStore,
  loadLearningState,
  pendingProgressKey,
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

const missionState = {
  approach: "guided",
  reflection: "Describe the API contract and the security boundary.",
  status: "self_reviewed",
};

test("a durable progress save queues a narrow record before sync transport runs", async () => {
  const storage = createStorage({ pinnedTopicId: "apis" });
  const messages = [];
  const queued = [];
  let fetchCalls = 0;
  const { queuePendingProgress } = createStateBackedQueue(storage);
  const client = createProgressClient({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("Direct saves must not send progress themselves.");
    },
    queuePendingProgress,
    onPending: (message) => messages.push(message),
    onQueued: (record) => queued.push(record),
  });

  const result = await client.saveQuizAttempt(attempt);
  const persisted = JSON.parse(storage.getItem(LEARNING_ROUTE_STORAGE_KEY));

  assert.equal(result, null);
  assert.deepEqual(messages, []);
  assert.deepEqual(queued, [{ kind: "quizAttempt", payload: attempt }]);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(persisted.pendingProgress, [{ kind: "quizAttempt", payload: attempt }]);
  assert.equal("session" in persisted, false);
});

test("a queued durable save survives a later ordinary learning-state update without fetching", async () => {
  const storage = createStorage({ pinnedTopicId: "apis" });
  const { store, queuePendingProgress } = createStateBackedQueue(storage);
  let fetchCalls = 0;
  const client = createProgressClient({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("Direct saves must not fetch.");
    },
    queuePendingProgress,
  });

  await client.saveQuizAttempt(attempt);
  store.dispatch({ type: "pin", topicId: "sql" });

  const persisted = JSON.parse(storage.getItem(LEARNING_ROUTE_STORAGE_KEY));
  assert.deepEqual(persisted.pendingProgress, [{ kind: "quizAttempt", payload: attempt }]);
  assert.equal(persisted.pinnedTopicId, "sql");
  assert.equal(fetchCalls, 0);
});

test("a durable progress save does not claim a local sync record when storage rejects it", async () => {
  const messages = [];
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error("storage blocked"); },
  };
  const { queuePendingProgress } = createStateBackedQueue(storage);
  const client = createProgressClient({
    fetchImpl: async () => { throw new Error("Direct saves must not fetch."); },
    queuePendingProgress,
    onPending: (message) => messages.push(message),
  });

  const result = await client.saveQuizAttempt(attempt);

  assert.equal(result, null);
  assert.deepEqual(messages, [
    "Progress could not be saved locally. It is available for this session only.",
  ]);
});

test("a quiz attempt is durably queued before a caller refreshes recommendations", async () => {
  const events = [];
  const client = createProgressClient({
    fetchImpl: async (url, options) => {
      events.push([url, options]);
      throw new Error("Recommendation refresh must not trigger a direct progress write.");
    },
    queuePendingProgress: (record) => {
      events.push(["queue", record]);
      return true;
    },
    onQueued: (record) => events.push(["queued", record]),
  });

  const result = await client.saveQuizAttemptAndRefresh(attempt, async () => {
    events.push(["refresh"]);
    return { topicId: "sql" };
  });

  assert.equal(events[0][0], "queue");
  assert.equal(events[1][0], "queued");
  assert.equal(events[2][0], "refresh");
  assert.equal(events[0][1].kind, "quizAttempt");
  assert.equal(events[0][1].payload.attemptId, attempt.attemptId);
  assert.equal(result.attempt, null);
  assert.deepEqual(result.recommendation, { topicId: "sql" });
});

test("a queued quiz save records local pending progress before refreshing recommendations", async () => {
  const storage = createStorage();
  const { queuePendingProgress } = createStateBackedQueue(storage);
  let fetchCalls = 0;
  let refreshCalls = 0;
  const client = createProgressClient({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("Direct saves must not fetch.");
    },
    queuePendingProgress,
  });

  const completion = client.saveQuizAttemptAndRefresh(attempt, async () => {
    refreshCalls += 1;
    const persisted = JSON.parse(storage.getItem(LEARNING_ROUTE_STORAGE_KEY));
    assert.deepEqual(persisted.pendingProgress, [{ kind: "quizAttempt", payload: attempt }]);
    return { topicId: "sql" };
  });

  const result = await completion;

  assert.equal(refreshCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(result.attempt, null);
  assert.deepEqual(result.recommendation, { topicId: "sql" });
});

test("a progress snapshot falls back to null for an anonymous response", async () => {
  const requests = [];
  const client = createProgressClient({
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return { ok: false, status: 401, json: async () => ({}) };
    },
  });

  assert.equal(await client.loadSnapshot(), null);
  assert.deepEqual(requests, [["/api/progress", { credentials: "same-origin" }]]);
});

test("a progress snapshot rejects numeric topic and mission identifiers", async () => {
  const snapshots = [{
    topics: [{
      id: "00000000-0000-0000-0000-000000000001",
      topicId: 42,
      status: "explored",
      updatedAt: "2026-07-17T00:00:00Z",
    }],
    quizAttempts: [],
    missions: [],
  }, {
    topics: [],
    quizAttempts: [],
    missions: [{
      id: "00000000-0000-0000-0000-000000000002",
      missionId: 42,
      ...missionState,
      updatedAt: "2026-07-17T00:00:00Z",
    }],
  }];
  const client = createProgressClient({
    fetchImpl: async () => ({ ok: true, json: async () => snapshots.shift() }),
  });

  assert.equal(await client.loadSnapshot(), null);
  assert.equal(await client.loadSnapshot(), null);
});

test("progress saves reject numeric identifiers before they enter the durable outbox", async () => {
  const queued = [];
  let fetchCalls = 0;
  const client = createProgressClient({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("Direct saves must not fetch.");
    },
    queuePendingProgress: (record) => {
      queued.push(record);
      return true;
    },
  });

  assert.equal(await client.saveTopicProgress(42, "explored"), null);
  assert.equal(await client.saveMissionProgress(42, missionState), null);
  assert.deepEqual(queued, []);
  assert.equal(fetchCalls, 0);
});

test("a direct mission save survives a stale snapshot through the durable outbox", async () => {
  const localMissionState = {
    approach: "guided",
    reflection: "Keep this direct local reflection.",
    status: "self_reviewed",
  };
  const directRecord = {
    kind: "missionProgress",
    payload: { missionId: "api-service-v1", ...localMissionState },
  };
  const storage = createStorage();
  const { store, queuePendingProgress } = createStateBackedQueue(storage);
  let resolveSnapshot;
  let writes = 0;
  const client = createProgressClient({
    fetchImpl: (url) => {
      if (url === "/api/progress") {
        return new Promise((resolve) => {
          resolveSnapshot = resolve;
        });
      }
      if (url === "/api/progress/missions/api-service-v1") {
        writes += 1;
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    queuePendingProgress,
  });

  const delayedSnapshot = client.loadSnapshot();
  store.dispatch({
    type: "saveMission",
    missionId: directRecord.payload.missionId,
    missionState: localMissionState,
  });
  await client.saveMissionProgress(directRecord.payload.missionId, localMissionState);

  resolveSnapshot({
    ok: true,
    json: async () => ({
      topics: [],
      quizAttempts: [],
      missions: [{
        id: "00000000-0000-0000-0000-000000000003",
        missionId: "api-service-v1",
        approach: "byop",
        reflection: "This stale server value must not win.",
        status: "self_reviewed",
        updatedAt: "2026-07-17T00:00:00Z",
      }],
    }),
  });
  store.dispatch({ type: "hydrateServerProgress", snapshot: await delayedSnapshot });

  assert.deepEqual(store.getState().missionStates["api-service-v1"], localMissionState);
  assert.deepEqual(store.getState().pendingProgress, [directRecord]);
  assert.equal(writes, 0);
  store.dispatch({
    type: "ackPendingProgress",
    keys: [pendingProgressKey({
      kind: "missionProgress",
      payload: { ...directRecord.payload, reflection: "A newer reflection." },
    })],
  });
  assert.deepEqual(store.getState().pendingProgress, [directRecord]);

  const acknowledged = await client.replayPendingProgress(store.getState().pendingProgress);
  assert.deepEqual(acknowledged, [pendingProgressKey(directRecord)]);
  assert.equal(writes, 1);
  store.dispatch({ type: "ackPendingProgress", keys: acknowledged });

  assert.equal("pendingProgress" in store.getState(), false);
});

test("a failed durable-outbox replay retains local mission work after a stale snapshot", async () => {
  const localMissionState = {
    approach: "guided",
    reflection: "Keep this local reflection until the replay succeeds.",
    status: "self_reviewed",
  };
  const directRecord = {
    kind: "missionProgress",
    payload: { missionId: "api-service-v1", ...localMissionState },
  };
  const storage = createStorage();
  const { store, queuePendingProgress } = createStateBackedQueue(storage);
  let resolveSnapshot;
  let writes = 0;
  const client = createProgressClient({
    fetchImpl: (url) => {
      if (url === "/api/progress") {
        return new Promise((resolve) => {
          resolveSnapshot = resolve;
        });
      }
      if (url === "/api/progress/missions/api-service-v1") {
        writes += 1;
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    queuePendingProgress,
  });

  const delayedSnapshot = client.loadSnapshot();
  store.dispatch({
    type: "saveMission",
    missionId: directRecord.payload.missionId,
    missionState: localMissionState,
  });
  await client.saveMissionProgress(directRecord.payload.missionId, localMissionState);

  resolveSnapshot({
    ok: true,
    json: async () => ({
      topics: [],
      quizAttempts: [],
      missions: [{
        id: "00000000-0000-0000-0000-000000000004",
        missionId: "api-service-v1",
        approach: "byop",
        reflection: "This stale server value must not win either.",
        status: "self_reviewed",
        updatedAt: "2026-07-17T00:00:00Z",
      }],
    }),
  });
  store.dispatch({ type: "hydrateServerProgress", snapshot: await delayedSnapshot });

  assert.deepEqual(store.getState().missionStates["api-service-v1"], localMissionState);
  assert.deepEqual(store.getState().pendingProgress, [directRecord]);
  assert.equal(writes, 0);

  const acknowledged = await client.replayPendingProgress(store.getState().pendingProgress);

  assert.deepEqual(acknowledged, []);
  assert.equal(writes, 1);
  assert.deepEqual(store.getState().pendingProgress, [directRecord]);
  assert.deepEqual(store.getState().missionStates["api-service-v1"], localMissionState);
});

test("a pending replay acknowledges only the progress records whose writes succeed", async () => {
  const topicRecord = {
    kind: "topicProgress",
    payload: { topicId: "apis", status: "explored" },
  };
  const missionRecord = {
    kind: "missionProgress",
    payload: { missionId: "api-service-v1", ...missionState },
  };
  const requests = [];
  const client = createProgressClient({
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return {
        ok: url.endsWith("/apis"),
        status: url.endsWith("/apis") ? 200 : 503,
        json: async () => ({}),
      };
    },
  });

  const acknowledged = await client.replayPendingProgress([topicRecord, missionRecord]);

  assert.deepEqual(acknowledged, [pendingProgressKey(topicRecord)]);
  assert.deepEqual(requests, [
    ["/api/progress/topic/apis", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "explored" }),
    }],
    ["/api/progress/missions/api-service-v1", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(missionState),
    }],
  ]);
});

test("a mission self-review is durably queued before sync transport runs", async () => {
  const storage = createStorage();
  const { queuePendingProgress } = createStateBackedQueue(storage);
  const messages = [];
  let fetchCalls = 0;
  const client = createProgressClient({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("Direct saves must not fetch.");
    },
    queuePendingProgress,
    onPending: (message) => messages.push(message),
  });

  const result = await client.saveMissionProgress("api-service-v1", missionState);

  assert.equal(result, null);
  assert.deepEqual(messages, []);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(JSON.parse(storage.getItem(LEARNING_ROUTE_STORAGE_KEY)).pendingProgress, [{
    kind: "missionProgress",
    payload: { missionId: "api-service-v1", ...missionState },
  }]);
});

test("a mission self-review keeps the explicit mission ID as its queued write authority", async () => {
  const requests = [];
  const storage = createStorage();
  const { store, queuePendingProgress } = createStateBackedQueue(storage);
  const client = createProgressClient({
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
        return { ok: true, status: 200, json: async () => ({}) };
    },
    queuePendingProgress,
  });

  await client.saveMissionProgress("api-service-v1", {
    ...missionState,
    missionId: "python-tool-v1",
  });

  assert.deepEqual(store.getState().pendingProgress, [{
    kind: "missionProgress",
    payload: { missionId: "api-service-v1", ...missionState },
  }]);
  assert.deepEqual(requests, []);

  await client.replayPendingProgress(store.getState().pendingProgress);

  assert.deepEqual(requests, [["/api/progress/missions/api-service-v1", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(missionState),
  }]]);
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
