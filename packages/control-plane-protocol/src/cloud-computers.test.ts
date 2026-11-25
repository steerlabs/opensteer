import { describe, expect, it } from "vitest";
import {
  cloudComputerReleaseFeedPath,
  CloudComputerReleaseFeedResponseSchema,
  BrowserPoolNetworkCidrSchema,
  CloudComputerBrowserPoolNetworkSchema,
  CloudComputerLeaseSchema,
  CloudComputerBootRequestSchema,
  CloudComputerBootCompleteRequestSchema,
  CloudComputerDeleteRequestSchema,
  CloudComputerDesiredResponseSchema,
  CloudComputerIdSchema,
  CloudComputerEgressResponseSchema,
  CloudComputerReleaseManifestUrlSchema,
  cloudComputerEgressPath,
  CloudComputerViewSchema,
  cloudComputerDeleteConfirmation,
  CloudComputerDesiredSchema,
  CloudComputerReportResponseSchema,
  CloudComputerReportSchema,
  cloudComputerStatusPath,
  cloudComputersDesiredPath,
} from "./cloud-computers.js";

const desired = {
  id: "cc_00000000-0000-4000-8000-000000000001",
  hostname: "home-1.example.com",
  generation: 1,
  revision: 1,
  state: "active",
  region: "us-central1-a",
  serverType: "e2-standard-4",
  release: {
    version: "1.0.0",
    installerUrl: "https://releases.example.com/install.sh",
    installerSha256: "a".repeat(64),
  },
  bootstrapToken: "short_lived",
};
const identity = {
  deploymentId: "dep_00000000-0000-4000-8000-000000000001",
  hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
};
const report = {
  id: desired.id,
  generation: 1,
  revision: 1,
  phase: "ready",
  providerServerId: 27,
  ipv4: "192.0.2.42",
  ipv6: "2001:db8::1",
  observedIdentity: identity,
  lastError: null,
};

