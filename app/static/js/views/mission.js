import { renderNarrator } from "../components/narrator.js";
import { renderGitHubVerification } from "./github-verification.js";

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

function evidenceItems(evidence) {
  const items = evidence.requiredFiles.map((file) => `Review whether you created ${file}.`);
  if (evidence.requirePullRequest) items.push("Review whether you wrote a pull-request-ready summary.");
  if (evidence.requirePassingChecks) items.push("Review whether you ran the checks you chose for this project.");
  if (evidence.requireDeploymentUrl) items.push("Review whether you recorded a deployment URL.");
  return items;
}

export function renderMission({
  container,
  mission,
  state,
  tts,
  onNarrationError,
  onSave,
  onBack,
  githubConnection,
  onConnectGitHub,
  onSelectGitHubRepository,
  onVerifyWithGitHub,
  onDisconnectGitHub,
  onStatus,
}) {
  let approach = state?.approach === "byop" ? "byop" : "guided";
  const screen = createElement("section");
  screen.className = "mission-screen";
  screen.setAttribute("aria-labelledby", "mission-heading");
  const backRow = createElement("div");
  backRow.className = "back-link-row";
  const back = createElement("button", "Back to learning route");
  back.type = "button";
  back.className = "secondary";
  back.addEventListener("click", onBack);
  backRow.append(back);

  const card = createElement("article");
  card.className = "mission-card";
  const label = createElement("p", "Practical mission");
  label.className = "eyebrow";
  const heading = createElement("h2", mission.title);
  heading.id = "mission-heading";
  const intro = createElement(
    "p",
    "Choose a path, reflect on your work, and record your own review. You can optionally verify authored mission evidence with a read-only GitHub connection.",
  );
  const narrator = createElement("div");
  narrator.className = "narrator";
  renderNarrator({
    container: narrator,
    speechText: [
      mission.speechText,
      "Choose a path, reflect on your work, and record your own review.",
      "Self-review checklist.",
      ...evidenceItems(mission.evidence),
    ].join(" "),
    tts,
    onError: onNarrationError,
  });

  const optionsHeading = createElement("h3", "Choose a project approach");
  const options = createElement("div");
  options.className = "mission-options";
  const guided = createElement("button", "Guided project");
  guided.type = "button";
  guided.className = "choice-button";
  const byop = createElement("button", "Bring your own project");
  byop.type = "button";
  byop.className = "choice-button";
  function renderApproach() {
    guided.setAttribute("aria-pressed", String(approach === "guided"));
    byop.setAttribute("aria-pressed", String(approach === "byop"));
  }
  guided.addEventListener("click", () => {
    approach = "guided";
    renderApproach();
  });
  byop.addEventListener("click", () => {
    approach = "byop";
    renderApproach();
  });
  renderApproach();
  options.append(guided, byop);

  const reflectionLabel = createElement("label", "Short reflection");
  reflectionLabel.className = "reflection-field";
  reflectionLabel.htmlFor = "mission-reflection";
  const reflection = createElement("textarea");
  reflection.id = "mission-reflection";
  reflection.name = "mission-reflection";
  reflection.maxLength = 500;
  reflection.value = state?.reflection ?? "";
  reflection.setAttribute("aria-describedby", "reflection-help");
  reflectionLabel.append(reflection);
  const reflectionHelp = createElement("p", "Up to 500 characters. This stays in this browser until sign-in is available.");
  reflectionHelp.id = "reflection-help";
  reflectionHelp.className = "mission-note";

  const checklistHeading = createElement("h3", "Self-review checklist");
  const checklist = createElement("ul");
  checklist.className = "mission-checklist";
  for (const itemText of evidenceItems(mission.evidence)) {
    checklist.append(createElement("li", itemText));
  }

  const save = createElement("button", "Mark self-reviewed");
  save.type = "button";
  save.addEventListener("click", () => {
    onSave({
      approach,
      reflection: reflection.value,
      status: "self_reviewed",
    });
  });
  const fallback = createElement("p", "Completion is self-reviewed, not independently verified.");
  fallback.className = "mission-note";
  const githubVerification = createElement("div");
  renderGitHubVerification({
    container: githubVerification,
    mission,
    connection: githubConnection,
    tts,
    onNarrationError,
    onConnect: onConnectGitHub,
    onSelectRepository: onSelectGitHubRepository,
    onVerify: onVerifyWithGitHub,
    onDisconnect: onDisconnectGitHub,
    onStatus,
  });

  card.append(
    label,
    heading,
    intro,
    narrator,
    optionsHeading,
    options,
    reflectionLabel,
    reflectionHelp,
    checklistHeading,
    checklist,
    save,
    fallback,
    githubVerification,
  );
  screen.append(backRow, card);
  container.append(screen);
}
