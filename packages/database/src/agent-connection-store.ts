import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { publishThreadSummary } from "./thread-status.js";
import {
  AgentGrantSchema,
  agentGrantAllowsTasks,
  chatAddRefusals,
  chatConsentRefusal,
  chatGrantShape,
  OpensteerError,
  agentGrantNarrowed,
  everythingAgentGrant,
  threadAccessModeAtMost,
  type AgentGrant,
  type UserId,
} from "@opensteer/core";
import {
  agentConnectionConsentRefusals,
  agentConnectionVerificationChangedMessage,
  type AgentConnection,
  type AgentConnectionState,
} from "@opensteer/protocol";
import {
  AgentConnectionIdentityAtConsentSchema,
  AgentDirectoryDocumentSchema,
  type AgentDirectoryDocument,
  type AgentConnectionIdentityAtConsent,
} from "@opensteer/control-plane-protocol";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { outsideName } from "@opensteer/shared/outsideName";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { RunId } from "@opensteer/core";
import type { AgentConnectionTable, DatabaseSchema } from "./schema.js";
import { isIdentityStillVerified } from "./agent-directory-verification.js";
import { withDatabaseTransaction } from "./connection.js";
import { databaseOperation } from "./operation-budget.js";
import {
  connectionAttempts,
  latestConnectionUncertainty,
  outstandingAttempts,
} from "./connection-disconnect.js";
import { jsonValue } from "./store-primitives.js";
import { closeObsoleteAgentOperationRequests } from "./agent-session-store.js";
import {
  chatEndReason,
  chatEndedUnrevoked,
  connectionState,
  bridgeStoredExpiry,
  connectionActive,
  expiresByTime,
} from "./connection-liveness.js";
import type { BridgeEndedBy, BridgeSenders } from "./schema.js";
import { channelProviderCatalog, type ChannelAccountId } from "@opensteer/channel-core";

interface AgentConnectionEdit {
  readonly connectionId: string;
  readonly expectedRevision: number;
  readonly label?: string;
  readonly accessMode?: AgentConnection["accessMode"];
  readonly grant?: AgentGrant;
}

/** What a new messaging bridge covers and who may speak to it, chosen on its consent. */
export interface BridgeConsent {
  readonly userId: UserId;
  readonly accountId: ChannelAccountId;
  /** One named channel or group; absent covers direct messages to the bot or account. */
  readonly conversation?: { readonly id: string; readonly name: string } | undefined;
  readonly senders: BridgeSenders;
  readonly accessMode: AgentConnection["accessMode"];
  readonly grant: AgentGrant;
  readonly label?: string | undefined;
}

