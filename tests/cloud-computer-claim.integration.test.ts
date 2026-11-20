import { testBackupVault } from "../apps/control-plane/src/cloud-computers/backup-erasure.test-support.js";
/**
 * A paid Cloud Computer, end to end through the real Account and a real Home:
 * the provisioner reports it, the Home boots from what `/boot` returned and
 * completes, the production claim client claims it, the buyer finds it in
 * their directory and signs in to it through the Account's own OIDC provider,
 * and another Account user is refused.
 *
 * What the test substitutes, and only this:
 * - The provider: the real provisioner API is driven as the reconciler drives it
 *   (status reports, `/boot`, `boot-complete`), with no VM behind it.
 * - Stripe: the Account integration test's fakes; Checkout completes by webhook.
 * - Names and TLS: both services keep their real public HTTPS origins. A
 *   certificate minted for them here is trusted, and TLS connections to those
 *   two names are sent to this computer's loopback ports, where each service
 *   sits behind a TLS front. Hostname, SNI and certificate checks still run.
 * - The claim client and the Home's JWKS fetch are the production public-HTTPS
 *   client, given only its injectable resolver (loopback) and trust root.
 */
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ConnectLifecycleService } from "../apps/control-plane/src/account/connect-lifecycle.js";
import { PersonalAccountLinkOperationCipher } from "../apps/control-plane/src/account/personal-account-link-operation-crypto.js";
import { PersonalRemoteAccountService } from "../apps/control-plane/src/account/personal-remote-account.js";
import {
  ControlPlaneAuthenticator,
  createControlPlaneAuth,
} from "../apps/control-plane/src/auth/auth.js";
import {
  CloudComputerClaimer,
  HttpManagedHomeClient,
} from "../apps/control-plane/src/cloud-computers/claim.js";
import { loadCloudComputerConfig } from "../apps/control-plane/src/cloud-computers/config.js";
import {
  CloudComputerClaimSupersededError,
  CloudComputerStore,
} from "../apps/control-plane/src/cloud-computers/store.js";
import type {
  CloudComputerStripe,
  StripeBilling,
  StripeSubscription,
} from "../apps/control-plane/src/cloud-computers/stripe.js";
import { createControlPlaneDatabase } from "../apps/control-plane/src/database/database.js";
import { migrateControlPlaneToLatest } from "../apps/control-plane/src/database/migrations.js";
import { ControlPlaneStore } from "../apps/control-plane/src/database/store.js";
import { googleServiceAccountVerifier } from "../apps/control-plane/src/hosted-teams/provisioner-routes.js";
import { HostedTeamSetupTokenCipher } from "../apps/control-plane/src/hosted-teams/setup-token-cipher.js";
import { OrganizationStore } from "../apps/control-plane/src/organizations/store.js";
import { createControlPlaneServer } from "../apps/control-plane/src/server/server.js";
import { createHostRuntime, type PersonalHostRuntime } from "../apps/host/src/runtime/runtime.js";
import { createPublicHttpsFetch } from "../packages/access/src/host.js";
import { parseHostConfig } from "../packages/config/src/index.js";
import {
  CloudComputerBootResponseSchema,
  CloudComputerDesiredResponseSchema,
  ControlPlaneAccountIdSchema,
  ManagedHomeClaimReceiptSchema,
  ListAccountDeploymentsResponseSchema,
  MyOrganizationsResponseSchema,
  WorkAssignmentViewSchema,
  accountCloudComputerCheckoutPath,
  accountOrganizationsPath,
  cloudComputerBootCompletePath,
  cloudComputerBootPath,
  cloudComputerLeaseHeader,
  cloudComputerLeasePath,
  cloudComputerStatusPath,
  cloudComputerStripeWebhookPath,
  cloudComputersDesiredPath,
  officialOpensteerAccountProviderId,
  type CloudComputerDesired,
  type ControlPlaneAccountId,
} from "../packages/control-plane-protocol/src/index.js";
import { createId } from "../packages/core/src/index.js";
import { freePort } from "../packages/shared/src/loopbackPort.test-support.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import {
  apiVersionHeaders,
  hostKeyFingerprint,
} from "../packages/deployment-authority/src/index.js";

const controlPlaneUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const hostUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const domain = "home.example.test";
const accountHostname = "account.example.test";
const authSecret = "cloud-computer-claim-test-auth-secret-32";
const provisionerEmail = "home@example.iam.gserviceaccount.com";
const webhookSecret = "whsec_cloudcomputerclaimtest";
const digest = "a".repeat(64);

// ---- Names and TLS: a minted certificate and loopback routes for two names ----

