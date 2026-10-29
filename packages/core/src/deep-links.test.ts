import { describe, expect, it } from "vitest";
import { buildMobileThreadDeepLink, parseMobileThreadDeepLink } from "./deep-links.js";
import { createId } from "./ids.js";

const deploymentId = createId("deployment");
const threadId = createId("thread");
const requestId = createId("request");

describe("mobile thread deep links", () => {
  it("round-trips a Request destination", () => {
    const link = buildMobileThreadDeepLink({ deploymentId, requestId, threadId });

    expect(link).toBe(
      `com.opensteer.mobile:/deployments/${deploymentId}/threads/${threadId}?requestId=${requestId}`,
    );
    expect(parseMobileThreadDeepLink(link)).toEqual({ deploymentId, requestId, threadId });
  });

  it("round-trips a Run outcome without a Request", () => {
    const link = buildMobileThreadDeepLink({ deploymentId, requestId: null, threadId });

    expect(link).toBe(`com.opensteer.mobile:/deployments/${deploymentId}/threads/${threadId}`);
    expect(parseMobileThreadDeepLink(link)).toEqual({ deploymentId, requestId: null, threadId });
  });

  it.each([
    [
      "another application's scheme",
      `com.example.other:/deployments/${deploymentId}/threads/${threadId}`,
    ],
    [
      "an authority component",
      `com.opensteer.mobile://evil/deployments/${deploymentId}/threads/${threadId}`,
    ],
    [
      "an https origin",
      `https://opensteer.example/deployments/${deploymentId}/threads/${threadId}`,
    ],
    [
      "an unknown query parameter",
      `com.opensteer.mobile:/deployments/${deploymentId}/threads/${threadId}?host=https://evil.example`,
    ],
    [
      "a repeated Request id",
      `com.opensteer.mobile:/deployments/${deploymentId}/threads/${threadId}?requestId=${requestId}&requestId=${requestId}`,
    ],
    [
      "an unrecognised identifier shape",
      "com.opensteer.mobile:/deployments/not-a-deployment/threads/also-not",
    ],
    ["a truncated path", `com.opensteer.mobile:/deployments/${deploymentId}`],
    [
      "a deeper path",
      `com.opensteer.mobile:/deployments/${deploymentId}/threads/${threadId}/runs/x`,
    ],
    ["a fragment", `com.opensteer.mobile:/deployments/${deploymentId}/threads/${threadId}#approve`],
    ["nothing at all", ""],
  ])("refuses %s", (_label, value) => {
    expect(parseMobileThreadDeepLink(value)).toBeNull();
  });
});
