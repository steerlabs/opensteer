import { lockThreadChannelAuthorities } from "./channel-execution.js";
import { TransactionScopeChanged, withDatabaseTransaction } from "./connection.js";
import { prepareThreadInsertion } from "./thread-insertion.js";
import { jsonValue, lockCommandIdempotency, lockWorkspaceRow } from "./store-primitives.js";
import { createHash, randomBytes } from "node:crypto";
import {
  ChannelAccessPolicySchema,
  ChannelAccountSchema,
  ChannelBindingSchema,
  ChannelDashboardSchema,
  ChannelDeliverySchema,
  ChannelExecutionPolicySchema,
  ChannelProviderManifestSchema,
  ChannelProviderSchema,
  ChannelRouteSelectorSchema,
  ChannelTransportKindSchema,
  IntegrationConnectionSchema,
  NormalizedChannelEventSchema,
  assertUnambiguousBinding,
  channelProviderCatalog,
  createChannelId,
  resolveChannelBinding,
  type ChannelAccount,
  type ChannelAccountId,
  type ChannelAccessGrant,
  type ChannelBinding,
  type ChannelBindingId,
  type ChannelDelivery,
  type ChannelDeliveryId,
  type ChannelIdentityId,
  type ChannelIngressId,
  type ChannelProvider,
  type ChannelProviderManifest,
  type ChannelRuntimeCapability,
  type ChannelTransportKind,
  type IntegrationConnectionId,
  type NormalizedChannelEvent,
} from "@opensteer/channel-core";
import type { IntegrationConnectionMethod } from "@opensteer/integration-core";
import type { HarnessInstanceCatalog } from "@opensteer/protocol";
import {
  deriveThreadStatus,
  DEFAULT_THREAD_ACCESS_MODE,
  ModelSelectionSchema,
  OpensteerError,
  ThreadSchema,
  createId,
  nonTerminalRunStatuses,
  type AgentEvent,
  type CredentialId,
  type EnvironmentId,
  type HarnessInstanceId,
  type ModelSelection,
  type Run,
  type Thread,
  type RunnerId,
  type UserId,
  type ThreadId,
  type WorkspaceId,
} from "@opensteer/core";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import type {
  ChannelAccountTable,
  ChannelBindingTable,
  ChannelDeliveryTable,
  DatabaseSchema,
  IntegrationConnectionTable,
  ThreadTable,
} from "./schema.js";
import { executionEnvironmentIsAvailableToUser } from "./execution-authority.js";
import { appendHostWorkspaceEvent, enqueueThreadInputInTransaction } from "./store.js";
import {
  channelAccessGrantFromRow,
  channelSenderPolicy,
  ensureChannelAccessGrant,
  resolveChannelAuthority,
} from "./channel-authority.js";
import {
  channelSourceAllows,
  insertStatusDelivery,
  revokeChannelConnectionsInTransaction,
} from "./channel-deliveries.js";
import { ensureSelectedProviderSession } from "./thread-inbox.js";
import type { RevokedRunGrant } from "./run-grants.js";

class ChannelAdmissionFenceChanged extends TransactionScopeChanged {}

export interface CreateChannelConnectionInput {
  readonly accessPolicy: unknown;
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
  readonly executionPolicy: unknown;
  /**
   * Senders known to be the creator before they ever write — the handles
   * the owner texts an iMessage bot from — linked to them at once, so the
   * owner never needs a code that a stranger could be sent instead.
   */
  readonly linkedExternalUserIds?: readonly string[];
  readonly selector: unknown;
  readonly workspaceId: WorkspaceId;
}

interface ClaimedIngress {
  readonly accountId: ChannelAccountId;
  readonly claimToken: string;
  readonly event: NormalizedChannelEvent;
  readonly id: ChannelIngressId;
  readonly receivedAt: Date;
}

interface AdoptedChannelIngress {
  readonly dispatchEnvironmentId: EnvironmentId | null;
  readonly events: readonly AgentEvent[];
  readonly kind: "adopted";
  /** A restart that took the owner's message into the reply under way ended its tools. */
  readonly revokedGrants: readonly RevokedRunGrant[];
  readonly run: Run | null;
}

/**
 * Why an ingress event produced no Run. The two explicit-address reasons are
 * the ones a person is told about: they wrote to the bot and deserve an
 * answer rather than silence.
 */
export type ChannelIngressIgnoredReason =
  | "approval-pending"
  | "conversation-not-owned"
  | "conversation-owned-by-another-identity"
  | "identity-not-authorized"
  | "no-route"
  | "not-a-member"
  | "source-withdrawn";

/**
 * What the bot says when adoption declines, written by the Host because only
 * it knows the canonical origin a person signs in at and the provider's own
 * label. They are passed in rather than built here so that deciding to decline
 * and saying so are one transaction: a crash between them would leave somebody
 * who wrote to the bot with silence and no way to find out why.
 */
export interface ChannelIngressNotices {
  /** The owner must approve this provider identity before it may run. */
  readonly approvalPending: string;
  /** The provider cannot reach one person privately where they wrote. */
  readonly linkByDirectMessage: string;
  readonly linkCode: (code: string) => string;
  readonly noRoute: string;
  readonly notAMember: string;
}

interface IgnoredChannelIngress {
  /** The identity that wrote, once it has been resolved far enough to mint a code for. */
  readonly identityId: ChannelIdentityId | null;
  readonly kind: "ignored";
  readonly reason: ChannelIngressIgnoredReason;
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

const linkCodeTtlMs = 60 * 60 * 1_000;
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
/** The alphabet a person retypes from: no I, O, 0 or 1 to confuse. */
const linkAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/**
 * What an explicitly addressed message is told when its ingress ran out of
 * attempts. Nothing here knows what actually went wrong twenty times, so it
 * says the one useful thing: the answer is not coming, look in the app.
 */
const ingressDeadNotice =
  "Something went wrong while handling your message. Open Opensteer to check on it.";

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

export class ChannelIngressDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelIngressDeferredError";
  }
}

export class ChannelStore {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #providers: readonly ChannelProviderManifest[];

  constructor(
    database: Kysely<DatabaseSchema>,
    options: {
      /**
       * Where `actorDelivery` is read from. It is the shipped catalog in every
       * deployment; the seam exists so a test can exercise a provider shape
       * the catalog does not carry yet without inventing a fake provider for
       * everybody else.
       */
      readonly providers?: readonly ChannelProviderManifest[];
    } = {},
  ) {
    this.#database = database;
    this.#providers = options.providers ?? channelProviderCatalog;
  }

