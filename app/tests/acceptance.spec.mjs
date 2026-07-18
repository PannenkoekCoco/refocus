import { expect, test } from "@playwright/test";

const GITHUB_SENSITIVE_RESPONSE_FIELDS = new Set([
  "access_token",
  "refresh_token",
  "token",
  "github_token",
  "installation_token",
  "oauth_token",
  "user_token",
  "bearer_token",
  "code",
  "state",
  "code_verifier",
  "verifier",
]);

function normalizeGitHubFieldName(fieldName) {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
}

function hasSensitiveGitHubResponseField(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveGitHubResponseField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([fieldName, nestedValue]) => (
    GITHUB_SENSITIVE_RESPONSE_FIELDS.has(normalizeGitHubFieldName(fieldName))
    || hasSensitiveGitHubResponseField(nestedValue)
  ));
}

function jsonBodyHasSensitiveGitHubResponseField(body) {
  if (typeof body !== "string" || body.length === 0) return false;
  return hasSensitiveGitHubResponseField(JSON.parse(body));
}

function urlHasSensitiveGitHubResponseField(url) {
  return [...new URL(url).searchParams.keys()].some((fieldName) => (
    GITHUB_SENSITIVE_RESPONSE_FIELDS.has(normalizeGitHubFieldName(fieldName))
  ));
}

function emptyGitHubConnection() {
  return { connected: false, installations: [] };
}

test("the GitHub response safety check rejects a JSON access token", () => {
  expect(jsonBodyHasSensitiveGitHubResponseField(JSON.stringify({ access_token: "secret" }))).toBe(true);
});

test("the GitHub response safety check rejects nested secret field keys", () => {
  for (const fieldName of ["token", "code", "state", "codeVerifier"]) {
    expect(jsonBodyHasSensitiveGitHubResponseField(JSON.stringify({
      authorization: { [fieldName]: "secret" },
    }))).toBe(true);
  }
});

test("the GitHub response safety check leaves ordinary lesson content alone", () => {
  expect(jsonBodyHasSensitiveGitHubResponseField(JSON.stringify({
    title: "Protect an access token in an API client",
    lesson: { summary: "Learn why a token should not be logged." },
  }))).toBe(false);
});

test("a mismatched static mission contract does not load into the learning route", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.route("**/content/missions/foundation-missions.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 2,
        missions: [{ id: "unverifiable-mission", topicId: "apis" }],
      }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", {
    name: "Your learning route could not load offline.",
  })).toBeVisible();
});

async function mockInitialBrowserApis(page, { connection = emptyGitHubConnection } = {}) {
  await page.route("**/api/focus-lenses", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ lenses: [] }),
    });
  });
  await page.route("**/api/github/installations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(connection()),
    });
  });
}

async function installBrowserSpeechFallback(page) {
  await page.addInitScript(() => {
    const spoken = [];
    window.__refocusSpokenText = spoken;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        cancel() {},
        speak(utterance) {
          spoken.push(utterance.text);
        },
      },
    });
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    const browserFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const target = typeof input === "string" ? input : input?.url ?? String(input);
      if (target.startsWith("http://127.0.0.1:8767/tts")) {
        return Promise.reject(new TypeError("local TTS unavailable"));
      }
      return browserFetch(input, options);
    };
  });
}

async function installUnavailableSpeech(page) {
  await page.addInitScript(() => {
    window.__refocusTtsRequests = 0;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: undefined,
    });
    window.SpeechSynthesisUtterance = undefined;
    const browserFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const target = typeof input === "string" ? input : input?.url ?? String(input);
      if (target.startsWith("http://127.0.0.1:8767/tts")) {
        window.__refocusTtsRequests += 1;
        return Promise.reject(new TypeError("no text-to-speech provider"));
      }
      return browserFetch(input, options);
    };
  });
}

async function expectSpokenText(page, text) {
  await expect.poll(async () => page.evaluate((expectedText) => (
    window.__refocusSpokenText.includes(expectedText)
  ), text)).toBe(true);
}

async function openRouteTopic(page, topicId, actionName) {
  await showRoute(page);
  const card = page.locator(`.topic-card[data-topic-id="${topicId}"]`);
  await card.getByRole("button", { name: actionName }).click();
}

async function showRoute(page) {
  const routeLibrary = page.locator(".route-library");
  if (await routeLibrary.count() === 0) {
    await page.getByRole("button", { name: "Route", exact: true }).click();
  }
  await expect(routeLibrary).toBeVisible();
}

async function showTailor(page) {
  const tailorView = page.locator(".tailor-view");
  if (await tailorView.count() === 0) {
    await page.getByRole("button", { name: "Tailor", exact: true }).click();
  }
  await expect(tailorView).toBeVisible();
}

