import { expect, it } from "vitest";
import { redactUrlCredentials } from "./safeMessage.js";

it("removes a proxy address's user and password and keeps the rest", () => {
  const text =
    "connect ECONNREFUSED via http://person:hunter2-proxy-secret@proxy.example.test:8080 and https://token-only@proxy.test/";
  const redacted = redactUrlCredentials(text);
  expect(redacted).not.toContain("hunter2-proxy-secret");
  expect(redacted).not.toContain("person:");
  expect(redacted).not.toContain("token-only");
  expect(redacted).toBe(
    "connect ECONNREFUSED via http://[REDACTED]@proxy.example.test:8080 and https://[REDACTED]@proxy.test/",
  );
  expect(redactUrlCredentials("https://example.test/path?a=b")).toBe(
    "https://example.test/path?a=b",
  );
});
