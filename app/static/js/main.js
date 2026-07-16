import { createStatusMessage } from "./components/status-message.js";
import { createFocusLensClient, createProgressClient } from "./api/client.js";
import { loadLesson, loadTopics } from "./content/loader.js";
import { createTtsProvider } from "./services/tts.js";
import {
  createStore,
  loadLearningState,
  persistLearningState,
} from "./state/store.js";
import { selectRecommendedTopic, selectRouteView } from "./state/selectors.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderLesson } from "./views/lesson.js";
import { renderMission } from "./views/mission.js";
import { renderQuiz } from "./views/quiz.js";
import { renderRouteMap } from "./views/route-map.js";

const app = document.querySelector("#app");
const shellHeader = document.querySelector("#shell-header");
const statusMessage = createStatusMessage(document.querySelector("#status-message"));
const tts = createTtsProvider();
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
  return Array.isArray(payload.missions) ? payload.missions : [];
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
store.subscribe((state) => {
  latestPersistenceSucceeded = persistLearningState(storage, state);
});

function queuePendingProgress(record) {
  const previousState = store.getState();
  const nextState = store.dispatch({ type: "queuePendingProgress", record });
  return nextState !== previousState && latestPersistenceSucceeded;
}

const progressClient = createProgressClient({
  fetchImpl: window.fetch.bind(window),
  queuePendingProgress,
  onPending: statusMessage.announce,
});
const focusLensClient = createFocusLensClient({
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
let currentView = { name: "loading" };

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

function getPrerequisiteText(topicId) {
  return getRoute().find((node) => node.id === topicId)?.prerequisiteText
    ?? "No prerequisite is required; you can start here anytime.";
}

function renderShellHeader(recommendation) {
  shellHeader.replaceChildren();
  const inner = createElement("div");
  inner.className = "shell-inner";
  const title = createElement("h1", "Refocus");
  title.className = "shell-title";
  const copy = createElement("p", "An offline-first engineering learning route that stays in your control.");
  copy.className = "shell-copy";
  inner.append(title, copy);
  if (recommendation) {
    const reason = createElement("p", recommendation.reason);
    reason.className = "recommendation-reason";
    inner.append(reason);
  }
  shellHeader.append(inner);
}

function render({ moveFocus = false, focusTarget } = {}) {
  app.replaceChildren();
  const recommendation = topics.length > 0 ? getRecommendation() : null;
  renderShellHeader(recommendation);

  if (currentView.name === "loading") {
    renderLoading("Loading your learning route");
  } else if (currentView.name === "error") {
    renderLoading("Your learning route could not load offline.");
  } else if (currentView.name === "route") {
    renderDashboard({
      container: app,
      recommendation,
      onOpenTopic: openTopic,
      topics,
      lenses: focusLenses,
      tts,
      onNarrationError: statusMessage.announce,
      onPreview: (payload) => focusLensClient.preview(payload),
      onApply: applyFocusLens,
      onStatus: statusMessage.announce,
    });
    renderRouteMap({
      container: app,
      route: getRoute(),
      onPin: togglePin,
      onOpenTopic: openTopic,
    });
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
    });
  } else if (currentView.name === "quiz") {
    const mission = missions.find((candidate) => candidate.topicId === currentView.topic.id);
    renderQuiz({
      container: app,
      topic: currentView.topic,
      lesson: currentView.lesson,
      tts,
      onNarrationError: statusMessage.announce,
      onComplete: saveQuiz,
      onBack: () => showLesson(currentView.topic, currentView.lesson),
      onBackToRoute: showRoute,
      onMission: mission ? () => showMission(mission) : null,
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

function togglePin(topic) {
  const isPinned = store.getState().pinnedTopicId === topic.id;
  dispatchLearningState(
    { type: isPinned ? "unpin" : "pin", topicId: topic.id },
    isPinned ? `${topic.title} is no longer pinned.` : `${topic.title} is pinned.`,
  );
  render({
    focusTarget: (container) => [...container.querySelectorAll("[data-pin-topic-id]")]
      .find((control) => control.dataset.pinTopicId === topic.id),
  });
}

function showRoute() {
  currentView = { name: "route" };
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
}

function saveMission(mission, missionState) {
  dispatchLearningState(
    { type: "saveMission", missionId: mission.id, missionState },
    "Mission marked self-reviewed and saved locally. It has not been independently verified.",
  );
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
  if (currentView.name === "route") render();
}

async function start() {
  render();
  try {
    const fetchImpl = window.fetch.bind(window);
    [topics, missions] = await Promise.all([loadTopics(fetchImpl), loadMissions(fetchImpl)]);
    currentView = { name: "route" };
    render();
    void loadSavedFocusLenses();
  } catch {
    currentView = { name: "error" };
    statusMessage.announce("Refocus could not load the local curriculum. Check that its content files are available.");
    render();
  }
}

start();
