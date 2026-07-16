import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  loadLesson,
  loadTopics,
  validateTopics,
} from "../static/js/content/loader.js";

test("the route exposes every user-selected engineering topic exactly once", () => {
  const payload = JSON.parse(readFileSync(new URL("../../content/topics.json", import.meta.url), "utf8"));
  const topics = validateTopics(payload.topics);

  assert.equal(topics.length, 14);
});

test("loadTopics fetches and validates the versioned topic document", async () => {
  const payload = JSON.parse(readFileSync(new URL("../../content/topics.json", import.meta.url), "utf8"));
  let requestedUrl;

  const topics = await loadTopics(async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => payload,
    };
  });

  assert.match(String(requestedUrl), /content\/topics\.json$/);
  assert.equal(topics.length, 14);
});

test("loadLesson fetches the selected static lesson pack", async () => {
  const lesson = {
    topicId: "apis",
    title: "APIs",
    speechText: "APIs.",
    sections: [],
    questions: [],
    starterAction: {},
  };
  let requestedUrl;

  const result = await loadLesson("apis", async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => lesson,
    };
  });

  assert.match(String(requestedUrl), /content\/lessons\/apis\.json$/);
  assert.deepEqual(result, lesson);
});

test("loadLesson rejects a path-like topic identifier before fetching content", async () => {
  let fetched = false;

  await assert.rejects(
    () => loadLesson("../topics", async () => {
      fetched = true;
      return {
        ok: true,
        json: async () => ({}),
      };
    }),
    /Invalid lesson topic: \.\.\/topics/,
  );

  assert.equal(fetched, false);
});

test("validateTopics rejects an incomplete selectable route", () => {
  assert.throws(
    () => validateTopics([]),
    /Route topics must contain each required topic exactly once\./,
  );
});
