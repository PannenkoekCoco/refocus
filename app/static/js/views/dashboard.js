function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function renderDashboard({ container, recommendation, onOpenTopic }) {
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

  const card = createElement("article");
  card.className = "recommendation-card";
  const cardLabel = createElement("p", "Suggested next");
  cardLabel.className = "eyebrow";
  const title = createElement("h3", recommendation.title);
  const reason = createElement("p", recommendation.reason);
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

  card.append(cardLabel, title, reason, summary, action);
  section.append(heading, copy, card);
  container.append(section);
}
