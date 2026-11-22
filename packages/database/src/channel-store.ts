import { commitPersonalMutation } from "./personal-mutation.js";
import { computerConnectionDeviceId } from "./integration-connections.js";
import { getDeviceSelfRunnerId, getSelfDeviceId } from "./device-inventory-store.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { jsonValue } from "./store-primitives.js";
import { bridgeAccountEnded, liveConnection } from "./connection-liveness.js";
import { noticeDeadChatMessage } from "./bridge-ingress.js";
import { createHash, randomBytes } from "node:crypto";
import {
  ChannelAccountSchema,
  ChannelDashboardSchema,
  ChannelDeliverySchema,
  ChannelProviderManifestSchema,
  ChannelProviderSchema,
  ChannelTransportKindSchema,
  IntegrationConnectionSchema,
  NormalizedChannelEventSchema,
  channelProviderCatalog,
  createChannelId,
  type ChannelAccount,
  type ChannelAccountId,
  type ChannelDelivery,
  type ChannelDeliveryId,
  type ChannelIngressId,
  type ChannelProvider,
  type ChannelProviderManifest,
  type ChannelRuntimeCapability,
  type ChannelTransportKind,
  type IntegrationConnectionId,
  type NormalizedChannelEvent,
} from "@opensteer/channel-core";
import type { IntegrationConnectionMethod } from "@opensteer/integration-core/models";
import { OpensteerError, type CredentialId, type RunnerId, type UserId } from "@opensteer/core";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import type { ChannelAccountTable, DatabaseSchema, IntegrationConnectionTable } from "./schema.js";
import { assertPersonalOwner } from "./private-resource-owner.js";

import {
  channelSourceAllows,
  revokeChannelConnectionsInTransaction,
} from "./channel-deliveries.js";
import type {} from "./run-grants.js";

export interface CreateChannelConnectionInput {
  readonly account: {
    readonly displayName: string;
    readonly externalAccountId: string;
    readonly handle?: string | null;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly routingMode: "dedicated" | "shared";
  };
  readonly connection: {
    readonly capabilities?: readonly string[];
    readonly connectionMethod: IntegrationConnectionMethod;
    readonly displayName: string;
    readonly externalIdentityId?: string | null;
    readonly externalTenantId?: string | null;
    readonly provider: ChannelProvider;
    readonly runnerId: RunnerId;
    /** For a computer transport, the app connection it is a use of. */
    readonly sourceConnectionId?: IntegrationConnectionId;
    readonly transportKind: ChannelTransportKind;
  };
  readonly createdBy: UserId;
  /** Null for a computer transport, which is reached through its computer. */
  readonly credential: {
    readonly encryptedPayload: Buffer;
    readonly encryptionKeyVersion: number;
    readonly id: CredentialId;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly name: string;
    readonly ownerId: UserId;
    readonly provider: string;
  } | null;
}

export interface ClaimedIngress {
  readonly accountId: ChannelAccountId;
  readonly claimToken: string;
  readonly event: NormalizedChannelEvent;
  readonly id: ChannelIngressId;
  readonly receivedAt: Date;
}

interface ClaimedDeliveryRecord {
  readonly claimToken: string;
  readonly connection: {
    readonly connectionId: IntegrationConnectionId;
    /** Null for a computer transport, which holds no secret. */
    readonly credentialId: CredentialId | null;
    readonly ownerUserId: UserId;
    readonly provider: ChannelProvider;
    readonly runnerId: RunnerId;
  };
  readonly delivery: ChannelDelivery;
  readonly destination: {
    readonly externalConversationId: string;
    readonly externalScopeId: string | null;
    readonly externalThreadId: string | null;
    readonly externalUserId: string | null;
  };
  readonly externalAccountId: string;
  /** The previous attempt lost its outcome, so the provider may already hold this message. */
  readonly mayHaveBeenSent: boolean;
}

const atIngressLaneHead = sql<boolean>`not exists (
  select 1 from public.channel_ingress_events ahead
  where ahead.lane_key = claimable.lane_key
    and (
      ahead.status = 'leased'
      or (ahead.status = 'pending' and ahead.received_at < claimable.received_at)
    )
)`;
const retentionMs = 7 * 24 * 60 * 60 * 1_000;
const deliveryAttemptCeiling = 20;
const ingressAttemptCeiling = 20;
/**
 * How soon a deferred event is looked at again; the wait is for a computer,
 * not a fix. A message somebody just sent is polled quickly because they are
 * still watching for the answer; one that has been waiting a while is polled
 * gently, because nobody is helped by a tight loop for the rest of the hour.
 */
const ingressDeferralRetryMs = 5_000;
const ingressDeferralSlowRetryMs = 30_000;
/** How long a message stays "just sent" for the purpose of that cadence. */
const ingressDeferralFreshMs = 60_000;

/**
 * Exponential with full respect for a provider's own `Retry-After`, jittered
 * so a burst of failures from one outage does not return as a synchronized
 * burst of retries.
 */
