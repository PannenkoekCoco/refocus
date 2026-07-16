import assert from "node:assert/strict";
import test from "node:test";

import { pythonHttpServerCommand } from "../../playwright.config.mjs";

test("the browser test server uses the platform's supported Python launcher", () => {
  assert.equal(
    pythonHttpServerCommand("win32"),
    "py -3 -m http.server 4173 --bind 127.0.0.1",
  );
  assert.equal(
    pythonHttpServerCommand("linux"),
    "python -m http.server 4173 --bind 127.0.0.1",
  );
});
