import { describe, expect, it } from "vitest";
import {
  buildMobilePairingDeepLink,
  buildMobileThreadDeepLink,
  parseMobileOpenDeepLink,
  parseMobilePairingDeepLink,
  parseMobileSetupCode,
  parseMobileThreadDeepLink,
} from "./deep-links.js";
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

describe("mobile computer links", () => {
  it("accepts only a Deployment destination", () => {
    expect(parseMobileOpenDeepLink(`com.opensteer.mobile:/open?d=${deploymentId}`)).toEqual({
      deploymentId,
    });
  });
  it.each([
    `com.opensteer.mobile://host/open?d=${deploymentId}`,
    `com.opensteer.mobile://user@host/open?d=${deploymentId}`,
    `com.opensteer.mobile:/open?d=${deploymentId}#x`,
    `com.opensteer.mobile:/open?d=${deploymentId}#`,
    `com.opensteer.mobile:/open?d=${deploymentId}&d=${deploymentId}`,
    `com.opensteer.mobile:/open?d=${deploymentId}&host=https://evil.example`,
    "com.opensteer.mobile:/open?d=invalid",
    "com.opensteer.mobile:/open",
    `https://example.com/open?d=${deploymentId}`,
  ])("rejects %s", (url) => expect(parseMobileOpenDeepLink(url)).toBeNull());
});

describe("mobile pairing links", () => {
  const code = `osp_${"a".repeat(43)}`;
  const origin = "https://mac.tail2f9.ts.net";

  it("round-trips an address and a one-time code", () => {
    const link = buildMobilePairingDeepLink({ code, origin: `${origin}/` });

    expect(parseMobilePairingDeepLink(link)).toEqual({ code, origin });
    expect(parseMobileSetupCode(link, null)).toEqual({ code, kind: "pair", origin });
  });

  it.each([
    ["plain HTTP", { code, origin: "http://mac.tail2f9.ts.net" }],
    ["a path", { code, origin: `${origin}/app` }],
    ["a malformed code", { code: "osp_short", origin }],
  ])("refuses to build one with %s", (_label, link) => {
    expect(() => buildMobilePairingDeepLink(link)).toThrow(TypeError);
  });

  it.each([
    `com.opensteer.mobile:/pair?o=${encodeURIComponent(origin)}`,
    `com.opensteer.mobile:/pair?o=${encodeURIComponent(origin)}&c=${code}#x`,
    `com.opensteer.mobile:/pair?o=${encodeURIComponent(origin)}&c=${code}&d=extra`,
    `com.opensteer.mobile:/pair?o=${encodeURIComponent("http://mac.local")}&c=${code}`,
    `com.opensteer.mobile://host/pair?o=${encodeURIComponent(origin)}&c=${code}`,
  ])("rejects %s", (url) => expect(parseMobilePairingDeepLink(url)).toBeNull());
});

describe("codes scanned from a computer", () => {
  const portal = "https://opensteer.example";

  it("reads the Connect code only from the trusted portal", () => {
    const scanned = `${portal}/open#d=${encodeURIComponent(deploymentId)}`;

    expect(parseMobileSetupCode(scanned, portal)).toEqual({ deploymentId, kind: "open" });
    expect(parseMobileSetupCode(scanned, "https://other.example")).toBeNull();
    expect(parseMobileSetupCode(scanned, null)).toBeNull();
  });

  it.each([
    `https://opensteer.example/open?d=${deploymentId}`,
    `https://opensteer.example/elsewhere#d=${deploymentId}`,
    "https://opensteer.example/open#d=invalid",
    "a grocery list",
  ])("is not an Opensteer code: %s", (value) => {
    expect(parseMobileSetupCode(value, portal)).toBeNull();
  });
});
