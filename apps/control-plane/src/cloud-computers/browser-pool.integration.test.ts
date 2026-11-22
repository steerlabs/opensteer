import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import {
  BrowserPoolHostBootCompleteResponseSchema,
  BrowserPoolHostBootResponseSchema,
  BrowserPoolHostDesiredResponseSchema,
  BrowserPoolHostReplaceUnreadyResponseSchema,
  BrowserPoolSlotBumpTermResponseSchema,
  BrowserPoolSlotDesiredResponseSchema,
  CloudComputerBootResponseSchema,
  CloudComputerCheckResponseSchema,
  CloudComputerEgressResponseSchema,
  CloudComputerEgressSchema,
  CloudComputerIdentitySchema,
  CloudComputerReportResponseSchema,
  ControlPlaneAccountIdSchema,
  ManagedBrowserPoolTargetResponseSchema,
  browserPoolHostBootCompletePath,
  browserPoolHostBootPath,
  browserPoolHostReplaceUnreadyPath,
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
  type CloudComputerId,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  HostDiscoveryDocumentSchema,
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
} from "@opensteer/deployment-authority";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { ControlPlaneAuthenticator, createControlPlaneAuth } from "../auth/auth.js";
import { createHostCredential, hashCredential } from "../auth/credentials.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneStore } from "../database/store.js";
import { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { createControlPlaneServer } from "../server/server.js";
import { testBackupVault } from "./backup-erasure.test-support.js";
import { loadCloudComputerConfig } from "./config.js";
import { runCloudComputerOperator } from "./operator.js";
import { resetManagedCloudTables } from "./reset.test-support.js";
import { CloudComputerStore } from "./store.js";
import type { StripeBilling, StripeSubscription } from "./stripe.js";

const url = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// Requires PostgreSQL via OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL; skip outside integration runs.
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

const uniformEgressRefusal = {
  error: {
    code: "unauthorized",
    message: "Browser pool slot egress request was refused",
  },
};

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

function makeHomeKeys(ticketKeyId = "tk-1") {
  return {
    homeKey: keyPairSpkiBase64().spki,
    relayKey: keyPairSpkiBase64().spki,
    ticketKey: { keyId: ticketKeyId, spki: keyPairSpkiBase64().spki },
  };
}

function makeDiscoveryEnvelope(
  origin: string,
  deploymentId: string,
  privateKey: KeyObject,
  spkiBase64Url: string,
) {
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

function signSlotEgress(
  hostId: BrowserPoolHostId,
  slotId: BrowserPoolSlotId,
  issuedAt: string,
  privateKey: KeyObject,
  nonce = Buffer.alloc(16, 1).toString("base64url"),
) {
  const payload = { v: 1 as const, hostId, slotId, issuedAt, nonce };
  return {
    ...payload,
    signature: sign(null, browserPoolHostSlotEgressSigningBytes(payload), privateKey).toString(
      "base64",
    ),
  };
}

function signRegistration(
  cloudComputerId: CloudComputerId,
  issuedAt: string,
  keys: ReturnType<typeof makeHomeKeys>,
  privateKey: KeyObject,
) {
  const document = {
    purpose: "opensteer-managed-browser-pool-registration" as const,
    documentVersion: 1 as const,
    cloudComputerId,
    issuedAt,
    keys,
  };
  return {
    document,
    signature: sign(
      null,
      managedBrowserPoolRegistrationSigningBytes(document),
      privateKey,
    ).toString("base64url"),
  };
}

integration("Browser pool Account service", () => {
  const database = createControlPlaneDatabase({ connectionString: url!, maxConnections: 6 });
  const subscriptions = new Map<string, StripeSubscription>();
  const stripe: StripeBilling = {
    checkout: vi.fn(async () => ({
      id: `cs_${randomUUID()}`,
      url: "https://checkout.example.test",
    })),
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

  async function buildHarness(
    slotsPerHost?: string,
    db: Kysely<ControlPlaneDatabaseSchema> = database,
  ) {
    const config = loadCloudComputerConfig(makeEnv(slotsPerHost))!;
    const cloudStore = new CloudComputerStore(db, {
      config,
      accountOrigin: publicOrigin,
      cipher,
      stripe,
      now: () => now,
      backupKeyVault: testBackupVault(),
      purgeBackupStep: async () => true,
    });
    const auth = createControlPlaneAuth(db, {
      authSecret,
      publicOrigin,
    });
    const controlStore = new ControlPlaneStore(db, publicOrigin, {
      adoptionCompletionGrantIssuer: { issueGrant: vi.fn() } as never,
      adoptionOperationCipher: cipher as never,
      adoptionProofVerifier: { verify: vi.fn() } as never,
      portalOrigin,
    });
    const app = await createControlPlaneServer(
      {
        auth,
        authenticator: new ControlPlaneAuthenticator(auth, db, publicOrigin),
        connectLifecycle: new ConnectLifecycleService(
          db,
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
    const acquireLease = async (poolConfigured = slotsPerHost !== undefined) => {
      const response = await app.inject({
        method: "POST",
        url: cloudComputerLeasePath,
        headers: { authorization: "Bearer provisioner-ok" },
        payload: { holder: leaseHolder, poolConfigured },
      });
      expect(response.statusCode).toBe(200);
    };

    const seenComputerIds = new Set<string>();
    const provisionComputer = async (n: number) => {
      const accountId = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
      await db
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
      await db
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

      const hostCredential = createHostCredential();
      const envelope = makeDiscoveryEnvelope(
        `https://${computer.hostname}`,
        deploymentId,
        hostKey.privateKey,
        hostKey.spkiBase64Url,
      );
      await db
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
          accountLink: {
            generation: "a".repeat(43),
            issuer: publicOrigin.origin,
            subject: accountId,
          },
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      await db
        .insertInto("deploymentCredentials")
        .values({
          deploymentId: deploymentId as never,
          tokenHash: hashCredential(hostCredential),
          createdAt: now,
          rotatedAt: now,
        })
        .execute();
      await db
        .updateTable("cloudComputers")
        .set({ phase: "ready", bootstrapReceiptAt: now })
        .where("id", "=", computer.id)
        .execute();

      return { boot, hostKey, hostCredential, deploymentId };
    };

    const getDesiredHosts = async () =>
      BrowserPoolHostDesiredResponseSchema.parse(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: browserPoolHostsDesiredPath,
              headers: leaseHeaders,
            })
          ).body,
        ),
      ).hosts;

    const getDesiredSlots = async () =>
      BrowserPoolSlotDesiredResponseSchema.parse(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: browserPoolSlotsDesiredPath,
              headers: leaseHeaders,
            })
          ).body,
        ),
      ).slots;

    const openHostBootWindow = async (hostId: BrowserPoolHostId, ip: string) => {
      const host = (await getDesiredHosts()).find((h) => h.id === hostId)!;
      expect(host.bootstrapToken).toBeDefined();
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
      return host;
    };

    const enrolAndReadyHost = async (hostId: BrowserPoolHostId, ip: string) => {
      const host = await openHostBootWindow(hostId, ip);
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

      const afterEnrol = (await getDesiredHosts()).find((h) => h.id === host.id)!;
      expect(afterEnrol.enrolled).toBe(true);
      expect(afterEnrol.everEnrolled).toBe(true);
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
      return { hostKey, relayKey, host: afterEnrol, bootstrapToken: host.bootstrapToken! };
    };

    const setupPooledHomeAndHost = async (ip = "10.40.0.10") => {
      await acquireLease(true);
      const { accountId, computer } = await provisionComputer(1);
      const claimed = await bootAndClaimComputer(computer, accountId);
      const hosts = await getDesiredHosts();
      expect(hosts).toHaveLength(1);
      const hostId = hosts[0]!.id;
      const enrolled = await enrolAndReadyHost(hostId, ip);
      const homeKeys = makeHomeKeys("tk-1");
      const regRes = await app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed.hostCredential}` },
        payload: signRegistration(
          computer.id,
          now.toISOString(),
          homeKeys,
          claimed.hostKey.privateKey,
        ),
      });
      expect(regRes.statusCode).toBe(200);
      const desiredSlots = await getDesiredSlots();
      expect(desiredSlots).toHaveLength(1);
      return {
        accountId,
        computer,
        claimed,
        hostId,
        enrolled,
        homeKeys,
        slot: desiredSlots[0]!,
      };
    };

    return {
      app,
      cloudStore,
      leaseHeaders,
      acquireLease,
      provisionComputer,
      bootAndClaimComputer,
      getDesiredHosts,
      getDesiredSlots,
      openHostBootWindow,
      enrolAndReadyHost,
      setupPooledHomeAndHost,
    };
  }

  // --- Config & S8 (pooling unset) ---

  it("refuses a pool configuration where slotsPerHost * profileMib exceeds usable durable disk capacity", () => {
    expect(() =>
      loadCloudComputerConfig({
        ...makeEnv("250"),
        OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_MIB: "2048",
        OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_DISK_SIZE_GB: "500",
      }),
    ).toThrow(/exceed usable profile disk capacity/u);

    const exact = loadCloudComputerConfig({
      ...makeEnv("225"),
      OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_MIB: "2048",
      OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_DISK_SIZE_GB: "500",
    });
    expect(exact?.browserPool?.slotsPerHost).toBe(225);
    expect(exact?.browserPool?.profileMib).toBe(2048);
    expect(exact?.browserPool?.profileDiskSizeGb).toBe(500);
  });

  it("runs no pool SQL statement and wants no host when pooling is unset (S8)", async () => {
    const executedSql: string[] = [];
    const loggedPool = new Pool({
      application_name: "opensteer-control-plane-sql-spy",
      connectionString: url!,
      max: 4,
    });
    const loggedDb = new Kysely<ControlPlaneDatabaseSchema>({
      dialect: new PostgresDialect({ pool: loggedPool }),
      plugins: [new CamelCasePlugin()],
      log: (event) => {
        if (event.level === "query") executedSql.push(event.query.sql);
      },
    });
    const h = await buildHarness(undefined, loggedDb);
    try {
      await h.acquireLease(false);
      const { accountId, computer } = await h.provisionComputer(1);
      const { boot } = await h.bootAndClaimComputer(computer, accountId);
      expect(boot.browserPool).toBeUndefined();

      expect(await h.getDesiredHosts()).toEqual([]);
      expect(await h.getDesiredSlots()).toEqual([]);

      await h.cloudStore.mutate(computer.id, "delete", accountId);

      const poolStatements = executedSql.filter((statement) =>
        /browser_pool|browser-pool/iu.test(statement),
      );
      expect(poolStatements).toEqual([]);
    } finally {
      await h.app.close();
      await loggedDb.destroy();
    }
  });

  it("returns 404 on both Home browser-pool routes for a non-pooled Cloud Computer", async () => {
    const h = await buildHarness(undefined);
    try {
      await h.acquireLease(false);
      const { accountId, computer } = await h.provisionComputer(1);
      const { hostCredential, hostKey } = await h.bootAndClaimComputer(computer, accountId);

      const targetRes = await h.app.inject({
        method: "GET",
        url: managedBrowserPoolTargetPath,
        headers: { authorization: `Bearer ${hostCredential}` },
      });
      expect(targetRes.statusCode).toBe(404);

      const regRes = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${hostCredential}` },
        payload: signRegistration(
          computer.id,
          now.toISOString(),
          makeHomeKeys(),
          hostKey.privateKey,
        ),
      });
      expect(regRes.statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  // --- W2 placement, draining, concurrency, and T7 lock order ---

  it("places slots onto the ready host with the most free slots and grows host count when full (W2)", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      const host1Id = (await h.getDesiredHosts())[0]!.id;
      await h.enrolAndReadyHost(host1Id, "10.40.0.10");

      await h.provisionComputer(2);
      await h.provisionComputer(3);
      const hosts = await h.getDesiredHosts();
      expect(hosts).toHaveLength(2);
      const host2Id = hosts.find((entry) => entry.id !== host1Id)!.id;
      await h.enrolAndReadyHost(host2Id, "10.40.0.11");

      await h.getDesiredHosts();
      const before = await database
        .selectFrom("browserPoolSlots")
        .select(["computerId", "hostId"])
        .where("tombstonedAt", "is", null)
        .execute();
      const counts = new Map<string, number>();
      for (const row of before) {
        if (row.hostId) counts.set(row.hostId, (counts.get(row.hostId) ?? 0) + 1);
      }
      expect(counts.get(host1Id)).toBe(2);
      expect(counts.get(host2Id)).toBe(1);

      const c4 = await h.provisionComputer(4);
      await h.getDesiredHosts();
      const slot4 = await database
        .selectFrom("browserPoolSlots")
        .select(["hostId"])
        .where("computerId", "=", c4.computer.id)
        .executeTakeFirstOrThrow();
      expect(slot4.hostId).toBe(host2Id);
    } finally {
      await h.app.close();
    }
  });

  it("never places a new slot on a draining host", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      const host1Id = (await h.getDesiredHosts())[0]!.id;
      await h.enrolAndReadyHost(host1Id, "10.40.0.10");
      await h.getDesiredHosts();

      await runCloudComputerOperator(h.cloudStore, ["pool-host-drain", host1Id]);

      const c2 = await h.provisionComputer(2);
      const hosts = await h.getDesiredHosts();
      expect(hosts).toHaveLength(2);
      const slot2 = await database
        .selectFrom("browserPoolSlots")
        .select(["hostId"])
        .where("computerId", "=", c2.computer.id)
        .executeTakeFirstOrThrow();
      expect(slot2.hostId).toBeNull();

      const host2Id = hosts.find((entry) => entry.id !== host1Id)!.id;
      await h.enrolAndReadyHost(host2Id, "10.40.0.11");
      await h.getDesiredHosts();
      const placed2 = await database
        .selectFrom("browserPoolSlots")
        .select(["hostId"])
        .where("computerId", "=", c2.computer.id)
        .executeTakeFirstOrThrow();
      expect(placed2.hostId).toBe(host2Id);
    } finally {
      await h.app.close();
    }
  });

  it("serializes two Cloud Computers racing for the last free slot without oversubscribing a host", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      const host1Id = (await h.getDesiredHosts())[0]!.id;
      await h.enrolAndReadyHost(host1Id, "10.40.0.10");
      await h.getDesiredHosts();

      const c2 = await h.provisionComputer(2);
      const c3 = await h.provisionComputer(3);
      await Promise.all([
        h.getDesiredHosts(),
        h.getDesiredHosts(),
        h.getDesiredSlots(),
        h.getDesiredSlots(),
      ]);

      const slots = await database
        .selectFrom("browserPoolSlots")
        .select(["computerId", "hostId"])
        .where("tombstonedAt", "is", null)
        .execute();
      const onHost1 = slots.filter((row) => row.hostId === host1Id);
      const unplaced = slots.filter((row) => row.hostId === null);
      expect(onHost1).toHaveLength(2);
      expect(unplaced).toHaveLength(1);
      expect([c2.computer.id, c3.computer.id]).toContain(unplaced[0]!.computerId);
      expect(await h.getDesiredHosts()).toHaveLength(2);
    } finally {
      await h.app.close();
    }
  });

  it("preserves declared lock order in #reconcileCapacity when syncing externally deleted Cloud Computers (T7)", async () => {
    const h = await buildHarness("2");
    try {
      const { computer, slot } = await h.setupPooledHomeAndHost();
      // Simulate an external Cloud Computer deletion outside #refreshSubscription (e.g. org offboard).
      await sql`
        update cloud_computers set state = 'deleted', deleted_at = now() where id = ${computer.id}
      `.execute(database);

      // Under OPENSTEER_LOCK_ORDER_MODE=enforce this must sync the slot to deleting without
      // ever locking browser_pool_slots before browser_pool_hosts.
      await h.getDesiredHosts();
      const updated = await database
        .selectFrom("browserPoolSlots")
        .select(["state", "phase"])
        .where("slotId", "=", slot.slotId)
        .executeTakeFirstOrThrow();
      expect(updated).toEqual({ state: "deleting", phase: "deleting" });
    } finally {
      await h.app.close();
    }
  });

  // --- W3 enrolment token guards ---

  it("refuses pool host enrolment when the bootstrap token belongs to another host", async () => {
    const h = await buildHarness("1");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      await h.provisionComputer(2);
      const hosts = await h.getDesiredHosts();
      expect(hosts).toHaveLength(2);
      const hostA = await h.openHostBootWindow(hosts[0]!.id, "10.40.0.10");
      const hostB = await h.openHostBootWindow(hosts[1]!.id, "10.40.0.11");

      const res = await h.app.inject({
        method: "POST",
        url: browserPoolHostBootCompletePath(hostB.id),
        payload: {
          generation: hostB.generation,
          bootstrapToken: hostA.bootstrapToken,
          hostKey: keyPairSpkiBase64().spki,
          relayKey: keyPairSpkiBase64().spki,
        },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.app.close();
    }
  });

  it("refuses pool host enrolment when the generation does not match the host", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      const hostId = (await h.getDesiredHosts())[0]!.id;
      const host = await h.openHostBootWindow(hostId, "10.40.0.10");

      const wrongGen = await h.app.inject({
        method: "POST",
        url: browserPoolHostBootCompletePath(host.id),
        payload: {
          generation: host.generation + 1,
          bootstrapToken: host.bootstrapToken,
          hostKey: keyPairSpkiBase64().spki,
          relayKey: keyPairSpkiBase64().spki,
        },
      });
      expect(wrongGen.statusCode).toBe(401);

      await runCloudComputerOperator(h.cloudStore, ["pool-host-replace", host.id]);
      await h.openHostBootWindow(host.id, "10.40.0.12");
      const staleGen = await h.app.inject({
        method: "POST",
        url: browserPoolHostBootCompletePath(host.id),
        payload: {
          generation: 1,
          bootstrapToken: host.bootstrapToken,
          hostKey: keyPairSpkiBase64().spki,
          relayKey: keyPairSpkiBase64().spki,
        },
      });
      expect(staleGen.statusCode).toBe(401);
    } finally {
      await h.app.close();
    }
  });

  it("refuses pool host enrolment when the bootstrap token has expired", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      const hostId = (await h.getDesiredHosts())[0]!.id;
      const host = await h.openHostBootWindow(hostId, "10.40.0.10");

      now = new Date(now.getTime() + 21 * 60_000);
      const res = await h.app.inject({
        method: "POST",
        url: browserPoolHostBootCompletePath(host.id),
        payload: {
          generation: host.generation,
          bootstrapToken: host.bootstrapToken,
          hostKey: keyPairSpkiBase64().spki,
          relayKey: keyPairSpkiBase64().spki,
        },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.app.close();
    }
  });

  it("makes pool host enrolment idempotent when replayed with the same keys", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      const hostId = (await h.getDesiredHosts())[0]!.id;
      const { host, hostKey, relayKey, bootstrapToken } = await h.enrolAndReadyHost(
        hostId,
        "10.40.0.10",
      );

      const replay = await h.app.inject({
        method: "POST",
        url: browserPoolHostBootCompletePath(host.id),
        payload: {
          generation: host.generation,
          bootstrapToken,
          hostKey: hostKey.spki,
          relayKey: relayKey.spki,
        },
      });
      expect(replay.statusCode).toBe(200);
      expect(BrowserPoolHostBootCompleteResponseSchema.parse(JSON.parse(replay.body))).toEqual({
        completed: true,
      });
    } finally {
      await h.app.close();
    }
  });

  it("refuses pool host enrolment when replayed with different keys (single-use)", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      const hostId = (await h.getDesiredHosts())[0]!.id;
      const { host, hostKey, bootstrapToken } = await h.enrolAndReadyHost(hostId, "10.40.0.10");

      const replayDifferent = await h.app.inject({
        method: "POST",
        url: browserPoolHostBootCompletePath(host.id),
        payload: {
          generation: host.generation,
          bootstrapToken,
          hostKey: keyPairSpkiBase64().spki,
          relayKey: keyPairSpkiBase64().spki,
        },
      });
      expect(replayDifferent.statusCode).toBe(401);

      const row = await database
        .selectFrom("browserPoolHosts")
        .select(["hostPublicKey"])
        .where("id", "=", hostId)
        .executeTakeFirstOrThrow();
      expect(row.hostPublicKey).toBe(hostKey.spki);
    } finally {
      await h.app.close();
    }
  });

  // --- T8 unenrolled host auto-replacement ---

  it("allows replacing an unenrolled host up to twice and refuses auto-replacement once enrolled or after two retries (T8)", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      const hostId = (await h.getDesiredHosts())[0]!.id;

      // Retry 1: gen 1 -> gen 2.
      let host = (await h.getDesiredHosts())[0]!;
      const r1 = BrowserPoolHostReplaceUnreadyResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "POST",
              url: browserPoolHostReplaceUnreadyPath(hostId),
              headers: h.leaseHeaders,
              payload: { revision: host.revision, generation: host.generation },
            })
          ).body,
        ),
      );
      expect(r1).toMatchObject({ replaced: true, generation: 2 });

      // Retry 2: gen 2 -> gen 3.
      host = (await h.getDesiredHosts())[0]!;
      const r2 = BrowserPoolHostReplaceUnreadyResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "POST",
              url: browserPoolHostReplaceUnreadyPath(hostId),
              headers: h.leaseHeaders,
              payload: { revision: host.revision, generation: host.generation },
            })
          ).body,
        ),
      );
      expect(r2).toMatchObject({ replaced: true, generation: 3 });

      // Retry 3: cap of 2 reached -> refused.
      host = (await h.getDesiredHosts())[0]!;
      const r3 = BrowserPoolHostReplaceUnreadyResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "POST",
              url: browserPoolHostReplaceUnreadyPath(hostId),
              headers: h.leaseHeaders,
              payload: { revision: host.revision, generation: host.generation },
            })
          ).body,
        ),
      );
      expect(r3).toEqual({ replaced: false });

      // An enrolled host can NEVER be auto-replaced even if autoReplaceCount === 0.
      await h.enrolAndReadyHost(hostId, "10.40.0.10");
      await sql`
        update browser_pool_hosts set auto_replace_count = 0 where id = ${hostId}
      `.execute(database);
      host = (await h.getDesiredHosts())[0]!;
      const enrolledAttempt = BrowserPoolHostReplaceUnreadyResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "POST",
              url: browserPoolHostReplaceUnreadyPath(hostId),
              headers: h.leaseHeaders,
              payload: { revision: host.revision, generation: host.generation },
            })
          ).body,
        ),
      );
      expect(enrolledAttempt).toEqual({ replaced: false });
    } finally {
      await h.app.close();
    }
  });

  // --- S4 + T9 slot-egress pull guards ---

  it("refuses slot-egress for another host's slot with the uniform refusal", async () => {
    const h = await buildHarness("1");
    try {
      await h.acquireLease(true);
      await h.provisionComputer(1);
      await h.provisionComputer(2);
      const hosts = await h.getDesiredHosts();
      const host1 = await h.enrolAndReadyHost(hosts[0]!.id, "10.40.0.10");
      await h.enrolAndReadyHost(hosts[1]!.id, "10.40.0.11");
      await h.getDesiredHosts();
      const slots = await database
        .selectFrom("browserPoolSlots")
        .select(["slotId", "hostId"])
        .execute();
      const slotOnHost2 = slots.find((s) => s.hostId === hosts[1]!.id)!;

      const res = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hosts[0]!.id),
        payload: signSlotEgress(
          hosts[0]!.id,
          slotOnHost2.slotId,
          now.toISOString(),
          host1.hostKey.privateKey,
        ),
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual(uniformEgressRefusal);
    } finally {
      await h.app.close();
    }
  });

  it("refuses slot-egress for an unenrolled host with the uniform refusal", async () => {
    const h = await buildHarness("2");
    try {
      // A host with a placed slot whose replacement has not enrolled yet (enrolledAt/hostPublicKey are null).
      const { hostId, enrolled, slot } = await h.setupPooledHomeAndHost();
      await runCloudComputerOperator(h.cloudStore, ["pool-host-replace", hostId]);

      const res = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
        ),
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual(uniformEgressRefusal);
    } finally {
      await h.app.close();
    }
  });

  it("refuses slot-egress signed with an old generation's host key with the uniform refusal", async () => {
    const h = await buildHarness("2");
    try {
      const { hostId, enrolled, slot } = await h.setupPooledHomeAndHost();
      const oldGen1Key = enrolled.hostKey.privateKey;

      await runCloudComputerOperator(h.cloudStore, ["pool-host-replace", hostId]);
      await h.enrolAndReadyHost(hostId, "10.40.0.12");

      const res = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(hostId, slot.slotId, now.toISOString(), oldGen1Key),
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual(uniformEgressRefusal);
    } finally {
      await h.app.close();
    }
  });

  it("refuses slot-egress outside the five-minute timestamp window with the uniform refusal", async () => {
    const h = await buildHarness("2");
    try {
      const { hostId, enrolled, slot } = await h.setupPooledHomeAndHost();
      const staleTs = new Date(now.getTime() - 6 * 60_000).toISOString();

      const res = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(hostId, slot.slotId, staleTs, enrolled.hostKey.privateKey),
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual(uniformEgressRefusal);
    } finally {
      await h.app.close();
    }
  });

  it("refuses slot-egress for a deleting Cloud Computer with the uniform refusal", async () => {
    const h = await buildHarness("2");
    try {
      const { accountId, computer, hostId, enrolled, slot } = await h.setupPooledHomeAndHost();
      await h.cloudStore.mutate(computer.id, "delete", accountId);

      const res = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
        ),
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual(uniformEgressRefusal);
    } finally {
      await h.app.close();
    }
  });

  it("refuses slot-egress for a suspended Cloud Computer or a deleting slot with the uniform refusal", async () => {
    const h = await buildHarness("2");
    try {
      const { computer, hostId, enrolled, slot } = await h.setupPooledHomeAndHost();
      await h.cloudStore.mutate(computer.id, "operator-suspend", undefined, "Abuse investigation");

      const suspendedRes = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
        ),
      });
      expect(suspendedRes.statusCode).toBe(401);
      expect(JSON.parse(suspendedRes.body)).toEqual(uniformEgressRefusal);

      // Unsuspend computer, but mark slot deleting -> still refused identically.
      await h.cloudStore.mutate(computer.id, "operator-unsuspend");
      await database
        .updateTable("browserPoolSlots")
        .set({ state: "deleting", phase: "deleting" })
        .where("slotId", "=", slot.slotId)
        .execute();
      const deletingSlotRes = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
          Buffer.alloc(16, 4).toString("base64url"),
        ),
      });
      expect(deletingSlotRes.statusCode).toBe(401);
      expect(JSON.parse(deletingSlotRes.body)).toEqual(uniformEgressRefusal);
    } finally {
      await h.app.close();
    }
  });

  it("returns exact {} when no egress endpoint is assigned, exact {egress} when available, and hides egress password from the pooled Home (S4+T9)", async () => {
    const h = await buildHarness("2");
    try {
      const { computer, claimed, hostId, enrolled, slot } = await h.setupPooledHomeAndHost();

      const emptyRes = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
        ),
      });
      expect(emptyRes.statusCode).toBe(200);
      const emptyBody = JSON.parse(emptyRes.body) as Record<string, unknown>;
      expect(Object.keys(emptyBody)).toEqual([]);
      expect(CloudComputerEgressResponseSchema.parse(emptyBody)).toEqual({});

      await h.cloudStore.addEgressEndpoint({
        url: "https://egress.example.test:8443",
        username: "egress-user",
        password: "egress-password",
        publicAddress: "198.51.100.10",
      });
      const assignedRes = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
          Buffer.alloc(16, 2).toString("base64url"),
        ),
      });
      expect(assignedRes.statusCode).toBe(200);
      const assignedBody = JSON.parse(assignedRes.body) as Record<string, unknown>;
      expect(Object.keys(assignedBody)).toEqual(["egress"]);
      expect(CloudComputerEgressResponseSchema.parse(assignedBody)).toEqual({
        egress: {
          url: "https://egress.example.test:8443",
          username: "egress-user",
          password: "egress-password",
        },
      });

      // T9: The pooled Cloud Computer's own Home must NOT receive the egress password on GET /egress.
      const basicAuth =
        "Basic " +
        Buffer.from(
          `${claimed.boot.managedHome!.oidc.clientId}:${claimed.boot.managedHome!.oidc.clientSecret}`,
        ).toString("base64");
      const homeEgressRes = await h.app.inject({
        method: "GET",
        url: `/v1/cloud-computers/${encodeURIComponent(computer.id)}/egress`,
        headers: { authorization: basicAuth },
      });
      expect(homeEgressRes.statusCode).toBe(200);
      expect(JSON.parse(homeEgressRes.body)).toEqual({});
    } finally {
      await h.app.close();
    }
  });

  it("rate-limits slot-egress per host and slot so one host can fetch egress for many slots at boot and cold-start a slot repeatedly while refusing a flood (T9)", async () => {
    const h = await buildHarness("2");
    try {
      const { hostId, enrolled, slot } = await h.setupPooledHomeAndHost();

      // 35 distinct slot IDs on the same host within the same minute must NOT trigger 429.
      for (let i = 0; i < 35; i++) {
        const fakeSlot = `bps_${randomUUID()}` as BrowserPoolSlotId;
        const res = await h.app.inject({
          method: "POST",
          url: browserPoolHostSlotEgressPath(hostId),
          payload: signSlotEgress(
            hostId,
            fakeSlot,
            now.toISOString(),
            enrolled.hostKey.privateKey,
            Buffer.alloc(16, i + 1).toString("base64url"),
          ),
        });
        // Refused as unknown slot (401), never 429 rate_limited.
        expect(res.statusCode).toBe(401);
      }

      // Cold-starting the same (hostId, slotId) up to the 30/min limit all succeed (200)...
      for (let i = 0; i < 30; i++) {
        const res = await h.app.inject({
          method: "POST",
          url: browserPoolHostSlotEgressPath(hostId),
          payload: signSlotEgress(
            hostId,
            slot.slotId,
            now.toISOString(),
            enrolled.hostKey.privateKey,
            Buffer.alloc(16, i + 40).toString("base64url"),
          ),
        });
        expect(res.statusCode).toBe(200);
      }
      // ...and a 31st request in the same minute is refused as a flood (429).
      const flood = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
          Buffer.alloc(16, 99).toString("base64url"),
        ),
      });
      expect(flood.statusCode).toBe(429);
      expect(flood.headers["retry-after"]).toBe("60");
    } finally {
      await h.app.close();
    }
  });

  it("keeps repeated cold-start slot-egress calls idempotent with no second assignment, reflects reassignment, and answers {} only when unassigned", async () => {
    const h = await buildHarness("2");
    try {
      const { computer, hostId, enrolled, slot } = await h.setupPooledHomeAndHost();
      const ep1Id = await h.cloudStore.addEgressEndpoint({
        url: "https://egress-one.example.test:8443",
        username: "user-one",
        password: "password-one",
        publicAddress: "198.51.100.11",
      });
      const ep2Id = await h.cloudStore.addEgressEndpoint({
        url: "https://egress-two.example.test:8443",
        username: "user-two",
        password: "password-two",
        publicAddress: "198.51.100.12",
      });

      const first = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
          Buffer.alloc(16, 1).toString("base64url"),
        ),
      });
      expect(first.statusCode).toBe(200);
      const firstBody = CloudComputerEgressResponseSchema.parse(JSON.parse(first.body));
      expect(firstBody.egress).toBeDefined();
      expect(CloudComputerEgressSchema.parse(firstBody.egress)).toEqual(firstBody.egress);

      // Second and third cold-start calls return the exact same credentials and do NOT assign the second free endpoint.
      for (let i = 2; i <= 3; i++) {
        const repeat = await h.app.inject({
          method: "POST",
          url: browserPoolHostSlotEgressPath(hostId),
          payload: signSlotEgress(
            hostId,
            slot.slotId,
            now.toISOString(),
            enrolled.hostKey.privateKey,
            Buffer.alloc(16, i).toString("base64url"),
          ),
        });
        expect(repeat.statusCode).toBe(200);
        expect(JSON.parse(repeat.body)).toEqual(firstBody);
      }

      const endpointsAfterRepeats = await database
        .selectFrom("cloudComputerEgressEndpoints")
        .select(["id", "computerId"])
        .where("id", "in", [ep1Id, ep2Id])
        .execute();
      const assignedRows = endpointsAfterRepeats.filter((row) => row.computerId === computer.id);
      const freeRows = endpointsAfterRepeats.filter((row) => row.computerId === null);
      expect(assignedRows).toHaveLength(1);
      expect(freeRows).toHaveLength(1);

      // Reassigning the endpoint takes effect on the next cold start.
      const originalId = assignedRows[0]!.id;
      const replacementId = freeRows[0]!.id;
      await database
        .updateTable("cloudComputerEgressEndpoints")
        .set({ computerId: null, needsRotation: true })
        .where("id", "=", originalId)
        .execute();
      const reassigned = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
          Buffer.alloc(16, 4).toString("base64url"),
        ),
      });
      expect(reassigned.statusCode).toBe(200);
      const reassignedBody = CloudComputerEgressResponseSchema.parse(JSON.parse(reassigned.body));
      expect(reassignedBody.egress?.url).not.toBe(firstBody.egress?.url);

      // When no endpoint is assigned and none is free, the route answers exact {}.
      await database
        .updateTable("cloudComputerEgressEndpoints")
        .set({ computerId: null, needsRotation: true })
        .where("id", "=", replacementId)
        .execute();
      const unassigned = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
          Buffer.alloc(16, 5).toString("base64url"),
        ),
      });
      expect(unassigned.statusCode).toBe(200);
      expect(JSON.parse(unassigned.body)).toEqual({});
    } finally {
      await h.app.close();
    }
  });

  it("rejects invalid egress endpoints on add (port 0, whitespace-only values, over-long address) and guarantees slot-egress answers pass CloudComputerEgressSchema", async () => {
    const h = await buildHarness("2");
    try {
      const { hostId, enrolled, slot } = await h.setupPooledHomeAndHost();

      await expect(
        h.cloudStore.addEgressEndpoint({
          url: "https://egress.example.test:0",
          username: "user",
          password: "secret-password",
        }),
      ).rejects.toMatchObject({ code: "bad_request" });

      await expect(
        h.cloudStore.addEgressEndpoint({
          url: "https://egress.example.test:8443",
          username: "   ",
          password: "secret-password",
        }),
      ).rejects.toMatchObject({ code: "bad_request" });

      await expect(
        h.cloudStore.addEgressEndpoint({
          url: "https://egress.example.test:8443",
          username: "user",
          password: "   	  ",
        }),
      ).rejects.toMatchObject({ code: "bad_request" });

      await expect(
        h.cloudStore.addEgressEndpoint({
          url: `https://${"a".repeat(2050)}.example.test:8443`,
          username: "user",
          password: "secret-password",
        }),
      ).rejects.toMatchObject({ code: "bad_request" });

      await h.cloudStore.addEgressEndpoint({
        url: "https://egress-valid.example.test:8443/",
        username: "valid-user",
        password: "valid-password",
        publicAddress: "198.51.100.19",
      });
      const res = await h.app.inject({
        method: "POST",
        url: browserPoolHostSlotEgressPath(hostId),
        payload: signSlotEgress(
          hostId,
          slot.slotId,
          now.toISOString(),
          enrolled.hostKey.privateKey,
        ),
      });
      expect(res.statusCode).toBe(200);
      const parsed = CloudComputerEgressResponseSchema.parse(JSON.parse(res.body));
      expect(CloudComputerEgressSchema.parse(parsed.egress)).toEqual({
        url: "https://egress-valid.example.test:8443",
        username: "valid-user",
        password: "valid-password",
      });
    } finally {
      await h.app.close();
    }
  });

  // --- W4 + S5 + T4 Home key registration guards ---

  it("refuses Home key registration without a signature", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      const { accountId, computer } = await h.provisionComputer(1);
      const { hostCredential } = await h.bootAndClaimComputer(computer, accountId);

      const res = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${hostCredential}` },
        payload: {
          document: {
            purpose: "opensteer-managed-browser-pool-registration",
            documentVersion: 1,
            cloudComputerId: computer.id,
            issuedAt: now.toISOString(),
            keys: makeHomeKeys(),
          },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await h.app.close();
    }
  });

  it("refuses Home key registration signed by another key than the Home's pinned key", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      const { accountId, computer } = await h.provisionComputer(1);
      const { hostCredential } = await h.bootAndClaimComputer(computer, accountId);
      const attackerKey = keyPairSpkiBase64();

      const res = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${hostCredential}` },
        payload: signRegistration(
          computer.id,
          now.toISOString(),
          makeHomeKeys(),
          attackerKey.privateKey,
        ),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.app.close();
    }
  });

  it("refuses Home key registration naming another Cloud Computer", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      const c1 = await h.provisionComputer(1);
      const c2 = await h.provisionComputer(2);
      const claimed1 = await h.bootAndClaimComputer(c1.computer, c1.accountId);

      const res = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed1.hostCredential}` },
        payload: signRegistration(
          c2.computer.id,
          now.toISOString(),
          makeHomeKeys(),
          claimed1.hostKey.privateKey,
        ),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.app.close();
    }
  });

  it("refuses Home key registration older than five minutes", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(true);
      const { accountId, computer } = await h.provisionComputer(1);
      const { hostCredential, hostKey } = await h.bootAndClaimComputer(computer, accountId);
      const expiredTs = new Date(now.getTime() - 6 * 60_000).toISOString();

      const res = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${hostCredential}` },
        payload: signRegistration(computer.id, expiredTs, makeHomeKeys(), hostKey.privateKey),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.app.close();
    }
  });

  it("keeps Home key registration idempotent on replay within five minutes without bumping term", async () => {
    const h = await buildHarness("2");
    try {
      const { computer, claimed, homeKeys, slot } = await h.setupPooledHomeAndHost();
      const firstIssuedAt = now.toISOString();
      expect(slot.term).toBe(1);

      // Byte-identical replay 60s later -> idempotent, no term bump.
      now = new Date(now.getTime() + 60_000);
      const exactReplay = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed.hostCredential}` },
        payload: signRegistration(computer.id, firstIssuedAt, homeKeys, claimed.hostKey.privateKey),
      });
      expect(exactReplay.statusCode).toBe(200);
      expect((await h.getDesiredSlots())[0]!.term).toBe(1);

      // Newer timestamp with identical keys -> still idempotent, no term bump.
      const newerReplay = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed.hostCredential}` },
        payload: signRegistration(
          computer.id,
          now.toISOString(),
          homeKeys,
          claimed.hostKey.privateKey,
        ),
      });
      expect(newerReplay.statusCode).toBe(200);
      expect((await h.getDesiredSlots())[0]!.term).toBe(1);
    } finally {
      await h.app.close();
    }
  });

  it("refuses an older or same-timestamp non-identical Home key registration to prevent replay downgrade (T4)", async () => {
    const h = await buildHarness("2");
    try {
      const { computer, claimed, homeKeys: keysA } = await h.setupPooledHomeAndHost();
      const tsA = now.toISOString();
      const docA = signRegistration(computer.id, tsA, keysA, claimed.hostKey.privateKey);

      // Register newer keys B at tsB = tsA + 10s -> succeeds and raises term to 2.
      now = new Date(now.getTime() + 10_000);
      const tsB = now.toISOString();
      const keysB = makeHomeKeys("tk-2");
      const docB = signRegistration(computer.id, tsB, keysB, claimed.hostKey.privateKey);
      const rotRes = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed.hostCredential}` },
        payload: docB,
      });
      expect(rotRes.statusCode).toBe(200);
      expect((await h.getDesiredSlots())[0]!.term).toBe(2);

      // Replaying older signed docA (still inside 5-minute window!) must be refused (401),
      // leaving keysB in place and term at 2.
      const replayOld = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed.hostCredential}` },
        payload: docA,
      });
      expect(replayOld.statusCode).toBe(401);
      const slotAfterOld = (await h.getDesiredSlots())[0]!;
      expect(slotAfterOld.term).toBe(2);
      expect(slotAfterOld.keys?.homeKey).toBe(keysB.homeKey);

      // Different keys at the exact same timestamp tsB must also be refused (401).
      const keysC = makeHomeKeys("tk-3");
      const sameTsDifferent = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed.hostCredential}` },
        payload: signRegistration(computer.id, tsB, keysC, claimed.hostKey.privateKey),
      });
      expect(sameTsDifferent.statusCode).toBe(401);
      expect((await h.getDesiredSlots())[0]!.term).toBe(2);
    } finally {
      await h.app.close();
    }
  });

  it("raises slot term once when Home registers changed keys and returns preparing until applied", async () => {
    const h = await buildHarness("2");
    try {
      const { computer, claimed, slot } = await h.setupPooledHomeAndHost();
      const controlKey1 = keyPairSpkiBase64().spki;
      const ready1 = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot.slotId,
          hostGeneration: 1,
          revision: slot.revision,
          term: 1,
          phase: "ready",
          controlKey: controlKey1,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });
      expect(ready1.statusCode).toBe(200);

      now = new Date(now.getTime() + 5_000);
      const rotated = makeHomeKeys("tk-2");
      const rotRes = await h.app.inject({
        method: "PUT",
        url: managedBrowserPoolRegistrationPath,
        headers: { authorization: `Bearer ${claimed.hostCredential}` },
        payload: signRegistration(
          computer.id,
          now.toISOString(),
          rotated,
          claimed.hostKey.privateKey,
        ),
      });
      expect(rotRes.statusCode).toBe(200);
      expect(ManagedBrowserPoolTargetResponseSchema.parse(JSON.parse(rotRes.body))).toEqual({
        status: "preparing",
      });

      const afterRot = (await h.getDesiredSlots())[0]!;
      expect(afterRot.term).toBe(2);

      const ready2 = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot.slotId,
          hostGeneration: 1,
          revision: afterRot.revision,
          term: 2,
          phase: "ready",
          controlKey: controlKey1,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });
      expect(CloudComputerReportResponseSchema.parse(JSON.parse(ready2.body)).recorded).toBe(true);
      const target = ManagedBrowserPoolTargetResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: managedBrowserPoolTargetPath,
              headers: { authorization: `Bearer ${claimed.hostCredential}` },
            })
          ).body,
        ),
      );
      expect(target.status).toBe("ready");
      expect(target.target?.term).toBe(2);
    } finally {
      await h.app.close();
    }
  });

  // --- Monotonic term & bump-term compare-and-set ---

  it("never lowers or skips a slot term across bump-term, check-slot, and status reports", async () => {
    const h = await buildHarness("2");
    try {
      const { slot } = await h.setupPooledHomeAndHost();

      // Wrong expectedTerm (skipped) refused.
      expect(
        BrowserPoolSlotBumpTermResponseSchema.parse(
          JSON.parse(
            (
              await h.app.inject({
                method: "POST",
                url: browserPoolSlotBumpTermPath(slot.slotId),
                headers: h.leaseHeaders,
                payload: { revision: slot.revision, expectedTerm: 2 },
              })
            ).body,
          ),
        ),
      ).toEqual({ bumped: false });

      // Stale revision refused.
      expect(
        BrowserPoolSlotBumpTermResponseSchema.parse(
          JSON.parse(
            (
              await h.app.inject({
                method: "POST",
                url: browserPoolSlotBumpTermPath(slot.slotId),
                headers: h.leaseHeaders,
                payload: { revision: slot.revision + 99, expectedTerm: 1 },
              })
            ).body,
          ),
        ),
      ).toEqual({ bumped: false });

      // Pending agent write blocks bump-term.
      const pendingToken = randomUUID();
      await h.app.inject({
        method: "POST",
        url: browserPoolSlotCheckPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          operation: "begin-agent-write",
          revision: slot.revision,
          write: { token: pendingToken, kind: "create", term: 1, hostId: slot.hostId },
        },
      });
      expect(
        BrowserPoolSlotBumpTermResponseSchema.parse(
          JSON.parse(
            (
              await h.app.inject({
                method: "POST",
                url: browserPoolSlotBumpTermPath(slot.slotId),
                headers: h.leaseHeaders,
                payload: { revision: slot.revision, expectedTerm: 1 },
              })
            ).body,
          ),
        ),
      ).toEqual({ bumped: false });
      await h.app.inject({
        method: "POST",
        url: browserPoolSlotCheckPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: { operation: "finish-agent-write", token: pendingToken },
      });

      // Valid bump raises term strictly by +1 (1 -> 2).
      const bumped = BrowserPoolSlotBumpTermResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "POST",
              url: browserPoolSlotBumpTermPath(slot.slotId),
              headers: h.leaseHeaders,
              payload: { revision: slot.revision, expectedTerm: 1 },
            })
          ).body,
        ),
      );
      expect(bumped).toEqual({ bumped: true, term: 2, revision: slot.revision + 1 });

      // Lower expectedTerm refused.
      expect(
        BrowserPoolSlotBumpTermResponseSchema.parse(
          JSON.parse(
            (
              await h.app.inject({
                method: "POST",
                url: browserPoolSlotBumpTermPath(slot.slotId),
                headers: h.leaseHeaders,
                payload: { revision: bumped.revision!, expectedTerm: 1 },
              })
            ).body,
          ),
        ),
      ).toEqual({ bumped: false });

      // Status reports and begin-agent-write with lowered (1) or skipped (3) term refused.
      for (const badTerm of [1, 3]) {
        const res = await h.app.inject({
          method: "POST",
          url: browserPoolSlotStatusPath(slot.slotId),
          headers: h.leaseHeaders,
          payload: {
            slotId: slot.slotId,
            hostGeneration: 1,
            revision: bumped.revision!,
            term: badTerm,
            phase: "ready",
            controlKey: keyPairSpkiBase64().spki,
            slotErased: false,
            profileErased: false,
            credentialsErased: false,
            lastError: null,
          },
        });
        expect(CloudComputerReportResponseSchema.parse(JSON.parse(res.body)).recorded).toBe(false);

        const checkRes = await h.app.inject({
          method: "POST",
          url: browserPoolSlotCheckPath(slot.slotId),
          headers: h.leaseHeaders,
          payload: {
            operation: "begin-agent-write",
            revision: bumped.revision!,
            write: { token: randomUUID(), kind: "create", term: badTerm, hostId: slot.hostId },
          },
        });
        expect(CloudComputerCheckResponseSchema.parse(JSON.parse(checkRes.body)).allowed).toBe(
          false,
        );
      }
    } finally {
      await h.app.close();
    }
  });

  // --- T5 stale hostGeneration on slot report + S6/S7 convergence ---

  it("refuses a slot status report whose hostGeneration does not match the host's current generation (T5)", async () => {
    const h = await buildHarness("2");
    try {
      const { claimed, hostId, slot } = await h.setupPooledHomeAndHost();
      // Host is replaced and enrols at generation 2 while a delayed gen-1 ready report arrives.
      await runCloudComputerOperator(h.cloudStore, ["pool-host-replace", hostId]);
      await h.enrolAndReadyHost(hostId, "10.40.0.12");

      const staleGenReport = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot.slotId,
          hostGeneration: 1,
          revision: slot.revision,
          term: 1,
          phase: "ready",
          controlKey: keyPairSpkiBase64().spki,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });
      expect(
        CloudComputerReportResponseSchema.parse(JSON.parse(staleGenReport.body)).recorded,
      ).toBe(false);

      // Target must stay preparing (never publish a mixed gen-1 controlKey + gen-2 hostKey).
      const target = ManagedBrowserPoolTargetResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: managedBrowserPoolTargetPath,
              headers: { authorization: `Bearer ${claimed.hostCredential}` },
            })
          ).body,
        ),
      );
      expect(target).toEqual({ status: "preparing" });
    } finally {
      await h.app.close();
    }
  });

  it("converges Home target across pool host replacement with bumped term and new host keys (S6+S7)", async () => {
    const h = await buildHarness("2");
    try {
      const { claimed, hostId, slot } = await h.setupPooledHomeAndHost();
      expect(claimed.boot.browserPool).toBe(true);
      expect(claimed.boot.egress).toBeUndefined();

      const controlKey1 = keyPairSpkiBase64().spki;
      await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot.slotId,
          hostGeneration: 1,
          revision: slot.revision,
          term: 1,
          phase: "ready",
          controlKey: controlKey1,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });

      await runCloudComputerOperator(h.cloudStore, ["pool-host-replace", hostId]);
      const duringReplace = ManagedBrowserPoolTargetResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: managedBrowserPoolTargetPath,
              headers: { authorization: `Bearer ${claimed.hostCredential}` },
            })
          ).body,
        ),
      );
      expect(duringReplace).toEqual({ status: "preparing" });

      const gen2 = await h.enrolAndReadyHost(hostId, "10.40.0.12");
      const slotAfterReplace = (await h.getDesiredSlots())[0]!;
      expect(slotAfterReplace.hostGeneration).toBe(2);

      const bumped = BrowserPoolSlotBumpTermResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "POST",
              url: browserPoolSlotBumpTermPath(slot.slotId),
              headers: h.leaseHeaders,
              payload: {
                revision: slotAfterReplace.revision,
                expectedTerm: slotAfterReplace.term,
              },
            })
          ).body,
        ),
      );
      expect(bumped).toEqual({ bumped: true, term: 2, revision: slotAfterReplace.revision + 1 });

      const controlKey2 = keyPairSpkiBase64().spki;
      await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot.slotId,
          hostGeneration: 2,
          revision: bumped.revision!,
          term: 2,
          phase: "ready",
          controlKey: controlKey2,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });

      const converged = ManagedBrowserPoolTargetResponseSchema.parse(
        JSON.parse(
          (
            await h.app.inject({
              method: "GET",
              url: managedBrowserPoolTargetPath,
              headers: { authorization: `Bearer ${claimed.hostCredential}` },
            })
          ).body,
        ),
      );
      expect(converged).toEqual({
        status: "ready",
        target: {
          kind: "managed-pool",
          agentUrl: "http://10.40.0.12:7310",
          slotId: slot.slotId,
          term: 2,
          agentKey: controlKey2,
          hostKey: gen2.hostKey.spki,
          relay: {
            host: "10.40.0.12",
            port: 7312,
            relayHostKey: gen2.relayKey.spki,
          },
        },
      });
    } finally {
      await h.app.close();
    }
  });

  // --- W10 + T1 accumulated deletion evidence ---

  it("settles slot and Cloud Computer deletion when erased, profileErased, and credentialsErased accumulate across separate reports (W10+T1)", async () => {
    const h = await buildHarness("2");
    try {
      const { accountId, computer, hostId, slot } = await h.setupPooledHomeAndHost();

      await expect(
        runCloudComputerOperator(h.cloudStore, ["pool-host-delete", hostId]),
      ).rejects.toMatchObject({ code: "conflict" });

      await h.cloudStore.mutate(computer.id, "delete", accountId);
      const compAfterDelete = await database
        .selectFrom("cloudComputers")
        .select(["state", "revision", "generation"])
        .where("id", "=", computer.id)
        .executeTakeFirstOrThrow();
      expect(compAfterDelete.state).toBe("deleted");

      await h.app.inject({
        method: "POST",
        url: cloudComputerStatusPath(computer.id),
        headers: h.leaseHeaders,
        payload: {
          id: computer.id,
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

      const beforeSlotErased = await database
        .selectFrom("cloudComputers")
        .select(["vmDestroyedAt", "backupsUnreadableAt", "browserSlotErasedAt", "tombstonedAt"])
        .where("id", "=", computer.id)
        .executeTakeFirstOrThrow();
      expect(beforeSlotErased.vmDestroyedAt).not.toBeNull();
      expect(beforeSlotErased.backupsUnreadableAt).not.toBeNull();
      expect(beforeSlotErased.browserSlotErasedAt).toBeNull();
      expect(beforeSlotErased.tombstonedAt).toBeNull();

      const deletingSlot = (await h.getDesiredSlots())[0]!;
      expect(deletingSlot.state).toBe("deleting");

      // Premature phase:"deleted" with only 2 of 3 bits is refused.
      for (const partial of [
        { slotErased: false, profileErased: true, credentialsErased: true },
        { slotErased: true, profileErased: false, credentialsErased: true },
        { slotErased: true, profileErased: true, credentialsErased: false },
      ]) {
        const res = await h.app.inject({
          method: "POST",
          url: browserPoolSlotStatusPath(slot.slotId),
          headers: h.leaseHeaders,
          payload: {
            slotId: slot.slotId,
            hostGeneration: 1,
            revision: deletingSlot.revision,
            term: deletingSlot.term,
            phase: "deleted",
            controlKey: null,
            ...partial,
            lastError: null,
          },
        });
        expect(res.statusCode).toBe(200);
        expect(CloudComputerReportResponseSchema.parse(JSON.parse(res.body)).recorded).toBe(false);
      }

      // T1: Evidence arrives across 3 separate reports:
      // Report 1 records slotErased only (phase: "deleting").
      const r1 = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot.slotId,
          hostGeneration: 1,
          revision: deletingSlot.revision,
          term: deletingSlot.term,
          phase: "deleting",
          controlKey: null,
          slotErased: true,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });
      expect(CloudComputerReportResponseSchema.parse(JSON.parse(r1.body)).recorded).toBe(true);

      // Report 2 records profileErased only (still missing credentialsErased -> premature deleted refused).
      const r2 = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot.slotId,
          hostGeneration: 1,
          revision: deletingSlot.revision,
          term: deletingSlot.term,
          phase: "deleting",
          controlKey: null,
          slotErased: false,
          profileErased: true,
          credentialsErased: false,
          lastError: null,
        },
      });
      expect(CloudComputerReportResponseSchema.parse(JSON.parse(r2.body)).recorded).toBe(true);

      const stillMissingCreds = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot.slotId,
          hostGeneration: 1,
          revision: deletingSlot.revision,
          term: deletingSlot.term,
          phase: "deleted",
          controlKey: null,
          slotErased: false,
          profileErased: false,
          credentialsErased: false,
          lastError: null,
        },
      });
      expect(
        CloudComputerReportResponseSchema.parse(JSON.parse(stillMissingCreds.body)).recorded,
      ).toBe(false);

      // Report 3 carries ONLY credentialsErased:true (with slotErased/profileErased already accumulated) -> settles!
      const r3 = await h.app.inject({
        method: "POST",
        url: browserPoolSlotStatusPath(slot.slotId),
        headers: h.leaseHeaders,
        payload: {
          slotId: slot.slotId,
          hostGeneration: 1,
          revision: deletingSlot.revision,
          term: deletingSlot.term,
          phase: "deleted",
          controlKey: null,
          slotErased: false,
          profileErased: false,
          credentialsErased: true,
          lastError: null,
        },
      });
      expect(CloudComputerReportResponseSchema.parse(JSON.parse(r3.body)).recorded).toBe(true);

      const afterSlotErased = await database
        .selectFrom("cloudComputers")
        .select(["browserSlotErasedAt", "tombstonedAt", "phase"])
        .where("id", "=", computer.id)
        .executeTakeFirstOrThrow();
      expect(afterSlotErased.browserSlotErasedAt).not.toBeNull();
      expect(afterSlotErased.tombstonedAt).not.toBeNull();
      expect(afterSlotErased.phase).toBe("deleted");

      await runCloudComputerOperator(h.cloudStore, ["pool-host-delete", hostId]);
      const deletingHost = (await h.getDesiredHosts()).find((entry) => entry.id === hostId)!;
      expect(deletingHost.state).toBe("deleted");
    } finally {
      await h.app.close();
    }
  });

  // --- T9 operator warning when pooling on without pool-configured provisioner ---

  it("warns in operator pool commands when pooling is enabled in Account while the active provisioner lacks a pool key (T9)", async () => {
    const h = await buildHarness("2");
    try {
      await h.acquireLease(false);
      await h.provisionComputer(1);
      await h.getDesiredHosts();

      const hostsView = (await runCloudComputerOperator(h.cloudStore, ["pool-host-list"])) as {
        hosts: unknown[];
        warning?: string;
      };
      expect(hostsView.hosts).toHaveLength(1);
      expect(hostsView.warning).toContain("OPENSTEER_POOL_PROVISIONER_KEY");

      const slotsView = (await runCloudComputerOperator(h.cloudStore, ["pool-slot-list"])) as {
        slots: unknown[];
        warning?: string;
      };
      expect(slotsView.warning).toContain("OPENSTEER_POOL_PROVISIONER_KEY");

      // Once a pool-configured provisioner acquires the lease, the warning disappears.
      await h.acquireLease(true);
      const cleanHostsView = (await runCloudComputerOperator(h.cloudStore, ["pool-host-list"])) as {
        hosts: unknown[];
        warning?: string;
      };
      expect(cleanHostsView.warning).toBeUndefined();
    } finally {
      await h.app.close();
    }
  });
});
