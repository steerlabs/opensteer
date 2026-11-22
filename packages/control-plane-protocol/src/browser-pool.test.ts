import { describe, expect, it } from "vitest";
import {
  BrowserPoolHostDesiredSchema,
  BrowserPoolHostIdSchema,
  BrowserPoolHostReportSchema,
  BrowserPoolHostSlotEgressRequestSchema,
  BrowserPoolSlotDesiredSchema,
  BrowserPoolSlotIdSchema,
  BrowserPoolSlotReportSchema,
  CloudComputerBootResponseSchema,
  CloudComputerIdSchema,
  ManagedBrowserPoolRegistrationRequestSchema,
  ManagedBrowserPoolTargetResponseSchema,
  browserPoolHostSlotEgressPath,
  browserPoolHostSlotEgressSigningBytes,
  managedBrowserPoolRegistrationSigningBytes,
} from "./index.js";

const sha = "a".repeat(64);
const spki = "MCowBQYDK2VwAyEA" + "A".repeat(44);
const hostId = BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111");
const slotId = BrowserPoolSlotIdSchema.parse("bps_22222222-2222-4222-8222-222222222222");
const computerId = CloudComputerIdSchema.parse("cc_33333333-3333-4333-8333-333333333333");

const release = {
  version: "1.0.0",
  installerUrl: "https://releases.example.test/pool-host.sh",
  installerSha256: sha,
  artifacts: {
    agentUrl: "https://releases.example.test/pool-agent.mjs",
    agentSha256: sha,
    relayUrl: "https://releases.example.test/pool-relay.mjs",
    relaySha256: sha,
    rootfsUrl: "https://releases.example.test/rootfs.ext4",
    rootfsSha256: sha,
    kernelUrl: "https://releases.example.test/vmlinux",
    kernelSha256: sha,
    egressUrl: "https://releases.example.test/egress.tar.gz",
    egressSha256: sha,
  },
};

