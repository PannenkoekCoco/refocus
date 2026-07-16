import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

export const FAST_API_ORIGIN = "http://127.0.0.1:8000";
export const FAST_API_HEALTH_URL = `${FAST_API_ORIGIN}/health`;

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const backendRoot = join(appRoot, "backend");

function joinForPlatform(platform, ...parts) {
  return platform === "win32" ? win32.join(...parts) : posix.join(...parts);
}

function quoteExecutable(value, platform) {
  return platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function configuredPython(env) {
  const value = env.REFOCUS_TEST_PYTHON;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function fastApiServerCommand({
  platform = process.platform,
  appRoot: root = appRoot,
  env = process.env,
  pathExists = existsSync,
} = {}) {
  const configured = configuredPython(env);
  let pythonCommand;
  if (configured) {
    pythonCommand = quoteExecutable(configured, platform);
  } else if (platform === "win32") {
    const localVenvPython = joinForPlatform(platform, root, "backend", ".venv", "Scripts", "python.exe");
    pythonCommand = pathExists(localVenvPython)
      ? quoteExecutable(localVenvPython, platform)
      : "py -3.12";
  } else {
    pythonCommand = "python3";
  }

  return `${pythonCommand} -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log`;
}

export default defineConfig({
  testDir: "./app/tests",
  testMatch: "**/*.spec.mjs",
  timeout: 30_000,
  use: {
    baseURL: `${FAST_API_ORIGIN}/`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: fastApiServerCommand({ appRoot }),
    cwd: backendRoot,
    url: FAST_API_HEALTH_URL,
    reuseExistingServer: !process.env.CI,
  },
});
