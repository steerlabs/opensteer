import { resetManagedCloudTables } from "../cloud-computers/reset.test-support.js";
import { testBackupVault } from "../cloud-computers/backup-erasure.test-support.js";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  cloudComputerStripeWebhookPath,
  cloudWords,
  ControlPlaneAccountIdSchema,
  orgWords,
  type ControlPlaneAccountId,
  type OrganizationId,
} from "@opensteer/control-plane-protocol";
import { escapeHtml } from "@opensteer/shared/browserPage";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { ControlPlaneAuthenticator, createControlPlaneAuth } from "../auth/auth.js";
import { loadCloudComputerConfig } from "../cloud-computers/config.js";
import { CloudComputerStore } from "../cloud-computers/store.js";
import type {
  CloudComputerStripe,
  StripeBilling,
  StripeSubscription,
} from "../cloud-computers/stripe.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { ControlPlaneStore } from "../database/store.js";
import { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { PortalSessionStore } from "../portal/portal-sessions.js";
import { ControlPlaneError } from "../server/errors.js";
import { createControlPlaneServer } from "../server/server.js";
import { organizationTime } from "./portal-pages.js";
import { OrganizationStore } from "./store.js";

const url = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// The focused integration launcher supplies a disposable Account database.
const integration = url ? describe : describe.skip;
const publicOrigin = new URL("https://account.organization-pages.example.test");
const portalOrigin = new URL("https://portal.organization-pages.example.test");
const authSecret = "test-auth-secret-for-organization-pages";
const webhookSecret = "whsec_abcdefghijklmno";
const checkoutUrl = "https://checkout.stripe.example.test/pay";
const billingUrl = "https://billing.stripe.example.test/session";
const digest = "a".repeat(64);
const config = loadCloudComputerConfig({
  OPENSTEER_CLOUD_COMPUTER_PROVISIONER_EMAIL: "home@example.iam.gserviceaccount.com",
  OPENSTEER_CLOUD_COMPUTER_DOMAIN: "home.example.test",
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
  OPENSTEER_CLOUD_COMPUTER_STRIPE_SECRET_KEY: "sk_test_abcdefghijklmno",
  OPENSTEER_CLOUD_COMPUTER_STRIPE_WEBHOOK_SECRET: webhookSecret,
  OPENSTEER_CLOUD_COMPUTER_STRIPE_PRICE_ID: "price_1",
  OPENSTEER_CLOUD_COMPUTER_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_cloud",
  OPENSTEER_CLOUD_COMPUTER_PLAN_NAME: "Cloud Computer",
  OPENSTEER_CLOUD_COMPUTER_CURRENCY: "usd",
  OPENSTEER_CLOUD_COMPUTER_PRICE_MINOR: "2900",
})!;

type Person = {
  readonly id: ControlPlaneAccountId;
  readonly email: string;
  readonly cookie: string;
};

integration("Organization website pages", () => {
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
    findCheckout: vi.fn<StripeBilling["findCheckout"]>(async () => undefined),
    cancel: vi.fn<StripeBilling["cancel"]>(async (id) => {
      const row = subscriptions.get(id);
      if (row) subscriptions.set(id, { ...row, status: "canceled" });
    }),
    updateSeatQuantity: vi.fn<CloudComputerStripe["updateSeatQuantity"]>(async ({ subscription }) =>
      subscriptions.get(subscription)!,
    ),
    invoice: vi.fn<CloudComputerStripe["invoice"]>(async (id) => {
      const invoice = [...subscriptions.values()].find(
        (value) => value.latest_invoice?.id === id,
      )?.latest_invoice;
      if (!invoice) throw new Error("No mock invoice");
      return invoice;
    }),
    voidInvoice: vi.fn<CloudComputerStripe["voidInvoice"]>(async (id) => {
      for (const [subscription, value] of subscriptions) {
        if (value.latest_invoice?.id === id)
          subscriptions.set(subscription, {
            ...value,
            pending_update: null,
            latest_invoice: { ...value.latest_invoice, status: "void" },
          });
      }
    }),
  } satisfies StripeBilling &
    Pick<CloudComputerStripe, "updateSeatQuantity" | "invoice" | "voidInvoice">;
  const auth = createControlPlaneAuth(database, {
    publicOrigin,
    authSecret,
    googleClientId: "test-client",
    googleClientSecret: "test-secret",
  });
  const organizationsUrl = new URL("/organizations", portalOrigin);
  const organizations = new OrganizationStore(database, {
    stripe,
    offer: {
      priceId: "price_seat",
      portalConfigurationId: "bpc_org",
      name: "Work seat",
      currency: "usd",
      amountMinor: 4900,
      interval: "month",
    },
    returnUrl: organizationsUrl,
  });
  const cloud = new CloudComputerStore(database, {
    backupKeyVault: testBackupVault(),
    purgeBackupStep: async () => true,
    organizations,
    config,
    accountOrigin: publicOrigin,
    cipher: new HostedTeamSetupTokenCipher(Buffer.alloc(32, 5).toString("base64url")),
    stripe,
    returnUrl: new URL("/cloud-computer", portalOrigin),
  });
  const portalSessions = new PortalSessionStore(database);
  const workHomeFetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error("No Home is reachable in this test");
  });
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
      organizations,
      workHomeFetch,
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
    workHomeFetch.mockClear();
    await cloud.checkOffer();
    await organizations.checkOffer();
    // Each Cloud Computer takes a backup target of its own; a test makes at most five.
    for (let target = 0; target < 5; target += 1) {
      const key = randomUUID().slice(0, 8);
      await cloud.addBackupTarget({
        endpoint: "https://s3.example.test",
        bucket: "test-backups",
        prefix: `organization-pages-${key}`,
        accessKeyId: `access-${key}`,
        secretAccessKey: "secret-a",
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    await database.destroy();
  });

  it("creates an organization by checkout and returns to its pages", async () => {
    const admin = await signIn("Ada Admin");
    const form = await page("/organizations/new", admin);
    expect(form.status).toBe(200);
    expect(form.body).toContain("$49.00 a seat a month");
    expect(form.body).toContain(escapeHtml(orgWords("org.split.lead")));
    expect(form.body).toContain(escapeHtml(orgWords("org.cannot.content")));
    const requestId = /name="requestId" value="([^"]+)"/u.exec(form.body)![1]!;

    const foreign = await post(
      "/organizations/new",
      admin,
      { requestId, name: "Acme", seats: "3" },
      publicOrigin.origin,
    );
    expect(foreign.status).toBe(403);
    const invalid = await post("/organizations/new", admin, { requestId, name: "", seats: "0" });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toContain(escapeHtml(orgWords("org.refused.form")));
    expect(stripe.checkout).not.toHaveBeenCalled();

    const sent = await post("/organizations/new", admin, { requestId, name: "Acme", seats: "3" });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe(checkoutUrl);
    expect(stripe.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: organizationsUrl,
        organization: expect.objectContaining({ quantity: 3 }),
      }),
    );
    const id = await completeOrganization(admin, requestId, 3);

    const forged = await page("/organizations?organization=checkout-completed&joined=1", admin);
    expect(forged.body).not.toContain(escapeHtml(orgWords("org.checkout.completed")));
    expect(forged.body).not.toContain(escapeHtml(orgWords("org.done.joined")));
    const returned = await page(`/organizations?checkout=${requestId}`, admin);
    expect(returned.body).toContain(escapeHtml(orgWords("org.checkout.completed")));
    expect(returned.body).toContain(`href="/organizations/${id}"`);
    const overview = await page(`/organizations/${id}`, admin);
    expect(overview.status).toBe(200);
    expect(overview.body).toMatch(/org__stat-value">3<\/span><span class="org__stat-label">Paid/u);
    expect(overview.body).toContain(escapeHtml(orgWords("org.billing.active")));
    const billingPath = `/organizations/${id}/billing`;
    expect((await post(billingPath, admin, {}, publicOrigin.origin)).status).toBe(403);
    expect((await post(billingPath, admin, {}, null)).status).toBe(403);
    expect(stripe.portal).not.toHaveBeenCalled();
    const billing = await post(billingPath, admin, {});
    expect(billing.status).toBe(303);
    expect(billing.headers.get("location")).toBe(billingUrl);
    expect(stripe.portal).toHaveBeenCalledWith(
      expect.stringMatching(/^cus_/u),
      organizationsUrl,
      "bpc_org",
    );
  });

  it("changes seats: an increase waits for the provider, a decrease below assigned is refused", async () => {
    const { admin, id } = await organization(2);
    const member = await join(admin, id, "Mia Member");
    await assign(admin, id, member);
    const invalid = await post(`/organizations/${id}/seats`, admin, {
      requestId: randomUUID(),
      seats: "0",
    });
    expect(invalid.status).toBe(400);
    const more = await post(`/organizations/${id}/seats`, admin, {
      requestId: randomUUID(),
      seats: "5",
    });
    expect(more.status).toBe(303);
    expect(stripe.updateSeatQuantity).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 5, increase: true }),
    );
    const shown = await page(`/organizations/${id}`, admin);
    expect(shown.body).toContain(escapeHtml(orgWords("org.seats.pendingDetail", { seats: 5 })));
    expect(shown.body).toMatch(/org__stat-value">2<\/span><span class="org__stat-label">Paid/u);
    const another = await post(`/organizations/${id}/seats`, admin, {
      requestId: randomUUID(),
      seats: "6",
    });
    expect(another.status).toBe(409);
    expect(another.body).toContain("A seat change is already pending");
  });

  it("links the pending invoice, abandons it after Stripe confirms, and remembers the request", async () => {
    const { admin, id } = await organization(1);
    const requestId = randomUUID();
    const url = `/organizations/${id}`;
    const invoiceUrl = "https://invoices.stripe.example.test/pending";
    stripe.updateSeatQuantity.mockImplementationOnce(async ({ subscription }) => {
      const updated: StripeSubscription = {
        ...subscriptions.get(subscription)!,
        pending_update: { expires_at: Math.floor(Date.now() / 1000) + 300 },
        latest_invoice: {
          id: "in_seat_change",
          status: "open",
          attempt_count: 1,
          hosted_invoice_url: invoiceUrl,
          billing_reason: "subscription_update",
        },
      };
      subscriptions.set(subscription, updated);
      return updated;
    });
    expect((await post(`${url}/seats`, admin, { requestId, seats: "2" })).status).toBe(303);
    expect((await page(url, admin)).body).toContain(`href="${invoiceUrl}"`);
    expect((await post(`${url}/seats/abandon`, admin, { requestId })).status).toBe(303);
    expect(stripe.voidInvoice).toHaveBeenCalledWith("in_seat_change");
    expect((await organizations.admin(id, admin.id)).pendingSeatChange).toBeNull();
    expect((await post(`${url}/seats`, admin, { requestId, seats: "2" })).status).toBe(303);
    expect((await post(`${url}/seats`, admin, { requestId, seats: "3" })).status).toBe(409);
    expect(stripe.updateSeatQuantity).toHaveBeenCalledOnce();
  });

  it("restores a canceled subscription on the same organization and confirms explicit closure", async () => {
    const { admin, id } = await organization(1);
    const old = await database
      .selectFrom("organizations")
      .select("stripeSubscriptionId")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    await stripe.cancel(old.stripeSubscriptionId);
    const onError = vi.fn();
    await cloud.reconcileBilling(onError);
    expect(onError).not.toHaveBeenCalled();
    const url = `/organizations/${id}`;
    expect((await page(url, admin)).body).toContain(escapeHtml(orgWords("org.billing.restore")));
    const requestId = randomUUID();
    expect((await post(`${url}/billing/restore`, admin, { requestId })).status).toBe(303);
    expect(await completeOrganization(admin, requestId, 1)).toBe(id);
    expect((await organizations.mine(admin.id)).organizations.map((row) => row.id)).toEqual([id]);
    expect((await organizations.admin(id, admin.id)).billingStatus).toBe("active");
    expect((await post(`${url}/close`, admin, {})).status).toBe(303);
    const closed = await organizations.admin(id, admin.id);
    expect(closed.closedAt).toEqual(expect.any(String));
    expect(closed.seats.free).toBe(0);
    expect((await post(`${url}/billing/restore`, admin, { requestId: randomUUID() })).status).toBe(
      409,
    );
  });

  it("refuses to go below the seats already assigned", async () => {
    const { admin, id } = await organization(2);
    await assign(admin, id, await join(admin, id, "Mia Member"));
    await assign(admin, id, await join(admin, id, "Max Member"));
    const refused = await post(`/organizations/${id}/seats`, admin, {
      requestId: randomUUID(),
      seats: "1",
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toContain("Offboard work Homes before reducing seats.");
  });

  it("invites by email; only the invited, verified address can accept", async () => {
    const { admin, id } = await organization(1);
    const invitee = await signIn("Ivy Invitee");
    const stranger = await signIn("Sam Stranger");
    const invited = await post(`/organizations/${id}/invitations`, admin, {
      email: invitee.email,
      role: "member",
    });
    expect(invited.status).toBe(303);
    const target = `/organizations/${id}/people`;
    expect(invited.headers.get("location")).toBe(target);
    const forged = await page(`${target}?done=invited`, admin);
    expect(forged.body).not.toContain(escapeHtml(orgWords("org.done.invited")));
    const flash = invited.headers
      .get("set-cookie")
      ?.match(/__Host-opensteer\.organization-flash=[^;,]+/u)?.[0];
    expect(flash).toBeDefined();
    const people = await page(target, { cookie: `${admin.cookie}; ${flash}` });
    const link = new RegExp(
      `${portalOrigin.origin}(/organizations/invitations/oi_[0-9a-f-]+)`,
      "u",
    ).exec(people.body)?.[1];
    expect(link).toBeDefined();
    expect(people.body).toContain(escapeHtml(orgWords("org.done.invited")));

    const strangerView = await page(link!, stranger);
    expect(strangerView.status).toBe(404);
    expect(strangerView.body).toContain(escapeHtml(orgWords("org.invite.wrongEmail")));
    const wrong = await post(`${link}/accept`, stranger, {});
    expect(wrong.status).toBe(403);
    expect(wrong.body).toContain(escapeHtml(orgWords("org.invite.wrongEmail")));

    await database
      .updateTable("users")
      .where("id", "=", invitee.id)
      .set({ emailVerified: false })
      .executeTakeFirstOrThrow();
    expect((await post(`${link}/accept`, invitee, {})).status).toBe(403);
    await database
      .updateTable("users")
      .where("id", "=", invitee.id)
      .set({ emailVerified: true })
      .executeTakeFirstOrThrow();
    const own = await page(link!, invitee);
    expect(own.status).toBe(200);
    expect(own.body).toContain(escapeHtml(orgWords("org.invite.lead")));
    const accepted = await post(`${link}/accept`, invitee, {});
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/organizations");
    const mine = await page("/organizations", invitee);
    expect(mine.body).toContain("Acme");
    expect(mine.body).toContain(escapeHtml(orgWords("org.role.member")));
    const again = await post(`${link}/accept`, invitee, {});
    expect(again.status).toBe(409);
  });

  it("keeps the last admin and anyone with a live work Home", async () => {
    const { admin, id } = await organization(1);
    const member = await join(admin, id, "Mia Member");
    const lastAdmin = await post(`/organizations/${id}/members`, admin, {
      accountId: admin.id,
      action: "member",
    });
    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.body).toContain("The last organization admin must stay an admin");
    await assign(admin, id, member);
    const live = await post(`/organizations/${id}/members`, admin, {
      accountId: member.id,
      action: "remove",
    });
    expect(live.status).toBe(409);
    expect(live.body).toContain("Offboard the member’s work Home before removing them.");
    expect(
      (await post(`/organizations/${id}/members`, admin, { accountId: member.id, action: "admin" }))
        .status,
    ).toBe(303);
    expect((await page(`/organizations/${id}/people`, admin)).body).toContain(
      escapeHtml(orgWords("org.people.makeMember")),
    );
  });

  it("refuses a non-admin on every admin page and action", async () => {
    const { admin, id } = await organization(1);
    const member = await join(admin, id, "Mia Member");
    const assignment = await assign(admin, id, member);
    const stranger = await signIn("Stranger");
    for (const path of [
      `/organizations/${id}`,
      `/organizations/${id}/people`,
      `/organizations/${id}/work-homes`,
      `/organizations/${id}/policy`,
      `/organizations/${id}/audit`,
      `/organizations/${id}/audit/${assignment}/export.jsonl`,
    ]) {
      for (const caller of [member, stranger]) {
        const response = await page(path, caller);
        expect(response.status, path).toBe(403);
        expect(response.body, path).toContain("Organization access is not allowed");
      }
    }
    for (const [path, fields] of [
      [`/organizations/${id}/billing`, {}],
      [`/organizations/${id}/billing/restore`, { requestId: randomUUID() }],
      [`/organizations/${id}/seats/abandon`, { requestId: randomUUID() }],
      [`/organizations/${id}/close`, {}],
      [`/organizations/${id}/seats`, { requestId: randomUUID(), seats: "4" }],
      [`/organizations/${id}/invitations`, { email: "x@example.test", role: "admin" }],
      [`/organizations/${id}/members`, { accountId: admin.id, action: "remove" }],
      [`/organizations/${id}/work-homes`, { requestId: randomUUID(), accountId: member.id }],
      [`/organizations/${id}/work-homes/${assignment}/offboard`, { retentionSeconds: "0" }],
      [
        `/organizations/${id}/policy`,
        {
          expectedRevision: "1",
          externalMaxMode: "full-access",
          allowTasks: "on",
          allowEverything: "on",
          devices: "assignee-may-enroll",
        },
      ],
    ] as const) {
      for (const caller of [member, stranger]) {
        const response = await post(path, caller, fields);
        expect(response.status, path).toBe(403);
        expect(response.body, path).toContain("Organization access is not allowed");
      }
    }
    const after = await organizations.admin(id, admin.id);
    expect(after.policyRevision).toBe(1);
    expect(after.assignments.map(({ state }) => state)).toEqual(["active"]);
    expect(stripe.updateSeatQuantity).not.toHaveBeenCalled();
  });

  it("changes the policy against the revision the admin saw", async () => {
    const { admin, id } = await organization(1);
    await assign(admin, id, await join(admin, id, "Mia Member"));
    const saved = await post(`/organizations/${id}/policy`, admin, {
      expectedRevision: "1",
      externalMaxMode: "auto",
      allowTasks: "on",
      devices: "assignee-may-enroll",
    });
    expect(saved.status).toBe(303);
    const shown = await page(`/organizations/${id}/policy`, admin);
    expect(shown.body).toContain("Version 2");
    expect(shown.body).toContain("Most a connected agent may do on its own");
    expect(shown.body).toContain('<option value="auto" selected>');
    expect(shown.body).toMatch(/name="allowTasks" value="on" checked/u);
    expect(shown.body).not.toMatch(/name="allowEverything" value="on" checked/u);
    expect(shown.body).toContain(
      escapeHtml(orgWords("org.policy.homes", { applied: 0, total: 1 })),
    );
    expect(shown.body).toContain(
      escapeHtml(orgWords("org.policy.pending", { revision: 2, applied: 0 })),
    );
    const stale = await post(`/organizations/${id}/policy`, admin, {
      expectedRevision: "1",
      externalMaxMode: "full-access",
      devices: "cloud-computer-only",
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toContain("Organization policy changed");
    expect((await organizations.admin(id, admin.id)).policy).toEqual({
      externalMaxMode: "auto",
      allowTasks: true,
      allowEverything: false,
      devices: "assignee-may-enroll",
    });
  });

  it("offboards with each retention choice and shows each step's real status", async () => {
    const { admin, id } = await organization(4);
    const choices = [0, 7, 30, 90] as const;
    const assignments: string[] = [];
    for (const [index] of choices.entries())
      assignments.push(await assign(admin, id, await join(admin, id, `Person ${index}`)));
    for (const [index, days] of choices.entries()) {
      const done = await post(
        `/organizations/${id}/work-homes/${assignments[index]}/offboard`,
        admin,
        {
          retentionSeconds: String(days * 86_400),
        },
      );
      expect(done.status).toBe(303);
    }
    const invalid = await post(
      `/organizations/${id}/work-homes/${assignments[0]}/offboard`,
      admin,
      {
        retentionSeconds: "12345",
      },
    );
    expect(invalid.status).toBe(400);
    const onOffboardingError = vi.fn();
    await organizations.reconcileOffboarding(onOffboardingError);
    expect(onOffboardingError).not.toHaveBeenCalled();
    const rows = await database
      .selectFrom("workAssignments")
      .selectAll()
      .where("organizationId", "=", id)
      .execute();
    for (const [index, days] of choices.entries()) {
      const row = rows.find(({ id: assignment }) => assignment === assignments[index])!;
      expect(row.state).toBe("offboarding");
      expect(row.offboardingCheckedAt).not.toBeNull();
      expect(row.signInCutAt).not.toBeNull();
      expect(row.retainUntil).toBeNull();
      expect(row.retentionSeconds).toBe(days * 86_400);
    }
    const shown = await page(`/organizations/${id}/work-homes`, admin);
    expect(shown.body).toContain(escapeHtml(orgWords("org.offboard.cut")));
    expect(shown.body).toContain(escapeHtml(orgWords("org.offboard.retainPending")));
    expect(shown.body).toContain(escapeHtml(orgWords("org.audit.finalUnconfirmed")));
    expect(shown.body).not.toContain(escapeHtml(orgWords("org.offboard.deletesNow")));
    expect(shown.body).not.toContain(`/work-homes/${assignments[0]}/offboard`);
    const first = rows.find(({ id: assignment }) => assignment === assignments[0])!;
    const employee = await page("/cloud-computer", (await personOf(first.assigneeAccountId!))!);
    expect(employee.body).toContain(escapeHtml(orgWords("org.status.signInCut")));
  });

  it("lists the audit record with its gap and downloads it as JSONL", async () => {
    const { admin, id } = await organization(1);
    const assignment = await assign(admin, id, await join(admin, id, "Mia Member"));
    const receivedAt = new Date("2026-11-20T10:00:00.000Z");
    await database
      .insertInto("workAuditRecords")
      .values(
        [1, 2].map((sequence) => ({
          assignmentId: assignment,
          sequence,
          canonicalRecord: JSON.stringify({ at: receivedAt.toISOString(), kind: "stop", sequence }),
          hash: String(sequence).repeat(64),
          receivedAt,
        })),
      )
      .execute();
    await database
      .updateTable("workAssignments")
      .where("id", "=", assignment)
      .set({
        auditSequence: 2,
        auditReceivedAt: receivedAt,
        auditGapExpected: 3,
        auditGapReceived: 5,
        auditGapThrough: 7,
      })
      .execute();
    const shown = await page(`/organizations/${id}/audit`, admin);
    expect(shown.body).toContain(
      escapeHtml(orgWords("org.audit.gap", { expected: 3, received: 5 })),
    );
    expect(shown.body).toContain(
      escapeHtml(
        orgWords("org.audit.last", { sequence: 2, at: organizationTime(receivedAt.toISOString()) }),
      ),
    );
    expect(shown.body).toContain("Screenshots");
    expect(shown.body).toContain("A connected agent started working");
    expect(shown.body).toContain("A policy version was applied");
    expect(shown.body).not.toContain("agentSessionId");
    expect(shown.body).not.toContain("grantRevision");
    const download = await page(`/organizations/${id}/audit/${assignment}/export.jsonl`, admin);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/x-ndjson");
    expect(download.headers.get("x-opensteer-audit-gap-expected")).toBe("3");
    expect(download.headers.get("x-opensteer-audit-gap-received")).toBe("5");
    expect(
      download.body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).sequence),
    ).toEqual([1, 2]);
  });

  it("shows a person their work Home, their own Cloud Computer, both, or neither", async () => {
    const { admin, id } = await organization(1);
    const neither = await signIn("Nia Neither");
    const plain = await page("/cloud-computer", neither);
    expect(plain.body).not.toContain('<section class="cloud-computer__work"');
    expect(plain.body).toContain('href="/cloud-computer/checkout"');

    const member = await join(admin, id, "Mia Member");
    await assign(admin, id, member);
    const work = await page("/cloud-computer", member);
    expect(work.body).toContain(escapeHtml(orgWords("org.work.title", { organization: "Acme" })));
    expect(work.body).toContain(escapeHtml(orgWords("org.work.badge", { organization: "Acme" })));
    expect(work.body).toContain(escapeHtml(orgWords("org.work.managed", { organization: "Acme" })));
    expect(work.body).toContain(escapeHtml(orgWords("org.policy.devices.cloud-computer-only")));
    expect(work.body).toContain(escapeHtml(cloudWords("cloud.web.personal")));
    expect(work.body).toContain('href="/cloud-computer/checkout"');
    expect(work.headers.get("refresh")).toBe("5");
    const start = work.body.indexOf('<section class="cloud-computer__work"');
    expect(start).toBeGreaterThan(0);
    const workSection = work.body.slice(start, work.body.indexOf("</section>", start));
    expect(workSection).not.toContain("/cloud-computer/suspend");
    expect(workSection).not.toContain("/cloud-computer/delete");
    expect(workSection).not.toContain("/cloud-computer/billing");

    await buyPersonal(member);
    const both = await page("/cloud-computer", member);
    expect(both.body).toContain(escapeHtml(cloudWords("cloud.preparing.title")));
    expect(both.body).toContain(escapeHtml(orgWords("org.work.title", { organization: "Acme" })));
  });

  async function organization(seats: number) {
    const admin = await signIn("Ada Admin");
    const requestId = randomUUID();
    expect(
      (await post("/organizations/new", admin, { requestId, name: "Acme", seats: String(seats) }))
        .status,
    ).toBe(303);
    return { admin, id: await completeOrganization(admin, requestId, seats) };
  }

  async function completeOrganization(admin: Person, requestId: string, seats: number) {
    const submitted = stripe.checkout.mock.calls.findLast(
      ([input]) => input.requestId === requestId,
    )?.[0];
    const id = submitted!.organization!.id as OrganizationId;
    const key = requestId.replaceAll("-", "");
    const metadata = { account_id: admin.id, request_id: requestId, organization_id: id };
    const subscription = `sub_${key}`;
    subscriptions.set(subscription, {
      id: subscription,
      customer: `cus_${key}`,
      status: "active",
      latest_invoice: { status: "paid", attempt_count: 1 },
      metadata,
      items: {
        has_more: false,
        data: [{ id: "si_seat", quantity: seats, price: { id: "price_seat", currency: "usd" } }],
      },
    });
    await webhook({
      id: `cs_test_${key}`,
      mode: "subscription",
      client_reference_id: admin.id,
      metadata,
      subscription,
      customer: `cus_${key}`,
      payment_status: "paid",
      currency: "usd",
    });
    return id;
  }

  async function buyPersonal(person: Person) {
    const requestId = randomUUID();
    await cloud.checkout(person.id, requestId);
    const key = requestId.replaceAll("-", "");
    const metadata = { account_id: person.id, request_id: requestId };
    const subscription = `sub_${key}`;
    subscriptions.set(subscription, {
      id: subscription,
      customer: `cus_${key}`,
      status: "active",
      latest_invoice: { status: "paid", attempt_count: 1 },
      metadata,
      items: {
        has_more: false,
        data: [{ quantity: 1, price: { id: "price_1", currency: "usd" } }],
      },
    });
    await webhook({
      id: `cs_test_${key}`,
      mode: "subscription",
      client_reference_id: person.id,
      metadata,
      subscription,
      customer: `cus_${key}`,
      payment_status: "paid",
      currency: "usd",
    });
  }

  async function join(admin: Person, id: OrganizationId, name: string) {
    const person = await signIn(name);
    expect(
      (
        await post(`/organizations/${id}/invitations`, admin, {
          email: person.email,
          role: "member",
        })
      ).status,
    ).toBe(303);
    const [invite] = (await organizations.mine(person.id)).invitations;
    expect((await post(`/organizations/invitations/${invite!.id}/accept`, person, {})).status).toBe(
      303,
    );
    return person;
  }

  async function assign(admin: Person, id: OrganizationId, person: Person) {
    const assigned = await post(`/organizations/${id}/work-homes`, admin, {
      requestId: randomUUID(),
      accountId: person.id,
    });
    expect(assigned.status, assigned.body).toBe(303);
    const row = await database
      .selectFrom("workAssignments")
      .select("id")
      .where("organizationId", "=", id)
      .where("assigneeAccountId", "=", person.id)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const people = new Map<string, Person>();
  async function personOf(id: string) {
    return people.get(id);
  }

  async function signIn(displayName: string): Promise<Person> {
    const id = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    const email = `${id}@example.test`;
    const now = new Date();
    await database
      .insertInto("users")
      .values({
        id,
        displayName,
        email,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    const session = await (await auth.$context).internalAdapter.createSession(id);
    const created = await portalSessions.create({ accountId: id, accountSessionId: session.id });
    const person = {
      id,
      email,
      cookie: `__Host-opensteer.portal=${encodeURIComponent(created.token)}`,
    };
    people.set(id, person);
    return person;
  }

  async function webhook(object: unknown) {
    const body = JSON.stringify({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      type: "checkout.session.completed",
      data: { object },
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
  }

  function page(path: string, as?: { readonly cookie: string }) {
    return send("GET", path, { host: portalOrigin.host, ...(as ? { cookie: as.cookie } : {}) });
  }

  function post(
    path: string,
    as: { readonly cookie: string },
    fields: Record<string, string>,
    origin: string | null = portalOrigin.origin,
  ) {
    return send(
      "POST",
      path,
      {
        host: portalOrigin.host,
        ...(origin === null ? {} : { origin }),
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
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: {
                get: (name) => {
                  const found = response.headers[name.toLowerCase()];
                  return found === undefined ? null : String(found);
                },
              },
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }
});
