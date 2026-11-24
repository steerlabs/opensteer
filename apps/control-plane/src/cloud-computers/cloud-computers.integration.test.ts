import { resetManagedCloudTables } from "./reset.test-support.js";
import { testBackupVault } from "./backup-erasure.test-support.js";
import { ControlPlaneError } from "../server/errors.js";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  accountCloudComputerBillingPortalPath,
  accountCloudComputerCheckoutPath,
  accountCloudComputerPath,
  accountCloudComputersPath,
  CloudComputerBootResponseSchema,
  type CloudComputerCheck,
  CloudComputerDesiredResponseSchema,
  CloudComputerIdSchema,
  CloudComputerIdentitySchema,
  cloudComputerBackupReportPath,
  cloudComputerBootPath,
  cloudComputerCheckPath,
  cloudComputerEgressPath,
  cloudComputerBootCompletePath,
  cloudComputerLeasePath,
  cloudComputerLeaseHeader,
  cloudComputerDeleteConfirmation,
  cloudComputerStatusPath,
  cloudComputerStripeWebhookPath,
  cloudComputersDesiredPath,
  ControlPlaneAccountIdSchema,
  GoogleComputeServerRefSchema,
  ManagedHomeClaimClaimsSchema,
  ManagedHomeClaimReceiptDocumentSchema,
  ManagedHomeClaimReceiptSchema,
  ManagedHomeClaimRequestSchema,
  managedHomeClaimPath,
  managedHomeClaimReceiptSigningBytes,
  type CloudComputerBootResponse,
  type CloudComputerDesired,
  type CloudComputerReport,
  type ControlPlaneAccountId,
  type ManagedHomeClaimReceipt,
} from "@opensteer/control-plane-protocol";
import {
  HostDiscoveryDocumentSchema,
  hostApiVersion,
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
  minimumHostApiVersion,
} from "@opensteer/deployment-authority";
import { digestSecret } from "@opensteer/shared/secretDigest";
import { createLocalJWKSet, exportJWK, jwtVerify, SignJWT } from "jose";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { ControlPlaneAuthenticator, createControlPlaneAuth } from "../auth/auth.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { ControlPlaneStore } from "../database/store.js";
import { googleServiceAccountVerifier } from "./provisioner-verifier.js";
import { CloudComputerSecretCipher } from "./secret-cipher.js";
import { createControlPlaneServer } from "../server/server.js";
import { CloudComputerClaimer, HttpManagedHomeClient } from "./claim.js";
import { loadCloudComputerConfig } from "./config.js";
import { browserPoolRelease } from "./pool-release.test-support.js";
import { CloudComputerStore } from "./store.js";
import { billingErrorDetails } from "./billing-error.js";
import { cloudComputerBillingSettledMigration } from "./migration.js";
import { cloudComputerOperatorUsage, runCloudComputerOperator } from "./operator.js";
import type { StripeBilling, StripeSubscription } from "./stripe.js";

const url = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// The focused integration launcher supplies a disposable Account database.
const integration = url ? describe : describe.skip;
const publicOrigin = new URL("https://account.cloud-computers.example.test");
const portalOrigin = new URL("https://portal.cloud-computers.example.test");
const authSecret = "test-auth-secret-for-cloud-computers-32";
const provisionerEmail = "home@example.iam.gserviceaccount.com";
const webhookSecret = "whsec_abcdefghijklmno";
const checkoutUrl = "https://checkout.stripe.example.test/pay";
const portalUrl = "https://billing.stripe.example.test/session";
const digest = "a".repeat(64);
const releaseManifestUrl = "https://releases.example.test/managed/stable.json";
const services = [
  "host",
  "runner",
  "browser-runtime",
  "browser-egress",
  "channel-runtime",
  "gateway",
];
const config = loadCloudComputerConfig({
  OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL: provisionerEmail,
  OPENSTEER_CLOUD_COMPUTER_DOMAIN: "home.example.test",
  OPENSTEER_CLOUD_COMPUTER_REGION: "us-central1-a",
  OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE: "e2-standard-4",
  OPENSTEER_CLOUD_COMPUTER_RELEASE_JSON: JSON.stringify({
    version: "1.2.3",
    installerUrl: "https://releases.example.test/install.sh",
    installerSha256: digest,
    images: Object.fromEntries(
      services.map((service) => [service, `example.test/${service}@sha256:${digest}`]),
    ),
  }),
  OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL: releaseManifestUrl,
  OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY: "sk_test_abcdefghijklmno",
  OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET: webhookSecret,
  OPENSTEER_CLOUD_COMPUTER_STRIPE_PRICE_ID: "price_1",
  OPENSTEER_CLOUD_COMPUTER_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_cloud",
  OPENSTEER_CLOUD_COMPUTER_PLAN_NAME: "Cloud Computer",
  OPENSTEER_CLOUD_COMPUTER_CURRENCY: "usd",
  OPENSTEER_CLOUD_COMPUTER_PRICE_MINOR: "2900",
  OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST: "10",
  OPENSTEER_CLOUD_COMPUTER_POOL_RELEASE_JSON: JSON.stringify(browserPoolRelease(digest)),
})!;
// The Home's own signing key: the fingerprint Account pins is the one its discovery proves.
const homeKeys = generateKeyPairSync("ed25519");
const homeSpki = homeKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const identity = CloudComputerIdentitySchema.parse({
  deploymentId: "dep_00000000-0000-4000-8000-000000000010",
  hostKeyFingerprint: hostKeyFingerprint(homeSpki),
});