export function channelRetryDelayMs(attempts: number, retryAfterMs: number | null): number {
  const exponential = Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 600_000);
  const base = Math.max(retryAfterMs ?? 0, exponential);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export class ChannelStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  async dashboard(
    ownerUserId: UserId,
    providers: readonly ChannelProviderManifest[],
    connectedRunnerIds: readonly RunnerId[],
  ): Promise<ReturnType<typeof ChannelDashboardSchema.parse>> {
    const [connections, accounts, attention] = await Promise.all([
      this.#database
        .selectFrom("integrationConnections")
        .selectAll()
        .where("ownerUserId", "=", ownerUserId)
        .where("connectionKind", "=", "channel")
        .where("status", "!=", "revoked")
        .orderBy("updatedAt", "desc")
        .limit(500)
        .execute(),
      this.#database
        .selectFrom("channelAccounts")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .selectAll("channelAccounts")
        .where("integrationConnections.ownerUserId", "=", ownerUserId)
        .where("channelAccounts.status", "!=", "revoked")
        .orderBy("channelAccounts.updatedAt", "desc")
        .limit(500)
        .execute(),
      this.#database
        .selectFrom("bridgeDeliveries")
        .innerJoin("channelAccounts", "channelAccounts.id", "bridgeDeliveries.accountId")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("integrationConnections.ownerUserId", "=", ownerUserId)
        .where("bridgeDeliveries.status", "in", ["unknown", "dead"])
        .executeTakeFirstOrThrow(),
    ]);
    return ChannelDashboardSchema.parse({
      // Routes and approvals are gone: what a chat may do is its bridge, listed with the
      // connected agents. The rows the previous image wrote are never read again.
      accessGrants: [],
      accounts: accounts.map(channelAccountFromRow),
      bindings: [],
      connections: connections.map((connection) =>
        integrationConnectionFromRow(
          connection,
          connection.runnerId !== null && connectedRunnerIds.includes(connection.runnerId),
        ),
      ),
      deliveriesNeedingAttention: safeCount(attention.count),
      providers: providers.map((provider) => ChannelProviderManifestSchema.parse(provider)),
    });
  }

  /**
   * A provider account, and nothing that decides who may use it: that is a bridge's, chosen on
   * its consent. "Me" on the account is linked by the person sending a code from it.
   */
  async createConnection(input: CreateChannelConnectionInput): Promise<{
    readonly account: ChannelAccount;
    readonly connection: ReturnType<typeof IntegrationConnectionSchema.parse>;
  }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const externalIdentityId = input.connection.externalIdentityId ?? null;
      if (externalIdentityId) {
        const identityKey = JSON.stringify([
          input.connection.provider,
          input.connection.externalTenantId ?? null,
          externalIdentityId,
        ]);
        await sql`select pg_advisory_xact_lock(hashtextextended(${identityKey}, 0))`.execute(
          transaction,
        );
      }
      await assertPersonalOwner(transaction, input.createdBy);
      if (input.connection.transportKind === "computer") {
        if (input.credential !== null) {
          throw new OpensteerError({
            code: "bad_request",
            message: "A channel reached through a computer takes no credentials",
          });
        }
        await requireComputerChannelSource(transaction, {
          createdBy: input.createdBy,
          provider: input.connection.provider,
          runnerId: input.connection.runnerId,
          sourceConnectionId: input.connection.sourceConnectionId ?? null,
        });
      } else if (
        input.credential === null ||
        input.credential.ownerId !== input.createdBy ||
        input.credential.provider !== `channel:${input.connection.provider}`
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Channel credential is unavailable",
        });
      }
      if (externalIdentityId) {
        const claimed = await transaction
          .selectFrom("integrationConnections")
          .select("id")
          .where("provider", "=", input.connection.provider)
          .where(
            sql<boolean>`external_tenant_id is not distinct from ${input.connection.externalTenantId ?? null}`,
          )
          .where("externalIdentityId", "=", externalIdentityId)
          .where("status", "!=", "revoked")
          .executeTakeFirst();
        if (claimed) {
          throw new OpensteerError({
            code: "conflict",
            message: "This provider bot identity is already connected to Opensteer",
          });
        }
      }
      const now = new Date();
      if (input.credential) {
        await transaction
          .insertInto("credentials")
          .values({
            encryptedPayload: input.credential.encryptedPayload,
            encryptionKeyVersion: input.credential.encryptionKeyVersion,
            id: input.credential.id,
            metadata: jsonValue(input.credential.metadata ?? {}),
            name: input.credential.name,
            ownerId: input.credential.ownerId,
            provider: input.credential.provider,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
      }
      const connectionRow = await transaction
        .insertInto("integrationConnections")
        .values({
          accountIdentifier: null,
          capabilities: jsonValue(input.connection.capabilities ?? []),
          computerAccess: null,
          runnerId: input.connection.runnerId,
          connectionKind: "channel",
          connectionMethod: input.connection.connectionMethod,
          credentialId: input.credential?.id ?? null,
          displayName: input.connection.displayName,
          externalIdentityId,
          externalTenantId: input.connection.externalTenantId ?? null,
          id: createChannelId("connection"),
          integrationDefinitionId: null,
          ownerUserId: input.createdBy,
          provider: input.connection.provider,
          sourceConnectionId: input.connection.sourceConnectionId ?? null,
          status: "pending",
          statusDetail: "Checking messaging provider setup",
          transportKind: input.connection.transportKind,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const accountRow = await transaction
        .insertInto("channelAccounts")
        .values({
          connectionId: connectionRow.id,
          displayName: input.account.displayName,
          externalAccountId: input.account.externalAccountId,
          handle: input.account.handle ?? null,
          id: createChannelId("account"),
          metadata: jsonValue(input.account.metadata ?? {}),
          provider: input.connection.provider,
          routingMode: input.account.routingMode,
          status: "connected",
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        account: channelAccountFromRow(accountRow),
        connection: integrationConnectionFromRow(connectionRow),
      };
    });
  }

  async setConnectionStatus(
    connectionId: IntegrationConnectionId,
    ownerUserId: UserId,
    status: "connected" | "paused" | "revoked",
    administration?: AdministrationCommandIdentity | undefined,
  ): Promise<void> {
    await commitPersonalMutation(this.#database, (transaction) =>
      administrationCommand(transaction, administration, async () => {
        const connection = await transaction
          .selectFrom("integrationConnections")
          .select("id")
          .where("id", "=", connectionId)
          .where("ownerUserId", "=", ownerUserId)
          .where("connectionKind", "=", "channel")
          .where("status", "!=", "revoked")
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!connection) {
          throw new OpensteerError({ code: "not_found", message: "Channel connection not found" });
        }
        if (status === "revoked") {
          await revokeChannelConnectionsInTransaction(transaction, [connectionId]);
          return;
        }
        await transaction
          .updateTable("integrationConnections")
          .set({
            status: status === "connected" ? "pending" : status,
            statusDetail: status === "connected" ? "Reconnecting to messaging provider" : null,
            statusReason: null,
            updatedAt: new Date(),
          })
          .where("id", "=", connectionId)
          .where("connectionKind", "=", "channel")
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("channelAccounts")
          .set({ status: status === "paused" ? "paused" : "connected", updatedAt: new Date() })
          .where("connectionId", "=", connectionId)
          .execute();
      }),
    );
  }

  /**
   * Terminal ingress and delivery rows are an operational log, not a record
   * anyone reads back, so they age out. Deliveries go first because the
   * ingress they answer is theirs by a RESTRICT foreign key.
   */
  async pruneHistory(now: Date): Promise<{
    readonly deliveries: number;
    readonly ingressEvents: number;
  }> {
    const horizon = new Date(now.getTime() - retentionMs);
    // A message that may have arrived (`unknown`) is kept: it is a Disconnect's evidence.
    const deliveries = await this.#database
      .deleteFrom("bridgeDeliveries")
      .where("status", "in", ["sent", "dead", "cancelled"])
      .where("updatedAt", "<", horizon)
      .executeTakeFirst();
    const ingressEvents = await this.#database
      .deleteFrom("channelIngressEvents")
      .where("status", "in", ["adopted", "ignored", "dead"])
      .where("processedAt", "<", horizon)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("channelDeliveries")
              .select("channelDeliveries.id")
              .whereRef("channelDeliveries.ingressId", "=", "channelIngressEvents.id"),
          ),
        ),
      )
      .executeTakeFirst();
    return {
      deliveries: Number(deliveries.numDeletedRows),
      ingressEvents: Number(ingressEvents.numDeletedRows),
    };
  }

  /** One of the owner's channel connections as a check of it needs it. */
  async connectionForCheck(
    connectionId: IntegrationConnectionId,
    ownerUserId: UserId,
  ): Promise<{
    /** Null for a computer transport, which holds no secret. */
    readonly credentialId: CredentialId | null;
    readonly externalTenantId: string | null;
    readonly provider: ChannelProvider;
    readonly runnerId: RunnerId;
    readonly transportKind: ChannelTransportKind;
  } | null> {
    const row = await this.#database
      .selectFrom("integrationConnections")
      .select(["credentialId", "externalTenantId", "provider", "runnerId", "transportKind"])
      .where("id", "=", connectionId)
      .where("ownerUserId", "=", ownerUserId)
      .where("connectionKind", "=", "channel")
      .where("status", "!=", "revoked")
      .executeTakeFirst();
    if (!row?.runnerId || !row.transportKind) return null;
    return {
      credentialId: row.credentialId,
      externalTenantId: row.externalTenantId,
      provider: ChannelProviderSchema.parse(row.provider),
      runnerId: row.runnerId,
      transportKind: ChannelTransportKindSchema.parse(row.transportKind),
    };
  }

  /**
   * The owner's live connection to one computer app on one computer — the
   * app a computer transport is a use of — or null when it is off there.
   */
  async computerAppConnectionId(input: {
    readonly definitionId: string;
    readonly ownerUserId: UserId;
    readonly runnerId: RunnerId;
  }): Promise<IntegrationConnectionId | null> {
    const deviceId = await getSelfDeviceId(this.#database, input.runnerId);
    if (!deviceId) return null;
    const row = await this.#database
      .selectFrom("integrationConnections")
      .select("id")
      .where("connectionKind", "=", "computer")
      .where("integrationDefinitionId", "=", input.definitionId)
      .where("ownerUserId", "=", input.ownerUserId)
      .where(computerConnectionDeviceId, "=", deviceId)
      .where("status", "!=", "revoked")
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async runtimeConnection(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly provider: ChannelProvider;
    readonly runnerId: RunnerId;
  }): Promise<{
    readonly accountId: ChannelAccountId;
    /** Null only for a computer transport, which holds no secret. */
    readonly credentialId: CredentialId | null;
    readonly externalAccountId: string;
    readonly ownerUserId: UserId;
    readonly transportKind: ChannelTransportKind;
  } | null> {
    const row = await this.#database
      .selectFrom("integrationConnections")
      .innerJoin("channelAccounts", "channelAccounts.connectionId", "integrationConnections.id")
      .select([
        "channelAccounts.externalAccountId",
        "channelAccounts.id as accountId",
        "integrationConnections.credentialId",
        "integrationConnections.ownerUserId",
        "integrationConnections.transportKind",
      ])
      .where("integrationConnections.id", "=", input.connectionId)
      .where("integrationConnections.provider", "=", input.provider)
      .where("integrationConnections.runnerId", "=", input.runnerId)
      .where("integrationConnections.status", "in", ["pending", "connected", "needs-attention"])
      .where("channelAccounts.status", "=", "connected")
      .executeTakeFirst();
    if (!row) return null;
    const transportKind = ChannelTransportKindSchema.parse(row.transportKind);
    if (row.credentialId === null && transportKind !== "computer") return null;
    return { ...row, transportKind };
  }

  async assignedRuntimeConnections(runnerId: RunnerId): Promise<
    readonly {
      readonly accountId: ChannelAccountId;
      readonly connectionId: IntegrationConnectionId;
      readonly credentialGeneration: number;
      readonly externalAccountId: string;
      readonly initialCursor: string | null;
      readonly provider: ChannelProvider;
      readonly transportKind: ChannelTransportKind;
    }[]
  > {
    const rows = await this.#database
      .selectFrom("integrationConnections")
      .innerJoin("channelAccounts", "channelAccounts.connectionId", "integrationConnections.id")
      .select([
        "channelAccounts.externalAccountId",
        "channelAccounts.id as accountId",
        "channelAccounts.metadata",
        "integrationConnections.id as connectionId",
        "integrationConnections.credentialGeneration",
        "integrationConnections.provider",
        "integrationConnections.transportKind",
      ])
      .where("integrationConnections.runnerId", "=", runnerId)
      .where("integrationConnections.connectionKind", "=", "channel")
      .where("integrationConnections.status", "in", ["pending", "connected", "needs-attention"])
      .where("channelAccounts.status", "not in", ["paused", "revoked"])
      .orderBy("integrationConnections.createdAt", "asc")
      .execute();
    return rows.map(({ metadata, ...row }) => ({
      ...row,
      initialCursor: accountInitialCursor(metadata),
      provider: ChannelProviderSchema.parse(row.provider),
      transportKind: ChannelTransportKindSchema.parse(row.transportKind),
    }));
  }

  async reassignDisconnectedRuntimeConnections(input: {
    readonly capabilities: readonly ChannelRuntimeCapability[];
    readonly connectedRunnerIds: readonly RunnerId[];
    readonly runnerId: RunnerId;
  }): Promise<void> {
    if (!input.connectedRunnerIds.includes(input.runnerId)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Messaging Runner must be connected before assignment",
      });
    }
    await commitPersonalMutation(this.#database, async (transaction) => {
      if (!input.capabilities.length) return;
      const candidates = transaction
        .selectFrom("integrationConnections")
        .select("id")
        .where("connectionKind", "=", "channel")
        .where("transportKind", "!=", "computer")
        .where("status", "in", ["pending", "connected", "needs-attention"])
        .where((eb) =>
          eb.or([eb("runnerId", "is", null), eb("runnerId", "not in", input.connectedRunnerIds)]),
        )
        .where((eb) =>
          eb.or(
            input.capabilities.map((capability) =>
              eb.and([
                eb("provider", "=", capability.provider),
                eb("transportKind", "in", capability.transportKinds),
              ]),
            ),
          ),
        );
      const rows = await candidates.orderBy("id", "asc").forNoKeyUpdate().execute();
      if (rows.length)
        await transaction
          .updateTable("integrationConnections")
          .set({ runnerId: input.runnerId, updatedAt: new Date() })
          .where(
            "id",
            "in",
            rows.map(({ id }) => id),
          )
          .execute();
    });
  }

  async setRuntimeConnectionHealth(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly detail: string | null;
    readonly runnerId: RunnerId;
    readonly reason: import("@opensteer/channel-core").ChannelConnectionIssueKind | null;
    readonly status: "connecting" | "connected" | "needs-attention";
  }): Promise<void> {
    const status = input.status === "connecting" ? "pending" : input.status;
    const result = await this.#database
      .updateTable("integrationConnections")
      .set({
        status,
        statusDetail: input.detail,
        statusReason: input.reason,
        updatedAt: new Date(),
      })
      .where("id", "=", input.connectionId)
      .where("connectionKind", "=", "channel")
      .where("runnerId", "=", input.runnerId)
      .where("status", "not in", ["paused", "revoked"])
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new OpensteerError({ code: "not_found", message: "Channel connection not found" });
    }
    await this.#database
      .updateTable("channelAccounts")
      .set({
        // Once connected, the transport keeps its own position: where setup
        // said to start no longer applies (`accountInitialCursor`).
        ...(status === "connected" ? { metadata: sql`metadata - 'initialCursor'` } : {}),
        status: status === "needs-attention" ? "needs-attention" : "connected",
        updatedAt: new Date(),
      })
      .where("connectionId", "=", input.connectionId)
      .where("status", "not in", ["paused", "revoked"])
      .execute();
  }

  async commitIngress(
    connectionId: IntegrationConnectionId,
    eventInput: unknown,
    onCommitted?: () => void,
  ): Promise<{
    readonly accountId: ChannelAccountId;
    readonly duplicate: boolean;
    readonly ingressId: ChannelIngressId;
  }> {
    const event = NormalizedChannelEventSchema.parse(eventInput);
    return commitPersonalMutation(this.#database, async (transaction, mutation) => {
      const account = await transaction
        .selectFrom("channelAccounts")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .select("channelAccounts.id")
        .where("integrationConnections.id", "=", connectionId)
        .where("channelAccounts.provider", "=", event.provider)
        .where("channelAccounts.externalAccountId", "=", event.accountExternalId)
        .where("channelAccounts.status", "=", "connected")
        .where("integrationConnections.status", "=", "connected")
        .executeTakeFirst();
      if (!account) {
        throw new OpensteerError({ code: "not_found", message: "Channel account not found" });
      }
      const id = createChannelId("ingress");
      const laneKey = JSON.stringify([
        event.provider,
        event.accountExternalId,
        event.conversation.externalScopeId,
        event.conversation.externalConversationId,
        event.conversation.externalThreadId,
      ]);
      const inserted = await transaction
        .insertInto("channelIngressEvents")
        .values({
          accountId: account.id,
          claimExpiresAt: null,
          claimOwner: null,
          claimTokenHash: null,
          conversationId: null,
          event: jsonValue(event),
          id,
          laneKey,
          lastError: null,
          messageId: null,
          nextAttemptAt: new Date(),
          processedAt: null,
          providerEventId: event.eventId,
          receivedAt: new Date(),
          runId: null,
          status: "pending",
          updatedAt: new Date(),
        })
        .onConflict((conflict) => conflict.columns(["accountId", "providerEventId"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (inserted) {
        if (onCommitted) mutation.reaction(onCommitted);
        return { accountId: account.id, duplicate: false, ingressId: inserted.id };
      }
      const duplicate = await transaction
        .selectFrom("channelIngressEvents")
        .select("id")
        .where("accountId", "=", account.id)
        .where("providerEventId", "=", event.eventId)
        .executeTakeFirstOrThrow();
      return { accountId: account.id, duplicate: true, ingressId: duplicate.id };
    });
  }

  // Ingress times are the Host's: stamped and claimed with it, so "due now" is the Host's now.
  // A drain pass gives the one time it claimed at, so "due" means the same thing
  // to the claim and to this answer: an exhausted row nobody could take is due
  // exactly at that time, never a moment later because this read ran later.
  async nextIngressDeadline(asOf: Date): Promise<Date | null> {
    const now = asOf;
    const row = await this.#database
      .selectFrom("channelIngressEvents as claimable")
      .select(
        sql<Date | null>`min(case
        when status = 'leased' then claim_expires_at
        when attempts >= ${ingressAttemptCeiling} then least(next_attempt_at, ${now})
        else next_attempt_at
      end)`.as("deadline"),
      )
      .where((eb) =>
        eb.or([
          eb("status", "=", "leased"),
          eb.and([
            eb("status", "=", "pending"),
            eb.or([eb("attempts", ">=", ingressAttemptCeiling), atIngressLaneHead]),
          ]),
        ]),
      )
      .executeTakeFirstOrThrow();
    return row.deadline;
  }

  async claimIngress(
    workerId: string,
    asOf: Date = new Date(),
    leaseMs = 30_000,
  ): Promise<ClaimedIngress | null> {
    // Eligibility is judged at the caller's time; a lease starts when it is taken.
    const now = asOf;
    const candidate = await this.#database
      .selectFrom("channelIngressEvents as claimable")
      .select("id")
      .where((eb) =>
        eb.or([
          eb.and([eb("status", "=", "leased"), eb("claimExpiresAt", "<=", now)]),
          eb.and([
            eb("status", "=", "pending"),
            eb.or([
              eb.and([eb("nextAttemptAt", "<=", now), atIngressLaneHead]),
              eb("attempts", ">=", ingressAttemptCeiling),
            ]),
          ]),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    if (!candidate) return null;
    await commitPersonalMutation(this.#database, async (transaction) => {
      const maintenance = await transaction
        .selectFrom("channelIngressEvents")
        .select("id")
        .where((eb) =>
          eb.or([
            eb.and([eb("status", "=", "leased"), eb("claimExpiresAt", "<=", now)]),
            eb.and([eb("status", "=", "pending"), eb("attempts", ">=", ingressAttemptCeiling)]),
          ]),
        )
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .skipLocked()
        .execute();
      if (!maintenance.length) return;
      const maintenanceIds = maintenance.map(({ id }) => id);
      await transaction
        .updateTable("channelIngressEvents")
        .set({
          claimExpiresAt: null,
          claimOwner: null,
          claimTokenHash: null,
          status: "pending",
          updatedAt: now,
        })
        .where("id", "in", maintenanceIds)
        .where("status", "=", "leased")
        .where("claimExpiresAt", "<=", now)
        .execute();
      // An event that ran out of attempts is the one failure nobody would ever
      // hear about otherwise: it never adopted, so no Run can report it, and
      // its last error is an operator's detail rather than an answer. Killing
      // it and saying so are one write, for the same reason every other
      // decline is.
      const dead = await transaction
        .updateTable("channelIngressEvents")
        .set({
          lastError: "Channel ingress retry limit reached",
          processedAt: now,
          status: "dead",
          updatedAt: now,
        })
        .where("id", "in", maintenanceIds)
        .where("status", "=", "pending")
        .where("attempts", ">=", ingressAttemptCeiling)
        .returning(["accountId", "event"])
        .execute();
      // Only a sender who may speak to the bridge covering it hears that it could not start.
      for (const row of dead) await noticeDeadChatMessage(transaction, row);
    });
    return commitPersonalMutation(this.#database, async (transaction) => {
      const leasedAt = new Date();
      // One conversation is one lane: the oldest pending event in it, and only
      // while nothing else in that lane is in flight. Two messages a person
      // sent in order must reach their Thread in that order, and a global
      // queue cannot promise that.
      const row = await transaction
        .selectFrom("channelIngressEvents as claimable")
        .selectAll("claimable")
        .where("claimable.status", "=", "pending")
        .where("claimable.nextAttemptAt", "<=", now)
        .where(atIngressLaneHead)
        .orderBy("claimable.receivedAt", "asc")
        .orderBy("claimable.id", "asc")
        .limit(1)
        .forNoKeyUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return null;
      const claimToken = randomBytes(32).toString("base64url");
      await transaction
        .updateTable("channelIngressEvents")
        .set({
          attempts: sql<number>`attempts + 1`,
          claimExpiresAt: new Date(leasedAt.getTime() + leaseMs),
          claimOwner: workerId,
          claimTokenHash: digest(claimToken),
          status: "leased",
          updatedAt: leasedAt,
        })
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      return {
        accountId: row.accountId,
        claimToken,
        event: NormalizedChannelEventSchema.parse(row.event),
        id: row.id,
        receivedAt: row.receivedAt,
      };
    });
  }

  /**
   * Put a leased event back. A failure backs off and counts toward the retry
   * ceiling; a deferral — nothing is wrong, the Deployment just has nowhere
   * to run it yet — comes back soon and costs no attempt, because a computer
   * that is asleep is not the message's fault.
   */
  async releaseIngress(
    id: ChannelIngressId,
    claimToken: string,
    error: string,
    options: { readonly deferred?: boolean } = {},
  ): Promise<void> {
    const observed = await this.#database
      .selectFrom("channelIngressEvents")
      .select(["attempts", "receivedAt"])
      .where("id", "=", id)
      .executeTakeFirst();
    const result = await this.#database
      .updateTable("channelIngressEvents")
      .set({
        ...(options.deferred ? { attempts: sql<number>`greatest(attempts - 1, 0)` } : {}),
        claimExpiresAt: null,
        claimOwner: null,
        claimTokenHash: null,
        lastError: error.slice(0, 2_000),
        nextAttemptAt: new Date(
          Date.now() +
            (options.deferred
              ? ingressDeferralDelayMs(observed?.receivedAt ?? null)
              : channelRetryDelayMs(observed?.attempts ?? 1, null)),
        ),
        status: "pending",
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .where("status", "=", "leased")
      .where("claimTokenHash", "=", digest(claimToken))
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw staleClaim("ingress");
  }

  /**
   * Give up on a leased event. Nothing is said in the chat: a message that starts no work gets
   * no answer.
   */
  async markIngressIgnored(
    id: ChannelIngressId,
    claimToken: string,
    reason: string,
  ): Promise<void> {
    await commitPersonalMutation(this.#database, async (transaction) => {
      const result = await transaction
        .updateTable("channelIngressEvents")
        .set({
          claimExpiresAt: null,
          claimOwner: null,
          claimTokenHash: null,
          lastError: reason.slice(0, 2_000),
          processedAt: new Date(),
          status: "ignored",
          updatedAt: new Date(),
        })
        .where("id", "=", id)
        .where("status", "=", "leased")
        .where("claimTokenHash", "=", digest(claimToken))
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw staleClaim("ingress");
    });
  }

  /**
   * The next message a messaging runtime may send: a bridge's reply or notice, in order within
   * its conversation, while the bridge is live and its account connected. A send whose lease ran
   * out may have happened: it becomes `unknown` and is never handed out again.
   */
  async claimDelivery(workerId: string, leaseMs = 30_000): Promise<ClaimedDeliveryRecord | null> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const now = new Date();
      await transaction
        .updateTable("bridgeDeliveries")
        .set({
          claimExpiresAt: null,
          claimOwner: null,
          claimTokenHash: null,
          lastError: "The send's outcome is unknown: its runtime stopped answering",
          status: "unknown",
          updatedAt: now,
        })
        .where("status", "=", "attempt-started")
        .where("claimExpiresAt", "<", now)
        .execute();
      await transaction
        .updateTable("bridgeDeliveries")
        .set({ lastError: "Channel delivery retry limit reached", status: "dead", updatedAt: now })
        .where("status", "in", ["pending", "retryable-failed"])
        .where("attempts", ">=", deliveryAttemptCeiling)
        .execute();
      await transaction
        .updateTable("bridgeDeliveries")
        .set({
          claimExpiresAt: null,
          claimOwner: null,
          claimTokenHash: null,
          status: "pending",
          updatedAt: now,
        })
        .where("status", "=", "leased")
        .where("claimExpiresAt", "<", now)
        .execute();
      const row = await transaction
        .selectFrom("bridgeDeliveries")
        .innerJoin(
          "bridgeConversations",
          "bridgeConversations.id",
          "bridgeDeliveries.conversationId",
        )
        .innerJoin("agentConnections", "agentConnections.id", "bridgeDeliveries.bridgeId")
        .innerJoin("channelAccounts", "channelAccounts.id", "bridgeDeliveries.accountId")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .select([
          "bridgeDeliveries.accountId",
          "bridgeDeliveries.attempts",
          "bridgeDeliveries.content",
          "bridgeDeliveries.conversationId",
          "bridgeDeliveries.createdAt",
          "bridgeDeliveries.id",
          "bridgeDeliveries.kind",
          "bridgeDeliveries.lastError",
          "bridgeDeliveries.messageId",
          "bridgeDeliveries.part",
          "bridgeDeliveries.partCount",
          "bridgeDeliveries.receipt",
          "bridgeDeliveries.status",
          "bridgeDeliveries.updatedAt",
          "bridgeConversations.externalConversationId",
          "bridgeConversations.externalScopeId",
          "bridgeConversations.externalThreadId",
          "channelAccounts.externalAccountId",
          "integrationConnections.credentialId",
          "integrationConnections.runnerId",
          "integrationConnections.id as connectionId",
          "integrationConnections.ownerUserId",
          "integrationConnections.provider",
        ])
        .where("bridgeDeliveries.status", "in", ["pending", "retryable-failed"])
        .where("bridgeDeliveries.nextAttemptAt", "<=", sql<Date>`statement_timestamp()`)
        // One conversation is one lane: its earliest unsent part, only while nothing in it is
        // in flight, so a reply split into parts arrives whole and in order.
        .where(
          sql<boolean>`not exists (
            select 1 from public.bridge_deliveries ahead
            where ahead.conversation_id = bridge_deliveries.conversation_id
              and (
                ahead.status in ('leased', 'attempt-started')
                or (
                  ahead.status in ('pending', 'retryable-failed')
                  and (ahead.created_at, ahead.part)
                      < (bridge_deliveries.created_at, bridge_deliveries.part)
                )
              )
          )`,
        )
        .where(liveConnection())
        .where("channelAccounts.status", "=", "connected")
        .where("integrationConnections.status", "=", "connected")
        .where("integrationConnections.runnerId", "=", workerId as RunnerId)
        .orderBy("bridgeDeliveries.createdAt", "asc")
        .orderBy("bridgeDeliveries.part", "asc")
        .forNoKeyUpdate("bridgeDeliveries")
        .skipLocked()
        .executeTakeFirst();
      if (!row?.runnerId) return null;
      const claimToken = randomBytes(32).toString("base64url");
      await transaction
        .updateTable("bridgeDeliveries")
        .set({
          claimExpiresAt: new Date(now.getTime() + leaseMs),
          claimOwner: workerId,
          claimTokenHash: digest(claimToken),
          status: "leased",
          updatedAt: now,
        })
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      return {
        claimToken,
        connection: {
          connectionId: row.connectionId,
          credentialId: row.credentialId,
          ownerUserId: row.ownerUserId,
          provider: ChannelProviderSchema.parse(row.provider),
          runnerId: row.runnerId,
        },
        delivery: ChannelDeliverySchema.parse({
          accountId: row.accountId,
          attempts: row.attempts,
          audience: "conversation",
          content: row.content,
          conversationId: row.conversationId,
          createdAt: row.createdAt.toISOString(),
          id: row.id,
          kind: row.kind,
          lastError: row.lastError,
          messageId: row.messageId,
          receipt: row.receipt,
          status: "leased",
          updatedAt: row.updatedAt.toISOString(),
        }),
        destination: {
          externalConversationId: row.externalConversationId,
          externalScopeId: row.externalScopeId,
          externalThreadId: row.externalThreadId,
          externalUserId: null,
        },
        externalAccountId: row.externalAccountId,
        // Never: a send that may have happened is not handed out again.
        mayHaveBeenSent: false,
      };
    });
  }

  /**
   * The send is about to leave the Home. Under the bridge's own row: a bridge that ended, or
   * whose transport lost the use it was set up on, never sends it, and it is known unsent. A
   * bridge that is only paused keeps it: it goes back to waiting and leaves when it resumes.
   */
  async startDeliveryAttempt(deliveryId: ChannelDeliveryId, claimToken: string): Promise<void> {
    const withdrawn = await commitPersonalMutation(this.#database, async (transaction) => {
      const delivery = await transaction
        .selectFrom("bridgeDeliveries")
        .select(["accountId", "bridgeId"])
        .where("id", "=", deliveryId)
        .executeTakeFirst();
      if (!delivery) throw staleClaim("delivery");
      // Disconnect holds this row for update: once it commits, nothing more starts.
      const bridge = await transaction
        .selectFrom("agentConnections")
        .select(["revokedAt", liveConnection().as("live"), bridgeAccountEnded.as("accountEnded")])
        .where("id", "=", delivery.bridgeId)
        .forShare("agentConnections")
        .executeTakeFirst();
      const allowed =
        bridge?.live === true && (await channelSourceAllows(transaction, delivery.accountId));
      if (!allowed) {
        const ended = !bridge || bridge.revokedAt !== null || bridge.accountEnded;
        const withdrawn = await transaction
          .updateTable("bridgeDeliveries")
          .set({
            claimExpiresAt: null,
            claimOwner: null,
            claimTokenHash: null,
            lastError: ended
              ? "The bridge ended before this was sent"
              : "The chat was paused before this was sent",
            status: ended ? "cancelled" : "pending",
            updatedAt: new Date(),
          })
          .where("id", "=", deliveryId)
          .where("status", "=", "leased")
          .where("claimTokenHash", "=", digest(claimToken))
          .executeTakeFirst();
        if (withdrawn.numUpdatedRows !== 1n) throw staleClaim("delivery");
        return true;
      }
      const result = await transaction
        .updateTable("bridgeDeliveries")
        .set({
          attempts: sql<number>`attempts + 1`,
          status: "attempt-started",
          updatedAt: new Date(),
        })
        .where("id", "=", deliveryId)
        .where("status", "=", "leased")
        .where("claimTokenHash", "=", digest(claimToken))
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw staleClaim("delivery");
      return false;
    });
    if (withdrawn) {
      throw new OpensteerError({
        code: "conflict",
        message: "Messaging authority changed before delivery",
      });
    }
  }

  /**
   * What the runtime saw. A failure the provider proves happened before sending is tried
   * again; `unknown` (it may have arrived) and `dead` are final, never retried by the Home.
   */
  async finishDelivery(input: {
    readonly claimToken: string;
    readonly deliveryId: ChannelDeliveryId;
    readonly error?: string;
    readonly outcome: "sent" | "retryable-failed" | "unknown" | "dead";
    readonly receipt?: Readonly<Record<string, unknown>>;
    readonly retryAfterMs?: number;
  }): Promise<void> {
    const now = new Date();
    const observed = await this.#database
      .selectFrom("bridgeDeliveries")
      .select("attempts")
      .where("id", "=", input.deliveryId)
      .executeTakeFirst();
    const retry =
      input.outcome === "retryable-failed"
        ? channelRetryDelayMs(observed?.attempts ?? 1, input.retryAfterMs ?? null)
        : 0;
    const result = await this.#database
      .updateTable("bridgeDeliveries")
      .set({
        claimExpiresAt: null,
        claimOwner: null,
        claimTokenHash: null,
        lastError: input.error?.slice(0, 2_000) ?? null,
        nextAttemptAt: sql<Date>`statement_timestamp() + ${retry} * interval '1 millisecond'`,
        receipt: input.receipt ? jsonValue(input.receipt) : null,
        sentAt: input.outcome === "sent" ? now : null,
        status: input.outcome,
        updatedAt: now,
      })
      .where("id", "=", input.deliveryId)
      .where("status", "=", "attempt-started")
      .where("claimTokenHash", "=", digest(input.claimToken))
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw staleClaim("delivery");
  }
}