const scratch = await mkdtemp(join(tmpdir(), "opensteer-cloud-claim-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=Opensteer disposable claim test",
    "-addext",
    `subjectAltName=DNS:${accountHostname},DNS:*.${domain}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    join(scratch, "key.pem"),
    "-out",
    join(scratch, "cert.pem"),
  ],
  { stdio: "ignore" },
);
const key = await readFile(join(scratch, "key.pem"), "utf8");
const cert = await readFile(join(scratch, "cert.pem"), "utf8");
const routes = new Map<string, number>();
const route = (hostname: string) =>
  routes.get(hostname) ?? (hostname.endsWith(`.${domain}`) ? routes.get(`*.${domain}`) : undefined);
const connect = tls.connect;
(tls as { connect: typeof tls.connect }).connect = ((...input: unknown[]) => {
  const [options, ...rest] = input;
  if (typeof options === "object" && options !== null) {
    const target = options as tls.ConnectionOptions;
    const port = route(target.servername ?? target.host ?? "");
    if (port !== undefined)
      return (connect as (...args: unknown[]) => tls.TLSSocket)(
        { ...target, host: "127.0.0.1", port, ca: cert },
        ...rest,
      );
  }
  return (connect as (...args: unknown[]) => tls.TLSSocket)(...input);
}) as typeof tls.connect;

/** The production public-HTTPS client, with only its resolver and trust root replaced. */
const loopback = async () => ({ address: "127.0.0.1", family: 4 as const });
const servers: Server[] = [];

/** A TLS front for a plain-HTTP service on loopback, as Caddy or a load balancer stands. */
async function tlsFront(): Promise<{ readonly port: number; target: number }> {
  const front = { port: 0, target: 0 };
  const server = createHttpsServer({ cert, key }, (incoming, outgoing) => {
    const upstream = httpRequest(
      {
        headers: {
          ...incoming.headers,
          "x-forwarded-for": incoming.socket.remoteAddress ?? "127.0.0.1",
          "x-forwarded-proto": "https",
        },
        host: "127.0.0.1",
        method: incoming.method,
        path: incoming.url,
        port: front.target,
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  front.port = (server.address() as AddressInfo).port;
  return front;
}

// ---- A browser: an HTTP client that keeps cookies and follows redirects by hand ----

class Browser {
  readonly #cookies = new Map<string, Map<string, string>>();

  set(host: string, name: string, value: string): void {
    const jar = this.#cookies.get(host) ?? new Map<string, string>();
    jar.set(name, value);
    this.#cookies.set(host, jar);
  }

  cookie(host: string): string {
    return [...(this.#cookies.get(host) ?? new Map<string, string>())]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    const headers = new Headers(init.headers);
    const cookie = this.cookie(target.host);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(target, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator).trim();
      const value = pair!.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/iu.test(attribute));
      const jar = this.#cookies.get(target.host) ?? new Map<string, string>();
      if (expired || value === "") jar.delete(name);
      else jar.set(name, value);
      this.#cookies.set(target.host, jar);
    }
    return response;
  }

  /** Follows redirects the way a browser does, answering where it stopped. */
  async navigate(url: string): Promise<{ readonly url: string; readonly response: Response }> {
    let current = url;
    for (let hop = 0; hop < 20; hop += 1) {
      const response = await this.request(current, {
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      let location = response.headers.get("location");
      // A sign-in page answering a script with where to go next, as the Account's own pages read it.
      if (!location && response.headers.get("content-type")?.includes("application/json")) {
        const body = (await response.clone().json()) as { redirect?: boolean; url?: string };
        if (body.redirect === true && typeof body.url === "string") location = body.url;
      }
      if (
        !location ||
        (response.status !== 200 && (response.status < 300 || response.status >= 400))
      )
        return { url: current, response };
      await response.body?.cancel();
      current = new URL(location, current).href;
    }
    throw new Error(`Too many redirects from ${url}`);
  }
}

// ---- The Account, with its real routes, OIDC provider and claimer ----

const accountFront = await tlsFront();
routes.set(accountHostname, accountFront.port);
const publicOrigin = new URL(`https://${accountHostname}:${accountFront.port}`);
const homeFront = await tlsFront();
routes.set(`*.${domain}`, homeFront.port);

const database = createControlPlaneDatabase({
  connectionString: controlPlaneUrl ?? "",
  maxConnections: 4,
});
const subscriptions = new Map<string, StripeSubscription>();
const checkouts = new Map<string, string>();
let stripeUnavailable = false;
let lastCheckout: Parameters<StripeBilling["checkout"]>[0] | undefined;
const stripe = {
  checkout: async (input: Parameters<StripeBilling["checkout"]>[0]) => {
    lastCheckout = input;
    return {
      id: checkouts.get(input.requestId) ?? `cs_test_${randomUUID().replaceAll("-", "")}`,
      url: "https://checkout.stripe.example.test/pay",
    };
  },
  portal: async () => ({ url: "https://billing.stripe.example.test/session" }),
  subscription: async (id: string) => subscriptions.get(id)!,
  validateOffer: async () => {},
  validatePortal: async () => {},
  expireCheckout: async (id: string) => ({
    id,
    status: "expired" as const,
    url: null,
    payment: undefined,
  }),
  refundCheckout: async () => true,
  findCheckout: async () => undefined,
  cancel: async () => {
    if (stripeUnavailable) throw new Error("Stripe is unavailable");
  },
  updateSeatQuantity: async () => {
    throw new Error("Not used");
  },
} satisfies StripeBilling & Pick<CloudComputerStripe, "updateSeatQuantity">;
const config = loadCloudComputerConfig({
  OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL: provisionerEmail,
  OPENSTEER_CLOUD_COMPUTER_DOMAIN: domain,
  OPENSTEER_CLOUD_COMPUTER_REGION: "ash",
  OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE: "cpx22",
  OPENSTEER_CLOUD_COMPUTER_RELEASE_JSON: JSON.stringify({
    version: "1.2.3",
    installerUrl: "https://releases.example.test/install.sh",
    installerSha256: digest,
    images: Object.fromEntries(
      ["host", "runner", "browser-runtime", "browser-egress", "channel-runtime", "gateway"].map(
        (service) => [service, `example.test/${service}@sha256:${digest}`],
      ),
    ),
  }),
  OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL:
    "https://releases.example.test/managed/stable.json",
  OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY: "sk_test_cloudcomputerclaim",
  OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET: webhookSecret,
  OPENSTEER_CLOUD_COMPUTER_STRIPE_PRICE_ID: "price_1",
  OPENSTEER_CLOUD_COMPUTER_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_cloud",
  OPENSTEER_CLOUD_COMPUTER_PLAN_NAME: "Cloud Computer",
  OPENSTEER_CLOUD_COMPUTER_CURRENCY: "usd",
  OPENSTEER_CLOUD_COMPUTER_PRICE_MINOR: "2900",
})!;
const auth = createControlPlaneAuth(database, {
  publicOrigin,
  authSecret,
  googleClientId: "test-client",
  googleClientSecret: "test-secret",
});
const organizations = new OrganizationStore(database, {
  stripe: {
    ...stripe,
    invoice: async () => {
      throw new Error("Not used");
    },
    voidInvoice: async () => {
      throw new Error("Not used");
    },
  },
  offer: {
    priceId: "price_seat",
    portalConfigurationId: "bpc_org",
    name: "Work seat",
    currency: "usd",
    amountMinor: 4900,
    interval: "month",
  },
});
const cloud = new CloudComputerStore(database, {
  backupKeyVault: testBackupVault(),
  purgeBackupStep: async () => true,
  organizations,
  onBillingAttention: () => undefined,
  config,
  accountOrigin: publicOrigin,
  cipher: new HostedTeamSetupTokenCipher(Buffer.alloc(32, 5).toString("base64url")),
  stripe,
});
const claimErrors: unknown[] = [];
const claimer = new CloudComputerClaimer({
  store: cloud,
  home: new HttpManagedHomeClient({ ca: cert, resolve: loopback }),
  issuer: publicOrigin,
  sign: async (claims) => (await auth.api.signJWT({ body: { payload: claims } })).token,
  onError: (error) => claimErrors.push(error),
});
const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const lease = randomUUID();
let app: Awaited<ReturnType<typeof createControlPlaneServer>> | undefined;
const homes: { readonly close: () => Promise<void> }[] = [];
const operator = new Browser();

function workloadToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const body = `${encode({ alg: "RS256", kid: "gke", typ: "JWT" })}.${encode({
    aud: publicOrigin.origin,
    email: provisionerEmail,
    email_verified: true,
    exp: now + 300,
    iat: now,
    iss: "https://accounts.google.com",
  })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), google.privateKey).toString("base64url")}`;
}
const provisioner = () => ({
  authorization: `Bearer ${workloadToken()}`,
  [cloudComputerLeaseHeader]: lease,
});
const account = (path: string) => new URL(path, publicOrigin).href;
const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", origin: publicOrigin.origin },
  method: "POST",
});

