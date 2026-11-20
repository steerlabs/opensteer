import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { quote, redact } from "./verify-home-deployment-support.mjs";

test("Colima test input keeps whitespace, quotes and shell metacharacters literal", () => {
  const value = "'a b' `printf substituted` $(printf substituted)\n--arg";
  const output = execFileSync("bash", ["-c", `printf '%s' ${quote(value)}`], { encoding: "utf8" });
  assert.equal(output, value);
});

test("diagnostics redact setup tokens and preserve other error text", () => {
  assert.equal(
    redact("First: https://home.example/setup#token=a.B_c-d\nsecond: 401"),
    "First: https://home.example/setup#token=[redacted]\nsecond: 401",
  );
});