/**
 * The app connection a computer transport is a use of, checked under its own
 * row lock: the provider's `computerApp` on that computer, the creator's, live,
 * and allowed to read and send. A channel created now shares that lock with
 * anything revoking or narrowing the app.
 */
async function requireComputerChannelSource(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly createdBy: UserId;
    readonly provider: ChannelProvider;
    readonly runnerId: RunnerId;
    readonly sourceConnectionId: IntegrationConnectionId | null;
  },
): Promise<void> {
  const manifest: ChannelProviderManifest | undefined = channelProviderCatalog.find(
    ({ provider }) => provider === input.provider,
  );
  const source = input.sourceConnectionId
    ? await transaction
        .selectFrom("integrationConnections")
        .select([
          "computerAccess",
          "connectionKind",
          "integrationDefinitionId",
          "ownerUserId",
          computerConnectionDeviceId.as("deviceId"),
          "status",
        ])
        .where("id", "=", input.sourceConnectionId)
        .forNoKeyUpdate()
        .executeTakeFirst()
    : undefined;
  if (
    !manifest?.computerApp ||
    !source ||
    source.connectionKind !== "computer" ||
    source.integrationDefinitionId !== manifest.computerApp ||
    source.ownerUserId !== input.createdBy ||
    !source.deviceId ||
    (await getDeviceSelfRunnerId(transaction, source.deviceId)) !== input.runnerId ||
    source.computerAccess !== "read-write" ||
    source.status === "revoked"
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: `${manifest?.label ?? "This channel"} needs its app on this computer, allowed to read and send.`,
    });
  }
}

