import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export function pythonHttpServerCommand(platform = process.platform) {
  const launcher = platform === "win32" ? "py -3" : "python";
  return `${launcher} -m http.server 4173 --bind 127.0.0.1`;
}

export default defineConfig({
  testDir: "./app/tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173/app/static/",
    trace: "retain-on-failure",
  },
  webServer: {
    command: pythonHttpServerCommand(),
    cwd: appRoot,
    url: "http://127.0.0.1:4173/app/static/",
    reuseExistingServer: !process.env.CI,
  },
});
