import { createStatusMessage } from "./components/status-message.js";
import { createProgressClient } from "./api/client.js";
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
const progressClient = createProgressClient({
  storage,
  fetchImpl: window.fetch.bind(window),
  onPending: statusMessage.announce,
});
let latestPersistenceSucceeded = true;
store.subscribe((state) => {
  latestPersistenceSucceeded = persistLearningState(storage, state);
});

function dispatchLearningState(action, savedMessage) {
  store.dispatch(action);
  statusMessage.announce(latestPersistenceSucceeded ? savedMessage : SESSION_ONLY_PROGRESS_MESSAGE);
  return latestPersistenceSucceeded;
}

let topics = [];
let missions = [];
let currentView = { name: "loading" };

function getRecommendation() {
  const state = store.getState();
  return selectRecommendedTopic({
    pinnedTopicId: state.pinnedTopicId,
    topics,
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
  const persisted = dispatchLearningState(
    { type: "recordQuiz", topicId: currentView.topic.id, attempt: quizAttempt },
    "Quiz result saved locally.",
  );
  await progressClient.saveQuizAttempt({
    lessonId: currentView.lesson?.topicId ?? currentView.topic.id,
    answers: result.answers,
  });
  return persisted;
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

async function start() {
  render();
  try {
    const fetchImpl = window.fetch.bind(window);
    [topics, missions] = await Promise.all([loadTopics(fetchImpl), loadMissions(fetchImpl)]);
    currentView = { name: "route" };
    render();
  } catch {
    currentView = { name: "error" };
    statusMessage.announce("Refocus could not load the local curriculum. Check that its content files are available.");
    render();
  }
}

start();