  async dashboard(
    ownerUserId: UserId,
    providers: readonly ChannelProviderManifest[],
    connectedRunnerIds: readonly RunnerId[],
  ): Promise<ReturnType<typeof ChannelDashboardSchema.parse>> {
    const [connections, accounts, bindings, accessGrants, attention] = await Promise.all([
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
        .selectFrom("channelBindings")
        .innerJoin("channelAccounts", "channelAccounts.id", "channelBindings.accountId")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .selectAll("channelBindings")
        .where("integrationConnections.ownerUserId", "=", ownerUserId)
        .where("channelBindings.status", "!=", "revoked")
        .orderBy("channelBindings.updatedAt", "desc")
        .limit(2_000)
        .execute(),
      this.#database
        .selectFrom("channelAccessGrants")
        .innerJoin("channelBindings", "channelBindings.id", "channelAccessGrants.bindingId")
        .innerJoin("channelAccounts", "channelAccounts.id", "channelBindings.accountId")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .selectAll("channelAccessGrants")
        .where("integrationConnections.ownerUserId", "=", ownerUserId)
        .where("integrationConnections.status", "!=", "revoked")
        .where("channelAccounts.status", "!=", "revoked")
        .where("channelBindings.status", "!=", "revoked")
        .orderBy("channelAccessGrants.requestedAt", "desc")
        .limit(10_000)
        .execute(),
      this.#database
        .selectFrom("channelDeliveries")
        .innerJoin("channelAccounts", "channelAccounts.id", "channelDeliveries.accountId")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("integrationConnections.ownerUserId", "=", ownerUserId)
        .where("channelDeliveries.status", "in", ["unknown", "dead"])
        .executeTakeFirstOrThrow(),
    ]);
    return ChannelDashboardSchema.parse({
      accessGrants: accessGrants.map(channelAccessGrantFromRow),
      accounts: accounts.map(channelAccountFromRow),
      bindings: bindings.map(channelBindingFromRow),
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

  async createConnection(input: CreateChannelConnectionInput): Promise<{
    readonly account: ChannelAccount;
    readonly binding: ChannelBinding;
    readonly connection: ReturnType<typeof IntegrationConnectionSchema.parse>;
  }> {
    const selector = ChannelRouteSelectorSchema.parse(input.selector);
    const executionPolicy = ChannelExecutionPolicySchema.parse(input.executionPolicy);
    const accessPolicy = ChannelAccessPolicySchema.parse(input.accessPolicy);
    if (
      input.account.routingMode === "dedicated" &&
      Object.values(selector).some((value) => value !== null)
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: "A dedicated messaging identity must use one account-wide Workspace binding",
      });
    }
    return withDatabaseTransaction(this.#database, async (transaction) => {
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
      await lockWorkspaceRow(transaction, input.workspaceId);
      await requireWorkspaceOwner(transaction, input.workspaceId, input.createdBy);
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
          applicationSource: null,
          authMethodId: null,
          capabilities: jsonValue(input.connection.capabilities ?? []),
          computerAccess: null,
          runnerId: input.connection.runnerId,
          connectionKind: "channel",
          connectionMethod: input.connection.connectionMethod,
          credentialId: input.credential?.id ?? null,
          displayName: input.connection.displayName,
          externalIdentityId,
          externalTenantId: input.connection.externalTenantId ?? null,
          grantedScopes: jsonValue([]),
          id: createChannelId("connection"),
          integrationDefinitionId: null,
          ownerUserId: input.createdBy,
          provider: input.connection.provider,
          providerApplicationId: null,
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
      for (const externalUserId of new Set(input.linkedExternalUserIds ?? [])) {
        const identity = await upsertChannelIdentity(transaction, {
          accountId: accountRow.id,
          displayName: externalUserId,
          externalUserId,
        });
        await transaction
          .updateTable("channelIdentities")
          .set({ linkedUserId: input.createdBy, status: "linked", updatedAt: now })
          .where("id", "=", identity.id)
          .executeTakeFirstOrThrow();
      }
      const bindingRow = await transaction
        .insertInto("channelBindings")
        .values({
          accessPolicy: jsonValue(accessPolicy),
          accountId: accountRow.id,
          createdBy: input.createdBy,
          executionPolicy: jsonValue(executionPolicy),
          id: createChannelId("binding"),
          revision: 1,
          selector: jsonValue(selector),
          status: "active",
          updatedAt: now,
          workspaceId: input.workspaceId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        account: channelAccountFromRow(accountRow),
        binding: channelBindingFromRow(bindingRow),
        connection: integrationConnectionFromRow(connectionRow),
      };
    });
  }

  async createBinding(input: {
    readonly accessPolicy: unknown;
    readonly accountId: ChannelAccountId;
    readonly createdBy: UserId;
    readonly executionPolicy: unknown;
    readonly selector: unknown;
    readonly workspaceId: WorkspaceId;
  }): Promise<ChannelBinding> {
    const selector = ChannelRouteSelectorSchema.parse(input.selector);
    const executionPolicy = ChannelExecutionPolicySchema.parse(input.executionPolicy);
    const accessPolicy = ChannelAccessPolicySchema.parse(input.accessPolicy);
    return withDatabaseTransaction(this.#database, async (transaction) => {
      await lockWorkspaceRow(transaction, input.workspaceId);
      await requireWorkspaceOwner(transaction, input.workspaceId, input.createdBy);
      const account = await ownedAccount(transaction, input.accountId, input.createdBy);
      if (account.routingMode === "dedicated") {
        throw new OpensteerError({
          code: "conflict",
          message: "A dedicated messaging identity has exactly one Workspace binding",
        });
      }
      const existing = await transaction
        .selectFrom("channelBindings")
        .selectAll()
        .where("accountId", "=", account.id)
        .where("status", "!=", "revoked")
        .forNoKeyUpdate()
        .execute();
      const id = createChannelId("binding");
      assertUnambiguousBinding(
        { id, selector, status: "active" },
        existing.map(channelBindingFromRow),
      );
      const row = await transaction
        .insertInto("channelBindings")
        .values({
          accessPolicy: jsonValue(accessPolicy),
          accountId: input.accountId,
          createdBy: input.createdBy,
          executionPolicy: jsonValue(executionPolicy),
          id,
          revision: 1,
          selector: jsonValue(selector),
          status: "active",
          updatedAt: new Date(),
          workspaceId: input.workspaceId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return channelBindingFromRow(row);
    });
  }

  async updateBinding(input: {
    readonly accessPolicy: unknown;
    readonly bindingId: ChannelBindingId;
    readonly expectedRevision: number;
    readonly ownerUserId: UserId;
  }): Promise<ChannelBinding> {
    const accessPolicy = ChannelAccessPolicySchema.parse(input.accessPolicy);
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const binding = await ownedBinding(transaction, input.bindingId, input.ownerUserId);
      await requireWorkspaceOwner(transaction, binding.workspaceId, input.ownerUserId);
      if (binding.revision !== input.expectedRevision) {
        throw new OpensteerError({
          code: "conflict",
          message: "Channel access policy changed while it was being edited",
        });
      }
      const now = new Date();
      const row = await transaction
        .updateTable("channelBindings")
        .set({
          accessPolicy: jsonValue(accessPolicy),
          revision: binding.revision + 1,
          updatedAt: now,
        })
        .where("id", "=", input.bindingId)
        .where("revision", "=", input.expectedRevision)
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw new OpensteerError({
          code: "conflict",
          message: "Channel access policy changed while it was being edited",
        });
      }
      await cancelStaleChannelInputs(transaction, input.bindingId, row.revision, now);
      return channelBindingFromRow(row);
    });
  }

  async reviewAccess(input: {
    readonly bindingId: ChannelBindingId;
    readonly decision: "approved" | "declined" | "revoked";
    readonly expectedRevision: number;
    readonly externalUserId: string;
    readonly ownerUserId: UserId;
  }): Promise<ChannelAccessGrant> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const binding = await ownedBinding(transaction, input.bindingId, input.ownerUserId);
      await requireWorkspaceOwner(transaction, binding.workspaceId, input.ownerUserId);
      const grant = await transaction
        .selectFrom("channelAccessGrants")
        .selectAll()
        .where("bindingId", "=", input.bindingId)
        .where("externalUserId", "=", input.externalUserId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!grant) {
        throw new OpensteerError({
          code: "not_found",
          message: "Channel access request not found",
        });
      }
      if (grant.revision !== input.expectedRevision) {
        throw new OpensteerError({
          code: "conflict",
          message: "Channel access request changed while it was being reviewed",
        });
      }
      const now = new Date();
      const row = await transaction
        .updateTable("channelAccessGrants")
        .set({
          decidedAt: now,
          decidedBy: input.ownerUserId,
          revision: grant.revision + 1,
          status: input.decision,
          updatedAt: now,
        })
        .where("bindingId", "=", input.bindingId)
        .where("externalUserId", "=", input.externalUserId)
        .where("revision", "=", input.expectedRevision)
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw new OpensteerError({
          code: "conflict",
          message: "Channel access request changed while it was being reviewed",
        });
      }
      const identity = await transaction
        .selectFrom("channelIdentities")
        .select("principalId")
        .where("accountId", "=", row.accountId)
        .where("externalUserId", "=", row.externalUserId)
        .executeTakeFirstOrThrow();
      await cancelChannelInputsForPrincipal(
        transaction,
        input.bindingId,
        identity.principalId,
        now,
      );
      if (row.requestIngressId) {
        const text =
          input.decision === "approved"
            ? "Your access was approved. Send your message again to start work."
            : input.decision === "declined"
              ? "Your access request was declined."
              : "Your access was revoked.";
        await insertStatusDelivery(transaction, {
          accountId: row.accountId,
          audience: "actor",
          conversationId: null,
          ingressId: row.requestIngressId,
          text,
        });
      }
      return channelAccessGrantFromRow(row);
    });
  }

  async setConnectionStatus(
    connectionId: IntegrationConnectionId,
    ownerUserId: UserId,
    status: "connected" | "paused" | "revoked",
  ): Promise<void> {
    await withDatabaseTransaction(this.#database, async (transaction) => {
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
    });
  }

  /**
   * Retire one route. Conversations already pinned to it decline with
   * `no-route` on their next message, which is answered the same way any
   * unrouted conversation is, so nothing has to be torn down here.
   */
  async revokeBinding(input: {
    readonly bindingId: ChannelBindingId;
    readonly ownerUserId: UserId;
  }): Promise<void> {
    await withDatabaseTransaction(this.#database, async (transaction) => {
      const binding = await transaction
        .selectFrom("channelBindings")
        .innerJoin("channelAccounts", "channelAccounts.id", "channelBindings.accountId")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .select("channelBindings.id")
        .where("channelBindings.id", "=", input.bindingId)
        .where("channelBindings.status", "!=", "revoked")
        .where("integrationConnections.ownerUserId", "=", input.ownerUserId)
        .forNoKeyUpdate("channelBindings")
        .executeTakeFirst();
      if (!binding) {
        throw new OpensteerError({ code: "not_found", message: "Channel route not found" });
      }
      await transaction
        .updateTable("channelBindings")
        .set({ status: "revoked", updatedAt: new Date() })
        .where("id", "=", input.bindingId)
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * Redeem a link code as the signed-in user. Redemption requires an
   * authenticated session and the code lives one hour in a 32^8 keyspace, so
   * guessing is not a threat worth a lockout.
   */
  async linkIdentity(input: { readonly codeHash: string; readonly userId: UserId }): Promise<{
    readonly account: ChannelAccount;
    readonly identity: { readonly displayName: string; readonly externalUserId: string };
  }> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const now = new Date();
      const observedCode = await transaction
        .selectFrom("channelLinkCodes")
        .selectAll()
        .where("codeHash", "=", input.codeHash)
        .where("consumedAt", "is", null)
        .where("expiresAt", ">", now)
        .executeTakeFirst();
      if (!observedCode) {
        throw new OpensteerError({
          code: "not_found",
          message: "That code is invalid or has expired.",
        });
      }
      const identity = await transaction
        .selectFrom("channelIdentities")
        .selectAll()
        .where("id", "=", observedCode.identityId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const code = await transaction
        .selectFrom("channelLinkCodes")
        .selectAll()
        .where("codeHash", "=", input.codeHash)
        .where("consumedAt", "is", null)
        .where("expiresAt", ">", now)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!code) {
        throw new OpensteerError({
          code: "not_found",
          message: "That code is invalid or has expired.",
        });
      }
      if (identity.linkedUserId && identity.linkedUserId !== input.userId) {
        throw new OpensteerError({
          code: "conflict",
          message: "That messaging account is already linked to another person",
        });
      }
      await transaction
        .updateTable("channelIdentities")
        .set({ linkedUserId: input.userId, status: "linked", updatedAt: now })
        .where("id", "=", identity.id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("channelLinkCodes")
        .set({ consumedAt: now, userId: input.userId })
        .where("id", "=", code.id)
        .executeTakeFirstOrThrow();
      const account = await transaction
        .selectFrom("channelAccounts")
        .selectAll()
        .where("id", "=", code.accountId)
        .executeTakeFirstOrThrow();
      if (code.requestIngressId) {
        await insertStatusDelivery(transaction, {
          accountId: code.accountId,
          audience: "actor",
          conversationId: null,
          ingressId: code.requestIngressId,
          text: "Your messaging identity is linked. Send your message again to start work.",
        });
      }
      return {
        account: channelAccountFromRow(account),
        identity: { displayName: identity.displayName, externalUserId: identity.externalUserId },
      };
    });
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
    const deliveries = await this.#database
      .deleteFrom("channelDeliveries")
      .where("status", "in", ["sent", "dead"])
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
    const row = await this.#database
      .selectFrom("integrationConnections")
      .select("id")
      .where("connectionKind", "=", "computer")
      .where("integrationDefinitionId", "=", input.definitionId)
      .where("ownerUserId", "=", input.ownerUserId)
      .where("runnerId", "=", input.runnerId)
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
    await withDatabaseTransaction(this.#database, async (transaction) => {
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
  ): Promise<{
    readonly accountId: ChannelAccountId;
    readonly duplicate: boolean;
    readonly ingressId: ChannelIngressId;
  }> {
    const event = NormalizedChannelEventSchema.parse(eventInput);
    return withDatabaseTransaction(this.#database, async (transaction) => {
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

  async claimIngress(workerId: string, leaseMs = 30_000): Promise<ClaimedIngress | null> {
    await withDatabaseTransaction(this.#database, async (transaction) => {
      const now = new Date();
      const maintenance = await transaction
        .selectFrom("channelIngressEvents")
        .select("id")
        .where((eb) =>
          eb.or([
            eb.and([eb("status", "=", "leased"), eb("claimExpiresAt", "<", now)]),
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
        .where("claimExpiresAt", "<", now)
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
        .returning(["accountId", "event", "id"])
        .execute();
      for (const row of dead) {
        if (NormalizedChannelEventSchema.parse(row.event).trigger === "conversation-followup") {
          continue;
        }
        await insertStatusDelivery(transaction, {
          accountId: row.accountId,
          audience: "actor",
          conversationId: null,
          ingressId: row.id,
          text: ingressDeadNotice,
        });
      }
    });
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const now = new Date();
      // One conversation is one lane: the oldest pending event in it, and only
      // while nothing else in that lane is in flight. Two messages a person
      // sent in order must reach their Thread in that order, and a global
      // queue cannot promise that.
      const row = await transaction
        .selectFrom("channelIngressEvents as claimable")
        .selectAll("claimable")
        .where("claimable.status", "=", "pending")
        .where("claimable.nextAttemptAt", "<=", now)
        .where(
          sql<boolean>`not exists (
            select 1 from public.channel_ingress_events ahead
            where ahead.lane_key = claimable.lane_key
              and (
                ahead.status = 'leased'
                or (ahead.status = 'pending' and ahead.received_at < claimable.received_at)
              )
          )`,
        )
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
          claimExpiresAt: new Date(now.getTime() + leaseMs),
          claimOwner: workerId,
          claimTokenHash: digest(claimToken),
          status: "leased",
          updatedAt: now,
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
   * Give up on a leased event, and say so in the same transaction. Marking it
   * ignored and telling the person are one write for the same reason adoption's
   * own declines are: a crash between the two would leave somebody who wrote to
   * the bot with silence and a row that says the matter is closed.
   */
  async markIngressIgnored(
    id: ChannelIngressId,
    claimToken: string,
    reason: string,
    notice: { readonly accountId: ChannelAccountId; readonly text: string } | null = null,
  ): Promise<void> {
    await withDatabaseTransaction(this.#database, async (transaction) => {
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
      if (!notice) return;
      await insertStatusDelivery(transaction, {
        accountId: notice.accountId,
        audience: "actor",
        conversationId: null,
        ingressId: id,
        text: notice.text,
      });
    });
  }

  /**
   * `placementCandidates` are the work locations the Host found an AI engine
   * for, in preference order. Which one the message actually lands on can only
   * be decided here, after the channel identity has been resolved to a user:
   * choosing it outside the transaction would place one person's message on
   * another person's Runner, and the Thread execution-authority trigger
   * would reject the insert on every retry, forever.
   */
  async adoptIngress(input: {
    readonly claimToken: string;
    readonly ingressId: ChannelIngressId;
    readonly notices: ChannelIngressNotices;
    readonly placementCandidates: readonly {
      readonly environmentId: EnvironmentId;
      readonly harnessInstanceId: HarnessInstanceId;
    }[];
  }): Promise<AdoptedChannelIngress | IgnoredChannelIngress> {
    return withDatabaseTransaction(
      this.#database,
      async (transaction) => {
        const ingress = await transaction
          .selectFrom("channelIngressEvents")
          .selectAll()
          .where("id", "=", input.ingressId)
          .where("status", "=", "leased")
          .where("claimTokenHash", "=", digest(input.claimToken))
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!ingress) throw staleClaim("ingress");
        await sql`select pg_advisory_xact_lock(hashtextextended(${ingress.laneKey}, 0))`.execute(
          transaction,
        );
        const event = NormalizedChannelEventSchema.parse(ingress.event);
        // A channel that lost the use it was set up on answers nobody, and says
        // nothing: its transport, not the person writing, is what changed.
        if (!(await channelSourceAllows(transaction, ingress.accountId, false))) {
          await finishIgnored(
            transaction,
            ingress.id,
            "The computer's app connection no longer allows this channel",
          );
          return { identityId: null, kind: "ignored", reason: "source-withdrawn" };
        }
        const observedConversation = await transaction
          .selectFrom("channelConversations")
          .selectAll()
          .where("provider", "=", event.provider)
          .where("externalAccountId", "=", event.accountExternalId)
          .where(
            sql<boolean>`external_scope_id is not distinct from ${event.conversation.externalScopeId}`,
          )
          .where("externalConversationId", "=", event.conversation.externalConversationId)
          .where(
            sql<boolean>`external_thread_id is not distinct from ${event.conversation.externalThreadId}`,
          )
          .executeTakeFirst();

        if (observedConversation && observedConversation.accountId !== ingress.accountId) {
          await finishIgnored(
            transaction,
            ingress.id,
            "This provider conversation belongs to another messaging identity",
          );
          return {
            identityId: null,
            kind: "ignored",
            reason: "conversation-owned-by-another-identity",
          };
        }
        if (!observedConversation && event.trigger === "conversation-followup") {
          await finishIgnored(
            transaction,
            ingress.id,
            "No messaging identity owns this provider conversation",
          );
          return { identityId: null, kind: "ignored", reason: "conversation-not-owned" };
        }

        let existingConversation = observedConversation;

        let binding: ChannelBinding | null;
        if (existingConversation) {
          const row = await transaction
            .selectFrom("channelBindings")
            .selectAll()
            .where("id", "=", existingConversation.bindingId)
            .where("status", "=", "active")
            .executeTakeFirst();
          binding = row ? channelBindingFromRow(row) : null;
        } else {
          const candidates = await transaction
            .selectFrom("channelBindings")
            .selectAll()
            .where("accountId", "=", ingress.accountId)
            .where("status", "=", "active")
            .execute();
          binding = resolveChannelBinding(candidates.map(channelBindingFromRow), {
            conversationId: event.conversation.externalConversationId,
            conversationType: event.conversation.type,
            scopeId: event.conversation.externalScopeId,
            threadId: event.conversation.externalThreadId,
          });
        }
        // Every decline from here on is written and answered in this one
        // transaction. A person who addressed the bot hears exactly one thing
        // about it, or the whole decision rolls back and is taken again.
        const addressed = event.trigger !== "conversation-followup";
        if (!binding) {
          await finishIgnored(
            transaction,
            ingress.id,
            "No channel route matched this conversation",
          );
          if (addressed) {
            await insertStatusDelivery(transaction, {
              accountId: ingress.accountId,
              audience: "actor",
              conversationId: null,
              ingressId: ingress.id,
              text: input.notices.noRoute,
            });
          }
          return { identityId: null, kind: "ignored", reason: "no-route" };
        }

        const observedIdentity = await transaction
          .selectFrom("channelIdentities")
          .select(["id", "linkedUserId"])
          .where("accountId", "=", ingress.accountId)
          .where("externalUserId", "=", event.actor.externalUserId)
          .executeTakeFirst();
        const commandUsers = [
          ...new Set(
            [binding.createdBy, observedIdentity?.linkedUserId].filter(
              (id): id is UserId => id != null,
            ),
          ),
        ].sort();
        const commandKey = `channel:${ingress.accountId}:${event.eventId}`;
        for (const userId of commandUsers)
          await lockCommandIdempotency(transaction, userId, commandKey);
        const observedWorkspaceId = binding.workspaceId;

        // Thread Inbox steering locks a target Run before Workspace/Thread rows.
        // Existing channel conversations participate in that same order so the
        // later atomic inbox admission can safely re-lock the observed Run.
        let activeThreadIds: ThreadId[] = [];
        if (observedConversation) {
          const activeContextThreads = await transaction
            .selectFrom("channelConversationContexts")
            .select("activeThreadId")
            .where("conversationId", "=", observedConversation.id)
            .where("activeThreadId", "is not", null)
            .execute();
          activeThreadIds = activeContextThreads
            .map(({ activeThreadId }) => activeThreadId)
            .filter((id): id is NonNullable<typeof id> => id !== null)
            .sort();
          if (activeThreadIds.length > 0) {
            await transaction
              .selectFrom("runs")
              .select("id")
              .where("threadId", "in", activeThreadIds)
              .where("status", "in", nonTerminalRunStatuses)
              .orderBy("id", "asc")
              .forNoKeyUpdate()
              .execute();
          }
        }
        // Acquisition follows ./lock-order.ts after the ingress/lane claim.
        // Routing is first observed without a row lock solely to learn which
        // Workspace to lock; the binding is then refreshed under its durable
        // lock before any policy or grant decision is made.
        const lockedWorkspace = await transaction
          .selectFrom("workspaces")
          .select(["createdBy", "id", "kind", "status"])
          .where("id", "=", binding.workspaceId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!lockedWorkspace) {
          throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
        }
        await transaction
          .selectFrom("workspaceMemberships")
          .select("id")
          .where("workspaceId", "=", binding.workspaceId)
          .where("userId", "in", commandUsers)
          .orderBy("id", "asc")
          .forNoKeyUpdate()
          .execute();
        // Placement fences precede channel authority, including grant approvals.
        // The lane and Workspace protect the discovered conversation set.
        const candidateHarnessIds = [
          ...new Set([
            ...input.placementCandidates.flatMap((candidate) =>
              candidate.harnessInstanceId ? [candidate.harnessInstanceId] : [],
            ),
            ...(binding.executionPolicy.harness === "specific"
              ? [binding.executionPolicy.harnessInstanceId]
              : []),
          ]),
        ];
        const candidateEnvironmentIds = [
          ...new Set(input.placementCandidates.map((candidate) => candidate.environmentId)),
        ];
        if (candidateEnvironmentIds.length)
          await transaction
            .selectFrom("executionEnvironments")
            .select("id")
            .where("id", "in", candidateEnvironmentIds)
            .orderBy("id", "asc")
            .forShare()
            .execute();
        if (candidateHarnessIds.length)
          await transaction
            .selectFrom("harnessInstances")
            .select("id")
            .where("id", "in", candidateHarnessIds)
            .orderBy("id", "asc")
            .forShare()
            .execute();
        await lockThreadChannelAuthorities(transaction, activeThreadIds, {
          bindingId: binding.id,
          ...(observedIdentity ? { identityId: observedIdentity.id } : {}),
        });
        if (!(await channelSourceAllows(transaction, ingress.accountId))) {
          await finishIgnored(
            transaction,
            ingress.id,
            "The computer's app connection no longer allows this channel",
          );
          return { identityId: null, kind: "ignored", reason: "source-withdrawn" };
        }
        const connection = await transaction
          .selectFrom("channelAccounts")
          .innerJoin(
            "integrationConnections",
            "integrationConnections.id",
            "channelAccounts.connectionId",
          )
          .select([
            "channelAccounts.status as accountStatus",
            "integrationConnections.status as connectionStatus",
          ])
          .where("channelAccounts.id", "=", ingress.accountId)
          .forShare("channelAccounts")
          .executeTakeFirst();
        if (
          !connection ||
          connection.accountStatus !== "connected" ||
          !["pending", "connected", "needs-attention"].includes(connection.connectionStatus)
        ) {
          await finishIgnored(transaction, ingress.id, "The messaging connection is not active");
          return { identityId: null, kind: "ignored", reason: "no-route" };
        }
        const lockedBinding = await transaction
          .selectFrom("channelBindings")
          .selectAll()
          .where("id", "=", binding.id)
          .where("status", "=", "active")
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!lockedBinding) {
          await finishIgnored(transaction, ingress.id, "The channel route is no longer active");
          if (addressed) {
            await insertStatusDelivery(transaction, {
              accountId: ingress.accountId,
              audience: "actor",
              conversationId: null,
              ingressId: ingress.id,
              text: input.notices.noRoute,
            });
          }
          return { identityId: null, kind: "ignored", reason: "no-route" };
        }
        if (
          lockedBinding.workspaceId !== observedWorkspaceId ||
          !commandUsers.includes(lockedBinding.createdBy)
        ) {
          throw new ChannelAdmissionFenceChanged(
            "Channel route authority changed during discovery",
          );
        }
        binding = channelBindingFromRow(lockedBinding);

        const senderPolicy = channelSenderPolicy(binding, event.conversation);
        if (!senderPolicy || senderPolicy.mode === "off") {
          await finishIgnored(
            transaction,
            ingress.id,
            "This conversation is outside the route access policy",
          );
          if (addressed) {
            await insertStatusDelivery(transaction, {
              accountId: ingress.accountId,
              audience: "actor",
              conversationId: null,
              ingressId: ingress.id,
              text: input.notices.noRoute,
            });
          }
          return { identityId: null, kind: "ignored", reason: "no-route" };
        }

        const identity = await upsertChannelIdentity(transaction, {
          accountId: ingress.accountId,
          displayName: event.actor.displayName,
          externalUserId: event.actor.externalUserId,
        });
        if (identity.linkedUserId && !commandUsers.includes(identity.linkedUserId)) {
          throw new ChannelAdmissionFenceChanged("Channel identity changed during discovery");
        }
        if (
          senderPolicy.mode === "approved" &&
          identity.linkedUserId !== binding.createdBy &&
          (senderPolicy.allowedExternalUserIds.length === 0 ||
            senderPolicy.allowedExternalUserIds.includes(identity.externalUserId))
        ) {
          const approval = await ensureChannelAccessGrant(transaction, {
            binding,
            displayName: identity.displayName,
            externalUserId: identity.externalUserId,
            ingressId: ingress.id,
          });
          if (approval.grant.status !== "approved") {
            await finishIgnored(
              transaction,
              ingress.id,
              `Channel access is ${approval.grant.status}`,
            );
            if (addressed && approval.grant.status === "pending") {
              await insertStatusDelivery(transaction, {
                accountId: ingress.accountId,
                audience: "actor",
                conversationId: null,
                ingressId: ingress.id,
                text: input.notices.approvalPending,
              });
            }
            return { identityId: identity.id, kind: "ignored", reason: "approval-pending" };
          }
        }
        const senderIsAllowed =
          senderPolicy.allowedExternalUserIds.length === 0 ||
          senderPolicy.allowedExternalUserIds.includes(identity.externalUserId);
        const eligibleAuthorityUserId = !senderIsAllowed
          ? null
          : senderPolicy.mode === "linked-members"
            ? identity.linkedUserId
            : senderPolicy.mode === "owner"
              ? identity.linkedUserId === binding.createdBy
                ? binding.createdBy
                : null
              : binding.createdBy;
        const authority = await resolveChannelAuthority(
          transaction,
          binding,
          identity,
          event.conversation,
        );
        if (!authority) {
          if (eligibleAuthorityUserId) {
            const inactiveMembership = await transaction
              .selectFrom("workspaceMemberships")
              .select("state")
              .where("workspaceId", "=", binding.workspaceId)
              .where("userId", "=", eligibleAuthorityUserId)
              .forNoKeyUpdate()
              .executeTakeFirst();
            if (!inactiveMembership || inactiveMembership.state !== "active") {
              await finishIgnored(
                transaction,
                ingress.id,
                "The resolved user is not an active member of the routed Workspace",
              );
              if (addressed) {
                await insertStatusDelivery(transaction, {
                  accountId: ingress.accountId,
                  audience: "actor",
                  conversationId: null,
                  ingressId: ingress.id,
                  text: input.notices.notAMember,
                });
              }
              return { identityId: identity.id, kind: "ignored", reason: "not-a-member" };
            }
          }
          await finishIgnored(
            transaction,
            ingress.id,
            "Channel identity must be linked before it can invoke this Workspace",
          );
          if (addressed) {
            await this.#offerLinking(transaction, {
              accountId: ingress.accountId,
              conversationType: event.conversation.type,
              identityId: identity.id,
              ingressId: ingress.id,
              notices: input.notices,
              provider: event.provider,
            });
          }
          return { identityId: identity.id, kind: "ignored", reason: "identity-not-authorized" };
        }
        const membership = await transaction
          .selectFrom("workspaceMemberships")
          .select([
            "workspaceMemberships.generation",
            "workspaceMemberships.role",
            "workspaceMemberships.state",
          ])
          .where("workspaceMemberships.workspaceId", "=", binding.workspaceId)
          .where("workspaceMemberships.userId", "=", authority.userId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        // Authority resolved to somebody who is no longer in the Workspace this
        // route points at. That is a configuration answer, not a transient one,
        // so it declines and says so rather than retrying until the ceiling.
        if (!membership || membership.state !== "active") {
          await finishIgnored(
            transaction,
            ingress.id,
            "The resolved user is not an active member of the routed Workspace",
          );
          if (addressed) {
            await insertStatusDelivery(transaction, {
              accountId: ingress.accountId,
              audience: "actor",
              conversationId: null,
              ingressId: ingress.id,
              text: input.notices.notAMember,
            });
          }
          return { identityId: identity.id, kind: "ignored", reason: "not-a-member" };
        }
        if (lockedWorkspace.status !== "ready") {
          throw new ChannelIngressDeferredError("Workspace storage is not ready");
        }
        let placement: (typeof input.placementCandidates)[number] | undefined;
        for (const candidate of input.placementCandidates) {
          if (
            await executionEnvironmentIsAvailableToUser(
              transaction,
              candidate.environmentId,
              authority.userId,
            )
          ) {
            placement = candidate;
            break;
          }
        }
        if (!placement) {
          throw new ChannelIngressDeferredError("No work location is available with an AI engine");
        }
        const selectedHarnessId =
          binding.executionPolicy.harness === "specific"
            ? binding.executionPolicy.harnessInstanceId
            : placement.harnessInstanceId;
        if (!selectedHarnessId) {
          throw new OpensteerError({
            code: "internal",
            message: "Channel harness policy is invalid",
          });
        }
        const selectedHarness = await transaction
          .selectFrom("harnessInstances")
          .select(["enabled", "environmentId"])
          .where("id", "=", selectedHarnessId)
          .executeTakeFirst();
        if (!selectedHarness?.enabled) {
          throw new ChannelIngressDeferredError("Selected AI engine is unavailable");
        }
        if (selectedHarness.environmentId !== placement.environmentId) {
          const matchingPlacement = input.placementCandidates.find(
            (candidate) => candidate.environmentId === selectedHarness.environmentId,
          );
          if (
            !matchingPlacement ||
            !(await executionEnvironmentIsAvailableToUser(
              transaction,
              matchingPlacement.environmentId,
              authority.userId,
            ))
          ) {
            throw new ChannelIngressDeferredError(
              "Selected AI engine belongs to an unavailable work location",
            );
          }
          placement = matchingPlacement;
        }
        const insertThread = await prepareThreadInsertion(transaction, {
          createdBy: authority.userId,
          environmentId: placement.environmentId,
          harnessInstanceId: selectedHarnessId,
        }).catch((error: unknown) => {
          if (error instanceof OpensteerError) throw new ChannelIngressDeferredError(error.message);
          throw error;
        });
        const storedCatalog = await transaction
          .selectFrom("harnessCatalogs")
          .select("catalog")
          .where("environmentId", "=", placement.environmentId)
          .where("harnessInstanceId", "=", selectedHarnessId)
          .executeTakeFirst();
        const selectedModel = modelSelectionFromCatalog(storedCatalog?.catalog ?? null);

        if (observedConversation) {
          existingConversation = await transaction
            .selectFrom("channelConversations")
            .selectAll()
            .where("id", "=", observedConversation.id)
            .forNoKeyUpdate()
            .executeTakeFirstOrThrow();
          if (
            existingConversation.accountId !== observedConversation.accountId ||
            existingConversation.bindingId !== observedConversation.bindingId ||
            existingConversation.workspaceId !== observedConversation.workspaceId
          ) {
            throw new OpensteerError({
              code: "conflict",
              message: "Channel conversation routing changed during adoption",
            });
          }
        }
        let conversation = existingConversation;
        if (!conversation) {
          conversation = await transaction
            .insertInto("channelConversations")
            .values({
              accountId: ingress.accountId,
              activeThreadId: null,
              bindingId: binding.id,
              bindingRevision: binding.revision,
              conversationType: event.conversation.type,
              displayName: event.conversation.displayName,
              externalAccountId: event.accountExternalId,
              externalConversationId: event.conversation.externalConversationId,
              externalScopeId: event.conversation.externalScopeId,
              externalThreadId: event.conversation.externalThreadId,
              id: createChannelId("conversation"),
              provider: event.provider,
              providerState: jsonValue({}),
              updatedAt: new Date(),
              workspaceId: binding.workspaceId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        const context = await transaction
          .selectFrom("channelConversationContexts")
          .selectAll()
          .where("conversationId", "=", conversation.id)
          .where("authorityUserId", "=", authority.userId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        let thread =
          context?.bindingRevision === binding.revision && context.activeThreadId
            ? await transaction
                .selectFrom("threads")
                .selectAll()
                .where("id", "=", context.activeThreadId)
                .forNoKeyUpdate()
                .executeTakeFirst()
            : undefined;
        // A person writing to their own bot in a direct message is themself, so
        // in their own Main that is their Home agent. Everyone else — an admitted
        // stranger, a channel, even the owner in a conversation others share —
        // runs as the route's creator without being them, below Main.
        const capabilityProfileId =
          event.conversation.type === "dm" &&
          identity.linkedUserId === authority.userId &&
          lockedWorkspace.kind === "main" &&
          lockedWorkspace.createdBy === authority.userId
            ? "main"
            : "workspace";
        const rotate =
          !thread ||
          thread.status === "archived" ||
          thread.capabilityProfileId !== capabilityProfileId ||
          thread.environmentId !== placement.environmentId ||
          thread.harnessInstanceId !== selectedHarnessId;
        const events: AgentEvent[] = [];
        if (rotate) {
          const threadId = createId("thread");
          const threadRow = await insertThread({
            accessMode: thread?.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
            // A messaging context never inherits another Thread's history:
            // every rotation, including a change of profile, is a fresh root.
            capabilityProfileId,
            role: capabilityProfileId === "main" ? "conversation" : "work",
            createdByPrincipalId: identity.principalId,
            id: threadId,
            lineageRootThreadId: threadId,
            listed: true,
            modelSelection: jsonValue(selectedModel),
            parentThreadId: null,
            status: deriveThreadStatus({
              earliestActiveRunStatus: null,
              inputQueuePaused: false,
              lastRunFailed: false,
            }),
            title: channelThreadTitle(event, this.#manifest(event.provider)?.label ?? null),
            titleSource: "chosen",
            icon: null,
            iconSource: "provisional",
            workspaceId: lockedWorkspace.id,
          });
          thread = threadRow;
          const providerSessionId = await ensureSelectedProviderSession(transaction, threadRow);
          events.push(
            await appendHostWorkspaceEvent(transaction, {
              data: { thread: threadFromRow(thread, providerSessionId) },
              environmentId: thread.environmentId,
              runId: null,
              threadId: thread.id,
              type: "thread.created",
              workspaceId: thread.workspaceId,
            }),
          );
        }
        if (!thread) {
          throw new OpensteerError({ code: "internal", message: "Channel Thread was not created" });
        }
        const now = new Date();
        await transaction
          .insertInto("channelConversationContexts")
          .values({
            activeThreadId: thread.id,
            authorityUserId: authority.userId,
            bindingRevision: binding.revision,
            conversationId: conversation.id,
            updatedAt: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["conversationId", "authorityUserId"]).doUpdateSet({
              activeThreadId: thread.id,
              bindingRevision: binding.revision,
              updatedAt: now,
            }),
          )
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("channelConversations")
          .set({
            activeThreadId: thread.id,
            bindingRevision: binding.revision,
            updatedAt: now,
          })
          .where("id", "=", conversation.id)
          .executeTakeFirstOrThrow();

        // Bind the leased ingress to its authoritative conversation before the
        // shared Thread Inbox validates and authors the input. The transaction
        // keeps this invisible until adoption commits, while the inbox never has
        // to trust caller-supplied routing facts.
        await transaction
          .updateTable("channelIngressEvents")
          .set({ conversationId: conversation.id, updatedAt: new Date() })
          .where("id", "=", ingress.id)
          .where("status", "=", "leased")
          .executeTakeFirstOrThrow();

        const accepted = await enqueueThreadInputInTransaction(transaction, {
          content: event.content,
          idempotencyKey: commandKey,
          policy: "queue",
          requestedBy: authority.userId,
          source: {
            conversationId: conversation.id,
            ingressId: ingress.id,
            kind: "channel",
            principalId: identity.principalId,
          },
          threadId: thread.id,
        });
        await transaction
          .updateTable("channelIngressEvents")
          .set({
            claimExpiresAt: null,
            claimOwner: null,
            claimTokenHash: null,
            conversationId: conversation.id,
            lastError: null,
            messageId: accepted.message.id,
            processedAt: new Date(),
            runId: accepted.run?.id ?? null,
            status: "adopted",
            updatedAt: new Date(),
          })
          .where("id", "=", ingress.id)
          .executeTakeFirstOrThrow();
        events.push(...accepted.events);
        return {
          dispatchEnvironmentId: accepted.command?.environmentId ?? null,
          events,
          kind: "adopted",
          revokedGrants: accepted.revokedGrants,
          run: accepted.run,
        };
      },
      undefined,
      (error) => error instanceof ChannelAdmissionFenceChanged,
    );
  }

  async claimDelivery(workerId: string, leaseMs = 30_000): Promise<ClaimedDeliveryRecord | null> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const now = new Date();
      await transaction
        .updateTable("channelDeliveries")
        .set({
          claimExpiresAt: null,
          claimOwner: null,
          claimTokenHash: null,
          lastError: "Delivery outcome is unknown after worker lease expiry",
          status: "unknown",
          updatedAt: now,
        })
        .where("status", "=", "attempt-started")
        .where("claimExpiresAt", "<", now)
        .execute();
      await transaction
        .updateTable("channelDeliveries")
        .set({
          lastError: "Channel delivery retry limit reached",
          status: "dead",
          updatedAt: now,
        })
        .where("status", "in", ["pending", "retryable-failed", "unknown"])
        .where("attempts", ">=", deliveryAttemptCeiling)
        .execute();
      await transaction
        .updateTable("channelDeliveries")
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
      // One destination is one lane: the earliest unsent part of a
      // conversation (or of the ingress a status answers), and only while
      // nothing else in that lane is in flight. A reply split into parts must
      // arrive whole and in order, which a global queue cannot promise.
      const row = await transaction
        .selectFrom("channelDeliveries")
        .leftJoin(
          "channelConversations",
          "channelConversations.id",
          "channelDeliveries.conversationId",
        )
        .leftJoin("channelIngressEvents", "channelIngressEvents.id", "channelDeliveries.ingressId")
        .innerJoin("channelAccounts", "channelAccounts.id", "channelDeliveries.accountId")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .select([
          "channelDeliveries.accountId",
          "channelDeliveries.attempts",
          "channelDeliveries.audience",
          "channelDeliveries.content",
          "channelDeliveries.conversationId",
          "channelDeliveries.createdAt",
          "channelDeliveries.id",
          "channelDeliveries.kind",
          "channelDeliveries.lastError",
          "channelDeliveries.messageId",
          "channelDeliveries.part",
          "channelDeliveries.partCount",
          "channelDeliveries.receipt",
          "channelDeliveries.status",
          "channelDeliveries.updatedAt",
          "channelConversations.externalConversationId",
          "channelConversations.externalScopeId",
          "channelConversations.externalThreadId",
          "channelIngressEvents.event as ingressEvent",
          "channelAccounts.externalAccountId",
          "integrationConnections.credentialId",
          "integrationConnections.runnerId",
          "integrationConnections.id as connectionId",
          "integrationConnections.ownerUserId",
          "integrationConnections.provider",
        ])
        .where("channelDeliveries.status", "in", ["pending", "retryable-failed", "unknown"])
        .where("channelDeliveries.nextAttemptAt", "<=", now)
        .where(
          sql<boolean>`not exists (
            select 1 from public.channel_deliveries ahead
            where coalesce(ahead.conversation_id, ahead.ingress_id)
                = coalesce(channel_deliveries.conversation_id, channel_deliveries.ingress_id)
              and (
                ahead.status in ('leased', 'attempt-started')
                or (
                  ahead.status in ('pending', 'retryable-failed', 'unknown')
                  and (ahead.created_at, ahead.part)
                      < (channel_deliveries.created_at, channel_deliveries.part)
                )
              )
          )`,
        )
        .where("channelAccounts.status", "=", "connected")
        .where("integrationConnections.status", "=", "connected")
        .where("integrationConnections.runnerId", "=", workerId as RunnerId)
        .orderBy("channelDeliveries.createdAt", "asc")
        .orderBy("channelDeliveries.part", "asc")
        .forNoKeyUpdate("channelDeliveries")
        .skipLocked()
        .executeTakeFirst();
      if (!row?.runnerId) return null;
      const claimToken = randomBytes(32).toString("base64url");
      await transaction
        .updateTable("channelDeliveries")
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
        delivery: channelDeliveryFromRow({ ...row, status: "leased" }),
        destination: deliveryDestination(row),
        externalAccountId: row.externalAccountId,
        mayHaveBeenSent: row.status === "unknown",
      };
    });
  }

  async startDeliveryAttempt(deliveryId: ChannelDeliveryId, claimToken: string): Promise<void> {
    const withdrawn = await withDatabaseTransaction(this.#database, async (transaction) => {
      const delivery = await transaction
        .selectFrom("channelDeliveries")
        .select("accountId")
        .where("id", "=", deliveryId)
        .executeTakeFirst();
      if (!delivery) throw staleClaim("delivery");
      // The source app first, then the channel: the order revocation takes
      // them in. Whether this may start is read under both.
      const allowed = await channelSourceAllows(transaction, delivery.accountId);
      // Revocation and attempt-start use the connection row as their fence.
      // Whichever owns it first decides whether the delivery is known not to
      // have started (`dead`) or may have reached the provider (`unknown`).
      const connection = await transaction
        .selectFrom("channelAccounts")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .select("integrationConnections.status")
        .where("channelAccounts.id", "=", delivery.accountId)
        .forNoKeyUpdate("integrationConnections")
        .executeTakeFirst();
      if (connection?.status !== "connected") throw staleClaim("delivery");
      // Nothing left the Host yet, so a delivery whose channel lost the use it
      // was set up on ends here, known not to have been sent.
      if (!allowed) {
        const ended = await transaction
          .updateTable("channelDeliveries")
          .set({
            claimExpiresAt: null,
            claimOwner: null,
            claimTokenHash: null,
            lastError: "The computer's app connection no longer allows this channel to send",
            status: "dead",
            updatedAt: new Date(),
          })
          .where("id", "=", deliveryId)
          .where("status", "=", "leased")
          .where("claimTokenHash", "=", digest(claimToken))
          .executeTakeFirst();
        if (ended.numUpdatedRows !== 1n) throw staleClaim("delivery");
        return true;
      }
      const result = await transaction
        .updateTable("channelDeliveries")
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
        message: "The computer's app connection no longer allows this channel to send",
      });
    }
  }

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
      .selectFrom("channelDeliveries")
      .select("attempts")
      .where("id", "=", input.deliveryId)
      .executeTakeFirst();
    // `unknown` keeps its place in the queue: the runtime reconciles with the
    // provider before it sends again, and an outcome that never arrived is not
    // evidence that sending again immediately would help.
    const retry =
      input.outcome === "retryable-failed" || input.outcome === "unknown"
        ? channelRetryDelayMs(observed?.attempts ?? 1, input.retryAfterMs ?? null)
        : 0;
    const result = await this.#database
      .updateTable("channelDeliveries")
      .set({
        claimExpiresAt: null,
        claimOwner: null,
        claimTokenHash: null,
        lastError: input.error?.slice(0, 2_000) ?? null,
        nextAttemptAt: new Date(now.getTime() + retry),
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

  #manifest(provider: ChannelProvider): ChannelProviderManifest | undefined {
    return this.#providers.find((candidate) => candidate.provider === provider);
  }

  /**
   * Hand one person the code that links their provider account. The code is a
   * secret, so it only ever goes where nobody else can read it: a provider that
   * cannot address one person inside a conversation gets told to move to a
   * direct message instead of having a code posted in front of the room.
   *
   * Every explicitly addressed retry receives a fresh code. The previous code
   * is deleted before the new one is inserted, so the latest private notice is
   * always redeemable and an older copied code cannot link the identity later.
   * The caller holds the identity fence, serializing retries and redemption.
   */
  async #offerLinking(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly accountId: ChannelAccountId;
      readonly conversationType: NormalizedChannelEvent["conversation"]["type"];
      readonly identityId: ChannelIdentityId;
      readonly ingressId: ChannelIngressId;
      readonly notices: ChannelIngressNotices;
      readonly provider: ChannelProvider;
    },
  ): Promise<void> {
    if (
      input.conversationType !== "dm" &&
      this.#manifest(input.provider)?.actorDelivery === "direct-message-only"
    ) {
      await insertStatusDelivery(transaction, {
        accountId: input.accountId,
        audience: "conversation",
        conversationId: null,
        ingressId: input.ingressId,
        text: input.notices.linkByDirectMessage,
      });
      return;
    }
    const now = new Date();
    await transaction
      .selectFrom("channelLinkCodes")
      .select("id")
      .where("identityId", "=", input.identityId)
      .where("consumedAt", "is", null)
      .orderBy("id", "asc")
      // FOR UPDATE: The previous unconsumed codes are deleted below.
      .forUpdate()
      .execute();
    await transaction
      .deleteFrom("channelLinkCodes")
      .where("identityId", "=", input.identityId)
      .where("consumedAt", "is", null)
      .execute();
    const code = randomLinkCode();
    await transaction
      .insertInto("channelLinkCodes")
      .values({
        accountId: input.accountId,
        codeHash: digest(code),
        expiresAt: new Date(now.getTime() + linkCodeTtlMs),
        id: `link_${globalThis.crypto.randomUUID()}`,
        identityId: input.identityId,
        requestIngressId: input.ingressId,
        userId: null,
      })
      .executeTakeFirstOrThrow();
    await insertStatusDelivery(transaction, {
      accountId: input.accountId,
      audience: "actor",
      conversationId: null,
      ingressId: input.ingressId,
      text: input.notices.linkCode(code),
    });
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
          "runnerId",
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
    source.runnerId !== input.runnerId ||
    source.computerAccess !== "read-write" ||
    source.status === "revoked"
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: `${manifest?.label ?? "This channel"} needs its app on this computer, allowed to read and send.`,
    });
  }
}