async function completeCurrentQuizWithCorrectBAnswers(page) {
  for (let questionIndex = 0; questionIndex < 3; questionIndex += 1) {
    await page.getByRole("button", { name: /^B\./ }).click();
    if (questionIndex < 2) {
      await page.getByRole("button", { name: "Next question" }).click();
    }
  }
}

test("Today offers one next learning action before route browsing", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.goto("/");

  await expect(page.locator(".today-view")).toBeVisible();
  await expect(page.locator(".today-view .today-primary-action")).toHaveCount(1);
  await expect(page.locator(".today-view .momentum-grid > *")).toHaveCount(3);
  await expect(page.locator(".today-view .recommendation-reason")).toBeVisible();
  await expect(page.locator(".topic-card")).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Browse all topics" })).toHaveClass(/secondary/);
  const tailor = page.getByRole("button", { name: "Tailor my route" });
  await expect(tailor).toHaveClass(/secondary/);

  await tailor.click();
  await expect(page.locator(".tailor-view")).toBeVisible();
  await page.getByRole("button", { name: "Today", exact: true }).click();

  await page.getByRole("button", { name: "Browse all topics" }).click();
  await expect(page.locator(".route-library .topic-card")).toHaveCount(14);
});

test("Today remains compact and usable at a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockInitialBrowserApis(page);
  await page.goto("/");

  await expect(page.locator(".today-view .today-primary-action")).toHaveCount(1);
  await expect(page.locator(".today-view .topic-card")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the header navigates explicitly between Today, Route, and Tailor", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.goto("/");

  const navigation = page.getByRole("navigation", { name: "Learning views" });
  await expect(navigation.getByRole("button")).toHaveText(["Today", "Route", "Tailor"]);
  const today = navigation.getByRole("button", { name: "Today" });
  await expect(today).toHaveAttribute("aria-current", "page");
  await expect(today).toHaveCSS("color", "rgb(20, 33, 61)");

  await navigation.getByRole("button", { name: "Route" }).click();
  await expect(page.locator(".route-library")).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Route" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "Today" })).not.toHaveAttribute("aria-current");

  await navigation.getByRole("button", { name: "Tailor" }).click();
  await expect(page.locator(".tailor-view")).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Tailor" })).toHaveAttribute("aria-current", "page");
});

test("Tailor starts with a low-friction choice before the advanced editor", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Tailor my route" }).click();
  await expect(page.getByRole("heading", { name: "Tailor your route" })).toBeVisible();
  await expect(page.getByLabel("Job description")).toHaveCount(0);
  await page.getByRole("button", { name: "Aim for a role" }).click();
  await expect(page.getByLabel("Job description")).toBeVisible();
});

