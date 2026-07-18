import { createStatusMessage } from "./components/status-message.js";
import {
  PENDING_PROGRESS_MESSAGE,
  createFocusLensClient,
  createGitHubMissionClient,
  createProgressClient,
} from "./api/client.js";
import { loadLesson, loadTopics } from "./content/loader.js";
import { createTtsProvider } from "./services/tts.js";
import {
  createStore,
  loadLearningState,
  pendingProgressKey,
  persistLearningState,
} from "./state/store.js";
import { selectRecommendedTopic, selectRouteView, selectTodayMomentum } from "./state/selectors.js";
import { renderFocusLenses } from "./views/focus-lenses.js";
import { renderLesson } from "./views/lesson.js";
import { renderMission } from "./views/mission.js";
import { renderQuiz } from "./views/quiz.js";
import { renderRouteMap } from "./views/route-map.js";
import { renderToday } from "./views/today.js";

const app = document.querySelector("#app");
const shellHeader = document.querySelector("#shell-header");
const tts = createTtsProvider();
const statusMessage = createStatusMessage({
  container: document.querySelector("#status-message"),
  tts,
  onNarrationError: () => {},
});
const SESSION_ONLY_PROGRESS_MESSAGE = "Progress is available for this session only because it could not be saved locally.";

function getBrowserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

async function loadMissions(fetchImpl) {
  const response = await fetchImpl(new URL("../../../content/missions/foundation-missions.json", import.meta.url));
  if (!response.ok) throw new Error("Could not load missions.");
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || payload.version !== 1 || !Array.isArray(payload.missions)) {
    throw new Error("Could not load a versioned mission contract.");
  }
  return payload.missions;
}

function masteryFromAttempts(quizAttempts) {
  return Object.fromEntries(
    Object.entries(quizAttempts).map(([topicId, attempt]) => [
      topicId,
      attempt.total > 0 ? attempt.correct / attempt.total : 0,
    ]),
  );
}

function renderLoading(message) {
  const section = createElement("section");
  section.setAttribute("aria-labelledby", "loading-heading");
  const heading = createElement("h2", message);
  heading.id = "loading-heading";
  heading.className = "screen-title";
  section.append(heading);
  app.append(section);
}

const storage = getBrowserStorage();
const store = createStore(loadLearningState(storage));
let latestPersistenceSucceeded = true;
let pendingProgressGeneration = 0;
let pendingQueueObserver = null;
store.subscribe((state) => {
  latestPersistenceSucceeded = persistLearningState(storage, state);
});

function queuePendingProgress(record) {
  const progressKey = pendingProgressKey(record);
  if (!progressKey) return false;
  const previousState = store.getState();
  const wasQueued = (previousState.pendingProgress ?? []).some((candidate) => (
    pendingProgressKey(candidate) === progressKey
  ));
  const nextState = store.dispatch({ type: "queuePendingProgress", record });
  const isQueued = (nextState.pendingProgress ?? []).some((candidate) => (
    pendingProgressKey(candidate) === progressKey
  ));
  const queued = isQueued && latestPersistenceSucceeded;
  if (pendingQueueObserver?.key === progressKey) pendingQueueObserver.queued = queued;
  if (!queued) return false;
  if (!wasQueued) pendingProgressGeneration += 1;
  return true;
}

const progressClient = createProgressClient({
  fetchImpl: window.fetch.bind(window),
  queuePendingProgress,
  onPending: statusMessage.announce,
  onQueued: () => { void syncProgress(); },
});
const focusLensClient = createFocusLensClient({
  fetchImpl: window.fetch.bind(window),
});
const githubMissionClient = createGitHubMissionClient({
  fetchImpl: window.fetch.bind(window),
});

function dispatchLearningState(action, savedMessage) {
  store.dispatch(action);
  statusMessage.announce(latestPersistenceSucceeded ? savedMessage : SESSION_ONLY_PROGRESS_MESSAGE);
  return latestPersistenceSucceeded;
}

let topics = [];
let missions = [];
let focusLenses = [];
let githubConnection = null;
let currentView = { name: "loading" };
let progressSyncPromise = null;
let progressSyncReady = false;
let progressSyncRequested = false;
let progressSyncNeedsSnapshot = false;
let progressSyncSnapshotScheduled = false;
let focusLensDraft = null;

function renderAfterProgressSync() {
  if (["today", "route", "tailor"].includes(currentView.name)) render();
}

