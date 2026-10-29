import {
  ControlPlaneAccountIdSchema,
  HostNotificationPublicationSchema,
  type ControlPlaneAccountId,
  type HostNotificationPublication,
} from "@opensteer/control-plane-protocol";
import {
  createId,
  notificationExpiryMilliseconds,
  type DeploymentId,
  type HostInstanceId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHostCredential, hashCredential } from "../auth/credentials.js";
import { CONTROL_PLANE_BASELINE_SCHEMA_SQL } from "../database/baseline-schema.js";
import { createControlPlaneDatabase } from "../database/database.js";
import {
  migrateControlPlaneToLatest,
  notificationDeviceEnvironmentMigration,
  notificationsMigration,
  replyNotificationMigration,
  reportNotificationMigration,
} from "../database/migrations.js";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneStore } from "../database/store.js";
import {
  NotificationDeliveryWorker,
  type NotificationDeliveryWorkerStore,
  type PushSender,
} from "./notification-delivery-worker.js";
import { ControlPlaneNotificationStore } from "./notification-store.js";
import { NotificationTokenCipher } from "./notification-token-cipher.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const publicOrigin = new URL("https://accounts.notifications.opensteer.invalid");
const authSecret = "notification-control-plane-secret-at-least-32";

function accountId(): ControlPlaneAccountId {
  return ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
}

