import { resetManagedCloudTables } from "./reset.test-support.js";
import { testBackupVault } from "./backup-erasure.test-support.js";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  cloudComputerStripeWebhookPath,
  cloudWords,
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { escapeHtml } from "@opensteer/shared/browserPage";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { ControlPlaneAuthenticator, createControlPlaneAuth } from "../auth/auth.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { ControlPlaneStore } from "../database/store.js";
import { CloudComputerSecretCipher } from "./secret-cipher.js";
import { PortalSessionStore } from "../portal/portal-sessions.js";
import { ControlPlaneError } from "../server/errors.js";
import { createControlPlaneServer } from "../server/server.js";
import { loadCloudComputerConfig } from "./config.js";
import { browserPoolRelease } from "./pool-release.test-support.js";
import { cloudComputerPreparingRefreshSeconds } from "./portal-routes.js";
import { CloudComputerStore } from "./store.js";
import type { StripeBilling, StripeSubscription } from "./stripe.js";

const url = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// The focused integration launcher supplies a disposable Account database.
const integration = url ? describe : describe.skip;
const publicOrigin = new URL("https://account.cloud-computer-pages.example.test");
const portalOrigin = new URL("https://portal.cloud-computer-pages.example.test");
const pagesUrl = new URL("/cloud-computer", portalOrigin);
const authSecret = "test-auth-secret-for-cloud-computer-pages";
const webhookSecret = "whsec_abcdefghijklmno";
const checkoutUrl = "https://checkout.stripe.example.test/pay";
const billingUrl = "https://billing.stripe.example.test/session";
const digest = "a".repeat(64);
const config = loadCloudComputerConfig({
  OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL: "home@example.iam.gserviceaccount.com",
  OPENSTEER_CLOUD_COMPUTER_DOMAIN: "home.example.test",
  OPENSTEER_CLOUD_COMPUTER_REGION: "us-central1-a",
  OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE: "e2-standard-4",
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
  OPENSTEER_CLOUD_COMPUTER_RELEASE_MANIFEST_URL: "https://releases.example.test/managed/stable.json",
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

integration("Cloud Computer website pages", () => {
  const database = createControlPlaneDatabase({ connectionString: url!, maxConnections: 4 });
  const subscriptions = new Map<string, StripeSubscription>();
  const stripe = {
    checkout: vi.fn<StripeBilling["checkout"]>(async (input) => ({
      id: `cs_test_${input.requestId.replaceAll("-", "")}`,
      url: checkoutUrl,
    })),
    portal: vi.fn<StripeBilling["portal"]>(async () => ({ url: billingUrl })),
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
    cancel: vi.fn<StripeBilling["cancel"]>(async () => {}),
  } satisfies StripeBilling;
  const auth = createControlPlaneAuth(database, {
    publicOrigin,
    authSecret,
    googleClientId: "test-client",
    googleClientSecret: "test-secret",
  });
  const cloud = new CloudComputerStore(database, {
    backupKeyVault: testBackupVault(),
    purgeBackupStep: async () => true,
    config,
    accountOrigin: publicOrigin,
    cipher: new CloudComputerSecretCipher(Buffer.alloc(32, 5).toString("base64url")),
    stripe,
    returnUrl: pagesUrl,
  });
  const portalSessions = new PortalSessionStore(database);
  let app: Awaited<ReturnType<typeof createControlPlaneServer>>;
  let listener: URL;

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
    const unused = async () => {
      throw new Error("Not used");
    };
    app = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle: new ConnectLifecycleService(database, {
        delete: async () => undefined,
        ensure: unused,
        readConnectorToken: unused,
        rotateConnectorToken: unused,
      }),
      cloudComputers: {
        store: cloud,
        stripeWebhookSecret: webhookSecret,
        verifyProvisioner: async () => {
          throw new ControlPlaneError("unauthorized", "Not used");
        },
      },
      portalOrigin,
      portalSessions,
      publicOrigin,
      store: new ControlPlaneStore(database, publicOrigin, { portalOrigin }),
    });
    listener = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
  });

  beforeEach(async () => {
    await resetManagedCloudTables(database);
    for (const mock of Object.values(stripe)) mock.mockClear();
    await cloud.checkOffer();
    await cloud.addBackupTarget({
      endpoint: "https://s3.example.test",
      bucket: "test-backups",
      prefix: "pages",
      accessKeyId: "access-a",
      secretAccessKey: "secret-a",
    });
  });

  afterAll(async () => {
    await app?.close();
    await database.destroy();
  });

  it("is served only on the portal host, and shows the price and sign-in when signed out", async () => {
    expect((await page("/cloud-computer", { host: publicOrigin.host })).status).toBe(404);
    const signedOut = await page("/cloud-computer");
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    expect(signedOut.body).toContain("$29.00 a month");
    expect(signedOut.body).toContain('href="/auth/sign-in?return=%2Fcloud-computer"');
    const checkout = await page("/cloud-computer/checkout");
    expect(checkout.status).toBe(303);
    expect(checkout.headers.get("location")).toBe(
      "/auth/sign-in?return=%2Fcloud-computer%2Fcheckout",
    );
  });

  it("buys with one explicit click, returns from Stripe to these pages, and follows setup", async () => {
    const person = await signIn();
    const offer = await page("/cloud-computer", person);
    expect(offer.body).toContain('href="/cloud-computer/checkout"');

    const form = await page("/cloud-computer/checkout", person);
    expect(form.status).toBe(200);
    expect(stripe.checkout).not.toHaveBeenCalled();
    const requestId = /name="requestId" value="([^"]+)"/u.exec(form.body)?.[1];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);

    const foreign = await post(
      "/cloud-computer/checkout",
      person,
      { requestId: requestId! },
      {
        origin: publicOrigin.origin,
      },
    );
    expect(foreign.status).toBe(403);
    expect(stripe.checkout).not.toHaveBeenCalled();

    for (let click = 0; click < 2; click += 1) {
      const sent = await post("/cloud-computer/checkout", person, { requestId: requestId! });
      expect(sent.status).toBe(303);
      expect(sent.headers.get("location")).toBe(checkoutUrl);
    }
    expect(stripe.checkout).toHaveBeenCalledTimes(1);
    expect(stripe.checkout).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: person.id, requestId, returnUrl: pagesUrl }),
    );

    const paidNotice = escapeHtml(cloudWords("cloud.web.checkout.paid"));
    const forged = await page("/cloud-computer?checkout=paid&notice=no-billing", person);
    expect(forged.body).not.toContain(paidNotice);
    expect(forged.body).not.toContain(escapeHtml(cloudWords("cloud.web.noBilling")));
    expect((await page(`/cloud-computer?checkout=${requestId}`, person)).body).not.toContain(
      paidNotice,
    );
    const customer = await complete(person.id, requestId!);
    const preparing = await page(`/cloud-computer?checkout=${requestId}`, person);
    expect(preparing.body).toContain(
      `data-state="done">${escapeHtml(cloudWords("cloud.step.payment"))}</li>`,
    );
    expect(
      (await page(`/cloud-computer?checkout=${requestId}`, await signIn())).body,
    ).not.toContain(paidNotice);
    expect(preparing.status).toBe(200);
    expect(preparing.headers.get("refresh")).toBe(String(cloudComputerPreparingRefreshSeconds));
    expect(preparing.body).toContain(escapeHtml(cloudWords("cloud.preparing.title")));
    const again = await page("/cloud-computer/checkout", person);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/cloud-computer");

    const billing = await page("/cloud-computer/billing", person);
    expect(billing.status).toBe(303);
    expect(billing.headers.get("location")).toBe(billingUrl);
    expect(stripe.portal).toHaveBeenCalledWith(customer, pagesUrl, "bpc_cloud");
    const [computer] = await cloud.listForAccount(person.id);
    expect((await post("/cloud-computer/suspend", person, { id: computer!.id })).status).toBe(303);
    expect((await page(`/cloud-computer?checkout=${requestId}`, person)).body).toContain(
      paidNotice,
    );
  });

  it("suspends, resumes and deletes only after the typed word, for its owner alone", async () => {
    const person = await signIn();
    const stranger = await signIn();
    await complete(person.id, randomUUID());
    const [computer] = await cloud.listForAccount(person.id);
    const id = computer!.id;

    const theirs = await post("/cloud-computer/suspend", stranger, { id });
    expect(theirs.status).toBe(404);
    expect((await cloud.listForAccount(person.id))[0]?.status).toBe("preparing");

    expect((await post("/cloud-computer/suspend", person, { id })).headers.get("location")).toBe(
      "/cloud-computer",
    );
    const suspended = await page("/cloud-computer", person);
    expect(suspended.body).toContain("You suspended this Cloud Computer.");
    expect(suspended.body).toContain('action="/cloud-computer/resume"');
    expect(suspended.headers.get("refresh")).toBeNull();

    expect((await post("/cloud-computer/resume", person, { id })).status).toBe(303);
    expect((await cloud.listForAccount(person.id))[0]?.status).toBe("preparing");

    const mistyped = await post("/cloud-computer/delete", person, { id, confirm: "remove" });
    expect(mistyped.status).toBe(400);
    expect(mistyped.body).toContain(escapeHtml(cloudWords("cloud.web.typeWord")));
    expect((await cloud.listForAccount(person.id))[0]?.status).toBe("preparing");

    const deleted = await post("/cloud-computer/delete", person, { id, confirm: " Delete " });
    expect(deleted.status).toBe(303);
    expect(stripe.cancel).toHaveBeenCalledTimes(1);
    const deletionStatus = await page("/cloud-computer", person);
    for (const fact of [
      "cloud.deletion.computer",
      "cloud.deletion.backups",
      "cloud.deletion.storage",
    ] as const)
      expect(deletionStatus.body).toContain(`${escapeHtml(cloudWords(fact))} — Pending since`);
  });

  it("shows the store's refusal with what to do next instead of a blank error", async () => {
    const person = await signIn();
    await complete(person.id, randomUUID());
    const [computer] = await cloud.listForAccount(person.id);
    await database.updateTable("cloudComputers").set({ state: "deleted" }).execute();
    const refused = await post("/cloud-computer/suspend", person, { id: computer!.id });
    expect(refused.status).toBe(409);
    expect(refused.body).toContain(escapeHtml(cloudWords("cloud.reason.deleted")));
    expect(refused.body).toContain(escapeHtml(cloudWords("cloud.web.next.other")));
  });

  async function signIn() {
    const id = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    const now = new Date();
    await database
      .insertInto("users")
      .values({
        id,
        displayName: "Cloud page tester",
        email: `${id}@example.test`,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    const session = await (await auth.$context).internalAdapter.createSession(id);
    const created = await portalSessions.create({ accountId: id, accountSessionId: session.id });
    return { id, cookie: `__Host-opensteer.portal=${encodeURIComponent(created.token)}` };
  }

  /** Stripe reports a paid Checkout for this request, as its webhook does. */
  async function complete(accountId: ControlPlaneAccountId, requestId: string) {
    if (
      !(await database
        .selectFrom("cloudComputerCheckouts")
        .select("requestId")
        .where("requestId", "=", requestId)
        .executeTakeFirst())
    )
      await cloud.checkout(accountId, requestId);
    const key = requestId.replaceAll("-", "");
    const customer = `cus_${key}`;
    const subscription = `sub_${key}`;
    const metadata = { account_id: accountId, request_id: requestId };
    subscriptions.set(subscription, {
      id: subscription,
      customer,
      status: "active",
      latest_invoice: { status: "paid", attempt_count: 1 },
      metadata,
      items: {
        has_more: false,
        data: [{ quantity: 1, price: { id: "price_1", currency: "usd" } }],
      },
    });
    const body = JSON.stringify({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${key}`,
          mode: "subscription",
          client_reference_id: accountId,
          metadata,
          subscription,
          customer,
          payment_status: "paid",
          currency: "usd",
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const response = await fetch(new URL(cloudComputerStripeWebhookPath, listener), {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      },
    });
    expect(response.status, await response.text()).toBe(200);
    return customer;
  }

  function page(path: string, as?: { readonly cookie: string } | { readonly host: string }) {
    return send("GET", path, {
      host: as && "host" in as ? as.host : portalOrigin.host,
      ...(as && "cookie" in as ? { cookie: as.cookie } : {}),
    });
  }

  function post(
    path: string,
    as: { readonly cookie: string },
    fields: Record<string, string>,
    options: { readonly origin?: string } = {},
  ) {
    return send(
      "POST",
      path,
      {
        host: portalOrigin.host,
        origin: options.origin ?? portalOrigin.origin,
        cookie: as.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      new URLSearchParams(fields).toString(),
    );
  }

  /** A browser request to the listener; `fetch` cannot name the portal's Host. */
  function send(method: string, path: string, headers: Record<string, string>, body?: string) {
    return new Promise<{
      status: number;
      headers: { get(name: string): string | null };
      body: string;
    }>((resolve, reject) => {
      const outgoing = httpRequest(
        new URL(path, listener),
        {
          method,
          headers:
            body === undefined
              ? headers
              : { ...headers, "content-length": String(Buffer.byteLength(body)) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const value = (name: string) => {
              const found = response.headers[name.toLowerCase()];
              return found === undefined ? null : String(found);
            };
            resolve({
              status: response.statusCode ?? 0,
              headers: { get: value },
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          response.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }
});
