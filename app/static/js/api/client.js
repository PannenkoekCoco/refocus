import {
  loadLearningState,
  persistLearningState,
} from "../state/store.js";

export const PENDING_PROGRESS_MESSAGE = "Saved locally; sign in or retry to sync.";
export const LOCAL_PROGRESS_UNAVAILABLE_MESSAGE = "Progress could not be saved locally. It is available for this session only.";

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function newAttemptId() {
  return globalThis.crypto?.randomUUID?.();
}

function appendPendingProgress(storage, record) {
  const state = loadLearningState(storage);
  const sameRecord = (candidate) => candidate.kind === record.kind
    && candidate.payload.attemptId
    && candidate.payload.attemptId === record.payload.attemptId;
  const pendingProgress = [
    ...(state.pendingProgress ?? []).filter((candidate) => !sameRecord(candidate)),
    record,
  ];
  return persistLearningState(storage, { ...state, pendingProgress });
}

function announcePendingPersistence(onPending, persisted) {
  onPending(persisted ? PENDING_PROGRESS_MESSAGE : LOCAL_PROGRESS_UNAVAILABLE_MESSAGE);
}

export function createProgressClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  storage = defaultStorage(),
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
        appendPendingProgress(storage, { kind: "quizAttempt", payload }),
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
        appendPendingProgress(storage, { kind: "topicProgress", payload: { topicId, status } }),
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
