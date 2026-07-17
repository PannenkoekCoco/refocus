import { expect, test } from "@playwright/test";

test("a learner can pin RAG, complete an API quiz, and retain progress", async ({ page }) => {
  await page.goto("./");

  await page.getByRole("button", { name: "Pin Retrieval-augmented generation" }).click();
  await page.getByRole("button", { name: "Open APIs" }).click();
  await expect(page.getByText("You pinned this topic.")).toBeVisible();
  await page.getByRole("button", { name: "Start quiz" }).click();

  for (let questionIndex = 0; questionIndex < 3; questionIndex += 1) {
    await page.getByRole("button", { name: /^B\./ }).click();
    if (questionIndex < 2) {
      await page.getByRole("button", { name: "Next question" }).click();
    }
  }

  await expect(page.getByText("Correct.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "See results" })).toBeVisible();
  await expect(page.getByText("Saved locally; sign in or retry to sync.")).toBeVisible();
  await page.getByRole("button", { name: "See results" }).click();
  await expect(page.getByText("Quiz complete: 3/3.")).toBeVisible();
  await page.getByRole("button", { name: "Back to learning route" }).click();
  await expect(page.getByText("Quiz complete: 3/3.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Unpin Retrieval-augmented generation" })).toBeVisible();
  await expect(page.getByText("Quiz complete: 3/3.")).toBeVisible();
});

test("topic exploration syncs and quiz results wait for the attempted progress save", async ({ page }) => {
  const progressRequests = [];
  let releaseQuizSave;
  const quizSaveCanFinish = new Promise((resolve) => {
    releaseQuizSave = resolve;
  });

  await page.route("**/api/progress/**", async (route) => {
    const method = route.request().method();
    progressRequests.push(method);
    if (method === "PUT") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "00000000-0000-0000-0000-000000000001",
          topicId: "apis",
          status: "explored",
          updatedAt: "2026-07-16T00:00:00Z",
        }),
      });
      return;
    }

    await quizSaveCanFinish;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  await page.goto("./");
  await page.getByRole("button", { name: "Open APIs" }).click();
  await expect.poll(() => progressRequests).toContain("PUT");
  await page.getByRole("button", { name: "Start quiz" }).click();

  for (let questionIndex = 0; questionIndex < 3; questionIndex += 1) {
    await page.getByRole("button", { name: /^B\./ }).click();
    if (questionIndex < 2) {
      await page.getByRole("button", { name: "Next question" }).click();
    }
  }

  await page.getByRole("button", { name: "See results" }).click();
  await expect(page.getByRole("heading", { name: "Quiz complete: 3/3." })).not.toBeVisible();
  expect(progressRequests).toEqual(["PUT", "POST"]);

  releaseQuizSave();
  await expect(page.getByRole("heading", { name: "Quiz complete: 3/3." })).toBeVisible();
});

test("the live quiz renders its refreshed local recommendation only after progress persistence settles", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("engineeringLearningRoute.v1", JSON.stringify({
      quizAttempts: {
        "python-beyond-scripts": { correct: 3, total: 3 },
        "git-and-github": { correct: 3, total: 3 },
      },
    }));
  });

  let releaseQuizSave;
  const quizSaveCanFinish = new Promise((resolve) => {
    releaseQuizSave = resolve;
  });

  await page.route("**/api/progress/**", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "00000000-0000-0000-0000-000000000001",
          topicId: "apis",
          status: "explored",
          updatedAt: "2026-07-16T00:00:00Z",
        }),
      });
      return;
    }

    await quizSaveCanFinish;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  await page.goto("./");
  await expect(page.locator(".recommendation-card")).toContainText("APIs");
  await page.locator(".recommendation-card").getByRole("button", { name: "Open APIs" }).click();
  await page.getByRole("button", { name: "Start quiz" }).click();

  for (let questionIndex = 0; questionIndex < 3; questionIndex += 1) {
    await page.getByRole("button", { name: /^B\./ }).click();
    if (questionIndex < 2) {
      await page.getByRole("button", { name: "Next question" }).click();
    }
  }

  await page.getByRole("button", { name: "See results" }).click();
  await expect(page.getByText("Suggested next: Structured outputs and tool calling")).not.toBeVisible();

  releaseQuizSave();
  await expect(page.getByRole("heading", { name: "Quiz complete: 3/3." })).toBeVisible();
  await expect(page.getByText("Suggested next: Structured outputs and tool calling")).toBeVisible();
});

