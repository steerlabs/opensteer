import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BrowserPoolHostBootCompleteRequestSchema,
  BrowserPoolHostBootRequestSchema,
  BrowserPoolHostCheckSchema,
  BrowserPoolHostDesiredResponseSchema,
  BrowserPoolHostEgressRequestSchema,
  BrowserPoolHostIdSchema,
  BrowserPoolHostReportSchema,
  BrowserPoolSlotCheckSchema,
  BrowserPoolSlotDesiredResponseSchema,
  BrowserPoolSlotIdSchema,
  BrowserPoolSlotReportSchema,
  ManagedBrowserPoolRegistrationRequestSchema,
  ManagedBrowserPoolTargetResponseSchema,
  browserPoolHostBootCompletePath,
  browserPoolHostBootPath,
  browserPoolHostCheckPath,
  browserPoolHostEgressPath,
  browserPoolHostEgressSigningBytes,
  browserPoolHostStatusPath,
  browserPoolHostsDesiredPath,
  browserPoolSlotBumpTermPath,
  browserPoolSlotCheckPath,
  browserPoolSlotStatusPath,
  browserPoolSlotsDesiredPath,
  managedBrowserPoolRegistrationPath,
  managedBrowserPoolRegistrationSigningBytes,
  managedBrowserPoolTargetPath,
} from "./browser-pool.js";
import { CloudComputerBootResponseSchema, CloudComputerIdSchema } from "./cloud-computers.js";

function spkiBase64() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey,
  };
}

const sha = "a".repeat(64);
const hostId = BrowserPoolHostIdSchema.parse("ph_00000000-0000-4000-8000-000000000001");
const slotId = BrowserPoolSlotIdSchema.parse("bps_00000000-0000-4000-8000-000000000001");
const computerId = CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000001");

const release = {
  version: "1.0.0",
  installerUrl: "https://releases.example.com/pool-host.sh",
  installerSha256: sha,
  artifacts: {
    agentUrl: "https://releases.example.com/pool-agent.mjs",
    agentSha256: sha,
    relayUrl: "https://releases.example.com/pool-relay.mjs",
    relaySha256: sha,
    rootfsUrl: "https://releases.example.com/rootfs.ext4",
    rootfsSha256: sha,
    kernelUrl: "https://releases.example.com/vmlinux",
    kernelSha256: sha,
    egressUrl: "https://releases.example.com/egress.tar.gz",
    egressSha256: sha,
  },
};