describe("Cloud Computer provisioner wire contract", () => {
  it("round trips desired state and a ready report", () => {
    const list = CloudComputerDesiredResponseSchema.parse({ computers: [desired] });
    expect(list.computers).toEqual([desired]);
    expect(CloudComputerReportSchema.parse(report)).toEqual(report);
    expect(cloudComputersDesiredPath).toBe("/v1/cloud-computers/desired");
    expect(cloudComputerStatusPath(list.computers[0]!.id)).toBe(
      `/v1/cloud-computers/${desired.id}/status`,
    );
    expect(CloudComputerReportResponseSchema.safeParse({ recorded: true }).success).toBe(true);
  });

  it("accepts a tokenless generation with defaults and a persisted identity", () => {
    const { bootstrapToken: _, ...tokenless } = desired;
    const computer = { ...tokenless, region: null, serverType: null, observedIdentity: identity };
    expect(CloudComputerDesiredSchema.parse(computer)).toEqual(computer);
  });

  it.each([
    { generation: 0 },
    { hostname: "home.example.com/surprise" },
    { state: "suspended" },
    { state: "deleted" },
    {
      release: {
        ...desired.release,
        installerUrl: "https://example.com/install?credential=secret",
      },
    },
    { release: { ...desired.release, installerSha256: "unverified" } },
  ])("rejects invalid desired state %o", (patch) => {
    expect(CloudComputerDesiredSchema.safeParse({ ...desired, ...patch }).success).toBe(false);
  });

  it("rejects ownership collisions in the list", () => {
    expect(
      CloudComputerDesiredResponseSchema.safeParse({ computers: [desired, desired] }).success,
    ).toBe(false);
    expect(
      CloudComputerDesiredResponseSchema.safeParse({
        computers: [
          desired,
          {
            ...desired,
            id: "cc_00000000-0000-4000-8000-000000000002",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates identity, error and tombstone invariants", () => {
    expect(CloudComputerReportSchema.safeParse({ ...report, observedIdentity: null }).success).toBe(
      false,
    );
    expect(CloudComputerReportSchema.safeParse({ ...report, ipv6: "2001:db8::/64" }).success).toBe(
      false,
    );
    expect(CloudComputerReportSchema.safeParse({ ...report, phase: "deleted" }).success).toBe(
      false,
    );
    expect(
      CloudComputerReportSchema.safeParse({
        ...report,
        phase: "failed",
        lastError: "arbitrary upstream message",
      }).success,
    ).toBe(false);
    expect(
      CloudComputerReportSchema.safeParse({
        ...report,
        phase: "deleted",
        providerServerId: null,
        ipv4: null,
        ipv6: null,
        observedIdentity: null,
      }).success,
    ).toBe(true);
  });
});

it("validates boot inputs and keeps installation secrets off Account views", () => {
  expect(
    CloudComputerBootRequestSchema.safeParse({ hostname: desired.hostname, bootstrapToken: "abc" })
      .success,
  ).toBe(true);
  expect(
    CloudComputerBootRequestSchema.safeParse({
      hostname: desired.hostname,
      bootstrapToken: "abc",
      setupCode: "leak",
    }).success,
  ).toBe(false);
  const id = CloudComputerIdSchema.parse(desired.id);
  expect(
    CloudComputerDeleteRequestSchema.parse({ confirmation: cloudComputerDeleteConfirmation(id) }),
  ).toEqual({ confirmation: `DELETE:${id}` });
  expect(
    CloudComputerViewSchema.safeParse({ id, status: "ready", egress: "assigned" }).success,
  ).toBe(false);
  expect(
    CloudComputerViewSchema.parse({
      id,
      status: "ready",
      egress: "assigned",
      address: "https://home.example.com",
      setupCode: "leak",
    }),
  ).not.toHaveProperty("setupCode");
});

it("requires a revision on reports and validates a boot-complete identity", () => {
  expect(CloudComputerReportSchema.safeParse({ ...report, revision: undefined }).success).toBe(
    false,
  );
  expect(CloudComputerReportResponseSchema.parse({ recorded: false })).toEqual({ recorded: false });
  const body = { hostname: desired.hostname, bootstrapToken: "issued_token", identity };
  expect(CloudComputerBootCompleteRequestSchema.parse(body)).toEqual(body);
  expect(
    CloudComputerBootCompleteRequestSchema.safeParse({ ...body, identity: undefined }).success,
  ).toBe(false);
});

describe("Cloud Computer view facts", () => {
  const preparing = { id: desired.id, status: "preparing", egress: "assigned" };

  it("preserves older responses and round trips known facts", () => {
    expect(CloudComputerViewSchema.parse(preparing)).toEqual(preparing);
    const current = {
      ...preparing,
      deploymentId: identity.deploymentId,
      region: { id: "us-central1-a", label: "Council Bluffs, IA" },
      egressAddress: "2001:db8::7",
      renewsAt: "2027-01-15T00:00:00.000Z",
      steps: [{ id: "claim", state: "current" }],
    };
    expect(CloudComputerViewSchema.parse(current)).toEqual(current);
    const suspended = {
      ...preparing,
      status: "suspended",
      reason: "Your subscription needs attention.",
      reasonCode: "cloud-computer-billing-problem",
    };
    expect(CloudComputerViewSchema.parse(suspended)).toEqual(suspended);
  });

  it.each([
    { region: { id: "us-central1-a", label: "" } },
    { egressAddress: "gateway.example.test" },
    { renewsAt: null },
    { deploymentId: "unknown" },
    { steps: [{ id: "backup", state: "current" }] },
  ])("rejects placeholder or unsupported facts %o", (fields) => {
    expect(CloudComputerViewSchema.safeParse({ ...preparing, ...fields }).success).toBe(false);
  });
});

it("accepts only a credential-free HTTPS update feed and the egress-only refresh response", () => {
  expect(
    CloudComputerReleaseManifestUrlSchema.parse("https://releases.example.com/managed.json"),
  ).toBe("https://releases.example.com/managed.json");
  for (const url of [
    "http://releases.example.com/feed",
    "https://secret@releases.example.com/feed",
    "https://releases.example.com/feed?token=secret",
    "https://releases.example.com/feed#secret",
    "https://releases.example.com/feed\n",
  ])
    expect(CloudComputerReleaseManifestUrlSchema.safeParse(url).success).toBe(false);
  const id = CloudComputerIdSchema.parse(desired.id);
  expect(cloudComputerEgressPath(id)).toBe(`/v1/cloud-computers/${id}/egress`);
  expect(CloudComputerEgressResponseSchema.parse({})).toEqual({});
  expect(
    CloudComputerEgressResponseSchema.safeParse({ backup: { password: "secret" } }).success,
  ).toBe(false);
});

it("accepts only a private IPv4 network, at its own address, as the pool network a Home may reach", () => {
  for (const cidr of [
    "10.128.0.0/20",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "172.31.4.0/24",
    "192.168.1.0/24",
    "10.1.2.3/32",
  ])
    expect(BrowserPoolNetworkCidrSchema.safeParse(cidr).success, cidr).toBe(true);
  for (const cidr of [
    "0.0.0.0/0", // everything
    "10.0.0.0/7", // wider than a private range
    "172.0.0.0/8",
    "192.168.0.0/15",
    "8.8.8.0/24", // public
    "10.128.0.1/20", // not the network's own address
    "10.128.0.0/33",
    "10.128.0.0",
    "10.256.0.0/16",
    "010.1.0.0/16",
    " 10.1.0.0/16",
    "10.1.0.0/16\n",
  ])
    expect(BrowserPoolNetworkCidrSchema.safeParse(cidr).success, cidr).toBe(false);
  expect(
    CloudComputerBrowserPoolNetworkSchema.parse({
      cidr: "10.128.0.0/20",
      agentPort: 7310,
      relayPort: 7312,
    }),
  ).toEqual({ cidr: "10.128.0.0/20", agentPort: 7310, relayPort: 7312 });
  for (const ports of [
    { agentPort: 0, relayPort: 7312 },
    { agentPort: 7310, relayPort: 65_536 },
    { agentPort: 7310, relayPort: 7310 },
    { agentPort: 7310.5, relayPort: 7312 },
  ])
    expect(
      CloudComputerBrowserPoolNetworkSchema.safeParse({ cidr: "10.128.0.0/20", ...ports }).success,
    ).toBe(false);
  expect(
    CloudComputerLeaseSchema.safeParse({ holder: crypto.randomUUID(), poolNetwork: "8.8.8.0/24" })
      .success,
  ).toBe(false);
});

it("names a Home's release feed route and answers only an allowed feed address", () => {
  const id = CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000001");
  expect(cloudComputerReleaseFeedPath(id)).toBe(`/v1/cloud-computers/${id}/release-feed`);
  expect(
    CloudComputerReleaseFeedResponseSchema.parse({
      releaseManifestUrl: "https://releases.example.test/managed/stable.json",
    }),
  ).toEqual({ releaseManifestUrl: "https://releases.example.test/managed/stable.json" });
  for (const releaseManifestUrl of ["http://releases.example.test/x", "https://a.test/x?y=1"])
    expect(CloudComputerReleaseFeedResponseSchema.safeParse({ releaseManifestUrl }).success).toBe(
      false,
    ); // The recipe for the account's release: its installer and SHA-256, from the account's config.
  const releaseManifestUrl = "https://releases.example.test/managed/stable.json";
  const recipe = { url: "https://releases.example.test/home.sh", sha256: "a".repeat(64) };
  expect(CloudComputerReleaseFeedResponseSchema.parse({ releaseManifestUrl, recipe })).toEqual({
    releaseManifestUrl,
    recipe,
  });
  for (const bad of [
    { ...recipe, sha256: "A".repeat(64) },
    { ...recipe, url: "http://releases.example.test/home.sh" },
    { url: recipe.url },
  ])
    expect(
      CloudComputerReleaseFeedResponseSchema.safeParse({ releaseManifestUrl, recipe: bad }).success,
    ).toBe(false);
});
