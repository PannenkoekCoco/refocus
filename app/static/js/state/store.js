export const LEARNING_ROUTE_STORAGE_KEY = "engineeringLearningRoute.v1";

const TOPIC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MISSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function normaliseMissionState(value) {
  if (
    !isRecord(value)
    || !["guided", "byop"].includes(value.approach)
    || typeof value.reflection !== "string"
    || value.reflection.length > 500
    || value.status !== "self_reviewed"
  ) return null;
  return {
    approach: value.approach,
    reflection: value.reflection,
    status: value.status,
  };
}

function normaliseMissionStates(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([missionId, missionState]) => {
      const normalisedMission = normaliseMissionState(missionState);
      return MISSION_ID_PATTERN.test(missionId) && normalisedMission
        ? [[missionId, normalisedMission]]
        : [];
    }),
  );
}

export function normalisePendingProgress(value) {
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
      if (!TOPIC_ID_PATTERN.test(topicId) || !["explored", "completed"].includes(status)) return [];
      return [{ kind: "topicProgress", payload: { topicId, status } }];
    }
    if (record.kind === "missionProgress") {
      const { missionId } = record.payload;
      const missionState = normaliseMissionState(record.payload);
      if (!MISSION_ID_PATTERN.test(missionId) || !missionState) return [];
      return [{
        kind: "missionProgress",
        payload: { missionId, ...missionState },
      }];
    }
    return [];
  });
}

export function pendingProgressKey(record) {
  const [normalisedRecord] = normalisePendingProgress([record]);
  if (!normalisedRecord) return null;
  if (normalisedRecord.kind === "quizAttempt") {
    const { attemptId, lessonId, answers } = normalisedRecord.payload;
    return typeof attemptId === "string"
      ? `quiz:${attemptId}`
      : `quiz:${JSON.stringify([lessonId, answers])}`;
  }
  if (normalisedRecord.kind === "topicProgress") {
    return `topic:${normalisedRecord.payload.topicId}:${normalisedRecord.payload.status}`;
  }
  const { missionId, approach, reflection, status } = normalisedRecord.payload;
  return `mission:${JSON.stringify([missionId, status, approach, reflection])}`;
}

function queuePendingProgress(state, record) {
  const [pendingRecord] = normalisePendingProgress([record]);
  if (!pendingRecord) return state;
  const pendingKey = pendingProgressKey(pendingRecord);
  const pendingRecords = state.pendingProgress ?? [];
  if (pendingKey && pendingRecords.some((candidate) => pendingProgressKey(candidate) === pendingKey)) {
    return { ...state, pendingProgress: pendingRecords };
  }
  return {
    ...state,
    pendingProgress: [
      ...pendingRecords,
      pendingRecord,
    ],
  };
}

function normaliseProgressSnapshot(value) {
  if (!isRecord(value) || !Array.isArray(value.topics) || !Array.isArray(value.quizAttempts) || !Array.isArray(value.missions)) {
    return null;
  }
  const topics = value.topics.flatMap((topic) => (
    isRecord(topic)
    && TOPIC_ID_PATTERN.test(topic.topicId)
    && ["explored", "completed"].includes(topic.status)
      ? [{ topicId: topic.topicId, status: topic.status }]
      : []
  ));
  const quizAttempts = value.quizAttempts.flatMap((attempt) => (
    isRecord(attempt)
    && typeof attempt.lessonId === "string"
    && isNonNegativeInteger(attempt.correct)
    && isNonNegativeInteger(attempt.total)
    && attempt.correct <= attempt.total
      ? [{ lessonId: attempt.lessonId, correct: attempt.correct, total: attempt.total }]
      : []
  ));
  const missions = value.missions.flatMap((mission) => {
    const missionState = normaliseMissionState(mission);
    return isRecord(mission) && MISSION_ID_PATTERN.test(mission.missionId) && missionState
      ? [{ missionId: mission.missionId, ...missionState }]
      : [];
  });
  return { topics, quizAttempts, missions };
}

function hydrateServerProgress(state, snapshot) {
  const normalisedSnapshot = normaliseProgressSnapshot(snapshot);
  if (normalisedSnapshot === null) return state;
  const pendingRecords = normalisePendingProgress(state.pendingProgress);
  const pendingQuizLessons = new Set(pendingRecords.flatMap((record) => (
    record.kind === "quizAttempt" ? [record.payload.lessonId] : []
  )));
  const pendingMissionIds = new Set(pendingRecords.flatMap((record) => (
    record.kind === "missionProgress" ? [record.payload.missionId] : []
  )));
  const serverQuizAttempts = Object.fromEntries(normalisedSnapshot.quizAttempts.map((attempt) => [
    attempt.lessonId,
    { correct: attempt.correct, total: attempt.total },
  ]));
  const serverMissionStates = Object.fromEntries(normalisedSnapshot.missions.map((mission) => [
    mission.missionId,
    {
      approach: mission.approach,
      reflection: mission.reflection,
      status: mission.status,
    },
  ]));
  const unsyncedQuizAttempts = Object.fromEntries(Object.entries(state.quizAttempts).filter(([lessonId]) => (
    pendingQuizLessons.has(lessonId)
  )));
  const unsyncedMissionStates = Object.fromEntries(Object.entries(state.missionStates).filter(([missionId]) => (
    pendingMissionIds.has(missionId)
  )));
  return {
    ...state,
    exploredLessonIds: uniqueStringIds([
      ...state.exploredLessonIds,
      ...normalisedSnapshot.topics.map((topic) => topic.topicId),
    ]),
    quizAttempts: { ...state.quizAttempts, ...serverQuizAttempts, ...unsyncedQuizAttempts },
    missionStates: { ...state.missionStates, ...serverMissionStates, ...unsyncedMissionStates },
  };
}

function ackPendingProgress(state, keys) {
  if (!Array.isArray(keys)) return state;
  const acknowledgedKeys = new Set(keys.filter((key) => typeof key === "string"));
  if (acknowledgedKeys.size === 0) return state;
  const pendingRecords = state.pendingProgress ?? [];
  const remainingRecords = pendingRecords.filter((record) => !acknowledgedKeys.has(pendingProgressKey(record)));
  if (remainingRecords.length === pendingRecords.length) return state;
  if (remainingRecords.length > 0) return { ...state, pendingProgress: remainingRecords };
  const { pendingProgress, ...stateWithoutPendingProgress } = state;
  return stateWithoutPendingProgress;
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
    case "hydrateServerProgress":
      return hydrateServerProgress(state, action.snapshot);
    case "queuePendingProgress":
      return queuePendingProgress(state, action.record);
    case "ackPendingProgress":
      return ackPendingProgress(state, action.keys);
    case "applyFocusLens": {
      const scoreKey = action.kind === "job"
        ? "jobScores"
        : action.kind === "development"
          ? "developmentScores"
          : null;
      if (scoreKey === null) return state;
      return { ...state, [scoreKey]: normaliseFocusSkills(action.skills) };
    }
    case "saveMission": {
      const missionState = normaliseMissionState(action.missionState);
      if (!MISSION_ID_PATTERN.test(action.missionId) || missionState === null) return state;
      return {
        ...state,
        missionStates: { ...state.missionStates, [action.missionId]: missionState },
      };
    }
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