describe("Browser pool control-plane protocol", () => {
  it("round-trips pool host desired state, checks, boot completion, and reports", () => {
    const hostKey = spkiBase64().spki;
    const relayKey = spkiBase64().spki;
    const desired = BrowserPoolHostDesiredResponseSchema.parse({
      hosts: [
        {
          id: hostId,
          generation: 1,
          revision: 2,
          state: "active",
          region: "us-central1-a",
          machineType: "n2-standard-8",
          slotsCapacity: 10,
          profileDiskName: `osp-pool-${hostId.slice(3)}-profiles`,
          release,
          enrolled: false,
          bootstrapToken: "pool_boot_token",
          readinessStartedAt: "2026-11-21T00:00:00.000Z",
          pendingProviderWrites: [
            {
              token: "00000000-0000-4000-8000-000000000010",
              kind: "create-disk",
              generation: 1,
              diskName: `osp-pool-${hostId.slice(3)}-profiles`,
              dispatched: false,
            },
          ],
        },
      ],
    });
    expect(desired.hosts[0]?.id).toBe(hostId);
    expect(browserPoolHostsDesiredPath).toBe("/v1/browser-pool/hosts/desired");
    expect(browserPoolHostCheckPath(hostId)).toBe(`/v1/browser-pool/hosts/${hostId}/check`);
    expect(browserPoolHostStatusPath(hostId)).toBe(`/v1/browser-pool/hosts/${hostId}/status`);
    expect(browserPoolHostBootPath(hostId)).toBe(`/v1/browser-pool/hosts/${hostId}/boot`);
    expect(browserPoolHostBootCompletePath(hostId)).toBe(
      `/v1/browser-pool/hosts/${hostId}/boot-complete`,
    );

    expect(
      BrowserPoolHostBootRequestSchema.parse({ generation: 1, bootstrapToken: "pool_boot_token" }),
    ).toEqual({ generation: 1, bootstrapToken: "pool_boot_token" });
    expect(
      BrowserPoolHostBootCompleteRequestSchema.parse({
        generation: 1,
        bootstrapToken: "pool_boot_token",
        hostKey,
        relayKey,
      }),
    ).toMatchObject({ hostKey, relayKey });

    expect(
      BrowserPoolHostCheckSchema.parse({
        operation: "begin-provider-write",
        revision: 2,
        write: {
          token: "00000000-0000-4000-8000-000000000011",
          kind: "create",
          generation: 1,
        },
      }).operation,
    ).toBe("begin-provider-write");

    expect(
      BrowserPoolHostReportSchema.parse({
        id: hostId,
        generation: 1,
        revision: 2,
        phase: "ready",
        providerServerRef: "osp-ph-00000000-1/12345",
        profileDiskRef: "osp-pool-profiles/999",
        internalIp: "10.40.0.12",
        lastError: null,
      }).phase,
    ).toBe("ready");
    expect(
      BrowserPoolHostReportSchema.safeParse({
        id: hostId,
        generation: 1,
        revision: 2,
        phase: "ready",
        providerServerRef: null,
        profileDiskRef: null,
        internalIp: null,
        lastError: null,
      }).success,
    ).toBe(false);
    expect(
      BrowserPoolHostReportSchema.safeParse({
        id: hostId,
        generation: 1,
        revision: 2,
        phase: "deleted",
        providerServerRef: "osp-ph-00000000-1/12345",
        profileDiskRef: null,
        internalIp: null,
        lastError: null,
      }).success,
    ).toBe(false);
  });

  it("round-trips pool slot desired state, checks, and reports", () => {
    const homeKey = spkiBase64().spki;
    const relayKey = spkiBase64().spki;
    const ticketKey = spkiBase64().spki;
    const hostKey = spkiBase64().spki;
    const controlKey = spkiBase64().spki;

    const desired = BrowserPoolSlotDesiredResponseSchema.parse({
      slots: [
        {
          slotId,
          computerId,
          hostId,
          hostGeneration: 1,
          hostInternalIp: "10.40.0.12",
          hostKey,
          term: 1,
          revision: 1,
          state: "active",
          phase: "provisioning",
          keys: { homeKey, relayKey, ticketKey: { keyId: "tk-1", spki: ticketKey } },
          guest: { vcpus: 2, memoryMib: 2048, profileSizeMib: 2048 },
          slotErased: false,
          profileErased: false,
        },
      ],
    });
    expect(desired.slots[0]?.slotId).toBe(slotId);
    expect(browserPoolSlotsDesiredPath).toBe("/v1/browser-pool/slots/desired");
    expect(browserPoolSlotCheckPath(slotId)).toBe(`/v1/browser-pool/slots/${slotId}/check`);
    expect(browserPoolSlotStatusPath(slotId)).toBe(`/v1/browser-pool/slots/${slotId}/status`);
    expect(browserPoolSlotBumpTermPath(slotId)).toBe(`/v1/browser-pool/slots/${slotId}/bump-term`);

    expect(
      BrowserPoolSlotCheckSchema.parse({
        operation: "begin-agent-write",
        revision: 1,
        write: {
          token: "00000000-0000-4000-8000-000000000020",
          kind: "create",
          term: 1,
          hostId,
        },
      }).operation,
    ).toBe("begin-agent-write");

    expect(
      BrowserPoolSlotReportSchema.parse({
        slotId,
        revision: 1,
        term: 1,
        phase: "ready",
        controlKey,
        slotErased: false,
        profileErased: false,
        lastError: null,
      }).phase,
    ).toBe("ready");

    // Deleted requires both slotErased and profileErased evidence (W10).
    expect(
      BrowserPoolSlotReportSchema.safeParse({
        slotId,
        revision: 2,
        term: 1,
        phase: "deleted",
        controlKey: null,
        slotErased: true,
        profileErased: false,
        lastError: null,
      }).success,
    ).toBe(false);
    expect(
      BrowserPoolSlotReportSchema.safeParse({
        slotId,
        revision: 2,
        term: 1,
        phase: "deleted",
        controlKey: null,
        slotErased: true,
        profileErased: true,
        lastError: null,
      }).success,
    ).toBe(true);
  });

  it("canonicalizes pool host egress pull requests deterministically (S4)", () => {
    const request = BrowserPoolHostEgressRequestSchema.parse({
      v: 1,
      hostId,
      slotId,
      issuedAt: "2026-11-21T00:00:00.000Z",
      nonce: "1234567890abcdef",
    });
    const reordered = {
      nonce: request.nonce,
      slotId: request.slotId,
      v: request.v,
      issuedAt: request.issuedAt,
      hostId: request.hostId,
    };
    expect(browserPoolHostEgressSigningBytes(request)).toEqual(
      browserPoolHostEgressSigningBytes(reordered),
    );
    expect(browserPoolHostEgressPath(hostId, slotId)).toBe(
      `/v1/browser-pool/hosts/${hostId}/slots/${slotId}/egress`,
    );
  });

  it("canonicalizes Home signed key registration (W4, S5) and validates public targets", () => {
    const home = spkiBase64();
    const relay = spkiBase64();
    const ticket = spkiBase64();
    const control = spkiBase64();
    const hostKey = spkiBase64().spki;
    const relayHostKey = spkiBase64().spki;

    const document = {
      purpose: "opensteer-managed-browser-pool-registration" as const,
      documentVersion: 1 as const,
      cloudComputerId: computerId,
      issuedAt: "2026-11-21T00:00:00.000Z",
      keys: {
        homeKey: home.spki,
        relayKey: relay.spki,
        ticketKey: { keyId: "tk-1", spki: ticket.spki },
      },
    };
    const bytes = managedBrowserPoolRegistrationSigningBytes(document);
    const bytesReordered = managedBrowserPoolRegistrationSigningBytes({
      keys: {
        ticketKey: { spki: ticket.spki, keyId: "tk-1" },
        relayKey: relay.spki,
        homeKey: home.spki,
      },
      issuedAt: document.issuedAt,
      cloudComputerId: document.cloudComputerId,
      documentVersion: 1,
      purpose: "opensteer-managed-browser-pool-registration",
    });
    expect(bytes).toEqual(bytesReordered);

    const signature = sign(null, bytes, home.privateKey).toString("base64url");
    expect(
      ManagedBrowserPoolRegistrationRequestSchema.parse({ document, signature }).document,
    ).toEqual(document);
    expect(managedBrowserPoolRegistrationPath).toBe("/v1/cloud-computers/browser-pool/registration");
    expect(managedBrowserPoolTargetPath).toBe("/v1/cloud-computers/browser-pool/target");

    expect(
      ManagedBrowserPoolTargetResponseSchema.parse({
        status: "ready",
        target: {
          kind: "managed-pool",
          agentUrl: "http://10.40.0.12:7310",
          slotId,
          term: 1,
          agentKey: control.spki,
          hostKey,
          relay: { host: "10.40.0.12", port: 7312, relayHostKey },
        },
      }).status,
    ).toBe("ready");
    expect(ManagedBrowserPoolTargetResponseSchema.safeParse({ status: "ready" }).success).toBe(
      false,
    );
    expect(
      ManagedBrowserPoolTargetResponseSchema.safeParse({
        status: "preparing",
        target: {
          kind: "managed-pool",
          agentUrl: "http://10.40.0.12:7310",
          slotId,
          term: 1,
          agentKey: control.spki,
          hostKey,
          relay: { host: "10.40.0.12", port: 7312, relayHostKey },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps browserPool optional on CloudComputerBootResponseSchema (W9)", () => {
    const base = {
      hostname: "cc-1.example.com",
      accountOrigin: "https://account.example.com",
      setupCodeDigest: sha,
      release: {
        version: "1.0.0",
        images: {
          host: `ghcr.io/steerlabs/host@sha256:${sha}`,
          runner: `ghcr.io/steerlabs/runner@sha256:${sha}`,
          "browser-runtime": `ghcr.io/steerlabs/browser@sha256:${sha}`,
          "browser-egress": `ghcr.io/steerlabs/egress@sha256:${sha}`,
          "channel-runtime": `ghcr.io/steerlabs/channel@sha256:${sha}`,
          gateway: `ghcr.io/steerlabs/gateway@sha256:${sha}`,
        },
      },
      ipv6Enabled: false,
      backup: {
        endpoint: "https://s3.example.com",
        bucket: "opensteer-backups",
        prefix: "cc-1",
        repository: "s3:https://s3.example.com/opensteer-backups/cc-1",
        accessKeyId: "ak_test",
        secretAccessKey: "sk_test",
        password: "pw_test",
      },
    };
    expect(CloudComputerBootResponseSchema.parse(base).browserPool).toBeUndefined();
    expect(
      CloudComputerBootResponseSchema.parse({ ...base, browserPool: true }).browserPool,
    ).toBe(true);
  });
});
