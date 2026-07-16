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

export function normaliseLearningState(value) {
  if (!isRecord(value)) return { ...EMPTY_LEARNING_STATE };

  return {
    pinnedTopicId: typeof value.pinnedTopicId === "string" ? value.pinnedTopicId : null,
    exploredLessonIds: uniqueStringIds(value.exploredLessonIds),
    quizAttempts: normaliseQuizAttempts(value.quizAttempts),
    missionStates: normaliseMissionStates(value.missionStates),
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
