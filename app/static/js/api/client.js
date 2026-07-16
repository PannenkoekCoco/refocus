export const PENDING_PROGRESS_MESSAGE = "Saved locally; sign in or retry to sync.";
export const LOCAL_PROGRESS_UNAVAILABLE_MESSAGE = "Progress could not be saved locally. It is available for this session only.";

const FOCUS_LENS_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