/** A signed-in Account user: a session the Account's own adapter issued. */
async function accountUser(): Promise<{
  readonly id: ControlPlaneAccountId;
  readonly browser: Browser;
}> {
  const id = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
  const now = new Date();
  await database
    .insertInto("users")
    .values({
      id,
      displayName: "Cloud buyer",
      email: `${id}@example.test`,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(id);
  const signature = createHmac("sha256", authSecret).update(session.token).digest("base64");
  const browser = new Browser();
  browser.set(
    publicOrigin.host,
    context.authCookies.sessionToken.name,
    encodeURIComponent(`${session.token}.${signature}`),
  );
  return { id, browser };
}

async function webhook(object: unknown): Promise<void> {
  const body = JSON.stringify({
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type: "checkout.session.completed",
    data: { object },
  });
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const response = await operator.request(account(cloudComputerStripeWebhookPath), {
    body,
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    method: "POST",
  });
  expect(response.status, await response.text()).toBe(200);
}

/** A paid Checkout, as Stripe completes it: a subscription for this buyer. */
function order(buyer: ControlPlaneAccountId) {
  const requestId = randomUUID();
  const key = requestId.replaceAll("-", "");
  const metadata: Record<string, string> = { account_id: buyer, request_id: requestId };
  subscriptions.set(`sub_${key}`, {
    id: `sub_${key}`,
    customer: `cus_${key}`,
    status: "active",
    latest_invoice: { status: "paid", attempt_count: 1 },
    metadata,
    items: { has_more: false, data: [{ quantity: 1, price: { id: "price_1", currency: "usd" } }] },
  });
  checkouts.set(requestId, `cs_test_${key}`);
  return {
    requestId,
    session: {
      id: `cs_test_${key}`,
      mode: "subscription",
      client_reference_id: buyer,
      metadata,
      subscription: `sub_${key}`,
      customer: `cus_${key}`,
      payment_status: "paid",
      currency: "usd",
    },
  };
}

async function desired(id: string): Promise<CloudComputerDesired> {
  const response = await operator.request(account(cloudComputersDesiredPath), {
    headers: provisioner(),
  });
  expect(response.status).toBe(200);
  const found = CloudComputerDesiredResponseSchema.parse(await response.json()).computers.find(
    (computer) => computer.id === id,
  );
  if (!found) throw new Error(`The provisioner was not asked for ${id}`);
  return found;
}

async function report(
  computer: CloudComputerDesired,
  phase: "provisioning" | "ready",
  observedIdentity: { deploymentId: string; hostKeyFingerprint: string } | null,
): Promise<void> {
  const response = await operator.request(account(cloudComputerStatusPath(computer.id)), {
    ...json({
      id: computer.id,
      generation: computer.generation,
      revision: computer.revision,
      phase,
      providerServerId: 7,
      ipv4: "192.0.2.7",
      ipv6: null,
      observedIdentity,
      lastError: null,
    }),
    headers: { ...provisioner(), "content-type": "application/json" },
  });
  expect(response.status, await response.text()).toBe(200);
}

/**
 * The provisioner's path for one paid Cloud Computer, then the claim:
 * `/boot`, a Home started from exactly what it returned, `boot-complete` with
 * the identity that Home's discovery proves, readiness, and the claimer.
 */
async function bootAndClaim(id: string) {
  const computer = await desired(id);
  await report(computer, "provisioning", null);
  const boot = await operator.request(
    account(cloudComputerBootPath(computer.id)),
    json({ hostname: computer.hostname, bootstrapToken: computer.bootstrapToken }),
  );
  const bootBody = await boot.text();
  expect(boot.status, bootBody).toBe(200);
  const booted = CloudComputerBootResponseSchema.parse(JSON.parse(bootBody));
  expect(booted.managedHome).toBeDefined();

  const directory = await mkdtemp(join(scratch, "home-"));
  const homeDatabase = await cloneTestDatabase("host");
  const homeOrigin = `https://${booted.hostname}`;
  const homePort = await freePort();
  const homeConfig = parseHostConfig({
    OPENSTEER_MODE: "development",
    OPENSTEER_DEPLOYMENT_KIND: "personal",
    OPENSTEER_DATABASE_URL: homeDatabase.url,
    OPENSTEER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    OPENSTEER_HOST_DATA_DIR: join(directory, "host"),
    OPENSTEER_PORT: String(homePort),
    OPENSTEER_BIND_ADDRESS: "127.0.0.1",
    OPENSTEER_CANONICAL_ORIGIN: homeOrigin,
    OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
    OPENSTEER_AGENT_HOME: join(directory, "agent-home"),
    OPENSTEER_NATIVE_FS_HELPER: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
    OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST: booted.setupCodeDigest,
    OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
    OPENSTEER_SIGNUP_POLICY: "closed",
    OPENSTEER_MANAGED_HOME_ID: booted.managedHome!.cloudComputerId,
    OPENSTEER_MANAGED_HOME_GENERATION: String(booted.managedHome!.generation),
    OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN: booted.accountOrigin,
    OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID: booted.managedHome!.oidc.clientId,
    OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET: booted.managedHome!.oidc.clientSecret,
  });
  const { host } = await ownTestDatabaseProducer(homeDatabase.url, async () => {
    const runtime = await createHostRuntime(homeConfig, {
      personalAccountGrantFetch: createPublicHttpsFetch({
        ca: cert,
        maxRequestBytes: 1,
        maxResponseBytes: 64 * 1_024,
        resolve: loopback,
        timeoutMs: 10_000,
      }),
    });
    if (runtime.kind !== "personal") throw new Error("Expected a Home");
    return { host: runtime as PersonalHostRuntime, close: () => runtime.close() };
  });
  homes.push({
    close: async () => {
      await host.close();
      await homeDatabase.drop();
    },
  });
  await host.app.listen({ host: "127.0.0.1", port: homePort });
  homeFront.target = homePort;

  // What the VM reports: the identity the Home's own discovery proves.
  const discovery = (await (
    await operator.request(`${homeOrigin}/.well-known/opensteer`)
  ).json()) as {
    authority: { document: { deploymentId: string }; publicKey: { spki: string } };
  };
  const identity = {
    deploymentId: discovery.authority.document.deploymentId,
    hostKeyFingerprint: hostKeyFingerprint(discovery.authority.publicKey.spki),
  };
  const completed = await operator.request(
    account(cloudComputerBootCompletePath(computer.id)),
    json({
      hostname: computer.hostname,
      bootstrapToken: computer.bootstrapToken,
      identity,
    }),
  );
  expect(completed.status, await completed.text()).toBe(200);
  await report(await desired(id), "ready", identity);

  claimErrors.length = 0;
  expect(await claimer.runOnce()).toBe(1);
  expect(claimErrors).toEqual([]);
  const recorded = await database
    .selectFrom("cloudComputers")
    .select(["bootstrapReceipt", "claimError"])
    .where("id", "=", id as never)
    .executeTakeFirstOrThrow();
  expect(recorded.claimError).toBeNull();
  const receipt = ManagedHomeClaimReceiptSchema.parse(recorded.bootstrapReceipt);
  return { host, homeOrigin, identity, receipt };
}

/** A bought Cloud Computer, booted and ready, that nobody has claimed yet. */
async function readyUnclaimed() {
  const buyer = await accountUser();
  const paid = order(buyer.id);
  expect(
    (
      await buyer.browser.request(
        account(accountCloudComputerCheckoutPath),
        json({ requestId: paid.requestId }),
      )
    ).status,
  ).toBe(200);
  await webhook(paid.session);
  const { id } = await database
    .selectFrom("cloudComputers")
    .select("id")
    .where("accountId", "=", buyer.id)
    .executeTakeFirstOrThrow();
  const computer = await desired(id);
  await report(computer, "provisioning", null);
  expect(
    (
      await operator.request(
        account(cloudComputerBootPath(computer.id)),
        json({ hostname: computer.hostname, bootstrapToken: computer.bootstrapToken }),
      )
    ).status,
  ).toBe(200);
  const keys = generateKeyPairSync("ed25519");
  const identity = {
    deploymentId: createId("deployment"),
    hostKeyFingerprint: hostKeyFingerprint(
      keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    ),
  };
  expect(
    (
      await operator.request(
        account(cloudComputerBootCompletePath(computer.id)),
        json({ hostname: computer.hostname, bootstrapToken: computer.bootstrapToken, identity }),
      )
    ).status,
  ).toBe(200);
  await report(await desired(id), "ready", identity);
  return { buyer, id, identity };
}

/** A lease taken now: the job a claim worker would carry. */
async function leaseClaim(id: string) {
  await database
    .updateTable("cloudComputers")
    .set({ claimNextAt: null })
    .where("id", "=", id as never)
    .execute();
  const job = await cloud.claimDue();
  if (job?.id !== id) throw new Error(`Expected to lease ${id}`);
  return job;
}

/** A call to the Home's own API as its web app makes it. */
async function homeApi(
  browser: Browser,
  origin: string,
  name: string,
  payload?: object,
): Promise<{
  readonly status: number;
  readonly body: { data?: unknown; error?: { reason?: string } };
}> {
  const response =
    payload === undefined
      ? await browser.request(`${origin}/v1/rpc/${name}?input=%7B%7D`, {
          headers: { origin, ...apiVersionHeaders("personal") },
        })
      : await browser.request(`${origin}/v1/rpc/${name}`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            origin,
            ...apiVersionHeaders("personal"),
          },
          method: "POST",
        });
  return { status: response.status, body: (await response.json()) as never };
}

