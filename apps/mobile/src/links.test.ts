import {
  computerForTeam,
  parseTeamNoticeLink,
  routeComputerLink,
  routePairingLink,
  routeSetupCode,
} from "./links.js";
import {
  buildMobilePairingDeepLink,
  buildMobileThreadDeepLink,
  DeploymentIdSchema,
  mobileDeepLinkScheme,
  opensteerDesktopClient,
  opensteerMobileAccountOAuthCallback,
  opensteerMobileClient,
  opensteerMobileHostOAuthCallback,
  RequestIdSchema,
  TeamChannelIdSchema,
  TeamNoticeIdSchema,
  teamPageAppLink,
  ThreadIdSchema,
} from "@opensteer/core";
import { readTeamLinkIntent } from "./team/mobile-teams.js";
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

describe("team links", () => {
  const origin = "https://chat.acme.example";
  const teamId = DeploymentIdSchema.parse("dep_0192f4a1-5555-4000-8000-000000000005");
  const channelId = TeamChannelIdSchema.parse("tch_0192f4a1-6666-4000-8000-000000000006");
  const noticeId = TeamNoticeIdSchema.parse("tnt_0192f4a1-7777-4000-8000-000000000007");
  const invite = {
    origin,
    target: {
      kind: "invite" as const,
      selector: "S".repeat(32),
      // The verifier is the secret half; it rides in the page URL's fragment.
      verifier: "v_Q-".repeat(8),
    },
  };
  const handoff = (page: Parameters<typeof teamPageAppLink>[0]) => teamPageAppLink(page, "mobile");

  it("takes a first invite to the join sheet with its verifier intact, before knowing the team", () => {
    // No Deployment this phone knows is the team: joining is what the link is for.
    const outcome = resolveApplicationLink(handoff(invite), []);
    expect(outcome).toEqual({
      kind: "team",
      origin,
      page: `${origin}/invite/${"S".repeat(32)}#${"v_Q-".repeat(8)}`,
    });
    if (outcome.kind !== "team") throw new Error("Not a team link");
    expect(readTeamLinkIntent(outcome.page)).toEqual({
      kind: "invite",
      origin,
      selector: invite.target.selector,
      verifier: invite.target.verifier,
    });
  });

  it("refuses a handoff whose own fragment could carry or replace the verifier", () => {
    expect(resolveApplicationLink(`${handoff(invite)}#${"x".repeat(32)}`, [])).toEqual({
      kind: "ignore",
    });
    // A page that lost its fragment on the way is no invite at all.
    const stripped = `${mobileDeepLinkScheme}:/team?${new URLSearchParams({
      url: `${origin}/invite/${"S".repeat(32)}`,
    })}`;
    expect(resolveApplicationLink(stripped, [deploymentId])).toEqual({ kind: "ignore" });
  });

  it("opens a channel, and a message at its place, only as pages to look up on the team", () => {
    const messageId = "42";
    const message = handoff({ origin, target: { kind: "message", channelId, messageId } as never });
    const outcome = resolveApplicationLink(message, []);
    expect(outcome).toEqual({ kind: "team", origin, page: `${origin}/c/${channelId}/m/42` });
    if (outcome.kind !== "team") throw new Error("Not a team link");
    expect(readTeamLinkIntent(outcome.page)).toEqual({
      kind: "open",
      origin,
      channelId,
      messageId: "42",
    });
    expect(readTeamLinkIntent(`${origin}/c/${channelId}`)).toEqual({
      kind: "open",
      origin,
      channelId,
      messageId: null,
    });
  });

  it("ignores a team page meant for another app, a bare web page and an unencrypted team", () => {
    expect(resolveApplicationLink(teamPageAppLink(invite, "desktop"), [])).toEqual({
      kind: "ignore",
    });
    expect(resolveApplicationLink(`${origin}/c/${channelId}`, [])).toEqual({ kind: "ignore" });
    const plain = `${mobileDeepLinkScheme}:/team?${new URLSearchParams({
      url: `http://chat.acme.example/c/${channelId}`,
    })}`;
    expect(resolveApplicationLink(plain, [])).toEqual({ kind: "ignore" });
    expect(readTeamLinkIntent(`http://chat.acme.example/c/${channelId}`)).toBeNull();
  });

  it("leaves the sign-in callbacks to the authorization broker, even shaped like a team link", () => {
    for (const callback of [
      `${opensteerMobileHostOAuthCallback}?code=c&state=s&iss=${encodeURIComponent(origin)}`,
      `${opensteerMobileAccountOAuthCallback}?code=c&state=s`,
      `${opensteerMobileHostOAuthCallback}?url=${encodeURIComponent(`${origin}/c/${channelId}`)}`,
    ])
      expect(resolveApplicationLink(callback, [deploymentId])).toEqual({ kind: "ignore" });
  });

  it("reads a team notice's link and nothing that strays from it", () => {
    const notice = `${mobileDeepLinkScheme}:/team-notice?${new URLSearchParams({
      origin,
      teamId,
      noticeId,
    })}`;
    expect(resolveApplicationLink(notice, [])).toEqual({
      kind: "team-notice",
      origin,
      teamId,
      noticeId,
    });
    for (const stray of [
      `${notice}&extra=1`,
      `${notice}#x`,
      notice.replace(encodeURIComponent(origin), encodeURIComponent("http://chat.acme.example")),
      notice.replace(`${mobileDeepLinkScheme}:`, `${opensteerDesktopClient.applicationId}:`),
    ])
      expect(parseTeamNoticeLink(stray)).toBeNull();
  });

  it("carries a team-link code from a team's page to the reader's own Opensteer", () => {
    const code = "c".repeat(43);
    const text = `${origin}/agent-link#${new URLSearchParams({ teamId, fingerprint: "fp", code })}`;
    expect(readTeamLinkIntent(` ${text}\n`)).toEqual({ kind: "agent-link", origin, text });
  });

  it("shows a team link on a computer that is in the team, staying on the one in front when it is", () => {
    const mini = "dep_mini";
    const laptop = "dep_laptop";
    expect(computerForTeam({ shown: laptop, computersInTeam: [mini, laptop] })).toBeNull();
    expect(computerForTeam({ shown: laptop, computersInTeam: [mini] })).toBe(mini);
    expect(computerForTeam({ shown: null, computersInTeam: [mini] })).toBe(mini);
    // A team none of this person's computers is known to be in: join from the one in front.
    expect(computerForTeam({ shown: laptop, computersInTeam: [] })).toBeNull();
  });
});
