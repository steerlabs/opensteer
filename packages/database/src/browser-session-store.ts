import { z } from "zod";
import {
  lockCommandIdempotency,
  findCommandByIdempotency,
  idempotencyConflict,
  jsonValue,
  principalIdForUser,
} from "./store-primitives.js";
import { withDatabaseTransaction } from "./connection.js";
import { withRequestWorkspaceLocks } from "./request-workspace-locks.js";
import {
  type BrowserProfileAccess,
  BrowserProfileAccessSchema,
} from "@opensteer/browser-profile/grant";
import {
  type BrowserProfileGrantId,
  type BrowserProfileId,
  BrowserProfileIdSchema,
  type WorkspaceId,
  type UserId,
  type RunnerId,
  type AgentEvent,
  BrowserProfileGrantIdSchema,
  OpensteerError,
  createId,
  type RunId,
  RunIdSchema,
  nonTerminalRunStatuses,
  type ContentPart,
  IntegrationCallSubjectSchema,
  type ThreadId,
} from "@opensteer/core";
import {
  type BrowserSessionId,
  type BrowserSessionOpenerRecord,
  browserTabOpenReplayWindowMs,
  type BrowserTabOpenBinding,
  BrowserTabOpenBindingSchema,
  type HostedBrowserSessionState,
  browserSessionMaxAttachedRuns,
  type BrowserSessionUsageProjection,
  browserUsageRunBatchSize,
  browserUsageTabsPerRun,
  BrowserSurfaceIdSchema,
  browserPageSite,
  browserSessionMaxThreads,
  type ThreadPlaceReference,
} from "@opensteer/protocol";
import { type Transaction, sql, type ExpressionBuilder, type Kysely } from "kysely";
import { type DatabaseSchema } from "./schema.js";
import { cancelPending } from "./request-store.js";
import { createHash } from "node:crypto";

export const browserProfileCheckpointGraceMs = 2 * 60_000;

export interface ActiveBrowserProfileGrantRecord {
  readonly access: BrowserProfileAccess;
  readonly createdAt: Date;
  readonly grantId: BrowserProfileGrantId;
  readonly profileId: BrowserProfileId;
  readonly workspaceId: WorkspaceId;
}

export interface RevokedBrowserProfileGrantRecord {
  readonly grantId: BrowserProfileGrantId;
  readonly profileId: BrowserProfileId;
  readonly workspaceId: WorkspaceId;
}

export interface BrowserProfileRecord {
  readonly id: BrowserProfileId;
  readonly name: string;
  readonly ownerId: UserId;
  readonly revision: number;
}

export interface BrowserSessionRecord {
  readonly opener?: BrowserSessionOpenerRecord | null;
  readonly createdAt: Date;
  readonly runnerId: RunnerId;
  readonly id: BrowserSessionId;
  readonly origin: "agent" | "trigger" | "workspace";
  readonly placementKey: string;
  /** Null for a fresh session. */
  readonly profileId: BrowserProfileId | null;
  readonly runtimeId: string;
  readonly state: HostedBrowserSessionState;
  readonly updatedAt: Date;
  readonly workspaceId: WorkspaceId;
}

export interface BrowserSessionWithAttachmentCountRecord extends BrowserSessionRecord {
  readonly activeAttachmentCount: number;
}

export interface BrowserProfileRevisionRecord {
  readonly createdAt: Date;
  readonly ciphertext: Uint8Array;
  readonly ciphertextSha256: string;
  readonly revision: number;
}

/**
 * A Browser Session belongs to the owner of its profile; a fresh session has no
 * profile to own, so its Workspace membership is what binds it to a user.
 */
async function browserRequestWorkspaces(
  transaction: Transaction<DatabaseSchema>,
  sessionIds: readonly BrowserSessionId[],
) {
  if (sessionIds.length === 0) return [];
  return (
    await transaction
      .selectFrom("requests")
      .select(["originatingWorkspaceId", "targetWorkspaceId"])
      .where("kind", "=", "browser.profile.save")
      .where("status", "=", "pending")
      .where(sql<boolean>`requests.payload ->> 'sessionId' in (${sql.join(sessionIds)})`)
      .execute()
  ).flatMap((row) => [row.originatingWorkspaceId, row.targetWorkspaceId]);
}

async function cancelBrowserProfileSaveRequests(
  transaction: Transaction<DatabaseSchema>,
  sessionIds: readonly BrowserSessionId[],
  resolvedAt: Date,
): Promise<readonly AgentEvent[]> {
  if (sessionIds.length === 0) return [];
  const requests = await transaction
    .selectFrom("requests")
    .select("id")
    .where("kind", "=", "browser.profile.save")
    .where("status", "=", "pending")
    .where(sql<boolean>`requests.payload ->> 'sessionId' in (${sql.join(sessionIds)})`)
    .execute();
  return cancelPending(transaction, {
    reason: "resource-deleted",
    requestIds: requests.map(({ id }) => id),
    resolvedAt,
  });
}

export function ownedBrowserSession(
  expression: ExpressionBuilder<DatabaseSchema, "browserProfiles" | "browserSessions">,
  ownerId: UserId,
) {
  return expression.or([
    expression("browserProfiles.ownerId", "=", ownerId),
    expression.and([
      expression("browserSessions.profileId", "is", null),
      expression.exists(
        expression
          .selectFrom("workspaceMemberships")
          .select("workspaceMemberships.id")
          .whereRef("workspaceMemberships.workspaceId", "=", "browserSessions.workspaceId")
          .where("workspaceMemberships.userId", "=", ownerId)
          .where("workspaceMemberships.state", "=", "active"),
      ),
    ]),
  ]);
}

