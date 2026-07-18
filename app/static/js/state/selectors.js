export function selectRecommendedTopic({
  pinnedTopicId,
  topics,
  developmentScores = {},
  jobScores = {},
  mastery = {},
}) {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  if (pinnedTopicId && byId.has(pinnedTopicId)) {
    const topic = byId.get(pinnedTopicId);
    return {
      ...topic,
      reason: "You pinned this topic.",
      advisoryPrerequisites: Array.isArray(topic.prerequisites) ? [...topic.prerequisites] : [],
    };
  }

  let recommendation = null;
  let highestScore = -Infinity;
  for (const topic of topics) {
    const score = (developmentScores[topic.id] ?? 0) * 1000
      + (jobScores[topic.id] ?? 0) * 100
      + (1 - (mastery[topic.id] ?? 0)) * 10;
    if (score > highestScore) {
      highestScore = score;
      recommendation = {
        ...topic,
        score,
        reason: "Recommended from your goals and current mastery.",
        advisoryPrerequisites: Array.isArray(topic.prerequisites) ? [...topic.prerequisites] : [],
      };
    }
  }
  return recommendation;
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

export const ROUTE_STAGES = Object.freeze([
  { id: "foundations", title: "Foundations", categories: ["foundation"] },
  { id: "build-and-ship", title: "Build and ship", categories: ["production"] },
  { id: "ai-systems", title: "AI systems", categories: ["ai-systems"] },
]);

export function selectTodayMomentum({ topics, progress, missions }) {
  const appliedTopics = new Set((missions ?? []).flatMap((mission) => (
    progress.missionStates?.[mission.id]?.status === "self_reviewed" ? [mission.topicId] : []
  )));
  return {
    explored: new Set(progress.exploredLessonIds ?? []).size,
    practised: Object.keys(progress.quizAttempts ?? {}).length,
    applied: appliedTopics.size,
    total: topics.length,
  };
}

export function selectRouteGroups(route, { query = "", category = "all" } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const visible = route.filter((node) => (
    (category === "all" || node.category === category)
    && [node.title, node.summary].join(" ").toLocaleLowerCase().includes(needle)
  ));
  return ROUTE_STAGES.flatMap((stage) => {
    const nodes = visible.filter((node) => stage.categories.includes(node.category));
    return nodes.length ? [{ id: stage.id, title: stage.title, nodes }] : [];
  });
}
