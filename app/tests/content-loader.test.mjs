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

test("loadTopics prefers the same-origin API response", async () => {
  const payload = JSON.parse(readFileSync(new URL("../../content/topics.json", import.meta.url), "utf8"));
  const requestedUrls = [];

  const topics = await loadTopics(async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      json: async () => payload,
    };
  });

  assert.deepEqual(requestedUrls, ["/api/content/topics"]);
  assert.equal(topics.length, 14);
});

test("loadTopics falls back to versioned static content when the API is unavailable", async () => {
  const payload = JSON.parse(readFileSync(new URL("../../content/topics.json", import.meta.url), "utf8"));
  const requestedUrls = [];

  const topics = await loadTopics(async (url) => {
    requestedUrls.push(String(url));
    if (url === "/api/content/topics") throw new TypeError("Failed to fetch");
    return {
      ok: true,
      json: async () => payload,
    };
  });

  assert.deepEqual(requestedUrls.slice(0, 1), ["/api/content/topics"]);
  assert.match(requestedUrls[1], /content\/topics\.json$/);
  assert.equal(topics.length, 14);
});

test("loadTopics falls back to static content after a non-OK API response", async () => {
  const payload = JSON.parse(readFileSync(new URL("../../content/topics.json", import.meta.url), "utf8"));
  const requestedUrls = [];

  const topics = await loadTopics(async (url) => {
    requestedUrls.push(String(url));
    if (url === "/api/content/topics") return { ok: false };
    return {
      ok: true,
      json: async () => payload,
    };
  });

  assert.deepEqual(requestedUrls.slice(0, 1), ["/api/content/topics"]);
  assert.match(requestedUrls[1], /content\/topics\.json$/);
  assert.equal(requestedUrls.length, 2);
  assert.equal(topics.length, 14);
});

test("loadLesson prefers the same-origin API response", async () => {
  const lesson = {
    topicId: "apis",
    title: "APIs",
    speechText: "APIs.",
    sections: [],
    questions: [],
    starterAction: {},
  };
  const requestedUrls = [];

  const result = await loadLesson("apis", async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      json: async () => lesson,
    };
  });

  assert.deepEqual(requestedUrls, ["/api/content/lessons/apis"]);
  assert.deepEqual(result, lesson);
});

test("loadLesson falls back to the selected static lesson pack when the API is unavailable", async () => {
  const lesson = {
    topicId: "apis",
    title: "APIs",
    speechText: "APIs.",
    sections: [],
    questions: [],
    starterAction: {},
  };
  const requestedUrls = [];

  const result = await loadLesson("apis", async (url) => {
    requestedUrls.push(String(url));
    if (url === "/api/content/lessons/apis") throw new TypeError("Failed to fetch");
    return {
      ok: true,
      json: async () => lesson,
    };
  });

  assert.deepEqual(requestedUrls.slice(0, 1), ["/api/content/lessons/apis"]);
  assert.match(requestedUrls[1], /content\/lessons\/apis\.json$/);
  assert.deepEqual(result, lesson);
});

test("loadLesson falls back to static content after a non-OK API response", async () => {
  const lesson = {
    topicId: "apis",
    title: "APIs",
    speechText: "APIs.",
    sections: [],
    questions: [],
    starterAction: {},
  };
  const requestedUrls = [];

  const result = await loadLesson("apis", async (url) => {
    requestedUrls.push(String(url));
    if (url === "/api/content/lessons/apis") return { ok: false };
    return {
      ok: true,
      json: async () => lesson,
    };
  });

  assert.deepEqual(requestedUrls.slice(0, 1), ["/api/content/lessons/apis"]);
  assert.match(requestedUrls[1], /content\/lessons\/apis\.json$/);
  assert.equal(requestedUrls.length, 2);
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
