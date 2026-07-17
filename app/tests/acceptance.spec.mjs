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

async function openRouteTopic(page, topicId, actionName) {
  const card = page.locator(`.topic-card[data-topic-id="${topicId}"]`);
  await card.getByRole("button", { name: actionName }).click();
}

async function completeCurrentQuizWithCorrectBAnswers(page) {
  for (let questionIndex = 0; questionIndex < 3; questionIndex += 1) {
    await page.getByRole("button", { name: /^B\./ }).click();
    if (questionIndex < 2) {
      await page.getByRole("button", { name: "Next question" }).click();
    }
  }
}

test("all fourteen topics stay free while an advanced pin remains recommended with advisory prerequisites", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.goto("/");

  const cards = page.locator(".topic-card");
  await expect(cards).toHaveCount(14);
  for (let index = 0; index < 14; index += 1) {
    const card = cards.nth(index);
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: /^(Open|Explore now)/ })).toBeEnabled();
  }

  const ragCard = page.locator('.topic-card[data-topic-id="retrieval-augmented-generation"]');
  await ragCard.getByRole("button", { name: "Pin Retrieval-augmented generation" }).click();

  await expect(page.locator(".recommendation-card")).toContainText("Retrieval-augmented generation");
  await expect(page.locator(".recommendation-card")).toContainText(
    "Advisory prerequisite: APIs, SQL. You can start here anytime.",
  );
  await expect(page.getByText("You pinned this topic.", { exact: true }).first()).toBeVisible();
  await expect(ragCard.getByRole("button", { name: "Unpin Retrieval-augmented generation" })).toBeFocused();
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
  await page.getByRole("button", { name: "Continue to mission" }).click();

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

test("keyboard focus, polite status, and the route grid work at mobile and desktop widths", async ({ page }) => {
  await mockInitialBrowserApis(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to learning route" })).toBeFocused();
  const ragCard = page.locator('.topic-card[data-topic-id="retrieval-augmented-generation"]');
  const pin = ragCard.getByRole("button", { name: "Pin Retrieval-augmented generation" });
  await pin.focus();
  await page.keyboard.press("Enter");
  await expect(ragCard.getByRole("button", { name: "Unpin Retrieval-augmented generation" })).toBeFocused();
  await expect(page.locator("#status-message")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#status-message")).toHaveText("Retrieval-augmented generation is pinned.");

  const mobileColumns = await page.locator(".route-list").evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(" ").length
  ));
  expect(mobileColumns).toBe(1);

  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopColumns = await page.locator(".route-list").evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(" ").length
  ));
  expect(desktopColumns).toBe(3);
});