test("Tailor follows the foundation without applying a focus lens and returns to Today", async ({ page }) => {
  const focusLensWrites = [];
  await mockInitialBrowserApis(page);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/focus-lenses" && request.method() !== "GET") {
      focusLensWrites.push(request.method());
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Tailor my route" }).click();

  for (const choice of ["Follow the foundation", "Aim for a role", "Build toward a goal"]) {
    await expect(page.getByRole("button", { name: choice })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview skills" })).toHaveCount(0);
  await expect(page.getByRole("slider")).toHaveCount(0);

  await page.getByRole("button", { name: "Back to Today" }).click();
  await expect(page.locator(".today-view")).toBeVisible();
  await page.getByRole("button", { name: "Tailor my route" }).click();

  await page.getByRole("button", { name: "Follow the foundation" }).click();

  await expect(page.locator(".today-view")).toBeVisible();
  await expect(page.locator("#status-message")).toContainText("Following the foundation.");
  expect(focusLensWrites).toEqual([]);
});

test("Tailor reveals development goal weights only after a successful preview", async ({ page }) => {
  let previewPayload = null;
  await mockInitialBrowserApis(page);
  await page.route("**/api/focus-lenses/preview", async (route) => {
    previewPayload = JSON.parse(route.request().postData());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ skills: [{ topicId: "apis", weight: 0.6 }] }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Tailor my route" }).click();
  await page.getByRole("button", { name: "Build toward a goal" }).click();

  const goal = page.getByLabel("Development goal");
  await expect(goal).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await goal.fill("Build a reliable API service.");
  await page.getByRole("button", { name: "Preview skills" }).click();

  await expect(page.getByRole("slider", { name: "APIs weight" })).toHaveValue("0.6");
  expect(previewPayload).toEqual({ kind: "development", originalText: "Build a reliable API service." });
});

test("the route library filters topics without hiding free navigation", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Browse all topics" }).click();

  for (const filterName of ["All", "Foundations", "Build and ship", "AI systems"]) {
    await expect(page.getByRole("button", { name: filterName, exact: true })).toBeVisible();
  }
  await page.getByLabel("Search topics").fill("Docker");
  await expect(page.locator(".route-library .topic-card")).toHaveCount(1);
  const dockerCard = page.locator('.topic-card[data-topic-id="docker"]');
  await expect(dockerCard.locator(".topic-open")).toHaveCount(1);
  await expect(dockerCard.locator(".topic-pin")).toHaveCount(1);
  await expect(dockerCard.locator(".narrator")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Explore now Docker" })).toBeEnabled();

  await page.getByLabel("Search topics").fill("");
  await page.getByRole("button", { name: "AI systems" }).click();
  await expect(page.locator(".route-library .route-stage")).toHaveCount(1);
  await expect(page.locator(".route-library .topic-card")).toHaveCount(3);

  await page.getByRole("button", { name: "Back to Today" }).click();
  await expect(page.locator(".today-view")).toBeVisible();
});

test("all fourteen topics stay free while an advanced pin remains recommended", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Browse all topics" }).click();

  const cards = page.locator(".topic-card");
  await expect(cards).toHaveCount(14);
  for (let index = 0; index < 14; index += 1) {
    const card = cards.nth(index);
    await expect(card).toBeVisible();
    await expect(card.locator(".topic-pin")).toHaveCount(1);
    await expect(card.locator(".topic-open")).toHaveCount(1);
    await expect(card.getByRole("button", { name: /^(Open|Explore now)/ })).toBeEnabled();
  }

  const ragCard = page.locator('.topic-card[data-topic-id="retrieval-augmented-generation"]');
  await ragCard.getByRole("button", { name: "Pin Retrieval-augmented generation" }).click();

  await expect(ragCard).toContainText("AI systems");
  await expect(ragCard.locator(".advisory")).toHaveCount(0);
  await expect(ragCard.locator(".narrator")).toHaveCount(0);
  await expect(ragCard.getByRole("button", { name: "Unpin Retrieval-augmented generation" })).toBeFocused();
  await page.getByRole("button", { name: "Today", exact: true }).click();

  await expect(page.locator(".recommendation-card")).toContainText("Retrieval-augmented generation");
  await expect(page.getByText("You pinned this topic.", { exact: true }).first()).toBeVisible();
});

test("lesson and quiz show the Learn Check Apply loop", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.goto("/");

  await openRouteTopic(page, "apis", "Open APIs");
  const stepper = page.locator(".learning-stepper");
  await expect(stepper).toHaveAttribute("aria-label", "Learning progress");
  await expect(stepper.locator("li")).toHaveText(["Learn", "Check", "Apply"]);
  await expect(stepper.locator(".is-active")).toHaveCount(1);
  await expect(stepper.locator(".is-active")).toHaveText("Learn");

  await page.getByRole("button", { name: "Start quiz" }).click();
  await expect(page.getByText("Question 1 of 3", { exact: true })).toBeVisible();
  await expect(stepper.locator(".is-active")).toHaveCount(1);
  await expect(stepper.locator(".is-active")).toHaveText("Check");

  await page.getByRole("button", { name: /^B\./ }).click();
  await page.getByRole("button", { name: "Next question" }).click();
  await expect(page.getByText("Question 2 of 3", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^B\./ }).click();
  await page.getByRole("button", { name: "Next question" }).click();
  await expect(page.getByText("Question 3 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^B\./ }).click();
  await page.getByRole("button", { name: "See results" }).click();

  await expect(stepper.locator(".is-active")).toHaveCount(1);
  await expect(stepper.locator(".is-active")).toHaveText("Apply");
  await expect(page.getByRole("button", { name: "Ship a small API service" })).toBeVisible();
});

test("starter completion saves completed progress and returns to Today", async ({ page }) => {
  const progressWrites = [];
  await mockInitialBrowserApis(page);
  await page.route("**/api/progress/**", async (route) => {
    progressWrites.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("/");

  await openRouteTopic(page, "docker", "Explore now Docker");
  await expect(page.getByRole("button", { name: "I tried this step" })).toBeVisible();
  await page.getByRole("button", { name: "I tried this step" }).click();

  await expect(page.locator(".today-view")).toBeVisible();
  await expect(page.locator("#status-message")).toContainText(
    "Docker is marked complete and will sync when you're online.",
  );
  await expect.poll(() => progressWrites.some(({ path, body }) => (
    path === "/api/progress/topic/docker" && body?.status === "completed"
  ))).toBe(true);
});

test("starter completion stays open when progress cannot be queued", async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === "engineeringLearningRoute.v1") throw new Error("storage blocked");
      return originalSetItem.call(this, key, value);
    };
  });
  await mockInitialBrowserApis(page);
  await page.goto("/");

  await openRouteTopic(page, "docker", "Explore now Docker");
  const completeStarter = page.getByRole("button", { name: "I tried this step" });
  await completeStarter.click();

  await expect(page.getByRole("heading", { name: "Docker" })).toBeVisible();
  await expect(page.locator(".today-view")).toHaveCount(0);
  await expect(page.locator("#status-message")).toHaveText(
    "Progress could not be saved locally. It is available for this session only.",
  );
  await expect(completeStarter).toBeEnabled();
});

