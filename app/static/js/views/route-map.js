function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function renderRouteMap({ container, route, onPin, onOpenTopic }) {
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
  header.append(heading, copy);

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

    card.append(cardHeader, category, summary, status, prerequisite, actions);
    item.append(card);
    list.append(item);
  }

  section.append(header, list);
  container.append(section);
}
