import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  accountCloudComputerBillingPortalPath,
  accountCloudComputerCheckoutPath,
  accountCloudComputerPath,
  accountCloudComputersPath,
  CloudComputerBootResponseSchema,
  CloudComputerDesiredResponseSchema,
  CloudComputerIdSchema,
  CloudComputerIdentitySchema,
  cloudComputerBootPath,
  cloudComputerBootCompletePath,
  cloudComputerLeasePath,
  cloudComputerLeaseHeader,
  cloudComputerDeleteConfirmation,
  cloudComputerStatusPath,
  cloudComputerStripeWebhookPath,
  cloudComputersDesiredPath,
  ControlPlaneAccountIdSchema,
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
import { googleServiceAccountVerifier } from "../hosted-teams/provisioner-routes.js";
import { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { createControlPlaneServer } from "../server/server.js";
import { CloudComputerClaimer, HttpManagedHomeClient } from "./claim.js";
import { loadCloudComputerConfig } from "./config.js";
import { CloudComputerStore } from "./store.js";
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
  OPENSTEER_CLOUD_COMPUTER_REGION: "ash",
  OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE: "cpx22",
  OPENSTEER_CLOUD_COMPUTER_RELEASE_JSON: JSON.stringify({
    version: "1.2.3",
    installerUrl: "https://releases.example.test/install.sh",
    installerSha256: digest,
    images: Object.fromEntries(
      services.map((service) => [service, `example.test/${service}@sha256:${digest}`]),
    ),
  }),
  OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY: "sk_test_abcdefghijklmno",
  OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET: webhookSecret,
  OPENSTEER_CLOUD_COMPUTER_STRIPE_PRICE_ID: "price_1",
  OPENSTEER_CLOUD_COMPUTER_PLAN_NAME: "Cloud Computer",
  OPENSTEER_CLOUD_COMPUTER_CURRENCY: "usd",
  OPENSTEER_CLOUD_COMPUTER_PRICE_MINOR: "2900",
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
    portal: vi.fn(async (_customer: string) => ({ url: portalUrl })),
    subscription: vi.fn(async (id: string) => subscriptions.get(id)!),
    validateOffer: vi.fn<StripeBilling["validateOffer"]>(async () => {}),
    findCheckout: vi.fn<StripeBilling["findCheckout"]>(async () => undefined),
    cancel: vi.fn<StripeBilling["cancel"]>(async (id) => {
      subscriptions.set(id, { ...subscriptions.get(id)!, status: "canceled" });
    }),
  } satisfies StripeBilling;
  const logs: string[] = [];
  let now = new Date();
  let app: Awaited<ReturnType<typeof createControlPlaneServer>>;
  const auth = createControlPlaneAuth(database, {
    publicOrigin,
    authSecret,
    googleClientId: "test-client",
    googleClientSecret: "test-secret",
  });
  const cipher = new HostedTeamSetupTokenCipher(Buffer.alloc(32, 5).toString("base64url"));
  const cloud = new CloudComputerStore(database, {
    config,
    accountOrigin: publicOrigin,
    cipher,
    stripe,
    now: () => now,
  });
  const kickBootstrap = vi.fn();
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
  }) {
    const origin = `https://${input.hostname}`;
    const document = HostDiscoveryDocumentSchema.parse({
      canonicalOrigin: origin,
      deploymentId: input.deploymentId ?? identity.deploymentId,
      hostInstanceId: "hst_00000000-0000-4000-8000-000000000020",
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { kind: "personal" },
    });
    const authority = {
      document,
      publicKey: { algorithm: "Ed25519", spki: homeSpki },
      signature: sign(null, hostDiscoverySigningBytes(document), homeKeys.privateKey).toString(
        "base64url",
      ),
    };
    const state: { claims: number; receipt?: ManagedHomeClaimReceipt; owner?: string } = {
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
        claims.authority.hostKeyFingerprint !== hostKeyFingerprint(homeSpki) ||
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
          hostKeyFingerprint: hostKeyFingerprint(homeSpki),
        },
        claim: claims.claim,
        linkGeneration: claims.link.generation,
        claimedAt: new Date().toISOString(),
      });
      state.receipt = ManagedHomeClaimReceiptSchema.parse({
        document: receiptDocument,
        publicKey: { algorithm: "Ed25519", spki: homeSpki },
        signature: sign(
          null,
          managedHomeClaimReceiptSigningBytes(receiptDocument),
          homeKeys.privateKey,
        ).toString("base64url"),
      });
      state.owner = claims.sub;
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
  }) {
    const headers = new Headers(input.headers);
    if (input.payload !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const response = await fetch(new URL(input.url, listener), {
      method: input.method,
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
    await sql`truncate table cloud_computer_egress_endpoints, cloud_computer_backup_targets, cloud_computer_provisioner_lease, cloud_computers, cloud_computer_stripe_events, cloud_computer_checkouts`.execute(
      database,
    );
    await database.deleteFrom("deployments").where("id", "=", identity.deploymentId).execute();
    await database.deleteFrom("oauthClients").where("clientId", "like", "occ_%").execute();
    claimErrors.length = 0;
    checkout.mockClear();
    stripe.subscription.mockClear();
    stripe.portal.mockClear();
    stripe.cancel.mockClear();
    stripe.findCheckout.mockReset().mockResolvedValue(undefined);
    stripe.validateOffer.mockReset().mockResolvedValue(undefined);
    kickBootstrap.mockClear();
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
    const id = (await cloud.list(account.id))[0]!.id;
    return { account, order, id };
  }

  async function getDesired(id: CloudComputerDesired["id"]) {
    const response = await http({
      method: "GET",
      url: cloudComputersDesiredPath,
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
      defaultRegion: "ash",
      defaultServerType: "cpx22",
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
      egress: "unavailable",
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
      reason: "You paused this Cloud Computer.",
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
    expect(stripe.portal).toHaveBeenCalledWith(order.customer);
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
    const { id } = await buy();
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
    await cloud.mutate(id, "replace", undefined, "aabbccdd");
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
      reason: "Your Cloud Computer couldn’t be set up for your Account. Contact support.",
    });
    expect(await claimer(impostor.fetch).runOnce()).toBe(0);
    await expect(directory.listDeployments(account.id)).resolves.toEqual([]);
  });

  it("assigns egress exclusively and releases it only upon a confirmed tombstone", async () => {
    const endpoint = {
      url: "https://proxy.example.test",
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
    expect(firstBoot.egress).toEqual(endpoint);
    expect(secondBoot.egress).toBeUndefined();
    expect(secondBoot.backup.password).not.toBe(firstBoot.backup.password);
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
    expect(
      CloudComputerBootResponseSchema.parse((await boot(second)).json()).egress,
    ).toBeUndefined();
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
    await cloud.rotateBackupTarget(retired.id, {
      accessKeyId: "access-c",
      secretAccessKey: "secret-c",
    });
    await cloud.rotateEgressEndpoint(endpointId, {
      username: "egress-user",
      password: "rotated-password",
    });
    const third = await buy(customer);
    const config = await bootable((await getDesired(third.id))!);
    expect(config.backup.accessKeyId).toBe("access-c");
    expect(config.egress?.password).toBe("rotated-password");
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
    await cloud.reconcileBilling(() => {
      throw new Error("unexpected periodic billing failure");
    });
    expect(stripe.cancel).toHaveBeenLastCalledWith(order.subscription);
    expect((await getDesired(id))?.state).toBe("deleted");
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

  it("recovers an abandoned Checkout create and durably defers payment during an Account deletion fence", async () => {
    const account = await createAccount();
    const lost = purchase(account.id);
    checkout.mockRejectedValueOnce(new Error("Checkout create never reached Stripe"));
    await expect(cloud.checkout(account.id, lost.requestId)).rejects.toThrow(
      "never reached Stripe",
    );
    now = new Date(now.getTime() + 60_001);
    const order = purchase(account.id);
    expect(await cloud.checkout(account.id, order.requestId)).toEqual({ url: checkoutUrl });
    expect(stripe.findCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: lost.requestId, sessionId: null }),
    );
    expect(
      await database
        .selectFrom("cloudComputerCheckouts")
        .select("status")
        .where("requestId", "=", lost.requestId)
        .executeTakeFirst(),
    ).toEqual({ status: "expired" });

    await database
      .updateTable("users")
      .where("id", "=", account.id)
      .set({ deletionFencedUntil: new Date(now.getTime() + 60_001) })
      .executeTakeFirst();
    expect(
      (await webhook("checkout.session.completed", order.session, "evt_fenced")).statusCode,
    ).toBe(200);
    expect(await cloud.list(account.id)).toEqual([]);
    expect(
      (
        await database
          .selectFrom("cloudComputerStripeEvents")
          .select("deferredCheckout")
          .where("id", "=", "evt_fenced")
          .executeTakeFirstOrThrow()
      ).deferredCheckout,
    ).toMatchObject({ id: order.session.id });
    now = new Date(now.getTime() + 60_002);
    await cloud.reconcileBilling(() => {
      throw new Error("unexpected periodic billing failure");
    });
    expect(await cloud.list(account.id)).toHaveLength(1);
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
    const [computer] = await cloud.list(customer.id);
    expect(computer?.status).toBe("preparing");
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

  it("does not recreate a deleted Home when a pending resubscription pays late", async () => {
    const { id, account, order } = await buy();
    subscriptions.set(order.subscription, { ...order.details, status: "canceled" });
    await cloud.reconcileBilling(() => {
      throw new Error("unexpected periodic billing failure");
    });
    const second = purchase(account.id);
    await cloud.checkout(account.id, second.requestId);
    await cloud.mutate(id, "delete", account.id);
    const deletion = (await getDesired(id))!;
    expect(
      (
        await report(deletion, {
          phase: "deleted",
          providerServerId: null,
          ipv4: null,
          observedIdentity: null,
        })
      ).json(),
    ).toEqual({ recorded: true });
    expect((await webhook("checkout.session.completed", second.session)).statusCode).toBe(200);
    expect(stripe.cancel).toHaveBeenCalledWith(second.subscription);
    expect(await cloud.list(account.id)).toMatchObject([{ id, status: "deleted" }]);
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
    ).toEqual([]);
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
    expect(
      await database
        .selectFrom("cloudComputerBackupTargets")
        .select("checkoutKey")
        .where("checkoutKey", "is not", null)
        .execute(),
    ).toEqual([]);
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