async function syncProgressPass({ hydrate }) {
  let didChangeState = false;
  if (hydrate) {
    const snapshot = await progressClient.loadSnapshot();
    if (snapshot !== null) {
      const previousState = store.getState();
      const nextState = store.dispatch({ type: "hydrateServerProgress", snapshot });
      didChangeState = nextState !== previousState;
    }
  }

  const pendingRecords = [...(store.getState().pendingProgress ?? [])];
  const capturedGeneration = pendingProgressGeneration;
  if (pendingRecords.length === 0) {
    return { capturedGeneration, didChangeState };
  }

  let acknowledgedKeys = [];
  try {
    acknowledgedKeys = await progressClient.replayPendingProgress(pendingRecords);
  } catch {
    acknowledgedKeys = [];
  }
  if (acknowledgedKeys.length > 0) {
    const previousState = store.getState();
    const nextState = store.dispatch({ type: "ackPendingProgress", keys: acknowledgedKeys });
    didChangeState = didChangeState || nextState !== previousState;
  }
  if ((store.getState().pendingProgress ?? []).length > 0) {
    statusMessage.announce(PENDING_PROGRESS_MESSAGE);
  }
  return { capturedGeneration, didChangeState };
}

function syncProgress({ hydrate = false } = {}) {
  const shouldScheduleSnapshot = hydrate && !progressSyncSnapshotScheduled;
  if (shouldScheduleSnapshot) {
    progressSyncNeedsSnapshot = true;
    progressSyncSnapshotScheduled = true;
  }
  if (!hydrate || shouldScheduleSnapshot || progressSyncPromise === null) {
    progressSyncRequested = true;
  }
  if (progressSyncPromise !== null) return progressSyncPromise;
  const sync = (async () => {
    let didChangeState = false;
    while (progressSyncRequested) {
      progressSyncRequested = false;
      const shouldHydrate = progressSyncNeedsSnapshot;
      progressSyncNeedsSnapshot = false;
      let pass;
      try {
        pass = await syncProgressPass({ hydrate: shouldHydrate });
      } finally {
        if (shouldHydrate) progressSyncSnapshotScheduled = false;
      }
      didChangeState = didChangeState || pass.didChangeState;
      if (pendingProgressGeneration > pass.capturedGeneration) {
        progressSyncRequested = true;
      }
    }
    if (didChangeState) renderAfterProgressSync();
  })();
  progressSyncPromise = sync.finally(() => {
    progressSyncPromise = null;
    if (progressSyncRequested) void syncProgress();
  });
  return progressSyncPromise;
}

window.addEventListener("online", () => {
  if (!progressSyncReady) return;
  void syncProgress({ hydrate: true });
});

function getRecommendation() {
  const state = store.getState();
  return selectRecommendedTopic({
    pinnedTopicId: state.pinnedTopicId,
    topics,
    developmentScores: state.developmentScores,
    jobScores: state.jobScores,
    mastery: masteryFromAttempts(state.quizAttempts),
  });
}

function getRoute() {
  const state = store.getState();
  const recommendation = getRecommendation();
  return selectRouteView(topics, state, {
    pinnedTopicId: state.pinnedTopicId,
    recommendedTopicId: recommendation?.id,
  });
}

function getActiveFocusLensSummary() {
  const activeLens = focusLenses.find((lens) => (
    lens?.isActive === true && ["job", "development"].includes(lens.kind)
  ));
  if (!activeLens) return null;
  return {
    kind: activeLens.kind,
    label: activeLens.kind === "job"
      ? "Route tailored for a role"
      : "Route tailored for your development goal",
  };
}

function getPrerequisiteText(topicId) {
  return getRoute().find((node) => node.id === topicId)?.prerequisiteText
    ?? "No prerequisite is required; you can start here anytime.";
}

