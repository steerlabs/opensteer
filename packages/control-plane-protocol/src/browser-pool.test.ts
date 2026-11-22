import { describe, expect, it } from "vitest";
import {
  BrowserPoolHostBootCompleteRequestSchema,
  BrowserPoolHostDesiredSchema,
  BrowserPoolHostIdSchema,
  BrowserPoolHostReplaceUnreadyRequestSchema,
  BrowserPoolHostReportSchema,
  BrowserPoolHostSlotEgressRequestSchema,
  BrowserPoolSlotCheckSchema,
  BrowserPoolSlotDesiredSchema,
  BrowserPoolSlotIdSchema,
  BrowserPoolSlotReportSchema,
  CloudComputerBootResponseSchema,
  CloudComputerIdSchema,
  CloudComputerLeaseSchema,
  ManagedBrowserPoolRegistrationRequestSchema,
  ManagedBrowserPoolTargetResponseSchema,
  browserPoolHostSlotEgressSigningBytes,
  managedBrowserPoolRegistrationSigningBytes,
} from "./index.js";

const sha = "a".repeat(64);
const spki = Buffer.alloc(44, 1).toString("base64");
const sigBase64 = Buffer.alloc(64, 2).toString("base64");
const sigBase64Url = Buffer.alloc(64, 3).toString("base64url");
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

describe("control-plane-protocol browser pool contracts", () => {
  it("keeps CloudComputerBootResponseSchema and CloudComputerLeaseSchema additive", () => {
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

    const holder = "11111111-1111-4111-8111-111111111111";
    expect(CloudComputerLeaseSchema.parse({ holder }).poolConfigured).toBeUndefined();
    expect(CloudComputerLeaseSchema.parse({ holder, poolConfigured: true }).poolConfigured).toBe(
      true,
    );
  });

  it("validates pool host desired, replace-unready, and report invariants", () => {
    const desired = BrowserPoolHostDesiredSchema.parse({
      id: hostId,
      generation: 1,
      revision: 1,
      state: "active",
      machineType: "n2-standard-8",
      profileDiskName: "osp-disk-11111111-1111-4111-8111-111111111111",
      profileDiskSizeGb: 500,
      agentPort: 7310,
      relayPort: 7312,
      release,
      enrolled: false,
      everEnrolled: false,
      autoReplaceCount: 0,
      bootstrapToken: "b".repeat(43),
    });
    expect(desired.agentPort).toBe(7310);
    expect(desired.relayPort).toBe(7312);

    expect(
      BrowserPoolHostReplaceUnreadyRequestSchema.parse({ revision: 1, generation: 1 }),
    ).toEqual({ revision: 1, generation: 1 });

    // Deleted pool host cannot carry a bootstrap token.
    expect(() =>
      BrowserPoolHostDesiredSchema.parse({
        ...desired,
        state: "deleted",
        bootstrapToken: "b".repeat(43),
      }),
    ).toThrow();

    // Ready report requires server ref, profile disk ref, and internal IP.
    expect(() =>
      BrowserPoolHostReportSchema.parse({
        id: hostId,
        generation: 1,
        revision: 1,
        phase: "ready",
        providerServerRef: null,
        profileDiskRef: "osp-disk-1/1",
        internalIp: "10.40.0.10",
        lastError: null,
      }),
    ).toThrow();

    expect(
      BrowserPoolHostBootCompleteRequestSchema.parse({
        generation: 1,
        bootstrapToken: "b".repeat(43),
        hostKey: spki,
        relayKey: spki,
      }).hostKey,
    ).toBe(spki);
  });

  it("validates pool slot desired, T5 hostGeneration report, and T10 simplified phases/checks", () => {
    const slot = BrowserPoolSlotDesiredSchema.parse({
      slotId,
      hostId,
      hostGeneration: 1,
      hostInternalIp: "10.40.0.10",
      hostKey: spki,
      term: 1,
      revision: 1,
      state: "active",
      phase: "preparing",
      guest: { vcpus: 2, memoryMib: 2048, profileMib: 2048 },
      slotErased: false,
      profileErased: false,
      credentialsErased: false,
    });
    expect(slot.guest.profileMib).toBe(2048);

    // T1: deleted report allows partial flags when completing accumulated Account *_erased_at columns,
    // but still rejects retaining a control key.
    expect(
      BrowserPoolSlotReportSchema.parse({
        slotId,
        hostGeneration: 1,
        revision: 2,
        term: 1,
        phase: "deleted",
        controlKey: null,
        slotErased: false,
        profileErased: false,
        credentialsErased: true,
        lastError: null,
      }).phase,
    ).toBe("deleted");

    expect(() =>
      BrowserPoolSlotReportSchema.parse({
        slotId,
        hostGeneration: 1,
        revision: 2,
        term: 1,
        phase: "deleted",
        controlKey: spki,
        slotErased: true,
        profileErased: true,
        credentialsErased: true,
        lastError: null,
      }),
    ).toThrow();

    // T5: hostGeneration is required on slot reports.
    expect(() =>
      BrowserPoolSlotReportSchema.parse({
        slotId,
        revision: 2,
        term: 1,
        phase: "ready",
        controlKey: spki,
        slotErased: false,
        profileErased: false,
        credentialsErased: false,
        lastError: null,
      }),
    ).toThrow();

    // T10: unused "mutate" slot check is removed.
    expect(() => BrowserPoolSlotCheckSchema.parse({ operation: "mutate", revision: 1 })).toThrow();
  });

  it("matches the S4 pool host slot-egress signing test vector and schema", () => {
    const vector = {
      hostId: "ph_test",
      slotId: "bps_test",
      issuedAt: "2026-11-22T00:00:00.000Z",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    };
    expect(Buffer.from(browserPoolHostSlotEgressSigningBytes(vector)).toString("utf8")).toBe(
      "opensteer-pool-slot-egress-v1\nph_test\nbps_test\n2026-11-22T00:00:00.000Z\nAAAAAAAAAAAAAAAAAAAAAA",
    );

    const parsed = BrowserPoolHostSlotEgressRequestSchema.parse({
      v: 1,
      hostId,
      slotId,
      issuedAt: "2026-11-22T00:00:00.000Z",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      signature: sigBase64,
    });
    expect(parsed.v).toBe(1);
  });

  it("validates W4+S5 signed Home key registration and target response invariants", () => {
    const req = ManagedBrowserPoolRegistrationRequestSchema.parse({
      document: {
        purpose: "opensteer-managed-browser-pool-registration",
        documentVersion: 1,
        cloudComputerId: computerId,
        issuedAt: "2026-11-22T00:00:00.000Z",
        keys: {
          homeKey: spki,
          relayKey: spki,
          ticketKey: { keyId: "tk-1", spki },
        },
      },
      signature: sigBase64Url,
    });
    expect(
      Buffer.from(managedBrowserPoolRegistrationSigningBytes(req.document)).toString("utf8"),
    ).toContain('"purpose":"opensteer-managed-browser-pool-registration"');

    expect(() => ManagedBrowserPoolTargetResponseSchema.parse({ status: "ready" })).toThrow();
    expect(ManagedBrowserPoolTargetResponseSchema.parse({ status: "preparing" }).status).toBe(
      "preparing",
    );
  });
});
