import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import {
  BrowserPoolHostBootCompleteResponseSchema,
  BrowserPoolHostBootResponseSchema,
  BrowserPoolHostDesiredResponseSchema,
  BrowserPoolSlotBumpTermResponseSchema,
  BrowserPoolSlotDesiredResponseSchema,
  CloudComputerBootResponseSchema,
  CloudComputerCheckResponseSchema,
  CloudComputerEgressResponseSchema,
  CloudComputerIdentitySchema,
  CloudComputerReportResponseSchema,
  ControlPlaneAccountIdSchema,
  ManagedBrowserPoolTargetResponseSchema,
  browserPoolHostBootCompletePath,
  browserPoolHostBootPath,
  browserPoolHostSlotEgressPath,
  browserPoolHostSlotEgressSigningBytes,
  browserPoolHostStatusPath,
  browserPoolHostsDesiredPath,
  browserPoolSlotBumpTermPath,
  browserPoolSlotCheckPath,
  browserPoolSlotStatusPath,
  browserPoolSlotsDesiredPath,
  cloudComputerBootCompletePath,
  cloudComputerBootPath,
  cloudComputerLeaseHeader,
  cloudComputerLeasePath,
  cloudComputerStatusPath,
  cloudComputersDesiredPath,
  managedBrowserPoolRegistrationPath,
  managedBrowserPoolRegistrationSigningBytes,
  managedBrowserPoolTargetPath,
  type BrowserPoolHostId,
  type BrowserPoolSlotId,
  type CloudComputerDesired,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  HostDiscoveryDocumentSchema,
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
} from "@opensteer/deployment-authority";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostCredential, hashCredential } from "../auth/credentials.js";
import { ControlPlaneAuthenticator, createControlPlaneAuth } from "../auth/auth.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { ControlPlaneStore } from "../database/store.js";
import { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { createControlPlaneServer } from "../server/server.js";
import { testBackupVault } from "./backup-erasure.test-support.js";
import { loadCloudComputerConfig } from "./config.js";
import { runCloudComputerOperator } from "./operator.js";
import { resetManagedCloudTables } from "./reset.test-support.js";
import { CloudComputerStore } from "./store.js";
import type { StripeBilling, StripeSubscription } from "./stripe.js";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";

const url = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

const publicOrigin = new URL("https://account.browser-pool.example.test");
const portalOrigin = new URL("https://portal.browser-pool.example.test");
const authSecret = "test-auth-secret-for-browser-pool-32";
const provisionerEmail = "home@example.iam.gserviceaccount.com";
const webhookSecret = "whsec_abcdefghijklmno";
const sha = "a".repeat(64);
const services = [
  "host",
  "runner",
  "browser-runtime",
  "browser-egress",
  "channel-runtime",
  "gateway",
];

const poolRelease = {
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

function makeEnv(slotsPerHost?: string) {
  return {
    OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL: provisionerEmail,
    OPENSTEER_CLOUD_COMPUTER_DOMAIN: "home.example.test",
    OPENSTEER_CLOUD_COMPUTER_REGION: "us-central1-a",
    OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE: "default",
    OPENSTEER_CLOUD_COMPUTER_RELEASE_JSON: JSON.stringify({
      version: "1.2.3",
      installerUrl: "https://releases.example.test/install.sh",
      installerSha256: sha,
      images: Object.fromEntries(
        services.map((service) => [service, `example.test/${service}@sha256:${sha}`]),
      ),
    }),
    OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY: "sk_test_abcdefghijklmno",
    OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET: webhookSecret,
    OPENSTEER_CLOUD_COMPUTER_STRIPE_PRICE_ID: "price_1",
    OPENSTEER_CLOUD_COMPUTER_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_cloud",
    OPENSTEER_CLOUD_COMPUTER_PLAN_NAME: "Cloud Computer",
    OPENSTEER_CLOUD_COMPUTER_CURRENCY: "usd",
    OPENSTEER_CLOUD_COMPUTER_PRICE_MINOR: "2900",
    ...(slotsPerHost !== undefined
      ? {
          OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST: slotsPerHost,
          OPENSTEER_CLOUD_COMPUTER_POOL_RELEASE_JSON: JSON.stringify(poolRelease),
          OPENSTEER_CLOUD_COMPUTER_POOL_MACHINE_TYPE: "n2-standard-8",
        }
      : {}),
  };
}

function keyPairSpkiBase64() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    spkiBase64Url: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    privateKey,
  };
}

function makeDiscoveryEnvelope(origin: string, deploymentId: string, privateKey: KeyObject, spkiBase64Url: string) {
  const document = HostDiscoveryDocumentSchema.parse({
    deploymentId,
    deploymentShape: { kind: "personal" },
    canonicalOrigin: origin,
    hostInstanceId: `hst_${randomUUID()}`,
    hostKey: { algorithm: "Ed25519" },
  });
  return {
    document,
    publicKey: { algorithm: "Ed25519" as const, spki: spkiBase64Url },
    signature: sign(null, hostDiscoverySigningBytes(document), privateKey).toString("base64url"),
  };
}

