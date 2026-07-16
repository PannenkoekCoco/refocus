import { renderNarrator } from "../components/narrator.js";

const KIND_COPY = {
  job: {
    button: "Job description",
    field: "Job description",
    intro: "Paste a role description to make its relevant skills visible and editable.",
  },
  development: {
    button: "Development goal",
    field: "Development goal",
    intro: "Describe what you want to build or strengthen next.",
  },
};

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

function normaliseSkills(skills, topics) {
  const weightsByTopic = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (
      skill
      && typeof skill.topicId === "string"
      && typeof skill.weight === "number"
      && Number.isFinite(skill.weight)
      && skill.weight >= 0
      && skill.weight <= 1
    ) {
      weightsByTopic.set(skill.topicId, skill.weight);
    }
  }
  return topics.flatMap((topic) => (
    weightsByTopic.has(topic.id)
      ? [{ topicId: topic.id, weight: weightsByTopic.get(topic.id) }]
      : []
  ));
}

function activeLensForKind(lenses, kind) {
  return lenses.find((lens) => lens?.kind === kind && lens.isActive)
    ?? lenses.find((lens) => lens?.kind === kind)
    ?? null;
}

function readableWeight(weight) {
  return Number(weight).toFixed(2);
}

export function renderFocusLenses({
  container,
  topics,
  lenses = [],
  tts,
  onNarrationError = () => {},
  onPreview = async () => null,
  onApply = async () => {},
  onStatus = () => {},
}) {
  let selectedKind = "job";
  let selectedLens = activeLensForKind(lenses, selectedKind);
  let currentSkills = normaliseSkills(selectedLens?.skills, topics);

  const section = createElement("section");
  section.className = "focus-lenses";
  section.setAttribute("aria-labelledby", "focus-lenses-heading");
  const heading = createElement("h3", "Focus your route");
  heading.id = "focus-lenses-heading";
  const copy = createElement(
    "p",
    "Use a job description or a development goal. Refocus shows the matched skills, lets you adjust them, and never locks any topic.",
  );
  copy.className = "screen-copy";
  const narrator = createElement("div");
  narrator.className = "narrator";
  if (tts) {
    renderNarrator({
      container: narrator,
      speechText: "Focus your route. Use a job description or development goal to preview editable skill weights. Recommendations remain optional and every topic stays available.",
      tts,
      onError: onNarrationError,
    });
  }

  const kindControls = createElement("div");
  kindControls.className = "focus-lens-kind-controls";
  const field = createElement("div");
  field.className = "focus-lens-field";
  const label = createElement("label");
  label.htmlFor = "focus-lens-text";
  const textarea = createElement("textarea");
  textarea.id = "focus-lens-text";
  textarea.maxLength = 10_000;
  textarea.rows = 6;
  textarea.setAttribute("aria-describedby", "focus-lens-privacy");
  const privacy = createElement(
    "p",
    "Your source text is used only for the editable lens. Refocus never stores it in this browser's learning cache.",
  );
  privacy.id = "focus-lens-privacy";
  privacy.className = "focus-lens-privacy";
  const preview = createElement("button", "Preview skills");
  preview.type = "button";
  const skillsPanel = createElement("div");
  skillsPanel.className = "focus-lens-skills";
  field.append(label, textarea, privacy, preview, skillsPanel);

  function renderSkillControls() {
    skillsPanel.replaceChildren();
    if (currentSkills.length === 0) {
      const empty = createElement(
        "p",
        "Preview a description to choose which skills should shape your route.",
      );
      empty.className = "focus-lens-empty";
      skillsPanel.append(empty);
      return;
    }

    const card = createElement("div");
    card.className = "focus-lens-skill-card";
    const title = createElement("h4", "Editable skill weights");
    const explanation = createElement(
      "p",
      "Higher weights make a topic more likely to be suggested. You can still open every topic at any time.",
    );
    explanation.className = "focus-lens-empty";
    const list = createElement("div");
    list.className = "focus-lens-skill-list";

    currentSkills.forEach((skill, index) => {
      const topic = topics.find((candidate) => candidate.id === skill.topicId);
      if (!topic) return;
      const row = createElement("div");
      row.className = "focus-lens-skill-row";
      const rowLabel = createElement("label", `${topic.title} weight`);
      const input = createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.1";
      input.value = String(skill.weight);
      input.id = `focus-weight-${topic.id}`;
      rowLabel.htmlFor = input.id;
      const output = createElement("output", readableWeight(skill.weight));
      output.htmlFor = input.id;
      input.addEventListener("input", () => {
        const nextWeight = Number(input.value);
        currentSkills[index] = { ...currentSkills[index], weight: nextWeight };
        output.textContent = readableWeight(nextWeight);
      });
      row.append(rowLabel, input, output);
      list.append(row);
    });

    const apply = createElement("button", "Apply to route");
    apply.type = "button";
    apply.addEventListener("click", async () => {
      const originalText = textarea.value;
      if (!originalText.trim()) {
        onStatus("Add a non-empty description before applying a focus lens.");
        textarea.focus();
        return;
      }
      apply.disabled = true;
      try {
        await onApply({
          id: selectedLens?.id,
          kind: selectedKind,
          originalText,
          skills: currentSkills,
          isActive: true,
        });
      } catch {
        onStatus("Your route could not apply that focus lens. Try again or keep choosing topics freely.");
      } finally {
        apply.disabled = false;
      }
    });
    card.append(title, explanation, list, apply);
    skillsPanel.append(card);
  }

  function updateKindControls() {
    for (const control of kindControls.querySelectorAll("button")) {
      control.setAttribute("aria-pressed", String(control.dataset.focusKind === selectedKind));
    }
  }

  function loadKind(kind) {
    selectedKind = kind;
    selectedLens = activeLensForKind(lenses, selectedKind);
    currentSkills = normaliseSkills(selectedLens?.skills, topics);
    label.textContent = KIND_COPY[selectedKind].field;
    textarea.placeholder = KIND_COPY[selectedKind].intro;
    textarea.value = selectedLens?.originalText ?? "";
    updateKindControls();
    renderSkillControls();
  }

  for (const kind of Object.keys(KIND_COPY)) {
    const control = createElement("button", KIND_COPY[kind].button);
    control.type = "button";
    control.className = "secondary";
    control.dataset.focusKind = kind;
    control.addEventListener("click", () => loadKind(kind));
    kindControls.append(control);
  }

  preview.addEventListener("click", async () => {
    const originalText = textarea.value;
    if (!originalText.trim()) {
      onStatus("Add a non-empty description before previewing skills.");
      textarea.focus();
      return;
    }
    preview.disabled = true;
    try {
      const result = await onPreview({ kind: selectedKind, originalText });
      if (!result || !Array.isArray(result.skills)) {
        onStatus("Skill preview is unavailable right now. Your learning route is still available.");
        return;
      }
      currentSkills = normaliseSkills(result.skills, topics);
      renderSkillControls();
      onStatus("Preview ready. Adjust the topic weights, then apply them to your route.");
    } catch {
      onStatus("Skill preview is unavailable right now. Your learning route is still available.");
    } finally {
      preview.disabled = false;
    }
  });

  section.append(heading, copy, narrator, kindControls, field);
  container.append(section);
  loadKind(selectedKind);
}
