import { routeComputerLink, routePairingLink, routeSetupCode } from "./links.js";
import {
  buildMobilePairingDeepLink,
  buildMobileThreadDeepLink,
  DeploymentIdSchema,
  opensteerDesktopClient,
  opensteerMobileClient,
  opensteerMobileHostOAuthCallback,
  RequestIdSchema,
  ThreadIdSchema,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { agentConnectionDeepLink } from "@opensteer/protocol";
import { resolveApplicationLink } from "./links.js";

const deploymentId = DeploymentIdSchema.parse("dep_0192f4a1-1111-4000-8000-000000000001");
const otherDeploymentId = DeploymentIdSchema.parse("dep_0192f4a1-2222-4000-8000-000000000002");
const threadId = ThreadIdSchema.parse("thr_0192f4a1-3333-4000-8000-000000000003");
const requestId = RequestIdSchema.parse("req_0192f4a1-4444-4000-8000-000000000004");

function link(overrides: { readonly requestId?: typeof requestId } = {}): string {
  return buildMobileThreadDeepLink({
    deploymentId,
    requestId: overrides.requestId ?? null,
    threadId,
  });
}

describe("resolveApplicationLink", () => {
  it("opens a thread on a deployment this phone has", () => {
    expect(resolveApplicationLink(link(), [deploymentId])).toEqual({
      deploymentId,
      kind: "open",
      requestId: null,
      threadId,
    });
  });

  it("carries the request a notification is about", () => {
    expect(resolveApplicationLink(link({ requestId }), [deploymentId])).toEqual({
      deploymentId,
      kind: "open",
      requestId,
      threadId,
    });
  });

  it("says what to do about a deployment this phone has never been added to", () => {
    const outcome = resolveApplicationLink(link(), [otherDeploymentId]);

    expect(outcome.kind).toBe("unknown-deployment");
    expect(outcome.kind === "unknown-deployment" ? outcome.detail : "").toContain("Add it");
  });

  it.each([
    ["an OAuth callback the broker takes", `${opensteerMobileHostOAuthCallback}?code=abc`],
    [
      "another application's scheme",
      `com.example.other:/deployments/${deploymentId}/threads/${threadId}`,
    ],
    ["a web address", `https://opensteer.example/deployments/${deploymentId}/threads/${threadId}`],
    ["an unreadable identifier", "com.opensteer.mobile:/deployments/nope/threads/nope"],
    ["nonsense", "not a url at all"],
  ])("ignores %s", (_label, url) => {
    expect(resolveApplicationLink(url, [deploymentId])).toEqual({ kind: "ignore" });
  });
});

describe("agent connection links", () => {
  const agentRequestId = "a".repeat(43);
  const agentLink = agentConnectionDeepLink(opensteerMobileClient.applicationId, {
    deploymentId,
    requestId: agentRequestId,
  });

  it("opens the request for review on a deployment this phone has", () => {
    expect(resolveApplicationLink(agentLink, [deploymentId])).toEqual({
      deploymentId,
      kind: "authorize-agent",
      requestId: agentRequestId,
    });
  });

  it("says what to do about a deployment this phone has never been added to", () => {
    expect(resolveApplicationLink(agentLink, [otherDeploymentId]).kind).toBe("unknown-deployment");
  });

  it("ignores the desktop app's link", () => {
    const desktop = agentConnectionDeepLink(opensteerDesktopClient.applicationId, {
      deploymentId,
      requestId: agentRequestId,
    });
    expect(resolveApplicationLink(desktop, [deploymentId])).toEqual({ kind: "ignore" });
  });
});

describe("computer URL boundary", () => {
  it("routes an unknown computer before consulting the Thread catalog", () => {
    const selected: string[] = [];
    const id = "dep_0192f4a1-1111-4000-8000-000000000001";
    expect(
      routeComputerLink(`com.opensteer.mobile:/open?d=${id}`, (value) => selected.push(value)),
    ).toBe(true);
    expect(selected).toEqual([id]);
    expect(
      routeComputerLink("com.opensteer.mobile:/oauth/account?code=x", (value) =>
        selected.push(value),
      ),
    ).toBe(false);
    expect(selected).toEqual([id]);
  });
});

describe("codes a computer shows", () => {
  const portal = "https://app.opensteer.example";
  const pairing = { code: `osp_${"A1_-".repeat(10)}abc`, origin: "https://mac.tailnet.ts.net" };

  function route(text: string, portalOrigin: string | null = portal) {
    const opened: string[] = [];
    const offered: unknown[] = [];
    const routed = routeSetupCode(text, portalOrigin, {
      offer: (link) => offered.push(link),
      open: (id) => opened.push(id),
    });
    return { offered, opened, routed };
  }

  it("opens the computer a Connect code names, from the portal or the app's own link", () => {
    expect(route(`${portal}/open#d=${deploymentId}`)).toEqual({
      offered: [],
      opened: [deploymentId],
      routed: true,
    });
    expect(route(`com.opensteer.mobile:/open?d=${deploymentId}`, null).opened).toEqual([
      deploymentId,
    ]);
  });

  it("offers a pairing code for confirmation instead of pairing", () => {
    expect(route(buildMobilePairingDeepLink(pairing))).toEqual({
      offered: [pairing],
      opened: [],
      routed: true,
    });
  });

  it.each([
    ["another site's page", "https://example.com/menu"],
    [
      "a Connect code from a portal this build does not trust",
      `https://evil.example/open#d=${deploymentId}`,
    ],
    [
      "a pairing link over plain HTTP",
      `com.opensteer.mobile:/pair?o=http%3A%2F%2Fmac.local&c=${pairing.code}`,
    ],
    ["plain text", "hello"],
  ])("routes nothing for %s", (_label, text) => {
    expect(route(text)).toEqual({ offered: [], opened: [], routed: false });
  });

  it("takes an operating-system pairing link to the form and nothing else", () => {
    const offered: unknown[] = [];
    expect(
      routePairingLink(buildMobilePairingDeepLink(pairing), (link) => offered.push(link)),
    ).toBe(true);
    expect(routePairingLink(link(), (value) => offered.push(value))).toBe(false);
    expect(offered).toEqual([pairing]);
  });
});