integration("control-plane notification boundary", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 4,
  });
  const store = new ControlPlaneStore(database, publicOrigin, {
    managedDeploymentDomain: "connect.notifications.opensteer.invalid",
  });
  const cipher = new NotificationTokenCipher(authSecret);
  let now = new Date("2026-09-14T12:00:00.000Z");
  const notifications = new ControlPlaneNotificationStore(database, {
    cipher,
    now: () => now,
  });
  const ownerId = accountId();
  const memberId = accountId();
  const outsiderId = accountId();
  const deploymentId: DeploymentId = createId("deployment");
  const otherDeploymentId: DeploymentId = createId("deployment");
  const hostInstanceId: HostInstanceId = createId("hostInstance");
  const otherHostInstanceId: HostInstanceId = createId("hostInstance");
  let hostCredential = "";
  let otherHostCredential = "";

  async function insertDeployment(input: {
    readonly credential: string;
    readonly fingerprint: string;
    readonly hostInstanceId: HostInstanceId;
    readonly id: DeploymentId;
  }): Promise<void> {
    const createdAt = new Date();
    await database
      .insertInto("deployments")
      .values({
        accountLink: null,
        activeHostInstanceId: input.hostInstanceId,
        authorityEnvelope: null,
        canonicalOrigin: `https://${input.id}.opensteer.invalid`,
        createdAt,
        directoryGeneration: 1,
        hostKeyFingerprint: input.fingerprint,
        id: input.id,
        lifecycle: "active",
        name: "Notification fixture",
        oidcClientId: null,
        ownerAccountId: ownerId,
        reachability: "canonical",
        updatedAt: createdAt,
      })
      .execute();
    await database
      .insertInto("deploymentCredentials")
      .values({
        createdAt,
        deploymentId: input.id,
        rotatedAt: createdAt,
        tokenHash: hashCredential(input.credential),
      })
      .execute();
  }

  function publication(
    overrides: Partial<HostNotificationPublication> = {},
  ): HostNotificationPublication {
    return HostNotificationPublicationSchema.parse({
      deploymentId,
      eventId: createId("event"),
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      hostInstanceId,
      kind: "request-opened",
      notificationId: createId("notification"),
      occurredAt: now.toISOString(),
      recipientAccountIds: [ownerId],
      requestId: createId("request"),
      runId: null,
      schemaVersion: 1,
      sequence: "42",
      threadId: createId("thread"),
      workspaceId: createId("workspace"),
      ...overrides,
    });
  }

  async function registerPhone(input: {
    readonly accountId: ControlPlaneAccountId;
    readonly apsEnvironment?: "development" | "production";
    readonly approvalsEnabled?: boolean;
    readonly installationId?: string;
    readonly runOutcomesEnabled?: boolean;
    readonly token?: string;
  }) {
    return notifications.registerDevice({
      accountId: input.accountId,
      approvalsEnabled: input.approvalsEnabled ?? true,
      installationId: input.installationId ?? `install-${crypto.randomUUID()}`,
      platform: "ios",
      apsEnvironment: input.apsEnvironment ?? "development",
      runOutcomesEnabled: input.runOutcomesEnabled ?? true,
      token: input.token ?? crypto.randomUUID().replaceAll("-", "").repeat(2),
    });
  }

  /** A publication with the day-long window Hosts from Host API epoch 30 send. */
  function reply(
    overrides: Partial<HostNotificationPublication> = {},
  ): HostNotificationPublication {
    return publication({
      expiresAt: new Date(now.getTime() + notificationExpiryMilliseconds).toISOString(),
      kind: "reply-published",
      messageId: createId("message"),
      requestId: null,
      runId: createId("run"),
      ...overrides,
    });
  }

  /**
   * Runs the real delivery worker over the real ledger once, with a sender in
   * place of Apple and Google, and answers with what the phone would be sent.
   */
  async function sendDue(): Promise<Parameters<PushSender>[0][]> {
    const sent: Parameters<PushSender>[0][] = [];
    const sender: PushSender = async (input) => {
      sent.push(input);
      return { outcome: "accepted", status: "delivered" };
    };
    const store: NotificationDeliveryWorkerStore = {
      claimDueDeliveries: () => notifications.claimDueDeliveries({ now }),
      disableDevice: (input) => notifications.disableDevice(input),
      pruneSettled: (input) => notifications.pruneSettled(input),
      renewDeliveryLease: (input) => notifications.renewDeliveryLease(input),
      retryDelivery: (input) => notifications.retryDelivery(input),
      settleDelivery: (input) => notifications.settleDelivery(input),
    };
    await new NotificationDeliveryWorker({
      now: () => now,
      onSettledFailure: () => undefined,
      onError: (error) => {
        throw error;
      },
      senders: { android: sender, ios: sender },
      store,
    }).deliverOnce();
    return sent;
  }

  /** Every delivery's outcome, by the publication it came from. */
  async function ledger(): Promise<
    Readonly<Record<string, { readonly providerOutcome: string | null; readonly status: string }>>
  > {
    const rows = await database
      .selectFrom("notificationDeliveries")
      .select(["notificationId", "providerOutcome", "status"])
      .execute();
    return Object.fromEntries(
      rows.map((row) => [
        row.notificationId,
        { providerOutcome: row.providerOutcome, status: row.status },
      ]),
    );
  }

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
  });

  beforeEach(async () => {
    now = new Date("2026-09-14T12:00:00.000Z");
    hostCredential = createHostCredential();
    otherHostCredential = createHostCredential();
    await sql`
      truncate table
        notification_publications,
        notification_deliveries,
        notification_devices,
        deployment_directory_entries,
        deployment_credentials,
        deployments,
        users
      cascade
    `.execute(database);
    const createdAt = new Date();
    await database
      .insertInto("users")
      .values(
        [ownerId, memberId, outsiderId].map((id) => ({
          createdAt,
          displayName: "Person",
          email: `${id}@example.test`,
          emailVerified: true,
          id,
          image: null,
          updatedAt: createdAt,
        })),
      )
      .execute();
    await insertDeployment({
      credential: hostCredential,
      fingerprint: `sha256:${"f".repeat(43)}`,
      hostInstanceId,
      id: deploymentId,
    });
    await insertDeployment({
      credential: otherHostCredential,
      fingerprint: `sha256:${"g".repeat(43)}`,
      hostInstanceId: otherHostInstanceId,
      id: otherDeploymentId,
    });
    await database
      .insertInto("deploymentDirectoryEntries")
      .values({
        accountId: memberId,
        deploymentId,
        generation: 1,
        observedAt: createdAt,
        present: true,
        updatedAt: createdAt,
      })
      .execute();
  });

  afterAll(async () => {
    await database.destroy();
  });

  it("registers, lists and unregisters one install without exposing its token", async () => {
    const token = "t".repeat(64);
    const registered = await registerPhone({
      accountId: ownerId,
      installationId: "install-alpha-0001",
      token,
    });

    expect(registered).toEqual({
      approvalsEnabled: true,
      installationId: "install-alpha-0001",
      lastSeenAt: now.toISOString(),
      platform: "ios",
      registeredAt: now.toISOString(),
      runOutcomesEnabled: true,
      updatedAt: now.toISOString(),
    });
    await expect(notifications.listDevices(ownerId)).resolves.toEqual([registered]);
    const stored = await database
      .selectFrom("notificationDevices")
      .select(["tokenCiphertext", "tokenHash"])
      .executeTakeFirstOrThrow();
    expect(stored.tokenCiphertext).not.toContain(token);
    expect(stored.tokenHash).not.toContain(token);
    expect(cipher.open(ownerId, stored.tokenCiphertext)).toBe(token);

    await expect(
      notifications.unregisterDevice({ accountId: ownerId, installationId: "install-alpha-0001" }),
    ).resolves.toBe(true);
    await expect(notifications.listDevices(ownerId)).resolves.toEqual([]);
  });

  it("keeps one row per install when the operating system rotates the token", async () => {
    await registerPhone({
      accountId: ownerId,
      installationId: "install-alpha-0001",
      token: "t".repeat(64),
    });
    now = new Date("2026-09-14T13:00:00.000Z");
    await registerPhone({
      accountId: ownerId,
      approvalsEnabled: false,
      installationId: "install-alpha-0001",
      token: "u".repeat(64),
    });

    const rows = await database
      .selectFrom("notificationDevices")
      .select(["approvalsEnabled", "installationId", "tokenCiphertext"])
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.approvalsEnabled).toBe(false);
    expect(cipher.open(ownerId, rows[0]?.tokenCiphertext ?? "")).toBe("u".repeat(64));
  });

  it("moves a token that now belongs to another install", async () => {
    const token = "s".repeat(64);
    await registerPhone({ accountId: ownerId, installationId: "install-alpha-0001", token });
    await registerPhone({ accountId: memberId, installationId: "install-beta-00001", token });

    const rows = await database
      .selectFrom("notificationDevices")
      .select(["accountId", "installationId"])
      .execute();
    expect(rows).toEqual([{ accountId: memberId, installationId: "install-beta-00001" }]);
  });

  it("turns one publication into a delivery for every reachable Account's phone", async () => {
    const owner = await registerPhone({ accountId: ownerId });
    const member = await registerPhone({ accountId: memberId });
    await registerPhone({ accountId: outsiderId });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);

    const accepted = await notifications.ingest(
      authority,
      publication({ recipientAccountIds: [ownerId, memberId, outsiderId] }),
    );

    expect(accepted).toEqual({ deliveries: 2 });
    const delivered = await database
      .selectFrom("notificationDeliveries")
      .innerJoin("notificationDevices", "notificationDevices.id", "notificationDeliveries.deviceId")
      .select(["notificationDevices.accountId as accountId"])
      .orderBy("notificationDevices.accountId")
      .execute();
    expect(new Set(delivered.map((row) => row.accountId))).toEqual(new Set([ownerId, memberId]));
    expect([owner.installationId, member.installationId]).toHaveLength(2);
  });

  it("delivers a reply published with a day-long window, worded and anchored for the phone", async () => {
    await registerPhone({ accountId: ownerId, token: "r".repeat(64) });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    const published = reply();

    await expect(notifications.ingest(authority, published)).resolves.toEqual({ deliveries: 1 });
    await expect(sendDue()).resolves.toEqual([
      {
        apsEnvironment: "development",
        expiresAt: new Date(now.getTime() + notificationExpiryMilliseconds),
        message: {
          body: "Opensteer replied",
          data: {
            deepLink: `com.opensteer.mobile:/deployments/${deploymentId}/threads/${published.threadId}?messageId=${published.messageId}`,
            deploymentId,
            kind: "reply-published",
            messageId: published.messageId,
            threadId: published.threadId,
          },
          title: "Opensteer",
        },
        collapseKey: `${published.threadId}:reply-published`,
        token: "r".repeat(64),
      },
    ]);
    await expect(ledger()).resolves.toEqual({
      [published.notificationId]: { providerOutcome: "accepted", status: "delivered" },
    });
  });

  it.each([
    ["run-completed", "A run finished", false],
    ["run-interrupted", "A run was stopped", false],
    ["report-published", "An agent shared an update", true],
  ] as const)(
    "still delivers %s from a Host that predates replies, in its own words",
    async (kind, body, anchored) => {
      await registerPhone({ accountId: ownerId });
      const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
      const messageId = createId("message");
      // Exactly what a Host before Host API epoch 30 sends: a two-minute window.
      const published = publication({
        expiresAt: new Date(now.getTime() + 120_000).toISOString(),
        kind,
        ...(anchored ? { messageId } : {}),
        requestId: null,
        runId: anchored ? null : createId("run"),
      });

      await expect(notifications.ingest(authority, published)).resolves.toEqual({
        deliveries: 1,
      });
      const [sent, ...rest] = await sendDue();
      expect(rest).toEqual([]);
      expect(sent?.expiresAt).toEqual(new Date(now.getTime() + 120_000));
      expect(sent?.message).toMatchObject({ body, data: { kind }, title: "Opensteer" });
      const thread = `com.opensteer.mobile:/deployments/${deploymentId}/threads/${published.threadId}`;
      expect(sent?.message.data.deepLink).toBe(
        anchored ? `${thread}?messageId=${messageId}` : thread,
      );
    },
  );

  it("refuses a Host publishing for a Deployment or Host instance that is not its own", async () => {
    await registerPhone({ accountId: ownerId });
    const authority = await store.authenticateHostCredential(`Bearer ${otherHostCredential}`);

    await expect(notifications.ingest(authority, publication())).rejects.toThrow(
      /fence does not match/iu,
    );
    await expect(
      notifications.ingest(
        await store.authenticateHostCredential(`Bearer ${hostCredential}`),
        publication({ hostInstanceId: otherHostInstanceId }),
      ),
    ).rejects.toThrow(/fence does not match/iu);
  });

  it("alerts approval devices to Requests and outcome devices to everything else", async () => {
    await registerPhone({
      accountId: ownerId,
      approvalsEnabled: true,
      installationId: "install-approvals1",
      runOutcomesEnabled: false,
    });
    await registerPhone({
      accountId: ownerId,
      approvalsEnabled: false,
      installationId: "install-outcomes01",
      runOutcomesEnabled: true,
    });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    const reached = async (published: HostNotificationPublication) => {
      await expect(notifications.ingest(authority, published)).resolves.toEqual({
        deliveries: 1,
      });
      const row = await database
        .selectFrom("notificationDeliveries")
        .innerJoin(
          "notificationDevices",
          "notificationDevices.id",
          "notificationDeliveries.deviceId",
        )
        .select("notificationDevices.installationId as installationId")
        .where("notificationDeliveries.notificationId", "=", published.notificationId)
        .executeTakeFirstOrThrow();
      return row.installationId;
    };

    await expect(reached(publication())).resolves.toBe("install-approvals1");
    await expect(reached(reply())).resolves.toBe("install-outcomes01");
    await expect(reached(reply({ kind: "run-failed", messageId: null }))).resolves.toBe(
      "install-outcomes01",
    );
    await expect(
      reached(publication({ kind: "run-completed", requestId: null, runId: createId("run") })),
    ).resolves.toBe("install-outcomes01");
  });

  it("drops a publication whose freshness window has already closed", async () => {
    await registerPhone({ accountId: ownerId });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);

    // A well-formed publication that simply arrived late: its own two-minute
    // window opened and closed before the Account saw it.
    const occurredAt = new Date(now.getTime() - 10 * 60_000);
    await expect(
      notifications.ingest(
        authority,
        publication({
          expiresAt: new Date(occurredAt.getTime() + 120_000).toISOString(),
          occurredAt: occurredAt.toISOString(),
        }),
      ),
    ).resolves.toEqual({ deliveries: 0 });
    await expect(
      database.selectFrom("notificationDeliveries").selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it("answers a replayed publication with what it already became", async () => {
    await registerPhone({ accountId: ownerId });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    const replayed = publication();

    await expect(notifications.ingest(authority, replayed)).resolves.toEqual({ deliveries: 1 });
    await expect(notifications.ingest(authority, replayed)).resolves.toEqual({ deliveries: 1 });
    // A replay is answered from the receipt alone: it neither adds a delivery
    // nor supersedes the one it already became.
    await expect(ledger()).resolves.toEqual({
      [replayed.notificationId]: { providerOutcome: null, status: "pending" },
    });
  });

  it("keeps two publications for one Thread and kind and deduplicates concurrent replays", async () => {
    await registerPhone({ accountId: ownerId });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    const first = reply();
    const second = reply({ threadId: first.threadId });
    await expect(
      Promise.all([
        notifications.ingest(authority, first),
        notifications.ingest(authority, second),
        notifications.ingest(authority, first),
      ]),
    ).resolves.toEqual([{ deliveries: 1 }, { deliveries: 1 }, { deliveries: 1 }]);
    await expect(ledger()).resolves.toEqual({
      [first.notificationId]: { providerOutcome: null, status: "pending" },
      [second.notificationId]: { providerOutcome: null, status: "pending" },
    });
    expect((await sendDue()).map((sent) => sent.message.data.messageId).sort()).toEqual(
      [first.messageId, second.messageId].sort(),
    );
  });

  it.each(["development", "production"] as const)(
    "stores and claims the %s APNs environment",
    async (apsEnvironment) => {
      await registerPhone({ accountId: ownerId, apsEnvironment });
      expect(
        (
          await database
            .selectFrom("notificationDevices")
            .select("apsEnvironment")
            .executeTakeFirstOrThrow()
        ).apsEnvironment,
      ).toBe(apsEnvironment);
      await notifications.ingest(
        await store.authenticateHostCredential(`Bearer ${hostCredential}`),
        publication(),
      );
      expect((await notifications.claimDueDeliveries({ now }))[0]?.apsEnvironment).toBe(
        apsEnvironment,
      );
    },
  );

  it("re-enables a worker-disabled phone on the next identical registration", async () => {
    const input = {
      accountId: ownerId,
      installationId: "install-revive-001",
      token: "r".repeat(64),
    };
    await registerPhone(input);
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    await notifications.ingest(authority, publication());
    const worker = new NotificationDeliveryWorker({
      now: () => now,
      onError: (error) => {
        throw error;
      },
      onSettledFailure: () => undefined,
      senders: { ios: async () => ({ status: "unregistered", outcome: "apns:Unregistered" }) },
      store: {
        claimDueDeliveries: () => notifications.claimDueDeliveries({ now }),
        disableDevice: (input) => notifications.disableDevice(input),
        renewDeliveryLease: (input) => notifications.renewDeliveryLease(input),
        settleDelivery: (input) => notifications.settleDelivery(input),
        retryDelivery: (input) => notifications.retryDelivery(input),
        pruneSettled: (input) => notifications.pruneSettled(input),
      },
    });
    await worker.deliverOnce();
    await expect(notifications.listDevices(ownerId)).resolves.toEqual([]);
    await registerPhone(input);
    await expect(notifications.listDevices(ownerId)).resolves.toHaveLength(1);
    await expect(notifications.ingest(authority, publication())).resolves.toEqual({
      deliveries: 1,
    });
  });

  it("enforces the platform environment constraint in PostgreSQL", async () => {
    await registerPhone({ accountId: ownerId });
    for (const value of [null, "sandbox"]) {
      await expect(
        sql`update notification_devices set aps_environment = ${value}`.execute(database),
      ).rejects.toThrow(/notification_devices_aps_environment_check/u);
    }
    await expect(
      sql`update notification_devices set platform = 'android'`.execute(database),
    ).rejects.toThrow(/notification_devices_aps_environment_check/u);
    await sql`update notification_devices set platform = 'android', aps_environment = null`.execute(
      database,
    );
    expect(
      (
        await database
          .selectFrom("notificationDevices")
          .select("apsEnvironment")
          .executeTakeFirstOrThrow()
      ).apsEnvironment,
    ).toBeNull();
  });

  it("refuses a freshness window longer than a day or one that never opens", async () => {
    await registerPhone({ accountId: ownerId });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);

    await expect(
      notifications.ingest(
        authority,
        reply({
          expiresAt: new Date(now.getTime() + notificationExpiryMilliseconds + 1).toISOString(),
        }),
      ),
    ).rejects.toThrow(/freshness window/iu);
    await expect(
      notifications.ingest(
        authority,
        publication({ expiresAt: now.toISOString(), occurredAt: now.toISOString() }),
      ),
    ).rejects.toThrow(/freshness window/iu);
    await expect(
      notifications.ingest(
        authority,
        publication({
          expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
          occurredAt: new Date(now.getTime() + 8 * 60_000).toISOString(),
        }),
      ),
    ).rejects.toThrow(/has not happened yet/iu);
    await expect(
      database.selectFrom("notificationDeliveries").selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it("accepts a Host clock that runs a little ahead of the Account's", async () => {
    await registerPhone({ accountId: ownerId });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    const occurredAt = new Date(now.getTime() + 30_000);

    await expect(
      notifications.ingest(
        authority,
        publication({
          expiresAt: new Date(occurredAt.getTime() + 120_000).toISOString(),
          occurredAt: occurredAt.toISOString(),
        }),
      ),
    ).resolves.toEqual({ deliveries: 1 });
  });

  it("answers a retried publication from its receipt after the device has gone", async () => {
    await registerPhone({ accountId: ownerId, installationId: "install-receipt-01" });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    const published = publication();

    await expect(notifications.ingest(authority, published)).resolves.toEqual({ deliveries: 1 });
    await notifications.unregisterDevice({
      accountId: ownerId,
      installationId: "install-receipt-01",
    });
    await registerPhone({ accountId: ownerId, installationId: "install-receipt-01" });

    // The delivery rows went with the device, so only the receipt can say this
    // publication was already answered.
    await expect(
      database.selectFrom("notificationDeliveries").selectAll().execute(),
    ).resolves.toEqual([]);
    await expect(notifications.ingest(authority, published)).resolves.toEqual({ deliveries: 1 });
    await expect(
      database.selectFrom("notificationDeliveries").selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it("records a receipt even when a publication reaches nobody", async () => {
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    const published = publication();

    await expect(notifications.ingest(authority, published)).resolves.toEqual({ deliveries: 0 });
    await registerPhone({ accountId: ownerId });
    await expect(notifications.ingest(authority, published)).resolves.toEqual({ deliveries: 0 });
    await expect(
      database.selectFrom("notificationDeliveries").selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it("claims a due delivery with its decrypted token and settles it once", async () => {
    await registerPhone({ accountId: ownerId, token: "v".repeat(64) });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    const published = publication();
    await notifications.ingest(authority, published);

    const [claimed, ...rest] = await notifications.claimDueDeliveries({ now });
    expect(rest).toEqual([]);
    expect(claimed).toMatchObject({
      attempts: 1,
      deploymentId,
      kind: "request-opened",
      notificationId: published.notificationId,
      platform: "ios",
      requestId: published.requestId,
      threadId: published.threadId,
      token: "v".repeat(64),
    });
    // A second worker finds it leased rather than sending it twice.
    await expect(notifications.claimDueDeliveries({ now })).resolves.toEqual([]);

    await expect(
      notifications.settleDelivery({
        deviceId: claimed!.deviceId,
        leaseToken: claimed!.leaseToken,
        notificationId: claimed!.notificationId,
        outcome: "accepted",
        status: "delivered",
      }),
    ).resolves.toBe(true);
    await expect(
      notifications.settleDelivery({
        deviceId: claimed!.deviceId,
        leaseToken: claimed!.leaseToken,
        notificationId: claimed!.notificationId,
        outcome: "accepted",
        status: "delivered",
      }),
    ).resolves.toBe(false);
  });

  it("keeps a rotated token alive when the provider rejects the one it replaced", async () => {
    await registerPhone({
      accountId: ownerId,
      installationId: "install-rotate-001",
      token: "o".repeat(64),
    });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    await notifications.ingest(authority, publication());
    const [claimed] = await notifications.claimDueDeliveries({ now });
    // The phone re-registers with a new token while the old one is in flight.
    await registerPhone({
      accountId: ownerId,
      installationId: "install-rotate-001",
      token: "n".repeat(64),
    });

    await expect(
      notifications.disableDevice({
        deviceId: claimed!.deviceId,
        outcome: "apns:Unregistered",
        tokenHash: claimed!.tokenHash,
      }),
    ).resolves.toBe(false);

    await expect(notifications.listDevices(ownerId)).resolves.toHaveLength(1);
    await expect(
      notifications.ingest(authority, publication({ threadId: createId("thread") })),
    ).resolves.toEqual({ deliveries: 1 });
  });

  it("stops delivering to a device the provider reported as gone", async () => {
    await registerPhone({ accountId: ownerId, installationId: "install-gone-00001" });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    await notifications.ingest(authority, publication());
    const [claimed] = await notifications.claimDueDeliveries({ now });

    await notifications.disableDevice({
      deviceId: claimed!.deviceId,
      outcome: "apns:Unregistered",
      tokenHash: claimed!.tokenHash,
    });

    await expect(notifications.listDevices(ownerId)).resolves.toEqual([]);
    await expect(
      database.selectFrom("notificationDeliveries").select(["status"]).execute(),
    ).resolves.toEqual([{ status: "dropped" }]);
    await expect(
      notifications.ingest(authority, publication({ threadId: createId("thread") })),
    ).resolves.toEqual({ deliveries: 0 });
  });

  it("refuses the seventeenth device for one Account, with a reason the app can show", async () => {
    for (let index = 0; index < 16; index += 1) {
      await registerPhone({ accountId: ownerId, installationId: `install-limit-${index}00001` });
    }

    await expect(
      registerPhone({ accountId: ownerId, installationId: "install-limit-overflow1" }),
    ).rejects.toMatchObject({ code: "conflict", reason: "device-limit" });

    // The limit is per Account, and re-registering an install this Account
    // already holds is a rotation rather than a seventeenth device.
    await expect(
      registerPhone({ accountId: ownerId, installationId: "install-limit-000001" }),
    ).resolves.toMatchObject({ installationId: "install-limit-000001" });
    await expect(
      registerPhone({ accountId: memberId, installationId: "install-limit-member01" }),
    ).resolves.toMatchObject({ installationId: "install-limit-member01" });
    await expect(notifications.listDevices(ownerId)).resolves.toHaveLength(16);
  });

  it("reaches every device of every recipient rather than one page of them", async () => {
    // Two Accounts the Deployment reaches, with more devices between them than
    // any single page: the fan-out is bounded by registration, not by a limit
    // that would drop phones without saying so.
    for (const recipient of [ownerId, memberId]) {
      for (let index = 0; index < 16; index += 1) {
        await registerPhone({
          accountId: recipient,
          installationId: `install-fan-${recipient.slice(5, 13)}-${index}`,
        });
      }
    }
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);

    await expect(
      notifications.ingest(authority, publication({ recipientAccountIds: [ownerId, memberId] })),
    ).resolves.toEqual({ deliveries: 32 });
  });

  it("drops settled deliveries and their receipts once they are a month old", async () => {
    await registerPhone({ accountId: ownerId });
    const authority = await store.authenticateHostCredential(`Bearer ${hostCredential}`);
    const settled = publication();
    await notifications.ingest(authority, settled);
    const claimed = await notifications.claimDueDeliveries({ now });
    await notifications.settleDelivery({
      deviceId: claimed[0]!.deviceId,
      leaseToken: claimed[0]!.leaseToken,
      notificationId: claimed[0]!.notificationId,
      outcome: "accepted",
      status: "delivered",
    });
    now = new Date("2026-09-14T12:01:00.000Z");
    const pending = publication({ threadId: createId("thread") });
    await notifications.ingest(authority, pending);

    const before = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
    await expect(
      notifications.pruneSettled({ before: new Date("2026-09-14T11:59:00.000Z") }),
    ).resolves.toEqual({ deliveries: 0, receipts: 0 });
    await expect(notifications.pruneSettled({ before })).resolves.toEqual({
      deliveries: 1,
      receipts: 2,
    });

    // The delivery nobody has answered for yet is still owed, whatever its age.
    await expect(
      database.selectFrom("notificationDeliveries").select(["notificationId", "status"]).execute(),
    ).resolves.toEqual([{ notificationId: pending.notificationId, status: "pending" }]);
  });

  it("silences an Account's phones when every session is revoked", async () => {
    await registerPhone({ accountId: ownerId });

    await store.revokeAccountSessions(ownerId);

    await expect(notifications.listDevices(ownerId)).resolves.toEqual([]);
    await expect(
      notifications.ingest(
        await store.authenticateHostCredential(`Bearer ${hostCredential}`),
        publication(),
      ),
    ).resolves.toEqual({ deliveries: 0 });
  });
});

integration("control-plane reply notification migration", () => {
  const databaseName = `opensteer_control_replies_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<ControlPlaneDatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createControlPlaneDatabase({
      connectionString: urlForDatabase(databaseName),
      maxConnections: 2,
    });
    // The notification tables as an Account that already shipped report
    // notifications holds them; nothing else in between touches them.
    await sql.raw(CONTROL_PLANE_BASELINE_SCHEMA_SQL).execute(database);
    await notificationsMigration.up(database);
    await reportNotificationMigration.up(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("keeps legacy alerts, admits replies and migrates unknown iOS environments", async () => {
    const accountId = "acct_44444444-4444-4444-8444-444444444444";
    const deploymentId = "dep_44444444-4444-4444-8444-444444444444";
    const deviceId = crypto.randomUUID();
    const notificationId = (index: number) =>
      `ntf_44444444-4444-4444-8444-${String(index).padStart(12, "0")}`;
    const legacyKinds = [
      "report-published",
      "request-opened",
      "run-completed",
      "run-failed",
      "run-interrupted",
    ];
    await sql`
      insert into public.users(id, display_name, email)
      values (${accountId}, 'Owner', 'owner@example.test')
    `.execute(database);
    await sql`
      insert into public.deployments(
        id, owner_account_id, name, reachability, active_host_instance_id,
        authority_epoch, canonical_origin, host_key_fingerprint
      ) values (
        ${deploymentId}, ${accountId}, 'Home', 'canonical',
        'hst_44444444-4444-4444-8444-444444444444', 1, 'https://home.example.test',
        ${`sha256:${"d".repeat(43)}`}
      )
    `.execute(database);
    await sql`
      insert into public.notification_devices(
        id, account_id, installation_id, application, platform, token_ciphertext,
        token_hash, approvals_enabled, run_outcomes_enabled
      ) values (
        ${deviceId}, ${accountId}, 'install-migrate-01', 'mobile', 'ios', 'sealed',
        ${"h".repeat(43)}, true, true
      )
    `.execute(database);
    const insertAlert = async (index: number, kind: string, status: string) => {
      await sql`
        insert into public.notification_publications(deployment_id, notification_id, thread_id, kind)
        values (${deploymentId}, ${notificationId(index)}, 'thr_migrate', ${kind})
      `.execute(database);
      await sql`
        insert into public.notification_deliveries(
          notification_id, device_id, deployment_id, thread_id, kind, expires_at, status,
          completed_at
        ) values (
          ${notificationId(index)}, ${deviceId}, ${deploymentId}, 'thr_migrate', ${kind},
          now() + interval '2 minutes', ${status},
          ${status === "pending" ? null : new Date()}
        )
      `.execute(database);
    };
    for (const [index, kind] of legacyKinds.entries()) {
      await insertAlert(index, kind, index % 2 === 0 ? "pending" : "delivered");
    }

    await replyNotificationMigration.up(database);

    const kept = await sql<{ readonly kind: string; readonly status: string }>`
      select delivery.kind, delivery.status
      from public.notification_deliveries delivery
      join public.notification_publications publication using (deployment_id, notification_id)
      order by delivery.notification_id
    `.execute(database);
    expect(kept.rows).toEqual(
      legacyKinds.map((kind, index) => ({
        kind,
        status: index % 2 === 0 ? "pending" : "delivered",
      })),
    );
    await insertAlert(legacyKinds.length, "reply-published", "pending");
    await expect(insertAlert(legacyKinds.length + 1, "run-started", "pending")).rejects.toThrow(
      /notification_publications_kind_check/u,
    );
    await expect(
      sql`
        update public.notification_deliveries set kind = 'run-started'
        where notification_id = ${notificationId(0)}
      `.execute(database),
    ).rejects.toThrow(/notification_deliveries_kind_check/u);
    const indexes = await sql<{ readonly indexname: string }>`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'notification_deliveries'
      order by indexname
    `.execute(database);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "notification_deliveries_due",
      "notification_deliveries_pending_stream",
      "notification_deliveries_pkey",
    ]);

    await notificationDeviceEnvironmentMigration.up(database);
    expect((await sql`select * from notification_devices`.execute(database)).rows).toEqual([]);
    const constraints = await sql<{
      definition: string;
    }>`select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'notification_devices_aps_environment_check'`.execute(
      database,
    );
    expect(constraints.rows).toHaveLength(1);
    expect(constraints.rows[0]?.definition).toContain("development");
    expect(constraints.rows[0]?.definition).toContain("production");
  });
});
