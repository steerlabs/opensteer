// The Home's own registration client and target service (phase B, piece 4) against the account's
// real routes and store. The account's harness below is the one in
// apps/control-plane/src/cloud-computers/browser-pool.integration.test.ts, copied so that file
// stays the account builder's own; only the last test is new.
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import {
  BrowserPoolHostBootCompleteResponseSchema,
  BrowserPoolHostBootResponseSchema,
  BrowserPoolHostDesiredResponseSchema,
  BrowserPoolSlotDesiredResponseSchema,
  CloudComputerBootResponseSchema,
  CloudComputerIdentitySchema,
  CloudComputerReportResponseSchema,
  ControlPlaneAccountIdSchema,
  browserPoolHostBootCompletePath,
  browserPoolHostBootPath,
  browserPoolHostStatusPath,
  browserPoolHostsDesiredPath,
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
  type BrowserPoolHostId,
  type CloudComputerDesired,
  type CloudComputerId,
  type ControlPlaneAccountId,
} from "../packages/control-plane-protocol/src/index.js";
import {
  HostDiscoveryDocumentSchema,
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
} from "../packages/deployment-authority/src/index.js";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateManagedBrowserPoolKeys } from "../apps/host/src/browser/managed-pool-keys.js";
import { startManagedBrowserPool } from "../apps/host/src/browser/managed-pool-home.js";
import { createStoreFixture } from "../packages/database/src/store.integration.test-support.js";
import {
  databaseManagedBrowserPoolTargetRecord,
  ManagedBrowserPoolAccountClient,
  ManagedBrowserPoolTargetService,
  signedManagedBrowserPoolRegistration,
  type ManagedBrowserPoolTarget,
} from "../apps/host/src/browser/managed-pool-target.js";
import { ConnectLifecycleService } from "../apps/control-plane/src/account/connect-lifecycle.js";
import {
  ControlPlaneAuthenticator,
  createControlPlaneAuth,
} from "../apps/control-plane/src/auth/auth.js";
import {
  createHostCredential,
  hashCredential,
} from "../apps/control-plane/src/auth/credentials.js";
import { createControlPlaneDatabase } from "../apps/control-plane/src/database/database.js";
import { migrateControlPlaneToLatest } from "../apps/control-plane/src/database/migrations.js";
import type { ControlPlaneDatabaseSchema } from "../apps/control-plane/src/database/schema.js";
import { ControlPlaneStore } from "../apps/control-plane/src/database/store.js";
import { CloudComputerSecretCipher } from "../apps/control-plane/src/cloud-computers/secret-cipher.js";
import { createControlPlaneServer } from "../apps/control-plane/src/server/server.js";
import { testBackupVault } from "../apps/control-plane/src/cloud-computers/backup-erasure.test-support.js";
import { loadCloudComputerConfig } from "../apps/control-plane/src/cloud-computers/config.js";
import { resetManagedCloudTables } from "../apps/control-plane/src/cloud-computers/reset.test-support.js";
import { CloudComputerStore } from "../apps/control-plane/src/cloud-computers/store.js";
import type {
  StripeBilling,
  StripeSubscription,
} from "../apps/control-plane/src/cloud-computers/stripe.js";

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
    OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL:
      "https://releases.example.test/managed/stable.json",
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