function inheritedMainBrowserGrantId(
  ownerId: UserId,
  workspaceId: WorkspaceId,
  profileId: BrowserProfileId,
): BrowserProfileGrantId {
  const bytes = createHash("sha256")
    .update(
      ["opensteer-main-inherited-browser-v1", ownerId, workspaceId, profileId].join("\0"),
      "utf8",
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return BrowserProfileGrantIdSchema.parse(
    `bpg_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export async function createBrowserProfile(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly idempotencyKey: string;
    readonly name: string;
    readonly ownerId: UserId;
  },
): Promise<BrowserProfileRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.ownerId, input.idempotencyKey);
    const command = await findCommandByIdempotency(
      transaction,
      input.ownerId,
      input.idempotencyKey,
    );
    if (command) {
      const recorded = z
        .object({ profileId: BrowserProfileIdSchema, request: z.object({ name: z.string() }) })
        .safeParse(command.payload);
      if (
        command.type !== "browser.profile.create" ||
        !recorded.success ||
        recorded.data.request.name !== input.name
      )
        throw idempotencyConflict(input.idempotencyKey);
      const profile = await transaction
        .selectFrom("browserProfiles")
        .select(["id", "name", "ownerId", "revision"])
        .where("id", "=", recorded.data.profileId)
        .where("ownerId", "=", input.ownerId)
        .where("archivedAt", "is", null)
        .executeTakeFirst();
      // A replay after deletion must not hand the deleted profile back.
      if (!profile) {
        throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
      }
      return profile;
    }
    await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-profile:${input.ownerId}`}, 0))`.execute(
      transaction,
    );
    const existing = await transaction
      .selectFrom("browserProfiles")
      .select("id")
      .where("ownerId", "=", input.ownerId)
      .where("archivedAt", "is", null)
      .limit(128)
      .execute();
    if (existing.length >= 128) {
      throw new OpensteerError({
        code: "conflict",
        message: "Browser profile limit reached",
      });
    }
    const profile = await transaction
      .insertInto("browserProfiles")
      .values({
        archivedAt: null,
        id: createId("browserProfile"),
        name: input.name,
        ownerId: input.ownerId,
      })
      .returning(["id", "name", "ownerId", "revision"])
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("commands")
      .values({
        actorPrincipalId: await principalIdForUser(transaction, input.ownerId),
        authoritySource: jsonValue({ kind: "user-session", userId: input.ownerId }),
        dispatcherId: null,
        environmentId: null,
        id: createId("command"),
        idempotencyKey: input.idempotencyKey,
        lastError: null,
        payload: jsonValue({
          type: "browser.profile.create",
          profileId: profile.id,
          request: { name: input.name },
        }),
        requestedBy: input.ownerId,
        runId: null,
        status: "succeeded",
        threadId: null,
        type: "browser.profile.create",
      })
      .executeTakeFirstOrThrow();
    return profile;
  });
}

export async function createBrowserProfileWithRevision(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ciphertext: Uint8Array;
    readonly ciphertextSha256: string;
    readonly id: BrowserProfileId;
    readonly name: string;
    readonly ownerId: UserId;
    readonly revision: 1;
  },
): Promise<BrowserProfileRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-profile:${input.ownerId}`}, 0))`.execute(
      transaction,
    );
    const active = await transaction
      .selectFrom("browserProfiles")
      .select("id")
      .where("ownerId", "=", input.ownerId)
      .where("archivedAt", "is", null)
      .limit(128)
      .execute();
    if (active.length >= 128) {
      throw new OpensteerError({ code: "conflict", message: "Browser profile limit reached" });
    }
    const profile = await transaction
      .insertInto("browserProfiles")
      .values({
        archivedAt: null,
        id: input.id,
        name: input.name,
        ownerId: input.ownerId,
        revision: input.revision,
      })
      .returning(["id", "name", "ownerId", "revision"])
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("browserProfileRevisions")
      .values({
        ciphertext: input.ciphertext,
        ciphertextSha256: input.ciphertextSha256,
        profileId: input.id,
        revision: input.revision,
      })
      .executeTakeFirstOrThrow();
    return profile;
  });
}

export async function getBrowserProfile(
  database: Kysely<DatabaseSchema>,
  profileId: BrowserProfileId,
  ownerId: UserId,
): Promise<BrowserProfileRecord | null> {
  const row = await database
    .selectFrom("browserProfiles")
    .select(["id", "name", "ownerId", "revision"])
    .where("id", "=", profileId)
    .where("ownerId", "=", ownerId)
    .where("archivedAt", "is", null)
    .executeTakeFirst();
  return row ?? null;
}

export async function listBrowserProfiles(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<readonly BrowserProfileRecord[]> {
  return database
    .selectFrom("browserProfiles")
    .select(["id", "name", "ownerId", "revision"])
    .where("ownerId", "=", ownerId)
    .where("archivedAt", "is", null)
    .orderBy("createdAt", "asc")
    .limit(129)
    .execute();
}

/** A deleted profile, or another person's, is not found. */
export async function renameBrowserProfile(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly name: string;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  },
): Promise<BrowserProfileRecord> {
  const row = await database
    .updateTable("browserProfiles")
    .set({ name: input.name, updatedAt: new Date() })
    .where("id", "=", input.profileId)
    .where("ownerId", "=", input.ownerId)
    .where("archivedAt", "is", null)
    .returning(["id", "name", "ownerId", "revision"])
    .executeTakeFirst();
  if (!row) throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
  return row;
}

/**
 * Deletes one of the owner's profiles in one transaction: its waiting and open
 * tabs close, its saved state is erased and its grants are revoked. It holds
 * the session lock that every session start and revision commit takes, and the
 * grant lock that every grant takes, so no session, save or grant can follow.
 * The row stays, archived, because sessions keep naming the identity they were
 * created with.
 *
 * Returns the profile's live sessions for the caller to stop. Nothing durable
 * is left to them: a Host that stops before they do fails them on restart.
 */
export async function deleteBrowserProfile(
  database: Kysely<DatabaseSchema>,
  input: { readonly ownerId: UserId; readonly profileId: BrowserProfileId },
): Promise<{ readonly sessionIds: readonly BrowserSessionId[] }> {
  return withDatabaseTransaction(database, async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-profile-session:${input.profileId}`}, 0))`.execute(
      transaction,
    );
    const owned = await transaction
      .selectFrom("browserProfiles")
      .select("id")
      .where("id", "=", input.profileId)
      .where("ownerId", "=", input.ownerId)
      .executeTakeFirst();
    if (!owned) {
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
    }
    // No session can join these lineages while the session lock is held.
    const lineages = await transaction
      .selectFrom("browserSessions as session")
      .select("session.tabGroupId")
      .where("session.profileId", "=", input.profileId)
      .where(({ exists, not, selectFrom }) =>
        not(
          exists(
            selectFrom("browserSessions as newer")
              .select("newer.id")
              .whereRef("newer.tabGroupId", "=", "session.tabGroupId")
              .where(sql<boolean>`(newer.created_at, newer.id) > (session.created_at, session.id)`),
          ),
        ),
      )
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("workspaceTabs as tab")
            .select("tab.id")
            .whereRef("tab.groupId", "=", "session.tabGroupId")
            .where("tab.closedAt", "is", null),
        ),
      )
      .orderBy("session.tabGroupId")
      .execute();
    const groupIds = lineages.map((lineage) => lineage.tabGroupId);
    const now = new Date();
    if (groupIds.length > 0) {
      // Each lineage, then its tabs, in key order, as closing one lineage locks them.
      await transaction
        .selectFrom("browserSessions")
        .select("id")
        .where("id", "in", groupIds)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("workspaceTabs")
        .select("id")
        .where("groupId", "in", groupIds)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      await transaction
        .updateTable("workspaceTabs")
        .set({ closedAt: now })
        .where("groupId", "in", groupIds)
        .where("closedAt", "is", null)
        .execute();
      await transaction
        .updateTable("browserSessions")
        .set((eb) => ({ tabRevision: eb("tabRevision", "+", 1) }))
        .where("id", "in", groupIds)
        .execute();
    }
    await transaction
      .updateTable("browserProfiles")
      .set({ archivedAt: now, updatedAt: now })
      .where("id", "=", input.profileId)
      .where("archivedAt", "is", null)
      .execute();
    await transaction
      .deleteFrom("browserProfileRevisions")
      .where("profileId", "=", input.profileId)
      .execute();
    await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-grants:${input.ownerId}`}, 0))`.execute(
      transaction,
    );
    await transaction
      .updateTable("browserProfileGrants")
      .set({ revokedAt: now })
      .where("profileId", "=", input.profileId)
      .where("revokedAt", "is", null)
      .execute();
    const live = await transaction
      .selectFrom("browserSessions")
      .select("id")
      .where("profileId", "=", input.profileId)
      .where("state", "not in", ["closed", "failed"])
      .orderBy("id")
      .execute();
    return { sessionIds: live.map((session) => session.id) };
  });
}

export async function readBrowserProfileRevision(
  database: Kysely<DatabaseSchema>,
  profileId: BrowserProfileId,
): Promise<BrowserProfileRevisionRecord | null> {
  const row = await database
    .selectFrom("browserProfileRevisions")
    .select(["ciphertext", "ciphertextSha256", "revision", "createdAt"])
    .where("profileId", "=", profileId)
    .orderBy("revision", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

export async function commitBrowserProfileRevision(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ciphertext: Uint8Array;
    readonly ciphertextSha256: string;
    readonly expectedRevision: number;
    readonly periodic?: boolean;
    readonly profileId: BrowserProfileId;
  },
): Promise<BrowserProfileRevisionRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-profile-session:${input.profileId}`}, 0))`.execute(
      transaction,
    );
    const closingSessions = await transaction
      .selectFrom("browserSessions")
      .select("id")
      .where("profileId", "=", input.profileId)
      .where("state", "in", ["closed", "failed"])
      .where("profileLeaseExpiresAt", "is not", null)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
    const profile = await transaction
      .selectFrom("browserProfiles")
      .select(["archivedAt", "revision"])
      .where("id", "=", input.profileId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!profile || profile.archivedAt) {
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
    }
    if (profile.revision !== input.expectedRevision) {
      throw new OpensteerError({ code: "conflict", message: "Browser profile revision changed" });
    }
    const revision = profile.revision + 1;
    const row = await transaction
      .insertInto("browserProfileRevisions")
      .values({
        ciphertext: input.ciphertext,
        ciphertextSha256: input.ciphertextSha256,
        profileId: input.profileId,
        revision,
      })
      .returning(["ciphertext", "ciphertextSha256", "revision", "createdAt"])
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("browserProfiles")
      .set({ revision, updatedAt: new Date() })
      .where("id", "=", input.profileId)
      .where("revision", "=", input.expectedRevision)
      .executeTakeFirstOrThrow();
    // Only the newest revision is ever read, and a profile in use saves
    // repeatedly; earlier ciphertexts are dead weight.
    await transaction
      .deleteFrom("browserProfileRevisions")
      .where("profileId", "=", input.profileId)
      .where("revision", "<", revision)
      .execute();
    // A session may end during this checkpoint. Release grace only for the rows
    // locked before the profile, never acquire a new session lock underneath it.
    if (!input.periodic && closingSessions.length > 0)
      await transaction
        .updateTable("browserSessions")
        .set({ profileLeaseExpiresAt: new Date(), updatedAt: new Date() })
        .where(
          "id",
          "in",
          closingSessions.map(({ id }) => id),
        )
        .execute();
    return row;
  });
}

export async function authorizeBrowserProfileLease(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly leaseTokenHash: string;
    readonly profileId: BrowserProfileId;
    readonly sessionId: BrowserSessionId;
  },
): Promise<boolean> {
  const row = await database
    .selectFrom("browserSessions")
    .select("id")
    .where("id", "=", input.sessionId)
    .where("profileId", "=", input.profileId)
    .where("leaseTokenHash", "=", input.leaseTokenHash)
    .where((expression) =>
      expression.or([
        expression("state", "in", ["starting", "ready", "closing"]),
        expression.and([
          expression("state", "in", ["closed", "failed"]),
          expression("profileLeaseExpiresAt", ">", new Date()),
        ]),
      ]),
    )
    .executeTakeFirst();
  return Boolean(row);
}

export async function createBrowserSession(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly tabGroupId?: BrowserSessionId;
    readonly opener?: BrowserSessionOpenerRecord | null;
    readonly id: BrowserSessionId;
    readonly leaseGeneration: number;
    readonly leaseTokenHash: string | null;
    readonly placementKey: string;
    readonly runnerId: RunnerId;
    readonly origin: "agent" | "trigger" | "workspace";
    readonly profileId: BrowserProfileId | null;
    readonly runtimeId: string;
    readonly workspaceId: WorkspaceId;
  },
): Promise<BrowserSessionRecord> {
  const profileId = input.profileId;
  return withDatabaseTransaction(database, async (transaction) => {
    // A fresh session holds no profile, so no placement affinity or profile
    // session budget applies to it.
    if (profileId !== null) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-profile-session:${profileId}`}, 0))`.execute(
        transaction,
      );
      // Under the lock a deletion takes, so a session cannot outlive its profile.
      const profile = await transaction
        .selectFrom("browserProfiles")
        .select("archivedAt")
        .where("id", "=", profileId)
        .executeTakeFirst();
      if (!profile || profile.archivedAt) {
        throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
      }
      const placementHolders = await transaction
        .selectFrom("browserSessions")
        .select(["id", "placementKey", "state"])
        .where("profileId", "=", profileId)
        .where((expression) =>
          expression.or([
            expression("state", "in", ["starting", "ready", "closing"]),
            expression.and([
              expression("state", "in", ["closed", "failed"]),
              expression("profileLeaseExpiresAt", ">", new Date()),
            ]),
          ]),
        )
        .limit(65)
        .execute();
      if (placementHolders.some((session) => session.placementKey !== input.placementKey)) {
        throw new OpensteerError({
          code: "conflict",
          message: "This browser profile is already active on another placement",
        });
      }
      const active = placementHolders.filter((session) => session.state !== "closed");
      if (active.length >= 32) {
        throw new OpensteerError({
          code: "conflict",
          message: "Browser profile session limit reached",
        });
      }
    }
    return transaction
      .insertInto("browserSessions")
      .values({
        tabGroupId: input.tabGroupId ?? input.id,
        closedAt: null,
        runnerId: input.runnerId,
        id: input.id,
        leaseGeneration: input.leaseGeneration,
        leaseTokenHash: input.leaseTokenHash,
        origin: input.origin,
        opener: input.opener ?? null,
        profileLeaseExpiresAt: null,
        placementKey: input.placementKey,
        profileId: input.profileId,
        runtimeId: input.runtimeId,
        state: "starting",
        workspaceId: input.workspaceId,
      })
      .returning([
        "createdAt",
        "runnerId",
        "id",
        "origin",
        "opener",
        "placementKey",
        "profileId",
        "runtimeId",
        "state",
        "updatedAt",
        "workspaceId",
      ])
      .executeTakeFirstOrThrow();
  });
}

export async function countBrowserSessionAttachments(
  database: Kysely<DatabaseSchema>,
  sessionId: BrowserSessionId,
): Promise<number> {
  const row = await database
    .selectFrom("browserSessionAttachments")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("sessionId", "=", sessionId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function findActiveBrowserSessionForWorkspace(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<BrowserSessionRecord | null> {
  const row = await database
    .selectFrom("browserSessions")
    .select([
      "createdAt",
      "runnerId",
      "id",
      "origin",
      "opener",
      "placementKey",
      "profileId",
      "runtimeId",
      "state",
      "updatedAt",
      "workspaceId",
    ])
    .where("workspaceId", "=", workspaceId)
    .where("origin", "=", "workspace")
    .where("state", "in", ["starting", "ready", "closing"])
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
  return row ?? null;
}

/** A binding's active sessions, most recently attached first. */
export async function listActiveBrowserSessionsForAgentBinding(
  database: Kysely<DatabaseSchema>,
  agentBindingId: string,
): Promise<readonly BrowserSessionRecord[]> {
  return database
    .selectFrom("browserSessionAttachments")
    .innerJoin("browserSessions", "browserSessions.id", "browserSessionAttachments.sessionId")
    .select([
      "browserSessions.createdAt",
      "browserSessions.runnerId",
      "browserSessions.id",
      "browserSessions.origin",
      "browserSessions.opener",
      "browserSessions.placementKey",
      "browserSessions.profileId",
      "browserSessions.runtimeId",
      "browserSessions.state",
      "browserSessions.updatedAt",
      "browserSessions.workspaceId",
    ])
    .where("browserSessionAttachments.agentBindingId", "=", agentBindingId)
    .where("browserSessions.state", "in", ["starting", "ready", "closing"])
    .orderBy("browserSessionAttachments.updatedAt", "desc")
    .orderBy("browserSessionAttachments.sessionId", "desc")
    .limit(100)
    .execute();
}

export async function listAttachedRunIdsForBrowserSessions(
  database: Kysely<DatabaseSchema>,
  sessionIds: readonly BrowserSessionId[],
): Promise<ReadonlyMap<BrowserSessionId, readonly RunId[]>> {
  if (sessionIds.length === 0) return new Map();
  // Each session's most recent Runs only, however many attachments linger.
  const ranked = database
    .selectFrom("browserSessionAttachments")
    .select([
      "sessionId",
      "agentBindingId",
      sql<number>`row_number() over (partition by ${sql.ref("sessionId")} order by ${sql.ref("createdAt")} desc)`.as(
        "recency",
      ),
    ])
    .where("sessionId", "in", sessionIds)
    .where("agentBindingId", "like", "run:%");
  const rows = await database
    .selectFrom(ranked.as("ranked"))
    .select(["ranked.sessionId", "ranked.agentBindingId"])
    .where("ranked.recency", "<=", browserSessionMaxAttachedRuns)
    .orderBy("ranked.recency")
    .execute();
  const attached = new Map<BrowserSessionId, RunId[]>();
  for (const row of rows) {
    const runId = RunIdSchema.safeParse(row.agentBindingId.slice("run:".length));
    if (!runId.success) continue;
    attached.set(row.sessionId, [...(attached.get(row.sessionId) ?? []), runId.data]);
  }
  return attached;
}

/** The Run behind an agent binding, or null for a Trigger, watch or malformed binding. */
function bindingRunId(agentBindingId: string): RunId | null {
  if (!agentBindingId.startsWith("run:")) return null;
  const parsed = RunIdSchema.safeParse(agentBindingId.slice("run:".length));
  return parsed.success ? parsed.data : null;
}

export async function authorizedPlaceThreadIds(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  threadIds: readonly ThreadId[],
): Promise<readonly ThreadId[]> {
  if (threadIds.length === 0) return [];
  const rows = await database
    .selectFrom("threads")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
    .select("threads.id")
    .where("threads.id", "in", threadIds)
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .execute();
  return rows.map(({ id }) => id);
}

/** Reconstruct quiet native references from Host-resolved subjects and successful results.
 * The transcript is already durable; pictures and helper sessions are never recovered here.
 */
export async function latestNativePlaces(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<readonly ThreadPlaceReference[]> {
  const result = await sql<{
    threadId: ThreadId;
    runId: RunId;
    integration: unknown;
    at: Date;
  }>`
    with recursive native_calls as (
      select distinct on (s.run_id, s.runner_binding_generation, s.data->>'callId', coalesce(s.data->>'nodeId', ''))
        s.run_id, s.data->'integration' as integration, c.created_at as at, c.sequence
      from workspace_events s join workspace_events c
        on c.run_id = s.run_id and c.type = 'tool.completed'
        and c.runner_binding_generation is not distinct from s.runner_binding_generation
        and c.data->>'callId' = s.data->>'callId'
        and coalesce(c.data->>'nodeId', '') = coalesce(s.data->>'nodeId', '')
        and c.sequence > s.sequence and c.data->>'isError' = 'false'
      where s.type = 'tool.started'
        and s.data->'tool'->>'namespace' = 'opensteer.integrations'
        and (s.data->'tool'->>'name' = 'integration_call'
          or (s.runner_ordinal is null and c.runner_ordinal is null
            and s.data->'tool'->>'name' in ('computer.windows', 'computer.bind', 'computer.observe',
              'computer.click', 'computer.type', 'computer.key', 'computer.setValue', 'computer.scroll', 'computer.act')))
        and (s.data->'integration'->'computerApp'->>'runnerId' is not null
          or s.data->'integration'->'phone'->>'runnerId' is not null)
        and s.data->'integration'->'operation'->>'name' in ('observe', 'act')
      order by s.run_id, s.runner_binding_generation, s.data->>'callId', coalesce(s.data->>'nodeId', ''), c.sequence
    ), lineage as (
      select n.*, r.thread_id, r.assignment_id, 0 as depth, array[]::text[] as path
      from native_calls n join runs r on r.id = n.run_id
      union all
      select l.run_id, l.integration, l.at, l.sequence, d.parent_thread_id, d.parent_assignment_id,
        l.depth + 1, l.path || d.id::text
      from lineage l join delegations d on d.id = l.assignment_id
      where l.depth < 64 and not d.id::text = any(l.path)
    ), addressed as (
      select distinct on (l.run_id, l.sequence) l.*
      from lineage l join threads t on t.id = l.thread_id join workspaces w on w.id = t.workspace_id
      where t.listed or w.home_thread_id = t.id
      order by l.run_id, l.sequence, l.depth
    )
    select distinct on (a.thread_id) a.thread_id, a.run_id, a.integration, a.at
    from addressed a join threads t on t.id = a.thread_id
    join workspace_memberships m on m.workspace_id = t.workspace_id
    where m.user_id = ${ownerId} and m.state = 'active'
      and not exists (select 1 from browser_session_uses b where b.thread_id = a.thread_id and b.last_used_at > a.at)
    order by a.thread_id, a.at desc, a.sequence desc limit 4096
  `.execute(database);
  return result.rows.flatMap((row, order) => {
    const parsed = IntegrationCallSubjectSchema.safeParse(row.integration);
    if (!parsed.success) return [];
    const subject = parsed.data;
    const place = subject.computerApp
      ? {
          kind: "app" as const,
          machineId: subject.computerApp.runnerId,
          appKey: subject.computerApp.bundleId.toLowerCase(),
        }
      : subject.phone
        ? { kind: "phone" as const, machineId: subject.phone.runnerId, display: "main" }
        : null;
    return place
      ? [
          {
            threadId: row.threadId,
            runId: row.runId,
            place,
            title: subject.computerApp?.app ?? subject.phone!.computer,
            site: null,
            iconRef: null,
            order,
            at: row.at.toISOString(),
          },
        ]
      : [];
  });
}

export async function resolvePlaceActors(
  database: Kysely<DatabaseSchema>,
  input: { readonly agentBindingIds: readonly string[]; readonly ownerIds: readonly UserId[] },
): Promise<
  readonly {
    agentBindingId: string;
    ownerId: UserId;
    runId: RunId;
    threadId: ThreadId;
    home: boolean;
    generation: number;
    lineageThreadIds: ThreadId[];
    lineageWorkspaceIds: WorkspaceId[];
  }[]
> {
  const runIds = input.agentBindingIds.flatMap((binding) => {
    const id = bindingRunId(binding);
    return id ? [id] : [];
  });
  if (!runIds.length || !input.ownerIds.length) return [];
  const lineage = await sql<{
    runId: RunId;
    threadId: ThreadId;
    home: boolean;
    generation: number;
    workspaceId: WorkspaceId;
    lineageThreadIds: ThreadId[];
    lineageWorkspaceIds: WorkspaceId[];
  }>`
    with recursive lineage as (
      select r.id as run_id, r.thread_id, r.assignment_id, r.binding_generation as generation, 0 as depth,
        array[]::text[] as path
      from runs r where r.id in (${sql.join(runIds)}) and r.status in (${sql.join(nonTerminalRunStatuses)}) and r.binding_generation is not null
      union all
      select l.run_id, d.parent_thread_id, d.parent_assignment_id, l.generation, l.depth + 1, l.path || d.id::text
      from lineage l join delegations d on d.id = l.assignment_id
      where l.depth < 64 and not d.id::text = any(l.path)
    )
    select distinct on (l.run_id) l.run_id, l.thread_id, l.generation, w.id as workspace_id,
      (w.home_thread_id = t.id) as home, array(select l2.thread_id from lineage l2 where l2.run_id = l.run_id order by l2.depth) as lineage_thread_ids,
      array(select distinct t2.workspace_id from lineage l2 join threads t2 on t2.id = l2.thread_id where l2.run_id = l.run_id) as lineage_workspace_ids
    from lineage l join threads t on t.id = l.thread_id join workspaces w on w.id = t.workspace_id
    where t.listed or w.home_thread_id = t.id order by l.run_id, l.depth
  `.execute(database);
  if (!lineage.rows.length) return [];
  const members = await database
    .selectFrom("workspaceMemberships")
    .select(["workspaceId", "userId"])
    .where("workspaceId", "in", [...new Set(lineage.rows.map((row) => row.workspaceId))])
    .where("userId", "in", input.ownerIds)
    .where("state", "=", "active")
    .execute();
  return lineage.rows.flatMap((row) =>
    members
      .filter((member) => member.workspaceId === row.workspaceId)
      .map((member) => ({
        agentBindingId: `run:${row.runId}`,
        ownerId: member.userId,
        runId: row.runId,
        threadId: row.threadId,
        home: row.home === true,
        generation: row.generation,
        lineageThreadIds: row.lineageThreadIds,
        lineageWorkspaceIds: row.lineageWorkspaceIds,
      })),
  );
}

export async function resolvePlaceActor(
  database: Kysely<DatabaseSchema>,
  input: { readonly agentBindingId: string; readonly ownerId: UserId },
) {
  return (
    (
      await resolvePlaceActors(database, {
        agentBindingIds: [input.agentBindingId],
        ownerIds: [input.ownerId],
      })
    )[0] ?? null
  );
}

/** A historical page counts as held only while that exact Run is still attached and live. */
export async function listBrowserPlaceHoldings(
  database: Kysely<DatabaseSchema>,
  sessionId: BrowserSessionId,
) {
  return database
    .selectFrom("browserSessionAttachments as a")
    .innerJoin("runs as r", (join) => join.on(sql<boolean>`a.agent_binding_id = 'run:' || r.id`))
    .innerJoin("browserSessionUses as u", (join) =>
      join.onRef("u.runId", "=", "r.id").onRef("u.sessionId", "=", "a.sessionId"),
    )
    .select(["a.agentBindingId", "a.ownerId", "u.tabId", "u.lastUsedAt"])
    .where("a.sessionId", "=", sessionId)
    .where("r.status", "in", nonTerminalRunStatuses)
    .where("u.tabId", "is not", null)
    .distinct()
    .execute();
}

/**
 * Records that a binding holds a session now; true when it did not already.
 *
 * A Run's binding holds a session only while the Run is active. The Run's row
 * is read under a share lock, so the check and the write are one step against
 * the Run's end: an attachment can never be written after the end that would
 * detach it, however long the caller waited before asking.
 */
export async function attachBrowserSession(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<boolean> {
  return withDatabaseTransaction(database, async (transaction) => {
    if (input.agentBindingId.startsWith("run:")) {
      const runId = bindingRunId(input.agentBindingId);
      const run = runId
        ? await transaction
            .selectFrom("runs")
            .select("status")
            .where("id", "=", runId)
            .forShare()
            .executeTakeFirst()
        : undefined;
      if (!run || !(nonTerminalRunStatuses as readonly string[]).includes(run.status)) {
        return false;
      }
    }
    const row = await transaction
      .insertInto("browserSessionAttachments")
      .values({
        agentBindingId: input.agentBindingId,
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
      })
      .onConflict((conflict) =>
        // Recency orders a binding's sessions, so it comes from the one clock
        // the insert's default also reads.
        conflict.columns(["agentBindingId", "sessionId"]).doUpdateSet({
          ownerId: input.ownerId,
          updatedAt: sql<Date>`now()`,
          workspaceId: input.workspaceId,
        }),
      )
      // An inserted row has no deleting transaction; an updated one does.
      .returning(sql<boolean>`(xmax = 0)`.as("created"))
      .executeTakeFirstOrThrow();
    return row.created;
  });
}

/** What a page showed when it was used: its title and its site (origin). */
export interface BrowserUsePage {
  readonly title: string;
  readonly site: string;
}

/** A conversation whose visible browser usage changed, and its Workspace. */
export interface BrowserUsageCredit {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  /**
   * The catalog's conversation list changed: a first use, or a revisit that
   * changes its recency order (including re-entering the bounded list).
   */
  readonly joined: boolean;
  /** Sessions whose catalog changed; their viewers can span the conversation's Workspace. */
  readonly catalogSessionIds?: readonly BrowserSessionId[];
}

/** One use as it is written: who used which session, by which Run and page. */
interface BrowserSessionUseWrite {
  readonly sessionId: BrowserSessionId;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly tabId: string | null;
  readonly page: BrowserUsePage | null;
}

/**
 * Records, durably, that a Run used a session and which page. It credits the
 * Run's own conversation and every conversation in its Assignment lineage at
 * the time of use, whether or not the Run is still active: a use that happened
 * stays true after the Run ends. Returns conversations whose visible usage
 * changed; timestamp-only repeats at the head of the projection stay silent.
 */
export async function recordAgentBrowserUse(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
    readonly tabId: string | null;
    readonly page: BrowserUsePage | null;
  },
): Promise<readonly BrowserUsageCredit[]> {
  const runId = bindingRunId(input.agentBindingId);
  if (!runId) return [];
  return withDatabaseTransaction(database, async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .select(["id", "threadId", "assignmentId"])
      .where("id", "=", runId)
      .where("requestedBy", "=", input.ownerId)
      .executeTakeFirst();
    if (!run) return [];
    const ancestors = run.assignmentId
      ? await sql<{ threadId: ThreadId }>`
          with recursive lineage as (
            select id, parent_thread_id, parent_assignment_id, array[id] as path
            from delegations where id = ${run.assignmentId}
            union all
            select parent.id, parent.parent_thread_id, parent.parent_assignment_id, lineage.path || parent.id
            from delegations parent join lineage on parent.id = lineage.parent_assignment_id
            where not parent.id = any(lineage.path)
          ) select distinct parent_thread_id as thread_id from lineage
        `.execute(transaction)
      : { rows: [] };
    const threadIds = new Set([run.threadId, ...ancestors.rows.map((row) => row.threadId)]);
    return creditedWorkspaces(
      transaction,
      await writeBrowserSessionUses(
        transaction,
        [...threadIds].map((threadId) => ({
          page: input.page,
          runId: run.id,
          sessionId: input.sessionId,
          tabId: input.tabId,
          threadId,
        })),
      ),
    );
  });
}

async function creditedWorkspaces(
  database: Kysely<DatabaseSchema>,
  gained: ReadonlyMap<ThreadId, Pick<BrowserUsageCredit, "joined" | "catalogSessionIds">>,
): Promise<readonly BrowserUsageCredit[]> {
  if (gained.size === 0) return [];
  const threads = await database
    .selectFrom("threads")
    .select(["id as threadId", "workspaceId"])
    .where("id", "in", [...gained.keys()])
    .orderBy("id")
    .execute();
  return threads.map((thread) => ({
    ...thread,
    ...gained.get(thread.threadId)!,
  }));
}

/**
 * The row key of one use. Its identity — session, conversation, Run and page —
 * is what the unique constraint decides on; the key only has to differ
 * whenever the identity does, whatever a page's id says.
 */
function browserSessionUseId(identity: {
  readonly sessionId: BrowserSessionId;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly tabId: string | null;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([identity.sessionId, identity.threadId, identity.runId, identity.tabId]),
      "utf8",
    )
    .digest("base64url");
  return `bsu_${digest}`;
}

/**
 * Writes uses, each with its conversation's membership in the session: the
 * row with no Run and no page, which records no page of its own, so a later
 * use that saw none never makes an older page look like the latest one.
 * Rows are written in ascending key order, as every writer of them does.
 * Returns the conversations whose page projection changed, and whether the
 * catalog's conversation list changed too.
 */
async function writeBrowserSessionUses(
  database: Kysely<DatabaseSchema>,
  uses: readonly BrowserSessionUseWrite[],
): Promise<ReadonlyMap<ThreadId, Pick<BrowserUsageCredit, "joined" | "catalogSessionIds">>> {
  if (uses.length === 0) return new Map();
  // Included pages are written after message authority locks, so serialize
  // usage here without acquiring the earlier Browser Session lifecycle lock.
  for (const sessionId of [...new Set(uses.map((use) => use.sessionId))].sort()) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-session-use:${sessionId}`}, 0))`.execute(
      database,
    );
  }
  const projectionKey = (use: BrowserSessionUseWrite) =>
    browserSessionUseId({ ...use, tabId: null });
  const projections = new Map(uses.map((use) => [projectionKey(use), use]));
  const readProjections = async () =>
    new Map(
      await Promise.all(
        [...projections].map(
          async ([key, use]) => [key, await browserSessionUseProjection(database, use)] as const,
        ),
      ),
    );
  const before = await readProjections();
  const membership = (use: BrowserSessionUseWrite): BrowserSessionUseWrite => ({
    ...use,
    page: null,
    runId: null,
    tabId: null,
  });
  const rows = new Map<string, BrowserSessionUseWrite>();
  for (const use of uses) {
    const membershipId = browserSessionUseId(membership(use));
    if (!rows.has(membershipId)) rows.set(membershipId, membership(use));
    rows.set(browserSessionUseId(use), use);
  }
  const created = new Set<string>();
  for (const [id, row] of [...rows].sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (await upsertBrowserSessionUseRow(database, id, row)) created.add(id);
  }
  const after = await readProjections();
  const gained = new Map<ThreadId, Pick<BrowserUsageCredit, "joined" | "catalogSessionIds">>();
  for (const use of uses) {
    const previous = before.get(projectionKey(use))!;
    const current = after.get(projectionKey(use))!;
    const joined = previous.catalog !== current.catalog;
    if (!joined && !created.has(browserSessionUseId(use)) && previous.usage === current.usage)
      continue;
    const prior = gained.get(use.threadId);
    const catalogSessionIds = [
      ...new Set([...(prior?.catalogSessionIds ?? []), ...(joined ? [use.sessionId] : [])]),
    ];
    gained.set(use.threadId, {
      joined: joined || prior?.joined === true,
      ...(catalogSessionIds.length > 0 ? { catalogSessionIds } : {}),
    });
  }
  return gained;
}

/** Compare visible identities, order and labels; timestamps alone do not invalidate a client. */
async function browserSessionUseProjection(
  database: Kysely<DatabaseSchema>,
  use: BrowserSessionUseWrite,
): Promise<{ readonly catalog: string; readonly usage: string }> {
  const conversation = database
    .selectFrom("browserSessionUses")
    .where("sessionId", "=", use.sessionId)
    .where("threadId", "=", use.threadId);
  const [pages, latest, catalog] = await Promise.all([
    conversation
      .select(["tabId", "pageTitle", "pageSite"])
      .where("runId", use.runId === null ? "is" : "=", use.runId)
      .$if(use.runId === null, (query) => query.where("tabId", "is not", null))
      .orderBy(sql`(tab_id is not null)`, "desc")
      .orderBy("lastUsedAt", "desc")
      .orderBy("id", "desc")
      .limit(browserUsageTabsPerRun)
      .execute(),
    conversation
      .select(["pageTitle", "pageSite"])
      .where("pageSite", "is not", null)
      .orderBy("lastUsedAt", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst(),
    // Keep the order before the viewer-specific membership filter: any move
    // can change a viewer's latest sixteen, even below the global sixteenth.
    database
      .selectFrom("browserSessionUses")
      .select("threadId")
      .where("sessionId", "=", use.sessionId)
      .where("runId", "is", null)
      .where("tabId", "is", null)
      .orderBy("lastUsedAt", "desc")
      .orderBy("threadId")
      .execute(),
  ]);
  const hasPages = pages.some((page) => page.tabId !== null);
  return {
    catalog: JSON.stringify(catalog),
    usage: JSON.stringify([
      latest ?? null,
      pages.filter((page) => !hasPages || page.tabId !== null),
    ]),
  };
}

async function upsertBrowserSessionUseRow(
  database: Kysely<DatabaseSchema>,
  id: string,
  input: BrowserSessionUseWrite,
): Promise<boolean> {
  const pageTitle = input.page ? input.page.title.slice(0, 256) : null;
  const pageSite = input.page ? input.page.site.slice(0, 2048) : null;
  const row = await database
    .insertInto("browserSessionUses")
    .values({
      id,
      pageSite,
      pageTitle,
      runId: input.runId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      threadId: input.threadId,
    })
    .onConflict((conflict) =>
      conflict.constraint("browser_session_uses_identity").doUpdateSet({
        lastUsedAt: sql<Date>`now()`,
        // A use that saw no page keeps what an earlier use of it saw.
        pageSite: sql<string | null>`coalesce(excluded.page_site, browser_session_uses.page_site)`,
        pageTitle: sql<
          string | null
        >`coalesce(excluded.page_title, browser_session_uses.page_title)`,
      }),
    )
    .returning(sql<boolean>`(xmax = 0)`.as("created"))
    .executeTakeFirstOrThrow();
  return row.created;
}

/**
 * Records that a person brought a browser into a conversation: they opened it
 * there (no page), or included one of its pages in a message. The person must
 * be an active member of the conversation's Workspace and able to see the
 * session. Returns the conversation when its visible usage changes.
 */
export async function recordBrowserSessionUse(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly sessionId: BrowserSessionId;
    readonly threadId: ThreadId;
    readonly ownerId: UserId;
    readonly tabId?: string | null;
    readonly page?: BrowserUsePage | null;
  },
): Promise<readonly BrowserUsageCredit[]> {
  return withDatabaseTransaction(database, async (transaction) => {
    const workspaceId = await personBrowserThreadWorkspace(transaction, input);
    if (
      !workspaceId ||
      !(await getBrowserSessionForOwner(transaction, input.sessionId, input.ownerId))
    )
      throw new OpensteerError({ code: "not_found", message: "Browser conversation not found." });
    const gained = await writeBrowserSessionUses(transaction, [
      {
        page: input.page ?? null,
        runId: null,
        sessionId: input.sessionId,
        tabId: input.tabId ?? null,
        threadId: input.threadId,
      },
    ]);
    const credit = gained.get(input.threadId);
    return credit ? [{ ...credit, threadId: input.threadId, workspaceId }] : [];
  });
}

/** The conversation's Workspace, when the person is an active member of it. */
async function personBrowserThreadWorkspace(
  database: Kysely<DatabaseSchema>,
  input: { readonly ownerId: UserId; readonly threadId: ThreadId },
): Promise<WorkspaceId | null> {
  const thread = await database
    .selectFrom("threads")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
    .select("threads.workspaceId")
    .where("threads.id", "=", input.threadId)
    .where("workspaceMemberships.userId", "=", input.ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .executeTakeFirst();
  return thread?.workspaceId ?? null;
}

/**
 * Credits a conversation with the pages a person included in a message, in
 * the transaction that keeps the message, so the message never exists without
 * its pages counting as used there. A page of a session the sender can no
 * longer see refuses the message.
 */
export async function recordIncludedBrowserPages(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly content: readonly ContentPart[];
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
  },
): Promise<readonly BrowserUsageCredit[]> {
  const pages = input.content.flatMap((part) => (part.type === "browser-page" ? [part] : []));
  if (pages.length === 0) return [];
  const workspaceId = await personBrowserThreadWorkspace(transaction, input);
  if (!workspaceId) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
  for (const page of pages) {
    if (await getBrowserSessionForOwner(transaction, page.sessionId, input.ownerId)) continue;
    throw new OpensteerError({
      code: "forbidden",
      message: `This message includes the browser page "${page.title || browserPageSite(page.url)}", which you can no longer see. Remove the page and send the message again.`,
    });
  }
  const gained = await writeBrowserSessionUses(
    transaction,
    pages.map((page) => ({
      page: { site: browserPageSite(page.url), title: page.title },
      runId: null,
      sessionId: page.sessionId,
      tabId: page.tabId,
      threadId: input.threadId,
    })),
  );
  const credit = gained.get(input.threadId);
  return credit ? [{ ...credit, threadId: input.threadId, workspaceId }] : [];
}

/**
 * Who may see one Browser Session now, by the rule the catalog reads it with:
 * a profile's owner sees its sessions, and a fresh session is seen by the
 * active members of its Workspace. Null when the session does not exist.
 */
export async function listBrowserSessionViewers(
  database: Kysely<DatabaseSchema>,
  sessionId: BrowserSessionId,
): Promise<{ readonly userIds: readonly UserId[]; readonly workspaceId: WorkspaceId } | null> {
  const session = await database
    .selectFrom("browserSessions")
    .leftJoin("browserProfiles", "browserProfiles.id", "browserSessions.profileId")
    .select([
      "browserSessions.profileId",
      "browserSessions.workspaceId",
      "browserProfiles.ownerId as profileOwnerId",
    ])
    .where("browserSessions.id", "=", sessionId)
    .executeTakeFirst();
  if (!session) return null;
  if (session.profileId !== null) {
    return {
      userIds: session.profileOwnerId ? [session.profileOwnerId] : [],
      workspaceId: session.workspaceId,
    };
  }
  const members = await database
    .selectFrom("workspaceMemberships")
    .select("userId")
    .where("workspaceId", "=", session.workspaceId)
    .where("state", "=", "active")
    .execute();
  return { userIds: members.map(({ userId }) => userId), workspaceId: session.workspaceId };
}

export async function detachBrowserSessionAttachments(
  database: Kysely<DatabaseSchema>,
  agentBindingId: string,
): Promise<readonly BrowserSessionId[]> {
  const detached = await database
    .deleteFrom("browserSessionAttachments")
    .where("agentBindingId", "=", agentBindingId)
    .returning("sessionId")
    .execute();
  return detached.map((row) => row.sessionId);
}

export async function detachBrowserSessionAttachmentsForProfileGrant(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<number> {
  const sessionIds = database
    .selectFrom("browserSessions")
    .innerJoin("browserProfiles", "browserProfiles.id", "browserSessions.profileId")
    .select("browserSessions.id")
    .where("browserProfiles.ownerId", "=", input.ownerId)
    .where("browserSessions.profileId", "=", input.profileId)
    .where("browserSessions.workspaceId", "=", input.workspaceId);
  const result = await database
    .deleteFrom("browserSessionAttachments")
    .where("sessionId", "in", sessionIds)
    .where("ownerId", "=", input.ownerId)
    .where("workspaceId", "=", input.workspaceId)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function findBrowserSessionHoldingProfilePlacement(
  database: Kysely<DatabaseSchema>,
  profileId: BrowserProfileId,
): Promise<BrowserSessionRecord | null> {
  const row = await database
    .selectFrom("browserSessions")
    .select([
      "createdAt",
      "runnerId",
      "id",
      "origin",
      "opener",
      "placementKey",
      "profileId",
      "runtimeId",
      "state",
      "updatedAt",
      "workspaceId",
    ])
    .where("profileId", "=", profileId)
    .where((expression) =>
      expression.or([
        expression("state", "in", ["starting", "ready", "closing"]),
        expression.and([
          expression("state", "in", ["closed", "failed"]),
          expression("profileLeaseExpiresAt", ">", new Date()),
        ]),
      ]),
    )
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
  return row ?? null;
}

export async function getBrowserSessionForOwner(
  database: Kysely<DatabaseSchema>,
  sessionId: BrowserSessionId,
  ownerId: UserId,
): Promise<BrowserSessionRecord | null> {
  const row = await database
    .selectFrom("browserSessions")
    .leftJoin("browserProfiles", "browserProfiles.id", "browserSessions.profileId")
    .select([
      "browserSessions.createdAt",
      "browserSessions.runnerId",
      "browserSessions.id",
      "browserSessions.origin",
      "browserSessions.opener",
      "browserSessions.placementKey",
      "browserSessions.profileId",
      "browserSessions.runtimeId",
      "browserSessions.state",
      "browserSessions.updatedAt",
      "browserSessions.workspaceId",
    ])
    .where("browserSessions.id", "=", sessionId)
    .where((expression) => ownedBrowserSession(expression, ownerId))
    .executeTakeFirst();
  return row ?? null;
}

export async function listBrowserSessions(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<readonly BrowserSessionRecord[]> {
  return (
    database
      .selectFrom("browserSessions")
      .leftJoin("browserProfiles", "browserProfiles.id", "browserSessions.profileId")
      .select([
        "browserSessions.createdAt",
        "browserSessions.runnerId",
        "browserSessions.id",
        "browserSessions.origin",
        "browserSessions.opener",
        "browserSessions.placementKey",
        "browserSessions.profileId",
        "browserSessions.runtimeId",
        "browserSessions.state",
        "browserSessions.updatedAt",
        "browserSessions.workspaceId",
      ])
      .where((expression) => ownedBrowserSession(expression, ownerId))
      // The bounded bootstrap catalog must never hide a live session behind
      // newer closed sessions kept as history.
      .orderBy(
        sql<number>`case when ${sql.ref("browserSessions.state")} in ('starting', 'ready', 'closing') then 0 else 1 end`,
      )
      .orderBy("browserSessions.createdAt", "desc")
      .limit(100)
      .execute()
  );
}

/**
 * The conversations using each session that the reader can open — they are an
 * active member of its Workspace — at most `browserSessionMaxThreads` per
 * session, most recently active first. A conversation uses a session from its
 * first use of it; its membership row moves with every later one.
 */
export async function listBrowserSessionThreads(
  database: Kysely<DatabaseSchema>,
  input: { readonly ownerId: UserId; readonly sessionIds: readonly BrowserSessionId[] },
): Promise<ReadonlyMap<BrowserSessionId, readonly ThreadId[]>> {
  if (input.sessionIds.length === 0) return new Map();
  const ranked = database
    .selectFrom("browserSessionUses")
    .innerJoin("threads", "threads.id", "browserSessionUses.threadId")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
    .select([
      "browserSessionUses.sessionId",
      "browserSessionUses.threadId",
      sql<number>`row_number() over (partition by browser_session_uses.session_id order by browser_session_uses.last_used_at desc, browser_session_uses.thread_id)`.as(
        "recency",
      ),
    ])
    .where("browserSessionUses.sessionId", "in", input.sessionIds)
    .where("browserSessionUses.runId", "is", null)
    .where("browserSessionUses.tabId", "is", null)
    .where("workspaceMemberships.userId", "=", input.ownerId)
    .where("workspaceMemberships.state", "=", "active");
  const rows = await database
    .selectFrom(ranked.as("ranked"))
    .select(["ranked.sessionId", "ranked.threadId"])
    .where("ranked.recency", "<=", browserSessionMaxThreads)
    .orderBy("ranked.sessionId")
    .orderBy("ranked.recency")
    .execute();
  const threads = new Map<BrowserSessionId, ThreadId[]>();
  for (const row of rows) {
    threads.set(row.sessionId, [...(threads.get(row.sessionId) ?? []), row.threadId]);
  }
  return threads;
}

/**
 * One conversation's browser use, within the reader's bounded catalog: per
 * session, its membership (no Run, no page), the latest pages people included,
 * and for each requested Run the latest distinct pages it used — or, for a Run
 * that never chose a page, its use of the session. Each Run and the people
 * keep at most `browserUsageTabsPerRun` pages per session.
 */
export async function getThreadBrowserUsage(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
    readonly runIds: readonly RunId[];
  },
): Promise<readonly BrowserSessionUsageProjection[]> {
  if (input.runIds.length > browserUsageRunBatchSize) {
    throw new OpensteerError({ code: "bad_request", message: "Too many browser Run references" });
  }
  // The catalog read already applies who may see which session.
  const sessions = await listBrowserSessions(database, input.ownerId);
  if (sessions.length === 0) return [];
  const sessionIds = sessions.map(({ id }) => id);
  const uses = database
    .selectFrom("browserSessionUses")
    .innerJoin("threads", "threads.id", "browserSessionUses.threadId")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
    .where("browserSessionUses.threadId", "=", input.threadId)
    .where("browserSessionUses.sessionId", "in", sessionIds)
    .where("workspaceMemberships.userId", "=", input.ownerId)
    .where("workspaceMemberships.state", "=", "active");
  const latestSeen = (column: "page_site" | "page_title") =>
    sql<
      string | null
    >`(array_agg(${sql.ref(`browser_session_uses.${column}`)} order by browser_session_uses.last_used_at desc, browser_session_uses.id desc) filter (where browser_session_uses.page_site is not null))[1]`;
  const ranked = uses
    .select([
      "browserSessionUses.sessionId",
      "browserSessionUses.threadId",
      "browserSessionUses.runId",
      "browserSessionUses.tabId",
      "browserSessionUses.pageTitle",
      "browserSessionUses.pageSite",
      "browserSessionUses.firstUsedAt",
      "browserSessionUses.lastUsedAt",
      sql<number>`row_number() over (partition by browser_session_uses.session_id, browser_session_uses.run_id order by (browser_session_uses.tab_id is not null) desc, browser_session_uses.last_used_at desc, browser_session_uses.id desc)`.as(
        "recency",
      ),
      sql<boolean>`bool_or(browser_session_uses.tab_id is not null) over (partition by browser_session_uses.session_id, browser_session_uses.run_id)`.as(
        "hasPages",
      ),
    ])
    .where((expression) =>
      expression.or([
        expression.and([
          expression("browserSessionUses.runId", "is", null),
          expression("browserSessionUses.tabId", "is not", null),
        ]),
        ...(input.runIds.length > 0
          ? [expression("browserSessionUses.runId", "in", input.runIds)]
          : []),
      ]),
    );
  const [memberships, pages] = await Promise.all([
    uses
      .select(["browserSessionUses.sessionId", "browserSessionUses.threadId"])
      .select(({ fn }) => [
        fn.min<Date>("browserSessionUses.firstUsedAt").as("firstUsedAt"),
        fn.max<Date>("browserSessionUses.lastUsedAt").as("lastUsedAt"),
        latestSeen("page_title").as("pageTitle"),
        latestSeen("page_site").as("pageSite"),
      ])
      .groupBy(["browserSessionUses.sessionId", "browserSessionUses.threadId"])
      .orderBy("browserSessionUses.sessionId")
      .execute(),
    database
      .selectFrom(ranked.as("ranked"))
      .select([
        "ranked.sessionId",
        "ranked.threadId",
        "ranked.runId",
        "ranked.tabId",
        "ranked.pageTitle",
        "ranked.pageSite",
        "ranked.firstUsedAt",
        "ranked.lastUsedAt",
      ])
      .where("ranked.recency", "<=", browserUsageTabsPerRun)
      // A Run's use of the session stands in for its pages only when it chose none.
      .where((expression) =>
        expression.or([
          expression("ranked.tabId", "is not", null),
          expression.not(expression.ref("ranked.hasPages")),
        ]),
      )
      .orderBy("ranked.sessionId")
      .orderBy("ranked.runId")
      .orderBy("ranked.recency")
      .execute(),
  ]);
  return [...memberships.map((row) => ({ ...row, runId: null, tabId: null })), ...pages].map(
    (row) => ({
      ...row,
      tabId: row.tabId === null ? null : BrowserSurfaceIdSchema.parse(row.tabId),
      firstUsedAt: row.firstUsedAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
    }),
  );
}

export async function listActiveBrowserSessionsForAgent(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly allOwnerWorkspaces: boolean;
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<readonly BrowserSessionWithAttachmentCountRecord[]> {
  let query = database
    .selectFrom("browserSessions")
    .leftJoin("browserProfiles", "browserProfiles.id", "browserSessions.profileId")
    .select([
      "browserSessions.createdAt",
      "browserSessions.runnerId",
      "browserSessions.id",
      "browserSessions.origin",
      "browserSessions.opener",
      "browserSessions.placementKey",
      "browserSessions.profileId",
      "browserSessions.runtimeId",
      "browserSessions.state",
      "browserSessions.updatedAt",
      "browserSessions.workspaceId",
    ])
    .select((expression) =>
      expression
        .selectFrom("browserSessionAttachments")
        .select(({ fn }) => fn.countAll<string>().as("activeAttachmentCount"))
        .whereRef("browserSessionAttachments.sessionId", "=", "browserSessions.id")
        .as("activeAttachmentCount"),
    )
    .where((expression) => ownedBrowserSession(expression, input.ownerId))
    .where("browserSessions.state", "in", ["starting", "ready", "closing"]);
  if (!input.allOwnerWorkspaces) {
    query = query.where("browserSessions.workspaceId", "=", input.workspaceId);
  }
  const rows = await query.orderBy("browserSessions.createdAt", "desc").limit(100).execute();
  return rows.map((row) => ({
    ...row,
    activeAttachmentCount: Number(row.activeAttachmentCount),
  }));
}

export async function failActiveBrowserSessions(
  database: Kysely<DatabaseSchema>,
  placementKey?: string,
): Promise<{
  readonly events: readonly AgentEvent[];
  readonly failed: number;
}> {
  const now = new Date();
  const profileLeaseExpiresAt = new Date(now.getTime() + browserProfileCheckpointGraceMs);
  let sessionIds: BrowserSessionId[] = [];
  return withRequestWorkspaceLocks(
    database,
    (transaction) => browserRequestWorkspaces(transaction, sessionIds),
    async (transaction) => {
      if (sessionIds.length === 0) return { events: [], failed: 0 };
      let transactionalUpdate = transaction
        .updateTable("browserSessions")
        .set({
          closedAt: now,
          // A Runtime whose Host disappeared may still hold the newest profile
          // state. Keep only its narrow profile-state lease alive long enough
          // to checkpoint after the Host restarts; the Browser Session itself
          // is failed immediately and cannot be reattached.
          profileLeaseExpiresAt,
          state: "failed",
          updatedAt: now,
        })
        .where("id", "in", sessionIds)
        .where("state", "in", ["starting", "ready", "closing"]);
      if (placementKey) {
        transactionalUpdate = transactionalUpdate.where("placementKey", "=", placementKey);
      }
      const failed = await transactionalUpdate.returning("id").execute();
      if (failed.length > 0) {
        await transaction
          .deleteFrom("browserSessionAttachments")
          .where(
            "sessionId",
            "in",
            failed.map((session) => session.id),
          )
          .execute();
      }
      return {
        events: await cancelBrowserProfileSaveRequests(
          transaction,
          failed.map(({ id }) => id),
          now,
        ),
        failed: failed.length,
      };
    },
    async (transaction) => {
      sessionIds = (
        await transaction
          .selectFrom("browserSessions")
          .select("id")
          .where("state", "in", ["starting", "ready", "closing"])
          .$if(placementKey !== undefined, (query) =>
            query.where("placementKey", "=", placementKey!),
          )
          .orderBy("id", "asc")
          .forNoKeyUpdate()
          .execute()
      ).map(({ id }) => id);
    },
  );
}

export async function transitionBrowserSession(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly from?: readonly HostedBrowserSessionState[];
    readonly sessionId: BrowserSessionId;
    readonly state: HostedBrowserSessionState;
  },
): Promise<{
  readonly events: readonly AgentEvent[];
  readonly session: BrowserSessionRecord;
}> {
  return withRequestWorkspaceLocks(
    database,
    (transaction) => browserRequestWorkspaces(transaction, [input.sessionId]),
    async (transaction) => {
      const now = new Date();
      // A session ends cleanly or because its Runtime's connection dropped; in
      // both the Runtime may hold newer profile state than the vault, so its
      // lease outlives the session long enough to hand that state back, as it
      // does when the Host restarts. Its final commit ends the grace early.
      const profileLeaseExpiresAt =
        input.state === "closed" || input.state === "failed"
          ? new Date(now.getTime() + browserProfileCheckpointGraceMs)
          : null;
      let update = transaction
        .updateTable("browserSessions")
        .set({
          ...(input.state === "closed" || input.state === "failed" ? { closedAt: now } : {}),
          profileLeaseExpiresAt,
          state: input.state,
          updatedAt: now,
        })
        .where("id", "=", input.sessionId)
        .where("state", "not in", ["closed", "failed"]);
      if (input.from) update = update.where("state", "in", [...input.from]);
      const row = await update
        .returning([
          "createdAt",
          "runnerId",
          "id",
          "origin",
          "opener",
          "placementKey",
          "profileId",
          "runtimeId",
          "state",
          "updatedAt",
          "workspaceId",
        ])
        .executeTakeFirst();
      if (row) {
        if (input.state === "closed" || input.state === "failed") {
          await transaction
            .selectFrom("browserSessionAttachments")
            .select(["agentBindingId", "sessionId"])
            .where("sessionId", "=", input.sessionId)
            .orderBy("agentBindingId", "asc")
            .orderBy("sessionId", "asc")
            // FOR UPDATE: These attachments are deleted below; lock their keys in order.
            .forUpdate()
            .execute();
          await transaction
            .deleteFrom("browserSessionAttachments")
            .where("sessionId", "=", input.sessionId)
            .execute();
        }
        return {
          events:
            input.state === "closing" || input.state === "closed" || input.state === "failed"
              ? await cancelBrowserProfileSaveRequests(transaction, [input.sessionId], now)
              : [],
          session: row,
        };
      }
      const existing = await transaction
        .selectFrom("browserSessions")
        .select([
          "createdAt",
          "runnerId",
          "id",
          "origin",
          "opener",
          "placementKey",
          "profileId",
          "runtimeId",
          "state",
          "updatedAt",
          "workspaceId",
        ])
        .where("id", "=", input.sessionId)
        .executeTakeFirst();
      if (!existing) {
        throw new OpensteerError({ code: "not_found", message: "Browser session not found" });
      }
      if (existing.state === "closed" || existing.state === "failed") {
        return { events: [], session: existing };
      }
      if (existing.state === input.state) {
        return {
          events:
            input.state === "closing"
              ? await cancelBrowserProfileSaveRequests(transaction, [input.sessionId], now)
              : [],
          session: existing,
        };
      }
      throw new OpensteerError({
        code: "conflict",
        message: `Browser session cannot transition from ${existing.state} to ${input.state}`,
      });
    },
    (transaction) =>
      transaction
        .selectFrom("browserSessions")
        .select("id")
        .where("id", "=", input.sessionId)
        .forNoKeyUpdate()
        .execute(),
  );
}

export async function createBrowserProfileGrant(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly access: BrowserProfileAccess;
    readonly createdBy: UserId;
    readonly id?: BrowserProfileGrantId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<ActiveBrowserProfileGrantRecord> {
  const id = input.id ?? createId("browserProfileGrant");
  return withDatabaseTransaction(database, async (transaction) => {
    await transaction
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const membership = await transaction
      .selectFrom("workspaceMemberships")
      .select(["role", "state"])
      .where("workspaceId", "=", input.workspaceId)
      .where("userId", "=", input.createdBy)
      .forNoKeyUpdate()
      .executeTakeFirst();
    await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-grants:${input.createdBy}`}, 0))`.execute(
      transaction,
    );
    const [profile, existing, activeOwnerGrants] = await Promise.all([
      // Read under the grant lock a deletion also takes, so a deleted profile is never granted.
      transaction
        .selectFrom("browserProfiles")
        .select(["archivedAt", "ownerId"])
        .where("id", "=", input.profileId)
        .executeTakeFirst(),
      transaction
        .selectFrom("browserProfileGrants")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("createdBy", "=", input.createdBy)
        .where("profileId", "=", input.profileId)
        .where("revokedAt", "is", null)
        .executeTakeFirst(),
      transaction
        .selectFrom("browserProfileGrants")
        .innerJoin("browserProfiles", "browserProfiles.id", "browserProfileGrants.profileId")
        .select("browserProfileGrants.id")
        .where("browserProfileGrants.revokedAt", "is", null)
        .where("browserProfiles.ownerId", "=", input.createdBy)
        .limit(100)
        .execute(),
    ]);
    if (!profile) {
      throw new OpensteerError({
        code: "not_found",
        message: "Workspace or browser profile not found",
      });
    }
    if (
      !membership ||
      membership.state !== "active" ||
      profile.ownerId !== input.createdBy ||
      profile.archivedAt
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "A Workspace member may grant only their own active browser profile",
      });
    }
    if (existing) {
      throw new OpensteerError({
        code: "conflict",
        message: "This browser profile is already granted to the Workspace",
      });
    }
    if (activeOwnerGrants.length >= 100) {
      throw new OpensteerError({
        code: "resource_exhausted",
        message: "Active browser grant limit reached",
      });
    }
    const row = await transaction
      .insertInto("browserProfileGrants")
      .values({
        access: input.access,
        createdBy: input.createdBy,
        id,
        profileId: input.profileId,
        revokedAt: null,
        workspaceId: input.workspaceId,
      })
      .returning(["access", "createdAt", "id", "profileId", "workspaceId"])
      .executeTakeFirstOrThrow();
    return {
      access: BrowserProfileAccessSchema.parse(row.access),
      createdAt: row.createdAt,
      grantId: row.id,
      profileId: row.profileId,
      workspaceId: row.workspaceId,
    };
  });
}

export async function listActiveBrowserProfileGrantsForWorkspace(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  ownerId: UserId,
): Promise<readonly ActiveBrowserProfileGrantRecord[]> {
  const mainWorkspace = await database
    .selectFrom("workspaces")
    .select("id")
    .where("id", "=", workspaceId)
    .where("createdBy", "=", ownerId)
    .where("kind", "=", "main")
    .executeTakeFirst();
  if (mainWorkspace) {
    const profiles = await database
      .selectFrom("browserProfiles")
      .select(["createdAt", "id"])
      .where("ownerId", "=", ownerId)
      .where("archivedAt", "is", null)
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(129)
      .execute();
    return profiles.map((profile) => ({
      access: "full-control" as const,
      createdAt: profile.createdAt,
      grantId: inheritedMainBrowserGrantId(ownerId, workspaceId, profile.id),
      profileId: profile.id,
      workspaceId,
    }));
  }
  const rows = await database
    .selectFrom("browserProfileGrants")
    .innerJoin(
      "workspaceMemberships",
      "workspaceMemberships.workspaceId",
      "browserProfileGrants.workspaceId",
    )
    .select([
      "browserProfileGrants.createdAt",
      "browserProfileGrants.access",
      "browserProfileGrants.id as grantId",
      "browserProfileGrants.profileId",
      "browserProfileGrants.workspaceId",
    ])
    .where("browserProfileGrants.workspaceId", "=", workspaceId)
    .where("browserProfileGrants.revokedAt", "is", null)
    .where("browserProfileGrants.createdBy", "=", ownerId)
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .orderBy("browserProfileGrants.createdAt", "asc")
    .limit(129)
    .execute();
  return rows.map((row) => ({
    access: BrowserProfileAccessSchema.parse(row.access),
    createdAt: row.createdAt,
    grantId: row.grantId,
    profileId: row.profileId,
    workspaceId: row.workspaceId,
  }));
}

export async function listActiveBrowserProfileGrants(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<readonly ActiveBrowserProfileGrantRecord[]> {
  const rows = await database
    .selectFrom("browserProfileGrants")
    .innerJoin(
      "workspaceMemberships",
      "workspaceMemberships.workspaceId",
      "browserProfileGrants.workspaceId",
    )
    .select([
      "browserProfileGrants.createdAt",
      "browserProfileGrants.access",
      "browserProfileGrants.id as grantId",
      "browserProfileGrants.profileId",
      "browserProfileGrants.workspaceId",
    ])
    .where("browserProfileGrants.revokedAt", "is", null)
    .where("browserProfileGrants.createdBy", "=", ownerId)
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .orderBy("browserProfileGrants.createdAt", "asc")
    .limit(101)
    .execute();
  return rows.map((row) => ({
    access: BrowserProfileAccessSchema.parse(row.access),
    createdAt: row.createdAt,
    grantId: row.grantId,
    profileId: row.profileId,
    workspaceId: row.workspaceId,
  }));
}

export async function revokeBrowserProfileGrant(
  database: Kysely<DatabaseSchema>,
  grantId: BrowserProfileGrantId,
  revokedBy: UserId,
): Promise<RevokedBrowserProfileGrantRecord> {
  const row = await database
    .updateTable("browserProfileGrants")
    .set({ revokedAt: new Date() })
    .where("id", "=", grantId)
    .where("createdBy", "=", revokedBy)
    .where("revokedAt", "is", null)
    .returning(["id", "profileId", "workspaceId"])
    .executeTakeFirst();
  if (!row) {
    throw new OpensteerError({ code: "not_found", message: "Active grant not found" });
  }
  return {
    grantId: row.id,
    profileId: row.profileId,
    workspaceId: row.workspaceId,
  };
}

export async function getBrowserTabOpen(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  idempotencyKey: string,
): Promise<BrowserTabOpenBinding | null> {
  const row = await database
    .selectFrom("browserTabOpens")
    .select("binding")
    .where("ownerId", "=", ownerId)
    .where("idempotencyKey", "=", idempotencyKey)
    .executeTakeFirst();
  return row ? BrowserTabOpenBindingSchema.parse(row.binding) : null;
}

/** The operation is durable before a runtime is allowed to create or navigate a page. */
export async function bindBrowserTabOpen(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly binding: BrowserTabOpenBinding;
    readonly identityKey: string | null;
    readonly runnerId: RunnerId;
  },
): Promise<void> {
  await database
    .insertInto("browserTabOpens")
    .values({
      ownerId: input.binding.callerUserId,
      idempotencyKey: input.binding.idempotencyKey,
      binding: input.binding,
      identityKey: input.identityKey,
      runnerId: input.runnerId,
    })
    .execute();
  // Keep the guaranteed replay window and one successful placement preference per identity.
  await sql`
    with remembered as (
      select distinct on (identity_key) idempotency_key
      from browser_tab_opens
      where owner_id = ${input.binding.callerUserId} and identity_key is not null
        and binding->'outcome'->>'kind' = 'opened'
      order by identity_key, created_at desc, idempotency_key desc
    )
    delete from browser_tab_opens
    where owner_id = ${input.binding.callerUserId}
      and created_at < now() - ${browserTabOpenReplayWindowMs} * interval '1 millisecond'
      and idempotency_key not in (select idempotency_key from remembered)
  `.execute(database);
}

export async function settleBrowserTabOpen(
  database: Kysely<DatabaseSchema>,
  binding: BrowserTabOpenBinding,
): Promise<void> {
  await database
    .updateTable("browserTabOpens")
    .set({ binding })
    .where("ownerId", "=", binding.callerUserId)
    .where("idempotencyKey", "=", binding.idempotencyKey)
    .executeTakeFirstOrThrow();
}

export async function rememberedBrowserPlacement(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  identityKey: string,
): Promise<RunnerId | null> {
  const row = await database
    .selectFrom("browserTabOpens")
    .select("runnerId")
    .where("ownerId", "=", ownerId)
    .where("identityKey", "=", identityKey)
    .where(sql<string>`binding->'outcome'->>'kind'`, "=", "opened")
    .orderBy("createdAt", "desc")
    .orderBy("idempotencyKey", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.runnerId ?? null;
}

export async function browserSessionOpenerForBinding(
  database: Kysely<DatabaseSchema>,
  agentBindingId: string,
  ownerId: UserId,
): Promise<BrowserSessionOpenerRecord | null> {
  // Trigger provenance is recorded at its authenticated call site, never inferred from current occupants.
  if (agentBindingId.startsWith("trigger:")) return { kind: "automation" };
  const runId = bindingRunId(agentBindingId);
  if (!runId) return null;
  const result = await sql<{ threadId: ThreadId; home: boolean }>`
    with recursive lineage as (
      select r.thread_id, r.assignment_id, 0 as depth, array[]::text[] as path
      from runs r where r.id = ${runId}
      union all
      select d.parent_thread_id, d.parent_assignment_id, l.depth + 1, l.path || d.id::text
      from lineage l join delegations d on d.id = l.assignment_id
      where l.depth < 64 and not d.id::text = any(l.path)
    )
    select t.id as thread_id, (w.home_thread_id = t.id) as home
    from lineage l join threads t on t.id = l.thread_id join workspaces w on w.id = t.workspace_id
    join workspace_memberships m on m.workspace_id = t.workspace_id
    where (t.listed or w.home_thread_id = t.id) and m.user_id = ${ownerId} and m.state = 'active'
    order by l.depth limit 1
  `.execute(database);
  const row = result.rows[0];
  if (!row) return null;
  return row.home
    ? { kind: "opensteer", threadId: row.threadId }
    : { kind: "task", threadId: row.threadId, runId };
}
