import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import {
  AgentGrantSchema,
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
import { sql, type Kysely, type Selectable } from "kysely";
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
import { connectionPolicyMode } from "./work-policy.js";
import { closeObsoleteAgentOperationRequests } from "./agent-session-store.js";

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
        if (directory && !(await isIdentityStillVerified(evidence, directory))) {
          throw new OpensteerError({
            code: "conflict",
            reason: agentConnectionConsentRefusals.verificationChanged,
            message: agentConnectionVerificationChangedMessage,
          });
        }
      }
      const grant = input.grant ? AgentGrantSchema.parse(input.grant) : everythingAgentGrant;
      const accessMode = await connectionPolicyMode(tx, grant, input.accessMode);
      if (input.grant) await assertGrantable(tx, input.userId, grant);
      const row = await tx
        .insertInto("agentConnections")
        .values({
          id: `mcn_${randomUUID()}`,
          userId: input.userId,
          label: input.label,
          clientName: input.clientName,
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
            ? jsonValue(AgentConnectionIdentityAtConsentSchema.parse(input.identityAtConsent))
            : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
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
          !(await isIdentityStillVerified(evidence, document))
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

  async claimEmbedderAssertion(
    issuer: string,
    statementId: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const row = await this.database
      .insertInto("agentEmbedderAssertionClaims")
      .columns(["issuer", "statementId", "expiresAt"])
      .expression(
        sql`select ${issuer}::text, ${statementId}::text, ${expiresAt}::timestamptz
        where ${expiresAt}::timestamptz > clock_timestamp()`,
      )
      .onConflict((conflict) => conflict.columns(["issuer", "statementId"]).doNothing())
      .returning(sql<boolean>`expires_at > clock_timestamp()`.as("accepted"))
      .executeTakeFirst();
    return row?.accepted === true;
  }

  async pruneEmbedderAssertionClaims(): Promise<void> {
    await this.database
      .deleteFrom("agentEmbedderAssertionClaims")
      .where("expiresAt", "<=", sql<Date>`clock_timestamp()`)
      .execute();
  }

  async nextMaintenance(retryAt: Date): Promise<Date | null> {
    const { rows } = await sql<{ next: Date | null }>`
      select least(
        (select min(expires_at) from agent_connections
          where removed_at is null and revoked_at is null
            and (cleanup_reason is null or cleanup_reason = 'narrowed')),
        (select ${retryAt}::timestamptz where exists (
          select 1 from agent_connections
          where removed_at is null and cleanup_requested_at is not null
            and cleanup_completed_at is null
        )),
        (select ${this.now()}::timestamptz + (min(expires_at) - clock_timestamp())
          from agent_embedder_assertion_claims)
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
      .where("userId", "=", userId)
      .$if(!options.includeRevoked, (query) =>
        query.where("revokedAt", "is", null).where("expiresAt", ">", now),
      )
      .$if(options.includeRevoked === true, (query) => query.where("removedAt", "is", null))
      .orderBy("createdAt", "desc")
      .execute();
    // Derived from the durable cleanup record and what its lineage still holds.
    return Promise.all(
      rows.map(async (row) => {
        const active = row.revokedAt === null && row.expiresAt > now;
        if (active && row.cleanupRequestedAt === null) return view(row, "active");
        const attempts = await connectionAttempts(this.database, row.id);
        const outstanding = outstandingAttempts(attempts);
        const state = active
          ? "active"
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
    input: {
      readonly connectionId: string;
      readonly expectedRevision: number;
      readonly label?: string;
      readonly accessMode?: AgentConnection["accessMode"];
      readonly grant?: AgentGrant;
    },
  ): Promise<{ readonly connection: AgentConnection; readonly narrowed: boolean }> {
    return commitPersonalMutation(this.database, async (tx) => {
      await requirePersonalOwner(tx, userId);
      const current = await tx
        .selectFrom("agentConnections")
        .selectAll()
        .where("id", "=", input.connectionId)
        .where("userId", "=", userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current || current.revokedAt !== null || current.expiresAt <= this.now())
        throw new OpensteerError({
          code: "not_found",
          message: "This connected agent is no longer connected.",
        });
      if (current.grantRevision !== input.expectedRevision)
        throw new OpensteerError({
          code: "conflict",
          reason: "revision-changed",
          message: "This connected agent changed since you opened it. Review it and try again.",
        });
      const grant = input.grant ? AgentGrantSchema.parse(input.grant) : current.grant;
      if (input.grant) await assertGrantable(tx, userId, grant);
      const accessMode = await connectionPolicyMode(
        tx,
        grant,
        input.accessMode ?? current.accessMode,
      );
      const narrowed =
        agentGrantNarrowed(current.grant, grant) ||
        !threadAccessModeAtMost(current.accessMode, accessMode);
      const changed = !isDeepStrictEqual(current.grant, grant) || current.accessMode !== accessMode;
      const row = await tx
        .updateTable("agentConnections")
        .set({
          label: input.label ?? current.label,
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
      if (changed)
        await closeObsoleteAgentOperationRequests(tx, current.id, row.grantRevision, this.now());
      return { connection: view(row, "active"), narrowed };
    });
  }
  /**
   * Disconnect's durable decision. Inside the personal fence the owner-filtered row is locked
   * `FOR NO KEY UPDATE`, which every admission of lineaged work holds `FOR SHARE` (or re-reads
   * under a row this sweep later locks), so once this commits no new work in the lineage starts.
   * Idempotent and owner-filtered; a foreign ID discloses nothing. Returns whether it was live.
   */
  async revoke(userId: UserId, id: string): Promise<boolean> {
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
        })
        .where("id", "=", row.id)
        .execute();
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
      if (row.revokedAt === null && row.expiresAt > this.now())
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
          cleanupCompletedAt: row.cleanupCompletedAt ?? now,
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
function view(row: Selectable<AgentConnectionTable>, state: AgentConnectionState): AgentConnection {
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
    expiresAt: row.expiresAt.toISOString(),
  };
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