integration("A pooled Home against its Opensteer account (phase B, piece 4)", () => {
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
  const cipher = new CloudComputerSecretCipher(Buffer.alloc(32, 7).toString("base64url"));

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
  });

  afterAll(async () => {
    await resetManagedCloudTables(database);
    await sql`truncate table deployments, oauth_clients, users cascade`.execute(database);
    await database.destroy();
  });

  beforeEach(async () => {
    now = new Date("2026-11-21T00:00:00.000Z");
    leaseHolder = randomUUID();
    subscriptions.clear();
    await resetManagedCloudTables(database);
    await sql`truncate table deployments, oauth_clients, users cascade`.execute(database);
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

  it("lets a pooled Home's own service register its keys signed by its pinned key, wait while preparing, and read its ready target", async () => {
    const h = await buildHarness("2");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-home-"));
    try {
      await h.acquireLease(true);
      const { accountId, computer } = await h.provisionComputer(1);
      const claimed = await h.bootAndClaimComputer(computer, accountId);
      const [host] = await h.getDesiredHosts();
      await h.enrolAndReadyHost(host!.id, "10.40.0.10");
      const keys = await loadOrCreateManagedBrowserPoolKeys(directory);
      const sent: string[] = [];
      // The Home's own client, over the account's real routes and store.
      const account = new ManagedBrowserPoolAccountClient({
        controlApiOrigin: publicOrigin,
        hostCredential: claimed.hostCredential,
        fetch: (async (input: URL, init?: RequestInit) => {
          sent.push(init?.method ?? "GET");
          const response = await h.app.inject({
            method: (init?.method ?? "GET") as "GET" | "PUT",
            url: input.pathname,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            ...(init?.body ? { payload: String(init.body) } : {}),
          });
          return new Response(response.body, { status: response.statusCode });
        }) as typeof fetch,
      });
      // The Home's host credential with a registration signed by any other key is refused.
      await expect(
        account.register(
          signedManagedBrowserPoolRegistration({
            cloudComputerId: computer.id,
            keys,
            hostKey: generateKeyPairSync("ed25519").privateKey,
            issuedAt: now,
          }),
        ),
      ).rejects.toThrow(/refused/u);
      // The Home's own record, on its own PostgreSQL (never a stand-in: the database gives back
      // jsonb with its keys reordered).
      const homeDatabase = await createStoreFixture();
      const record = databaseManagedBrowserPoolTargetRecord(homeDatabase.database, computer.id);
      const targets: ManagedBrowserPoolTarget[] = [];
      const service = new ManagedBrowserPoolTargetService({
        cloudComputerId: computer.id,
        keys,
        hostKey: claimed.hostKey.privateKey,
        account,
        record,
        onTarget: (target) => void targets.push(target),
        now: () => now,
        firstDelayMs: 20,
        maxDelayMs: 100,
      });
      service.start();
      try {
        await vi.waitFor(async () => expect((await record.read())?.status).toBe("preparing"));
        // The provisioner places the slot and its host reports it ready.
        const slot = (await h.getDesiredSlots())[0]!;
        const ready = await h.app.inject({
          method: "POST",
          url: browserPoolSlotStatusPath(slot.slotId),
          headers: h.leaseHeaders,
          payload: {
            slotId: slot.slotId,
            hostGeneration: 1,
            revision: slot.revision,
            term: slot.term,
            phase: "ready",
            controlKey: keyPairSpkiBase64().spki,
            slotErased: false,
            profileErased: false,
            credentialsErased: false,
            lastError: null,
          },
        });
        expect(ready.statusCode).toBe(200);
        await vi.waitFor(() => expect(targets).toHaveLength(1), { timeout: 10_000 });
        expect(targets[0]).toMatchObject({ kind: "managed-pool", slotId: slot.slotId, term: 1 });
        // The refused one and the Home's own: it read the target afterwards and never
        // registered again.
        expect(sent.filter((method) => method === "PUT")).toHaveLength(2);
        // Asked again (a suspicion): the keys it holds are the ones registered, so it reads the
        // target and registers nothing.
        service.suspect();
        await vi.waitFor(() =>
          expect(sent.filter((method) => method === "GET").length).toBeGreaterThan(1),
        );
        expect(sent.filter((method) => method === "PUT")).toHaveLength(2);
        // The target is over (its host said the slot is gone) while the account still names it:
        // the service keeps asking, paced, until a different target is placed (V6).
        const reads = sent.filter((method) => method === "GET").length;
        service.suspect({ over: true });
        await vi.waitFor(
          () => expect(sent.filter((method) => method === "GET").length).toBeGreaterThan(reads + 2),
          { timeout: 10_000 },
        );
        expect(targets).toHaveLength(1);
        // The provisioner places the slot again: its host reports a new control key.
        const replaced = await h.app.inject({
          method: "POST",
          url: browserPoolSlotStatusPath(slot.slotId),
          headers: h.leaseHeaders,
          payload: {
            slotId: slot.slotId,
            hostGeneration: 1,
            revision: slot.revision,
            term: slot.term,
            phase: "ready",
            controlKey: keyPairSpkiBase64().spki,
            slotErased: false,
            profileErased: false,
            credentialsErased: false,
            lastError: null,
          },
        });
        expect(replaced.statusCode).toBe(200);
        await vi.waitFor(() => expect(targets).toHaveLength(2), { timeout: 10_000 });
        expect(targets[1]!.agentKey).not.toBe(targets[0]!.agentKey);
      } finally {
        await service.close();
      }
      // The Home starts again with that target stored: it is chosen, read again from the account
      // as the same target, and nothing is retired.
      const browser = { adoptPool: vi.fn(async () => {}), retirePool: vi.fn(async () => {}) };
      const restarted = await startManagedBrowserPool({
        database: homeDatabase.database,
        dataDirectory: directory,
        cloudComputerId: computer.id,
        runnerId: "rnr_0192f4a1-1111-4000-8000-000000000001" as never,
        hostKey: claimed.hostKey.privateKey,
        browser: browser as never,
        account,
      });
      try {
        const reads = sent.filter((method) => method === "GET").length;
        await vi.waitFor(() =>
          expect(sent.filter((method) => method === "GET").length).toBeGreaterThan(reads),
        );
        await restarted.close();
        expect(browser.adoptPool).toHaveBeenCalledTimes(1);
        expect(browser.retirePool).not.toHaveBeenCalled();
        expect(sent.filter((method) => method === "PUT")).toHaveLength(2);
      } finally {
        await restarted.close();
        await homeDatabase.close();
      }
    } finally {
      await rm(directory, { recursive: true });
      await h.app.close();
    }
  });
});