async function upsertChannelIdentity(
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

async function finishIgnored(
  transaction: Transaction<DatabaseSchema>,
  id: ChannelIngressId,
  reason: string,
): Promise<void> {
  await transaction
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
    .executeTakeFirstOrThrow();
}

async function requireWorkspaceOwner(
  transaction: Transaction<DatabaseSchema>,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<void> {
  const membership = await transaction
    .selectFrom("workspaceMemberships")
    .select(["role", "state"])
    .where("workspaceId", "=", workspaceId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!membership || membership.state !== "active" || membership.role !== "owner") {
    throw new OpensteerError({
      code: "forbidden",
      message: "Only a Workspace owner may configure a channel route",
    });
  }
}

async function ownedAccount(
  transaction: Transaction<DatabaseSchema>,
  accountId: ChannelAccountId,
  ownerUserId: UserId,
) {
  const account = await transaction
    .selectFrom("channelAccounts")
    .innerJoin(
      "integrationConnections",
      "integrationConnections.id",
      "channelAccounts.connectionId",
    )
    .selectAll("channelAccounts")
    .where("channelAccounts.id", "=", accountId)
    .where("integrationConnections.ownerUserId", "=", ownerUserId)
    .where("integrationConnections.status", "!=", "revoked")
    .executeTakeFirst();
  if (!account) {
    throw new OpensteerError({ code: "not_found", message: "Channel account not found" });
  }
  return account;
}

async function ownedBinding(
  transaction: Transaction<DatabaseSchema>,
  bindingId: ChannelBindingId,
  ownerUserId: UserId,
): Promise<Selectable<ChannelBindingTable>> {
  const binding = await transaction
    .selectFrom("channelBindings")
    .innerJoin("channelAccounts", "channelAccounts.id", "channelBindings.accountId")
    .innerJoin(
      "integrationConnections",
      "integrationConnections.id",
      "channelAccounts.connectionId",
    )
    .selectAll("channelBindings")
    .where("channelBindings.id", "=", bindingId)
    .where("channelBindings.status", "=", "active")
    .where("integrationConnections.ownerUserId", "=", ownerUserId)
    .forNoKeyUpdate("channelBindings")
    .executeTakeFirst();
  if (!binding) {
    throw new OpensteerError({ code: "not_found", message: "Channel route not found" });
  }
  return binding;
}

async function cancelStaleChannelInputs(
  transaction: Transaction<DatabaseSchema>,
  bindingId: ChannelBindingId,
  currentRevision: number,
  now: Date,
): Promise<void> {
  await transaction
    .updateTable("threadInputs")
    .set({
      cancelReason: "channel-access-changed",
      state: "cancelled",
      updatedAt: now,
    })
    .where("state", "in", ["pending", "unknown"])
    .where(sql<boolean>`authority_source ->> 'kind' = 'channel-ingress'`)
    .where(sql<boolean>`authority_source ->> 'bindingId' = ${bindingId}`)
    .where(
      sql<boolean>`coalesce((authority_source ->> 'bindingRevision')::integer, 0) < ${currentRevision}`,
    )
    .execute();
}

async function cancelChannelInputsForPrincipal(
  transaction: Transaction<DatabaseSchema>,
  bindingId: ChannelBindingId,
  principalId: string,
  now: Date,
): Promise<void> {
  await transaction
    .updateTable("threadInputs")
    .set({
      cancelReason: "channel-access-changed",
      state: "cancelled",
      updatedAt: now,
    })
    .where("state", "in", ["pending", "unknown"])
    .where(sql<boolean>`authority_source ->> 'kind' = 'channel-ingress'`)
    .where(sql<boolean>`authority_source ->> 'bindingId' = ${bindingId}`)
    .where(sql<boolean>`authority_source ->> 'principalId' = ${principalId}`)
    .where(sql<boolean>`authority_source -> 'access' ->> 'mode' = 'approved'`)
    .where(sql<boolean>`authority_source -> 'access' ? 'grantRevision'`)
    .execute();
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

function channelBindingFromRow(row: Selectable<ChannelBindingTable>): ChannelBinding {
  return ChannelBindingSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function channelDeliveryFromRow(
  row: Pick<
    Selectable<ChannelDeliveryTable>,
    | "accountId"
    | "attempts"
    | "audience"
    | "content"
    | "conversationId"
    | "createdAt"
    | "id"
    | "kind"
    | "lastError"
    | "messageId"
    | "receipt"
    | "status"
    | "updatedAt"
  >,
): ChannelDelivery {
  return ChannelDeliverySchema.parse({
    accountId: row.accountId,
    attempts: row.attempts,
    audience: row.audience,
    content: row.content,
    conversationId: row.conversationId,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    kind: row.kind,
    lastError: row.lastError,
    messageId: row.messageId,
    receipt: row.receipt,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Where one claimed delivery goes. A reply is addressed by the conversation it
 * belongs to; a status born from an ignored ingress has no conversation row, so
 * the event the provider sent is the only record of where that person wrote.
 */
function deliveryDestination(row: {
  readonly audience: "conversation" | "actor";
  readonly externalConversationId: string | null;
  readonly externalScopeId: string | null;
  readonly externalThreadId: string | null;
  readonly ingressEvent: unknown;
}): ClaimedDeliveryRecord["destination"] {
  if (row.externalConversationId !== null) {
    return {
      externalConversationId: row.externalConversationId,
      externalScopeId: row.externalScopeId,
      externalThreadId: row.externalThreadId,
      externalUserId: null,
    };
  }
  const event = NormalizedChannelEventSchema.parse(row.ingressEvent);
  return {
    externalConversationId: event.conversation.externalConversationId,
    externalScopeId: event.conversation.externalScopeId,
    externalThreadId: event.conversation.externalThreadId,
    externalUserId: row.audience === "actor" ? event.actor.externalUserId : null,
  };
}

function threadFromRow(
  row: Selectable<ThreadTable>,
  providerSessionId: Thread["providerSessionId"],
) {
  return ThreadSchema.parse({
    ...row,
    continuationIdentity: null,
    providerSessionId,
    askedAt: row.askedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    pendingRequests: row.pendingRequestCount,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function channelThreadTitle(event: NormalizedChannelEvent, label: string | null): string {
  const location = event.conversation.displayName ?? event.conversation.externalConversationId;
  return `${label ?? event.provider} · ${location}`.slice(0, 240);
}

/** A code somebody retypes from a chat message, so the alphabet is unambiguous. */
function randomLinkCode(): string {
  return [...randomBytes(8)].map((value) => linkAlphabet[value % linkAlphabet.length]).join("");
}

/** See `ingressDeferralRetryMs`: quick while somebody is still watching. */
function ingressDeferralDelayMs(receivedAt: Date | null): number {
  return receivedAt && Date.now() - receivedAt.getTime() >= ingressDeferralFreshMs
    ? ingressDeferralSlowRetryMs
    : ingressDeferralRetryMs;
}

/**
 * Which model a channel message runs on. Nobody chose one, so it is the
 * account's own default — the model its last reported catalog marks
 * `isDefault`, carrying the endpoint's own `nativeModelId` exactly as a
 * person's selection would. There is no bundled fallback pair: a guessed
 * model is a model the account may not offer at all, and a Thread pinned to
 * one fails on every Run instead of once, here, with a reason.
 */
function modelSelectionFromCatalog(catalog: HarnessInstanceCatalog | null): ModelSelection {
  if (catalog?.status !== "ready") {
    throw new ChannelIngressDeferredError("Selected AI engine has reported no models yet");
  }
  const model = catalog.models.find(
    (candidate) => candidate.isDefault && !candidate.unavailableReason,
  );
  if (!model) {
    throw new OpensteerError({
      code: "conflict",
      message: "Selected AI engine reports no default model",
    });
  }
  return ModelSelectionSchema.parse({
    modelId: model.modelId,
    ...(model.nativeModelId === undefined ? {} : { nativeModelId: model.nativeModelId }),
    options: {},
    providerId: model.providerId,
  });
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
