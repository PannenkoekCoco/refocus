export const PENDING_PROGRESS_MESSAGE = "Saved locally; sign in or retry to sync.";
export const LOCAL_PROGRESS_UNAVAILABLE_MESSAGE = "Progress could not be saved locally. It is available for this session only.";

const FOCUS_LENS_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
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

export function createProgressClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  queuePendingProgress = () => false,
  onPending = () => {},
} = {}) {
  async function saveQuizAttempt(attempt) {
    const payload = {
      ...attempt,
      ...(attempt.attemptId ? {} : { attemptId: newAttemptId() }),
    };
    try {
      if (typeof fetchImpl !== "function") throw new TypeError("Fetch is unavailable");
      const response = await fetchImpl("/api/progress/quiz-attempts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("Progress sync failed");
      return await response.json();
    } catch {
      announcePendingPersistence(
        onPending,
        queuePendingRecord(queuePendingProgress, { kind: "quizAttempt", payload }),
      );
      return null;
    }
  }

  async function saveTopicProgress(topicId, status) {
    try {
      if (typeof fetchImpl !== "function") throw new TypeError("Fetch is unavailable");
      const response = await fetchImpl(`/api/progress/topic/${encodeURIComponent(topicId)}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error("Progress sync failed");
      return await response.json();
    } catch {
      announcePendingPersistence(
        onPending,
        queuePendingRecord(queuePendingProgress, { kind: "topicProgress", payload: { topicId, status } }),
      );
      return null;
    }
  }

  async function saveQuizAttemptAndRefresh(attempt, refreshRecommendation) {
    const savedAttempt = await saveQuizAttempt(attempt);
    return {
      attempt: savedAttempt,
      recommendation: await refreshRecommendation(),
    };
  }

  return { saveQuizAttempt, saveTopicProgress, saveQuizAttemptAndRefresh };
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
