import { renderNarrator } from "../components/narrator.js";
import { selectRouteGroups } from "../state/selectors.js";

const ROUTE_FILTERS = [
  { id: "all", label: "All" },
  { id: "foundation", label: "Foundations" },
  { id: "production", label: "Build and ship" },
  { id: "ai-systems", label: "AI systems" },
];

const CATEGORY_LABELS = {
  foundation: "Foundation",
  production: "Build and ship",
  "ai-systems": "AI systems",
};

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderTopicCard({ node, onPin, onOpenTopic, region }) {
  const card = createElement("article");
  card.className = "topic-card";
  if (node.isPinned) card.classList.add("is-pinned");
  if (node.isRecommended) card.classList.add("is-recommended");
  card.dataset.topicId = node.id;

  const cardHeader = createElement("div");
  cardHeader.className = "topic-card-header";
  const title = createElement("h3", node.title);
  const pin = createElement("button", node.isPinned ? "Pinned" : "Pin");
  pin.type = "button";
  pin.className = "topic-pin secondary";
  pin.dataset.pinTopicId = node.id;
  pin.setAttribute("aria-label", `${node.isPinned ? "Unpin" : "Pin"} ${node.title}`);
  pin.setAttribute("aria-pressed", String(node.isPinned));
  pin.addEventListener("click", () => onPin(node, region));
  cardHeader.append(title, pin);

  const meta = createElement("div");
  meta.className = "topic-meta";
  const category = createElement("span", CATEGORY_LABELS[node.category] ?? node.category);
  category.className = "badge category-badge";
  const level = createElement("span", node.badge);
  level.className = `badge ${node.contentStatus === "full" ? "full-path" : "starter"}`;
  meta.append(category, level);

  const summary = createElement("p", node.summary);
  summary.className = "topic-summary";
  const status = createElement("p", node.status);
  status.className = "topic-status";
  const open = createElement("button", node.actionLabel);
  open.type = "button";
  open.className = "topic-open";
  if (node.contentStatus !== "full") {
    open.setAttribute("aria-label", `Explore now ${node.title}`);
  }
  open.addEventListener("click", () => onOpenTopic(node));

  card.append(cardHeader, meta, summary, status, open);
  return card;
}

function forYouNodes(route) {
  const advisoryNodes = route.filter((node) => node.isPinned || node.isRecommended);
  const advisoryIds = new Set(advisoryNodes.map((node) => node.id));
  const nextCandidates = route
    .filter((node) => !advisoryIds.has(node.id))
    .slice(0, 2);
  return [...advisoryNodes, ...nextCandidates];
}

export function renderRouteMap({
  container,
  route,
  onPin,
  onOpenTopic,
  onBack,
  tts,
  onNarrationError,
}) {
  let query = "";
  let category = "all";

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
  const back = createElement("button", "Back to Today");
  back.type = "button";
  back.className = "secondary route-back";
  back.addEventListener("click", onBack);
  header.append(heading, copy, narrator, back);

  const controls = createElement("div");
  controls.className = "route-library-controls";
  const searchField = createElement("div");
  searchField.className = "route-search";
  const searchLabel = createElement("label", "Search topics");
  searchLabel.htmlFor = "route-topic-search";
  const search = createElement("input");
  search.id = "route-topic-search";
  search.type = "search";
  search.setAttribute("aria-label", "Search topics");
  search.placeholder = "Search skills";
  searchField.append(searchLabel, search);

  const filters = createElement("div");
  filters.className = "route-filters";
  filters.setAttribute("aria-label", "Filter topics");
  filters.setAttribute("role", "group");
  const filterControls = new Map();
  for (const filter of ROUTE_FILTERS) {
    const control = createElement("button", filter.label);
    control.type = "button";
    control.className = "secondary";
    control.setAttribute("aria-pressed", String(filter.id === category));
    control.addEventListener("click", () => {
      category = filter.id;
      for (const [filterId, filterControl] of filterControls) {
        filterControl.setAttribute("aria-pressed", String(filterId === category));
      }
      renderLibrary();
    });
    filterControls.set(filter.id, control);
    filters.append(control);
  }
  controls.append(searchField, filters);

  const library = createElement("div");
  library.className = "route-library-results";
  library.setAttribute("aria-live", "polite");

  function renderTopicList(nodes, className, region) {
    const list = createElement("ul");
    list.className = className;
    for (const node of nodes) {
      const item = createElement("li");
      item.append(renderTopicCard({ node, onPin, onOpenTopic, region }));
      list.append(item);
    }
    return list;
  }

  function appendStageGroups(container, groups) {
    if (groups.length === 0) {
      const empty = createElement("p", "No topics match that search yet.");
      empty.className = "route-empty";
      container.append(empty);
      return;
    }

    for (const group of groups) {
      const stage = createElement("section");
      stage.className = "route-stage";
      stage.setAttribute("aria-labelledby", `route-stage-${group.id}`);
      const stageHeading = createElement("h4", group.title);
      stageHeading.id = `route-stage-${group.id}`;
      stage.append(stageHeading, renderTopicList(group.nodes, "route-list", "all-topics"));
      container.append(stage);
    }
  }

  function renderLibrary() {
    query = search.value;
    const groups = selectRouteGroups(route, { query, category });
    library.replaceChildren();

    if (!query.trim() && category === "all") {
      const forYou = createElement("section");
      forYou.className = "route-for-you";
      forYou.setAttribute("aria-labelledby", "route-for-you-heading");
      const forYouHeading = createElement("h3", "For you");
      forYouHeading.id = "route-for-you-heading";
      const forYouCopy = createElement(
        "p",
        "A few optional suggestions. Every topic remains open in the full route below.",
      );
      forYouCopy.className = "screen-copy";
      forYou.append(
        forYouHeading,
        forYouCopy,
        renderTopicList(forYouNodes(route), "route-for-you-list", "for-you"),
      );
      library.append(forYou);
    }

    const allTopics = createElement("section");
    allTopics.className = "all-topics";
    allTopics.setAttribute("aria-labelledby", "all-topics-heading");
    const allTopicsHeading = createElement("h3", `All topics (${route.length})`);
    allTopicsHeading.id = "all-topics-heading";
    allTopics.append(allTopicsHeading);
    appendStageGroups(allTopics, groups);
    library.append(allTopics);
  }

  search.addEventListener("input", renderLibrary);
  section.append(header, controls, library);
  renderLibrary();
  container.append(section);
}