test("a Python lesson falls back to browser speech and keeps a locally saved quiz route navigable", async ({ page }) => {
  await installBrowserSpeechFallback(page);
  await mockInitialBrowserApis(page);
  await page.route("**/api/progress/**", async (route) => route.abort("failed"));
  await page.goto("/");

  await openRouteTopic(page, "python-beyond-scripts", "Open Python beyond scripts");
  const lessonCard = page.locator(".learning-card");
  await lessonCard.locator("> .narrator").getByRole("button", { name: "Listen" }).click();
  await expect.poll(async () => page.evaluate(() => (
    window.__refocusSpokenText.some((text) => text.startsWith("Python beyond scripts."))
  ))).toBe(true);

  await page.getByRole("button", { name: "Start quiz" }).click();
  await completeCurrentQuizWithCorrectBAnswers(page);
  await expect(page.getByText("Saved locally; sign in or retry to sync.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "See results" }).click();
  await expect(page.getByRole("heading", { name: "Quiz complete: 3/3." })).toBeVisible();

  const localState = await page.evaluate(() => JSON.parse(localStorage.getItem("engineeringLearningRoute.v1")));
  expect(localState.quizAttempts["python-beyond-scripts"]).toEqual({ correct: 3, total: 3 });
  expect(localState.pendingProgress).toHaveLength(2);

  await page.getByRole("button", { name: "Back to learning route" }).click();
  await openRouteTopic(page, "retrieval-augmented-generation", "Explore now Retrieval-augmented generation");
  await expect(page.getByRole("heading", { name: "Retrieval-augmented generation" })).toBeVisible();
});

test("narration coverage speaks route guidance, practical actions, mission evidence, and feedback", async ({ page }) => {
  await installBrowserSpeechFallback(page);
  await mockInitialBrowserApis(page);
  await page.goto("/");

  await page.locator(".today-view > .narrator").getByRole("button", { name: "Listen" }).click();
  await expectSpokenText(
    page,
    "Today. Your next learning action. Suggested next: Python beyond scripts. Recommended from your goals and current mastery. Turn scripts into maintainable, testable modules. Your momentum: 0 explored, 0 practised, and 0 applied out of 14 topics. Browse all topics or tailor your route whenever you want.",
  );

  await showRoute(page);
  await page.locator(".route-map-header > .narrator").getByRole("button", { name: "Listen" }).click();
  await expectSpokenText(
    page,
    "All engineering topics. Every topic is available now. Prerequisites are advisory context, not requirements.",
  );

  const ragCard = page.locator('.topic-card[data-topic-id="retrieval-augmented-generation"]');
  await expect(ragCard.locator(".narrator")).toHaveCount(0);

  await ragCard.getByRole("button", { name: "Pin Retrieval-augmented generation" }).click();
  await expectSpokenText(page, "Retrieval-augmented generation is pinned.");

  await openRouteTopic(page, "docker", "Explore now Docker");
  const starterAction = page.locator(".lesson-section").filter({
    has: page.getByRole("heading", { name: "Write a one-container plan" }),
  });
  await starterAction.locator(".narrator").getByRole("button", { name: "Listen" }).click();
  await expectSpokenText(
    page,
    "Starter action. Write a one-container plan for one app. Name its command, port, environment values, and a file that must not enter the image.",
  );

  await page.getByRole("button", { name: "Back to learning route" }).click();
  await openRouteTopic(page, "apis", "Open APIs");
  await page.getByRole("button", { name: "Start quiz" }).click();
  await completeCurrentQuizWithCorrectBAnswers(page);
  await page.getByRole("button", { name: "See results" }).click();
  await page.getByRole("button", { name: "Ship a small API service" }).click();

  await page.locator(".mission-card > .narrator").getByRole("button", { name: "Listen" }).click();
  await expectSpokenText(
    page,
    "Build a small API service with a deliberate contract. Choose a path, reflect on your work, and record your own review. Self-review checklist. Review whether you created backend/app/main.py. Review whether you created README.md. Review whether you wrote a pull-request-ready summary. Review whether you ran the checks you chose for this project.",
  );
});

test("quiz feedback and results have explicit browser-fallback narration", async ({ page }) => {
  await installBrowserSpeechFallback(page);
  await mockInitialBrowserApis(page);
  await page.goto("/");

  await openRouteTopic(page, "apis", "Open APIs");
  await page.getByRole("button", { name: "Start quiz" }).click();
  await page.getByRole("button", { name: /^A\./ }).click();
  const feedback = page.locator(".quiz-feedback");
  await feedback.getByRole("button", { name: "Listen" }).click();
  await expect.poll(async () => page.evaluate(() => (
    window.__refocusSpokenText.some((text) => (
      text.startsWith("Not quite. Correct answer:") && text.includes("Invalid request data")
    ))
  ))).toBe(true);

  await page.getByRole("button", { name: "Next question" }).click();
  await page.getByRole("button", { name: /^B\./ }).click();
  await page.getByRole("button", { name: "Next question" }).click();
  await page.getByRole("button", { name: /^B\./ }).click();
  await page.getByRole("button", { name: "See results" }).click();
  await page.locator(".quiz-card > .narrator").getByRole("button", { name: "Listen" }).click();
  await expect.poll(async () => page.evaluate(() => (
    window.__refocusSpokenText.some((text) => (
      text.includes("Quiz complete: 2/3.")
      && text.includes("Quiz saved locally")
      && text.includes("Suggested next:")
      && text.includes("Choose a practical mission")
      && text.includes("Ship a small API service")
    ))
  ))).toBe(true);
});

test("status narration leaves pin feedback visible when no provider is available", async ({ page }) => {
  await installUnavailableSpeech(page);
  await mockInitialBrowserApis(page);
  await page.goto("/");

  await showRoute(page);
  const ragCard = page.locator('.topic-card[data-topic-id="retrieval-augmented-generation"]');
  await ragCard.getByRole("button", { name: "Pin Retrieval-augmented generation" }).click();

  await expect(page.locator("#status-message")).toHaveText("Retrieval-augmented generation is pinned.");
  await expect.poll(() => page.evaluate(() => window.__refocusTtsRequests)).toBe(1);
  await expect(page.locator("#status-message")).toHaveText("Retrieval-augmented generation is pinned.");
});

test("starter actions are topic-specific and APIs offer both authored portfolio missions", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.goto("/");

  await openRouteTopic(page, "docker", "Explore now Docker");
  await expect(page.getByRole("heading", { name: "Write a one-container plan" })).toBeVisible();
  await expect(page.getByText(
    "Choose one app and list its command, port, environment values, and one file that must not enter the image.",
    { exact: true },
  )).toBeVisible();

  await page.getByRole("button", { name: "Back to learning route" }).click();
  await openRouteTopic(page, "apis", "Open APIs");
  await page.getByRole("button", { name: "Start quiz" }).click();
  await completeCurrentQuizWithCorrectBAnswers(page);
  await page.getByRole("button", { name: "See results" }).click();

  await expect(page.getByRole("heading", { name: "Choose a practical mission" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ship a small API service" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ship a secure backend capstone" })).toBeVisible();
});

test("the API mission journey selects an authorized repository, explains missing evidence, and never exposes a GitHub token", async ({ page }) => {
  await installBrowserSpeechFallback(page);
  let repositorySelected = false;
  let selectedRepositoryRequest = null;
  let verificationRequest = null;
  const githubRequests = [];
  const githubResponses = [];
  const connection = () => ({
    connected: true,
    installations: [{
      id: 7,
      accountLogin: "octo-org",
      repositories: [{
        id: 42,
        fullName: "octo-org/refocus",
        defaultBranch: "main",
        selected: repositorySelected,
      }],
    }],
  });
  await mockInitialBrowserApis(page, { connection });
  await page.route("**/api/progress/**", async (route) => route.abort("failed"));
  await page.route("**/api/github/repositories/42", async (route) => {
    selectedRepositoryRequest = {
      method: route.request().method(),
      postData: route.request().postData(),
    };
    repositorySelected = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 42,
        fullName: "octo-org/refocus",
        defaultBranch: "main",
        selected: true,
      }),
    });
  });
  await page.route("**/api/missions/api-service-v1/verify", async (route) => {
    verificationRequest = {
      method: route.request().method(),
      postData: route.request().postData(),
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "needs_attention",
        evidence: [],
        reason: "Required file missing: README.md",
      }),
    });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/github") || path.startsWith("/api/missions/")) {
      githubRequests.push({
        url: request.url(),
        headers: request.headers(),
        postData: request.postData() ?? "",
      });
    }
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/github") || path.startsWith("/api/missions/")) {
      githubResponses.push(response);
    }
  });

  await page.goto("/");
  await openRouteTopic(page, "apis", "Open APIs");
  await page.getByRole("button", { name: "Start quiz" }).click();
  await completeCurrentQuizWithCorrectBAnswers(page);
  await page.getByRole("button", { name: "See results" }).click();
  await page.getByRole("button", { name: "Ship a small API service" }).click();

  const verification = page.locator(".github-verification");
  await expect(verification.getByRole("heading", { name: "Optional GitHub verification" })).toBeVisible();
  const repository = verification.getByRole("combobox", { name: "GitHub repository" });
  await expect(repository).toBeVisible();
  await repository.selectOption("42");
  await expect.poll(() => repositorySelected).toBe(true);
  await verification.getByRole("button", { name: "Verify with GitHub" }).click();

  await expect(verification.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(verification.getByText("Required file missing: README.md", { exact: true })).toBeVisible();
  await verification.locator(".github-verification-feedback .narrator")
    .getByRole("button", { name: "Listen" })
    .click();
  await expect.poll(async () => page.evaluate(() => (
    window.__refocusSpokenText.some((text) => text.includes("Required file missing: README.md"))
  ))).toBe(true);

  expect(selectedRepositoryRequest).toEqual({ method: "PUT", postData: null });
  expect(verificationRequest).toEqual({ method: "POST", postData: "{}" });
  expect(githubRequests.length).toBeGreaterThanOrEqual(3);
  for (const request of githubRequests) {
    expect(Object.keys(request.headers)).not.toContain("authorization");
    expect(urlHasSensitiveGitHubResponseField(request.url)).toBe(false);
    expect(jsonBodyHasSensitiveGitHubResponseField(request.postData)).toBe(false);
  }
  for (const response of githubResponses) {
    expect(jsonBodyHasSensitiveGitHubResponseField(await response.text())).toBe(false);
  }
});

