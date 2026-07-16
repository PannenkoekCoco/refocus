export function selectRecommendedTopic({
  pinnedTopicId,
  topics,
  developmentScores = {},
  jobScores = {},
  mastery = {},
}) {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  if (pinnedTopicId && byId.has(pinnedTopicId)) {
    return { ...byId.get(pinnedTopicId), reason: "You pinned this topic." };
  }

  return topics
    .map((topic) => ({
      ...topic,
      score: (developmentScores[topic.id] ?? 0) * 1000
        + (jobScores[topic.id] ?? 0) * 100
        + (1 - (mastery[topic.id] ?? 0)) * 10,
      reason: "Recommended from your goals and current mastery.",
    }))
    .sort((left, right) => right.score - left.score)[0];
}

function advisoryPrerequisites(topic, topicsById) {
  if (!topic.prerequisites?.length) {
    return "No prerequisite is required; you can start here anytime.";
  }

  const names = topic.prerequisites.map((id) => topicsById.get(id)?.title ?? id);
  return `Advisory prerequisite: ${names.join(", ")}. You can start here anytime.`;
}

export function selectRouteView(topics, progress = {}, focus = {}) {
  const topicsById = new Map(topics.map((topic) => [topic.id, topic]));
  const explored = new Set(progress.exploredLessonIds ?? []);
  const attempts = progress.quizAttempts ?? {};

  return topics.map((topic) => {
    const attempt = attempts[topic.id];
    const isFullPath = topic.contentStatus === "full";
    const status = attempt
      ? `Quiz complete: ${attempt.correct}/${attempt.total}.`
      : explored.has(topic.id)
        ? "Lesson explored."
        : isFullPath
          ? "Full lesson available."
          : "Starter exploration available.";

    return {
      ...topic,
      actionLabel: isFullPath ? `Open ${topic.title}` : "Explore now",
      badge: isFullPath ? "Full path" : "Starter exploration",
      isPinned: focus.pinnedTopicId === topic.id,
      isRecommended: focus.recommendedTopicId === topic.id,
      prerequisiteText: advisoryPrerequisites(topic, topicsById),
      status,
    };
  });
}