test("pinning keeps focus on the replacement pin control", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Pin Retrieval-augmented generation" }).click();

  await expect(page.getByRole("button", { name: "Unpin Retrieval-augmented generation" })).toBeFocused();
});

test("quiz feedback and results receive predictable focus", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Open APIs" }).click();
  await page.getByRole("button", { name: "Start quiz" }).click();

  await page.getByRole("button", { name: /^B\./ }).click();
  await expect(page.getByRole("region", { name: "Answer feedback" })).toBeFocused();
  await page.getByRole("button", { name: "Next question" }).click();
  await expect(page.getByRole("heading", {
    name: "Which response best represents a request for a resource that does not exist?",
  })).toBeFocused();

  await page.getByRole("button", { name: /^B\./ }).click();
  await page.getByRole("button", { name: "Next question" }).click();
  await page.getByRole("button", { name: /^B\./ }).click();
  await expect(page.getByRole("region", { name: "Answer feedback" })).toBeFocused();
  await page.getByRole("button", { name: "See results" }).click();
  await expect(page.getByRole("heading", { name: "Quiz complete: 3/3." })).toBeFocused();
});

test("unavailable browser storage is announced as session-only progress", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked");
      },
    });
  });
  await page.goto("./");
  await page.getByRole("button", { name: "Pin Retrieval-augmented generation" }).click();

  await expect(page.getByText(
    "Progress is available for this session only because it could not be saved locally.",
  )).toBeVisible();
});

test("a route transition focuses the lesson title instead of the whole app region", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Open APIs" }).click();

  await expect(page.getByRole("heading", { name: "APIs" })).toBeFocused();
});

test("the visible skip link does not cover the Refocus title", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("./");
  const skip = await page.getByRole("link", { name: "Skip to learning route" }).boundingBox();
  const title = await page.getByRole("heading", { name: "Refocus" }).boundingBox();

  expect(skip.y + skip.height).toBeLessThanOrEqual(title.y);
});

test("the initial route does not move focus before learner interaction", async ({ page }) => {
  await page.goto("./");

  await expect(page.getByRole("heading", { name: "Your flexible route" })).not.toBeFocused();
});

test("a learner can preview, edit, and locally apply a job lens when saving is unavailable", async ({ page }) => {
  await page.route("**/api/focus-lenses**", async (route) => {
    const method = route.request().method();
    const url = route.request().url();
    if (method === "POST" && url.endsWith("/preview")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          skills: [
            { topicId: "python-beyond-scripts", weight: 0.3 },
            { topicId: "apis", weight: 0.6 },
          ],
        }),
      });
      return;
    }
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.goto("./");
  const jobDescription = page.getByRole("textbox", { name: "Job description" });
  const rawText = "<img src=x onerror=alert(1)> Build an API";
  await jobDescription.fill(rawText);
  await page.getByRole("button", { name: "Preview skills" }).click();
  await expect(page.getByRole("slider", { name: "APIs weight" })).toHaveValue("0.6");
  await page.getByRole("slider", { name: "APIs weight" }).press("End");
  await page.getByRole("button", { name: "Apply to route" }).click();

  await expect(page.locator(".recommendation-card")).toContainText("APIs");
  await expect(page.getByText("Applied to your route. Sign in to save this focus lens.")).toBeVisible();
  await expect(page.locator("img")).toHaveCount(0);
  const cached = await page.evaluate(() => localStorage.getItem("engineeringLearningRoute.v1"));
  expect(cached).not.toContain(rawText);
});

