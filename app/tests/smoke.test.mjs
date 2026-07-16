import test from "node:test";
import assert from "node:assert/strict";

test("the engineering companion test runner is isolated from the root package", () => {
  assert.equal(process.env.npm_package_name, "refocus");
});