export class AgentConnectionStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly now: () => Date;
  constructor(database: Kysely<DatabaseSchema>, now: () => Date = () => new Date()) {
    this.database = database;
    this.now = now;
  }
  /** A client that sent a grant made its consent on the grant screen (`consentVersion` 2). */
  async create(input: {
    userId: UserId;
    label: string;
    clientName: string;
    accessMode: AgentConnection["accessMode"];
    resource: string;
    expiresAt: Date;
    grant?: AgentGrant;
    clientFingerprint?: string;
    redirectUri?: string;
    /** Who the person was shown at consent. */
    identityAtConsent?: AgentConnectionIdentityAtConsent;
    directoryIssuer?: string;
  }): Promise<AgentConnection> {
    return withPersonalTransaction(this.database, async (tx) => {
      await requirePersonalOwner(tx, input.userId);
      const evidence = input.identityAtConsent;
      if (input.directoryIssuer && evidence && evidence.kind !== "unverified") {
        const directory = await new AgentConnectionStore(tx, this.now).loadDirectory(
          input.directoryIssuer,
        );
        if (directory && !isIdentityStillVerified(evidence, directory)) {
          throw new OpensteerError({
            code: "conflict",
            reason: agentConnectionConsentRefusals.verificationChanged,
            message: agentConnectionVerificationChangedMessage,
          });
        }
      }
      const grant = input.grant ? AgentGrantSchema.parse(input.grant) : everythingAgentGrant;
      const { accessMode } = input;
      if (input.grant) await assertGrantable(tx, input.userId, grant);
      const row = await tx
        .insertInto("agentConnections")
        .values({
          id: `mcn_${randomUUID()}`,
          userId: input.userId,
          // Names from outside enter clean (`outsideName`): never stored or served dirty.
          label: outsideName(input.label, 120) || outsideName(input.clientName, 100) || "Agent",
          clientName: outsideName(input.clientName, 100) || "Agent",
          accessMode,
          resource: input.resource,
          createdAt: this.now(),
          expiresAt: input.expiresAt,
          tokenHash: null,
          lastUsedAt: null,
          revokedAt: null,
          grant: jsonValue(grant),
          consentVersion: input.grant ? 2 : 1,
          clientFingerprint: input.clientFingerprint ?? null,
          redirectUri: input.redirectUri ?? null,
          identityAtConsent: input.identityAtConsent
            ? jsonValue(
                cleanIdentityNames(
                  AgentConnectionIdentityAtConsentSchema.parse(input.identityAtConsent),
                ),
              )
            : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return view(row, "active");
    });
  }
  /**
   * A messaging bridge: the same row a connected agent has, reached through a chat. It has no
   * credential and no expiry, and holds `tasks` always.
   */
  async createBridge(input: BridgeConsent): Promise<AgentConnection> {
    const grant = AgentGrantSchema.parse(input.grant);
    assertBridgeGrant(input.senders, input.conversation !== undefined, grant);
    return commitPersonalMutation(this.database, async (tx) => {
      await requirePersonalOwner(tx, input.userId);
      const account = await tx
        .selectFrom("channelAccounts")
        .innerJoin(
          "integrationConnections",
          "integrationConnections.id",
          "channelAccounts.connectionId",
        )
        .select(["channelAccounts.provider", "channelAccounts.status"])
        .where("channelAccounts.id", "=", input.accountId)
        .where("integrationConnections.ownerUserId", "=", input.userId)
        .where("integrationConnections.status", "!=", "revoked")
        .executeTakeFirst();
      if (!account || account.status === "revoked")
        throw new OpensteerError({
          code: "not_found",
          message: chatAddRefusals.accountGone,
        });
      const { accessMode } = input;
      await assertGrantable(tx, input.userId, grant);
      const provider = bridgeProviderLabel(account.provider);
      const conversationName = input.conversation
        ? outsideName(input.conversation.name, 160) || null
        : null;
      const row = await tx
        .insertInto("agentConnections")
        .values({
          id: `mcn_${randomUUID()}`,
          userId: input.userId,
          label:
            outsideName(input.label ?? bridgeLabel(provider, conversationName ?? undefined), 120) ||
            provider,
          clientName: provider,
          accessMode,
          resource: bridgeResource,
          createdAt: this.now(),
          expiresAt: bridgeStoredExpiry,
          tokenHash: null,
          lastUsedAt: null,
          revokedAt: null,
          grant: jsonValue(grant),
          consentVersion: 2,
          bridgeAccountId: input.accountId,
          bridgeConversationId: input.conversation?.id ?? null,
          bridgeSenders: input.senders,
          bridgeConversationName: conversationName,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            "constraint" in error &&
            error.constraint === "agent_connections_bridge_cover"
          )
            throw new OpensteerError({
              code: "conflict",
              message: chatAddRefusals.conversationTaken,
            });
          throw error;
        });
      return view(row, "active");
    });
  }
  async loadDirectory(issuer: string): Promise<AgentDirectoryDocument | null> {
    const row = await this.database
      .selectFrom("agentDirectoryCache")
      .select("document")
      .where("issuer", "=", issuer)
      .executeTakeFirst();
    return row ? AgentDirectoryDocumentSchema.parse(row.document) : null;
  }

  acceptDirectory(
    issuer: string,
    document: AgentDirectoryDocument,
  ): Promise<AgentDirectoryDocument> {
    return withPersonalTransaction(this.database, async (tx) => {
      const current = await new AgentConnectionStore(tx, this.now).loadDirectory(issuer);
      if (current && document.revision < current.revision) return current;
      if (
        document.revision === current?.revision &&
        (Date.parse(document.issuedAt) <= Date.parse(current.issuedAt) ||
          !isDeepStrictEqual(document.entries, current.entries))
      ) {
        return current;
      }
      const acceptedAt = this.now();
      const newRevision = current?.revision !== document.revision;
      const encoded = jsonValue(document);
      await tx
        .insertInto("agentDirectoryCache")
        .values({ issuer, document: encoded, acceptedAt })
        .onConflict((conflict) =>
          conflict.column("issuer").doUpdateSet({
            document: encoded,
            ...(newRevision ? { acceptedAt } : {}),
          }),
        )
        .execute();
      if (!newRevision) return document;
      const rows = await tx
        .selectFrom("agentConnections")
        .select(["id", "identityAtConsent"])
        .where("verificationWithdrawnAt", "is", null)
        .where("identityAtConsent", "is not", null)
        .execute();
      const withdrawn: string[] = [];
      for (const row of rows) {
        const evidence = identityAtConsent(row.identityAtConsent);
        if (
          evidence &&
          evidence.kind !== "unverified" &&
          evidence.directoryRevision < document.revision &&
          !isIdentityStillVerified(evidence, document)
        )
          withdrawn.push(row.id);
      }
      if (withdrawn.length > 0) {
        await tx
          .updateTable("agentConnections")
          .set({ verificationWithdrawnAt: acceptedAt })
          .where("id", "in", withdrawn)
          .where("verificationWithdrawnAt", "is", null)
          .execute();
      }
      return document;
    });
  }

  async nextMaintenance(retryAt: Date): Promise<Date | null> {
    const { rows } = await sql<{ next: Date | null }>`
      select least(
        (select min(expires_at) from agent_connections
          where removed_at is null and revoked_at is null and ${expiresByTime}
            and (cleanup_reason is null or cleanup_reason = 'narrowed')),
        (select ${retryAt}::timestamptz where exists (
          select 1 from agent_connections
          where (cleanup_requested_at is not null and cleanup_completed_at is null)
            or (removed_at is null and ${chatEndedUnrevoked(this.now())})
        ))
      ) as next
    `.execute(this.database);
    return rows[0]?.next ?? null;
  }

  async activate(id: string, tokenHash: string): Promise<boolean> {
    const result = await this.database
      .updateTable("agentConnections")
      .set({
        tokenHash,
      })
      .where("id", "=", id)
      .where("tokenHash", "is", null)
      .where("bridgeAccountId", "is", null)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", this.now())
      .returning("id")
      .executeTakeFirst();
    return result !== undefined;
  }
  async authenticate(tokenHash: string, resource?: string): Promise<AgentConnection | null> {
    if (databaseOperation() && !this.database.isTransaction)
      return withDatabaseTransaction(this.database, (tx) =>
        new AgentConnectionStore(tx, this.now).authenticate(tokenHash, resource),
      );
    const now = this.now();
    let query = this.database
      .updateTable("agentConnections")
      .set({
        lastUsedAt: now,
      })
      .where("tokenHash", "=", tokenHash)
      .where("bridgeAccountId", "is", null)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", now)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("users")
            .select("id")
            .whereRef("users.id", "=", "agentConnections.userId")
            .where("disabledAt", "is", null),
        ),
      )
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("personalSettings")
            .select("singletonKey")
            .whereRef("personalSettings.ownerId", "=", "agentConnections.userId"),
        ),
      );
    if (resource !== undefined) query = query.where("resource", "=", resource);
    const row = await query.returningAll().executeTakeFirst();
    return row ? view(row, "active") : null;
  }
  async list(
    userId: UserId,
    options: { readonly includeRevoked?: boolean } = {},
  ): Promise<AgentConnection[]> {
    await requirePersonalOwner(this.database, userId);
    const now = this.now();
    const rows = await this.database
      .selectFrom("agentConnections")
      .selectAll()
      .select(connectionState(now).as("connectionState"))
      .where("userId", "=", userId)
      .$if(!options.includeRevoked, (query) =>
        query
          .where("revokedAt", "is", null)
          .where((eb) => eb.or([eb("bridgeAccountId", "is not", null), eb("expiresAt", ">", now)])),
      )
      .$if(options.includeRevoked === true, (query) => query.where("removedAt", "is", null))
      .orderBy("createdAt", "desc")
      .execute();
    const facts = await chatFacts(
      this.database,
      rows.filter((row) => row.bridgeAccountId !== null).map((row) => row.id),
    );
    // Derived from the durable cleanup record and what its lineage still holds.
    return Promise.all(
      rows.map(async ({ connectionState: chatState, ...row }) => {
        const view = (input: Selectable<AgentConnectionTable>, state: AgentConnectionState) =>
          connectionView(input, state, facts.get(row.id));
        const chat = row.bridgeAccountId !== null;
        // A chat reads as what it is: live is active, waiting is paused, ended is stopping until
        // nothing in its lineage is outstanding, then stopped. It never reads as active once it
        // is not live.
        const active = chat ? chatState === "live" : connectionActive(row, now);
        if (chat && chatState === "waiting") return view(row, "paused");
        if (active && row.cleanupRequestedAt === null) return view(row, "active");
        const attempts = await connectionAttempts(this.database, row.id);
        const outstanding = outstandingAttempts(attempts);
        const state = active
          ? "active"
          : chat
            ? outstanding.length === 0 && row.revokedAt !== null
              ? "stopped"
              : "stopping"
            : outstanding.some((attempt) => attempt.handedOff)
              ? "stopping"
              : outstanding.length === 0
                ? "stopped"
                : row.revokedAt === null
                  ? "expired"
                  : "revoked";
        return view(
          { ...row, ...(await latestConnectionUncertainty(this.database, row, attempts)) },
          state,
        );
      }),
    );
  }
  /** Clears "last action uncertain" once the person has checked. */
  async acknowledgeUncertain(userId: UserId, id: string): Promise<void> {
    await requirePersonalOwner(this.database, userId);
    await this.database
      .updateTable("agentConnections")
      .set({
        lastActionUncertainAt: null,
        lastActionUncertain: null,
        acknowledgedUncertaintyAt: this.now(),
      })
      .where("id", "=", id)
      .where("userId", "=", userId)
      .execute();
  }
  /** Revision-checked; returns whether the edit withdrew authority that live work may hold. */
  async update(
    userId: UserId,
    input: AgentConnectionEdit,
  ): Promise<{ readonly connection: AgentConnection; readonly narrowed: boolean }> {
    return commitPersonalMutation(this.database, async (tx) => {
      const { changed, ...result } = await this.#writeUpdate(tx, userId, input);
      if (changed) await closeObsoleteAgentOperationRequests(tx, [input.connectionId], this.now());
      return result;
    });
  }

  async #writeUpdate(tx: Transaction<DatabaseSchema>, userId: UserId, input: AgentConnectionEdit) {
    await requirePersonalOwner(tx, userId);
    const found = await tx
      .selectFrom("agentConnections")
      .selectAll()
      .select(connectionState(this.now()).as("connectionState"))
      .where("id", "=", input.connectionId)
      .where("userId", "=", userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    // A chat that ended is edited no more; a paused one may be.
    if (
      !found ||
      (found.bridgeAccountId !== null
        ? found.revokedAt !== null || found.connectionState === "ended"
        : !connectionActive(found, this.now()))
    )
      throw new OpensteerError({
        code: "not_found",
        message: "This connected agent is no longer connected.",
      });
    const { connectionState: chatState, ...current } = found;
    // Who may speak is chosen when a bridge is made and never changes on that row.
    if ("senders" in input || "bridgeSenders" in input)
      throw new OpensteerError({
        code: "bad_request",
        reason: "bridge-senders-fixed",
        message:
          "Who may message a chat connection is chosen when it is set up. Disconnect it and set it up again to change it.",
      });
    if (current.grantRevision !== input.expectedRevision)
      throw new OpensteerError({
        code: "conflict",
        reason: "revision-changed",
        message: "This connected agent changed since you opened it. Review it and try again.",
      });
    const grant = input.grant ? AgentGrantSchema.parse(input.grant) : current.grant;
    if (input.grant) await assertGrantable(tx, userId, grant);
    // The person chooses only what a bridge may hold.
    if (current.bridgeAccountId !== null && current.bridgeSenders !== null)
      assertBridgeGrant(current.bridgeSenders, current.bridgeConversationId !== null, grant);
    const accessMode = input.accessMode ?? current.accessMode;
    const narrowed =
      agentGrantNarrowed(current.grant, grant) ||
      !threadAccessModeAtMost(current.accessMode, accessMode);
    const changed = !isDeepStrictEqual(current.grant, grant) || current.accessMode !== accessMode;
    const row = await tx
      .updateTable("agentConnections")
      .set({
        label:
          input.label === undefined
            ? current.label
            : outsideName(input.label, 120) || current.label,
        accessMode,
        grant: jsonValue(grant),
        grantRevision: current.grantRevision + Number(changed),
        ...(narrowed
          ? {
              cleanupReason: "narrowed" as const,
              cleanupRequestedAt: this.now(),
              cleanupMinimumGrantRevision: current.grantRevision + 1,
              cleanupMaximumMode: accessMode,
              cleanupCompletedAt: null,
            }
          : {}),
      })
      .where("id", "=", current.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      // As the list reads it: a chat that had ended, or that this edit left without tasks, is
      // ending; a paused one is paused.
      connection: view(
        row,
        row.bridgeAccountId === null
          ? "active"
          : chatState === "ended" || !agentGrantAllowsTasks(grant)
            ? "stopping"
            : chatState === "waiting"
              ? "paused"
              : "active",
      ),
      narrowed,
      changed,
    };
  }
  /**
   * Disconnect's durable decision. Inside the personal fence the owner-filtered row is locked
   * `FOR NO KEY UPDATE`, which every admission of lineaged work holds `FOR SHARE` (or re-reads
   * under a row this sweep later locks), so once this commits no new work in the lineage starts.
   * Idempotent and owner-filtered; a foreign ID discloses nothing. Returns whether it was live.
   */
  async revoke(
    userId: UserId,
    id: string,
    options: { readonly endedBy?: BridgeEndedBy } = {},
  ): Promise<boolean> {
    return commitPersonalMutation(this.database, async (tx) => {
      await requirePersonalOwner(tx, userId);
      const row = await tx
        .selectFrom("agentConnections")
        .select(["id", "revokedAt", "grantRevision"])
        .where("id", "=", id)
        .where("userId", "=", userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || row.revokedAt !== null) return false;
      await tx
        .updateTable("agentConnections")
        .set({
          revokedAt: this.now(),
          tokenHash: null,
          grantRevision: row.grantRevision + 1,
          // One durable record: the Home drives cleanup to completion from here, even after a
          // restart, and its state is read from what is still outstanding.
          cleanupReason: "revoked",
          cleanupRequestedAt: this.now(),
          cleanupCompletedAt: null,
          // A chat remembers why it ended; the person disconnecting it is the default.
          bridgeEndedBy: sql<BridgeEndedBy | null>`case when bridge_account_id is not null
            then ${options.endedBy ?? "you"} end`,
        })
        .where("id", "=", row.id)
        .execute();
      const originated = await tx
        .selectFrom("threads")
        .select("id")
        .where("originConnectionId", "=", row.id)
        .where("removedAt", "is", null)
        .orderBy("id")
        .execute();
      for (const { id: threadId } of originated) await publishThreadSummary(tx, threadId);
      return true;
    });
  }
  /** Takes an ended connection off the list; an active one must be disconnected first. */
  async remove(userId: UserId, id: string): Promise<void> {
    await commitPersonalMutation(this.database, async (tx) => {
      await requirePersonalOwner(tx, userId);
      const row = await tx
        .selectFrom("agentConnections")
        .select([
          "revokedAt",
          "expiresAt",
          "bridgeAccountId",
          "cleanupRequestedAt",
          "cleanupCompletedAt",
          "acknowledgedUncertaintyAt",
          "lastActionUncertainAt",
        ])
        .forNoKeyUpdate()
        .where("id", "=", id)
        .where("userId", "=", userId)
        .executeTakeFirst();
      if (!row) return;
      if (connectionActive(row, this.now()))
        throw new OpensteerError({
          code: "conflict",
          message: "Disconnect this agent before removing it.",
        });
      // A connection whose work has not finished stopping stays visible until it has.
      const attempts = await connectionAttempts(tx, id);
      if (outstandingAttempts(attempts).length)
        throw new OpensteerError({
          code: "conflict",
          reason: "cleanup-outstanding",
          message: "This agent's work is still stopping. Remove it once it has stopped.",
        });
      const now = this.now();
      await tx
        .updateTable("agentConnections")
        .set({
          removedAt: now,
          ...(row.cleanupRequestedAt === null
            ? {
                cleanupRequestedAt: row.revokedAt ?? row.expiresAt,
                cleanupReason: row.revokedAt ? "revoked" : "expired",
              }
            : {}),
          ...(await latestConnectionUncertainty(tx, row, attempts)),
        })
        .where("id", "=", id)
        .where("userId", "=", userId)
        .where("removedAt", "is", null)
        .execute();
    });
  }
}
/** What a person reads about a chat beside its row: where, who "me" is, why it is paused or ended. */
interface ChatFacts {
  readonly accountName: string;
  readonly accountHandle: string | null;
  readonly channelConnectionId: string;
  readonly me: { readonly displayName: string; readonly externalUserId: string } | null;
  readonly pausedBy: "you" | "needs-attention";
  readonly pauseDetail: string | null;
  /** What becomes of a message sent while it is paused, from its transport; never promised. */
  readonly pausedMessages: "kept" | "lost";
  /** Null for a chat whose grant holds no tasks: it reads as ended. */
  readonly endedBy: BridgeEndedBy | null;
  readonly unknownReplies: number;
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly running: boolean;
    readonly runId: RunId | null;
  }[];
}

