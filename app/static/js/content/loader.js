const REQUIRED_TOPIC_IDS = new Set([
  "python-beyond-scripts", "git-and-github", "apis", "structured-output-tool-calling",
  "sql", "cloud-deployment", "docker", "authentication-and-permissions", "testing",
  "logging-and-monitoring", "llm-evaluation", "retrieval-augmented-generation",
  "asynchronous-jobs-and-queues", "software-architecture"
]);

const LESSON_TOPIC_IDS = new Set([
  "python-beyond-scripts",
  "git-and-github",
  "apis",
  "sql",
  "testing",
  "ship-secure-backend",
]);

export function validateTopics(topics) {
  const ids = new Set(topics.map((topic) => topic.id));
  if (topics.length !== REQUIRED_TOPIC_IDS.size || ids.size !== REQUIRED_TOPIC_IDS.size) {
    throw new Error("Route topics must contain each required topic exactly once.");
  }
  for (const id of REQUIRED_TOPIC_IDS) {
    if (!ids.has(id)) throw new Error(`Missing route topic: ${id}`);
  }
  for (const topic of topics) {
    if (!topic.title || !topic.speechText || !Array.isArray(topic.prerequisites)) {
      throw new Error(`Invalid route topic: ${topic.id}`);
    }
  }
  return topics;
}

async function readContent(path, fetchImpl) {
  const response = await fetchImpl(new URL(path, import.meta.url));
  if (!response.ok) {
    throw new Error(`Could not load route content: ${response.status}`);
  }
  return response.json();
}

export async function loadTopics(fetchImpl) {
  const payload = await readContent("../../../../content/topics.json", fetchImpl);
  return validateTopics(payload.topics);
}

export async function loadLesson(topicId, fetchImpl) {
  if (!LESSON_TOPIC_IDS.has(topicId)) {
    throw new Error("Invalid lesson topic: " + topicId);
  }
  return readContent(`../../../../content/lessons/${topicId}.json`, fetchImpl);
}
