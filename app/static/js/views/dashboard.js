import { renderNarrator } from "../components/narrator.js";
import { renderFocusLenses } from "./focus-lenses.js";

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

function recommendationPrerequisiteText(recommendation, topics) {
  const prerequisiteIds = recommendation.advisoryPrerequisites ?? [];
  if (prerequisiteIds.length === 0) {
    return "No prerequisite is required; you can start here anytime.";
  }
  const titlesById = new Map(topics.map((topic) => [topic.id, topic.title]));
  return `Advisory prerequisite: ${prerequisiteIds.map((id) => titlesById.get(id) ?? id).join(", ")}. You can start here anytime.`;
}

function dashboardNarration(recommendation, topics) {
  return [
    "Your flexible route.",
    "Start anywhere. Recommendations are guidance, never a lock or a prerequisite gate.",
    "Suggested next.",
    `${recommendation.title}.`,
    recommendation.reason,
    recommendationPrerequisiteText(recommendation, topics),
    recommendation.summary,
  ].join(" ");
}

export function renderDashboard({
  container,
  recommendation,
  onOpenTopic,
  topics = [],
  lenses = [],
  tts,
  onNarrationError,
  onPreview,
  onApply,
  onStatus,
}) {
  const section = createElement("section");
  section.className = "dashboard";
  section.setAttribute("aria-labelledby", "dashboard-heading");

  const heading = createElement("h2", "Your flexible route");
  heading.id = "dashboard-heading";
  const copy = createElement(
    "p",
    "Start anywhere. Recommendations are guidance, never a lock or a prerequisite gate.",
  );
  copy.className = "screen-copy";
  const narrator = createElement("div");
  narrator.className = "narrator";
  renderNarrator({
    container: narrator,
    speechText: dashboardNarration(recommendation, topics),
    tts,
    onError: onNarrationError,
  });

  const card = createElement("article");
  card.className = "recommendation-card";
  const cardLabel = createElement("p", "Suggested next");
  cardLabel.className = "eyebrow";
  const title = createElement("h3", recommendation.title);
  const reason = createElement("p", recommendation.reason);
  const prerequisite = createElement("p", recommendationPrerequisiteText(recommendation, topics));
  prerequisite.className = "advisory";
  const summary = createElement("p", recommendation.summary);
  summary.className = "topic-summary";
  const action = createElement(
    "button",
    recommendation.contentStatus === "full"
      ? `Open ${recommendation.title}`
      : `Explore ${recommendation.title}`,
  );
  action.type = "button";
  action.addEventListener("click", () => onOpenTopic(recommendation));

  card.append(cardLabel, title, reason, prerequisite, summary, action);
  section.append(heading, copy, narrator, card);
  renderFocusLenses({
    container: section,
    topics,
    lenses,
    tts,
    onNarrationError,
    onPreview,
    onApply,
    onStatus,
  });
  container.append(section);
}