/** Signs in to the Home through the Account's OIDC provider, as a browser would. */
async function signInToHome(browser: Browser, homeOrigin: string) {
  const begun = await browser.request(`${homeOrigin}/v1/rpc/auth.oidc.begin`, {
    body: JSON.stringify({ providerId: officialOpensteerAccountProviderId, returnPath: "/" }),
    headers: {
      "content-type": "application/json",
      origin: homeOrigin,
      ...apiVersionHeaders("personal"),
    },
    method: "POST",
  });
  expect(begun.status, await begun.clone().text()).toBe(200);
  const { data } = (await begun.json()) as { data: { redirectUrl: string } };
  const stopped = await browser.navigate(data.redirectUrl);
  const session = await browser.request(`${homeOrigin}/v1/auth/session`, {
    headers: { origin: homeOrigin, ...apiVersionHeaders("personal") },
  });
  // Where the browser came to rest, for a failure to say why.
  const trail = `${stopped.response.status} ${stopped.url} ${(await stopped.response.text()).slice(0, 300)}`;
  return Object.assign(session, { trail });
}

beforeAll(async () => {
  await migrateControlPlaneToLatest(database);
  app = await createControlPlaneServer(
    {
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle: new ConnectLifecycleService(database, {
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
      }),
      organizations,
      workHomeFetch: async () => {
        throw new Error("Not used");
      },
      cloudComputers: {
        store: cloud,
        kickBootstrap: () => undefined,
        stripeWebhookSecret: webhookSecret,
        verifyProvisioner: googleServiceAccountVerifier({
          audience: publicOrigin.origin,
          email: provisionerEmail,
          keys: async () => google.publicKey,
        }),
      },
      personalRemoteAccount: new PersonalRemoteAccountService({
        auth,
        database,
        issuer: publicOrigin,
        operationCipher: new PersonalAccountLinkOperationCipher(
          Buffer.alloc(32, 11).toString("base64url"),
        ),
      }),
      portalOrigin: publicOrigin,
      publicOrigin,
      store: new ControlPlaneStore(database, publicOrigin, { portalOrigin: publicOrigin }),
    },
    { logger: false },
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  accountFront.target = (app.server.address() as AddressInfo).port;
  await cloud.checkOffer();
  await organizations.checkOffer();
  // One backup namespace per Cloud Computer this file buys.
  for (const prefix of [
    "claim-1",
    "claim-2",
    "claim-3",
    "claim-4",
    "claim-5",
    "claim-6",
    "claim-7",
  ])
    await cloud.addBackupTarget({
      endpoint: "https://s3.example.test",
      bucket: "test-backups",
      prefix,
      accessKeyId: `access-${prefix}`,
      secretAccessKey: `secret-${prefix}`,
    });
  const leased = await operator.request(account(cloudComputerLeasePath), {
    ...json({ holder: lease }),
    headers: { ...provisioner(), "content-type": "application/json" },
  });
  expect(leased.status, await leased.text()).toBe(200);
}, 120_000);

afterAll(async () => {
  for (const home of homes.splice(0)) await home.close();
  await app?.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  (tls as { connect: typeof tls.connect }).connect = connect;
  await database.destroy();
  await rm(scratch, { recursive: true, force: true });
});

it.skipIf(!controlPlaneUrl || !hostUrl)(
  "claims a paid Home for its buyer, who alone signs in to it through their Account",
  async () => {
    const buyer = await accountUser();
    const paid = order(buyer.id);
    const started = await buyer.browser.request(
      account(accountCloudComputerCheckoutPath),
      json({ requestId: paid.requestId }),
    );
    expect(started.status, await started.text()).toBe(200);
    await webhook(paid.session);
    const { id } = await database
      .selectFrom("cloudComputers")
      .select("id")
      .where("accountId", "=", buyer.id)
      .executeTakeFirstOrThrow();

    const { host, homeOrigin, identity, receipt } = await bootAndClaim(id);
    expect(receipt.document).toMatchObject({
      account: { issuer: publicOrigin.origin, subject: buyer.id },
      authority: { canonicalOrigin: homeOrigin, ...identity },
    });
    expect(receipt.document.work).toBeUndefined();

    // The Home is in the buyer's directory, at its own address.
    // An app that hasn't said it understands a Home at its own address isn't shown one.
    const older = await buyer.browser.request(account("/v1/account/deployments"));
    expect(
      ListAccountDeploymentsResponseSchema.parse(await older.json()).deployments.map(
        (deployment) => deployment.id,
      ),
    ).not.toContain(identity.deploymentId);
    const listed = await buyer.browser.request(
      account("/v1/account/deployments?understands=canonical-personal"),
    );
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(ListAccountDeploymentsResponseSchema.parse(await listed.json()).deployments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          access: "owner",
          authority: expect.objectContaining({
            canonicalOrigin: homeOrigin,
            deploymentId: identity.deploymentId,
          }),
        }),
      ]),
    );

    // The buyer signs in to the Home through the Account; it is the one owner.
    const session = await signInToHome(buyer.browser, homeOrigin);
    expect(session.status, session.trail).toBe(200);
    const owner = await host.store.database
      .selectFrom("users")
      .select("id")
      .executeTakeFirstOrThrow();
    expect(await session.json()).toMatchObject({ session: { user: { id: owner.id } } });

    // Its Account link reads as a Cloud Computer's, which nobody unlinks.
    const linkRead = await homeApi(buyer.browser, homeOrigin, "personal.accountLink.get");
    expect(linkRead.body.data).toMatchObject({
      accountLink: { state: "active", subject: buyer.id },
      managed: true,
    });
    const unlink = await homeApi(buyer.browser, homeOrigin, "commands.dispatch", {
      idempotencyKey: randomUUID(),
      type: "personal.accountLink.unlink",
    });
    expect(unlink.status).toBe(409);
    expect(unlink.body.error?.reason).toBe("managed-home-unlink-refused");
    expect(
      (await homeApi(buyer.browser, homeOrigin, "personal.accountLink.get")).body.data,
    ).toMatchObject({ accountLink: { state: "active" } });

    // Another Account user goes through the same door and is not let in.
    const stranger = await accountUser();
    const refused = await signInToHome(stranger.browser, homeOrigin);
    expect(refused.status).toBe(401);
    expect(await host.store.database.selectFrom("users").select("id").execute()).toEqual([owner]);
  },
  240_000,
);