function renderShellHeader(momentum) {
  shellHeader.replaceChildren();
  const inner = createElement("div");
  inner.className = "shell-inner";
  const brand = createElement("div");
  brand.className = "shell-brand";
  const title = createElement("h1", "Refocus");
  title.className = "shell-title";
  const copy = createElement("p", "An offline-first engineering learning route that stays in your control.");
  copy.className = "shell-copy";
  brand.append(title, copy);

  const navigation = createElement("nav");
  navigation.className = "app-navigation";
  navigation.setAttribute("aria-label", "Learning views");
  for (const { name, label, onClick } of [
    { name: "today", label: "Today", onClick: showToday },
    { name: "route", label: "Route", onClick: showRoute },
    { name: "tailor", label: "Tailor", onClick: showTailor },
  ]) {
    const control = createElement("button", label);
    control.type = "button";
    control.className = "secondary";
    if (currentView.name === name) control.setAttribute("aria-current", "page");
    control.addEventListener("click", onClick);
    navigation.append(control);
  }

  inner.append(brand, navigation);
  if (momentum.total > 0) {
    const progress = createElement(
      "p",
      `${momentum.explored} explored · ${momentum.practised} practised · ${momentum.applied} applied`,
    );
    progress.className = "shell-progress";
    inner.append(progress);
  }
  shellHeader.append(inner);
}

function render({ moveFocus = false, focusTarget } = {}) {
  app.replaceChildren();
  const recommendation = topics.length > 0 ? getRecommendation() : null;
  const momentum = selectTodayMomentum({
    topics,
    progress: store.getState(),
    missions,
  });
  renderShellHeader(momentum);

  if (currentView.name === "loading") {
    renderLoading("Loading your learning route");
  } else if (currentView.name === "error") {
    renderLoading("Your learning route could not load offline.");
  } else if (currentView.name === "today") {
    renderToday({
      container: app,
      recommendation,
      momentum,
      activeLens: getActiveFocusLensSummary(),
      onOpenTopic: openTopic,
      onNavigate: (viewName) => {
        if (viewName === "route") showRoute();
        if (viewName === "tailor") showTailor();
      },
      tts,
      onNarrationError: statusMessage.announce,
    });
  } else if (currentView.name === "route") {
    const routeLibrary = createElement("div");
    routeLibrary.className = "route-library";
    app.append(routeLibrary);
    renderRouteMap({
      container: routeLibrary,
      route: getRoute(),
      onPin: togglePin,
      onOpenTopic: openTopic,
      onBack: showToday,
      tts,
      onNarrationError: statusMessage.announce,
    });
  } else if (currentView.name === "tailor") {
    const tailorView = createElement("section");
    tailorView.className = "tailor-view";
    tailorView.setAttribute("aria-labelledby", "tailor-heading");
    const heading = createElement("h2", "Tailor your route");
    heading.id = "tailor-heading";
    const copy = createElement(
      "p",
      "Choose a role or goal when you want a more personalised suggestion. Every topic stays open.",
    );
    copy.className = "screen-copy";
    tailorView.append(heading, copy);
    renderFocusLenses({
      container: tailorView,
      topics,
      lenses: focusLenses,
      draft: focusLensDraft,
      tts,
      onNarrationError: statusMessage.announce,
      onPreview: (payload) => focusLensClient.preview(payload),
      onApply: applyFocusLens,
      onDraftChange: (nextDraft) => {
        focusLensDraft = nextDraft;
      },
      onStatus: statusMessage.announce,
      onUseFoundation: () => statusMessage.announce("Following the foundation."),
      onBack: showToday,
    });
    app.append(tailorView);
  } else if (currentView.name === "lesson") {
    renderLesson({
      container: app,
      topic: currentView.topic,
      lesson: currentView.lesson,
      prerequisiteText: getPrerequisiteText(currentView.topic.id),
      tts,
      onNarrationError: statusMessage.announce,
      onBack: showRoute,
      onStartQuiz: () => showQuiz(currentView.topic, currentView.lesson),
      onCompleteStarter: completeStarter,
    });
  } else if (currentView.name === "quiz") {
    const topicMissions = missions.filter((candidate) => candidate.topicId === currentView.topic.id);
    renderQuiz({
      container: app,
      topic: currentView.topic,
      lesson: currentView.lesson,
      tts,
      onNarrationError: statusMessage.announce,
      onComplete: saveQuiz,
      onBack: () => showLesson(currentView.topic, currentView.lesson),
      onBackToRoute: showRoute,
      missions: topicMissions,
      onMission: showMission,
    });
  } else if (currentView.name === "mission") {
    renderMission({
      container: app,
      mission: currentView.mission,
      state: store.getState().missionStates[currentView.mission.id],
      tts,
      onNarrationError: statusMessage.announce,
      onSave: (missionState) => saveMission(currentView.mission, missionState),
      onBack: showRoute,
      githubConnection,
      onConnectGitHub: startGitHubConnection,
      onSelectGitHubRepository: selectGitHubRepository,
      onVerifyWithGitHub: verifyMissionWithGitHub,
      onDisconnectGitHub: disconnectGitHub,
      onStatus: statusMessage.announce,
    });
  }

  const requestedFocus = focusTarget?.(app);
  if (requestedFocus) {
    requestedFocus.focus();
  } else if (moveFocus || focusTarget) {
    const screenHeading = app.querySelector("h2");
    if (screenHeading) {
      screenHeading.tabIndex = -1;
      screenHeading.focus();
    } else {
      app.focus();
    }
  }
}

