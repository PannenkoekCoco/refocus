export const PENDING_PROGRESS_MESSAGE = "Saved locally; sign in or retry to sync.";
export const LOCAL_PROGRESS_UNAVAILABLE_MESSAGE = "Progress could not be saved locally. It is available for this session only.";

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