test("keyboard focus, polite status, and the route grid use one mobile and two desktop columns", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to learning route" })).toBeFocused();
  await showRoute(page);
  const ragCard = page.locator('.topic-card[data-topic-id="retrieval-augmented-generation"]');
  const pin = ragCard.getByRole("button", { name: "Pin Retrieval-augmented generation" });
  await pin.focus();
  await page.keyboard.press("Enter");
  await expect(ragCard.getByRole("button", { name: "Unpin Retrieval-augmented generation" })).toBeFocused();
  await expect(page.locator("#status-message")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#status-message")).toHaveText("Retrieval-augmented generation is pinned.");

  const routeLists = page.locator(".route-stage .route-list");
  const mobileColumns = await routeLists.evaluateAll((elements) => elements.map((element) => (
    getComputedStyle(element).gridTemplateColumns.split(" ").length
  )));
  expect(mobileColumns).toEqual([1, 1, 1]);

  await page.setViewportSize({ width: 768, height: 900 });
  const boundaryColumns = await routeLists.evaluateAll((elements) => elements.map((element) => (
    getComputedStyle(element).gridTemplateColumns.split(" ").length
  )));
  expect(boundaryColumns).toEqual([1, 1, 1]);

  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopColumns = await routeLists.evaluateAll((elements) => elements.map((element) => (
    getComputedStyle(element).gridTemplateColumns.split(" ").length
  )));
  expect(desktopColumns).toEqual([2, 2, 2]);
});

