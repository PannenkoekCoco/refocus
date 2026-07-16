import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import config, {
  FAST_API_HEALTH_URL,
  FAST_API_ORIGIN,
  fastApiServerCommand,
} from "../../playwright.config.mjs";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

test("the browser test server uses a FastAPI command with a local Windows venv or configured Linux Python", () => {
  assert.equal(
    fastApiServerCommand({
      platform: "win32",
      appRoot: "C:\\Program Files\\Refocus\\ema-cram-app",
      env: {},
      pathExists: (candidate) => candidate.endsWith("\\backend\\.venv\\Scripts\\python.exe"),
    }),
    '"C:\\Program Files\\Refocus\\ema-cram-app\\backend\\.venv\\Scripts\\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log',
  );
  assert.equal(
    fastApiServerCommand({
      platform: "linux",
      appRoot: "/work/refocus/ema-cram-app",
      env: { REFOCUS_TEST_PYTHON: "/opt/refocus/python3" },
      pathExists: () => false,
    }),
    "'/opt/refocus/python3' -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log",
  );
  assert.equal(
    fastApiServerCommand({
      platform: "linux",
      appRoot: "/work/refocus/ema-cram-app",
      env: {},
      pathExists: () => false,
    }),
    "python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log",
  );
});

test("Playwright health-gates the same FastAPI entrypoint that learners use", () => {
  assert.equal(FAST_API_ORIGIN, "http://127.0.0.1:8000");
  assert.equal(FAST_API_HEALTH_URL, "http://127.0.0.1:8000/health");
  assert.equal(config.use.baseURL, `${FAST_API_ORIGIN}/`);
  assert.equal(config.webServer.url, FAST_API_HEALTH_URL);
  assert.match(config.webServer.cwd, /backend$/);
  assert.match(config.webServer.command, /uvicorn app\.main:app/);
  assert.match(config.webServer.command, /--no-access-log/);
});

test("the retired EMA launcher delegates to Refocus and release guidance names the supported health route", () => {
  const legacyLauncher = readFileSync(new URL("../../Launch EMA Cram Trainer.cmd", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .trim();
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const gitignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");

  assert.equal(legacyLauncher, '@echo off\ncall "%~dp0Launch Learning Companion.cmd"');
  assert.match(readme, /http:\/\/127\.0\.0\.1:8000\//);
  assert.match(readme, /GET \/health/);
  assert.match(readme, /optional local TTS/i);
  assert.doesNotMatch(readme, /existing EMA Cram Trainer/i);
  assert.match(gitignore, /^local-tts\/\*\.log$/m);
  assert.match(appRoot, /ema-cram-app[\\/]?$/);
});
