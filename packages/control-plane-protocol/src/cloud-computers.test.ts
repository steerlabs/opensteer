import { describe, expect, it } from "vitest";
import {
  CloudComputerBootRequestSchema,
  CloudComputerBootCompleteRequestSchema,
  CloudComputerDeleteRequestSchema,
  CloudComputerDesiredResponseSchema,
  CloudComputerIdSchema,
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
  region: "ash",
  serverType: "cpx22",
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