export async function upsertChannelIdentity(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly accountId: ChannelAccountId;
    readonly displayName: string;
    readonly externalUserId: string;
  },
) {
  const existing = await transaction
    .selectFrom("channelIdentities")
    .selectAll()
    .where("accountId", "=", input.accountId)
    .where("externalUserId", "=", input.externalUserId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (existing) {
    if (existing.displayName !== input.displayName) {
      await transaction
        .updateTable("channelIdentities")
        .set({ displayName: input.displayName, updatedAt: new Date() })
        .where("id", "=", existing.id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("principals")
        .set({ displayName: input.displayName, updatedAt: new Date() })
        .where("id", "=", existing.principalId)
        .executeTakeFirstOrThrow();
    }
    return { ...existing, displayName: input.displayName };
  }
  const principalId = createChannelId("principal");
  const identityId = createChannelId("identity");
  await transaction
    .insertInto("principals")
    .values({
      displayName: input.displayName,
      id: principalId,
      kind: "channel-identity",
      updatedAt: new Date(),
      userId: null,
    })
    .executeTakeFirstOrThrow();
  return transaction
    .insertInto("channelIdentities")
    .values({
      accountId: input.accountId,
      displayName: input.displayName,
      externalUserId: input.externalUserId,
      id: identityId,
      linkedUserId: null,
      principalId,
      status: "unlinked",
      updatedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

function channelAccountFromRow(row: Selectable<ChannelAccountTable>): ChannelAccount {
  return ChannelAccountSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function integrationConnectionFromRow(
  row: Selectable<IntegrationConnectionTable>,
  runtimeConnected = true,
) {
  const runtimeOffline =
    !runtimeConnected && (row.status === "connected" || row.status === "pending");
  return IntegrationConnectionSchema.parse({
    capabilities: row.capabilities,
    connectionMethod: row.connectionMethod,
    createdAt: row.createdAt.toISOString(),
    displayName: row.displayName,
    externalIdentityId: row.externalIdentityId,
    externalTenantId: row.externalTenantId,
    id: row.id,
    ownerUserId: row.ownerUserId,
    provider: row.provider,
    status: runtimeOffline ? "pending" : row.status,
    statusDetail: runtimeOffline ? "Messaging service is reconnecting" : row.statusDetail,
    statusReason: runtimeOffline ? "transport" : row.statusReason,
    transportKind: row.transportKind,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** See `ingressDeferralRetryMs`: quick while somebody is still watching. */
function ingressDeferralDelayMs(receivedAt: Date | null): number {
  return receivedAt && Date.now() - receivedAt.getTime() >= ingressDeferralFreshMs
    ? ingressDeferralSlowRetryMs
    : ingressDeferralRetryMs;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function staleClaim(kind: "delivery" | "ingress"): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: `Channel ${kind} claim is stale`,
  });
}

function safeCount(value: string | number | bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new OpensteerError({ code: "internal", message: "Channel count is invalid" });
  }
  return count;
}

/**
 * Where a transport that reads a history starts, as its own inspection said
 * at setup. It is kept only until the connection is first connected: after
 * that, a Runner that lost its position has lost it, and starting over from
 * setup would replay what was already answered.
 */
function accountInitialCursor(metadata: unknown): string | null {
  const value = (metadata as { readonly initialCursor?: unknown } | null)?.initialCursor;
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}