it.skipIf(!controlPlaneUrl || !hostUrl)(
  "claims a work Cloud Computer for its assignee and carries the organization's marker",
  async () => {
    const admin = await accountUser();
    const member = await accountUser();
    const paid = order(admin.id);
    const organizationCheckout = await admin.browser.request(
      account(`${accountOrganizationsPath}/checkout`),
      json({ requestId: paid.requestId, name: "Workspace", seats: 1 }),
    );
    expect(organizationCheckout.status, await organizationCheckout.text()).toBe(200);
    const organizationId = lastCheckout!.organization!.id;
    const metadata = { ...paid.session.metadata, organization_id: organizationId };
    subscriptions.set(paid.session.subscription, {
      ...subscriptions.get(paid.session.subscription)!,
      metadata,
      items: {
        has_more: false,
        data: [{ id: "si_seat", quantity: 1, price: { id: "price_seat", currency: "usd" } }],
      },
    });
    await webhook({ ...paid.session, metadata });
    const organizationPath = `${accountOrganizationsPath}/${organizationId}`;
    const invited = await admin.browser.request(
      account(`${organizationPath}/invitations`),
      json({ email: `${member.id}@example.test`, role: "member" }),
    );
    expect(invited.status, await invited.clone().text()).toBe(200);
    const invitation = (await invited.json()) as { id: string };
    const inbox = MyOrganizationsResponseSchema.parse(
      await (await member.browser.request(account(accountOrganizationsPath))).json(),
    );
    expect(inbox.invitations).toHaveLength(1);
    expect(
      (
        await member.browser.request(
          account(`${accountOrganizationsPath}/invitations/${invitation.id}/accept`),
          json({}),
        )
      ).status,
    ).toBe(200);
    const assigned = await admin.browser.request(
      account(`${organizationPath}/assignments`),
      json({ requestId: randomUUID(), accountId: member.id }),
    );
    expect(assigned.status, await assigned.clone().text()).toBe(200);
    const assignment = WorkAssignmentViewSchema.parse(await assigned.json());

    const { homeOrigin, receipt } = await bootAndClaim(assignment.computerId);
    expect(receipt.document.account.subject).toBe(member.id);
    expect(receipt.document.work).toEqual({
      organizationId,
      organizationName: "Workspace",
      assignmentId: assignment.assignmentId,
    });
    const session = await signInToHome(member.browser, homeOrigin);
    expect(session.status, session.trail).toBe(200);
  },
  240_000,
);

