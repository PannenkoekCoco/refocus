import { renderNarrator } from "../components/narrator.js";

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

function sentence(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function routeCardNarration(node) {
  return [
    sentence(node.title),
    sentence(node.badge),
    sentence(node.category),
    sentence(node.summary),
    sentence(node.status),
    sentence(node.prerequisiteText),
    node.isPinned ? "Pinned." : "",
  ].filter(Boolean).join(" ");
}

export function renderRouteMap({ container, route, onPin, onOpenTopic, tts, onNarrationError }) {
  const section = createElement("section");
  section.className = "route-map";
  section.setAttribute("aria-labelledby", "route-map-heading");

  const header = createElement("div");
  header.className = "route-map-header";
  const heading = createElement("h2", "All engineering topics");
  heading.id = "route-map-heading";
  const copy = createElement(
    "p",
    "Every topic is available now. Prerequisites are advisory context, not requirements.",
  );
  copy.className = "screen-copy";
  const narrator = createElement("div");
  narrator.className = "narrator";
  renderNarrator({
    container: narrator,
    speechText: "All engineering topics. Every topic is available now. Prerequisites are advisory context, not requirements.",
    tts,
    onError: onNarrationError,
  });
  header.append(heading, copy, narrator);

  const list = createElement("ul");
  list.className = "route-list";

  for (const node of route) {
    const item = createElement("li");
    const card = createElement("article");
    card.className = "topic-card";
    if (node.isPinned) card.classList.add("is-pinned");
    if (node.isRecommended) card.classList.add("is-recommended");
    card.dataset.topicId = node.id;

    const cardHeader = createElement("div");
    cardHeader.className = "topic-card-header";
    const title = createElement("h3", node.title);
    const badges = createElement("div");
    badges.className = "badge-row";
    const availability = createElement("span", node.badge);
    availability.className = `badge ${node.contentStatus === "full" ? "full-path" : "starter"}`;
    badges.append(availability);
    if (node.isPinned) {
      const pinned = createElement("span", "Pinned");
      pinned.className = "badge pinned";
      badges.append(pinned);
    }
    cardHeader.append(title, badges);

    const category = createElement("p", node.category);
    category.className = "eyebrow";
    const summary = createElement("p", node.summary);
    summary.className = "topic-summary";
    const status = createElement("p", node.status);
    status.className = "topic-status";
    const prerequisite = createElement("p", node.prerequisiteText);
    prerequisite.className = "advisory";
    const narrator = createElement("div");
    narrator.className = "narrator";
    renderNarrator({
      container: narrator,
      speechText: routeCardNarration(node),
      tts,
      onError: onNarrationError,
    });

    const actions = createElement("div");
    actions.className = "topic-card-actions";
    const pin = createElement("button", `${node.isPinned ? "Unpin" : "Pin"} ${node.title}`);
    pin.type = "button";
    pin.className = "secondary";
    pin.dataset.pinTopicId = node.id;
    pin.setAttribute("aria-pressed", String(node.isPinned));
    pin.addEventListener("click", () => onPin(node));
    const open = createElement("button", node.actionLabel);
    open.type = "button";
    if (node.contentStatus !== "full") {
      open.setAttribute("aria-label", `Explore now ${node.title}`);
    }
    open.addEventListener("click", () => onOpenTopic(node));
    actions.append(pin, open);

    card.append(cardHeader, category, summary, status, prerequisite, narrator, actions);
    item.append(card);
    list.append(item);
  }

  section.append(header, list);
  container.append(section);
}
