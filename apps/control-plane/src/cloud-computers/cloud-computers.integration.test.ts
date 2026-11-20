import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  accountCloudComputerBillingPortalPath,
  accountCloudComputerCheckoutPath,
  accountCloudComputerPath,
  accountCloudComputersPath,
  accountOrganizationsPath,
  canonicalWorkAuditRecord,
  defaultWorkPolicy,
  MyOrganizationsResponseSchema,
  OrganizationAdminResponseSchema,
  organizationWorkPath,
  WorkAssignmentViewSchema,
  WorkAuditPushSchema,
  WorkHomeResponseSchema,
  WorkPolicyClaimsSchema,
  WorkPolicyResponseSchema,
  workAuditFlushPath,
  WorkAuditFlushClaimsSchema,
  workAuditGenesisHash,
  workAuditSigningBytes,
  type WorkAuditRecord,
  type WorkPolicy,
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
import type { CloudComputerStripe, StripeBilling, StripeSubscription } from "./stripe.js";
import { OrganizationStore } from "../organizations/store.js";

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
    portal: vi.fn<StripeBilling["portal"]>(async () => ({ url: portalUrl })),
    subscription: vi.fn(async (id: string) => subscriptions.get(id)!),
    validateOffer: vi.fn<StripeBilling["validateOffer"]>(async () => {}),
    findCheckout: vi.fn<StripeBilling["findCheckout"]>(async () => undefined),
    cancel: vi.fn<StripeBilling["cancel"]>(async (id) => {
      subscriptions.set(id, { ...subscriptions.get(id)!, status: "canceled" });
    }),
    updateSeatQuantity: vi.fn<CloudComputerStripe["updateSeatQuantity"]>(async () => {}),
  } satisfies StripeBilling & Pick<CloudComputerStripe, "updateSeatQuantity">;
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
  const organizations = new OrganizationStore(database, {
    stripe,
    now: () => now,
    offer: {
      priceId: "price_seat",
      name: "Work seat",
      currency: "usd",
      amountMinor: 4900,
      interval: "month",
    },
  });
  const cloud = new CloudComputerStore(database, {
    organizations,
    config,
    accountOrigin: publicOrigin,
    cipher,
    stripe,
    now: () => now,
  });
  const kickBootstrap = vi.fn();
  const claimErrors: unknown[] = [];
  const workHomeFetch = vi.fn<typeof globalThis.fetch>();
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
        ...(claims.work ? { work: claims.work } : {}),
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
        organizations,
        workHomeFetch,
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
    await sql`truncate table work_audit_batches, work_audit_records, work_assignments, organization_invitations, organization_members, organization_checkouts, organizations, cloud_computer_egress_endpoints, cloud_computer_backup_targets, cloud_computer_provisioner_lease, cloud_computers, cloud_computer_stripe_events, cloud_computer_checkouts`.execute(
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
    stripe.updateSeatQuantity.mockReset().mockResolvedValue(undefined);
    workHomeFetch.mockReset();
    await cloud.checkOffer();
    await organizations.checkOffer();
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
        .where("workAssignmentId", "is", null)
        .where("tombstonedAt", "is", null)
        .executeTakeFirstOrThrow()
    ).id;
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

  async function buyOrganization(admin: Awaited<ReturnType<typeof createAccount>>, seats: number) {
    const order = purchase(admin.id);
    const input = { requestId: order.requestId, name: "Workspace", seats };
    const started = await requestAs(admin, "POST", `${accountOrganizationsPath}/checkout`, input);
    expect(started.statusCode, started.body).toBe(200);
    const submitted = checkout.mock.calls.at(-1)?.[0];
    expect(submitted?.organization).toMatchObject({ quantity: seats });
    expect(submitted?.priceId).toBe("price_seat");
    const id = submitted!.organization!.id;
    const metadata = { ...order.session.metadata, organization_id: id };
    const subscription = {
      ...order.details,
      metadata,
      items: {
        has_more: false,
        data: [{ id: "si_seat", quantity: seats, price: { id: "price_seat", currency: "usd" } }],
      },
    } satisfies StripeSubscription;
    subscriptions.set(order.subscription, subscription);
    const completed = { ...order.session, metadata };
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    expect((await webhook("checkout.session.completed", completed, eventId)).statusCode).toBe(200);
    expect((await webhook("checkout.session.completed", completed, eventId)).statusCode).toBe(200);
    expect((await webhook("checkout.session.completed", completed)).statusCode).toBe(200);
    const index = MyOrganizationsResponseSchema.parse(
      (await requestAs(admin, "GET", accountOrganizationsPath)).json(),
    );
    expect(index.organizations).toEqual([{ id, name: "Workspace", role: "admin" }]);
    const path = `${accountOrganizationsPath}/${id}`;
    const read = async () => {
      const response = await requestAs(admin, "GET", `${path}/admin`);
      expect(response.statusCode, response.body).toBe(200);
      return OrganizationAdminResponseSchema.parse(response.json());
    };
    expect((await read()).seats).toEqual({ paid: seats, assigned: 0, free: seats, pending: null });
    return { id, path, read, subscription };
  }

  async function invite(
    orgPath: string,
    admin: Awaited<ReturnType<typeof createAccount>>,
    account: Awaited<ReturnType<typeof createAccount>>,
    wrong?: Awaited<ReturnType<typeof createAccount>>,
  ) {
    const email = `${account.id}@example.test`;
    const invited = await requestAs(admin, "POST", `${orgPath}/invitations`, {
      email,
      role: "member",
    });
    expect(invited.statusCode, invited.body).toBe(200);
    const info = invited.json();
    const acceptPath = `${accountOrganizationsPath}/invitations/${info.id}/accept`;
    if (wrong) expect((await requestAs(wrong, "POST", acceptPath)).statusCode).toBe(403);
    const inbox = MyOrganizationsResponseSchema.parse(
      (await requestAs(account, "GET", accountOrganizationsPath)).json(),
    );
    expect(inbox.invitations).toHaveLength(1);
    expect(inbox.invitations[0]).toMatchObject({ id: info.id, email });
    expect((await requestAs(account, "POST", acceptPath)).statusCode).toBe(200);
    expect((await requestAs(account, "POST", acceptPath)).statusCode).toBe(409);
  }

  it("provisions work through the real listener, fences policy, audit and offboarding by assignment", async () => {
    const admin = await createAccount();
    const first = await createAccount();
    const second = await createAccount();
    const outsider = await createAccount();
    const org = await buyOrganization(admin, 1);
    await invite(org.path, admin, first, outsider);
    await invite(org.path, admin, second);
    const candidates = [first, second].map((account) => ({
      account,
      payload: { requestId: randomUUID(), accountId: account.id },
    }));
    const assign = (payload: (typeof candidates)[number]["payload"]) =>
      requestAs(admin, "POST", `${org.path}/assignments`, payload);
    const competing = await Promise.all(candidates.map(({ payload }) => assign(payload)));
    expect(competing.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const winner = competing.findIndex((result) => result.statusCode === 200);
    const { account: assignee, payload } = candidates[winner]!;
    const { account: other } = candidates[1 - winner]!;
    const assignment = WorkAssignmentViewSchema.parse(competing[winner]!.json());
    const marker = {
      organizationId: org.id,
      organizationName: "Workspace",
      assignmentId: assignment.assignmentId,
    };
    expect(assignment).toMatchObject(marker);
    expect((await assign(payload)).json()).toMatchObject({
      assignmentId: assignment.assignmentId,
      computerId: assignment.computerId,
    });
    expect((await org.read()).seats).toMatchObject({ paid: 1, assigned: 1, free: 0 });
    const assignmentPath = `${org.path}/assignments/${assignment.assignmentId}`;
    const hostPath = `${organizationWorkPath}/${assignment.assignmentId}`;
    const homePath = `${org.path}/work-home`;
    const ownerPath = accountCloudComputerPath(CloudComputerIdSchema.parse(assignment.computerId));
    const paths = [
      ["GET", `${org.path}/admin`, undefined],
      ["POST", `${org.path}/seats`, { requestId: randomUUID(), seats: 2 }],
      ["POST", `${org.path}/invitations`, { email: "another@example.test", role: "member" }],
      ["PUT", `${org.path}/members/${admin.id}`, { role: "member" }],
      ["DELETE", `${org.path}/members/${admin.id}`, undefined],
      ["POST", `${org.path}/assignments`, payload],
      ["POST", `${assignmentPath}/offboard`, { retentionSeconds: 0 }],
      ["PUT", `${org.path}/policy`, { expectedRevision: 1, policy: defaultWorkPolicy }],
      ["GET", `${assignmentPath}/audit`, undefined],
    ] as const;
    for (const account of [assignee, outsider]) {
      for (const [method, url, body] of paths)
        expect((await requestAs(account, method, url, body)).statusCode, `${method} ${url}`).toBe(
          403,
        );
    }
    expect(
      (await requestAs(admin, "PUT", `${org.path}/members/${admin.id}`, { role: "member" }))
        .statusCode,
    ).toBe(409);
    expect((await requestAs(admin, "DELETE", `${org.path}/members/${admin.id}`)).statusCode).toBe(
      409,
    );
    expect(
      (await requestAs(admin, "DELETE", `${org.path}/members/${assignee.id}`)).statusCode,
    ).toBe(409);
    await expect(directory.beginAccountDeletion(admin.id)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(directory.beginAccountDeletion(assignee.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await requestAs(outsider, "GET", homePath)).statusCode).toBe(403);
    expect((await requestAs(other, "GET", homePath)).json()).toBeNull();
    expect((await requestAs(assignee, "GET", ownerPath)).statusCode).toBe(200);
    expect((await requestAs(admin, "GET", ownerPath)).statusCode).toBe(404);
    const forbiddenSuspend = await requestAs(assignee, "POST", `${ownerPath}/suspend`);
    expect(forbiddenSuspend.statusCode).toBe(403);
    expect(forbiddenSuspend.json()).toMatchObject({
      error: {
        reason: "cloud-computer-work-managed",
        message: "This Cloud Computer is managed by its organization",
      },
    });
    expect((await requestAs(assignee, "POST", `${ownerPath}/resume`)).statusCode).toBe(403);
    expect(
      (await requestAs(assignee, "POST", accountCloudComputerBillingPortalPath)).statusCode,
    ).toBe(404);
    expect(
      (
        await requestAs(assignee, "DELETE", ownerPath, {
          confirmation: cloudComputerDeleteConfirmation(
            CloudComputerIdSchema.parse(assignment.computerId),
          ),
        })
      ).statusCode,
    ).toBe(403);
    await expect(
      cloud.mutate(CloudComputerIdSchema.parse(assignment.computerId), "replace"),
    ).rejects.toMatchObject({ code: "forbidden" });

    const desired = (await getDesired(CloudComputerIdSchema.parse(assignment.computerId)))!;
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
    let booted: CloudComputerBootResponse | undefined;
    let dns = false;
    const { accountClient } = await vi.importActual<{
      accountClient: (
        origin: URL,
        token: () => Promise<string>,
        http: { timeoutMs: number },
        holder: string,
      ) => object;
    }>("../../../home-provisioner/src/account.js");
    const options = {
      account: accountClient(listener, async () => provisionerToken, { timeoutMs: 5000 }, lease),
      provider: {
        ensureFirewall: async () => 1,
        ensureFirewallAttached: async () => true,
        listManaged: async () => [],
        find: async () => (server ? [server] : []),
        create: async ({ generation, userData }: { generation: number; userData: string }) => {
          expect(userData).toContain(desired.bootstrapToken);
          server = {
            id: 7,
            generation,
            status: "off",
            ipv4: "192.0.2.7",
            ipv6: null,
            firewalls: [],
          };
          return server;
        },
        describe: async () => server,
        powerOn: async () => {
          if (!booted) {
            const response = await boot(desired);
            expect(response.statusCode, response.body).toBe(200);
            booted = CloudComputerBootResponseSchema.parse(response.json());
          }
          server = { ...server!, status: "running" };
        },
        powerOff: async () => {
          server = { ...server!, status: "off" };
        },
        delete: async () => {
          server = undefined;
        },
      },
      dns: {
        listManaged: async () => [],
        ensureRecords: async () => {
          dns = true;
        },
        removeRecords: async () => {
          dns = false;
        },
      },
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
    await pass();
    expect(booted?.work).toEqual(marker);
    expect((await complete(desired)).json()).toEqual({ completed: true });
    await pass();
    const home = fakeHome({ hostname: desired.hostname, boot: booted! });
    expect(await claimer(home.fetch).runOnce()).toBe(1);
    expect(claimErrors).toEqual([]);
    expect(home.state.owner).toBe(assignee.id);
    expect(home.state.receipt?.document.work).toEqual(marker);
    expect(dns).toBe(true);
    const address = `https://${desired.hostname}`;
    expect(
      WorkHomeResponseSchema.parse((await requestAs(assignee, "GET", homePath)).json()),
    ).toMatchObject({
      assignment: { ...marker, homeStatus: "ready", address },
      policy: defaultWorkPolicy,
    });
    expect((await requestAs(other, "GET", homePath)).json()).toBeNull();
    expect((await directory.listDeployments(admin.id)).length).toBe(0);

    const authorize = new URL("/api/auth/oauth2/authorize", publicOrigin);
    const verifier = "a".repeat(43);
    authorize.search = new URLSearchParams({
      client_id: booted!.managedHome!.oidc.clientId,
      redirect_uri: `${address}/v1/auth/oidc/callback`,
      response_type: "code",
      scope: "openid profile email",
      state: randomUUID(),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    expect((await requestAs(admin, "GET", authorize.pathname + authorize.search)).statusCode).toBe(
      403,
    );
    async function issueCode() {
      const signedIn = await http({
        method: "GET",
        url: authorize.pathname + authorize.search,
        headers: { ...assignee.headers, accept: "text/html" },
        redirect: "manual",
      });
      expect(signedIn.statusCode).toBe(200);
      const authorized = signedIn.json();
      expect(authorized.redirect).toBe(true);
      const callback = new URL(authorized.url);
      expect(callback.origin).toBe(address);
      expect(callback.pathname).toBe("/v1/auth/oidc/callback");
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();
      return code!;
    }
    function redeemCode(code: string) {
      const oauth = booted!.managedHome!.oidc;
      return http({
        method: "POST",
        url: "/api/auth/oauth2/token",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization:
            "Basic " + Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString("base64"),
          host: publicOrigin.host,
        },
        payload: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: `${address}/v1/auth/oidc/callback`,
        }).toString(),
      });
    }

    const jwks = createLocalJWKSet((await http({ method: "GET", url: "/api/auth/jwks" })).json());
    const signedIn = await redeemCode(await issueCode());
    expect(signedIn.statusCode).toBe(200);
    const ownerToken = await jwtVerify(signedIn.json().id_token, jwks, {
      issuer: publicOrigin.origin,
      audience: booted!.managedHome!.oidc.clientId,
      algorithms: ["EdDSA"],
    });
    expect(ownerToken.payload.sub).toBe(assignee.id);
    const unusedCode = await issueCode();
    const headers = { authorization: `Bearer ${home.state.hostCredential}` };
    const hostCall = (method: string, action: string, payload?: unknown) =>
      http({
        method,
        url: `${hostPath}/${action}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
    const policy: WorkPolicy = {
      ...defaultWorkPolicy,
      externalMaxMode: "full-access",
      allowTasks: true,
    };
    expect(
      await requestAs(admin, "PUT", `${org.path}/policy`, { expectedRevision: 1, policy }),
    ).toMatchObject({ statusCode: 200 });
    expect((await org.read()).assignments[0]?.policyStatus).toBe("Pending on Home");
    const response = await hostCall("GET", "policy");
    expect(response.statusCode, response.body).toBe(200);
    const { assertion } = WorkPolicyResponseSchema.parse(response.json());
    const { payload: claims } = await jwtVerify(assertion, jwks, {
      issuer: publicOrigin.origin,
      audience: identity.deploymentId,
      algorithms: ["EdDSA"],
    });
    expect(WorkPolicyClaimsSchema.parse(claims)).toMatchObject({
      assignmentId: assignment.assignmentId,
      deploymentId: identity.deploymentId,
      policy,
      revision: 2,
      state: "active",
    });
    expect(claims.exp).toBeUndefined();
    expect((await hostCall("POST", "applied", { revision: 3 })).statusCode).toBe(400);
    expect((await hostCall("POST", "applied", { revision: 2 })).json()).toEqual({
      appliedRevision: 2,
    });
    expect((await hostCall("POST", "applied", { revision: 1 })).json()).toEqual({
      appliedRevision: 2,
    });
    expect((await org.read()).assignments[0]?.policyStatus).toBe("Applied");

    const buildAudit = (from: number, previous: string) => {
      const record: WorkAuditRecord = {
        kind: "policy.applied",
        revision: 2,
        sequence: from,
        at: now.toISOString(),
      };
      const headHash = createHash("sha256")
        .update(Buffer.from(previous, "hex"))
        .update(canonicalWorkAuditRecord(record))
        .digest("hex");
      const body = {
        assignmentId: assignment.assignmentId,
        fromSequence: from,
        records: [record],
        headHash,
      };
      return WorkAuditPushSchema.parse({
        ...body,
        signature: sign(null, workAuditSigningBytes(body), homeKeys.privateKey).toString(
          "base64url",
        ),
      });
    };
    const batch = buildAudit(1, workAuditGenesisHash);
    expect(
      (await hostCall("POST", "audit", { ...batch, signature: "x".repeat(86) })).statusCode,
    ).toBe(403);
    expect(
      (
        await hostCall("POST", "audit", {
          ...batch,
          records: [{ ...batch.records[0], url: "https://secret.example" }],
        })
      ).statusCode,
    ).toBe(400);
    expect((await hostCall("POST", "audit", batch)).json()).toEqual({ lastSequence: 1 });
    expect((await hostCall("POST", "audit", batch)).json()).toEqual({ lastSequence: 1 });
    const next = buildAudit(2, batch.headHash);
    const third = buildAudit(3, next.headHash);
    const fourth = buildAudit(4, third.headHash);
    const gap = {
      ...third,
      records: [...third.records, ...fourth.records],
      headHash: fourth.headHash,
    };
    const signedGap = {
      ...gap,
      signature: sign(null, workAuditSigningBytes(gap), homeKeys.privateKey).toString("base64url"),
    };
    expect((await hostCall("POST", "audit", signedGap)).statusCode).toBe(409);
    const exportAudit = () => requestAs(admin, "GET", `${assignmentPath}/audit?after=0`);
    const exported = await exportAudit();
    expect(exported.headers).toMatchObject({
      "x-opensteer-audit-last-sequence": "1",
      "x-opensteer-audit-gap-expected": "2",
      "x-opensteer-audit-gap-received": "4",
    });
    expect(exported.headers["x-opensteer-audit-last-received-at"]).toBe(now.toISOString());
    expect(exported.body).toBe(canonicalWorkAuditRecord(batch.records[0]!) + "\n");
    expect((await hostCall("POST", "audit", next)).statusCode).toBe(200);
    expect((await hostCall("POST", "audit", third)).json()).toEqual({ lastSequence: 3 });
    expect((await exportAudit()).headers["x-opensteer-audit-gap-expected"]).toBe("4");
    expect((await hostCall("POST", "audit", fourth)).json()).toEqual({ lastSequence: 4 });
    expect((await exportAudit()).headers["x-opensteer-audit-gap-expected"]).toBeUndefined();
    expect((await requestAs(admin, "GET", `${assignmentPath}/audit?after=2`)).body).toBe(
      [third, fourth].map((batch) => canonicalWorkAuditRecord(batch.records[0]!) + "\n").join(""),
    );

    let flushVerified = false;
    workHomeFetch.mockImplementation(async (target, init) => {
      const url = new URL(String(target));
      expect(url.origin).toBe(address);
      expect(url.pathname).toBe(workAuditFlushPath);
      const assertion = JSON.parse(String(init?.body)).assertion as string;
      const verified = await jwtVerify(assertion, jwks, {
        issuer: publicOrigin.origin,
        audience: address,
        algorithms: ["EdDSA"],
      });
      expect(WorkAuditFlushClaimsSchema.parse(verified.payload)).toMatchObject({
        assignmentId: assignment.assignmentId,
        deploymentId: identity.deploymentId,
      });
      expect(
        (await requestAs(assignee, "GET", authorize.pathname + authorize.search)).statusCode,
      ).toBe(403);
      expect(server?.status).toBe("running");
      flushVerified = true;
      return new Response(null, { status: 204 });
    });
    const offboarded = await requestAs(admin, "POST", `${assignmentPath}/offboard`, {
      retentionSeconds: 0,
    });
    expect(offboarded.statusCode, offboarded.body).toBe(200);
    expect(offboarded.json()).toMatchObject({
      state: "offboarding",
      signInCut: true,
      suspended: false,
      deleted: false,
    });
    expect(workHomeFetch).toHaveBeenCalledOnce();
    expect(flushVerified).toBe(true);
    const token = await redeemCode(unusedCode);
    expect(token.statusCode).toBe(401);
    expect(token.json()).toMatchObject({ error: "invalid_client" });
    expect((await org.read()).seats.free).toBe(0);
    await pass();
    expect(dns).toBe(false);
    expect(server?.status).toBe("off");
    const onBillingError = vi.fn();
    await cloud.reconcileBilling(onBillingError);
    expect(onBillingError).not.toHaveBeenCalled();
    const suspended = await org.read();
    expect(suspended.assignments[0]).toMatchObject({
      state: "offboarding",
      suspended: true,
      deleted: false,
    });
    expect(suspended.seats.free).toBe(0);
    await pass();
    expect(server).toBeUndefined();
    expect((await org.read()).seats.free).toBe(0);
    await cloud.reconcileBilling(onBillingError);
    expect(onBillingError).not.toHaveBeenCalled();
    const ended = await org.read();
    expect(ended.assignments[0]).toMatchObject({
      state: "ended",
      signInCut: true,
      deleted: true,
      audit: { lastSequence: 4 },
    });
    expect(ended.seats.free).toBe(1);
    const successor = await assign({ requestId: randomUUID(), accountId: other.id });
    expect(successor.statusCode, successor.body).toBe(200);
    expect(successor.json().computerId).not.toBe(assignment.computerId);
    expect(
      (await getDesired(CloudComputerIdSchema.parse(successor.json().computerId)))?.restoreSnapshot,
    ).toBeUndefined();
    expect((await cloud.listBackupTargets()).filter((target) => target.needsRotation)).toHaveLength(
      1,
    );
  });

  it("confirms changes with Stripe, refuses reductions below occupancy, and reconciles billing suspension", async () => {
    const admin = await createAccount();
    const member = await createAccount();
    const org = await buyOrganization(admin, 1);
    await invite(org.path, admin, member);
    const pending = { requestId: randomUUID(), seats: 2 };
    const assign = (accountId: ControlPlaneAccountId) =>
      requestAs(admin, "POST", `${org.path}/assignments`, { accountId, requestId: randomUUID() });
    const changed = await requestAs(admin, "POST", `${org.path}/seats`, pending);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().seats).toEqual({ paid: 1, pending: 2, assigned: 0, free: 1 });
    expect(stripe.updateSeatQuantity).toHaveBeenCalledWith({
      item: "si_seat",
      organization: org.id,
      requestId: pending.requestId,
      quantity: 2,
      increase: true,
    });
    const first = await assign(admin.id);
    expect(first.statusCode, first.body).toBe(200);
    expect((await assign(member.id)).statusCode).toBe(409);
    const sub = org.subscription;
    const id = CloudComputerIdSchema.parse(first.json().computerId);
    subscriptions.set(sub.id, {
      ...sub,
      pending_update: { expires_at: Math.floor(now.getTime() / 1000) + 300 },
      latest_invoice: { status: "open", attempt_count: 1 },
    });
    expect((await webhook("invoice.payment_failed", { subscription: sub.id })).statusCode).toBe(
      200,
    );
    expect((await getDesired(id))?.state).toBe("active");
    expect((await org.read()).seats).toMatchObject({ paid: 1, assigned: 1, free: 0, pending: 2 });
    subscriptions.set(sub.id, {
      ...sub,
      items: { has_more: false, data: [{ ...sub.items.data[0]!, quantity: 2 }] },
    });
    expect((await webhook("customer.subscription.updated", { id: sub.id })).statusCode).toBe(200);
    expect((await org.read()).seats).toEqual({ paid: 2, pending: null, assigned: 1, free: 1 });
    expect((await assign(member.id)).statusCode).toBe(200);
    expect(
      (await requestAs(admin, "POST", `${org.path}/seats`, { requestId: randomUUID(), seats: 1 }))
        .statusCode,
    ).toBe(409);
    subscriptions.set(sub.id, { ...subscriptions.get(sub.id)!, status: "past_due" });
    expect((await webhook("invoice.payment_failed", { subscription: sub.id })).statusCode).toBe(
      200,
    );
    expect((await getDesired(id))?.state).toBe("suspended");
    expect((await org.read()).seats.free).toBe(0);
    subscriptions.set(sub.id, { ...subscriptions.get(sub.id)!, status: "active" });
    const errors = vi.fn();
    await cloud.reconcileBilling(errors);
    expect(errors).not.toHaveBeenCalled();
    expect((await getDesired(id))?.state).toBe("active");
    await cloud.addBackupTarget({
      endpoint: "https://s3.example.test",
      bucket: "test-backups",
      prefix: "personal",
      accessKeyId: "access-c",
      secretAccessKey: "secret-c",
    });
    const personal = await buy(admin);
    expect(personal.id).not.toBe(id);
    expect((await cloud.list(admin.id)).map((computer) => computer.id)).toEqual([personal.id]);
    expect(
      WorkHomeResponseSchema.parse((await requestAs(admin, "GET", `${org.path}/work-home`)).json())
        ?.assignment.computerId,
    ).toBe(id);
    subscriptions.set(sub.id, { ...subscriptions.get(sub.id)!, status: "canceled" });
    expect((await webhook("customer.subscription.deleted", { id: sub.id })).statusCode).toBe(200);
    expect((await getDesired(id))?.state).toBe("suspended");
    expect((await getDesired(personal.id))?.state).toBe("active");
  });

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
      region: { id: "ash", label: "Ashburn, VA" },
      steps: steps("current", "pending", "pending"),
    });
    for (const key of ["deploymentId", "egressAddress", "renewsAt", "lastBackupAt"])
      expect(initial).not.toHaveProperty(key);

    const endpoint = await cloud.addEgressEndpoint({
      url: "https://proxy.example.test",
      username: "user",
      password: "test-password",
    });
    const preparing = (await getDesired(id))!;
    const install = await bootable(preparing);
    const booted = await read();
    expect(booted).toMatchObject({
      status: "preparing",
      egress: "assigned",
      steps: steps("done", "current", "pending"),
    });
    expect(booted).not.toHaveProperty("deploymentId");
    expect(booted).not.toHaveProperty("egressAddress");
    await expect(cloud.setEgressAddress(endpoint, "proxy.example.test")).rejects.toThrow(
      "Invalid browser egress address",
    );
    await cloud.setEgressAddress(endpoint, "203.0.113.5");
    expect((await read()).egressAddress).toBe("203.0.113.5");
    await cloud.setEgressAddress(endpoint, null);
    expect(await read()).not.toHaveProperty("egressAddress");

    expect((await complete(preparing)).statusCode).toBe(200);
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
        message: "This Account already has a Cloud Computer subscription",
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
    expect(stripe.portal).toHaveBeenCalledOnce();
    const [customer, returnUrl] = stripe.portal.mock.calls[0]!;
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