test("owned saved lenses reload into editable controls without rendering learner text as markup", async ({ page }) => {
  const rawText = "<strong>Private role text</strong>";
  await page.route("**/api/focus-lenses", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({}) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        lenses: [{
          id: "00000000-0000-0000-0000-000000000001",
          kind: "job",
          originalText: rawText,
          skills: [{ topicId: "apis", weight: 1 }],
          isActive: true,
          createdAt: "2026-07-16T00:00:00Z",
          updatedAt: "2026-07-16T00:00:00Z",
        }],
      }),
    });
  });

  await page.goto("./");

  await expect(page.getByRole("textbox", { name: "Job description" })).toHaveValue(rawText);
  await expect(page.locator(".recommendation-card")).toContainText("APIs");
  await expect(page.locator("strong")).toHaveCount(0);
});

test("a learner can safely select an authorized GitHub repository and review verification feedback", async ({ page }) => {
  let selected = false;
  let verificationPayload = null;

  await page.route("**/api/github/installations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        installations: [{
          id: 7,
          accountLogin: "octo-org",
          repositories: [{
            id: 42,
            fullName: "octo-org/refocus",
            defaultBranch: "main",
            selected,
          }],
        }],
      }),
    });
  });
  await page.route("**/api/github/repositories/42", async (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postData()).toBeNull();
    selected = true;
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
    expect(route.request().method()).toBe("POST");
    verificationPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "needs_attention",
        evidence: ["Required files found"],
        reason: "<img src=x onerror=alert(1)> No matching pull request found for this mission.",
      }),
    });
  });

  await page.goto("./");
  await page.getByRole("button", { name: "Open APIs" }).click();
  await page.getByRole("button", { name: "Start quiz" }).click();
  for (let questionIndex = 0; questionIndex < 3; questionIndex += 1) {
    await page.getByRole("button", { name: /^B\./ }).click();
    if (questionIndex < 2) {
      await page.getByRole("button", { name: "Next question" }).click();
    }
  }
  await page.getByRole("button", { name: "See results" }).click();
  await page.getByRole("button", { name: "Ship a small API service" }).click();

  await expect(page.getByRole("heading", { name: "Optional GitHub verification" })).toBeVisible();
  for (const permission of [
    "Metadata — read",
    "Contents — read",
    "Pull requests — read",
    "Checks — read",
    "Commit statuses — read",
    "Only selected repositories",
    "No webhooks or write access",
  ]) {
    await expect(page.getByText(permission, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("textbox", { name: /repository (url|id)/i })).toHaveCount(0);

  const repository = page.getByRole("combobox", { name: "GitHub repository" });
  await expect(repository).toBeVisible();
  await repository.selectOption("42");
  await expect.poll(() => selected).toBe(true);
  await page.getByRole("button", { name: "Verify with GitHub" }).click();

  await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(page.getByText(
    "<img src=x onerror=alert(1)> No matching pull request found for this mission.",
    { exact: true },
  )).toBeVisible();
  await expect(page.locator("img")).toHaveCount(0);
  expect(verificationPayload).toEqual({});
});

test("GitHub verification guidance remains available to browser text to speech", async ({ page }) => {
  await page.addInitScript(() => {
    window.__githubNarration = [];
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        cancel() {},
        speak(utterance) {
          window.__githubNarration.push(utterance.text);
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
      if (String(input).startsWith("http://127.0.0.1:8767/tts")) {
        return Promise.reject(new TypeError("local TTS unavailable"));
      }
      return browserFetch(input, options);
    };
  });
  await page.route("**/api/github/installations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connected: false, installations: [] }),
    });
  });

  await page.goto("./");
  await page.getByRole("button", { name: "Open APIs" }).click();
  await page.getByRole("button", { name: "Start quiz" }).click();
  for (let questionIndex = 0; questionIndex < 3; questionIndex += 1) {
    await page.getByRole("button", { name: /^B\./ }).click();
    if (questionIndex < 2) {
      await page.getByRole("button", { name: "Next question" }).click();
    }
  }
  await page.getByRole("button", { name: "See results" }).click();
  await page.getByRole("button", { name: "Ship a small API service" }).click();

  await page.locator(".github-verification > .narrator").getByRole("button", { name: "Listen" }).click();
  await expect.poll(() => page.evaluate(() => (
    window.__githubNarration.some((text) => text.startsWith("GitHub verification is optional."))
  ))).toBe(true);
});
