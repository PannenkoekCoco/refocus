import { renderNarrator } from "../components/narrator.js";

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function renderLesson({
  container,
  topic,
  lesson,
  prerequisiteText,
  tts,
  onNarrationError,
  onBack,
  onStartQuiz,
}) {
  const screen = createElement("section");
  screen.className = "learning-screen";
  screen.setAttribute("aria-labelledby", "lesson-heading");

  const backRow = createElement("div");
  backRow.className = "back-link-row";
  const back = createElement("button", "Back to learning route");
  back.type = "button";
  back.className = "secondary";
  back.addEventListener("click", onBack);
  backRow.append(back);

  const card = createElement("article");
  card.className = "learning-card";
  const label = createElement("p", lesson ? "Full lesson" : "Starter exploration");
  label.className = "eyebrow";
  const heading = createElement("h2", topic.title);
  heading.id = "lesson-heading";
  const summary = createElement("p", topic.summary);
  const prerequisite = createElement("p", prerequisiteText);
  prerequisite.className = "advisory";
  const narrator = createElement("div");
  narrator.className = "narrator";
  renderNarrator({
    container: narrator,
    speechText: lesson?.speechText ?? topic.speechText,
    tts,
    onError: onNarrationError,
  });
  card.append(label, heading, summary, prerequisite, narrator);

  screen.append(backRow, card);

  if (!lesson) {
    const overview = createElement("article");
    overview.className = "lesson-section";
    const overviewHeading = createElement("h3", "Explore the concept");
    const overviewCopy = createElement(
      "p",
      "This starter exploration gives you the route context. You can return to the map or choose another topic at any time.",
    );
    overview.append(overviewHeading, overviewCopy);
    screen.append(overview);
    container.append(screen);
    return;
  }

  const sections = createElement("div");
  sections.className = "lesson-sections";
  for (const lessonSection of lesson.sections) {
    const section = createElement("section");
    section.className = "lesson-section";
    const sectionHeading = createElement("h3", lessonSection.title);
    const body = createElement("p", lessonSection.body);
    const sectionNarrator = createElement("div");
    sectionNarrator.className = "narrator";
    renderNarrator({
      container: sectionNarrator,
      speechText: lessonSection.speechText,
      tts,
      onError: onNarrationError,
    });
    section.append(sectionHeading, body, sectionNarrator);
    sections.append(section);
  }
  screen.append(sections);

  const practice = createElement("article");
  practice.className = "lesson-section";
  const practiceHeading = createElement("h3", lesson.starterAction.title);
  const practiceCopy = createElement("p", lesson.starterAction.description);
  const practiceNarrator = createElement("div");
  practiceNarrator.className = "narrator";
  renderNarrator({
    container: practiceNarrator,
    speechText: lesson.starterAction.speechText,
    tts,
    onError: onNarrationError,
  });
  practice.append(practiceHeading, practiceCopy, practiceNarrator);
  screen.append(practice);

  const startQuiz = createElement("button", "Start quiz");
  startQuiz.type = "button";
  startQuiz.addEventListener("click", onStartQuiz);
  screen.append(startQuiz);
  container.append(screen);
}
