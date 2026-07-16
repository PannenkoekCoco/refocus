export function createQuizSession(questions) {
  let index = 0;
  const answers = [];

  return {
    current: () => questions[index] ?? null,
    answer(choiceIndex) {
      const question = questions[index];
      const correct = choiceIndex === question.answerIndex;
      answers.push({ questionId: question.id, choiceIndex, correct });
      return { correct, expectedIndex: question.answerIndex };
    },
    next: () => {
      index += 1;
      return questions[index] ?? null;
    },
    result: () => ({
      correct: answers.filter((answer) => answer.correct).length,
      total: questions.length,
      answers,
    }),
  };
}