test("offline progress sync hydrates once, acknowledges only delivered work, and keeps a local mission reflection", async ({ page }) => {
  const offlineQuizAttempt = {
    attemptId: "5dd72f13-4d53-4a7d-9d07-c17b9e8ff89b",
    lessonId: "apis",
    answers: [{ questionId: "invalid-input", choiceIndex: 1, correct: true }],
  };
  const offlineMission = {
    missionId: "api-service-v1",
    approach: "guided",
    reflection: "Keep this offline reflection after hydration.",
    status: "self_reviewed",
  };
  await page.addInitScript(({ quizAttempt, mission }) => {
    localStorage.setItem("engineeringLearningRoute.v1", JSON.stringify({
      pinnedTopicId: "retrieval-augmented-generation",
      exploredLessonIds: ["apis"],
      quizAttempts: { apis: { correct: 3, total: 3 } },
      missionStates: { "api-service-v1": mission },
      pendingProgress: [{
        kind: "topicProgress",
        payload: { topicId: "apis", status: "explored" },
      }, {
        kind: "quizAttempt",
        payload: quizAttempt,
      }, {
        kind: "missionProgress",
        payload: mission,
      }],
    }));
  }, { quizAttempt: offlineQuizAttempt, mission: offlineMission });

  let snapshotRequests = 0;
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  const progressWrites = [];
  await mockInitialBrowserApis(page);
  await page.route("**/api/progress", async (route) => {
    snapshotRequests += 1;
    await snapshotGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        topics: [{
          id: "00000000-0000-0000-0000-000000000001",
          topicId: "sql",
          status: "explored",
          updatedAt: "2026-07-17T00:00:00Z",
        }],
        quizAttempts: [{ lessonId: "python-beyond-scripts", correct: 1, total: 3 }],
        missions: [{
          id: "00000000-0000-0000-0000-000000000002",
          missionId: "api-service-v1",
          approach: "guided",
          reflection: "This server reflection must not replace local work.",
          status: "self_reviewed",
          updatedAt: "2026-07-17T00:00:00Z",
        }],
      }),
    });
  });
  await page.route("**/api/progress/**", async (route) => {
    progressWrites.push({
      url: new URL(route.request().url()).pathname,
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/");
  await expect.poll(() => snapshotRequests).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(100);
  expect(snapshotRequests).toBe(1);
  releaseSnapshot();

  await expect.poll(() => progressWrites.length).toBe(3);
  await expect.poll(async () => page.evaluate(() => (
    JSON.parse(localStorage.getItem("engineeringLearningRoute.v1")).pendingProgress?.length ?? 0
  ))).toBe(0);
  expect(progressWrites).toEqual([
    {
      url: "/api/progress/topic/apis",
      method: "PUT",
      body: { status: "explored" },
    },
    {
      url: "/api/progress/quiz-attempts",
      method: "POST",
      body: offlineQuizAttempt,
    },
    {
      url: "/api/progress/missions/api-service-v1",
      method: "PUT",
      body: {
        approach: offlineMission.approach,
        reflection: offlineMission.reflection,
        status: offlineMission.status,
      },
    },
  ]);

  await showRoute(page);
  const pythonCard = page.locator('.topic-card[data-topic-id="python-beyond-scripts"]');
  await expect(pythonCard).toContainText("Quiz complete: 1/3.");
  await openRouteTopic(page, "apis", "Open APIs");
  await page.getByRole("button", { name: "Start quiz" }).click();
  await completeCurrentQuizWithCorrectBAnswers(page);
  await page.getByRole("button", { name: "See results" }).click();
  await page.getByRole("button", { name: "Ship a small API service" }).click();
  expect(snapshotRequests).toBe(1);
  await expect(page.getByRole("textbox", { name: "Short reflection" })).toHaveValue(offlineMission.reflection);
});

test("a failed offline progress replay remains queued and keeps the established pending message", async ({ page }) => {
  const pendingTopic = {
    kind: "topicProgress",
    payload: { topicId: "apis", status: "explored" },
  };
  await page.addInitScript((record) => {
    localStorage.setItem("engineeringLearningRoute.v1", JSON.stringify({ pendingProgress: [record] }));
  }, pendingTopic);

  let replayWrites = 0;
  await mockInitialBrowserApis(page);
  await page.route("**/api/progress", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/progress/**", async (route) => {
    replayWrites += 1;
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  await page.goto("/");
  await expect.poll(() => replayWrites).toBe(1);
  await expect(page.getByText("Saved locally; sign in or retry to sync.", { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => JSON.parse(
    localStorage.getItem("engineeringLearningRoute.v1"),
  ).pendingProgress)).toEqual([pendingTopic]);
});

test("online progress hydration does not replace an unsaved mission reflection", async ({ page }) => {
  let snapshotRequests = 0;
  await mockInitialBrowserApis(page);
  await page.route("**/api/progress", async (route) => {
    snapshotRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ topics: [], quizAttempts: [], missions: [] }),
    });
  });
  await page.route("**/api/progress/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/");
  await expect.poll(() => snapshotRequests).toBe(1);
  await openRouteTopic(page, "apis", "Open APIs");
  await page.getByRole("button", { name: "Start quiz" }).click();
  await completeCurrentQuizWithCorrectBAnswers(page);
  await page.getByRole("button", { name: "See results" }).click();
  await page.getByRole("button", { name: "Ship a small API service" }).click();

  const reflection = page.getByRole("textbox", { name: "Short reflection" });
  await reflection.fill("Keep this unfinished reflection in the browser.");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => snapshotRequests).toBe(2);
  await expect(reflection).toHaveValue("Keep this unfinished reflection in the browser.");
});