it.skipIf(!controlPlaneUrl || !hostUrl)(
  "fences each claim attempt on the row exactly as it was leased",
  async () => {
    const receiptFor = (origin: string) =>
      ({ document: { authority: { canonicalOrigin: origin } } }) as never;

    // A stale worker can neither fail nor record a newer attempt.
    const first = await readyUnclaimed();
    const stale = await leaseClaim(first.id);
    const current = await leaseClaim(first.id);
    expect(current.attempt).toBe(stale.attempt + 1);
    await cloud.failClaim(stale, "A stale worker's verdict");
    await cloud.deferClaim(stale, new Date(Date.now() + 3_600_000));
    const after = await database
      .selectFrom("cloudComputers")
      .select(["claimError", "claimNextAt"])
      .where("id", "=", first.id as never)
      .executeTakeFirstOrThrow();
    expect(after.claimError).toBeNull();
    expect(after.claimNextAt!.getTime()).toBeLessThan(Date.now() + 3_600_000);
    await expect(cloud.claimMaterial(stale)).rejects.toBeInstanceOf(
      CloudComputerClaimSupersededError,
    );
    await expect(
      cloud.recordClaim(stale, receiptFor("https://x"), {} as never),
    ).rejects.toBeInstanceOf(CloudComputerClaimSupersededError);

    // A deletion intent stops leasing and recording, before the tombstone.
    const second = await readyUnclaimed();
    const leased = await leaseClaim(second.id);
    // Stripe is down: the delete is recorded and waits, the row still active.
    stripeUnavailable = true;
    await cloud.mutate(second.id as never, "delete", second.buyer.id).catch(() => undefined);
    stripeUnavailable = false;
    const waiting = await database
      .selectFrom("cloudComputers")
      .select(["deletionRequestedAt", "revision", "state"])
      .where("id", "=", second.id as never)
      .executeTakeFirstOrThrow();
    expect(waiting.state).toBe("active");
    expect(waiting.deletionRequestedAt).not.toBeNull();
    // Even a job carrying the row's current revision is refused, on the intent alone.
    const atRevision = { ...leased, revision: waiting.revision };
    await database
      .updateTable("cloudComputers")
      .set({ claimNextAt: null })
      .where("id", "=", second.id as never)
      .execute();
    expect(await cloud.claimDue()).toBeUndefined();
    await expect(cloud.claimMaterial(atRevision)).rejects.toBeInstanceOf(
      CloudComputerClaimSupersededError,
    );
    await expect(
      cloud.recordClaim(atRevision, receiptFor("https://x"), {} as never),
    ).rejects.toBeInstanceOf(CloudComputerClaimSupersededError);

    // The owner's own listing is accepted only as this very Home.
    const third = await readyUnclaimed();
    const job = await leaseClaim(third.id);
    const { hostname } = await database
      .selectFrom("cloudComputers")
      .select("hostname")
      .where("id", "=", third.id as never)
      .executeTakeFirstOrThrow();
    const origin = `https://${hostname}`;
    const listing = async (fingerprint: string, canonicalOrigin: string, token: string) => {
      await database
        .deleteFrom("deploymentDirectoryEntries")
        .where("deploymentId", "=", third.identity.deploymentId as never)
        .execute();
      await database
        .deleteFrom("deploymentCredentials")
        .where("deploymentId", "=", third.identity.deploymentId as never)
        .execute();
      await database
        .deleteFrom("deployments")
        .where("id", "=", third.identity.deploymentId as never)
        .execute();
      const now = new Date();
      await database
        .insertInto("deployments")
        .values({
          activeHostInstanceId: createId("hostInstance"),
          accountLink: null,
          authorityEnvelope: null,
          canonicalOrigin,
          createdAt: now,
          directoryGeneration: 1,
          hostKeyFingerprint: fingerprint,
          reachability: "canonical",
          id: third.identity.deploymentId,
          lifecycle: "active",
          name: "Cloud Computer",
          oidcClientId: null,
          ownerAccountId: third.buyer.id,
          updatedAt: now,
        } as never)
        .execute();
      await database
        .insertInto("deploymentCredentials")
        .values({
          createdAt: now,
          deploymentId: third.identity.deploymentId,
          rotatedAt: now,
          tokenHash: token,
        } as never)
        .execute();
    };
    const otherKey = hostKeyFingerprint(
      generateKeyPairSync("ed25519")
        .publicKey.export({ format: "der", type: "spki" })
        .toString("base64url"),
    );
    for (const [fingerprint, canonicalOrigin] of [
      [otherKey, origin],
      [third.identity.hostKeyFingerprint, "https://elsewhere.home.example.test"],
      [third.identity.hostKeyFingerprint, origin],
    ] as const) {
      await listing(fingerprint, canonicalOrigin, "not-this-homes-credential");
      await expect(cloud.recordClaim(job, receiptFor(origin), {} as never)).rejects.toThrow(
        "already listed as another Home",
      );
    }
  },
  240_000,
);

