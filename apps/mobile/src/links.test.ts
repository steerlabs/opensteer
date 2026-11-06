import { routeComputerLink } from "./links.js";
import {
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
