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