integration("Cloud Computer Account service", () => {
  const database = createControlPlaneDatabase({ connectionString: url!, maxConnections: 4 });
  const subscriptions = new Map<string, StripeSubscription>();
  const byRequest = new Map<string, string>();
  const checkout = vi.fn<StripeBilling["checkout"]>(async (input) => {
    const id = byRequest.get(input.requestId);
    if (!id) throw new Error("Unexpected Checkout request");
    return { id, url: checkoutUrl };
  });
  const stripe = {
    checkout,
    portal: vi.fn<StripeBilling["portal"]>(async () => ({ url: portalUrl })),
    subscription: vi.fn(async (id: string) => subscriptions.get(id)!),
    validateOffer: vi.fn<StripeBilling["validateOffer"]>(async () => {}),
    validatePortal: vi.fn<StripeBilling["validatePortal"]>(async () => {}),
    expireCheckout: vi.fn<StripeBilling["expireCheckout"]>(async (id) => ({
      id,
      status: "expired",
      url: null,
      payment: undefined,
    })),
    refundCheckout: vi.fn<StripeBilling["refundCheckout"]>(async () => true),
    deleteIdleCustomer: vi.fn<StripeBilling["deleteIdleCustomer"]>(async () => {}),
    findCheckout: vi.fn<StripeBilling["findCheckout"]>(async () => undefined),
    cancel: vi.fn<StripeBilling["cancel"]>(async (id) => {
      subscriptions.set(id, { ...subscriptions.get(id)!, status: "canceled" });
    }),
  } satisfies StripeBilling;
  const logs: string[] = [];
  const billingAttention = vi.fn<(message: string) => void>();
  let now = new Date();
  let app: Awaited<ReturnType<typeof createControlPlaneServer>>;
  const auth = createControlPlaneAuth(database, {
    publicOrigin,
    authSecret,
    googleClientId: "test-client",
    googleClientSecret: "test-secret",
  });
  const cipher = new CloudComputerSecretCipher(Buffer.alloc(32, 5).toString("base64url"));
  const vault = testBackupVault();
  const eraseKey = vi.fn(vault.destroy);
  const purge = vi.fn<import("./backup-purge.js").BackupPurgeStep>(async () => true);
  const cloud = new CloudComputerStore(database, {
    backupKeyVault: { ...vault, destroy: eraseKey },
    purgeBackupStep: purge,
    onBillingAttention: billingAttention,
    config,
    accountOrigin: publicOrigin,
    cipher,
    stripe,
    now: () => now,
  });
  const kickBootstrap = vi.fn();
  const kickBilling = vi.fn();
  const claimErrors: unknown[] = [];
  const directory = new ControlPlaneStore(database, publicOrigin, { portalOrigin });
  const claimer = (
    fetch: typeof globalThis.fetch,
    store: ConstructorParameters<typeof CloudComputerClaimer>[0]["store"] = cloud,
  ) =>
    new CloudComputerClaimer({
      store,
      home: new HttpManagedHomeClient({ fetch }),
      issuer: publicOrigin,
      sign: async (claims) => (await auth.api.signJWT({ body: { payload: claims } })).token,
      onError: (error) => claimErrors.push(error),
      now: () => now.getTime(),
    });

  /**
   * A Home behind exactly the two routes Account calls, making the same checks
   * the real Host makes (pinned in apps/host managed-home.integration.test.ts):
   * the Account's EdDSA assertion against its live JWKS, every binding, the
   * setup code against the digest it booted with, one owner, replay.
   */
  function fakeHome(input: {
    readonly hostname: string;
    readonly boot: CloudComputerBootResponse;
    readonly deploymentId?: string;
    readonly hostInstanceId?: string;
    readonly privateKey?: KeyObject;
    readonly spki?: string;
  }) {
    const spki = input.spki ?? homeSpki;
    const privateKey = input.privateKey ?? homeKeys.privateKey;
    const origin = `https://${input.hostname}`;
    const document = HostDiscoveryDocumentSchema.parse({
      canonicalOrigin: origin,
      deploymentId: input.deploymentId ?? identity.deploymentId,
      hostInstanceId: input.hostInstanceId ?? "hst_00000000-0000-4000-8000-000000000020",
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { kind: "personal" },
    });
    const authority = {
      document,
      publicKey: { algorithm: "Ed25519", spki },
      signature: sign(null, hostDiscoverySigningBytes(document), privateKey).toString("base64url"),
    };
    const state: {
      claims: number;
      receipt?: ManagedHomeClaimReceipt;
      owner?: string;
      hostCredential?: string;
    } = {
      claims: 0,
    };
    const answer = (status: number) => Response.json({ error: { status } }, { status });
    const fetch: typeof globalThis.fetch = async (target, init) => {
      const url = new URL(String(target));
      expect(url.origin).toBe(origin);
      if (url.pathname === "/.well-known/opensteer")
        return Response.json({
          kind: "personal",
          apiVersion: minimumHostApiVersion,
          currentApiVersion: hostApiVersion,
          authority,
          bootstrapMethods: ["oidc"],
          capabilities: [],
        });
      if (url.pathname !== managedHomeClaimPath) return answer(404);
      state.claims += 1;
      const request = ManagedHomeClaimRequestSchema.parse(JSON.parse(String(init?.body)));
      const jwks = await http({ method: "GET", url: "/api/auth/jwks" });
      let claims;
      try {
        const verified = await jwtVerify(request.assertion, createLocalJWKSet(jwks.json()), {
          algorithms: ["EdDSA"],
          audience: origin,
          issuer: publicOrigin.origin,
          maxTokenAge: "5m",
        });
        claims = ManagedHomeClaimClaimsSchema.parse(verified.payload);
      } catch {
        return answer(403);
      }
      if (
        claims.authority.deploymentId !== document.deploymentId ||
        claims.authority.hostKeyFingerprint !== hostKeyFingerprint(spki) ||
        claims.authority.canonicalOrigin !== origin ||
        claims.link.hostCredentialSha256 !==
          createHash("sha256").update(request.hostCredential).digest("base64url") ||
        digestSecret(request.setupCode) !== input.boot.setupCodeDigest
      )
        return answer(403);
      if (
        claims.claim.cloudComputerId !== input.boot.managedHome?.cloudComputerId ||
        claims.claim.generation !== input.boot.managedHome.generation
      )
        return answer(409);
      if (state.receipt)
        return state.owner === claims.sub ? Response.json(state.receipt) : answer(409);
      const receiptDocument = ManagedHomeClaimReceiptDocumentSchema.parse({
        purpose: "opensteer-managed-home-claim-receipt",
        documentVersion: 1,
        account: { issuer: publicOrigin.origin, subject: claims.sub },
        authority: {
          canonicalOrigin: origin,
          deploymentId: document.deploymentId,
          hostInstanceId: document.hostInstanceId,
          hostKeyFingerprint: hostKeyFingerprint(spki),
        },
        claim: claims.claim,
        linkGeneration: claims.link.generation,
        hostCredentialSha256: claims.link.hostCredentialSha256,
        claimedAt: new Date().toISOString(),
      });
      state.receipt = ManagedHomeClaimReceiptSchema.parse({
        document: receiptDocument,
        publicKey: { algorithm: "Ed25519", spki },
        signature: sign(
          null,
          managedHomeClaimReceiptSigningBytes(receiptDocument),
          privateKey,
        ).toString("base64url"),
      });
      state.owner = claims.sub;
      state.hostCredential = request.hostCredential;
      return Response.json(state.receipt);
    };
    return { fetch, state };
  }
  const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let provisionerToken: string;
  let listener: URL;
  const lease = randomUUID();
  const leaseHeaders = () => ({
    authorization: `Bearer ${provisionerToken}`,
    [cloudComputerLeaseHeader]: lease,
  });

  async function http(input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
    redirect?: RequestInit["redirect"];
  }) {
    const headers = new Headers(input.headers);
    if (input.payload !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const response = await fetch(new URL(input.url, listener), {
      method: input.method,
      redirect: input.redirect ?? "follow",
      headers,
      ...(input.payload === undefined
        ? {}
        : {
            body: typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload),
          }),
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      body,
      headers: Object.fromEntries(response.headers),
      json: () => JSON.parse(body),
    };
  }

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
    const keys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(google.publicKey)), kid: "gke", alg: "RS256" }],
    });
    const connectLifecycle = new ConnectLifecycleService(database, {
      delete: async () => undefined,
      ensure: async () => {
        throw new Error("Not used");
      },
      readConnectorToken: async () => {
        throw new Error("Not used");
      },
      rotateConnectorToken: async () => {
        throw new Error("Not used");
      },
    });
    app = await createControlPlaneServer(
      {
        auth,
        authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
        connectLifecycle,
        cloudComputers: {
          store: cloud,
          kickBootstrap,
          kickBilling,
          stripeWebhookSecret: webhookSecret,
          verifyProvisioner: googleServiceAccountVerifier({
            audience: publicOrigin.origin,
            email: provisionerEmail,
            keys,
          }),
        },
        portalOrigin,
        publicOrigin,
        store: new ControlPlaneStore(database, publicOrigin, { portalOrigin }),
      },
      { logger: { level: "error", stream: { write: (line: string) => logs.push(line) } } },
    );
    provisionerToken = await workloadToken(provisionerEmail);
    listener = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
  });

  beforeEach(async () => {
    await resetManagedCloudTables(database);
    claimErrors.length = 0;
    checkout.mockClear();
    eraseKey.mockReset().mockImplementation(vault.destroy);
    purge.mockReset().mockResolvedValue(true);
    stripe.subscription.mockClear();
    stripe.portal.mockClear();
    stripe.cancel.mockClear();
    stripe.validatePortal.mockReset().mockResolvedValue(undefined);
    stripe.expireCheckout.mockClear();
    stripe.refundCheckout.mockReset().mockResolvedValue(true);
    stripe.deleteIdleCustomer.mockReset().mockResolvedValue(undefined);
    billingAttention.mockClear();
    stripe.findCheckout.mockReset().mockResolvedValue(undefined);
    stripe.validateOffer.mockReset().mockResolvedValue(undefined);
    kickBootstrap.mockClear();
    kickBilling.mockClear();
    logs.length = 0;
    now = new Date();
    await cloud.checkOffer();
    await cloud.addBackupTarget({
      endpoint: "https://s3.example.test",
      bucket: "test-backups",
      prefix: "first",
      accessKeyId: "access-a",
      secretAccessKey: "secret-a",
    });
    await cloud.addBackupTarget({
      endpoint: "https://s3.example.test",
      bucket: "test-backups",
      prefix: "second",
      accessKeyId: "access-b",
      secretAccessKey: "secret-b",
    });
    expect(
      (
        await http({
          method: "POST",
          url: cloudComputerLeasePath,
          headers: leaseHeaders(),
          payload: { holder: lease },
        })
      ).statusCode,
    ).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await database.destroy();
  });

  async function workloadToken(email: string) {
    return new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "gke" })
      .setIssuer("https://accounts.google.com")
      .setAudience(publicOrigin.origin)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(google.privateKey);
  }

  async function createAccount() {
    const id = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    await database
      .insertInto("users")
      .values({
        id,
        displayName: "Cloud tester",
        email: `${id}@example.test`,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .executeTakeFirst();
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession(id);
    const signature = createHmac("sha256", authSecret).update(session.token).digest("base64");
    const headers = {
      cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
      origin: publicOrigin.origin,
      host: publicOrigin.host,
    };
    return { id, headers };
  }

  async function webhook(
    type: string,
    object: unknown,
    id = `evt_${randomUUID().replaceAll("-", "")}`,
  ) {
    const body = JSON.stringify({ id, type, data: { object } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    return http({
      method: "POST",
      url: cloudComputerStripeWebhookPath,
      payload: body,
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      },
    });
  }

  function purchase(accountId: ControlPlaneAccountId) {
    const requestId = randomUUID();
    const key = requestId.replaceAll("-", "");
    const checkoutId = `cs_test_${key}`;
    const customer = `cus_${key}`;
    const subscription = `sub_${key}`;
    const metadata = { account_id: accountId, request_id: requestId };
    const details = {
      id: subscription,
      customer,
      status: "active",
      latest_invoice: { status: "paid", attempt_count: 1 },
      metadata,
      items: {
        has_more: false,
        data: [{ quantity: 1, price: { id: "price_1", currency: "usd" } }],
      },
    } satisfies StripeSubscription;
    byRequest.set(requestId, checkoutId);
    subscriptions.set(subscription, details);
    return {
      requestId,
      details,
      subscription,
      customer,
      session: {
        id: checkoutId,
        mode: "subscription",
        client_reference_id: accountId,
        metadata,
        subscription,
        customer,
        payment_status: "paid",
        currency: "usd",
      },
    };
  }

  async function buy(existing?: Awaited<ReturnType<typeof createAccount>>) {
    const account = existing ?? (await createAccount());
    const order = purchase(account.id);
    const response = await http({
      method: "POST",
      url: accountCloudComputerCheckoutPath,
      headers: account.headers,
      payload: { requestId: order.requestId },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ url: checkoutUrl });
    expect((await webhook("checkout.session.completed", order.session)).statusCode).toBe(200);
    const id = (
      await database
        .selectFrom("cloudComputers")
        .select("id")
        .where("accountId", "=", account.id)
        .where("tombstonedAt", "is", null)
        .executeTakeFirstOrThrow()
    ).id;
    return { account, order, id };
  }

  async function getDesired(id: CloudComputerDesired["id"], provider?: "google") {
    const response = await http({
      method: "GET",
      url: provider
        ? `${cloudComputersDesiredPath}?provider=${provider}`
        : cloudComputersDesiredPath,
      headers: leaseHeaders(),
    });
    expect(response.statusCode, response.body).toBe(200);
    return CloudComputerDesiredResponseSchema.parse(response.json()).computers.find(
      (computer) => computer.id === id,
    );
  }

  function report(computer: CloudComputerDesired, patch: Partial<CloudComputerReport> = {}) {
    return http({
      method: "POST",
      url: cloudComputerStatusPath(computer.id),
      headers: leaseHeaders(),
      payload: {
        id: computer.id,
        generation: computer.generation,
        revision: computer.revision,
        phase: "ready",
        providerServerId: 7,
        ipv4: "192.0.2.7",
        ipv6: null,
        observedIdentity: identity,
        lastError: null,
        ...patch,
      },
    });
  }

  function boot(computer: CloudComputerDesired, token = computer.bootstrapToken, id = computer.id) {
    return http({
      method: "POST",
      url: cloudComputerBootPath(id),
      payload: { hostname: computer.hostname, bootstrapToken: token },
    });
  }

  function complete(computer: CloudComputerDesired, observed = identity) {
    return http({
      method: "POST",
      url: cloudComputerBootCompletePath(computer.id),
      payload: {
        hostname: computer.hostname,
        bootstrapToken: computer.bootstrapToken,
        identity: observed,
      },
    });
  }
  async function bootable(computer: CloudComputerDesired) {
    expect(
      (await report(computer, { phase: "provisioning", observedIdentity: null })).json(),
    ).toEqual({ recorded: true });
    return CloudComputerBootResponseSchema.parse((await boot(computer)).json());
  }

  function requestAs(
    account: Awaited<ReturnType<typeof createAccount>>,
    method: string,
    url: string,
    payload?: unknown,
  ) {
    return http({
      method,
      url,
      headers: account.headers,
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  it("reports only observed preparation, location, Home identity, egress and Stripe renewal facts", async () => {
    const { id, account, order } = await buy();
    const path = accountCloudComputerPath(id);
    const read = async () => {
      const response = await requestAs(account, "GET", path);
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const steps = (machine: string, opensteer: string, claim: string) => [
      { id: "payment", state: "done" },
      { id: "machine", state: machine },
      { id: "opensteer", state: opensteer },
      { id: "claim", state: claim },
    ];
    const initial = await read();
    expect(initial).toMatchObject({
      status: "preparing",
      region: { id: "us-central1-a", label: "Council Bluffs, IA" },
      steps: steps("current", "pending", "pending"),
    });
    for (const key of ["deploymentId", "egressAddress", "renewsAt", "lastBackupAt"])
      expect(initial).not.toHaveProperty(key);

    const endpoint = await cloud.addEgressEndpoint({
      url: "https://proxy.example.test:8443",
      username: "user",
      password: "test-password",
    });
    const preparing = (await getDesired(id))!;
    const install = await bootable(preparing);
    const booted = await read();
    // Its browser's egress is its pool host's to ask for, not its Home's boot.
    expect(booted).toMatchObject({
      status: "preparing",
      egress: "pending",
      steps: steps("done", "current", "pending"),
    });
    expect(booted).not.toHaveProperty("deploymentId");
    expect(booted).not.toHaveProperty("egressAddress");

    expect((await complete(preparing)).statusCode).toBe(200);
    expect(await cloud.assignEgress(id)).toMatchObject({ endpointId: endpoint });
    expect(await read()).toMatchObject({ egress: "assigned" });
    expect(await read()).not.toHaveProperty("egressAddress");
    await expect(cloud.setEgressAddress(endpoint, "proxy.example.test")).rejects.toThrow(
      "Invalid browser egress address",
    );
    await cloud.setEgressAddress(endpoint, "203.0.113.5");
    expect((await read()).egressAddress).toBe("203.0.113.5");
    await cloud.setEgressAddress(endpoint, null);
    expect(await read()).not.toHaveProperty("egressAddress");
    expect(await read()).toMatchObject({
      status: "preparing",
      deploymentId: identity.deploymentId,
      steps: steps("done", "current", "pending"),
    });
    expect((await report((await getDesired(id))!)).json()).toEqual({ recorded: true });
    expect(await read()).toMatchObject({
      status: "preparing",
      steps: steps("done", "done", "current"),
    });
    const home = fakeHome({ hostname: preparing.hostname, boot: install });
    expect(await claimer(home.fetch).runOnce()).toBe(1);

    const period = Math.floor(now.getTime() / 1000) + 3600;
    const stripePeriod = (current_period_end: number) => ({
      ...order.details,
      items: { has_more: false, data: [{ ...order.details.items.data[0]!, current_period_end }] },
    });
    subscriptions.set(order.subscription, stripePeriod(period));
    expect(
      (await webhook("customer.subscription.updated", { id: order.subscription })).statusCode,
    ).toBe(200);
    const ready = await read();
    expect(ready).toMatchObject({
      status: "ready",
      deploymentId: identity.deploymentId,
      renewsAt: new Date(period * 1000).toISOString(),
    });
    expect(ready).not.toHaveProperty("steps");

    subscriptions.set(order.subscription, stripePeriod(period + 3600));
    const billingErrors = vi.fn();
    await cloud.reconcileBilling(billingErrors);
    expect(billingErrors).not.toHaveBeenCalled();
    const listed = await requestAs(account, "GET", accountCloudComputersPath);
    expect(listed.json().computers).toMatchObject([
      {
        id,
        deploymentId: identity.deploymentId,
        renewsAt: new Date((period + 3600) * 1000).toISOString(),
      },
    ]);
    subscriptions.set(order.subscription, {
      ...stripePeriod(period + 3600),
      cancel_at_period_end: true,
    });
    expect(
      (await webhook("customer.subscription.updated", { id: order.subscription })).statusCode,
    ).toBe(200);
    expect(await read()).not.toHaveProperty("renewsAt");
  });

  it("returns distinct client reasons for purchase refusals and billing trouble", async () => {
    const { id, account, order } = await buy();
    const checkoutFor = (buyer: typeof account) =>
      requestAs(buyer, "POST", accountCloudComputerCheckoutPath, { requestId: randomUUID() });
    const duplicate = await checkoutFor(account);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: {
        reason: "cloud-computer-already-exists",
        message: "You already have a Cloud Computer subscription.",
      },
    });

    await buy();
    const buyer = await createAccount();
    const atCapacity = await checkoutFor(buyer);
    expect(atCapacity.statusCode).toBe(503);
    expect(atCapacity.json()).toMatchObject({
      error: {
        reason: "cloud-computer-no-capacity",
        message: "Cloud Computer checkout is not available right now",
      },
    });
    stripe.validateOffer.mockRejectedValueOnce(new Error("Invalid offer"));
    await expect(cloud.checkOffer()).rejects.toThrow("Invalid offer");
    const salesClosed = await checkoutFor(buyer);
    expect(salesClosed.statusCode).toBe(503);
    expect(salesClosed.json()).toMatchObject({
      error: {
        reason: "cloud-computer-sales-not-open",
        message: "Cloud Computer checkout is not available right now",
      },
    });

    subscriptions.set(order.subscription, { ...order.details, status: "past_due" });
    expect(
      (await webhook("invoice.payment_failed", { subscription: order.subscription })).statusCode,
    ).toBe(200);
    const billed = await requestAs(account, "GET", accountCloudComputerPath(id));
    expect(billed.json()).toMatchObject({
      status: "suspended",
      reason: "Your subscription needs attention.",
      reasonCode: "cloud-computer-billing-problem",
    });
  });

  it("mounts every Cloud Computer route in the production Fastify composition", async () => {
    const prefix = "/v1/cloud-computers";
    const account = accountCloudComputersPath;
    for (const [method, url] of [
      ["GET", `${prefix}/desired`],
      ["POST", `${prefix}/lease`],
      ["POST", `${prefix}/:id/check`],
      ["POST", `${prefix}/:id/status`],
      ["POST", `${prefix}/:id/boot`],
      ["POST", `${prefix}/:id/boot-complete`],
      ["POST", cloudComputerStripeWebhookPath],
      ["GET", account],
      ["GET", `${account}/:id`],
      ["DELETE", `${account}/:id`],
      ["POST", `${account}/:id/suspend`],
      ["POST", `${account}/:id/resume`],
      ["POST", accountCloudComputerCheckoutPath],
      ["POST", accountCloudComputerBillingPortalPath],
    ] as const)
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    expect(app.hasRoute({ method: "POST", url: `${prefix}/:id/bootstrap` })).toBe(false);
    const denied = await http({ method: "GET", url: cloudComputersDesiredPath });
    expect(denied.statusCode).toBe(401);
    const competing = await http({
      method: "POST",
      url: cloudComputerLeasePath,
      headers: leaseHeaders(),
      payload: { holder: randomUUID() },
    });
    expect(competing.statusCode).toBe(409);
  });

  it("runs checkout through the real reconciler, boot configuration, readiness, suspend, resume and tombstone", async () => {
    const { account, order, id } = await buy();
    const first = await getDesired(id);
    let server:
      | {
          id: number;
          generation: number;
          status: "off" | "running";
          ipv4: string;
          ipv6: null;
          firewalls: readonly [];
        }
      | undefined;
    let records = false;
    let bootCount = 0;
    let booted: CloudComputerBootResponse | undefined;
    const provider = {
      ensureFirewall: async () => 1,
      ensureFirewallAttached: async () => true,
      listManaged: async () => [],
      find: async () => (server ? [server] : []),
      create: async ({ generation, userData }: { generation: number; userData: string }) => {
        expect(first?.bootstrapToken).toBeTruthy();
        expect(userData).toContain(first!.bootstrapToken!);
        server = { id: 7, generation, status: "off", ipv4: "192.0.2.7", ipv6: null, firewalls: [] };
        return server;
      },
      describe: async () => server,
      powerOn: async () => {
        if (!bootCount++) {
          const response = await boot(first!);
          expect(response.statusCode, response.body).toBe(200);
          booted = CloudComputerBootResponseSchema.parse(response.json());
          expect(booted).toMatchObject({
            hostname: first!.hostname,
            accountOrigin: publicOrigin.origin,
            release: { version: "1.2.3" },
            // What the Home needs to accept its Account-bound claim and Account sign-in.
            managedHome: {
              cloudComputerId: first!.id,
              generation: first!.generation,
              oidc: { clientId: expect.stringMatching(/^occ_/u) },
            },
          });
        }
        server = { ...server!, status: "running" };
      },
      powerOff: async () => {
        server = { ...server!, status: "off" };
      },
      delete: async () => {
        server = undefined;
      },
    };
    const dns = {
      listManaged: async () => [],
      ensureRecords: async () => {
        records = true;
      },
      removeRecords: async () => {
        records = false;
      },
    };
    const { accountClient } = await vi.importActual<{
      accountClient: (
        origin: URL,
        token: () => Promise<string>,
        http: { timeoutMs: number },
        holder: string,
      ) => {
        desired: (signal: AbortSignal) => Promise<readonly CloudComputerDesired[]>;
        report: (report: CloudComputerReport, signal: AbortSignal) => Promise<boolean>;
      };
    }>("../../../home-provisioner/src/account.js");
    const options = {
      account: accountClient(listener, async () => provisionerToken, { timeoutMs: 5000 }, lease),
      provider,
      dns,
      discover: async () => identity,
      accountOrigin: publicOrigin,
      image: "image",
      defaultRegion: "us-central1-a",
      defaultServerType: "e2-standard-4",
      concurrency: 1,
      readinessTimeoutMs: 10_000,
    };
    const { Reconciler } = await vi.importActual<{
      Reconciler: new (input: typeof options) => { pass: (signal: AbortSignal) => Promise<void> };
    }>("../../../home-provisioner/src/reconcile.js");
    const reconciler = new Reconciler(options);
    const pass = () => reconciler.pass(new AbortController().signal);
    const path = accountCloudComputerPath(id);
    const read = () => http({ method: "GET", url: path, headers: account.headers });
    const mutation = (action: string) =>
      http({ method: "POST", url: `${path}/${action}`, headers: account.headers });
    expect((await read()).json()).toMatchObject({ status: "preparing" });
    await pass();
    expect(records).toBe(true);
    expect(kickBootstrap).not.toHaveBeenCalled();
    expect((await complete(first!)).json()).toEqual({ completed: true });
    await pass();
    // Running is not ready: nobody can sign in until the Home is claimed for its Account.
    expect((await read()).json()).toMatchObject({ status: "preparing" });
    expect(kickBootstrap).toHaveBeenCalledOnce();
    await expect(directory.listDeployments(account.id)).resolves.toEqual([]);
    const home = fakeHome({ hostname: first!.hostname, boot: booted! });
    expect(await claimer(home.fetch).runOnce()).toBe(1);
    expect(claimErrors).toEqual([]);
    expect(home.state.owner).toBe(account.id);
    expect((await read()).json()).toMatchObject({
      status: "ready",
      address: `https://${first!.hostname}`,
      egress: "pending",
    });
    // Its owner's devices list it as a Home at its own address, signed in with their Account.
    await expect(directory.listDeployments(account.id)).resolves.toMatchObject([
      {
        id: identity.deploymentId,
        access: "owner",
        canonicalOrigin: `https://${first!.hostname}`,
        reachability: "canonical",
        authorityEnvelope: { document: { deploymentShape: { kind: "personal" } } },
      },
    ]);
    await expect(
      database
        .selectFrom("oauthClients")
        .select(["clientId", "redirectUris", "userId"])
        .where("clientId", "=", booted!.managedHome!.oidc.clientId)
        .executeTakeFirst(),
    ).resolves.toMatchObject({
      redirectUris: [`https://${first!.hostname}/v1/auth/oidc/callback`],
      userId: account.id,
    });
    expect(await claimer(home.fetch).runOnce()).toBe(0);
    expect(records).toBe(true);
    expect((await getDesired(id))?.observedIdentity).toEqual(identity);
    expect((await boot(first!)).statusCode).toBe(401);
    expect((await mutation("suspend")).statusCode).toBe(200);
    expect((await mutation("resume")).statusCode).toBe(200);
    await pass();
    expect((await read()).json()).toMatchObject({ status: "ready" });
    expect((await mutation("suspend")).statusCode).toBe(200);
    await pass();
    expect(server?.status).toBe("off");
    expect(records).toBe(false);
    expect((await read()).json()).toMatchObject({
      status: "suspended",
      reason: "You suspended this Cloud Computer.",
    });
    expect((await mutation("resume")).statusCode).toBe(200);
    await pass();
    expect((await read()).json()).toMatchObject({ status: "ready" });
    expect(
      (
        await http({
          method: "POST",
          url: accountCloudComputerBillingPortalPath,
          headers: account.headers,
        })
      ).json(),
    ).toEqual({ url: portalUrl });
    expect(stripe.portal).toHaveBeenCalledOnce();
    const [customer, returnUrl, configuration] = stripe.portal.mock.calls[0]!;
    expect(configuration).toBe("bpc_cloud");
    expect(customer).toBe(order.customer);
    expect(returnUrl).toBeUndefined();
    expect(
      (
        await http({
          method: "DELETE",
          url: path,
          headers: account.headers,
          payload: { confirmation: id },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await http({
          method: "DELETE",
          url: path,
          headers: account.headers,
          payload: { confirmation: cloudComputerDeleteConfirmation(id) },
        })
      ).statusCode,
    ).toBe(200);
    expect((await getDesired(id))?.state).toBe("deleted");
    await pass();
    expect(server).toBeUndefined();
    expect(records).toBe(false);
    expect(await getDesired(id)).toBeUndefined();
    expect((await read()).json()).toMatchObject({ status: "deleted" });
    // A deleted Cloud Computer leaves no listing and no sign-in client behind.
    await expect(directory.listDeployments(account.id)).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("oauthClients")
        .select("clientId")
        .where("clientId", "=", booted!.managedHome!.oidc.clientId)
        .execute(),
    ).resolves.toEqual([]);
    expect(
      (
        await database
          .selectFrom("cloudComputers")
          .select("tombstonedAt")
          .where("id", "=", id)
          .executeTakeFirst()
      )?.tombstonedAt,
    ).toBeInstanceOf(Date);
  });

  it("replays checkout requests and events, fences one live computer and honors billing without undoing manual suspension", async () => {
    const { account, order, id } = await buy();
    const start = (requestId: string) =>
      http({
        method: "POST",
        url: accountCloudComputerCheckoutPath,
        headers: account.headers,
        payload: { requestId },
      });
    expect((await start(order.requestId)).json()).toEqual({ url: checkoutUrl });
    expect(checkout).toHaveBeenCalledOnce();
    expect((await start(randomUUID())).statusCode).toBe(409);
    expect(
      (await webhook("checkout.session.completed", order.session, "evt_replay")).statusCode,
    ).toBe(200);
    expect(
      (await webhook("checkout.session.completed", order.session, "evt_replay")).statusCode,
    ).toBe(200);
    const list = await http({
      method: "GET",
      url: accountCloudComputersPath,
      headers: account.headers,
    });
    expect(list.json()).toMatchObject({ computers: [{ id }], plan: config.plan });
    expect(
      await database
        .selectFrom("cloudComputerStripeEvents")
        .selectAll()
        .where("id", "=", "evt_replay")
        .execute(),
    ).toHaveLength(1);
    expect(stripe.subscription).toHaveBeenCalledOnce();

    const invoice = { parent: { subscription_details: { subscription: order.subscription } } };
    subscriptions.set(order.subscription, { ...order.details, status: "past_due" });
    expect((await webhook("invoice.payment_failed", invoice, "evt_failed")).statusCode).toBe(200);
    expect((await webhook("invoice.payment_failed", invoice, "evt_failed")).statusCode).toBe(200);
    expect(stripe.subscription).toHaveBeenCalledTimes(2);
    expect(await cloud.show(id)).toMatchObject({ status: "suspended" });
    subscriptions.set(order.subscription, order.details);
    expect((await webhook("invoice.paid", invoice)).statusCode).toBe(200);
    expect((await getDesired(id))?.state).toBe("active");
    await cloud.mutate(id, "suspend", account.id);
    expect((await webhook("invoice.paid", invoice)).statusCode).toBe(200);
    expect((await getDesired(id))?.state).toBe("suspended");
    await cloud.mutate(id, "resume", account.id);
    subscriptions.set(order.subscription, { ...order.details, status: "canceled" });
    expect(
      (await webhook("customer.subscription.deleted", { id: order.subscription })).statusCode,
    ).toBe(200);
    expect((await webhook("invoice.paid", invoice)).statusCode).toBe(200);
    expect((await getDesired(id))?.state).toBe("suspended");
    expect(await cloud.show(id)).toMatchObject({ reason: "Your subscription ended." });
  });

  it("starts boot expiry on server creation, fences revisions, and pins only boot-complete", async () => {
    const { account, id } = await buy();
    expect(
      (
        await http({
          method: "GET",
          url: cloudComputersDesiredPath,
          headers: {
            authorization: `Bearer ${await workloadToken("team@example.iam.gserviceaccount.com")}`,
          },
        })
      ).statusCode,
    ).toBe(403);
    const initial = (await getDesired(id))!;
    expect(initial.bootstrapToken).toBeTruthy();
    const denied = await boot(
      initial,
      initial.bootstrapToken,
      CloudComputerIdSchema.parse(`cc_${randomUUID()}`),
    );
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain(initial.bootstrapToken!);
    expect((await boot(initial)).statusCode).toBe(401);
    expect((await report(initial)).json()).toEqual({ recorded: false });
    now = new Date(now.getTime() + 21 * 60_000);
    expect(await cloud.lease(lease, true)).toBe(true);
    expect((await getDesired(id))?.bootstrapToken).toBe(initial.bootstrapToken);
    await cloud.mutate(id, "reissue");
    const first = (await getDesired(id))!;
    expect(first.generation).toBe(initial.generation);
    expect(first.bootstrapToken).not.toBe(initial.bootstrapToken);
    expect(
      (await report(initial, { phase: "provisioning", observedIdentity: null })).json(),
    ).toEqual({ recorded: false });

    const config = await bootable(first);
    expect((await boot(first)).json()).toEqual(config);
    expect((await getDesired(id))?.observedIdentity).toBeUndefined();
    expect((await report(first)).json()).toEqual({ recorded: false });
    expect((await complete(first)).json()).toEqual({ completed: true });
    expect((await complete(first)).json()).toEqual({ completed: true });
    expect(
      (await complete(first, { ...identity, hostKeyFingerprint: `sha256:${"b".repeat(43)}` }))
        .statusCode,
    ).toBe(401);
    expect((await boot(first)).statusCode).toBe(401);
    const pinned = (await getDesired(id))!;
    expect(pinned.observedIdentity).toEqual(identity);
    expect((await report(pinned)).json()).toEqual({ recorded: true });
    expect(
      (
        await report(pinned, {
          observedIdentity: { ...identity, hostKeyFingerprint: `sha256:${"b".repeat(43)}` },
        })
      ).statusCode,
    ).toBe(409);
    const setup = await cloud.setupCodeForReadyHome(id, pinned.generation);
    expect(digestSecret(setup!)).toBe(config.setupCodeDigest);
    expect(JSON.stringify(config)).not.toContain(setup!);
    expect(logs.join("")).not.toContain(first.bootstrapToken!);

    now = new Date(now.getTime() + 50);
    expect((await report(pinned, { phase: "booting" })).json()).toEqual({ recorded: true });
    expect((await getDesired(id))?.readinessStartedAt).toBe(now.toISOString());
    expect((await getDesired(id))?.observedIdentity).toEqual(identity);

    await expect(cloud.mutate(id, "reissue")).rejects.toThrow("working Home");
    await expect(cloud.mutate(id, "replace", undefined, "")).rejects.toThrow("snapshot");
    await runCloudComputerOperator(cloud, ["replace", id, "aabbccdd"]);
    const replacement = (await getDesired(id))!;
    expect(replacement).toMatchObject({
      generation: pinned.generation + 1,
      restoreSnapshot: "aabbccdd",
      previousProviderServerId: 7,
    });
    expect((await boot(replacement, first.bootstrapToken)).statusCode).toBe(401);
    const newConfig = await bootable(replacement);
    expect(newConfig.restoreSnapshot).toBe("aabbccdd");
    now = new Date(now.getTime() + 21 * 60_000);
    expect((await boot(replacement)).statusCode).toBe(401);
    expect((await complete(replacement)).statusCode).toBe(401);
    expect((await requestAs(account, "GET", accountCloudComputerPath(id))).json()).toMatchObject({
      status: "needs_attention",
      reasonCode: "cloud-computer-bootstrap-expired",
      reason: "Setup took too long to finish. Try again or contact support.",
    });
  });

  it("recovers a claim the Home committed from the Home's own receipt", async () => {
    const { account, id } = await buy();
    const computer = (await getDesired(id))!;
    const booted = await bootable(computer);
    expect((await complete(computer)).statusCode).toBe(200);
    expect((await report((await getDesired(id))!)).json()).toEqual({ recorded: true });
    const home = fakeHome({ hostname: computer.hostname, boot: booted });
    let crash = true;
    const crashing = {
      claimDue: () => cloud.claimDue(),
      claimMaterial: (job: Parameters<typeof cloud.claimMaterial>[0]) => cloud.claimMaterial(job),
      deferClaim: (job: Parameters<typeof cloud.deferClaim>[0], at: Date) =>
        cloud.deferClaim(job, at),
      failClaim: (job: Parameters<typeof cloud.failClaim>[0], reason: string) =>
        cloud.failClaim(job, reason),
      recordClaim: async (...args: Parameters<typeof cloud.recordClaim>) => {
        if (crash) {
          crash = false;
          throw new Error("Account stopped before recording the claim");
        }
        return cloud.recordClaim(...args);
      },
    };
    // The Home committed its owner, then Account lost the answer.
    expect(await claimer(home.fetch, crashing).runOnce()).toBe(1);
    expect(home.state.owner).toBe(account.id);
    const first = home.state.receipt;
    expect((await cloud.show(id, account.id)).status).toBe("preparing");
    // Not due again until its backoff passes.
    expect(await claimer(home.fetch).runOnce()).toBe(0);
    // Its backoff elapses (moved, not waited for: the assertion is signed at the real time).
    await database
      .updateTable("cloudComputers")
      .set({ claimNextAt: new Date(now.getTime() - 1) })
      .where("id", "=", id)
      .execute();
    expect(await claimer(home.fetch).runOnce()).toBe(1);
    expect(claimErrors).toHaveLength(1);
    expect(home.state.claims).toBe(2);
    expect(home.state.receipt).toBe(first);
    expect(
      (
        await database
          .selectFrom("cloudComputers")
          .select("bootstrapReceipt")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).bootstrapReceipt,
    ).toEqual(first);
    expect((await cloud.show(id, account.id)).status).toBe("ready");
    await expect(directory.listDeployments(account.id)).resolves.toHaveLength(1);
  });

  it("never claims a Home whose identity differs from the one Account pinned", async () => {
    const { account, id } = await buy();
    const computer = (await getDesired(id))!;
    const booted = await bootable(computer);
    expect((await complete(computer)).statusCode).toBe(200);
    expect((await report((await getDesired(id))!)).json()).toEqual({ recorded: true });
    const impostor = fakeHome({
      hostname: computer.hostname,
      boot: booted,
      deploymentId: "dep_00000000-0000-4000-8000-000000000099",
    });
    expect(await claimer(impostor.fetch).runOnce()).toBe(1);
    expect(impostor.state.claims).toBe(0);
    expect(await cloud.show(id, account.id)).toMatchObject({
      status: "needs_attention",
      reason: "Opensteer couldn’t link this Cloud Computer to your account. Contact support.",
    });
    expect(await claimer(impostor.fetch).runOnce()).toBe(0);
    await expect(directory.listDeployments(account.id)).resolves.toEqual([]);
    expect(await runCloudComputerOperator(cloud, ["show", id])).toMatchObject({
      claim: { error: "setup-failed", receiptAt: null },
    });
    await database
      .updateTable("cloudComputers")
      .set({ readinessStartedAt: new Date(now.getTime() - 61 * 60_000) })
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(await runCloudComputerOperator(cloud, ["claim-retry", id])).toEqual({ queued: true });
    const home = fakeHome({ hostname: computer.hostname, boot: booted });
    expect(await claimer(home.fetch).runOnce()).toBe(1);
    expect(home.state.owner).toBe(account.id);
    expect(await runCloudComputerOperator(cloud, ["show", id])).toMatchObject({
      claim: { error: null, receiptAt: expect.any(Date) },
      generation: computer.generation,
      readinessStartedAt: now,
    });
    await expect(runCloudComputerOperator(cloud, ["claim-retry", id])).rejects.toThrow(
      "no eligible failed claim",
    );
  });

  it("diagnoses a Home with operator list and show without printing boot secrets", async () => {
    const { account, id } = await buy();
    const computer = (await getDesired(id))!;
    const booted = await bootable(computer);
    expect(booted.releaseManifestUrl).toBe(releaseManifestUrl);
    expect(booted.release.images.host).toMatch(/@sha256:/u);
    const run = (...args: string[]) => runCloudComputerOperator(cloud, args);
    expect(await run("show", id)).toMatchObject({
      id,
      accountId: account.id,
      state: "active",
      phase: "provisioning",
      generation: computer.generation,
      revision: computer.revision,
      hostname: computer.hostname,
      providerServerId: "7",
      ipv4: "192.0.2.7",
      bootstrapExpiresAt: expect.any(Date),
      deletionRequestedAt: null,
    });
    expect((await complete(computer)).statusCode).toBe(200);
    const pinned = (await getDesired(id))!;
    expect((await report(pinned)).statusCode).toBe(200);
    const view = await run("show", id);
    expect(view).toMatchObject({
      phase: "ready",
      deploymentId: identity.deploymentId,
      hostKeyFingerprint: identity.hostKeyFingerprint,
      bootCompletedAt: expect.any(Date),
      claim: { error: null, receiptAt: null },
      lastError: null,
    });
    expect(await run("list")).toEqual([view]);
    const output = JSON.stringify(view);
    for (const secret of [
      computer.bootstrapToken,
      booted.managedHome?.oidc.clientSecret,
      booted.setupCodeDigest,
      booted.backup.password,
      booted.backup.secretAccessKey,
    ])
      expect(output).not.toContain(secret!);
    expect(cloudComputerOperatorUsage).toContain("sudo opensteer-home snapshots");
    stripe.cancel.mockRejectedValueOnce(new Error("Stripe is unreachable"));
    await run("delete", id);
    expect(await run("show", id)).toMatchObject({ deletionRequestedAt: expect.any(Date) });
  });

  it("lists reserved backup targets and removes released targets without permitting old prefixes", async () => {
    const account = await createAccount();
    const order = purchase(account.id);
    expect(
      (
        await requestAs(account, "POST", accountCloudComputerCheckoutPath, {
          requestId: order.requestId,
        })
      ).statusCode,
    ).toBe(200);
    const run = (...args: string[]) => runCloudComputerOperator(cloud, args);
    const pool = await cloud.listBackupTargets();
    const reserved = pool.find((target) => target.reserved)!;
    expect(await run("backup-list")).toContainEqual(
      expect.objectContaining({
        id: reserved.id,
        computerId: null,
        reservation: {
          accountId: account.id,
          requestId: order.requestId,
          stripeSessionId: order.session.id,
          expiresAt: expect.any(Date),
          paidAt: null,
        },
      }),
    );
    expect(JSON.stringify(pool)).not.toMatch(/secret-[ab]|access-[ab]|checkout\.stripe/u);
    await expect(run("backup-remove", reserved.id)).rejects.toThrow("reserved");
    expect((await webhook("checkout.session.completed", order.session)).statusCode).toBe(200);
    const id = (await cloud.listForAccount(account.id))[0]!.id;
    await expect(run("backup-remove", reserved.id)).rejects.toThrow("assigned");
    await run("delete", id);
    const deleting = (await getDesired(id))!;
    await report(deleting, {
      phase: "deleted",
      providerServerId: null,
      ipv4: null,
      observedIdentity: null,
    });
    expect(await run("backup-list")).toContainEqual(
      expect.objectContaining({
        id: reserved.id,
        needsRotation: true,
        reserved: false,
      }),
    );
    await expect(run("backup-remove", reserved.id)).rejects.toThrow("reserved");
    await cloud.reconcileBackupErasure(() => {
      throw new Error("Purge failed");
    });
    expect(await run("backup-remove", reserved.id)).toEqual({ removed: true });
    expect(await run("backup-list")).not.toContainEqual(
      expect.objectContaining({ id: reserved.id }),
    );
    await expect(
      cloud.addBackupTarget({
        endpoint: reserved.endpoint,
        bucket: reserved.bucket,
        prefix: reserved.prefix,
        accessKeyId: "new-key",
        secretAccessKey: "new-secret",
      }),
    ).rejects.toThrow();
  });

  it("accepts only current Home backup reports and keeps the most recent completion", async () => {
    const { account, id } = await buy();
    const current = (await getDesired(id))!;
    const first = (await bootable(current)).managedHome!.oidc;
    const published = { completedAt: now.toISOString(), snapshotId: "a".repeat(64) };
    const send = (oidc: typeof first, payload: unknown) =>
      http({
        method: "POST",
        url: cloudComputerBackupReportPath(id),
        headers: {
          authorization: `Basic ${Buffer.from(`${oidc.clientId}:${oidc.clientSecret}`).toString("base64")}`,
        },
        payload,
      });
    const read = () => requestAs(account, "GET", accountCloudComputerPath(id));
    expect((await read()).json()).not.toHaveProperty("lastBackupAt");
    expect((await send(first, published)).statusCode).toBe(401);
    expect((await complete(current)).statusCode).toBe(200);
    expect((await send(first, { ...published, snapshotId: "wrong" })).statusCode).toBe(400);
    const accepted = await send(first, published);
    expect(accepted.statusCode).toBe(204);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect((await read()).json()).toHaveProperty("lastBackupAt", published.completedAt);
    expect(
      (await requestAs(account, "GET", accountCloudComputersPath)).json().computers,
    ).toContainEqual(expect.objectContaining({ id, lastBackupAt: published.completedAt }));
    const stale = {
      completedAt: new Date(now.getTime() - 1000).toISOString(),
      snapshotId: "b".repeat(64),
    };
    expect((await send(first, stale)).statusCode).toBe(204);
    expect((await read()).json()).toHaveProperty("lastBackupAt", published.completedAt);

    await cloud.mutate(id, "reissue");
    const next = (await getDesired(id))!;
    const replacement = (await bootable(next)).managedHome!.oidc;
    expect((await complete(next)).statusCode).toBe(200);
    const later = {
      completedAt: new Date(now.getTime() + 1000).toISOString(),
      snapshotId: "c".repeat(64),
    };
    expect((await send(first, later)).statusCode).toBe(401);
    expect((await read()).json()).toHaveProperty("lastBackupAt", published.completedAt);
    expect((await send(replacement, later)).statusCode).toBe(204);
    expect((await read()).json()).toHaveProperty("lastBackupAt", later.completedAt);
  });

  it("assigns a late egress endpoint and never serves it to the Home, whose browser is in the pool", async () => {
    const { account, id } = await buy();
    const computer = (await getDesired(id))!;
    const booted = await bootable(computer);
    expect(booted.egress).toBeUndefined();
    const oidc = booted.managedHome!.oidc;
    const credentials = (secret: string) =>
      `Basic ${Buffer.from(`${oidc.clientId}:${secret}`).toString("base64")}`;
    const read = (authorization?: string) =>
      http({
        method: "GET",
        url: cloudComputerEgressPath(id),
        ...(authorization ? { headers: { authorization } } : {}),
      });
    const run = (...args: string[]) => runCloudComputerOperator(cloud, args);
    expect((await read(credentials(oidc.clientSecret))).statusCode).toBe(401);
    await expect(run("egress-assign", id)).rejects.toThrow("active and booted");
    expect((await complete(computer)).statusCode).toBe(200);
    expect((await read(credentials(oidc.clientSecret))).json()).toEqual({});
    await expect(run("egress-assign", id)).rejects.toThrow("No browser egress endpoint");
    const proxy = {
      url: "https://late.example.test:8443",
      username: "late-user",
      password: "late-password",
    };
    const endpointId = await cloud.addEgressEndpoint({ ...proxy, publicAddress: "192.0.2.8" });
    expect(await run("egress-assign", id)).toEqual({ endpointId, publicAddress: "192.0.2.8" });
    expect(await run("egress-assign", id)).toEqual({ endpointId, publicAddress: "192.0.2.8" });
    expect(await run("egress-list")).toEqual([
      {
        id: endpointId,
        computerId: id,
        needsRotation: false,
        url: proxy.url,
        username: proxy.username,
        publicAddress: "192.0.2.8",
      },
    ]);
    const authorized = await read(credentials(oidc.clientSecret));
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["cache-control"]).toBe("no-store");
    // T9: only its pool host holds the egress password.
    expect(authorized.json()).toEqual({});
    expect((await read()).statusCode).toBe(401);
    expect((await read(credentials("ocs_" + "A".repeat(43)))).statusCode).toBe(401);
    expect((await read(`Bearer ${computer.bootstrapToken}`)).statusCode).toBe(401);
    await expect(run("egress-remove", endpointId)).rejects.toThrow("assigned");
    expect(
      (await requestAs(account, "POST", `${accountCloudComputerPath(id)}/suspend`)).statusCode,
    ).toBe(200);
    expect((await read(credentials(oidc.clientSecret))).statusCode).toBe(401);
    await run("delete", id);
    const deleting = (await getDesired(id))!;
    await report(deleting, {
      phase: "deleted",
      providerServerId: null,
      ipv4: null,
      observedIdentity: null,
    });
    expect(await run("egress-list")).toContainEqual(
      expect.objectContaining({ id: endpointId, needsRotation: true }),
    );
    expect(await run("egress-remove", endpointId)).toEqual({ removed: true });
    expect(await run("egress-list")).toEqual([]);
    await expect(cloud.addEgressEndpoint(proxy)).rejects.toThrow("new password");
    await expect(
      cloud.addEgressEndpoint({ ...proxy, password: "new-late-password" }),
    ).resolves.toBe(endpointId);
    expect(logs.join("")).not.toContain(proxy.password);
  });

  it("shows the lease and atomically releases only the named expired holder", async () => {
    const run = (...args: string[]) => runCloudComputerOperator(cloud, args);
    expect(await run("lease-show")).toMatchObject({
      holder: lease,
      expiresAt: expect.any(Date),
      expired: false,
    });
    await expect(run("lease-release", lease)).rejects.toThrow("expired lease");
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    expect(await run("lease-show")).toMatchObject({ holder: lease, expired: true });
    await expect(run("lease-release", randomUUID())).rejects.toThrow("expired lease");
    expect(await run("lease-release", lease)).toEqual({ released: true });
    expect(await run("lease-show")).toBeNull();
    const holder = randomUUID();
    expect(
      (
        await http({
          method: "POST",
          url: cloudComputerLeasePath,
          headers: leaseHeaders(),
          payload: { holder },
        })
      ).statusCode,
    ).toBe(200);
    await expect(run("lease-release", lease)).rejects.toThrow("expired lease");
    expect(await run("lease-show")).toMatchObject({ holder, expired: false });
  });

  it("runs billing once through the shared advisory lock and redacts diagnostic errors", async () => {
    const run = () => runCloudComputerOperator(cloud, ["billing-reconcile"]);
    await database.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(hashtextextended('cloud-computer-billing-reconcile',0))`.execute(
        connection,
      );
      try {
        expect(await run()).toEqual({ ran: false, errors: [] });
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended('cloud-computer-billing-reconcile',0))`.execute(
          connection,
        );
      }
    });
    stripe.validateOffer.mockRejectedValueOnce(
      new ControlPlaneError("unavailable", "sk_test_private", {
        cause: new Error("webhook-secret-private"),
      }),
    );
    expect(await run()).toEqual({
      ran: true,
      errors: [
        {
          type: "ControlPlaneError",
          code: "unavailable",
          status: 503,
          message: "Account billing request failed",
        },
      ],
    });
  });

  it("keeps deletion pending without key erasure and a backup target reserved until an empty listing", async () => {
    const { id, account } = await buy();
    const original = await getDesired(id);
    const booted = await bootable(original!);
    const target = (await cloud.listBackupTargets()).find(({ computerId }) => computerId === id)!;
    expect(await vault.read(id, 1)).toBe(booted.backup.password);
    const url = accountCloudComputerPath(id);
    expect(
      (
        await requestAs(account, "DELETE", url, {
          confirmation: cloudComputerDeleteConfirmation(id),
        })
      ).statusCode,
    ).toBe(200);
    eraseKey.mockRejectedValueOnce(new Error("Vault timeout"));
    const deleting = (await getDesired(id))!;
    expect(
      (
        await report(deleting, {
          phase: "deleted",
          providerServerId: null,
          ipv4: null,
          observedIdentity: null,
        })
      ).json(),
    ).toEqual({ recorded: true });
    expect((await requestAs(account, "GET", url)).json()).toMatchObject({
      status: "needs_attention",
      deletion: {
        computerDestroyedAt: expect.any(String),
        backupsUnreadableAt: null,
        storedBackupDataRemovedAt: null,
      },
    });
    expect((await cloud.listBackupTargets()).find(({ id }) => id === target.id)).toMatchObject({
      purgeComputerId: id,
    });
    await expect(cloud.removeBackupTarget(target.id)).rejects.toThrow("reserved");

    const errors = vi.fn();
    purge.mockRejectedValueOnce(new Error("Storage unavailable")).mockResolvedValueOnce(false);
    await cloud.reconcileBackupErasure(errors);
    expect(errors).toHaveBeenCalledOnce();
    await expect(vault.read(id, 1)).rejects.toThrow("No test backup key");
    expect((await requestAs(account, "GET", url)).json()).toMatchObject({
      status: "deleted",
      deletion: {
        computerDestroyedAt: expect.any(String),
        backupsUnreadableAt: expect.any(String),
        storedBackupDataRemovedAt: null,
      },
    });
    await cloud.reconcileBackupErasure(errors);
    await expect(cloud.removeBackupTarget(target.id)).rejects.toThrow("reserved");
    expect(purge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prefix: booted.backup.prefix,
        accessKeyId: booted.backup.accessKeyId,
        secretAccessKey: booted.backup.secretAccessKey,
      }),
    );
    await cloud.reconcileBackupErasure(errors);
    expect((await requestAs(account, "GET", url)).json()).toMatchObject({
      status: "deleted",
      deletion: { storedBackupDataRemovedAt: expect.any(String) },
    });
    await expect(cloud.removeBackupTarget(target.id)).resolves.toBeUndefined();
  });

  it("assigns egress exclusively and releases it only upon a confirmed tombstone", async () => {
    const endpoint = {
      url: "https://proxy.example.test:8443",
      username: "egress-user",
      password: "egress-password",
    };
    const endpointId = await cloud.addEgressEndpoint(endpoint);
    await expect(cloud.addEgressEndpoint({ ...endpoint, username: "second-user" })).rejects.toThrow(
      "already exists",
    );
    const first = (await getDesired((await buy()).id))!;
    const second = (await getDesired((await buy()).id))!;
    const firstBoot = await bootable(first);
    const secondBoot = await bootable(second);
    expect(firstBoot.backup.accessKeyId).not.toBe(secondBoot.backup.accessKeyId);
    expect(firstBoot.backup.prefix).not.toBe(secondBoot.backup.prefix);
    // A Home's boot carries no egress: its browser's pool host asks for it.
    expect(firstBoot).not.toHaveProperty("egress");
    expect(secondBoot).not.toHaveProperty("egress");
    expect(secondBoot.backup.password).not.toBe(firstBoot.backup.password);
    expect((await complete(first)).statusCode).toBe(200);
    expect((await complete(second)).statusCode).toBe(200);
    expect(await cloud.assignEgress(first.id)).toMatchObject({ endpointId });
    await expect(cloud.assignEgress(second.id)).rejects.toThrow("No browser egress endpoint");
    await expect(cloud.removeEgressEndpoint(endpointId)).rejects.toThrow("assigned");
    await cloud.mutate(first.id, "delete");
    expect((await cloud.listEgressEndpoints())[0]?.computerId).toBe(first.id);
    expect(
      (
        await report((await getDesired(first.id))!, {
          phase: "deleted",
          providerServerId: null,
          ipv4: null,
          observedIdentity: null,
        })
      ).statusCode,
    ).toBe(200);
    expect((await cloud.listEgressEndpoints())[0]?.computerId).toBeNull();
    // Released, it waits for new credentials before anyone else gets it.
    await expect(cloud.assignEgress(second.id)).rejects.toThrow("No browser egress endpoint");
    expect((await cloud.listEgressEndpoints())[0]?.needsRotation).toBe(true);
    const retired = (await cloud.listBackupTargets()).find(
      (target) => target.prefix === firstBoot.backup.prefix,
    )!;
    expect(retired.needsRotation).toBe(true);
    const customer = await createAccount();
    const order = purchase(customer.id);
    await expect(cloud.checkout(customer.id, order.requestId)).rejects.toThrow(
      "not available right now",
    );
    await cloud.reconcileBackupErasure(() => {
      throw new Error("Purge failed");
    });
    await expect(
      cloud.rotateBackupTarget(retired.id, {
        prefix: retired.prefix,
        accessKeyId: "access-c",
        secretAccessKey: "secret-c",
      }),
    ).rejects.toThrow("current or retired target");
    await cloud.rotateBackupTarget(retired.id, {
      prefix: "third",
      accessKeyId: "access-c",
      secretAccessKey: "secret-c",
    });
    await expect(
      cloud.addBackupTarget({
        endpoint: retired.endpoint,
        bucket: retired.bucket,
        prefix: retired.prefix,
        accessKeyId: "access-d",
        secretAccessKey: "secret-d",
      }),
    ).rejects.toThrow("current or retired target");
    await cloud.rotateEgressEndpoint(endpointId, {
      username: "egress-user",
      password: "rotated-password",
    });
    const third = await buy(customer);
    const thirdDesired = (await getDesired(third.id))!;
    const config = await bootable(thirdDesired);
    expect(config.backup.accessKeyId).toBe("access-c");
    expect(config.backup.prefix).toBe("third");
    expect((await complete(thirdDesired)).statusCode).toBe(200);
    expect((await cloud.listEgressEndpoints())[0]?.needsRotation).toBe(false);
    expect(await cloud.assignEgress(third.id)).toMatchObject({ endpointId });
  });

  it("records delete before contacting Stripe and tombstones only after cancellation", async () => {
    const { id, account, order } = await buy();
    await bootable((await getDesired(id))!);
    stripe.cancel.mockRejectedValueOnce(new Error("Stripe unavailable"));
    expect(await cloud.mutate(id, "delete", account.id)).toMatchObject({
      status: "needs_attention",
    });
    expect((await getDesired(id))?.state).toBe("active");
    expect(
      (
        await database
          .selectFrom("cloudComputers")
          .select("deletionRequestedAt")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).deletionRequestedAt,
    ).toBeInstanceOf(Date);
    const errors: unknown[] = [];
    await cloud.reconcileBilling((error) => errors.push(error));
    expect(stripe.cancel).toHaveBeenLastCalledWith(order.subscription);
    expect((await getDesired(id))?.state).toBe("deleted");
    // The first attempt failed: the pass says so once it is cancelled, and refunds nothing.
    expect(errors).toEqual([expect.objectContaining({ name: "CloudComputerCancelledLate" })]);
  });

  it("reuses the same suspended Home after a final subscription cancellation", async () => {
    const { id, account, order } = await buy();
    const first = (await getDesired(id))!;
    const config = await bootable(first);
    subscriptions.set(order.subscription, { ...order.details, status: "canceled" });
    await cloud.reconcileBilling(() => {
      throw new Error("unexpected periodic billing failure");
    });
    expect(await cloud.show(id)).toMatchObject({ status: "suspended" });
    const replacement = await buy(account);
    expect(replacement.id).toBe(id);
    const resumed = (await getDesired(id))!;
    expect(resumed).toMatchObject({
      generation: first.generation,
      providerServerId: 7,
      state: "active",
    });
    const same = CloudComputerBootResponseSchema.parse((await boot(first)).json());
    expect(same.backup).toEqual(config.backup);
  });

  it("keeps capacity while a Checkout create is in flight and reuses the original Stripe parameters", async () => {
    const account = await createAccount();
    const order = purchase(account.id);
    const entered = Promise.withResolvers<void>();
    const completeCreate = Promise.withResolvers<void>();
    checkout.mockImplementationOnce(async () => {
      entered.resolve();
      await completeCreate.promise;
      return { id: order.session.id, url: checkoutUrl };
    });
    const first = requestAs(account, "POST", accountCloudComputerCheckoutPath, {
      requestId: order.requestId,
    });
    await entered.promise;
    try {
      now = new Date(now.getTime() + 60_001);
      const competing = await requestAs(account, "POST", accountCloudComputerCheckoutPath, {
        requestId: randomUUID(),
      });
      expect(competing.json()).toMatchObject({
        error: { reason: "cloud-computer-checkout-in-progress" },
      });
      expect(checkout.mock.calls).toHaveLength(2);
      expect(checkout.mock.calls[1]).toEqual(checkout.mock.calls[0]);
      await buy();
      const buyer = await createAccount();
      const full = await requestAs(buyer, "POST", accountCloudComputerCheckoutPath, {
        requestId: randomUUID(),
      });
      expect(full.json()).toMatchObject({ error: { reason: "cloud-computer-no-capacity" } });
    } finally {
      completeCreate.resolve();
      await first;
    }
    expect((await first).statusCode).toBe(200);
  });

  it("closes a completed but unpaid Checkout only after Stripe confirms cancellation", async () => {
    const account = await createAccount();
    const initial = purchase(account.id);
    const start = (requestId: string) =>
      requestAs(account, "POST", accountCloudComputerCheckoutPath, { requestId });
    expect((await start(initial.requestId)).statusCode).toBe(200);
    const unpaid = {
      id: initial.session.id,
      status: "complete",
      url: null,
      subscription: initial.subscription,
      payment: undefined,
    } as const;
    stripe.findCheckout.mockResolvedValueOnce(unpaid).mockResolvedValueOnce(unpaid);
    const replacement = purchase(account.id);
    expect((await start(replacement.requestId)).statusCode).toBe(200);
    expect(stripe.cancel).toHaveBeenCalledWith(initial.subscription);
    expect(stripe.refundCheckout).not.toHaveBeenCalled();
  });

  it("durably defers payment during an Account deletion fence", async () => {
    const account = await createAccount();
    const order = purchase(account.id);
    expect(
      (
        await requestAs(account, "POST", accountCloudComputerCheckoutPath, {
          requestId: order.requestId,
        })
      ).statusCode,
    ).toBe(200);
    await database
      .updateTable("users")
      .where("id", "=", account.id)
      .set({ deletionFencedUntil: new Date(now.getTime() + 60_001) })
      .executeTakeFirst();
    expect(
      (await webhook("checkout.session.completed", order.session, "evt_fenced")).statusCode,
    ).toBe(200);
    expect(await cloud.listForAccount(account.id)).toEqual([]);
    expect(
      (
        await database
          .selectFrom("cloudComputerStripeEvents")
          .select("deferredCheckout")
          .where("id", "=", "evt_fenced")
          .executeTakeFirstOrThrow()
      ).deferredCheckout,
    ).toMatchObject({ id: order.session.id });
    expect(await runCloudComputerOperator(cloud, ["checkout-list"])).toMatchObject({
      paidAttempts: [
        { accountId: account.id, requestId: order.requestId, paidAt: expect.any(Date) },
      ],
      deferredEvents: [
        {
          eventId: "evt_fenced",
          stripeSessionId: order.session.id,
          stripeSubscriptionId: order.subscription,
          accountId: account.id,
          requestId: order.requestId,
        },
      ],
    });
    now = new Date(now.getTime() + 60_002);
    expect(await runCloudComputerOperator(cloud, ["billing-reconcile"])).toEqual({
      ran: true,
      errors: [],
    });
    expect(await runCloudComputerOperator(cloud, ["checkout-list"])).toEqual({
      deferredEvents: [],
      paidAttempts: [],
    });
    expect(await cloud.listForAccount(account.id)).toHaveLength(1);
    expect(
      (
        await database
          .selectFrom("cloudComputerStripeEvents")
          .select("deferredCheckout")
          .where("id", "=", "evt_fenced")
          .executeTakeFirstOrThrow()
      ).deferredCheckout,
    ).toBeNull();
  });

  it("blocks sales on an invalid Stripe offer and recovers missed completion, paused collection and payment", async () => {
    const customer = await createAccount();
    const order = purchase(customer.id);
    stripe.validateOffer.mockRejectedValueOnce(new Error("offer differs"));
    await expect(cloud.checkOffer()).rejects.toThrow("offer differs");
    await expect(cloud.checkout(customer.id, order.requestId)).rejects.toThrow(
      "not available right now",
    );
    expect(checkout).not.toHaveBeenCalled();
    await cloud.checkOffer();
    await cloud.checkout(customer.id, order.requestId);
    stripe.findCheckout.mockResolvedValueOnce({
      id: order.session.id,
      status: "complete",
      url: null,
      payment: { ...order.session, mode: "subscription", payment_status: "paid" },
    });
    const tick = () =>
      cloud.reconcileBilling(() => {
        throw new Error("unexpected periodic billing failure");
      });
    await tick();
    const [computer] = await cloud.listForAccount(customer.id);
    expect(computer?.status).toBe("preparing");
    subscriptions.set(order.subscription, {
      ...order.details,
      latest_invoice: { status: "draft", attempt_count: 0 },
    });
    expect(
      (await webhook("customer.subscription.updated", { id: order.subscription })).statusCode,
    ).toBe(200);
    expect(
      (await requestAs(customer, "GET", accountCloudComputerPath(computer!.id))).json(),
    ).toMatchObject({ status: "preparing" });
    subscriptions.set(order.subscription, {
      ...order.details,
      pause_collection: { behavior: "void" },
    });
    await tick();
    expect(await cloud.show(computer!.id)).toMatchObject({ status: "suspended" });
    subscriptions.set(order.subscription, order.details);
    await tick();
    expect(await cloud.show(computer!.id)).toMatchObject({ status: "preparing" });
  });

  it("cancels at once while a completion wins the Stripe expiry race, and refunds that payment", async () => {
    const { id, account, order } = await buy();
    subscriptions.set(order.subscription, { ...order.details, status: "canceled" });
    await cloud.reconcileBilling(() => {
      throw new Error("unexpected billing failure");
    });
    const second = purchase(account.id);
    expect(
      (
        await requestAs(account, "POST", accountCloudComputerCheckoutPath, {
          requestId: second.requestId,
        })
      ).statusCode,
    ).toBe(200);
    const payment = { ...second.session, mode: "subscription", payment_status: "paid" } as const;
    const open = {
      id: second.session.id,
      status: "open",
      url: checkoutUrl,
      payment: undefined,
    } as const;
    const complete = { id: second.session.id, status: "complete", url: null, payment } as const;
    const expiryStarted = Promise.withResolvers<void>();
    const completePayment = Promise.withResolvers<void>();
    stripe.findCheckout.mockResolvedValue(open);
    stripe.expireCheckout.mockImplementationOnce(async () => {
      expiryStarted.resolve();
      await completePayment.promise;
      stripe.findCheckout.mockResolvedValue(complete);
      return complete;
    });
    stripe.refundCheckout.mockResolvedValue(false);
    const deletion = requestAs(account, "DELETE", accountCloudComputerPath(id), {
      confirmation: cloudComputerDeleteConfirmation(id),
    });
    await expiryStarted.promise;
    const racingEvent = webhook("checkout.session.completed", payment, "evt_race_completed");
    completePayment.resolve();
    expect((await deletion).statusCode).toBe(200);
    expect((await racingEvent).statusCode).toBe(200);
    // The computer's own subscription is cancelled at once: the checkout no longer holds it.
    expect((await getDesired(id))?.state).toBe("deleted");
    // The checkout keeps its own path: expired, and the payment that won cancelled and refunded.
    expect(stripe.expireCheckout).toHaveBeenCalledWith(second.session.id);
    expect(stripe.cancel).toHaveBeenCalledWith(second.subscription);
    expect(stripe.refundCheckout).toHaveBeenCalledWith(payment);

    stripe.refundCheckout.mockResolvedValue(true);
    await cloud.reconcileBilling(() => {
      throw new Error("unexpected billing failure");
    });
    expect((await getDesired(id))?.state).toBe("deleted");
    expect((await requestAs(account, "GET", accountCloudComputerPath(id))).json()).toMatchObject({
      status: "needs_attention",
      deletion: { startedAt: expect.any(String), computerDestroyedAt: null },
    });
  });

  it("expires an open payable Checkout before allowing deletion", async () => {
    const { id, account, order } = await buy();
    subscriptions.set(order.subscription, { ...order.details, status: "canceled" });
    await cloud.reconcileBilling(() => {
      throw new Error("unexpected billing failure");
    });
    const next = purchase(account.id);
    expect(
      (
        await requestAs(account, "POST", accountCloudComputerCheckoutPath, {
          requestId: next.requestId,
        })
      ).statusCode,
    ).toBe(200);
    stripe.findCheckout.mockResolvedValueOnce({
      id: next.session.id,
      status: "open",
      url: checkoutUrl,
      payment: undefined,
    });
    const deleted = await requestAs(account, "DELETE", accountCloudComputerPath(id), {
      confirmation: cloudComputerDeleteConfirmation(id),
    });
    expect(stripe.expireCheckout).toHaveBeenCalledWith(next.session.id);
    expect(stripe.refundCheckout).not.toHaveBeenCalled();
    expect(deleted.json()).toMatchObject({
      status: "needs_attention",
      deletion: { startedAt: expect.any(String), computerDestroyedAt: null },
    });
  });

  it("refunds a paid attempt after its fulfillment bound and logs the reason", async () => {
    const account = await createAccount();
    const order = purchase(account.id);
    expect(
      (
        await requestAs(account, "POST", accountCloudComputerCheckoutPath, {
          requestId: order.requestId,
        })
      ).statusCode,
    ).toBe(200);
    await database
      .updateTable("cloudComputerBackupTargets")
      .set({ needsRotation: true, checkoutKey: null })
      .execute();
    const paid = { ...order.session, mode: "subscription", payment_status: "paid" } as const;
    expect((await webhook("checkout.session.completed", paid, "evt_unfulfilled")).statusCode).toBe(
      200,
    );
    expect(stripe.refundCheckout).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 15 * 60_000 + 1);
    await cloud.reconcileBilling(() => {
      throw new Error("unexpected billing failure");
    });
    expect(stripe.cancel).toHaveBeenCalledWith(order.subscription);
    expect(stripe.refundCheckout).toHaveBeenCalledWith(paid);
    expect(billingAttention).toHaveBeenCalledWith(
      expect.stringContaining("Cancelling and refunding"),
    );
    expect((await requestAs(account, "GET", accountCloudComputersPath)).json().computers).toEqual(
      [],
    );
  });

  it("continues to find and cancel a pending Checkout after Account deletion", async () => {
    const owner = await createAccount();
    const order = purchase(owner.id);
    await cloud.checkout(owner.id, order.requestId);
    await database.deleteFrom("users").where("id", "=", owner.id).executeTakeFirst();
    expect(
      await database
        .selectFrom("cloudComputerCheckouts")
        .select("requestId")
        .where("accountId", "=", owner.id)
        .execute(),
    ).toEqual([{ requestId: order.requestId }]);
    stripe.findCheckout.mockResolvedValueOnce({
      id: order.session.id,
      status: "complete",
      url: null,
      payment: { ...order.session, mode: "subscription", payment_status: "paid" },
    });
    await cloud.reconcileBilling(() => {
      throw new Error("unexpected periodic billing failure");
    });
    expect(stripe.cancel).toHaveBeenCalledWith(order.subscription);
    expect(stripe.refundCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ id: order.session.id }),
    );
    expect(
      await database
        .selectFrom("cloudComputerBackupTargets")
        .select("checkoutKey")
        .where("checkoutKey", "is not", null)
        .execute(),
    ).toEqual([]);
  });

  async function liveReconciler(input: {
    id: CloudComputerDesired["id"];
    holder?: string;
    server?: FakeVm;
    invalidDiscovery?: boolean;
    unreachableDiscovery?: boolean;
    interceptCheck?: (check: CloudComputerCheck, reply: Promise<boolean>) => Promise<boolean>;
  }) {
    const { accountClient } = await vi.importActual<{
      accountClient(
        origin: URL,
        token: () => Promise<string>,
        http: { timeoutMs: number },
        holder: string,
      ): { check(id: string, check: CloudComputerCheck, signal: AbortSignal): Promise<boolean> };
    }>("../../../home-provisioner/src/account.js");
    const { discoverHome } = await vi.importActual<{
      discoverHome(http: { timeoutMs: number; fetch: typeof fetch }): () => Promise<unknown>;
    }>("../../../home-provisioner/src/discovery.js");
    const machine = { server: input.server, previous: undefined as FakeVm | undefined };
    const provider = {
      ensureFirewall: async () => 1,
      ensureFirewallAttached: async () => true,
      listManaged: async () => [],
      find: async (id: string) =>
        id === input.id ? [machine.server, machine.previous].filter(Boolean) : [],
      create: vi.fn(
        async (
          { generation }: { generation: number },
          _signal: AbortSignal,
          check?: () => Promise<void>,
        ) => {
          await check?.();
          return (machine.server = vm(generation, "off"));
        },
      ),
      describe: async (id: number) =>
        [machine.server, machine.previous].find((server) => server?.id === id),
      powerOn: vi.fn(async (_id: number, _signal: AbortSignal, check?: () => Promise<void>) => {
        await check?.();
        machine.server = { ...machine.server!, status: "running" };
      }),
      powerOff: vi.fn(async (id: number) => {
        if (machine.server && machine.server.id === id)
          machine.server = { ...machine.server, status: "off" };
        if (machine.previous && machine.previous.id === id)
          machine.previous = { ...machine.previous, status: "off" };
      }),
      delete: vi.fn(async (id: number) => {
        if (machine.server?.id === id) machine.server = undefined;
        if (machine.previous?.id === id) machine.previous = undefined;
      }),
    };
    const dnsState = { token: undefined as string | undefined, published: false };
    const dns = {
      listManaged: async () => [],
      observeWrites: async () => (dnsState.token ? [dnsState.token] : []),
      ensureRecords: vi.fn(
        async (
          _host: string,
          _addresses: object,
          _signal: AbortSignal,
          _check?: () => Promise<void>,
          publish?: (type: "A", send: (token: string) => Promise<void>) => Promise<void>,
        ) => {
          await publish?.("A", async (token) => {
            dnsState.token = token;
            dnsState.published = true;
          });
        },
      ),
      removeRecords: vi.fn(
        async (
          _host: string,
          _signal: AbortSignal,
          _check?: () => Promise<void>,
          observed?: (token: string) => Promise<void>,
        ) => {
          if (dnsState.token) await observed?.(dnsState.token);
          dnsState.token = undefined;
          dnsState.published = false;
        },
      ),
    };
    const options = {
      account: accountClient(
        listener,
        async () => provisionerToken,
        { timeoutMs: 5000 },
        input.holder ?? lease,
      ),
      provider,
      dns,
      discover:
        input.invalidDiscovery || input.unreachableDiscovery
          ? discoverHome({
              timeoutMs: 5000,
              fetch: async () =>
                input.unreachableDiscovery
                  ? new Response(null, { status: 503 })
                  : Response.json({ kind: "personal", authority: {} }),
            })
          : async () => identity,
      accountOrigin: publicOrigin,
      image: "image",
      defaultRegion: "us-central1-a",
      defaultServerType: "e2-standard-4",
      concurrency: 1,
      readinessTimeoutMs: 20 * 60_000,
      now: () => now.getTime(),
    };
    const { Reconciler } = await vi.importActual<{
      Reconciler: new (input: typeof options) => { pass(signal: AbortSignal): Promise<void> };
    }>("../../../home-provisioner/src/reconcile.js");
    function pass(holder = input.holder ?? lease) {
      const client = accountClient(
        listener,
        async () => provisionerToken,
        { timeoutMs: 5000 },
        holder,
      );
      const account = input.interceptCheck
        ? {
            ...client,
            check: (id: string, check: CloudComputerCheck, signal: AbortSignal) =>
              input.interceptCheck!(check, client.check(id, check, signal)),
          }
        : client;
      return new Reconciler({ ...options, account }).pass(AbortSignal.timeout(8000));
    }
    return { pass, machine, provider, dns, dnsState };
  }

  type FakeVm = ReturnType<typeof vm>;
  function vm(generation: number, status: "off" | "running") {
    return { id: 6 + generation, generation, status, ipv4: "192.0.2.7", ipv6: null, firewalls: [] };
  }

  it.each(["create", "dns-a"] as const)(
    "keeps pools reserved when a journaled %s lands after the lease changes",
    async (kind) => {
      const { id, account } = await buy();
      const harness = await liveReconciler({
        id,
        ...(kind === "dns-a" ? { server: vm(1, "running") } : {}),
      });
      const dispatched = Promise.withResolvers<void>();
      const deliver = Promise.withResolvers<void>();
      if (kind === "create") {
        harness.provider.create.mockImplementationOnce(async ({ generation }, _signal, check) => {
          await check?.();
          dispatched.resolve();
          await deliver.promise;
          return (harness.machine.server = vm(generation, "off"));
        });
      } else {
        harness.dns.ensureRecords.mockImplementationOnce(
          async (_host, _addresses, _signal, check, publish) => {
            await check?.();
            await publish?.("A", async (token) => {
              dispatched.resolve();
              await deliver.promise;
              harness.dnsState.token = token;
              harness.dnsState.published = true;
            });
          },
        );
      }
      const old = harness.pass().catch((error: unknown) => error);
      await dispatched.promise;
      const holder = randomUUID();
      try {
        const journaled = await getDesired(id);
        expect(journaled?.pendingProviderWrites).toMatchObject([{ kind, generation: 1 }]);
        expect(
          (
            await requestAs(account, "DELETE", accountCloudComputerPath(id), {
              confirmation: cloudComputerDeleteConfirmation(id),
            })
          ).statusCode,
        ).toBe(200);
        now = new Date(now.getTime() + 11 * 60_000);
        await harness.pass(holder);
        const premature = await database
          .selectFrom("cloudComputers")
          .select(["phase", "tombstonedAt"])
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        expect(premature).toEqual({ phase: "deleting", tombstonedAt: null });
        expect((await cloud.listBackupTargets()).some((entry) => entry.computerId === id)).toBe(
          true,
        );
      } finally {
        deliver.resolve();
        await old;
      }
      await harness.pass(holder);
      expect(harness.machine.server).toBeUndefined();
      expect(harness.dnsState.published).toBe(false);
      expect((await cloud.listBackupTargets()).some((entry) => entry.needsRotation)).toBe(true);
    },
  );

  it("powers off a suspended Home even when withdrawing DNS fails", async () => {
    const { id, account } = await buy();
    const harness = await liveReconciler({ id, server: vm(1, "running") });
    harness.dnsState.published = true;
    harness.dns.removeRecords.mockRejectedValueOnce(new Error("Cloudflare unavailable"));
    expect(
      (await requestAs(account, "POST", `${accountCloudComputerPath(id)}/suspend`)).statusCode,
    ).toBe(200);
    await harness.pass();
    expect(harness.machine.server?.status).toBe("off");
    expect(harness.dnsState.published).toBe(true);
    await harness.pass();
    expect(harness.dnsState.published).toBe(false);
  });

  it("withdraws DNS for an invalid discovery response at the pinned address", async () => {
    const { id, account } = await buy();
    const computer = (await getDesired(id))!;
    await bootable(computer);
    expect((await complete(computer)).statusCode).toBe(200);
    const harness = await liveReconciler({ id, server: vm(1, "running"), invalidDiscovery: true });
    harness.dnsState.published = true;
    await harness.pass();
    expect(harness.dnsState.published).toBe(false);
    expect(harness.dns.ensureRecords).not.toHaveBeenCalled();
    expect((await requestAs(account, "GET", accountCloudComputerPath(id))).json()).toMatchObject({
      status: "needs_attention",
    });
    const unreachable = await liveReconciler({
      id,
      server: vm(1, "running"),
      unreachableDiscovery: true,
    });
    await unreachable.pass();
    expect(unreachable.dns.ensureRecords).not.toHaveBeenCalled();
    expect((await getDesired(id))?.dnsQuarantined).toBe(true);
  });

  it("returns all desired rows through the listener's cursor pages", async () => {
    const first = await buy();
    const second = await buy();
    const page = async (cursor?: string) => {
      const response = await http({
        method: "GET",
        url: `${cloudComputersDesiredPath}?limit=1${cursor ? "&after=" + cursor : ""}`,
        headers: leaseHeaders(),
      });
      expect(response.statusCode).toBe(200);
      return CloudComputerDesiredResponseSchema.parse(response.json());
    };
    const one = await page();
    expect(one.computers).toHaveLength(1);
    expect(one.next).toBe(one.computers[0]?.id);
    const two = await page(one.next);
    expect(two.computers).toHaveLength(1);
    expect(two.next).toBeUndefined();
    expect([one.computers[0]?.id, two.computers[0]?.id]).toEqual([first.id, second.id].sort());
  });

  it("round-trips a Google instance ID and keeps the original desired wire readable", async () => {
    const { id } = await buy();
    const computer = (await getDesired(id, "google"))!;
    expect(computer.bootstrapReceiptRecorded).toBe(false);
    const ref = GoogleComputeServerRefSchema.parse(
      `os-${id.replace("_", "-")}-${computer.generation}/18446744073709551615`,
    );
    expect(
      (
        await report(computer, {
          phase: "provisioning",
          providerServerId: null,
          providerServerRef: ref,
          observedIdentity: null,
        })
      ).json(),
    ).toEqual({ recorded: true });
    expect(await getDesired(id, "google")).toMatchObject({ providerServerRef: ref });
    expect(await getDesired(id)).not.toHaveProperty("providerServerRef");
    const token = randomUUID();
    const check = (payload: CloudComputerCheck) =>
      http({
        method: "POST",
        url: cloudComputerCheckPath(id),
        headers: leaseHeaders(),
        payload,
      });
    expect(
      (
        await check({
          operation: "begin-provider-write",
          revision: computer.revision,
          write: { kind: "power-on", token, generation: computer.generation, serverRef: ref },
        })
      ).json(),
    ).toEqual({ allowed: true });
    expect((await getDesired(id, "google"))?.pendingProviderWrites?.[0]?.serverRef).toBe(ref);
    expect((await getDesired(id))?.pendingProviderWrites?.[0]).not.toHaveProperty("serverRef");
    expect((await check({ operation: "finish-provider-write", token })).json()).toEqual({
      allowed: true,
    });
    const booted = CloudComputerBootResponseSchema.parse((await boot(computer)).json());
    expect((await complete(computer)).statusCode).toBe(200);
    expect((await boot(computer)).statusCode).toBe(401);
    expect((await complete(computer)).statusCode).toBe(200);
    expect(
      (
        await report((await getDesired(id, "google"))!, {
          providerServerId: null,
          providerServerRef: ref,
        })
      ).json(),
    ).toEqual({ recorded: true });
    expect((await getDesired(id, "google"))?.bootstrapReceiptRecorded).toBe(false);
    const home = fakeHome({ hostname: computer.hostname, boot: booted });
    expect(await claimer(home.fetch).runOnce()).toBe(1);
    expect((await getDesired(id, "google"))?.bootstrapReceiptRecorded).toBe(true);
  });

  async function bootReplacement(id: CloudComputerDesired["id"], first: CloudComputerDesired) {
    const restored = (await getDesired(id))!;
    const current = vm(restored.generation, "running");
    expect(
      (
        await report(restored, {
          phase: "provisioning",
          providerServerId: current.id,
          observedIdentity: null,
        })
      ).json(),
    ).toEqual({ recorded: true });
    const response = await boot(restored);
    expect(response.statusCode, response.body).toBe(200);
    const install = CloudComputerBootResponseSchema.parse(response.json());
    expect(install.restoreSnapshot).toBe("aabbccdd");
    expect((await complete(restored)).statusCode).toBe(200);
    const harness = await liveReconciler({ id, server: current });
    harness.machine.previous = vm(first.generation, "running");
    await harness.pass();
    expect(harness.machine.previous?.status).toBe("off");
    expect(harness.provider.delete).not.toHaveBeenCalled();

    const home = fakeHome({ hostname: restored.hostname, boot: install });
    expect(await claimer(home.fetch).runOnce()).toBe(1);
    await harness.pass();
    expect(harness.provider.delete).not.toHaveBeenCalled();

    return { restored, install, harness };
  }

  async function claimedReplacement() {
    const { id, account } = await buy();
    const first = (await getDesired(id))!;
    await bootable(first);
    expect((await complete(first)).statusCode).toBe(200);
    expect((await report((await getDesired(id))!)).json()).toEqual({ recorded: true });
    await cloud.mutate(id, "replace", undefined, "aabbccdd");
    return { id, account, first, ...(await bootReplacement(id, first)) };
  }

  async function ownerExchange({
    account,
    restored,
    install,
  }: Awaited<ReturnType<typeof claimedReplacement>>) {
    const oidc = install.managedHome!.oidc;
    const redirect = `https://${restored.hostname}/v1/auth/oidc/callback`;
    const verifier = "x".repeat(43);
    const query = new URLSearchParams({
      client_id: oidc.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid profile email",
      state: randomUUID(),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authorized = await requestAs(account, "GET", `/api/auth/oauth2/authorize?${query}`);
    expect(authorized.statusCode).toBe(200);
    const code = new URL(authorized.json().url).searchParams.get("code");
    expect(code).toBeTruthy();
    return () =>
      http({
        method: "POST",
        url: "/api/auth/oauth2/token",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: publicOrigin.host,
          authorization:
            "Basic " + Buffer.from(`${oidc.clientId}:${oidc.clientSecret}`).toString("base64"),
        },
        payload: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          code_verifier: verifier,
          redirect_uri: redirect,
        }).toString(),
      });
  }

  function accessMarker(id: CloudComputerDesired["id"]) {
    return database
      .selectFrom("cloudComputers")
      .select(["generation", "ownerAccessAt"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  it("resets signing keys left by a fixture that used another Account secret", async () => {
    const other = createControlPlaneAuth(database, {
      publicOrigin,
      authSecret: "different-fixture-secret-with-at-least-32-bytes",
    });
    await other.api.signJWT({ body: { payload: { sub: "other-fixture" } } });
    await resetManagedCloudTables(database);
    const { token } = await auth.api.signJWT({ body: { payload: { sub: "current-fixture" } } });
    const jwks = createLocalJWKSet((await http({ method: "GET", url: "/api/auth/jwks" })).json());
    await expect(jwtVerify(token, jwks, { issuer: publicOrigin.origin })).resolves.toMatchObject({
      payload: { sub: "current-fixture" },
    });
  });

  async function reissueFromStagedSnapshot(id: CloudComputerDesired["id"]) {
    const targetId = await cloud.addBackupTarget({
      endpoint: "https://s3.example.test",
      bucket: "test-backups",
      prefix: "owner-sign-in-restore",
      accessKeyId: "access-owner-sign-in",
      secretAccessKey: "secret-owner-sign-in",
    });
    await cloud.mutate(
      id,
      "reissue",
      undefined,
      JSON.stringify({ targetId, password: "owner-sign-in-restore-password" }),
    );
  }

  it("keeps the predecessor off until Account issues the owner a sign-in to the claimed replacement", async () => {
    const replacement = await claimedReplacement();
    const { id, first, restored, harness } = replacement;
    const redeem = await ownerExchange(replacement);
    const token = await redeem();
    expect(token.statusCode).toBe(200);
    const jwks = createLocalJWKSet((await http({ method: "GET", url: "/api/auth/jwks" })).json());
    await expect(
      jwtVerify(token.json().id_token, jwks, {
        issuer: publicOrigin.origin,
        audience: replacement.install.managedHome!.oidc.clientId,
        algorithms: ["EdDSA"],
      }),
    ).resolves.toMatchObject({ payload: { sub: replacement.account.id } });
    const marked = await accessMarker(id);
    expect(marked).toEqual({ generation: restored.generation, ownerAccessAt: expect.any(Date) });
    now = new Date(now.getTime() + 1_000);
    const next = await ownerExchange(replacement);
    expect((await next()).statusCode).toBe(200);
    expect(await accessMarker(id)).toEqual(marked);
    expect((await getDesired(id))?.replacementVerified).toBe(true);
    await expect(cloud.mutate(id, "reissue")).rejects.toThrow("working Home");
    await harness.pass();
    expect(harness.provider.delete).toHaveBeenCalledWith(
      vm(first.generation, "off").id,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(harness.machine.previous).toBeUndefined();
  });

  it("keeps the predecessor and permits staged reissue when ID token signing fails", async () => {
    const replacement = await claimedReplacement();
    const { id, restored, harness } = replacement;
    const redeem = await ownerExchange(replacement);
    const poisoned = await database
      .updateTable("authJwks")
      .set({ privateKey: JSON.stringify("an-invalid-test-encrypted-key") })
      .executeTakeFirst();
    expect(poisoned.numUpdatedRows).toBeGreaterThan(0n);
    const response = await redeem();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("id_token");
    expect(await accessMarker(id)).toEqual({
      generation: restored.generation,
      ownerAccessAt: null,
    });
    expect((await getDesired(id))?.replacementVerified).toBe(false);
    await harness.pass();
    expect(harness.provider.delete).not.toHaveBeenCalled();
    expect(harness.machine.previous?.status).toBe("off");
    await reissueFromStagedSnapshot(id);
    expect((await getDesired(id))?.generation).toBe(restored.generation + 1);
  });

  it("does not credit a signed response for a superseded replacement generation", async () => {
    const replacement = await claimedReplacement();
    const { id, restored, account } = replacement;
    const redeem = await ownerExchange(replacement);
    const prepared = Promise.withResolvers<Response>();
    const release = Promise.withResolvers<void>();
    const handler = auth.handler.bind(auth);
    const spy = vi.spyOn(auth, "handler").mockImplementation(async (request) => {
      try {
        const response = await handler(request);
        if (new URL(request.url).pathname === "/api/auth/oauth2/token") {
          prepared.resolve(response);
          await release.promise;
        }
        return response;
      } catch (error) {
        prepared.reject(error);
        throw error;
      }
    });
    const pending = redeem();
    let current: Awaited<ReturnType<typeof claimedReplacement>>;
    try {
      const response = await Promise.race([
        prepared.promise,
        pending.then(({ statusCode }) => {
          throw new Error(`Token endpoint returned HTTP ${statusCode} before preparing a response`);
        }),
      ]);
      expect(response.status).toBe(200);
      expect(await response.clone().json()).toMatchObject({ id_token: expect.any(String) });
      expect(await accessMarker(id)).toEqual({
        generation: restored.generation,
        ownerAccessAt: null,
      });
      await reissueFromStagedSnapshot(id);
      current = { id, account, first: restored, ...(await bootReplacement(id, restored)) };
      expect(current.restored.generation).toBe(restored.generation + 1);
      expect(current.install.managedHome!.oidc.clientId).toBe(
        replacement.install.managedHome!.oidc.clientId,
      );
    } finally {
      release.resolve();
      await pending.finally(() => spy.mockRestore());
    }
    expect((await pending).statusCode).toBe(200);
    expect(await accessMarker(id)).toEqual({
      generation: current.restored.generation,
      ownerAccessAt: null,
    });
    expect((await getDesired(id))?.replacementVerified).toBe(false);
    await current.harness.pass();
    expect(current.harness.provider.delete).not.toHaveBeenCalled();
    const currentRedeem = await ownerExchange(current);
    expect((await currentRedeem()).statusCode).toBe(200);
    expect(await accessMarker(id)).toEqual({
      generation: current.restored.generation,
      ownerAccessAt: expect.any(Date),
    });
  });

  it("renews an unused token in place when only the create fence was checked", async () => {
    const { id } = await buy();
    const current = (await getDesired(id))!;
    const check = await http({
      method: "POST",
      url: `/v1/cloud-computers/${id}/check`,
      headers: leaseHeaders(),
      payload: { operation: "create", revision: current.revision },
    });
    expect(check.json()).toEqual({ allowed: true });
    await cloud.mutate(id, "reissue");
    const updated = (await getDesired(id))!;
    expect(updated.generation).toBe(current.generation);
    expect(updated.bootstrapToken).not.toBe(current.bootstrapToken);
  });

  it("requires the dedicated Stripe portal configuration at the account-facing endpoint", async () => {
    const { account } = await buy();
    stripe.validatePortal.mockRejectedValueOnce(
      new ControlPlaneError("unavailable", "Unsupported portal configuration", {
        reason: "cloud-computer-billing-problem",
      }),
    );
    const blocked = await requestAs(account, "POST", accountCloudComputerBillingPortalPath);
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ error: { reason: "cloud-computer-billing-problem" } });
    expect(stripe.portal).not.toHaveBeenCalled();

    const opened = await requestAs(account, "POST", accountCloudComputerBillingPortalPath);
    expect(opened.json()).toEqual({ url: portalUrl });
    expect(stripe.portal.mock.calls[0]?.[2]).toBe("bpc_cloud");
  });

  it("reissues a never-ready boot-completed Home with a clean pin and fresh credentials", async () => {
    const { id } = await buy();
    const oldEndpoint = await cloud.addEgressEndpoint({
      url: "https://old.example.test:8443",
      username: "first-user",
      password: "first-secret",
    });
    const original = (await getDesired(id))!;
    const first = await bootable(original);
    expect((await complete(original)).statusCode).toBe(200);
    expect(await cloud.assignEgress(id)).toMatchObject({ endpointId: oldEndpoint });
    await cloud.addEgressEndpoint({
      url: "https://new.example.test:8443",
      username: "next-user",
      password: "next-secret",
    });
    await cloud.mutate(id, "reissue");
    const next = (await getDesired(id))!;
    expect(next.generation).toBe(original.generation + 1);
    expect(next.observedIdentity).toBeUndefined();
    expect(next.bootCompleted).toBe(false);
    expect((await complete(original)).statusCode).toBe(401);
    const replacement = await bootable(next);
    expect(replacement.setupCodeDigest).not.toBe(first.setupCodeDigest);
    expect(replacement.managedHome?.oidc.clientSecret).not.toBe(
      first.managedHome?.oidc.clientSecret,
    );
    expect(replacement.backup.prefix).not.toBe(first.backup.prefix);
    expect(replacement.backup.password).not.toBe(first.backup.password);
    expect(replacement).not.toHaveProperty("egress");
    expect((await cloud.listEgressEndpoints()).filter((entry) => entry.needsRotation)).toHaveLength(
      1,
    );
  });

  it("reissues a ready replacement from a newly staged repository before Account issues owner access", async () => {
    const { id } = await buy();
    const first = (await getDesired(id))!;
    await bootable(first);
    expect((await complete(first)).statusCode).toBe(200);
    expect((await report((await getDesired(id))!)).json()).toEqual({ recorded: true });
    await cloud.mutate(id, "replace", undefined, "aabbccdd");
    const previous = (await getDesired(id))!;
    await bootable(previous);
    expect((await complete(previous)).statusCode).toBe(200);
    expect((await report((await getDesired(id))!)).json()).toEqual({ recorded: true });
    expect((await getDesired(id))?.replacementVerified).toBe(false);
    await expect(cloud.mutate(id, "replace", undefined, "aabbccdd")).rejects.toThrow(
      "Use bootstrap reissue",
    );
    await expect(cloud.mutate(id, "reissue")).rejects.toThrow(
      "fresh backup target containing the named snapshot",
    );

    const targetId = await cloud.addBackupTarget({
      endpoint: "https://s3.example.test",
      bucket: "test-backups",
      prefix: "prepared-restore",
      accessKeyId: "access-prepared",
      secretAccessKey: "secret-prepared",
    });
    await cloud.mutate(
      id,
      "reissue",
      undefined,
      JSON.stringify({ targetId, password: "new-restore-password" }),
    );
    const desired = (await getDesired(id))!;
    expect(desired).toMatchObject({
      generation: previous.generation + 1,
      restoreSnapshot: "aabbccdd",
    });
    expect(desired.observedIdentity).toBeUndefined();
    const boot = await bootable(desired);
    expect(boot).toMatchObject({
      restoreSnapshot: "aabbccdd",
      backup: { prefix: "prepared-restore", password: "new-restore-password" },
    });
  });

  it("returns a retryable failure and logs a malformed paid subscription Checkout", async () => {
    const paid = await webhook("checkout.session.completed", {
      id: "cs_malformed",
      mode: "subscription",
      payment_status: "paid",
      stray: "private-input",
    });
    expect(paid.statusCode).toBe(503);
    expect(paid.json()).toMatchObject({
      error: { message: "Could not interpret a paid Stripe Checkout Session" },
    });
    expect(logs.join("")).toContain("Could not interpret a paid Stripe Checkout Session");
    expect(logs.join("")).not.toContain("private-input");
  });

  describe("deleting a Cloud Computer, alone or with its Account", () => {
    const deleteAccount = (account: Awaited<ReturnType<typeof createAccount>>) =>
      requestAs(account, "DELETE", "/v1/account");
    const exists = async (id: ControlPlaneAccountId) =>
      Boolean(
        await database.selectFrom("users").select("id").where("id", "=", id).executeTakeFirst(),
      );
    const computer = (id: CloudComputerDesired["id"]) =>
      database
        .selectFrom("cloudComputers")
        .select(["accountId", "state", "deletionRequestedAt", "billingSettledAt", "cancelFailedAt"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    // The billing pass the account service runs every minute.
    const billingPass = async () => {
      const errors: unknown[] = [];
      const ran = await cloud.reconcileBilling((error) => errors.push(error));
      return { ran, errors };
    };
    const settled = async (id: CloudComputerDesired["id"]) =>
      (await computer(id)).billingSettledAt !== null;
    // Open, for this computer, and unresolved at Stripe: the lookup finds no session.
    const openCheckout = (accountId: ControlPlaneAccountId, target: CloudComputerDesired["id"]) =>
      database
        .insertInto("cloudComputerCheckouts")
        .values({
          accountId,
          requestId: randomUUID(),
          expiresAt: new Date(now.getTime() + 3_600_000),
          createdAt: now,
          lastStripeAttemptAt: now,
          targetComputerId: target,
          stripeSessionId: null,
          url: null,
          stripePriceId: "price_1",
          currency: "usd",
          status: "open",
        })
        .execute();

    it("deletes the Account at once, then cancels once, deletes the customer and settles", async () => {
      const { id, account, order } = await buy();
      await bootable((await getDesired(id))!);
      stripe.cancel.mockClear();
      const deleted = await deleteAccount(account);
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(deleted.json()).toEqual({ deleted: true });
      expect(await exists(account.id)).toBe(false);
      // Nothing touched the computer before the Account's own transaction: the database
      // recorded its deletion request as the Account's row went, and the pass is asked now.
      expect(stripe.cancel).not.toHaveBeenCalled();
      expect(kickBilling).toHaveBeenCalledOnce();
      const row = await computer(id);
      expect(row).toMatchObject({ accountId: null, billingSettledAt: null });
      expect(row.state).not.toBe("deleted");
      expect(row.deletionRequestedAt).toBeInstanceOf(Date);
      // Two passes at once: the pass's own lock lets one run.
      const passes = await Promise.all([billingPass(), billingPass()]);
      expect(passes.map(({ ran }) => ran).sort()).toEqual([false, true]);
      expect(passes.flatMap(({ errors }) => errors)).toEqual([]);
      expect(stripe.cancel).toHaveBeenCalledExactlyOnceWith(order.subscription);
      expect(stripe.deleteIdleCustomer).toHaveBeenCalledExactlyOnceWith(order.customer);
      expect(await computer(id)).toMatchObject({ state: "deleted", cancelFailedAt: null });
      expect(await settled(id)).toBe(true);
      // Settled once: later passes leave it alone, and the machine still goes as before.
      await billingPass();
      expect(stripe.deleteIdleCustomer).toHaveBeenCalledTimes(1);
      expect(stripe.cancel).toHaveBeenCalledTimes(1);
      const deleting = (await getDesired(id))!;
      expect(deleting.state).toBe("deleted");
      expect(
        (
          await report(deleting, {
            phase: "deleted",
            providerServerId: null,
            ipv4: null,
            observedIdentity: null,
          })
        ).json(),
      ).toEqual({ recorded: true });
    });

    it("keeps cancelling while Stripe fails, then reports how long it took and refunds nothing", async () => {
      const { id, account, order } = await buy();
      await bootable((await getDesired(id))!);
      stripe.cancel.mockClear();
      stripe.cancel.mockRejectedValueOnce(new Error("Stripe unavailable"));
      // The Cloud Computer's own Delete: the first attempt fails.
      const deleted = await requestAs(account, "DELETE", accountCloudComputerPath(id), {
        confirmation: `DELETE:${id}`,
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect((await computer(id)).cancelFailedAt).toBeInstanceOf(Date);
      stripe.cancel.mockRejectedValueOnce(new Error("Stripe unavailable"));
      // Retried by the pass, which reports Stripe's failure as any billing failure.
      expect((await billingPass()).errors).toHaveLength(1);
      expect((await computer(id)).state).not.toBe("deleted");
      expect(stripe.deleteIdleCustomer).not.toHaveBeenCalled();
      // Ten minutes on, Stripe answers.
      now = new Date(now.getTime() + 10 * 60_000);
      const { errors } = await billingPass();
      expect(stripe.cancel).toHaveBeenCalledTimes(3);
      expect(stripe.cancel).toHaveBeenLastCalledWith(order.subscription);
      expect(errors).toEqual([
        expect.objectContaining({ name: "CloudComputerCancelledLate", computerId: id }),
      ]);
      const details = billingErrorDetails(errors[0]);
      expect(details).toMatchObject({ computerId: id });
      expect(details["waitedMs"]).toBeGreaterThanOrEqual(10 * 60_000);
      // Nothing is refunded on its own: a person looks for a renewal in that time.
      expect(stripe.refundCheckout).not.toHaveBeenCalled();
      expect(await settled(id)).toBe(true);
      expect(stripe.deleteIdleCustomer).toHaveBeenCalledExactlyOnceWith(order.customer);
    });

    it("cancels at once although a checkout for the same computer is open and unresolved", async () => {
      const { id, account, order } = await buy();
      await bootable((await getDesired(id))!);
      await openCheckout(account.id, id);
      stripe.cancel.mockClear();
      const deleted = await requestAs(account, "DELETE", accountCloudComputerPath(id), {
        confirmation: `DELETE:${id}`,
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(stripe.cancel).toHaveBeenCalledExactlyOnceWith(order.subscription);
      expect((await computer(id)).state).toBe("deleted");
      // The checkout keeps its own path (here Stripe has no session for it, so it stays open);
      // the computer's billing settles meanwhile.
      const { errors } = await billingPass();
      expect(errors).not.toContainEqual(
        expect.objectContaining({ name: "CloudComputerDeletionUnsettled" }),
      );
      expect(await settled(id)).toBe(true);
    });

    it("cancels a deleted Account's computer on the pass although its checkout is unresolved", async () => {
      const { id, account, order } = await buy();
      await bootable((await getDesired(id))!);
      await openCheckout(account.id, id);
      stripe.cancel.mockClear();
      expect((await deleteAccount(account)).statusCode).toBe(200);
      await billingPass();
      expect(stripe.cancel).toHaveBeenCalledExactlyOnceWith(order.subscription);
      expect((await computer(id)).state).toBe("deleted");
    });

    it("compensates a checkout paid after the Account went, as before, and never fulfils it", async () => {
      const account = await createAccount();
      const order = purchase(account.id);
      const started = await requestAs(account, "POST", accountCloudComputerCheckoutPath, {
        requestId: order.requestId,
      });
      expect(started.statusCode, started.body).toBe(200);
      expect((await deleteAccount(account)).statusCode).toBe(200);
      // The pass closes a gone Account's open checkout.
      stripe.findCheckout.mockResolvedValue({
        id: order.session.id,
        status: "open",
        url: checkoutUrl,
        payment: undefined,
      });
      stripe.expireCheckout.mockClear();
      await billingPass();
      expect(stripe.expireCheckout).toHaveBeenCalledWith(order.session.id);
      stripe.findCheckout.mockResolvedValue(undefined);
      // A payment that still lands is cancelled and refunded, and makes no computer.
      expect((await webhook("checkout.session.completed", order.session)).statusCode).toBe(200);
      expect(stripe.refundCheckout).toHaveBeenCalledWith(order.session);
      expect(
        await database
          .selectFrom("cloudComputers")
          .select("id")
          .where("stripeSubscriptionId", "=", order.subscription)
          .execute(),
      ).toEqual([]);
    });

    it("cancels once when Stripe cancelled but the reply was lost, and says so", async () => {
      const { id, account } = await buy();
      await bootable((await getDesired(id))!);
      stripe.cancel.mockClear();
      // Stripe cancels, then the answer never arrives: the row can't say so yet.
      stripe.cancel.mockImplementationOnce(async (subscription) => {
        subscriptions.set(subscription, {
          ...subscriptions.get(subscription)!,
          status: "canceled",
        });
        throw new Error("reply lost");
      });
      const deleted = await requestAs(account, "DELETE", accountCloudComputerPath(id), {
        confirmation: `DELETE:${id}`,
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect((await computer(id)).state).not.toBe("deleted");
      const { errors } = await billingPass();
      // Stripe already says cancelled: the pass marks the row and never cancels again.
      expect(stripe.cancel).toHaveBeenCalledTimes(1);
      expect((await computer(id)).state).toBe("deleted");
      expect(errors).toEqual([expect.objectContaining({ name: "CloudComputerCancelledLate" })]);
      expect(await settled(id)).toBe(true);
    });

    it("reports a row unsettled an hour after its request, naming the step that blocks", async () => {
      const { id, account } = await buy();
      await bootable((await getDesired(id))!);
      expect((await deleteAccount(account)).statusCode).toBe(200);
      stripe.cancel.mockRejectedValue(new Error("Stripe unavailable"));
      try {
        expect((await billingPass()).errors).toHaveLength(1);
        now = new Date(now.getTime() + 61 * 60_000);
        const { errors } = await billingPass();
        expect(errors).toEqual([
          expect.objectContaining({
            name: "CloudComputerDeletionUnsettled",
            computerId: id,
            step: "cancel",
          }),
        ]);
        expect(billingErrorDetails(errors[0])).toMatchObject({ computerId: id, step: "cancel" });
      } finally {
        stripe.cancel.mockReset().mockImplementation(async (subscription) => {
          subscriptions.set(subscription, {
            ...subscriptions.get(subscription)!,
            status: "canceled",
          });
        });
      }
      // Cancelled at last; then the customer step blocks.
      stripe.deleteIdleCustomer.mockRejectedValueOnce(new Error("Stripe unavailable"));
      const later = await billingPass();
      expect(later.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "CloudComputerDeletionUnsettled", step: "customer" }),
        ]),
      );
      expect(await settled(id)).toBe(false);
    });

    it("never touches a computer deleted before this release", async () => {
      const { id, account } = await buy();
      await bootable((await getDesired(id))!);
      expect(
        (
          await requestAs(account, "DELETE", accountCloudComputerPath(id), {
            confirmation: `DELETE:${id}`,
          })
        ).statusCode,
      ).toBe(200);
      const live = await buy();
      // As the previous release left them: no settlement columns yet.
      await sql`alter table public.cloud_computers drop column billing_settled_at, drop column cancel_failed_at`.execute(
        database,
      );
      await cloudComputerBillingSettledMigration.up(database);
      expect(await settled(id)).toBe(true);
      expect(await settled(live.id)).toBe(false);
      stripe.deleteIdleCustomer.mockClear();
      stripe.subscription.mockClear();
      await billingPass();
      expect(stripe.deleteIdleCustomer).not.toHaveBeenCalled();
      expect(stripe.subscription).not.toHaveBeenCalledWith(
        (
          await database
            .selectFrom("cloudComputers")
            .select("stripeSubscriptionId")
            .where("id", "=", id)
            .executeTakeFirstOrThrow()
        ).stripeSubscriptionId,
      );
    });

    it("deletes an Account with no Cloud Computer at once, as before", async () => {
      const account = await createAccount();
      stripe.cancel.mockClear();
      const deleted = await deleteAccount(account);
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(deleted.json()).toEqual({ deleted: true });
      expect(await exists(account.id)).toBe(false);
      expect(stripe.cancel).not.toHaveBeenCalled();
    });
  });

  it("rate limits boot attempts and admits only signed Stripe webhooks", async () => {
    const id = CloudComputerIdSchema.parse(`cc_${randomUUID()}`);
    const path = cloudComputerBootPath(id);
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await http({
        method: "POST",
        url: path,
        payload: { hostname: "unknown.example.test", bootstrapToken: "guessed" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("guessed");
    }
    const limited = await http({
      method: "POST",
      url: path,
      payload: { hostname: "unknown.example.test", bootstrapToken: "guessed" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(logs.join("")).not.toContain("guessed");
    const forged = await http({
      method: "POST",
      url: cloudComputerStripeWebhookPath,
      payload: { id: "evt_forged", type: "invoice.paid", data: { object: {} } },
    });
    expect(forged.statusCode).toBe(401);
    expect(await database.selectFrom("cloudComputerStripeEvents").select("id").execute()).toEqual(
      [],
    );
  });
});
