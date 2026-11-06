import { expect, it } from "vitest";
import { reportEmail } from "./report.js";
it("builds a report from identifiers and app metadata without conversation content", () => {
  const source = {
    kind: "reply" as const,
    id: "msg_123",
    version: "0.1.488",
    platform: "ios",
    body: "private conversation",
    prompt: "private prompt",
    attachment: "private file",
    url: "https://host.test/?token=secret",
  };
  const report = reportEmail(source);
  expect(report.body).toContain("msg_123");
  expect(report.body).toContain("0.1.488");
  expect(report.body).toContain("ios");
  expect(JSON.stringify(report)).not.toMatch(/private|token=secret|host.test/);
});