/** The chat facts of the listed chats, in one statement; none is read for a connected agent. */
async function chatFacts(
  database: Kysely<DatabaseSchema>,
  chatIds: readonly string[],
): Promise<ReadonlyMap<string, ChatFacts>> {
  if (chatIds.length === 0) return new Map();
  const rows = await database
    .selectFrom("agentConnections")
    .innerJoin("channelAccounts", "channelAccounts.id", "agentConnections.bridgeAccountId")
    .innerJoin(
      "integrationConnections",
      "integrationConnections.id",
      "channelAccounts.connectionId",
    )
    .select([
      "agentConnections.id",
      "agentConnections.revokedAt",
      "agentConnections.bridgeEndedBy",
      "channelAccounts.displayName",
      "channelAccounts.handle",
      "channelAccounts.provider",
      "channelAccounts.status as accountStatus",
      "channelAccounts.connectionId",
      "integrationConnections.statusDetail",
      chatEndReason().as("endReason"),
      sql<string | null>`(select me.display_name from channel_identities me
        where me.account_id = channel_accounts.id and me.status = 'linked'
          and me.linked_user_id = agent_connections.user_id limit 1)`.as("meName"),
      sql<string | null>`(select me.external_user_id from channel_identities me
        where me.account_id = channel_accounts.id and me.status = 'linked'
          and me.linked_user_id = agent_connections.user_id limit 1)`.as("meId"),
      sql<number>`(select count(*)::integer from bridge_deliveries unknown
        where unknown.bridge_id = agent_connections.id and unknown.status = 'unknown')`.as(
        "unknownReplies",
      ),
    ])
    .where("agentConnections.id", "in", chatIds)
    .execute();
  // Each chat's most recent tasks, newest first.
  const tasks = await database
    .selectFrom("threads")
    .select(["id", "title", "status", "originConnectionId"])
    // The Run it is doing, which Stop interrupts: its newest one not ended.
    .select(
      sql<RunId | null>`(select runs.id from runs where runs.thread_id = threads.id
        and runs.maintenance is null and runs.status in ('starting', 'running', 'waiting')
        order by runs.run_ordinal desc limit 1)`.as("runId"),
    )
    .where("originConnectionId", "in", chatIds)
    .where("removedAt", "is", null)
    .where("parentThreadId", "is", null)
    .orderBy("updatedAt", "desc")
    .limit(5 * chatIds.length)
    .execute();
  const tasksOf = (id: string) =>
    tasks
      .filter((task) => task.originConnectionId === id)
      .slice(0, 5)
      .map((task) => {
        const running = task.status === "running";
        return { id: task.id, title: task.title, running, runId: running ? task.runId : null };
      });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        accountName: row.displayName.slice(0, 160),
        accountHandle: row.handle?.slice(0, 160) ?? null,
        channelConnectionId: row.connectionId,
        me:
          row.meName !== null && row.meId !== null
            ? { displayName: row.meName.slice(0, 160), externalUserId: row.meId }
            : null,
        pausedBy: row.accountStatus === "needs-attention" ? "needs-attention" : "you",
        pauseDetail: row.accountStatus === "needs-attention" ? row.statusDetail : null,
        pausedMessages:
          channelProviderCatalog.find((entry) => entry.provider === row.provider)?.pausedMessages ??
          "lost",
        endedBy: row.revokedAt !== null ? row.bridgeEndedBy : (row.bridgeEndedBy ?? row.endReason),
        unknownReplies: row.unknownReplies,
        tasks: tasksOf(row.id),
      },
    ]),
  );
}