it.skipIf(!controlPlaneUrl || !hostUrl)(
  "links a Home on its own server to an Account and unlinks it, with no Remote access",
  async () => {
    const directory = await mkdtemp(join(scratch, "byo-"));
    const homeDatabase = await cloneTestDatabase("host");
    const homeOrigin = `https://byo.${domain}`;
    const homePort = await freePort();
    const setupCode = randomBytes(32).toString("base64url");
    const { host } = await ownTestDatabaseProducer(homeDatabase.url, async () => {
      const runtime = await createHostRuntime(
        parseHostConfig({
          OPENSTEER_MODE: "development",
          OPENSTEER_DEPLOYMENT_KIND: "personal",
          OPENSTEER_DATABASE_URL: homeDatabase.url,
          OPENSTEER_AUTH_SECRET: randomBytes(32).toString("base64url"),
          OPENSTEER_HOST_DATA_DIR: join(directory, "host"),
          OPENSTEER_PORT: String(homePort),
          OPENSTEER_BIND_ADDRESS: "127.0.0.1",
          OPENSTEER_CANONICAL_ORIGIN: homeOrigin,
          OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
          OPENSTEER_AGENT_HOME: join(directory, "agent-home"),
          OPENSTEER_NATIVE_FS_HELPER: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
          OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: setupCode,
          OPENSTEER_SIGNUP_POLICY: "closed",
          OPENSTEER_PERSONAL_ACCOUNT_ISSUER: publicOrigin.origin,
        }),
        {
          personalAccountGrantFetch: createPublicHttpsFetch({
            ca: cert,
            maxRequestBytes: 1,
            maxResponseBytes: 64 * 1_024,
            resolve: loopback,
            timeoutMs: 10_000,
          }),
        },
      );
      if (runtime.kind !== "personal") throw new Error("Expected a Home");
      return { host: runtime as PersonalHostRuntime, close: () => runtime.close() };
    });
    homes.push({
      close: async () => {
        await host.close();
        await homeDatabase.drop();
      },
    });
    await host.app.listen({ host: "127.0.0.1", port: homePort });
    homeFront.target = homePort;

    // Its owner claims it with the setup link and a password.
    const owner = new Browser();
    expect(
      (await homeApi(owner, homeOrigin, "auth.setup.exchange", { token: setupCode })).status,
    ).toBe(200);
    expect(
      (
        await homeApi(owner, homeOrigin, "auth.setup.claim", {
          email: "owner@example.test",
          kind: "password",
          password: "correct horse battery staple",
        })
      ).status,
    ).toBe(200);
    const unlinked = await homeApi(owner, homeOrigin, "personal.accountLink.get");
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.data).toMatchObject({ accountLink: null, managed: false });
    const { authorityEnvelope } = unlinked.body.data as { authorityEnvelope: unknown };

    // The person's app carries the link between their Account and the Home.
    const person = await accountUser();
    const challenged = await person.browser.request(
      account("/v1/account/personal-host-links/challenges"),
      json({ authorityEnvelope, name: "My Home", operationId: `plo_${randomUUID()}` }),
    );
    expect(challenged.status, await challenged.clone().text()).toBe(201);
    const challenge = (await challenged.json()) as {
      challengeId: string;
      challengeCredential: string;
    };
    const approved = await homeApi(owner, homeOrigin, "commands.dispatch", {
      challenge,
      idempotencyKey: randomUUID(),
      type: "personal.accountLink.approve",
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const completed = await person.browser.request(
      account(
        `/v1/account/personal-host-links/${encodeURIComponent(challenge.challengeId)}/complete`,
      ),
      json({
        challengeCredential: challenge.challengeCredential,
        proof: (approved.body.data as { proof: unknown }).proof,
      }),
    );
    expect(completed.status, await completed.clone().text()).toBe(201);
    const consumed = await homeApi(owner, homeOrigin, "commands.dispatch", {
      completion: await completed.json(),
      idempotencyKey: randomUUID(),
      type: "personal.accountLink.complete",
    });
    expect(consumed.status, JSON.stringify(consumed.body)).toBe(200);
    expect((await homeApi(owner, homeOrigin, "personal.accountLink.get")).body.data).toMatchObject({
      accountLink: { state: "active", subject: person.id },
      managed: false,
    });

    // Unlinked from Settings, here and at the Account.
    const unlink = await homeApi(owner, homeOrigin, "commands.dispatch", {
      idempotencyKey: randomUUID(),
      type: "personal.accountLink.unlink",
    });
    expect(unlink.status, JSON.stringify(unlink.body)).toBe(200);
    expect((await homeApi(owner, homeOrigin, "personal.accountLink.get")).body.data).toMatchObject({
      accountLink: null,
    });
    const listed = await person.browser.request(
      account("/v1/account/deployments?understands=canonical-personal"),
    );
    expect(
      ListAccountDeploymentsResponseSchema.parse(await listed.json()).deployments.map(
        (deployment) => deployment.authority.canonicalOrigin,
      ),
    ).not.toContain(homeOrigin);
  },
  240_000,
);

it.skipIf(!controlPlaneUrl || !hostUrl)(
  "boots while its owner's Account is being deleted, with no deadlock between them",
  async () => {
    const buyer = await accountUser();
    const paid = order(buyer.id);
    expect(
      (
        await buyer.browser.request(
          account(accountCloudComputerCheckoutPath),
          json({ requestId: paid.requestId }),
        )
      ).status,
    ).toBe(200);
    await webhook(paid.session);
    const { id } = await database
      .selectFrom("cloudComputers")
      .select("id")
      .where("accountId", "=", buyer.id)
      .executeTakeFirstOrThrow();
    const computer = await desired(id);
    await report(computer, "provisioning", null);

    // Account deletion's order: the owner FOR UPDATE, then what hangs off them.
    let booting: Promise<Response> | undefined;
    const deletion = database.transaction().execute(async (tx) => {
      await tx.selectFrom("users").select("id").where("id", "=", buyer.id).forUpdate().execute();
      booting = operator.request(
        account(cloudComputerBootPath(computer.id)),
        json({ hostname: computer.hostname, bootstrapToken: computer.bootstrapToken }),
      );
      // The boot is now queued behind the owner's lock (a lock state, not a timer).
      for (let read = 0; ; read += 1) {
        const { waiting } = await database
          .selectNoFrom(
            sql<number>`(select count(*)::int from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock')`.as(
              "waiting",
            ),
          )
          .executeTakeFirstOrThrow();
        if (waiting > 0) break;
        if (read > 2_000) throw new Error("The boot never queued behind the owner's lock");
      }
      await tx
        .updateTable("cloudComputers")
        .set({ updatedAt: new Date() })
        .where("id", "=", id as never)
        .execute();
    });
    await expect(deletion).resolves.toBeUndefined();
    const booted = await booting!;
    expect(booted.status, await booted.text()).toBe(200);
  },
  240_000,
);
