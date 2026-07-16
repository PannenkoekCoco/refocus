import test from "node:test";
import assert from "node:assert/strict";
import { createQuizSession } from "../static/js/services/quiz-session.js";

test("quiz results include immediate answer feedback", () => {
  const session = createQuizSession([{ id: "q1", answerIndex: 1, options: ["a", "b"] }]);

  assert.deepEqual(session.answer(0), { correct: false, expectedIndex: 1 });
});

test("a quiz retains answers while progressing to a final result", () => {
  const session = createQuizSession([
    { id: "q1", answerIndex: 0, options: ["a", "b"] },
    { id: "q2", answerIndex: 1, options: ["a", "b"] },
  ]);

  session.answer(0);
  assert.equal(session.next().id, "q2");
  session.answer(0);

  assert.deepEqual(session.result(), {
    correct: 1,
    total: 2,
    answers: [
      { questionId: "q1", choiceIndex: 0, correct: true },
      { questionId: "q2", choiceIndex: 0, correct: false },
    ],
  });
});
