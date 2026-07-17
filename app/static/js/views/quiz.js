import { renderNarrator } from "../components/narrator.js";
import { createQuizSession } from "../services/quiz-session.js";

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

function toQuizQuestion(question) {
  return {
    ...question,
    answerIndex: question.options.findIndex((option) => option.id === question.correctOption),
  };
}

function answerLabel(index, option) {
  return `${String.fromCharCode(65 + index)}. ${option.text}`;
}

export function renderQuiz({
  container,
  topic,
  lesson,
  tts,
  onNarrationError,
  onComplete,
  onBack,
  onBackToRoute,
  missions = [],
  onMission,
}) {
  const session = createQuizSession(lesson.questions.map(toQuizQuestion));

  function focusElement(element) {
    element.tabIndex = -1;
    element.focus();
  }

  function showResult(result, { savedLocally = true, recommendation = null } = {}) {
    container.replaceChildren();
    const screen = createElement("section");
    screen.className = "quiz-screen";
    screen.setAttribute("aria-labelledby", "quiz-result-heading");
    const card = createElement("article");
    card.className = "quiz-card";
    const labelText = savedLocally ? "Quiz saved locally" : "Quiz available for this session";
    const headingText = `Quiz complete: ${result.correct}/${result.total}.`;
    const copyText = savedLocally
      ? `Your ${topic.title} result is available on the route map.`
      : `Your ${topic.title} result is available for this session. It could not be saved locally.`;
    const suggestedNextText = recommendation ? `Suggested next: ${recommendation.title}` : null;
    const authoredMissions = typeof onMission === "function" ? missions : [];
    const missionSpeechText = authoredMissions.length > 0
      ? `Choose a practical mission. ${authoredMissions.map((mission) => mission.title).join(". ")}.`
      : "";
    const resultSpeechText = [
      `${labelText}.`,
      headingText,
      copyText,
      suggestedNextText ? `${suggestedNextText}.` : "",
      missionSpeechText,
    ].filter(Boolean).join(" ");
    const label = createElement("p", labelText);
    label.className = "eyebrow";
    const heading = createElement("h2", headingText);
    heading.id = "quiz-result-heading";
    const copy = createElement("p", copyText);
    const suggestedNext = suggestedNextText ? createElement("p", suggestedNextText) : null;
    if (suggestedNext) suggestedNext.className = "topic-summary";
    const resultNarrator = createElement("div");
    resultNarrator.className = "narrator";
    renderNarrator({
      container: resultNarrator,
      speechText: resultSpeechText,
      tts,
      onError: onNarrationError,
    });
    const actions = createElement("div");
    actions.className = "result-actions";
    const missionChoices = createElement("div");
    if (authoredMissions.length > 0) {
      const missionHeading = createElement("h3", "Choose a practical mission");
      missionChoices.className = "result-actions";
      missionChoices.append(missionHeading);
      for (const mission of authoredMissions) {
        const missionButton = createElement("button", mission.title);
        missionButton.type = "button";
        missionButton.addEventListener("click", () => onMission(mission));
        missionChoices.append(missionButton);
      }
    }
    const back = createElement("button", "Back to learning route");
    back.type = "button";
    back.className = authoredMissions.length > 0 ? "secondary" : "";
    back.addEventListener("click", onBackToRoute);
    actions.append(back);
    card.append(label, heading, copy, resultNarrator);
    if (suggestedNext) card.append(suggestedNext);
    if (authoredMissions.length > 0) card.append(missionChoices);
    card.append(actions);
    screen.append(card);
    container.append(screen);
    focusElement(heading);
  }

  function showQuestion() {
    const question = session.current();
    container.replaceChildren();
    const screen = createElement("section");
    screen.className = "quiz-screen";
    screen.setAttribute("aria-labelledby", "quiz-heading");
    const backRow = createElement("div");
    backRow.className = "back-link-row";
    const back = createElement("button", "Back to lesson");
    back.type = "button";
    back.className = "secondary";
    back.addEventListener("click", onBack);
    backRow.append(back);

    const card = createElement("article");
    card.className = "quiz-card";
    const label = createElement("p", `${topic.title} quiz`);
    label.className = "eyebrow";
    const heading = createElement("h2", question.prompt);
    heading.id = "quiz-heading";
    const narrator = createElement("div");
    narrator.className = "narrator";
    renderNarrator({
      container: narrator,
      speechText: question.speechText,
      tts,
      onError: onNarrationError,
    });
    const options = createElement("div");
    options.className = "quiz-options";
    const answerButtons = [];

    question.options.forEach((option, optionIndex) => {
      const answer = createElement("button", answerLabel(optionIndex, option));
      answer.type = "button";
      answer.addEventListener("click", () => {
        const feedback = session.answer(optionIndex);
        for (const answerButton of answerButtons) answerButton.disabled = true;

        const feedbackCard = createElement("section");
        feedbackCard.className = `quiz-feedback ${feedback.correct ? "correct" : "incorrect"}`;
        feedbackCard.setAttribute("aria-live", "polite");
        feedbackCard.setAttribute("aria-label", "Answer feedback");
        const expectedOption = question.options[feedback.expectedIndex];
        const feedbackText = feedback.correct
          ? "Correct."
          : `Not quite. Correct answer: ${answerLabel(feedback.expectedIndex, expectedOption)}`;
        const feedbackMessage = createElement("p", feedbackText);
        const explanation = createElement("p", question.explanation);
        const explanationNarrator = createElement("div");
        explanationNarrator.className = "narrator";
        renderNarrator({
          container: explanationNarrator,
          speechText: `${feedbackText} ${question.explanationSpeechText}`,
          tts,
          onError: onNarrationError,
        });
        feedbackCard.append(feedbackMessage, explanation, explanationNarrator);

        if (question.id === lesson.questions.at(-1).id) {
          const result = session.result();
          const completion = Promise.resolve(onComplete(result));
          const seeResults = createElement("button", "See results");
          seeResults.type = "button";
          seeResults.addEventListener("click", async () => {
            seeResults.disabled = true;
            try {
              showResult(result, await completion);
            } catch {
              showResult(result, { savedLocally: false });
            }
          });
          feedbackCard.append(seeResults);
          card.append(feedbackCard);
          focusElement(feedbackCard);
          return;
        }

        const next = createElement("button", "Next question");
        next.type = "button";
        next.addEventListener("click", () => {
          session.next();
          showQuestion();
        });
        feedbackCard.append(next);
        card.append(feedbackCard);
        focusElement(feedbackCard);
      });
      answerButtons.push(answer);
      options.append(answer);
    });

    card.append(label, heading, narrator, options);
    screen.append(backRow, card);
    container.append(screen);
    focusElement(heading);
  }

  showQuestion();
}