describe("browser pool protocol", () => {
  it("keeps CloudComputerBootResponseSchema additive with optional browserPool flag", () => {
    const base = {
      hostname: "cc-33333333-3333-4333-8333-333333333333.home.example.test",
      accountOrigin: "https://account.example.test",
      ipv6Enabled: false,
      setupCodeDigest: sha,
      release: {
        version: "1.0.0",
        images: {
          host: `example.test/host@sha256:${sha}`,
          runner: `example.test/runner@sha256:${sha}`,
          "browser-runtime": `example.test/browser-runtime@sha256:${sha}`,
          "browser-egress": `example.test/browser-egress@sha256:${sha}`,
          "channel-runtime": `example.test/channel-runtime@sha256:${sha}`,
          gateway: `example.test/gateway@sha256:${sha}`,
        },
      },
      backup: {
        endpoint: "https://s3.example.test",
        bucket: "backups",
        prefix: "p1",
        accessKeyId: "ak_1",
        secretAccessKey: "sk_1",
        repository: "s3:https://s3.example.test/backups/p1",
        password: "secret-password-value",
      },
    };
    expect(CloudComputerBootResponseSchema.parse(base).browserPool).toBeUndefined();
    expect(CloudComputerBootResponseSchema.parse({ ...base, browserPool: true }).browserPool).toBe(
      true,
    );
  });

  it("validates pool host desired and report invariants", () => {
    const desired = BrowserPoolHostDesiredSchema.parse({
      id: hostId,
      generation: 1,
      revision: 1,
      state: "active",
      region: "us-central1-a",
      machineType: "n2-standard-8",
      slotsCapacity: 40,
      profileDiskName: "osp-disk-11111111-1111-4111-8111-111111111111",
      profileDiskSizeGb: 500,
      release,
      enrolled: false,
      bootstrapToken: "a".repeat(43),
    });
    expect(desired.slotsCapacity).toBe(40);
    expect(desired.profileDiskSizeGb).toBe(500);

    expect(() =>
      BrowserPoolHostDesiredSchema.parse({
        ...desired,
        state: "deleted",
        bootstrapToken: "a".repeat(43),
      }),
    ).toThrow();

    expect(() =>
      BrowserPoolHostReportSchema.parse({
        id: hostId,
        generation: 1,
        revision: 1,
        phase: "ready",
        providerServerRef: "osp-ph-1/123",
        profileDiskRef: null,
        internalIp: "10.40.0.10",
        lastError: null,
      }),
    ).toThrow();
  });

  it("validates pool slot desired and W10 deletion report evidence (slot + profile + credentials)", () => {
    const slot = BrowserPoolSlotDesiredSchema.parse({
      slotId,
      computerId,
      hostId,
      hostGeneration: 1,
      hostInternalIp: "10.40.0.10",
      hostKey: spki,
      term: 1,
      revision: 1,
      state: "active",
      phase: "provisioning",
      guest: { vcpus: 2, memoryMib: 2048, profileMib: 2048 },
      slotErased: false,
      profileErased: false,
      credentialsErased: false,
    });
    expect(slot.guest.profileMib).toBe(2048);

    // W10: deleted requires all three erasure flags and null controlKey.
    expect(() =>
      BrowserPoolSlotReportSchema.parse({
        slotId,
        revision: 2,
        term: 1,
        phase: "deleted",
        controlKey: null,
        slotErased: true,
        profileErased: true,
        credentialsErased: false,
        lastError: null,
      }),
    ).toThrow();

    expect(
      BrowserPoolSlotReportSchema.parse({
        slotId,
        revision: 2,
        term: 1,
        phase: "deleted",
        controlKey: null,
        slotErased: true,
        profileErased: true,
        credentialsErased: true,
        lastError: null,
      }).phase,
    ).toBe("deleted");
  });

  it("matches the S4 pool host slot-egress signing test vector and schema", () => {
    const vector = browserPoolHostSlotEgressSigningBytes({
      hostId: "ph_test",
      slotId: "bps_test",
      issuedAt: "2026-11-22T00:00:00.000Z",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(Buffer.from(vector).toString("utf8")).toBe(
      "opensteer-pool-slot-egress-v1\nph_test\nbps_test\n2026-11-22T00:00:00.000Z\nAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(browserPoolHostSlotEgressPath(hostId)).toBe(
      `/v1/browser-pool/hosts/${hostId}/slot-egress`,
    );

    const parsed = BrowserPoolHostSlotEgressRequestSchema.parse({
      v: 1,
      hostId,
      slotId,
      issuedAt: "2026-11-22T00:00:00.000Z",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      signature: "A".repeat(86) + "==",
    });
    expect(parsed.v).toBe(1);
    expect(() =>
      BrowserPoolHostSlotEgressRequestSchema.parse({
        ...parsed,
        issuedAt: "2026-11-22T00:00:00Z",
      }),
    ).toThrow();
  });

  it("validates W4+S5 signed Home key registration and target response invariants", () => {
    const doc = {
      purpose: "opensteer-managed-browser-pool-registration" as const,
      documentVersion: 1 as const,
      cloudComputerId: computerId,
      issuedAt: "2026-11-22T00:00:00.000Z",
      keys: {
        homeKey: spki,
        relayKey: spki,
        ticketKey: { keyId: "tk-1", spki },
      },
    };
    const req = ManagedBrowserPoolRegistrationRequestSchema.parse({
      document: doc,
      signature: "A".repeat(86),
    });
    expect(req.document.cloudComputerId).toBe(computerId);
    expect(Buffer.from(managedBrowserPoolRegistrationSigningBytes(doc)).toString("utf8")).toContain(
      "opensteer-managed-browser-pool-registration-v1\0",
    );

    expect(() => ManagedBrowserPoolTargetResponseSchema.parse({ status: "ready" })).toThrow();
    expect(ManagedBrowserPoolTargetResponseSchema.parse({ status: "preparing" }).status).toBe(
      "preparing",
    );
  });
});