test("startup progress sync absorbs an early online event without repeating the snapshot or replay", async ({ page }) => {
  const pendingTopic = {
    kind: "topicProgress",
    payload: { topicId: "apis", status: "explored" },
  };
  await page.addInitScript((record) => {
    localStorage.setItem("engineeringLearningRoute.v1", JSON.stringify({ pendingProgress: [record] }));
  }, pendingTopic);

  let topicsRequests = 0;
  let releaseTopics;
  const topicsGate = new Promise((resolve) => {
    releaseTopics = resolve;
  });
  let snapshotRequests = 0;
  let replayWrites = 0;
  await mockInitialBrowserApis(page);
  await page.route("**/api/content/topics", async (route) => {
    topicsRequests += 1;
    await topicsGate;
    await route.continue();
  });
  await page.route("**/api/progress", async (route) => {
    snapshotRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ topics: [], quizAttempts: [], missions: [] }),
    });
  });
  await page.route("**/api/progress/**", async (route) => {
    replayWrites += 1;
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect.poll(() => topicsRequests).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(100);
  releaseTopics();

  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect.poll(() => snapshotRequests).toBe(1);
  await expect.poll(() => replayWrites).toBe(1);
  await page.waitForTimeout(150);
  expect(snapshotRequests).toBe(1);
  expect(replayWrites).toBe(1);
});

