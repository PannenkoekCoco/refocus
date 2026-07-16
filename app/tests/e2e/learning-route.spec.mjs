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

  await expect(page.getByText("Quiz complete: 3/3.")).toBeVisible();
  await page.getByRole("button", { name: "Back to learning route" }).click();
  await expect(page.getByText("Quiz complete: 3/3.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Unpin Retrieval-augmented generation" })).toBeVisible();
  await expect(page.getByText("Quiz complete: 3/3.")).toBeVisible();
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
