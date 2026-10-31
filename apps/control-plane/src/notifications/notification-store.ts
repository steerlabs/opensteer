import { randomBytes } from "node:crypto";
import {
  NotificationDeviceSchema,
  type ControlPlaneAccountId,
  type HostNotificationPublication,
  type NotificationDevice,
  type NotificationDevicePlatform,
  type PublishedNotificationKind,
  type RegisterNotificationDeviceRequest,
} from "@opensteer/control-plane-protocol";
import {
  NotificationPreviewEnvelopeSchema,
  type NotificationPreviewEnvelope,
  maximumNotificationDevicesPerAccount,
  notificationExpiryMilliseconds,
  type DeploymentId,
  type NotificationId,
  type ThreadId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { ControlPlaneError } from "../server/errors.js";
import { assertFence, type HostAuthority } from "../database/store.js";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import type { NotificationTokenCipher } from "./notification-token-cipher.js";

/**
 * How far ahead of this Account's clock a Host's own clock may be before its
 * publication is refused. Two machines agreeing on "now" to within a minute is
 * what makes a publication's freshness window mean the same thing on both.
 */
const maximumPublicationClockSkewMilliseconds = 60 * 1_000;

/**
 * How many Accounts one device read covers. Fan-out reads every recipient's
 * devices — the bound on a publication is the 256 Accounts it may name times
 * the devices each may register, and it is arithmetic rather than a `limit`
 * that would drop phones without saying so — so the read is paged to keep any
 * one statement's parameter list small.
 */
const fanOutRecipientChunkSize = 32;

/** One delivery the worker has taken responsibility for. */
export interface ClaimedNotificationDelivery {
  readonly installationId: string;
  readonly preview: NotificationPreviewEnvelope | null;
  readonly apsEnvironment: "development" | "production" | null;
  readonly attempts: number;
  readonly deploymentId: DeploymentId;
  readonly deviceId: string;
  readonly expiresAt: Date;
  readonly kind: PublishedNotificationKind;
  readonly messageId?: string | null;
  readonly leaseToken: string;
  readonly notificationId: NotificationId;
  readonly platform: NotificationDevicePlatform;
  readonly requestId: string | null;
  readonly threadId: ThreadId;
  readonly token: string;
  /** Which registration this token was, so a rotation is not mistaken for it. */
  readonly tokenHash: string;
}

export interface NotificationStoreOptions {
  readonly cipher: NotificationTokenCipher;
  readonly now?: () => Date;
}

/**
 * The Account's half of push: who may be interrupted, on which device, and
 * whether a given publication has already earned that interruption.
 */
export class ControlPlaneNotificationStore {
  readonly #cipher: NotificationTokenCipher;
  readonly #database: Kysely<ControlPlaneDatabaseSchema>;
  readonly #now: () => Date;

  constructor(database: Kysely<ControlPlaneDatabaseSchema>, options: NotificationStoreOptions) {
    this.#cipher = options.cipher;
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Upserts one install's registration. The install id is the key, so a token
   * the operating system rotated replaces the value this phone already had
   * rather than leaving an undeliverable row behind; a token that has moved to
   * a different install takes its unique slot from the registration that used
   * to hold it, because only one of them can still receive it.
   */
  async registerDevice(
    input: RegisterNotificationDeviceRequest & {
      readonly accountId: ControlPlaneAccountId;
      readonly installationId: string;
    },
  ): Promise<NotificationDevice> {
    const now = this.#now();
    const tokenHash = this.#cipher.digest(input.platform, input.token);
    const row = await this.#database.transaction().execute(async (transaction) => {
      // One Account's registrations are counted and then written, which no
      // unique key can fence, so they serialize on the Account.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`opensteer:notification-devices:${input.accountId}`}, 0))`.execute(
        transaction,
      );
      await transaction
        .deleteFrom("notificationDevices")
        .where("platform", "=", input.platform)
        .where("tokenHash", "=", tokenHash)
        .where((expression) =>
          expression.or([
            expression("accountId", "!=", input.accountId),
            expression("installationId", "!=", input.installationId),
          ]),
        )
        .execute();
      const others = await transaction
        .selectFrom("notificationDevices")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("accountId", "=", input.accountId)
        .where("disabledAt", "is", null)
        .where("installationId", "!=", input.installationId)
        .executeTakeFirstOrThrow();
      if (Number(others.count) >= maximumNotificationDevicesPerAccount) {
        throw new ControlPlaneError(
          "conflict",
          `This Account already has ${maximumNotificationDevicesPerAccount} devices registered for notifications. Turn them off on a device you no longer use before registering this one.`,
          { reason: "device-limit" },
        );
      }
      const values = {
        application: "mobile",
        apsEnvironment: input.platform === "ios" ? input.apsEnvironment : null,
        approvalsEnabled: input.approvalsEnabled,
        disabledAt: null,
        lastSeenAt: now,
        platform: input.platform,
        runOutcomesEnabled: input.runOutcomesEnabled,
        tokenCiphertext: this.#cipher.seal(input.accountId, input.token),
        tokenHash,
        updatedAt: now,
      } as const;
      return transaction
        .insertInto("notificationDevices")
        .values({
          accountId: input.accountId,
          id: crypto.randomUUID(),
          installationId: input.installationId,
          registeredAt: now,
          ...values,
        })
        .onConflict((conflict) =>
          conflict.columns(["accountId", "installationId"]).doUpdateSet(values),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return deviceFromRow(row);
  }

  async unregisterDevice(input: {
    readonly accountId: ControlPlaneAccountId;
    readonly installationId: string;
  }): Promise<boolean> {
    const result = await this.#database
      .deleteFrom("notificationDevices")
      .where("accountId", "=", input.accountId)
      .where("installationId", "=", input.installationId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async listDevices(accountId: ControlPlaneAccountId): Promise<readonly NotificationDevice[]> {
    const rows = await this.#database
      .selectFrom("notificationDevices")
      .selectAll()
      .where("accountId", "=", accountId)
      .where("disabledAt", "is", null)
      .orderBy("registeredAt", "asc")
      .limit(maximumNotificationDevicesPerAccount)
      .execute();
    return rows.map(deviceFromRow);
  }

  /**
   * A provider saying the token is gone is the end of that registration — but
   * only of the registration that token belonged to.
   *
   * A phone that re-registered while a delivery for its previous token was
   * still in flight keeps the same row, so disabling by device id alone would
   * let Apple's verdict on a dead token silence a live one. The hash the
   * delivery was claimed with has to still be the row's, or nothing happens.
   */
  async disableDevice(input: {
    readonly deviceId: string;
    readonly outcome: string;
    readonly tokenHash: string;
  }): Promise<boolean> {
    return this.#database.transaction().execute(async (transaction) => {
      const disabled = await transaction
        .updateTable("notificationDevices")
        .set({ disabledAt: this.#now(), updatedAt: this.#now() })
        .where("id", "=", input.deviceId)
        .where("tokenHash", "=", input.tokenHash)
        .where("disabledAt", "is", null)
        .executeTakeFirst();
      if (disabled.numUpdatedRows !== 1n) return false;
      await transaction
        .updateTable("notificationDeliveries")
        .set({
          completedAt: this.#now(),
          leaseExpiresAt: null,
          leaseToken: null,
          providerOutcome: input.outcome.slice(0, 512),
          status: "dropped",
          preview: null,
        })
        .where("deviceId", "=", input.deviceId)
        .where("status", "=", "pending")
        .execute();
      return true;
    });
  }

  /**
   * Accepts one Host publication and turns it into the deliveries it earns.
   *
   * Four things are refused here rather than trusted: the Deployment the Host
   * claims to speak for, the Accounts it addresses, a freshness window that
   * does not close within a day of opening, and a publication this Account has
   * already answered. The Host resolved who *may see* it; the Account decides
   * who it still *reaches*, and the two are intersected rather than
   * concatenated. The window is an upper bound rather than an exact length
   * because earlier Hosts publish windows ranging from two minutes to a day.
   */
  async ingest(
    authority: HostAuthority,
    publication: HostNotificationPublication,
  ): Promise<{ readonly deliveries: number }> {
    assertFence(authority, publication.hostInstanceId);
    if (publication.deploymentId !== authority.deploymentId) {
      throw new ControlPlaneError("forbidden", "Host authority fence does not match");
    }
    const now = this.#now();
    const occurredAt = new Date(publication.occurredAt);
    const expiresAt = new Date(publication.expiresAt);
    if (occurredAt.getTime() > now.getTime() + maximumPublicationClockSkewMilliseconds) {
      throw new ControlPlaneError("bad_request", "Notification has not happened yet");
    }
    if (
      expiresAt.getTime() <= occurredAt.getTime() ||
      expiresAt.getTime() > occurredAt.getTime() + notificationExpiryMilliseconds
    ) {
      throw new ControlPlaneError(
        "bad_request",
        "Notification freshness window must close after it opens and within a day",
      );
    }
    return this.#database.transaction().execute(async (transaction) => {
      const receipt = await transaction
        .insertInto("notificationPublications")
        .values({
          deliveries: 0,
          deploymentId: publication.deploymentId,
          kind: publication.kind,
          notificationId: publication.notificationId,
          receivedAt: now,
          threadId: publication.threadId,
        })
        .onConflict((conflict) => conflict.columns(["deploymentId", "notificationId"]).doNothing())
        .returning("notificationId")
        .executeTakeFirst();
      // A replayed publication is the same publication, whatever has become of
      // the devices it was addressed to. The receipt is what answers it.
      if (!receipt) {
        const recorded = await transaction
          .selectFrom("notificationPublications")
          .select("deliveries")
          .where("deploymentId", "=", publication.deploymentId)
          .where("notificationId", "=", publication.notificationId)
          .executeTakeFirstOrThrow();
        return { deliveries: recorded.deliveries };
      }
      const deliveries = await this.#fanOut(transaction, publication, { expiresAt, now });
      if (deliveries > 0) {
        await transaction
          .updateTable("notificationPublications")
          .set({ deliveries })
          .where("deploymentId", "=", publication.deploymentId)
          .where("notificationId", "=", publication.notificationId)
          .executeTakeFirstOrThrow();
      }
      return { deliveries };
    });
  }

  async #fanOut(
    transaction: Transaction<ControlPlaneDatabaseSchema>,
    publication: HostNotificationPublication,
    window: { readonly expiresAt: Date; readonly now: Date },
  ): Promise<number> {
    if (window.expiresAt.getTime() <= window.now.getTime()) return 0;
    const reachable = await reachableAccounts(
      transaction,
      publication.deploymentId,
      publication.recipientAccountIds,
    );
    if (reachable.length === 0) return 0;
    const devices: {
      readonly id: string;
      readonly accountId: ControlPlaneAccountId;
      readonly installationId: string;
    }[] = [];
    for (let index = 0; index < reachable.length; index += fanOutRecipientChunkSize) {
      const chunk = reachable.slice(index, index + fanOutRecipientChunkSize);
      devices.push(
        ...(await transaction
          .selectFrom("notificationDevices")
          .select(["id", "accountId", "installationId"])
          .where("accountId", "in", chunk)
          .where("disabledAt", "is", null)
          .where(
            publication.kind === "request-opened" ? "approvalsEnabled" : "runOutcomesEnabled",
            "=",
            true,
          )
          .execute()),
      );
    }
    if (devices.length === 0) return 0;
    const deviceIds = devices.map((device) => device.id);
    await transaction
      .insertInto("notificationDeliveries")
      .values(
        devices.map((device) => ({
          preview:
            publication.previews?.find(
              (preview) =>
                preview.accountId === device.accountId &&
                preview.installationId === device.installationId,
            )?.preview ?? null,
          attempts: 0,
          createdAt: window.now,
          deploymentId: publication.deploymentId,
          deviceId: device.id,
          expiresAt: window.expiresAt,
          kind: publication.kind,
          messageId: publication.messageId ?? null,
          nextAttemptAt: window.now,
          notificationId: publication.notificationId,
          requestId: publication.requestId,
          status: "pending" as const,
          threadId: publication.threadId,
        })),
      )
      .execute();
    return deviceIds.length;
  }

  /**
   * Claims a small batch of due deliveries under a one-minute lease. The worker
   * sends them one at a time, so the batch is kept well inside what one lease
   * can cover, and `renewDeliveryLease` re-asserts ownership per message for
   * the rest.
   */
  async claimDueDeliveries(
    input: { readonly limit?: number; readonly now?: Date } = {},
  ): Promise<readonly ClaimedNotificationDelivery[]> {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Notification delivery claim limit must be between 1 and 100");
    }
    const now =
      input.now ??
      (
        await this.#database
          .selectNoFrom(sql<Date>`clock_timestamp()`.as("now"))
          .executeTakeFirstOrThrow()
      ).now;
    // Commit each bounded cleanup before claiming: live delivery IDs need not
    // follow expired IDs, so retaining cleanup locks would reverse lock order.
    await this.#database
      .updateTable("notificationDeliveries")
      .set({
        status: "dropped",
        preview: null,
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        providerOutcome: "expired",
      })
      .where((eb) =>
        eb(
          eb.refTuple("notificationId", "deviceId"),
          "in",
          eb
            .selectFrom("notificationDeliveries as expired")
            .select(["expired.notificationId", "expired.deviceId"])
            .where("expired.status", "=", "pending")
            .where("expired.expiresAt", "<=", now)
            .orderBy("expired.notificationId", "asc")
            .orderBy("expired.deviceId", "asc")
            .limit(limit)
            .forNoKeyUpdate()
            .skipLocked()
            .$asTuple("notificationId", "deviceId"),
        ),
      )
      .execute();
    return this.#database.transaction().execute(async (transaction) => {
      const rows = await transaction
        .selectFrom("notificationDeliveries")
        .innerJoin(
          "notificationDevices",
          "notificationDevices.id",
          "notificationDeliveries.deviceId",
        )
        .select([
          "notificationDeliveries.preview as preview",
          "notificationDevices.installationId as installationId",
          "notificationDeliveries.attempts as attempts",
          "notificationDeliveries.deploymentId as deploymentId",
          "notificationDeliveries.deviceId as deviceId",
          "notificationDeliveries.expiresAt as expiresAt",
          "notificationDeliveries.kind as kind",
          "notificationDeliveries.messageId as messageId",
          "notificationDeliveries.notificationId as notificationId",
          "notificationDeliveries.requestId as requestId",
          "notificationDeliveries.threadId as threadId",
          "notificationDevices.accountId as accountId",
          "notificationDevices.platform as platform",
          "notificationDevices.apsEnvironment as apsEnvironment",
          "notificationDevices.tokenCiphertext as tokenCiphertext",
          "notificationDevices.tokenHash as tokenHash",
        ])
        .where("notificationDeliveries.status", "=", "pending")
        .where("notificationDeliveries.expiresAt", ">", now)
        .where("notificationDeliveries.nextAttemptAt", "<=", now)
        .where("notificationDevices.disabledAt", "is", null)
        .where((expression) =>
          expression.or([
            expression("notificationDeliveries.leaseToken", "is", null),
            expression("notificationDeliveries.leaseExpiresAt", "<=", now),
          ]),
        )
        .orderBy("notificationDeliveries.nextAttemptAt", "asc")
        .orderBy("notificationDeliveries.createdAt", "asc")
        .limit(limit)
        .forNoKeyUpdate("notificationDeliveries")
        .skipLocked()
        .execute();
      const leaseExpiresAt = new Date(now.getTime() + 60_000);
      const claimed: ClaimedNotificationDelivery[] = [];
      for (const row of rows) {
        const leaseToken = randomBytes(32).toString("base64url");
        const updated = await transaction
          .updateTable("notificationDeliveries")
          .set({
            attempts: sql`attempts + 1`,
            leaseExpiresAt,
            leaseToken,
            nextAttemptAt: leaseExpiresAt,
          })
          .where("notificationId", "=", row.notificationId)
          .where("deviceId", "=", row.deviceId)
          .where("status", "=", "pending")
          .returning("attempts")
          .executeTakeFirstOrThrow();
        claimed.push({
          installationId: row.installationId,
          preview: row.preview === null ? null : parsedPreview(row.preview),
          apsEnvironment: row.apsEnvironment,
          attempts: updated.attempts,
          deploymentId: row.deploymentId,
          deviceId: row.deviceId,
          expiresAt: row.expiresAt,
          kind: row.kind,
          messageId: row.messageId,
          leaseToken,
          notificationId: row.notificationId,
          platform: row.platform,
          requestId: row.requestId,
          threadId: row.threadId,
          token: this.#cipher.open(row.accountId, row.tokenCiphertext),
          tokenHash: row.tokenHash,
        });
      }
      return claimed;
    });
  }

  /**
   * Re-asserts this worker's lease and extends it, immediately before the
   * message goes to Apple or Google. A batch is sent sequentially, so a lease
   * taken for all of it can expire part-way through; a row another worker has
   * since claimed is left to that worker rather than sent twice.
   */
  async renewDeliveryLease(input: {
    readonly deviceId: string;
    readonly leaseToken: string;
    readonly notificationId: NotificationId;
    readonly now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? this.#now();
    const result = await this.#database
      .updateTable("notificationDeliveries")
      .set({ leaseExpiresAt: new Date(now.getTime() + 60_000) })
      .where("notificationId", "=", input.notificationId)
      .where("deviceId", "=", input.deviceId)
      .where("leaseToken", "=", input.leaseToken)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /**
   * Records what the provider said. `delivered` means Apple or Google accepted
   * the message, never that anybody saw it — "seen" is the phone's word, and
   * this ledger has no way to learn it.
   */
  async settleDelivery(input: {
    readonly deviceId: string;
    readonly leaseToken: string;
    readonly notificationId: NotificationId;
    readonly outcome: string;
    readonly status: "delivered" | "dropped" | "failed";
  }): Promise<boolean> {
    const result = await this.#database
      .updateTable("notificationDeliveries")
      .set({
        completedAt: this.#now(),
        preview: null,
        leaseExpiresAt: null,
        leaseToken: null,
        providerOutcome: input.outcome.slice(0, 512),
        status: input.status,
      })
      .where("notificationId", "=", input.notificationId)
      .where("deviceId", "=", input.deviceId)
      .where("leaseToken", "=", input.leaseToken)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /**
   * Drops the settled half of the ledger once it is old enough to be nobody's
   * business: deliveries Apple or Google have already answered for, and the
   * publication receipts that fenced them.
   *
   * A pending delivery is never touched, whatever its age — it is either still
   * owed or still leased. A receipt outlives every delivery it produced,
   * because a Host replaying a publication inside the retention window must
   * still be answered from the receipt rather than fanned out again; past the
   * window the publication it recorded expired weeks ago.
   */
  async pruneSettled(input: {
    readonly before: Date;
  }): Promise<{ readonly deliveries: number; readonly receipts: number }> {
    return this.#database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("notificationDeliveries")
        .select("notificationId")
        .where("status", "!=", "pending")
        .where("completedAt", "<", input.before)
        .orderBy("notificationId", "asc")
        .orderBy("deviceId", "asc")
        // FOR UPDATE: prune the settled delivery rows below.
        .forUpdate()
        .execute();
      const deliveries = await transaction
        .deleteFrom("notificationDeliveries")
        .where("status", "!=", "pending")
        .where("completedAt", "<", input.before)
        .executeTakeFirst();
      await transaction
        .selectFrom("notificationPublications")
        .select("notificationId")
        .where("receivedAt", "<", input.before)
        .orderBy("deploymentId", "asc")
        .orderBy("notificationId", "asc")
        // FOR UPDATE: prune the expired publication receipts below.
        .forUpdate()
        .execute();
      const receipts = await transaction
        .deleteFrom("notificationPublications")
        .where("receivedAt", "<", input.before)
        .executeTakeFirst();
      return {
        deliveries: Number(deliveries.numDeletedRows),
        receipts: Number(receipts.numDeletedRows),
      };
    });
  }

  async retryDelivery(input: {
    readonly deviceId: string;
    readonly leaseToken: string;
    readonly nextAttemptAt: Date;
    readonly notificationId: NotificationId;
    readonly outcome: string;
  }): Promise<boolean> {
    const result = await this.#database
      .updateTable("notificationDeliveries")
      .set({
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: input.nextAttemptAt,
        providerOutcome: input.outcome.slice(0, 512),
      })
      .where("notificationId", "=", input.notificationId)
      .where("deviceId", "=", input.deviceId)
      .where("leaseToken", "=", input.leaseToken)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}

/**
 * The Accounts this Deployment currently reaches: its owner, plus whoever its
 * Host has projected into the directory as present. A Host naming anybody else
 * is naming somebody it has no relationship with, and they are dropped.
 */
async function reachableAccounts(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  deploymentId: DeploymentId,
  requested: readonly ControlPlaneAccountId[],
): Promise<readonly ControlPlaneAccountId[]> {
  const candidates = [...new Set(requested)];
  if (candidates.length === 0) return [];
  const owner = await transaction
    .selectFrom("deployments")
    .select("ownerAccountId")
    .where("id", "=", deploymentId)
    .executeTakeFirst();
  if (!owner) return [];
  const members = await transaction
    .selectFrom("deploymentDirectoryEntries")
    .select("accountId")
    .where("deploymentId", "=", deploymentId)
    .where("present", "=", true)
    .where("accountId", "in", candidates)
    .execute();
  const reachable = new Set(members.map((row) => row.accountId));
  if (candidates.includes(owner.ownerAccountId)) reachable.add(owner.ownerAccountId);
  return candidates.filter((accountId) => reachable.has(accountId));
}

function deviceFromRow(row: {
  readonly approvalsEnabled: boolean;
  readonly installationId: string;
  readonly lastSeenAt: Date;
  readonly platform: NotificationDevicePlatform;
  readonly registeredAt: Date;
  readonly runOutcomesEnabled: boolean;
  readonly updatedAt: Date;
}): NotificationDevice {
  return NotificationDeviceSchema.parse({
    approvalsEnabled: row.approvalsEnabled,
    installationId: row.installationId,
    lastSeenAt: row.lastSeenAt.toISOString(),
    platform: row.platform,
    registeredAt: row.registeredAt.toISOString(),
    runOutcomesEnabled: row.runOutcomesEnabled,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function parsedPreview(value: unknown): NotificationPreviewEnvelope {
  const parsed = NotificationPreviewEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new Error("Stored notification preview is invalid");
  return parsed.data;
}
