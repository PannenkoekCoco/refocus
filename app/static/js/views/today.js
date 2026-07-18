import { renderNarrator } from "../components/narrator.js";

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

function actionLabel(recommendation) {
  return recommendation.contentStatus === "full"
    ? `Open ${recommendation.title}`
    : `Explore ${recommendation.title}`;
}

function todayNarration(recommendation, momentum, activeLens) {
  return [
    "Today.",
    "Your next learning action.",
    `Suggested next: ${recommendation.title}.`,
    recommendation.reason,
    recommendation.summary,
    activeLens?.label,
    `Your momentum: ${momentum.explored} explored, ${momentum.practised} practised, and ${momentum.applied} applied out of ${momentum.total} topics.`,
    "Browse all topics or tailor your route whenever you want.",
  ].filter(Boolean).join(" ");
}

function renderMomentumItem(label, value) {
  const item = createElement("div");
  item.className = "momentum-item";
  const count = createElement("strong", String(value));
  const text = createElement("span", label);
  item.append(count, text);
  return item;
}

export function renderToday({
  container,
  recommendation,
  momentum,
  activeLens = null,
  onOpenTopic,
  onNavigate,
  tts,
  onNarrationError,
}) {
  const section = createElement("section");
  section.className = "today-view";
  section.setAttribute("aria-labelledby", "today-heading");

  const heading = createElement("h2", "Today");
  heading.id = "today-heading";
  const copy = createElement(
    "p",
    "One clear next step, with every topic ready whenever you want to explore.",
  );
  copy.className = "screen-copy";
  const narrator = createElement("div");
  narrator.className = "narrator";
  renderNarrator({
    container: narrator,
    speechText: todayNarration(recommendation, momentum, activeLens),
    tts,
    onError: onNarrationError,
  });

  const card = createElement("article");
  card.className = "recommendation-card";
  const label = createElement("p", "Next learning action");
  label.className = "eyebrow";
  const title = createElement("h3", recommendation.title);
  const reason = createElement("p", recommendation.reason);
  reason.className = "recommendation-reason";
  const summary = createElement("p", recommendation.summary);
  summary.className = "topic-summary";
  const action = createElement("button", actionLabel(recommendation));
  action.type = "button";
  action.className = "today-primary-action";
  action.addEventListener("click", () => onOpenTopic(recommendation));
  card.append(label, title, reason, summary, action);

  const activeLensSummary = activeLens?.label ? createElement("section") : null;
  if (activeLensSummary) {
    activeLensSummary.className = "today-active-lens";
    activeLensSummary.setAttribute("aria-label", "Route tailoring");
    const activeLensLabel = createElement("p", activeLens.label);
    const editTailoring = createElement("button", "Edit tailoring");
    editTailoring.type = "button";
    editTailoring.className = "secondary";
    editTailoring.addEventListener("click", () => onNavigate("tailor"));
    activeLensSummary.append(activeLensLabel, editTailoring);
  }

  const momentumSection = createElement("section");
  momentumSection.className = "today-momentum";
  momentumSection.setAttribute("aria-labelledby", "momentum-heading");
  const momentumHeading = createElement("h3", "Your momentum");
  momentumHeading.id = "momentum-heading";
  const momentumCopy = createElement("p", `Across ${momentum.total} free topics.`);
  momentumCopy.className = "screen-copy";
  const grid = createElement("div");
  grid.className = "momentum-grid";
  grid.append(
    renderMomentumItem("Explored", momentum.explored),
    renderMomentumItem("Practised", momentum.practised),
    renderMomentumItem("Applied", momentum.applied),
  );
  momentumSection.append(momentumHeading, momentumCopy, grid);

  const actions = createElement("div");
  actions.className = "today-secondary-actions";
  const browse = createElement("button", "Browse all topics");
  browse.type = "button";
  browse.className = "secondary";
  browse.addEventListener("click", () => onNavigate("route"));
  const tailor = createElement("button", "Tailor my route");
  tailor.type = "button";
  tailor.className = "secondary";
  tailor.addEventListener("click", () => onNavigate("tailor"));
  actions.append(browse, tailor);

  section.append(heading, copy, narrator, card);
  if (activeLensSummary) section.append(activeLensSummary);
  section.append(momentumSection, actions);
  container.append(section);
}
