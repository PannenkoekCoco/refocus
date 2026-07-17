import { normalisePendingProgress, pendingProgressKey } from "../state/store.js";

export const PENDING_PROGRESS_MESSAGE = "Saved locally; sign in or retry to sync.";
export const LOCAL_PROGRESS_UNAVAILABLE_MESSAGE = "Progress could not be saved locally. It is available for this session only.";

const FOCUS_LENS_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isProgressSnapshotTopic(value) {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.topicId === "string"
    && MISSION_ID_PATTERN.test(value.topicId)
    && ["explored", "completed"].includes(value.status)
    && typeof value.updatedAt === "string";
}

function isProgressSnapshotAttempt(value) {
  return isRecord(value)
    && typeof value.lessonId === "string"
    && isNonNegativeInteger(value.correct)
    && isNonNegativeInteger(value.total)
    && value.correct <= value.total;
}

function isProgressSnapshotMission(value) {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.missionId === "string"
    && MISSION_ID_PATTERN.test(value.missionId)
    && ["guided", "byop"].includes(value.approach)
    && typeof value.reflection === "string"
    && value.reflection.length <= 500
    && value.status === "self_reviewed"
    && typeof value.updatedAt === "string";
}

function isProgressSnapshot(value) {
  return isRecord(value)
    && Array.isArray(value.topics)
    && Array.isArray(value.quizAttempts)
    && Array.isArray(value.missions)
    && value.topics.every(isProgressSnapshotTopic)
    && value.quizAttempts.every(isProgressSnapshotAttempt)
    && value.missions.every(isProgressSnapshotMission);
}

function isGitHubRepository(value) {
  return value
    && typeof value === "object"
    && isPositiveSafeInteger(value.id)
    && typeof value.fullName === "string"
    && typeof value.defaultBranch === "string"
    && typeof value.selected === "boolean";
}

function isGitHubInstallationsResponse(value) {
  return value
    && typeof value === "object"
    && typeof value.connected === "boolean"
    && Array.isArray(value.installations)
    && value.installations.every((installation) => (
      installation
      && typeof installation === "object"
      && isPositiveSafeInteger(installation.id)
      && typeof installation.accountLogin === "string"
      && Array.isArray(installation.repositories)
      && installation.repositories.every(isGitHubRepository)
    ));
}

function isVerificationResponse(value) {
  return value
    && typeof value === "object"
    && ["verified", "needs_attention"].includes(value.status)
    && Array.isArray(value.evidence)
    && value.evidence.every((item) => typeof item === "string")
    && (value.reason === null || typeof value.reason === "string");
}

function defaultNavigate(url) {
  globalThis.location?.assign?.(url);
}

function newAttemptId() {
  return globalThis.crypto?.randomUUID?.();
}

function queuePendingRecord(queuePendingProgress, record) {
  try {
    return queuePendingProgress(record) === true;
  } catch {
    return false;
  }
}

function announcePendingPersistence(onPending, persisted) {
  onPending(persisted ? PENDING_PROGRESS_MESSAGE : LOCAL_PROGRESS_UNAVAILABLE_MESSAGE);
}

function notifyProgressQueued(callback, record) {
  try {
    callback(record);
  } catch {
    // Scheduling a later sync must not undo a record that is already durable locally.
  }
}

function progressRequest(record) {
  if (record.kind === "quizAttempt") {
    return {
      url: "/api/progress/quiz-attempts",
      options: {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record.payload),
      },
    };
  }
  if (record.kind === "topicProgress") {
    return {
      url: `/api/progress/topic/${encodeURIComponent(record.payload.topicId)}`,
      options: {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: record.payload.status }),
      },
    };
  }
  if (record.kind === "missionProgress") {
    const { missionId, ...missionState } = record.payload;
    return {
      url: `/api/progress/missions/${encodeURIComponent(missionId)}`,
      options: {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(missionState),
      },
    };
  }
  throw new TypeError("Unsupported progress record");
}