function view(row: Selectable<AgentConnectionTable>, state: AgentConnectionState): AgentConnection {
  return connectionView(row, state, undefined);
}

function connectionView(
  row: Selectable<AgentConnectionTable>,
  state: AgentConnectionState,
  chat: ChatFacts | undefined,
): AgentConnection {
  let redirectOrigin: string | null = null;
  try {
    redirectOrigin = row.redirectUri ? new URL(row.redirectUri).origin : null;
  } catch {
    redirectOrigin = null;
  }
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    clientName: row.clientName,
    accessMode: row.accessMode,
    grant: AgentGrantSchema.parse(row.grant),
    grantRevision: row.grantRevision,
    consentVersion: row.consentVersion,
    client: { fingerprint: row.clientFingerprint, redirectOrigin },
    state,
    lastActionUncertain: row.lastActionUncertainAt !== null,
    lastActionUncertainDetail: row.lastActionUncertainAt
      ? {
          at: row.lastActionUncertainAt.toISOString(),
          device: detailText(row.lastActionUncertain, "device"),
          task: detailText(row.lastActionUncertain, "task"),
          taskId: detailText(row.lastActionUncertain, "taskId"),
          tool: detailText(row.lastActionUncertain, "tool"),
          reason: detailText(row.lastActionUncertain, "reason"),
        }
      : null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    identityAtConsent: identityAtConsent(row.identityAtConsent),
    ...(row.verificationWithdrawnAt
      ? { verificationWithdrawnAt: row.verificationWithdrawnAt.toISOString() }
      : {}),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    // A bridge does not expire; what its row stores there is never shown.
    expiresAt: row.bridgeAccountId === null ? row.expiresAt.toISOString() : null,
    ...(row.bridgeAccountId !== null && row.bridgeSenders !== null
      ? {
          bridge: {
            accountId: row.bridgeAccountId,
            provider: row.clientName,
            conversationId: row.bridgeConversationId,
            senders: row.bridgeSenders,
            grantShape: (({ resources, ...shape }) => ({ ...shape, resources: [...resources] }))(
              chatGrantShape(row.bridgeSenders),
            ),
            conversationName: row.bridgeConversationName,
            ...(chat
              ? {
                  accountName: chat.accountName,
                  ...(chat.accountHandle ? { accountHandle: chat.accountHandle } : {}),
                  channelConnectionId: chat.channelConnectionId,
                  me: chat.me,
                  unknownReplies: chat.unknownReplies,
                  tasks: [...chat.tasks],
                  ...(state === "paused"
                    ? {
                        pausedBy: chat.pausedBy,
                        pauseDetail: chat.pauseDetail,
                        pausedMessages: chat.pausedMessages,
                      }
                    : {}),
                  ...((state === "stopping" || state === "stopped") && chat.endedBy
                    ? { endedBy: chat.endedBy }
                    : {}),
                }
              : {}),
          },
        }
      : {}),
  };
}