function togglePin(topic, focusRegion = "all-topics") {
  const isPinned = store.getState().pinnedTopicId === topic.id;
  dispatchLearningState(
    { type: isPinned ? "unpin" : "pin", topicId: topic.id },
    isPinned ? `${topic.title} is no longer pinned.` : `${topic.title} is pinned.`,
  );
  render({
    focusTarget: (container) => {
      const topicPin = (region) => container.querySelector(
        `.${region} [data-pin-topic-id="${topic.id}"]`,
      );
      return focusRegion === "for-you"
        ? topicPin("route-for-you") ?? topicPin("all-topics")
        : topicPin("all-topics");
    },
  });
}

function showToday() {
  currentView = { name: "today" };
  render({ moveFocus: true });
}

function showRoute() {
  currentView = { name: "route" };
  render({ moveFocus: true });
}

function showTailor() {
  currentView = { name: "tailor" };
  if (focusLensDraft?.editorOpen) {
    focusLensDraft = { ...focusLensDraft, editorOpen: false };
  }
  render({ moveFocus: true });
}

function showLesson(topic, lesson) {
  currentView = { name: "lesson", topic, lesson };
  render({ moveFocus: true });
}

async function openTopic(node) {
  const topic = topics.find((candidate) => candidate.id === node.id);
  if (!topic) return;

  dispatchLearningState({ type: "exploreLesson", topicId: topic.id }, `${topic.title} is marked as explored.`);
  void progressClient.saveTopicProgress(topic.id, "explored");
  if (topic.contentStatus !== "full") {
    showLesson(topic, null);
    return;
  }

  currentView = { name: "loading" };
  render({ moveFocus: true });
  try {
    const lesson = await loadLesson(topic.id, window.fetch.bind(window));
    showLesson(topic, lesson);
  } catch {
    statusMessage.announce("That lesson is unavailable offline right now. Choose another topic or try again later.");
    showRoute();
  }
}

function showQuiz(topic, lesson) {
  currentView = { name: "quiz", topic, lesson };
  render({ moveFocus: true });
}

async function saveStarterCompletion(topic) {
  const key = pendingProgressKey({
    kind: "topicProgress",
    payload: { topicId: topic.id, status: "completed" },
  });
  if (!key) return false;

  const outcome = { key, queued: false };
  pendingQueueObserver = outcome;
  try {
    await progressClient.saveTopicProgress(topic.id, "completed");
    return outcome.queued;
  } finally {
    if (pendingQueueObserver === outcome) pendingQueueObserver = null;
  }
}

async function completeStarter(topic) {
  try {
    const saved = await saveStarterCompletion(topic);
    if (!saved) return false;
  } catch {
    statusMessage.announce("That step could not be marked complete right now. Try again.");
    return false;
  }
  statusMessage.announce(topic.title + " is marked complete and will sync when you're online.");
  showToday();
  return true;
}

async function saveQuiz(result) {
  const quizAttempt = {
    correct: result.correct,
    total: result.total,
  };
  const savedLocally = dispatchLearningState(
    { type: "recordQuiz", topicId: currentView.topic.id, attempt: quizAttempt },
    "Quiz result saved locally.",
  );
  const { recommendation } = await progressClient.saveQuizAttemptAndRefresh(
    {
      lessonId: currentView.lesson?.topicId ?? currentView.topic.id,
      answers: result.answers,
    },
    () => getRecommendation(),
  );
  return { savedLocally, recommendation };
}

function showMission(mission) {
  currentView = { name: "mission", mission };
  render({ moveFocus: true });
  if (githubConnection === null) void loadGitHubConnection();
}