test("online hydration preserves an unapplied job description focus-lens draft without caching its source text", async ({ page }) => {
  const privateDraft = "Keep this job description only in the current browser memory.";
  let snapshotRequests = 0;
  await mockInitialBrowserApis(page);
  await page.route("**/api/focus-lenses/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ skills: [{ topicId: "apis", weight: 0.6 }] }),
    });
  });
  await page.route("**/api/progress", async (route) => {
    snapshotRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        topics: [{
          id: "00000000-0000-0000-0000-000000000003",
          topicId: "sql",
          status: "explored",
          updatedAt: "2026-07-17T00:00:00Z",
        }],
        quizAttempts: [],
        missions: [],
      }),
    });
  });

  await page.goto("/");
  await expect.poll(() => snapshotRequests).toBe(1);
  await expect.poll(async () => page.evaluate(() => JSON.parse(
    localStorage.getItem("engineeringLearningRoute.v1"),
  ).exploredLessonIds.includes("sql"))).toBe(true);

  await showTailor(page);
  await page.getByRole("button", { name: "Aim for a role" }).click();
  const jobDescription = page.getByRole("textbox", { name: "Job description" });
  await jobDescription.fill(privateDraft);
  await page.getByRole("button", { name: "Preview skills" }).click();
  const apiWeight = page.getByRole("slider", { name: "APIs weight" });
  await expect(apiWeight).toHaveValue("0.6");
  await apiWeight.press("End");
  await expect(apiWeight).toHaveValue("1");

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => snapshotRequests).toBe(2);
  await expect(jobDescription).toHaveValue(privateDraft);
  await expect(apiWeight).toHaveValue("1");
  const cached = await page.evaluate(() => localStorage.getItem("engineeringLearningRoute.v1"));
  expect(cached).not.toContain(privateDraft);
});

test("a direct quiz save waits for the stale startup snapshot and then replays from the durable outbox", async ({ page }) => {
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  let snapshotRequests = 0;
  let quizWrites = 0;
  await mockInitialBrowserApis(page);
  await page.route("**/api/progress", async (route) => {
    snapshotRequests += 1;
    await snapshotGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        topics: [],
        quizAttempts: [{ lessonId: "apis", correct: 1, total: 3 }],
        missions: [],
      }),
    });
  });
  await page.route("**/api/progress/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/progress/quiz-attempts") quizWrites += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/");
  await expect.poll(() => snapshotRequests).toBe(1);
  await openRouteTopic(page, "apis", "Open APIs");
  await page.getByRole("button", { name: "Start quiz" }).click();
  await completeCurrentQuizWithCorrectBAnswers(page);
  await expect.poll(async () => page.evaluate(() => JSON.parse(
    localStorage.getItem("engineeringLearningRoute.v1"),
  ).quizAttempts.apis)).toEqual({ correct: 3, total: 3 });

  releaseSnapshot();

  await expect.poll(async () => page.evaluate(() => JSON.parse(
    localStorage.getItem("engineeringLearningRoute.v1"),
  ).quizAttempts.apis)).toEqual({ correct: 3, total: 3 });
  await expect.poll(() => quizWrites).toBe(1);
  await expect.poll(async () => page.evaluate(() => (
    JSON.parse(localStorage.getItem("engineeringLearningRoute.v1")).pendingProgress?.length ?? 0
  ))).toBe(0);
  expect(snapshotRequests).toBe(1);
});

test("a progress record queued during an active replay is sent by the next durable sync pass", async ({ page }) => {
  const pendingApisTopic = {
    kind: "topicProgress",
    payload: { topicId: "apis", status: "explored" },
  };
  await page.addInitScript((record) => {
    localStorage.setItem("engineeringLearningRoute.v1", JSON.stringify({ pendingProgress: [record] }));
  }, pendingApisTopic);

  let snapshotRequests = 0;
  let apiReplayStarted = false;
  let releaseApiReplay;
  const apiReplayGate = new Promise((resolve) => {
    releaseApiReplay = resolve;
  });
  const writePaths = [];
  await mockInitialBrowserApis(page);
  await page.route("**/api/progress", async (route) => {
    snapshotRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ topics: [], quizAttempts: [], missions: [] }),
    });
  });
  await page.route("**/api/progress/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    writePaths.push(path);
    if (path === "/api/progress/topic/apis") {
      apiReplayStarted = true;
      await apiReplayGate;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/");
  await expect.poll(() => apiReplayStarted).toBe(true);

  await openRouteTopic(page, "sql", "Open SQL");
  await expect.poll(async () => page.evaluate(() => JSON.parse(
    localStorage.getItem("engineeringLearningRoute.v1"),
  ).pendingProgress?.some((record) => (
    record.kind === "topicProgress" && record.payload.topicId === "sql"
  )))).toBe(true);
  expect(writePaths).toEqual(["/api/progress/topic/apis"]);

  releaseApiReplay();

  await expect.poll(() => writePaths).toEqual([
    "/api/progress/topic/apis",
    "/api/progress/topic/sql",
  ]);
  await expect.poll(async () => page.evaluate(() => (
    JSON.parse(localStorage.getItem("engineeringLearningRoute.v1")).pendingProgress?.length ?? 0
  ))).toBe(0);
  expect(snapshotRequests).toBe(1);
});