/** The resource a bridge's row names where an MCP connection names its resource URL. */
export const bridgeResource = "opensteer:bridge";

function bridgeProviderLabel(provider: string): string {
  return channelProviderCatalog.find((entry) => entry.provider === provider)?.label ?? provider;
}

function bridgeLabel(provider: string, conversation: string | undefined): string {
  return conversation ? `${provider} · ${conversation}` : provider;
}

/**
 * What a bridge may hold: `tasks` always; with anyone in its one conversation speaking, only
 * `tasks` and selected plugins. Direct messages are always "only me".
 */
export function assertBridgeGrant(
  senders: BridgeSenders,
  coversOneConversation: boolean,
  grant: AgentGrant,
): void {
  // The rule lives once, in core (`chatConsentRefusal`); the screens offer what it allows
  // (`grantShape`) and the preview Home refuses with it too.
  const refusal = chatConsentRefusal(senders, coversOneConversation, grant);
  if (refusal) throw new OpensteerError({ code: "bad_request", ...refusal });
}

/**
 * A selected grant may not name the profile an AI engine signs in through: that sign-in is the
 * person's own. `everything` is the person's whole authority and still reaches it.
 */
async function assertGrantable(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  grant: AgentGrant,
): Promise<void> {
  if (grant.scope !== "selected") return;
  const profileIds = grant.resources.flatMap((resource) =>
    resource.kind === "browser-profile" ? [resource.profileId] : [],
  );
  if (!profileIds.length) return;
  const reserved = await database
    .selectFrom("browserProfiles")
    .select("id")
    .where("ownerId", "=", userId)
    .where("id", "in", profileIds)
    .where("purpose", "=", "engine-sign-in")
    .executeTakeFirst();
  if (reserved)
    throw new OpensteerError({
      code: "bad_request",
      reason: "engine-sign-in-profile",
      message: "The AI engine sign-in profile can't be given to a connected agent.",
    });
}

/** A stored identity that no longer parses is shown as unknown, never guessed. */
function identityAtConsent(
  value: Readonly<Record<string, unknown>> | null,
): AgentConnectionIdentityAtConsent | null {
  const parsed = AgentConnectionIdentityAtConsentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function detailText(detail: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" ? value : null;
}

/** The names in who an agent is (its own and its directory entry's) enter clean too. */
function cleanIdentityNames<Identity extends object>(identity: Identity): Identity {
  return Object.fromEntries(
    Object.entries(identity).map(([key, value]) => [
      key,
      typeof value === "string" && key.endsWith("Name")
        ? outsideName(value, 100) || "Agent"
        : value,
    ]),
  ) as Identity;
}
