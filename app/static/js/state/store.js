export const LEARNING_ROUTE_STORAGE_KEY = "engineeringLearningRoute.v1";

const EMPTY_LEARNING_STATE = Object.freeze({
  pinnedTopicId: null,
  exploredLessonIds: [],
  quizAttempts: {},
  missionStates: {},
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueStringIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.length > 0))];
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function normaliseFocusScores(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([topicId, weight]) => (
      typeof topicId === "string"
      && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topicId)
      && typeof weight === "number"
      && Number.isFinite(weight)
      && weight >= 0
      && weight <= 1
    )),
  );
}

function normaliseFocusSkills(skills) {
  if (!Array.isArray(skills)) return {};
  return normaliseFocusScores(Object.fromEntries(skills.flatMap((skill) => (
    isRecord(skill) ? [[skill.topicId, skill.weight]] : []
  ))));
}

function normaliseQuizAttempts(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, attempt]) => (
      isRecord(attempt)
      && isNonNegativeInteger(attempt.correct)
      && isNonNegativeInteger(attempt.total)
      && attempt.correct <= attempt.total
    )),
  );
}

function normaliseMissionStates(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, missionState]) => isRecord(missionState)),
  );
}

function normalisePendingProgress(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record) => {
    if (!isRecord(record) || !isRecord(record.payload)) return [];
    if (record.kind === "quizAttempt") {
      const { attemptId, lessonId, answers } = record.payload;
      const isAnswer = (answer) => isRecord(answer)
        && typeof answer.questionId === "string"
        && Number.isInteger(answer.choiceIndex)
        && typeof answer.correct === "boolean";
      if (
        typeof lessonId !== "string"
        || !Array.isArray(answers)
        || !answers.every(isAnswer)
        || (attemptId !== undefined && typeof attemptId !== "string")
      ) return [];
      return [{
        kind: "quizAttempt",
        payload: {
          ...(typeof attemptId === "string" ? { attemptId } : {}),
          lessonId,
          answers: answers.map(({ questionId, choiceIndex, correct }) => ({ questionId, choiceIndex, correct })),
        },
      }];
    }
    if (record.kind === "topicProgress") {
      const { topicId, status } = record.payload;
      if (typeof topicId !== "string" || !["explored", "completed"].includes(status)) return [];
      return [{ kind: "topicProgress", payload: { topicId, status } }];
    }
    return [];
  });
}

function queuePendingProgress(state, record) {
  const [pendingRecord] = normalisePendingProgress([record]);
  if (!pendingRecord) return state;

  const isSameAttempt = (candidate) => candidate.kind === pendingRecord.kind
    && candidate.payload.attemptId
    && candidate.payload.attemptId === pendingRecord.payload.attemptId;
  return {
    ...state,
    pendingProgress: [
      ...(state.pendingProgress ?? []).filter((candidate) => !isSameAttempt(candidate)),
      pendingRecord,
    ],
  };
}

export function normaliseLearningState(value) {
  if (!isRecord(value)) return { ...EMPTY_LEARNING_STATE };

  const pendingProgress = normalisePendingProgress(value.pendingProgress);
  const jobScores = normaliseFocusScores(value.jobScores);
  const developmentScores = normaliseFocusScores(value.developmentScores);

  return {
    pinnedTopicId: typeof value.pinnedTopicId === "string" ? value.pinnedTopicId : null,
    exploredLessonIds: uniqueStringIds(value.exploredLessonIds),
    quizAttempts: normaliseQuizAttempts(value.quizAttempts),
    missionStates: normaliseMissionStates(value.missionStates),
    ...(Object.keys(jobScores).length > 0 ? { jobScores } : {}),
    ...(Object.keys(developmentScores).length > 0 ? { developmentScores } : {}),
    ...(pendingProgress.length > 0 ? { pendingProgress } : {}),
  };
}

export function loadLearningState(storage) {
  try {
    const targetStorage = storage === undefined ? globalThis.localStorage : storage;
    if (!targetStorage || typeof targetStorage.getItem !== "function") {
      return normaliseLearningState();
    }
    const cached = targetStorage.getItem(LEARNING_ROUTE_STORAGE_KEY);
    return cached ? normaliseLearningState(JSON.parse(cached)) : normaliseLearningState();
  } catch {
    return normaliseLearningState();
  }
}

export function persistLearningState(storage, state) {
  try {
    const targetStorage = storage === undefined ? globalThis.localStorage : storage;
    if (!targetStorage || typeof targetStorage.setItem !== "function") return false;
    targetStorage.setItem(LEARNING_ROUTE_STORAGE_KEY, JSON.stringify(normaliseLearningState(state)));
    return true;
  } catch {
    return false;
  }
}

function reduce(state, action) {
  switch (action?.type) {
    case "pin":
      return { ...state, pinnedTopicId: action.topicId };
    case "unpin":
      return {
        ...state,
        pinnedTopicId: action.topicId && state.pinnedTopicId !== action.topicId
          ? state.pinnedTopicId
          : null,
      };
    case "exploreLesson":
      return {
        ...state,
        exploredLessonIds: uniqueStringIds([...state.exploredLessonIds, action.topicId]),
      };
    case "recordQuiz":
      return {
        ...state,
        quizAttempts: { ...state.quizAttempts, [action.topicId]: action.attempt },
      };
    case "queuePendingProgress":
      return queuePendingProgress(state, action.record);
    case "applyFocusLens": {
      const scoreKey = action.kind === "job"
        ? "jobScores"
        : action.kind === "development"
          ? "developmentScores"
          : null;
      if (scoreKey === null) return state;
      return { ...state, [scoreKey]: normaliseFocusSkills(action.skills) };
    }
    case "saveMission":
      return {
        ...state,
        missionStates: { ...state.missionStates, [action.missionId]: action.missionState },
      };
    default:
      return state;
  }
}

export function createStore(initialState = EMPTY_LEARNING_STATE) {
  let state = normaliseLearningState(initialState);
  const listeners = new Set();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(action) {
      const nextState = reduce(state, action);
      if (nextState !== state) {
        state = nextState;
        for (const listener of listeners) listener(state, action);
      }
      return state;
    },
  };
}
