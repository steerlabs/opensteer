import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
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
  cloudComputerDeleteConfirmation,
  cloudComputerStatusPath,
  cloudComputerStripeWebhookPath,
  cloudComputersDesiredPath,
  ControlPlaneAccountIdSchema,
  type CloudComputerDesired,
  type CloudComputerReport,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { digestSecret } from "@opensteer/shared/secretDigest";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";
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
  OPENSTEER_CLOUD_COMPUTER_BACKUP_ENDPOINT: "https://s3.example.test",
  OPENSTEER_CLOUD_COMPUTER_BACKUP_BUCKET: "test-backups",
  OPENSTEER_CLOUD_COMPUTER_BACKUP_ACCESS_KEY_ID: "test-access-key",
  OPENSTEER_CLOUD_COMPUTER_BACKUP_SECRET_ACCESS_KEY: "test-secret-access-key",
})!;
const identity = CloudComputerIdentitySchema.parse({
  deploymentId: "dep_00000000-0000-4000-8000-000000000010",
  hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
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
  const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let provisionerToken: string;

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
  });

  beforeEach(async () => {
    await sql`truncate table cloud_computer_egress_endpoints, cloud_computers, cloud_computer_stripe_events, cloud_computer_checkouts`.execute(
      database,
    );
    checkout.mockClear();
    stripe.subscription.mockClear();
    stripe.portal.mockClear();
    kickBootstrap.mockClear();
    logs.length = 0;
    now = new Date();
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
    return app.inject({
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
    const response = await app.inject({
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
    const response = await app.inject({
      method: "GET",
      url: cloudComputersDesiredPath,
      headers: { authorization: `Bearer ${provisionerToken}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    return CloudComputerDesiredResponseSchema.parse(response.json()).computers.find(
      (computer) => computer.id === id,
    );
  }

  function report(computer: CloudComputerDesired, patch: Partial<CloudComputerReport> = {}) {
    return app.inject({
      method: "POST",
      url: cloudComputerStatusPath(computer.id),
      headers: { authorization: `Bearer ${provisionerToken}` },
      payload: {
        id: computer.id,
        generation: computer.generation,
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
    return app.inject({
      method: "POST",
      url: cloudComputerBootPath(id),
      payload: { hostname: computer.hostname, bootstrapToken: token },
    });
  }

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
    const provider = {
      ensureFirewall: async () => 1,
      ensureFirewallAttached: async () => true,
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
          expect(CloudComputerBootResponseSchema.parse(response.json())).toMatchObject({
            hostname: first!.hostname,
            accountOrigin: publicOrigin.origin,
            release: { version: "1.2.3" },
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
        http: { timeoutMs: number; fetch: typeof fetch },
      ) => {
        desired: (signal: AbortSignal) => Promise<readonly CloudComputerDesired[]>;
        report: (report: CloudComputerReport, signal: AbortSignal) => Promise<void>;
      };
    }>("../../../home-provisioner/src/account.js");
    const options = {
      account: accountClient(publicOrigin, async () => provisionerToken, {
        timeoutMs: 5000,
        fetch: async (input, options) => {
          const response = await app.inject({
            method: options?.method === "POST" ? "POST" : "GET",
            url: new URL(String(input)).pathname,
            headers: Object.fromEntries(new Headers(options?.headers)),
            ...(typeof options?.body === "string" ? { payload: options.body } : {}),
          });
          return new Response(response.body, { status: response.statusCode });
        },
      }),
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
    const read = () => app.inject({ method: "GET", url: path, headers: account.headers });
    const mutation = (action: string) =>
      app.inject({ method: "POST", url: `${path}/${action}`, headers: account.headers });
    expect((await read()).json()).toMatchObject({ status: "preparing" });
    await pass();
    expect((await read()).json()).toMatchObject({
      status: "ready",
      address: `https://${first!.hostname}`,
      egress: "unavailable",
    });
    expect(kickBootstrap).toHaveBeenCalledOnce();
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
    expect(records).toBe(true);
    expect((await read()).json()).toMatchObject({
      status: "suspended",
      reason: "You paused this Cloud Computer.",
    });
    expect((await mutation("resume")).statusCode).toBe(200);
    await pass();
    expect((await read()).json()).toMatchObject({ status: "ready" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: accountCloudComputerBillingPortalPath,
          headers: account.headers,
        })
      ).json(),
    ).toEqual({ url: portalUrl });
    expect(stripe.portal).toHaveBeenCalledWith(order.customer);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: path,
          headers: account.headers,
          payload: { confirmation: id },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
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
      app.inject({
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
    const list = await app.inject({
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

  it("gates the provisioner, fences generations, pins identity, and revokes boot credentials at ready or expiry", async () => {
    const { id } = await buy();
    expect((await app.inject({ method: "GET", url: cloudComputersDesiredPath })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: cloudComputersDesiredPath,
          headers: {
            authorization: `Bearer ${await workloadToken("team@example.iam.gserviceaccount.com")}`,
          },
        })
      ).statusCode,
    ).toBe(403);
    const first = (await getDesired(id))!;
    expect(first.bootstrapToken).toBeTruthy();
    expect((await getDesired(id))?.bootstrapToken).toBe(first.bootstrapToken);
    expect(
      (await report(first, { id: CloudComputerIdSchema.parse(`cc_${randomUUID()}`) })).statusCode,
    ).toBe(400);
    const denied = await boot(
      first,
      first.bootstrapToken,
      CloudComputerIdSchema.parse(`cc_${randomUUID()}`),
    );
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain(first.bootstrapToken!);
    const booted = await boot(first);
    expect(booted.statusCode).toBe(200);
    expect((await boot(first)).json()).toEqual(booted.json());
    expect((await report(first, { phase: "booting", observedIdentity: null })).statusCode).toBe(
      200,
    );
    expect((await getDesired(id))?.bootstrapToken).toBeUndefined();
    expect((await boot(first)).statusCode).toBe(200);

    await cloud.mutate(id, "reissue");
    const second = (await getDesired(id))!;
    expect(second.generation).toBe(first.generation + 1);
    expect(second.bootstrapToken).not.toBe(first.bootstrapToken);
    expect((await boot(second, first.bootstrapToken)).statusCode).toBe(401);
    expect((await report(first)).statusCode).toBe(200);
    expect((await getDesired(id))?.observedIdentity).toBeUndefined();
    now = new Date(now.getTime() + 21 * 60_000);
    expect((await boot(second)).statusCode).toBe(401);
    expect((await getDesired(id))?.bootstrapToken).toBeUndefined();
    await cloud.mutate(id, "reissue");
    const third = (await getDesired(id))!;
    const install = CloudComputerBootResponseSchema.parse((await boot(third)).json());
    expect((await report(third)).statusCode).toBe(200);
    expect(
      (
        await report(third, {
          observedIdentity: { ...identity, hostKeyFingerprint: `sha256:${"b".repeat(43)}` },
        })
      ).statusCode,
    ).toBe(409);
    expect((await getDesired(id))?.observedIdentity).toEqual(identity);
    expect((await getDesired(id))?.bootstrapToken).toBeUndefined();
    expect((await boot(third)).statusCode).toBe(401);
    const setup = await cloud.setupCodeForReadyHome(id, third.generation);
    expect(setup).toBeTruthy();
    expect(digestSecret(setup!)).toBe(install.setupCodeDigest);
    expect(JSON.stringify(install)).not.toContain(setup!);
    expect(logs.join("")).not.toContain(first.bootstrapToken!);
    expect(logs.join("")).not.toContain(third.bootstrapToken!);
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
    const firstBoot = CloudComputerBootResponseSchema.parse((await boot(first)).json());
    const secondBoot = CloudComputerBootResponseSchema.parse((await boot(second)).json());
    expect(firstBoot.egress).toEqual(endpoint);
    expect(secondBoot.egress).toBeUndefined();
    expect(secondBoot.backup.password).not.toBe(firstBoot.backup.password);
    await expect(cloud.removeEgressEndpoint(endpointId)).rejects.toThrow("assigned");
    await cloud.mutate(first.id, "delete");
    expect((await cloud.listEgressEndpoints())[0]?.computerId).toBe(first.id);
    expect(
      (
        await report(first, {
          phase: "deleted",
          providerServerId: null,
          ipv4: null,
          observedIdentity: null,
        })
      ).statusCode,
    ).toBe(200);
    expect((await cloud.listEgressEndpoints())[0]?.computerId).toBeNull();
    expect(CloudComputerBootResponseSchema.parse((await boot(second)).json()).egress).toEqual(
      endpoint,
    );
  });

  it("rate limits boot attempts and admits only signed Stripe webhooks", async () => {
    const id = CloudComputerIdSchema.parse(`cc_${randomUUID()}`);
    const path = cloudComputerBootPath(id);
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await app.inject({
        method: "POST",
        url: path,
        payload: { hostname: "unknown.example.test", bootstrapToken: "guessed" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("guessed");
    }
    const limited = await app.inject({
      method: "POST",
      url: path,
      payload: { hostname: "unknown.example.test", bootstrapToken: "guessed" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(logs.join("")).not.toContain("guessed");
    const forged = await app.inject({
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