integration("Browser pool Account service", () => {
  const database = createControlPlaneDatabase({ connectionString: url!, maxConnections: 4 });
  const subscriptions = new Map<string, StripeSubscription>();
  const stripe: StripeBilling = {
    checkout: vi.fn(async () => ({ id: `cs_${randomUUID()}`, url: "https://checkout.example.test" })),
    portal: vi.fn(async () => ({ url: "https://portal.example.test" })),
    subscription: vi.fn(async (id: string) => subscriptions.get(id)!),
    validateOffer: vi.fn(async () => {}),
    validatePortal: vi.fn(async () => {}),
    expireCheckout: vi.fn(async (id: string) => ({
      id,
      status: "expired" as const,
      url: null,
      payment: undefined,
    })),
    refundCheckout: vi.fn(async () => true),
    deleteIdleCustomer: vi.fn(async () => {}),
    findCheckout: vi.fn(async () => undefined),
    cancel: vi.fn(async (id: string) => {
      subscriptions.set(id, { ...subscriptions.get(id)!, status: "canceled" });
    }),
  };

  let now = new Date("2026-11-21T00:00:00.000Z");
  let leaseHolder = randomUUID();
  const cipher = new HostedTeamSetupTokenCipher(Buffer.alloc(32, 7).toString("base64url"));

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
  });

  afterAll(async () => {
    await database.destroy();
  });

  beforeEach(async () => {
    now = new Date("2026-11-21T00:00:00.000Z");
    leaseHolder = randomUUID();
    subscriptions.clear();
    await resetManagedCloudTables(database);
    await database.deleteFrom("users").execute();
  });

  async function buildHarness(slotsPerHost?: string) {
    const config = loadCloudComputerConfig(makeEnv(slotsPerHost))!;
    const cloudStore = new CloudComputerStore(database, {
      config,
      accountOrigin: publicOrigin,
      cipher,
      stripe,
      now: () => now,
      backupKeyVault: testBackupVault(),
      purgeBackupStep: async () => true,
    });
    const auth = createControlPlaneAuth(database, {
      authSecret,
      publicOrigin,
    });
    const controlStore = new ControlPlaneStore(database, publicOrigin, {
      adoptionCompletionGrantIssuer: { issueGrant: vi.fn() } as never,
      adoptionOperationCipher: cipher as never,
      adoptionProofVerifier: { verify: vi.fn() } as never,
      portalOrigin,
    });
    const app = await createControlPlaneServer(
      {
        auth,
        authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
        connectLifecycle: new ConnectLifecycleService(
          database,
          { provision: vi.fn(), rotate: vi.fn(), revoke: vi.fn() } as never,
          { managedConnectDomain: "connect.example.test" },
        ),
        cloudComputers: {
          store: cloudStore,
          stripeWebhookSecret: webhookSecret,
          verifyProvisioner: async (authorization) => {
            if (authorization !== "Bearer provisioner-ok") {
              throw new Error("Unauthorized provisioner");
            }
          },
        },
        notifications: {} as never,
        notificationPlatforms: [],
        portalOrigin,
        publicOrigin,
        store: controlStore,
      },
      { logger: false },
    );

    const leaseHeaders = {
      authorization: "Bearer provisioner-ok",
      [cloudComputerLeaseHeader]: leaseHolder,
    };
    const acquireLease = async () => {
      const response = await app.inject({
        method: "POST",
        url: cloudComputerLeasePath,
        headers: { authorization: "Bearer provisioner-ok" },
        payload: { holder: leaseHolder },
      });
      expect(response.statusCode).toBe(200);
    };

    const seenComputerIds = new Set<string>();
    const provisionComputer = async (n: number) => {
      const accountId = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
      await database
        .insertInto("users")
        .values({
          id: accountId,
          displayName: `Person ${n}`,
          email: `person-${n}@example.test`,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
          deletionAttemptId: null,
          deletionFencedUntil: null,
        })
        .execute();
      await cloudStore.addBackupTarget({
        endpoint: "https://s3.example.test",
        bucket: "opensteer-backups",
        prefix: `p-${n}-${randomUUID().slice(0, 8)}`,
        accessKeyId: `ak_${randomUUID()}`,
        secretAccessKey: `sk_${randomUUID()}`,
      });
      const requestId = randomUUID();
      const subId = `sub_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const sessionId = `cs_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      subscriptions.set(subId, {
        id: subId,
        customer: `cus_${n}`,
        status: "active",
        cancel_at_period_end: false,
        latest_invoice: null,
        items: {
          has_more: false,
          data: [
            {
              quantity: 1,
              price: { id: "price_1", currency: "usd" },
              current_period_end: Math.floor(now.getTime() / 1000) + 86400,
            },
          ],
        },
        metadata: { account_id: accountId, request_id: requestId },
      });
      await cloudStore.checkOffer();
      await database
        .insertInto("cloudComputerCheckouts")
        .values({
          accountId,
          requestId,
          expiresAt: new Date(now.getTime() + 3600_000),
          createdAt: now,
          lastStripeAttemptAt: now,
          targetComputerId: null,
          stripeSessionId: sessionId,
          url: "https://checkout.example.test",
          stripePriceId: "price_1",
          currency: "usd",
          status: "open",
        })
        .execute();
      await cloudStore.applyStripeEvent({
        id: `evt_${randomUUID()}`,
        type: "checkout.session.completed",
        operation: "completed",
        checkout: {
          id: sessionId,
          mode: "subscription",
          payment_status: "paid",
          client_reference_id: accountId,
          customer: `cus_${n}`,
          subscription: subId,
          currency: "usd",
          metadata: { account_id: accountId, request_id: requestId },
        },
      });
      const desiredRes = await app.inject({
        method: "GET",
        url: `${cloudComputersDesiredPath}?provider=google`,
        headers: leaseHeaders,
      });
      const desired = (JSON.parse(desiredRes.body) as { computers: CloudComputerDesired[] })
        .computers;
      const computer = desired.find(
        (entry) => entry.bootstrapToken !== undefined && !seenComputerIds.has(entry.id),
      )!;
      seenComputerIds.add(computer.id);
      return { accountId, computer };
    };

    const bootAndClaimComputer = async (
      computer: CloudComputerDesired,
      accountId: ControlPlaneAccountId,
    ) => {
      // Provisioner reports server so boot window opens.
      await app.inject({
        method: "POST",
        url: cloudComputerStatusPath(computer.id),
        headers: leaseHeaders,
        payload: {
          id: computer.id,
          generation: computer.generation,
          revision: computer.revision,
          phase: "provisioning",
          providerServerId: null,
          providerServerRef: `os-${computer.id.replace("_", "-")}-1/1001`,
          ipv4: "192.0.2.10",
          ipv6: null,
          observedIdentity: null,
          lastError: null,
        },
      });
      const bootRes = await app.inject({
        method: "POST",
        url: cloudComputerBootPath(computer.id),
        payload: { hostname: computer.hostname, bootstrapToken: computer.bootstrapToken },
      });
      expect(bootRes.statusCode).toBe(200);
      const boot = CloudComputerBootResponseSchema.parse(JSON.parse(bootRes.body));

      const hostKey = keyPairSpkiBase64();
      const deploymentId = `dep_${randomUUID()}`;
      const fingerprint = hostKeyFingerprint(hostKey.spkiBase64Url);
      const identity = CloudComputerIdentitySchema.parse({
        deploymentId,
        hostKeyFingerprint: fingerprint,
      });
      const completeRes = await app.inject({
        method: "POST",
        url: cloudComputerBootCompletePath(computer.id),
        payload: {
          hostname: computer.hostname,
          bootstrapToken: computer.bootstrapToken,
          identity,
        },
      });
      expect(completeRes.statusCode).toBe(200);

      // Simulate claim pinning the deployment, authorityEnvelope (Home's Ed25519 key), and hostCredential.
      const hostCredential = createHostCredential();
      const envelope = makeDiscoveryEnvelope(
        `https://${computer.hostname}`,
        deploymentId,
        hostKey.privateKey,
        hostKey.spkiBase64Url,
      );
      await database
        .insertInto("deployments")
        .values({
          id: deploymentId as never,
          ownerAccountId: accountId,
          name: "Cloud Computer",
          reachability: "canonical",
          activeHostInstanceId: envelope.document.hostInstanceId as never,
          hostKeyFingerprint: fingerprint,
          canonicalOrigin: `https://${computer.hostname}`,
          lifecycle: "active",
          oidcClientId: boot.managedHome?.oidc.clientId ?? null,
          authorityEnvelope: envelope,
          directoryGeneration: 1,
          accountLink: { generation: "a".repeat(43), issuer: publicOrigin.origin, subject: accountId },
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      await database
        .insertInto("deploymentCredentials")
        .values({
          deploymentId: deploymentId as never,
          tokenHash: hashCredential(hostCredential),
          createdAt: now,
          rotatedAt: now,
        })
        .execute();
      await database
        .updateTable("cloudComputers")
        .set({ phase: "ready", bootstrapReceiptAt: now })
        .where("id", "=", computer.id)
        .execute();

      return { boot, hostKey, hostCredential, deploymentId };
    };

    const enrolAndReadyHost = async (hostId: BrowserPoolHostId, ip: string) => {
      const hostsRes = await app.inject({
        method: "GET",
        url: browserPoolHostsDesiredPath,
        headers: leaseHeaders,
      });
      const host = BrowserPoolHostDesiredResponseSchema.parse(JSON.parse(hostsRes.body)).hosts.find(
        (h) => h.id === hostId,
      )!;
      expect(host.bootstrapToken).toBeDefined();

      // Report server + disk created so bootstrap expiry opens.
      const provRes = await app.inject({
        method: "POST",
        url: browserPoolHostStatusPath(host.id),
        headers: leaseHeaders,
        payload: {
          id: host.id,
          generation: host.generation,
          revision: host.revision,
          phase: "provisioning",
          providerServerRef: `osp-ph-${host.id.slice(3, 11)}-${host.generation}/200${host.generation}`,
          profileDiskRef: `${host.profileDiskName}/3001`,
          internalIp: ip,
          lastError: null,
        },
      });
      expect(provRes.statusCode).toBe(200);

      // Host fetches boot release + enrols once with its generated keys (W3).
      const bootRes = await app.inject({
        method: "POST",
        url: browserPoolHostBootPath(host.id),
        payload: { generation: host.generation, bootstrapToken: host.bootstrapToken },
      });
      expect(bootRes.statusCode).toBe(200);
      expect(BrowserPoolHostBootResponseSchema.parse(JSON.parse(bootRes.body)).release).toEqual(
        poolRelease,
      );

      const hostKey = keyPairSpkiBase64();
      const relayKey = keyPairSpkiBase64();
      const enrolRes = await app.inject({
        method: "POST",
        url: browserPoolHostBootCompletePath(host.id),
        payload: {
          generation: host.generation,
          bootstrapToken: host.bootstrapToken,
          hostKey: hostKey.spki,
          relayKey: relayKey.spki,
        },
      });
      expect(enrolRes.statusCode).toBe(200);
      expect(BrowserPoolHostBootCompleteResponseSchema.parse(JSON.parse(enrolRes.body))).toEqual({
        completed: true,
      });

      // Re-fetch revision after boot-complete bumped it, then report ready.
      const afterEnrol = BrowserPoolHostDesiredResponseSchema.parse(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: browserPoolHostsDesiredPath,
              headers: leaseHeaders,
            })
          ).body,
        ),
      ).hosts.find((h) => h.id === host.id)!;
      expect(afterEnrol.enrolled).toBe(true);
      expect(afterEnrol.bootstrapToken).toBeUndefined();

      const readyRes = await app.inject({
        method: "POST",
        url: browserPoolHostStatusPath(host.id),
        headers: leaseHeaders,
        payload: {
          id: host.id,
          generation: afterEnrol.generation,
          revision: afterEnrol.revision,
          phase: "ready",
          providerServerRef: afterEnrol.providerServerRef!,
          profileDiskRef: afterEnrol.profileDiskRef!,
          internalIp: ip,
          lastError: null,
        },
      });
      expect(readyRes.statusCode).toBe(200);
      expect(CloudComputerReportResponseSchema.parse(JSON.parse(readyRes.body)).recorded).toBe(
        true,
      );
      return { hostKey, relayKey, host: afterEnrol };
    };

    return {
      app,
      cloudStore,
      leaseHeaders,
      acquireLease,
      provisionComputer,
      bootAndClaimComputer,
      enrolAndReadyHost,
    };
  }

  it("keeps pooling completely off when OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST is unset (S8)", async () => {
    const h = await buildHarness(undefined);
    try {
      await h.acquireLease();
      const { accountId, computer } = await h.provisionComputer(1);
      const { boot, hostCredential } = await h.bootAndClaimComputer(computer, accountId);
      expect(boot.browserPool).toBeUndefined();

      const hosts = BrowserPoolHostDesiredResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: browserPoolHostsDesiredPath,
              headers: h.leaseHeaders,
            })
          ).body,
        ),
      );
      expect(hosts.hosts).toEqual([]);

      const targetRes = await h.app.inject({
        method: "GET",
        url: managedBrowserPoolTargetPath,
        headers: { authorization: `Bearer ${hostCredential}` },
      });
      expect(targetRes.statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  it("enforces W2 capacity/most-free placement, W3 enrolment, W4+S5 signed key registration, S4 egress pull, S6+S7 convergence, and W10 deletion", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease();
      await h.cloudStore.addEgressEndpoint({
        url: "https://egress-1.example.test:8443",
        username: "u1",
        password: "p1-secret-value",
        publicAddress: "203.0.113.10",
      });

      // 1. Provision first pooled Cloud Computer -> 1 pool host wanted (W2).
      const c1 = await h.provisionComputer(1);
      const claimed1 = await h.bootAndClaimComputer(c1.computer, c1.accountId);
      expect(claimed1.boot.browserPool).toBe(true);
      expect(claimed1.boot.egress).toBeUndefined();

      // Plain unique constraint on computer_id in browser_pool_slots (S1).
      await expect(
        database
          .insertInto("browserPoolSlots")
          .values({
            slotId: `bps_${randomUUID()}` as BrowserPoolSlotId,
            computerId: c1.computer.id,
            hostId: null,
            term: 1,
            appliedTerm: null,
            appliedHostGeneration: null,
            state: "active",
            phase: "waiting_keys",
            homeKey: null,
            relayKey: null,
            ticketKeyId: null,
            ticketKeySpki: null,
            keysRegisteredAt: null,
            controlKey: null,
            guestVcpus: 2,
            guestMemoryMib: 2048,
            profileMib: 2048,
            pendingAgentWrites: "[]",
            deletionRequestedAt: null,
            slotErasedAt: null,
            profileErasedAt: null,
            credentialsErasedAt: null,
            lastError: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            tombstonedAt: null,
          })
          .execute(),
      ).rejects.toThrow();

      // Unregistered Home reads { status: "unregistered" }.
      const unregRes = await h.app.inject({
        method: "GET",
        url: managedBrowserPoolTargetPath,
        headers: { authorization: `Bearer ${claimed1.hostCredential}` },
      });
      expect(unregRes.statusCode).toBe(200);
      expect(ManagedBrowserPoolTargetResponseSchema.parse(JSON.parse(unregRes.body))).toEqual({
        status: "unregistered",
      });

      // S5: registration with wrong key signature or stale timestamp is refused even with valid bearer credential.
      const slotKeys1 = {
        homeKey: keyPairSpkiBase64().spki,
        relayKey: keyPairSpkiBase64().spki,
        ticketKey: { keyId: "tk-1", spki: keyPairSpkiBase64().spki },
      };
      const regDoc1 = {
        purpose: "opensteer-managed-browser-pool-registration" as const,
        documentVersion: 1 as const,
        cloudComputerId: c1.computer.id,
        issuedAt: now.toISOString(),
        keys: slotKeys1,
      };
      const wrongKey = keyPairSpkiBase64();
      const forgedRes = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed1.hostCredential}` },
        payload: {
          document: regDoc1,
          signature: sign(
            null,
            managedBrowserPoolRegistrationSigningBytes(regDoc1),
            wrongKey.privateKey,
          ).toString("base64url"),
        },
      });
      expect(forgedRes.statusCode).toBe(401);

      const staleDoc = { ...regDoc1, issuedAt: new Date(now.getTime() - 6 * 60_000).toISOString() };
      const staleRes = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed1.hostCredential}` },
        payload: {
          document: staleDoc,
          signature: sign(
            null,
            managedBrowserPoolRegistrationSigningBytes(staleDoc),
            claimed1.hostKey.privateKey,
          ).toString("base64url"),
        },
      });
      expect(staleRes.statusCode).toBe(401);

      // Valid signed registration succeeds; while host isn't ready yet, returns { status: "preparing" } (W2).
      const validSig1 = sign(
        null,
        managedBrowserPoolRegistrationSigningBytes(regDoc1),
        claimed1.hostKey.privateKey,
      ).toString("base64url");
      const regRes = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed1.hostCredential}` },
        payload: { document: regDoc1, signature: validSig1 },
      });
      expect(regRes.statusCode).toBe(200);
      expect(ManagedBrowserPoolTargetResponseSchema.parse(JSON.parse(regRes.body))).toEqual({
        status: "preparing",
      });

      // 2. Host 1 appears in desired hosts, enrols (W3), and becomes ready.
      const hosts1 = BrowserPoolHostDesiredResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: browserPoolHostsDesiredPath,
              headers: h.leaseHeaders,
            })
          ).body,
        ),
      ).hosts;
      expect(hosts1).toHaveLength(1);
      const host1Id = hosts1[0]!.id;
      const host1BootToken = hosts1[0]!.bootstrapToken!;

      // Enrol and ready Host 1; test idempotent boot-complete replay and mismatch rejection.
      const enrolled1 = await h.enrolAndReadyHost(host1Id, "10.40.0.10");
      const replayEnrol = await h.app.inject({
        method: "POST",
        url: browserPoolHostBootCompletePath(host1Id),
        payload: {
          generation: 1,
          bootstrapToken: host1BootToken,
          hostKey: enrolled1.hostKey.spki,
          relayKey: enrolled1.relayKey.spki,
        },
      });
      expect(replayEnrol.statusCode).toBe(200);
      const badReplay = await h.app.inject({
        method: "POST",
        url: browserPoolHostBootCompletePath(host1Id),
        payload: {
          generation: 1,
          bootstrapToken: host1BootToken,
          hostKey: keyPairSpkiBase64().spki,
          relayKey: enrolled1.relayKey.spki,
        },
      });
      expect(badReplay.statusCode).toBe(401);

      // 3. Slot 1 is now placed on Host 1 and served in desiredSlots; provisioner journals + reports ready.
      const slots1 = BrowserPoolSlotDesiredResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: browserPoolSlotsDesiredPath,
              headers: h.leaseHeaders,
            })
          ).body,
        ),
      ).slots;
      expect(slots1).toHaveLength(1);
      const slot1 = slots1[0]!;
      expect(slot1.hostId).toBe(host1Id);
      expect(slot1.term).toBe(1);
      expect(slot1.keys).toEqual(slotKeys1);

      const writeToken = randomUUID();
      const beginRes = await h.app.inject({
        method: "POST",
        url: browserPoolSlotCheckPath(slot1.slotId),
        headers: h.leaseHeaders,
        payload: {
          operation: "begin-agent-write",
          revision: slot1.revision,
          write: { token: writeToken, kind: "create", term: 1, hostId: host1Id },
        },
      });
      expect(CloudComputerCheckResponseSchema.parse(JSON.parse(beginRes.body)).allowed).toBe(true);
      await h.app.inject({
        method: "POST",
        url: browserPoolSlotCheckPath(slot1.slotId),
        headers: h.leaseHeaders,
        payload: { operation: "finish-agent-write", token: writeToken },
      });

      const controlKey1 = keyPairSpkiBase64().spki;
      const reportSlotRes = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot1.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot1.slotId,
          revision: slot1.revision,
          term: 1,
          phase: "ready",
          controlKey: controlKey1,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });
      expect(reportSlotRes.statusCode).toBe(200);

      // Home reads its ready target (W4).
      const readyTarget = ManagedBrowserPoolTargetResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: managedBrowserPoolTargetPath,
              headers: { authorization: `Bearer ${claimed1.hostCredential}` },
            })
          ).body,
        ),
      );
      expect(readyTarget).toEqual({
        status: "ready",
        target: {
          kind: "managed-pool",
          agentUrl: "http://10.40.0.10:7310",
          slotId: slot1.slotId,
          term: 1,
          agentKey: controlKey1,
          hostKey: enrolled1.hostKey.spki,
          relay: { host: "10.40.0.10", port: 7312, relayHostKey: enrolled1.relayKey.spki },
        },
      });

      // 4. S4: Pool host pulls slot 1's exclusive egress credentials signed by enrolled host key.
      const egressNonce = "AAAAAAAAAAAAAAAAAAAAAA";
      const egressFields = {
        hostId: host1Id,
        slotId: slot1.slotId,
        issuedAt: now.toISOString(),
        nonce: egressNonce,
      };
      const egressSig = sign(
        null,
        browserPoolHostSlotEgressSigningBytes(egressFields),
        enrolled1.hostKey.privateKey,
      ).toString("base64");
      const egressPayload = { v: 1, ...egressFields, signature: egressSig };
      const egressRes = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(host1Id),
        payload: egressPayload,
      });
      expect(egressRes.statusCode).toBe(200);
      expect(CloudComputerEgressResponseSchema.parse(JSON.parse(egressRes.body))).toEqual({
        egress: {
          url: "https://egress-1.example.test:8443",
          username: "u1",
          password: "p1-secret-value",
        },
      });

      // S4: uniform refusal across failure modes (stale timestamp, wrong key, unknown slot).
      const staleFields = {
        ...egressFields,
        issuedAt: new Date(now.getTime() - 6 * 60_000).toISOString(),
      };
      const staleEgressRes = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(host1Id),
        payload: {
          v: 1,
          ...staleFields,
          signature: sign(
            null,
            browserPoolHostSlotEgressSigningBytes(staleFields),
            enrolled1.hostKey.privateKey,
          ).toString("base64"),
        },
      });
      const unknownSlotFields = {
        ...egressFields,
        slotId: `bps_${randomUUID()}` as BrowserPoolSlotId,
      };
      const unknownSlotRes = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(host1Id),
        payload: {
          v: 1,
          ...unknownSlotFields,
          signature: sign(
            null,
            browserPoolHostSlotEgressSigningBytes(unknownSlotFields),
            enrolled1.hostKey.privateKey,
          ).toString("base64"),
        },
      });
      expect(staleEgressRes.statusCode).toBe(401);
      expect(unknownSlotRes.statusCode).toBe(401);
      expect(JSON.parse(staleEgressRes.body)).toEqual(JSON.parse(unknownSlotRes.body));

      // 5. W5: Rotating keys raises term and moves status back to preparing until applied.
      const slotKeys2 = {
        homeKey: keyPairSpkiBase64().spki,
        relayKey: keyPairSpkiBase64().spki,
        ticketKey: { keyId: "tk-2", spki: keyPairSpkiBase64().spki },
      };
      const regDoc2 = { ...regDoc1, keys: slotKeys2 };
      const rotRes = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed1.hostCredential}` },
        payload: {
          document: regDoc2,
          signature: sign(
            null,
            managedBrowserPoolRegistrationSigningBytes(regDoc2),
            claimed1.hostKey.privateKey,
          ).toString("base64url"),
        },
      });
      expect(ManagedBrowserPoolTargetResponseSchema.parse(JSON.parse(rotRes.body))).toEqual({
        status: "preparing",
      });
      const updatedSlot = BrowserPoolSlotDesiredResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: browserPoolSlotsDesiredPath,
              headers: h.leaseHeaders,
            })
          ).body,
        ),
      ).slots[0]!;
      expect(updatedSlot.term).toBe(2);
      expect(updatedSlot.phase).toBe("updating_keys");

      // S6: bump-term raises term monotonically from 2 to 3.
      const bumpRes = await h.app.inject({
        method: "POST",
        url: browserPoolSlotBumpTermPath(slot1.slotId),
        headers: h.leaseHeaders,
        payload: { revision: updatedSlot.revision, expectedTerm: 2 },
      });
      expect(bumpRes.statusCode).toBe(200);
      const bumped = BrowserPoolSlotBumpTermResponseSchema.parse(JSON.parse(bumpRes.body));
      expect(bumped).toMatchObject({ bumped: true, term: 3 });

      await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot1.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot1.slotId,
          revision: bumped.revision!,
          term: 3,
          phase: "ready",
          controlKey: controlKey1,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });

      // 6. S6 + S7 + W1: Replacing host 1 bumps host generation, keeps profile disk, refuses old host key on egress,
      // puts target back in preparing until reconciler bumps slot term and re-creates on gen 2, then serves new host keys/IP.
      await runCloudComputerOperator(h.cloudStore, ["pool-host-replace", host1Id]);
      // Old host key is now refused on S4 egress pull while replacement is not enrolled!
      const oldHostEgress = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(host1Id),
        payload: egressPayload,
      });
      expect(oldHostEgress.statusCode).toBe(401);

      const enrolled2 = await h.enrolAndReadyHost(host1Id, "10.40.0.20");
      expect(enrolled2.host.generation).toBe(2);
      expect(enrolled2.host.profileDiskName).toBe(enrolled1.host.profileDiskName);
      expect(enrolled2.host.profileDiskRef).toBe(enrolled1.host.profileDiskRef);

      // Before slot is re-created on generation 2 (S6 settled), Home reads preparing.
      const preparingAfterReplace = ManagedBrowserPoolTargetResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: managedBrowserPoolTargetPath,
              headers: { authorization: `Bearer ${claimed1.hostCredential}` },
            })
          ).body,
        ),
      );
      expect(preparingAfterReplace).toEqual({ status: "preparing" });

      // Reconciler sees slot absent on new host gen 2, bumps term (3 -> 4), creates slot, reports ready.
      const slotAfterReplace = BrowserPoolSlotDesiredResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: browserPoolSlotsDesiredPath,
              headers: h.leaseHeaders,
            })
          ).body,
        ),
      ).slots[0]!;
      expect(slotAfterReplace.hostGeneration).toBe(2);
      expect(slotAfterReplace.appliedHostGeneration).toBe(1);
      const bumpAfterReplace = BrowserPoolSlotBumpTermResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "POST",
              url: browserPoolSlotBumpTermPath(slot1.slotId),
              headers: h.leaseHeaders,
              payload: { revision: slotAfterReplace.revision, expectedTerm: 3 },
            })
          ).body,
        ),
      );
      expect(bumpAfterReplace).toMatchObject({ bumped: true, term: 4 });
      const controlKey2 = keyPairSpkiBase64().spki;
      const readyGen2Res = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot1.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot1.slotId,
          revision: bumpAfterReplace.revision!,
          term: 4,
          phase: "ready",
          controlKey: controlKey2,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });
      expect(readyGen2Res.statusCode).toBe(200);

      const replacedTarget = ManagedBrowserPoolTargetResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: managedBrowserPoolTargetPath,
              headers: { authorization: `Bearer ${claimed1.hostCredential}` },
            })
          ).body,
        ),
      );
      expect(replacedTarget).toEqual({
        status: "ready",
        target: {
          kind: "managed-pool",
          agentUrl: "http://10.40.0.20:7310",
          slotId: slot1.slotId,
          term: 4,
          agentKey: controlKey2,
          hostKey: enrolled2.hostKey.spki,
          relay: { host: "10.40.0.20", port: 7312, relayHostKey: enrolled2.relayKey.spki },
        },
      });

      // 7. W10: Cannot delete a host while it still holds a slot.
      await expect(
        runCloudComputerOperator(h.cloudStore, ["pool-host-delete", host1Id]),
      ).rejects.toMatchObject({ code: "conflict" });

      // 8. W10: Deleting Cloud Computer 1 transitions its slot to deleting; VM destroyed alone does NOT tombstone computer.
      await h.cloudStore.mutate(c1.computer.id, "delete", c1.accountId);
      const compAfterDelete = await database
        .selectFrom("cloudComputers")
        .select(["state", "revision", "generation"])
        .where("id", "=", c1.computer.id)
        .executeTakeFirstOrThrow();
      expect(compAfterDelete.state).toBe("deleted");

      await h.app.inject({
        method: "POST",
        url: cloudComputerStatusPath(c1.computer.id),
        headers: leaseHeaders(h.leaseHeaders),
        payload: {
          id: c1.computer.id,
          generation: compAfterDelete.generation,
          revision: compAfterDelete.revision,
          phase: "deleted",
          providerServerId: null,
          ipv4: null,
          ipv6: null,
          observedIdentity: null,
          lastError: null,
        },
      });
      const beforeSlotErase = await database
        .selectFrom("cloudComputers")
        .select(["phase", "vmDestroyedAt", "browserSlotErasedAt", "tombstonedAt"])
        .where("id", "=", c1.computer.id)
        .executeTakeFirstOrThrow();
      expect(beforeSlotErase.vmDestroyedAt).not.toBeNull();
      expect(beforeSlotErase.browserSlotErasedAt).toBeNull();
      expect(beforeSlotErase.tombstonedAt).toBeNull();

      // Reconciler sees slot1 in state=deleting, confirms both slotErased and profileErased -> computer tombstones.
      const deletingSlots = BrowserPoolSlotDesiredResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: browserPoolSlotsDesiredPath,
              headers: h.leaseHeaders,
            })
          ).body,
        ),
      ).slots;
      expect(deletingSlots[0]?.state).toBe("deleting");
      const eraseRes = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot1.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot1.slotId,
          revision: deletingSlots[0]!.revision,
          term: deletingSlots[0]!.term,
          phase: "deleted",
          controlKey: null,
          slotErased: true,
          profileErased: true,
          credentialsErased: true,
          lastError: null,
        },
      });
      expect(eraseRes.statusCode).toBe(200);

      const afterSlotErase = await database
        .selectFrom("cloudComputers")
        .select(["phase", "browserSlotErasedAt", "tombstonedAt"])
        .where("id", "=", c1.computer.id)
        .executeTakeFirstOrThrow();
      expect(afterSlotErase.browserSlotErasedAt).not.toBeNull();
      expect(afterSlotErase.phase).toBe("deleted");
      expect(afterSlotErase.tombstonedAt).not.toBeNull();

      // Now Host 1 holds no live slots -> pool-host-delete succeeds!
      const deletedHost = await runCloudComputerOperator(h.cloudStore, [
        "pool-host-delete",
        host1Id,
      ]);
      expect(deletedHost).toMatchObject({ id: host1Id, state: "deleted" });
    } finally {
      await h.app.close();
    }
  });

  it("refuses a pool configuration where slotsPerHost * profileMib exceeds usable durable disk capacity", () => {
    // 10 GiB disk with 10% filesystem overhead reserved => 9216 MiB usable.
    // 5 slots * 2048 MiB = 10240 MiB > 9216 MiB -> refused; 4 slots * 2048 MiB = 8192 MiB -> accepted.
    expect(() =>
      loadCloudComputerConfig({
        ...makeEnv("5"),
        OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_MIB: "2048",
        OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_DISK_SIZE_GB: "10",
      }),
    ).toThrow(/exceed usable profile disk capacity/u);

    const ok = loadCloudComputerConfig({
      ...makeEnv("4"),
      OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_MIB: "2048",
      OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_DISK_SIZE_GB: "10",
    });
    expect(ok?.browserPool).toMatchObject({
      slotsPerHost: 4,
      profileMib: 2048,
      profileDiskSizeGb: 10,
    });
  });

  it("places slots onto the ready host with the most free slots and grows host count when full (W2)", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease();
      const c1 = await h.provisionComputer(1);
      const c2 = await h.provisionComputer(2);
      const c3 = await h.provisionComputer(3);
      for (const c of [c1, c2, c3]) await h.bootAndClaimComputer(c.computer, c.accountId);

      // 3 pooled computers with slotsPerHost=2 -> 2 pool hosts wanted.
      const hosts = BrowserPoolHostDesiredResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: browserPoolHostsDesiredPath,
              headers: h.leaseHeaders,
            })
          ).body,
        ),
      ).hosts;
      expect(hosts).toHaveLength(2);
      await h.enrolAndReadyHost(hosts[0]!.id, "10.40.0.10");
      await h.enrolAndReadyHost(hosts[1]!.id, "10.40.0.11");

      // Trigger placement by querying desiredSlots; 3 slots across 2 hosts -> 2 on one, 1 on the other (most-free).
      await h.app.inject({
        method: "GET",
        url: browserPoolSlotsDesiredPath,
        headers: h.leaseHeaders,
      });
      const placed = await database
        .selectFrom("browserPoolSlots")
        .select(["hostId"])
        .where("hostId", "is not", null)
        .execute();
      expect(placed).toHaveLength(3);
      const counts = new Map<string, number>();
      for (const row of placed) counts.set(row.hostId!, (counts.get(row.hostId!) ?? 0) + 1);
      expect([...counts.values()].sort()).toEqual([1, 2]);
      expect(
        (await sql<{ n: string }>`select count(*)::text as n from browser_pool_hosts`.execute(
          database,
        )).rows[0]?.n,
      ).toBe("2");
    } finally {
      await h.app.close();
    }
  });
});

function leaseHeaders(headers: Record<string, string>) {
  return headers;
}