export function createProgressClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  queuePendingProgress = () => false,
  onPending = () => {},
  onQueued = () => {},
} = {}) {
  async function sendProgressRecord(record) {
    const [normalisedRecord] = normalisePendingProgress([record]);
    if (!normalisedRecord) throw new TypeError("Invalid progress record");
    if (typeof fetchImpl !== "function") throw new TypeError("Fetch is unavailable");
    const { url, options } = progressRequest(normalisedRecord);
    return fetchImpl(url, options);
  }

  function queueProgressRecord(record) {
    const [normalisedRecord] = normalisePendingProgress([record]);
    if (!normalisedRecord) {
      announcePendingPersistence(onPending, false);
      return null;
    }
    const persisted = queuePendingRecord(queuePendingProgress, normalisedRecord);
    if (!persisted) {
      announcePendingPersistence(onPending, false);
      return null;
    }
    notifyProgressQueued(onQueued, normalisedRecord);
    return null;
  }

  async function saveQuizAttempt(attempt) {
    const payload = {
      ...attempt,
      ...(attempt.attemptId ? {} : { attemptId: newAttemptId() }),
    };
    return queueProgressRecord({ kind: "quizAttempt", payload });
  }

  async function saveTopicProgress(topicId, status) {
    return queueProgressRecord({ kind: "topicProgress", payload: { topicId, status } });
  }

  async function saveMissionProgress(missionId, missionState) {
    return queueProgressRecord({
      kind: "missionProgress",
      payload: { ...missionState, missionId },
    });
  }

  async function loadSnapshot() {
    try {
      if (typeof fetchImpl !== "function") throw new TypeError("Fetch is unavailable");
      const response = await fetchImpl("/api/progress", { credentials: "same-origin" });
      if (!response.ok) return null;
      const snapshot = await response.json();
      return isProgressSnapshot(snapshot) ? snapshot : null;
    } catch {
      return null;
    }
  }

  async function replayPendingProgress(records) {
    const acknowledged = [];
    const replayedKeys = new Set();
    for (const record of normalisePendingProgress(records)) {
      const recordKey = pendingProgressKey(record);
      if (!recordKey || replayedKeys.has(recordKey)) continue;
      replayedKeys.add(recordKey);
      try {
        const response = await sendProgressRecord(record);
        if (response.ok) acknowledged.push(recordKey);
      } catch {
        // The store retains this exact record until a later replay acknowledges it.
      }
    }
    return acknowledged;
  }

  async function saveQuizAttemptAndRefresh(attempt, refreshRecommendation) {
    const savedAttempt = await saveQuizAttempt(attempt);
    return {
      attempt: savedAttempt,
      recommendation: await refreshRecommendation(),
    };
  }

  return {
    saveQuizAttempt,
    saveTopicProgress,
    saveMissionProgress,
    loadSnapshot,
    replayPendingProgress,
    saveQuizAttemptAndRefresh,
  };
}

export function createFocusLensClient({ fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  async function request(url, options) {
    try {
      if (typeof fetchImpl !== "function") throw new TypeError("Fetch is unavailable");
      const response = await fetchImpl(url, {
        credentials: "same-origin",
        ...options,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async function preview({ kind, originalText }) {
    return request("/api/focus-lenses/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, originalText }),
    });
  }

  async function list() {
    const payload = await request("/api/focus-lenses", { method: "GET" });
    return Array.isArray(payload?.lenses) ? payload.lenses : null;
  }

  async function save({ id, kind, originalText, skills, isActive }) {
    const isPersistedLens = typeof id === "string" && FOCUS_LENS_ID_PATTERN.test(id);
    const endpoint = isPersistedLens
      ? `/api/focus-lenses/${encodeURIComponent(id)}`
      : "/api/focus-lenses";
    const payload = isPersistedLens
      ? { originalText, skills, isActive }
      : { kind, originalText, skills, isActive };
    return request(endpoint, {
      method: isPersistedLens ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  return { preview, list, save };
}

export function createGitHubMissionClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  navigate = defaultNavigate,
} = {}) {
  async function request(url, options = {}) {
    try {
      if (typeof fetchImpl !== "function") throw new TypeError("Fetch is unavailable");
      const response = await fetchImpl(url, {
        credentials: "same-origin",
        ...options,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async function listInstallations() {
    const payload = await request("/api/github/installations", { method: "GET" });
    return isGitHubInstallationsResponse(payload) ? payload : null;
  }

  async function selectRepository(repositoryId) {
    if (!isPositiveSafeInteger(repositoryId)) return null;
    const payload = await request(`/api/github/repositories/${repositoryId}`, { method: "PUT" });
    return isGitHubRepository(payload) ? payload : null;
  }

  async function verifyMission(missionId, { deploymentUrl } = {}) {
    if (typeof missionId !== "string" || !MISSION_ID_PATTERN.test(missionId)) return null;
    const payload = {};
    if (typeof deploymentUrl === "string" && deploymentUrl.length <= 2_048) {
      payload.deploymentUrl = deploymentUrl;
    }
    const verification = await request(`/api/missions/${encodeURIComponent(missionId)}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return isVerificationResponse(verification) ? verification : null;
  }

  async function disconnect() {
    try {
      if (typeof fetchImpl !== "function") throw new TypeError("Fetch is unavailable");
      const response = await fetchImpl("/api/github/connection", {
        method: "DELETE",
        credentials: "same-origin",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function startConnection() {
    try {
      if (typeof fetchImpl !== "function") throw new TypeError("Fetch is unavailable");
      const response = await fetchImpl("/api/auth/github/login", {
        credentials: "same-origin",
        redirect: "manual",
      });
      if (response.status === 503) return { started: false, reason: "not_configured" };
      if (response.type === "opaqueredirect" || [301, 302, 303, 307, 308].includes(response.status)) {
        if (typeof navigate !== "function") return { started: false, reason: "unavailable" };
        navigate("/api/auth/github/login");
        return { started: true };
      }
      return { started: false, reason: "unavailable" };
    } catch {
      return { started: false, reason: "unavailable" };
    }
  }

  return {
    listInstallations,
    selectRepository,
    verifyMission,
    disconnect,
    startConnection,
  };
}