function saveMission(mission, missionState) {
  dispatchLearningState(
    { type: "saveMission", missionId: mission.id, missionState },
    "Mission marked self-reviewed and saved locally. It has not been independently verified.",
  );
  void progressClient.saveMissionProgress(mission.id, missionState);
}

async function loadGitHubConnection({ rerender = true } = {}) {
  const connection = await githubMissionClient.listInstallations();
  if (connection === null) return null;
  githubConnection = connection;
  if (rerender && currentView.name === "mission") render();
  return connection;
}

async function startGitHubConnection() {
  return githubMissionClient.startConnection();
}

async function selectGitHubRepository(repositoryId) {
  const repository = await githubMissionClient.selectRepository(repositoryId);
  if (repository === null) return null;
  await loadGitHubConnection({ rerender: false });
  if (currentView.name === "mission") render();
  return repository;
}

async function verifyMissionWithGitHub(missionId, options) {
  return githubMissionClient.verifyMission(missionId, options);
}

async function disconnectGitHub() {
  const disconnected = await githubMissionClient.disconnect();
  if (!disconnected) return false;
  githubConnection = { connected: false, installations: [] };
  if (currentView.name === "mission") render();
  statusMessage.announce("GitHub has been disconnected. Your self-review remains available.");
  return true;
}

function isFocusLens(value) {
  return value
    && typeof value === "object"
    && ["job", "development"].includes(value.kind)
    && typeof value.originalText === "string"
    && Array.isArray(value.skills)
    && typeof value.isActive === "boolean";
}

function replaceInMemoryFocusLens(nextLens) {
  const localId = `local-${nextLens.kind}`;
  const nextId = typeof nextLens.id === "string" ? nextLens.id : localId;
  let replaced = false;
  focusLenses = focusLenses.flatMap((lens) => {
    if (lens.id === nextId || lens.id === localId) {
      replaced = true;
      return [{ ...nextLens, id: nextId }];
    }
    if (nextLens.isActive && lens.kind === nextLens.kind && lens.isActive) {
      return [{ ...lens, isActive: false }];
    }
    return [lens];
  });
  if (!replaced) focusLenses.push({ ...nextLens, id: nextId });
}

async function applyFocusLens(lens) {
  if (focusLensDraft?.byKind && typeof focusLensDraft.byKind === "object") {
    const remainingDrafts = Object.fromEntries(
      Object.entries(focusLensDraft.byKind).filter(([kind]) => kind !== lens.kind),
    );
    focusLensDraft = { ...focusLensDraft, byKind: remainingDrafts };
  }
  replaceInMemoryFocusLens(lens);
  store.dispatch({ type: "applyFocusLens", kind: lens.kind, skills: lens.skills });
  const persistedLocally = latestPersistenceSucceeded;
  render();

  const savedLens = await focusLensClient.save(lens);
  if (isFocusLens(savedLens) && typeof savedLens.id === "string") {
    replaceInMemoryFocusLens(savedLens);
    statusMessage.announce(
      persistedLocally
        ? "Applied to your route and saved to your account."
        : "Applied to your route and saved to your account. Local route progress is available for this session only.",
    );
    render();
    return;
  }

  statusMessage.announce(
    persistedLocally
      ? "Applied to your route. Sign in to save this focus lens."
      : "Applied to your route for this session only. Sign in to save this focus lens.",
  );
}

async function loadSavedFocusLenses() {
  const savedLenses = await focusLensClient.list();
  if (!Array.isArray(savedLenses)) return;
  focusLenses = savedLenses.filter(isFocusLens);
  for (const kind of ["job", "development"]) {
    const activeLens = focusLenses.find((lens) => lens.kind === kind && lens.isActive);
    if (activeLens) {
      store.dispatch({ type: "applyFocusLens", kind, skills: activeLens.skills });
    }
  }
  if (["today", "route", "tailor"].includes(currentView.name)) render();
}

async function start() {
  render();
  try {
    const fetchImpl = window.fetch.bind(window);
    [topics, missions] = await Promise.all([loadTopics(fetchImpl), loadMissions(fetchImpl)]);
    currentView = { name: "today" };
    render();
    progressSyncReady = true;
    void syncProgress({ hydrate: true });
    void loadSavedFocusLenses();
    void loadGitHubConnection({ rerender: false });
  } catch {
    currentView = { name: "error" };
    statusMessage.announce("Refocus could not load the local curriculum. Check that its content files are available.");
    render();
  }
}

start();
