import { withPersonalTransaction } from "./personal-transaction.js";
import { lockBrowserHomeRunner } from "./browser-home-store.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { assertPersonalOwner } from "./private-resource-owner.js";
import {
  eventDataSchemas,
  integrationGatewayNamespaces,
  placeIdentityKey,
  type EventData,
} from "@opensteer/core";
import { storableText } from "./runner-event-store.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import {
  type AgentEvent,
  type BrowserProfileId,
  BrowserProfileIdSchema,
  type ContentPart,
  IntegrationCallSubjectSchema,
  OpensteerError,
  type RunId,
  RunIdSchema,
  type RunnerId,
  type ThreadId,
  type UserId,
  createId,
  nonTerminalRunStatuses,
} from "@opensteer/core";
import type { LocalProfileBinding } from "@opensteer/protocol";
import {
  type BrowserSessionId,
  type BrowserSessionOpenerRecord,
  type BrowserSessionUsageProjection,
  BrowserSurfaceIdSchema,
  type BrowserTabOpenBinding,
  BrowserTabOpenBindingSchema,
  type HostedBrowserSessionState,
  type ThreadPlaceReference,
  browserPageSite,
  browserSessionMaxAttachedRuns,
  browserSessionMaxThreads,
  browserTabOpenReplayWindowMs,
  browserUsageRunBatchSize,
  browserUsageSessionsPerRead,
  browserUsageTabsPerRun,
} from "@opensteer/protocol";
import { type ExpressionBuilder, type Kysely, type Transaction, sql } from "kysely";
import { createHash } from "node:crypto";
import { z } from "zod";
import { lockBrowserHistory } from "./browser-history-store.js";
import {
  lockBrowserProfile,
  type NativeProfileDeletionResult,
  profileStorage,
  publicProfileDeletion,
  recordBrowserProfileDeletion,
} from "./browser-profile-storage-store.js";

import { databaseOperationOptions } from "./operation-budget.js";
import { type DatabaseSchema } from "./schema.js";
import {
  findCommandByIdempotency,
  idempotencyConflict,
  jsonValue,
  eventFromRow,
  lockCommandIdempotency,
  principalIdForUser,
} from "./store-primitives.js";

export interface BrowserProfileRecord {
  readonly homeRunnerId: RunnerId | null;
  readonly id: BrowserProfileId;
  readonly name: string;
  readonly ownerId: UserId;
}

export interface BrowserSessionRecord {
  readonly opener?: BrowserSessionOpenerRecord | null;
  readonly createdAt: Date;
  readonly runnerId: RunnerId;
  readonly id: BrowserSessionId;
  readonly origin: "agent" | "trigger" | "person";
  readonly placementKey: string;
  /** Null for a fresh session. */
  readonly profileId: BrowserProfileId | null;
  readonly runtimeId: string;
  readonly state: HostedBrowserSessionState;
  readonly updatedAt: Date;
}

export interface BrowserSessionWithAttachmentCountRecord extends BrowserSessionRecord {
  readonly activeAttachmentCount: number;
}

export function ownedBrowserSession(
  expression: ExpressionBuilder<DatabaseSchema, "browserProfiles" | "browserSessions">,
  ownerId: UserId,
) {
  return expression.and([
    expression.exists(
      expression
        .selectFrom("personalSettings")
        .innerJoin("users", "users.id", "personalSettings.ownerId")
        .select("personalSettings.ownerId")
        .where("personalSettings.ownerId", "=", ownerId)
        .where("users.disabledAt", "is", null),
    ),
    expression.or([
      expression.and([
        expression("browserProfiles.ownerId", "=", ownerId),
        expression("browserProfiles.archivedAt", "is", null),
      ]),
      expression("browserSessions.profileId", "is", null),
    ]),
  ]);
}

/**
 * Adds one profile within the owner's slots: the person's own command and an
 * approved browser-access Request both create profiles through here.
 */
export async function insertBrowserProfileOnLockedHome(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly name: string;
    readonly ownerId: UserId;
    readonly homeRunnerId: RunnerId | null;
  },
): Promise<BrowserProfileRecord> {
  await assertPersonalOwner(transaction, input.ownerId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-profile:${input.ownerId}`}, 0))`.execute(
    transaction,
    databaseOperationOptions(),
  );
  const existing = await transaction
    .selectFrom("browserProfiles")
    .select("id")
    .where("ownerId", "=", input.ownerId)
    // Pending erasure retains a slot until the owning computer confirms it.
    .where((eb) =>
      eb.or([
        eb("archivedAt", "is", null),
        eb.exists(
          eb
            .selectFrom("browserProfileDeletions")
            .select("profileId")
            .whereRef("profileId", "=", "browserProfiles.id")
            .where("state", "in", ["pending-computer", "pending-restart"]),
        ),
      ]),
    )
    .limit(128)
    .execute(databaseOperationOptions());
  if (existing.length >= 128) {
    throw new OpensteerError({ code: "conflict", message: "Browser profile limit reached" });
  }
  return await transaction
    .insertInto("browserProfiles")
    .values({
      archivedAt: null,
      id: createId("browserProfile"),
      name: input.name,
      ownerId: input.ownerId,
      homeRunnerId: input.homeRunnerId,
    })
    .returning(["id", "name", "ownerId", "homeRunnerId"])
    .executeTakeFirstOrThrow(databaseOperationOptions());
}

export async function createBrowserProfile(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly idempotencyKey: string;
    readonly homeRunnerId?: RunnerId | null;
    readonly name: string;
    readonly ownerId: UserId;
  },
): Promise<BrowserProfileRecord> {
  return withPersonalTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.ownerId, input.idempotencyKey);
    const command = await findCommandByIdempotency(
      transaction,
      input.ownerId,
      input.idempotencyKey,
    );
    if (command) {
      const recorded = z
        .object({
          profileId: BrowserProfileIdSchema,
          request: z.object({ name: z.string(), homeRunnerId: z.string().nullable().optional() }),
        })
        .safeParse(command.payload);
      if (
        command.type !== "browser.profile.create" ||
        !recorded.success ||
        recorded.data.request.name !== input.name ||
        recorded.data.request.homeRunnerId !== input.homeRunnerId
      )
        throw idempotencyConflict(input.idempotencyKey);
      const profile = await transaction
        .selectFrom("browserProfiles")
        .select(["id", "name", "ownerId", "homeRunnerId"])
        .where("id", "=", recorded.data.profileId)
        .where("ownerId", "=", input.ownerId)
        .where("archivedAt", "is", null)
        .executeTakeFirst(databaseOperationOptions());
      // A replay after deletion must not hand the deleted profile back.
      if (!profile) {
        throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
      }
      return profile;
    }
    const homeRunnerId =
      input.homeRunnerId === null
        ? null
        : await lockBrowserHomeRunner(transaction, input.ownerId, input.homeRunnerId);
    const profile = await insertBrowserProfileOnLockedHome(transaction, { ...input, homeRunnerId });
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
          request: {
            name: input.name,
            ...(input.homeRunnerId !== undefined ? { homeRunnerId: input.homeRunnerId } : {}),
          },
        }),
        requestedBy: input.ownerId,
        runId: null,
        status: "succeeded",
        threadId: null,
        type: "browser.profile.create",
      })
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return profile;
  });
}

export async function getBrowserProfile(
  database: Kysely<DatabaseSchema>,
  profileId: BrowserProfileId,
  ownerId: UserId,
): Promise<BrowserProfileRecord | null> {
  await assertPersonalOwner(database, ownerId);
  const row = await database
    .selectFrom("browserProfiles")
    .select(["id", "name", "ownerId", "homeRunnerId"])
    .where("id", "=", profileId)
    .where("ownerId", "=", ownerId)
    .where("archivedAt", "is", null)
    .executeTakeFirst(databaseOperationOptions());
  return row ?? null;
}

export async function listBrowserProfiles(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<readonly BrowserProfileRecord[]> {
  await assertPersonalOwner(database, ownerId);
  return database
    .selectFrom("browserProfiles")
    .select(["id", "name", "ownerId", "homeRunnerId"])
    .where("ownerId", "=", ownerId)
    .where("archivedAt", "is", null)
    .orderBy("createdAt", "asc")
    .limit(129)
    .execute(databaseOperationOptions());
}

/** A deleted profile, or another person's, is not found. */
export async function renameBrowserProfile(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly name: string;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  },
): Promise<BrowserProfileRecord> {
  return withPersonalTransaction(database, (transaction) =>
    administrationCommand(transaction, input.administration, async () => {
      await assertPersonalOwner(transaction, input.ownerId);
      const row = await transaction
        .updateTable("browserProfiles")
        .set({ name: input.name, updatedAt: new Date() })
        .where("id", "=", input.profileId)
        .where("ownerId", "=", input.ownerId)
        .where("archivedAt", "is", null)
        .returning(["id", "name", "ownerId", "homeRunnerId"])
        .executeTakeFirst(databaseOperationOptions());
      if (!row)
        throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
      return row;
    }),
  );
}

/** Archived identities remain named by session history until native erasure is confirmed. */
export async function deleteBrowserProfile(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  },
) {
  return withPersonalTransaction(database, async (transaction) => {
    // The profile lock ranks before the administration ledger's.
    await lockBrowserProfile(transaction, input.profileId);
    return administrationCommand(transaction, input.administration, () =>
      deleteBrowserProfileInTransaction(transaction, input),
    );
  });
}

export async function deleteBrowserProfileInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
    readonly deletionId?: string;
    readonly binding?: LocalProfileBinding;
  },
): Promise<NativeProfileDeletionResult> {
  await assertPersonalOwner(transaction, input.ownerId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-profile-session:${input.profileId}`}, 0))`.execute(
    transaction,
    databaseOperationOptions(),
  );
  const owned = await transaction
    .selectFrom("browserProfiles")
    .selectAll()
    .where("id", "=", input.profileId)
    .where("ownerId", "=", input.ownerId)
    .executeTakeFirst(databaseOperationOptions());
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
        selectFrom("personalTabs as tab")
          .select("tab.id")
          .whereRef("tab.groupId", "=", "session.tabGroupId")
          .where("tab.closedAt", "is", null),
      ),
    )
    .orderBy("session.tabGroupId")
    .execute(databaseOperationOptions());
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
      .execute(databaseOperationOptions());
    await transaction
      .selectFrom("personalTabs")
      .select("id")
      .where("groupId", "in", groupIds)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute(databaseOperationOptions());
    await transaction
      .updateTable("personalTabs")
      .set({ closedAt: now })
      .where("groupId", "in", groupIds)
      .where("closedAt", "is", null)
      .execute(databaseOperationOptions());
    await transaction
      .updateTable("browserSessions")
      .set((eb) => ({ tabRevision: eb("tabRevision", "+", 1) }))
      .where("id", "in", groupIds)
      .execute(databaseOperationOptions());
  }
  await transaction
    .updateTable("browserProfiles")
    .set({
      archivedAt: now,
      updatedAt: now,
    })
    .where("id", "=", input.profileId)
    .where("archivedAt", "is", null)
    .execute(databaseOperationOptions());
  await lockBrowserHistory(transaction, input.profileId);
  await transaction
    .deleteFrom("browserHistoryEntries")
    .where("profileId", "=", input.profileId)
    .execute(databaseOperationOptions());
  await transaction
    .deleteFrom("browserHistoryIcons")
    .where("profileId", "=", input.profileId)
    .execute(databaseOperationOptions());
  const live = await transaction
    .selectFrom("browserSessions")
    .select("id")
    .where("profileId", "=", input.profileId)
    .where("state", "not in", ["closed", "failed"])
    .orderBy("id")
    .execute(databaseOperationOptions());
  const storage = profileStorage(owned);
  const binding = input.binding ?? (storage.kind === "unbound" ? undefined : storage.binding);
  const deletion = binding
    ? publicProfileDeletion(
        await recordBrowserProfileDeletion(transaction, binding, input.deletionId),
      )
    : undefined;
  return { sessionIds: live.map((session) => session.id), ...(deletion ? { deletion } : {}) };
}

export async function createBrowserSession(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly tabGroupId?: BrowserSessionId;
    readonly opener?: BrowserSessionOpenerRecord | null;
    readonly id: BrowserSessionId;
    readonly placementKey: string;
    readonly runnerId: RunnerId;
    readonly origin: "agent" | "trigger" | "person";
    readonly profileId: BrowserProfileId | null;
    readonly runtimeId: string;
  },
): Promise<BrowserSessionRecord> {
  const profileId = input.profileId;
  return withPersonalTransaction(database, async (transaction) => {
    await assertPersonalOwner(transaction, input.ownerId);
    if (profileId !== null) await lockBrowserProfile(transaction, profileId);
    const runner = await transaction
      .selectFrom("runners")
      .select(["revokedAt", "ownerKind", "ownerUserId", "kind"])
      .where("id", "=", input.runnerId)
      .forShare()
      .executeTakeFirst(databaseOperationOptions());
    if (
      !runner ||
      runner.revokedAt ||
      (runner.ownerUserId !== input.ownerId &&
        !(runner.ownerKind === "deployment" && runner.kind === "main"))
    )
      throw new OpensteerError({ code: "conflict", message: "This computer was removed." });
    if (profileId !== null) {
      // Under the lock a deletion takes, so a session cannot outlive its profile.
      const profile = await transaction
        .selectFrom("browserProfiles")
        .select(["archivedAt", "storageState", "storageRunnerId", "homeRunnerId", "ownerId"])
        .where("id", "=", profileId)
        .executeTakeFirst(databaseOperationOptions());
      if (!profile || profile.archivedAt || profile.ownerId !== input.ownerId) {
        throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
      }
      if (
        profile.storageState !== "local" ||
        profile.storageRunnerId !== input.runnerId ||
        profile.homeRunnerId !== input.runnerId
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Open this browser profile on its owning computer with an updated runtime.",
        });
      }
      const otherPlacement = await transaction
        .selectFrom("browserSessions")
        .select("id")
        .where("profileId", "=", profileId)
        .where("state", "in", ["starting", "ready", "closing"])
        .where("placementKey", "!=", input.placementKey)
        .limit(1)
        .executeTakeFirst(databaseOperationOptions());
      if (otherPlacement) {
        throw new OpensteerError({
          code: "conflict",
          message: "This browser profile is already active on another placement",
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
        origin: input.origin,
        opener: input.opener ?? null,
        placementKey: input.placementKey,
        profileId: input.profileId,
        runtimeId: input.runtimeId,
        state: "starting",
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
      ])
      .executeTakeFirstOrThrow(databaseOperationOptions());
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
    .executeTakeFirstOrThrow(databaseOperationOptions());
  return Number(row.count);
}

export async function findActiveBrowserSessionForPerson(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<BrowserSessionRecord | null> {
  await assertPersonalOwner(database, ownerId);
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
    ])
    .where("origin", "=", "person")
    .where("state", "in", ["starting", "ready", "closing"])
    .orderBy("createdAt", "desc")
    .executeTakeFirst(databaseOperationOptions());
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
    ])
    .where("browserSessionAttachments.agentBindingId", "=", agentBindingId)
    .where("browserSessions.state", "in", ["starting", "ready", "closing"])
    .orderBy("browserSessionAttachments.updatedAt", "desc")
    .orderBy("browserSessionAttachments.sessionId", "desc")
    .execute(databaseOperationOptions());
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
    .execute(databaseOperationOptions());
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
    .select("threads.id")
    .where("threads.id", "in", threadIds)
    .where("threads.createdBy", "=", ownerId)
    .execute(databaseOperationOptions());
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
      from deployment_events s join deployment_events c
        on c.run_id = s.run_id and c.type = 'tool.completed'
        and c.runner_binding_generation is not distinct from s.runner_binding_generation
        and c.data->>'callId' = s.data->>'callId'
        and coalesce(c.data->>'nodeId', '') = coalesce(s.data->>'nodeId', '')
        and c.sequence > s.sequence and c.data->>'isError' = 'false'
      where s.type = 'tool.started'
        and s.data->'tool'->>'namespace' in (${sql.join([...integrationGatewayNamespaces])})
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
      from lineage l join threads t on t.id = l.thread_id
      where t.listed
      order by l.run_id, l.sequence, l.depth
    )
    select distinct on (a.thread_id) a.thread_id, a.run_id, a.integration, a.at
    from addressed a join threads t on t.id = a.thread_id
    where t.created_by = ${ownerId}
      and not exists (select 1 from browser_session_uses b where b.thread_id = a.thread_id and b.last_used_at > a.at)
    order by a.thread_id, a.at desc, a.sequence desc limit 4096
  `.execute(database, databaseOperationOptions());
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
) {
  const runIds = input.agentBindingIds.flatMap((binding) => {
    const id = bindingRunId(binding);
    return id ? [id] : [];
  });
  if (!runIds.length || !input.ownerIds.length) return [];
  const lineage = await sql<{
    runId: RunId;
    threadId: ThreadId;
    ownerId: UserId;
    generation: number;
    lineageThreadIds: ThreadId[];
  }>`
    with recursive lineage as (
      select r.id as run_id, r.thread_id, r.assignment_id, r.binding_generation as generation,
        0 as depth, array[]::text[] as path
      from runs r where r.id in (${sql.join(runIds)})
        and r.status in (${sql.join(nonTerminalRunStatuses)}) and r.binding_generation is not null
        and not exists (select 1 from grants g where g.run_id = r.id and g.binding_generation = r.binding_generation and g.status = 'revoked')
      union all
      select l.run_id, d.parent_thread_id, d.parent_assignment_id, l.generation, l.depth + 1, l.path || d.id::text
      from lineage l join delegations d on d.id = l.assignment_id
      where l.depth < 64 and not d.id::text = any(l.path)
    )
    select distinct on (l.run_id) l.run_id, l.thread_id, t.created_by as owner_id, l.generation,
      array(select l2.thread_id from lineage l2 where l2.run_id = l.run_id order by l2.depth) as lineage_thread_ids
    from lineage l join threads t on t.id = l.thread_id
    join personal_settings p on p.owner_id = t.created_by join users u on u.id = p.owner_id and u.disabled_at is null
    where (t.listed or t.purpose = 'voice') and t.created_by in (${sql.join(input.ownerIds)}) order by l.run_id, l.depth
  `.execute(database, databaseOperationOptions());
  return lineage.rows.map((row) => ({ ...row, agentBindingId: `run:${row.runId}` }));
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
    .execute(databaseOperationOptions());
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
  },
): Promise<boolean> {
  return withPersonalTransaction(database, async (transaction) => {
    if (input.agentBindingId.startsWith("run:")) {
      const runId = bindingRunId(input.agentBindingId);
      const run = runId
        ? await transaction
            .selectFrom("runs")
            .select("status")
            .where("id", "=", runId)
            .forShare()
            .executeTakeFirst(databaseOperationOptions())
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
      })
      .onConflict((conflict) =>
        // Recency orders a binding's sessions, so it comes from the one clock
        // the insert's default also reads.
        conflict.columns(["agentBindingId", "sessionId"]).doUpdateSet({
          ownerId: input.ownerId,
          updatedAt: sql<Date>`now()`,
        }),
      )
      // An inserted row has no deleting transaction; an updated one does.
      .returning(sql<boolean>`(xmax = 0)`.as("created"))
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return row.created;
  });
}

/** What a page showed when it was used: its title and its site (origin). */
export interface BrowserUsePage {
  readonly title: string;
  readonly site: string;
}

/** A conversation whose visible browser usage changed, and the task. */
export interface BrowserUsageCredit {
  readonly threadId: ThreadId;
  /**
   * The catalog's conversation list changed: a first use, or a revisit that
   * changes its recency order (including re-entering the bounded list).
   */
  readonly joined: boolean;
  /** Sessions whose catalog changed; their viewers can span the task owner. */
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
  return withPersonalTransaction(database, async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .select(["id", "threadId", "assignmentId"])
      .where("id", "=", runId)
      .where("requestedBy", "=", input.ownerId)
      .executeTakeFirst(databaseOperationOptions());
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
        `.execute(transaction, databaseOperationOptions())
      : { rows: [] };
    const threadIds = new Set([run.threadId, ...ancestors.rows.map((row) => row.threadId)]);
    return creditedThreads(
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

async function creditedThreads(
  database: Kysely<DatabaseSchema>,
  gained: ReadonlyMap<ThreadId, Pick<BrowserUsageCredit, "joined" | "catalogSessionIds">>,
): Promise<readonly BrowserUsageCredit[]> {
  if (gained.size === 0) return [];
  const threads = await database
    .selectFrom("threads")
    .select("id as threadId")
    .where("id", "in", [...gained.keys()])
    .orderBy("id")
    .execute(databaseOperationOptions());
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
      databaseOperationOptions(),
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
      .execute(databaseOperationOptions()),
    conversation
      .select(["pageTitle", "pageSite"])
      .where("pageSite", "is not", null)
      .orderBy("lastUsedAt", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst(databaseOperationOptions()),
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
      .execute(databaseOperationOptions()),
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
    .executeTakeFirstOrThrow(databaseOperationOptions());
  return row.created;
}

/**
 * Records that a person brought a browser into a conversation: they opened it
 * there (no page), or included one of its pages in a message. The person must
 * be an personal owner of the task and able to see the
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
  return withPersonalTransaction(database, async (transaction) => {
    const threadId = await personBrowserThread(transaction, input);
    if (
      !threadId ||
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
    return credit ? [{ ...credit, threadId: input.threadId }] : [];
  });
}

/** The task owner, when the person is an active member of it. */
async function personBrowserThread(
  database: Kysely<DatabaseSchema>,
  input: { readonly ownerId: UserId; readonly threadId: ThreadId },
): Promise<ThreadId | null> {
  const thread = await database
    .selectFrom("threads")
    .select("threads.id")
    .where("threads.id", "=", input.threadId)
    .where("threads.createdBy", "=", input.ownerId)
    .executeTakeFirst(databaseOperationOptions());
  return thread?.id ?? null;
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
  const threadId = await personBrowserThread(transaction, input);
  if (!threadId) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
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
  return credit ? [{ ...credit, threadId: input.threadId }] : [];
}

/**
 * Who may see one Browser Session now, by the rule the catalog reads it with:
 * a profile's owner sees its sessions, and a fresh session is seen by the
 * active members of the task. Null when the session does not exist.
 */
export async function listBrowserSessionViewers(
  database: Kysely<DatabaseSchema>,
  sessionId: BrowserSessionId,
) {
  const session = await database
    .selectFrom("browserSessions")
    .select("id")
    .where("id", "=", sessionId)
    .executeTakeFirst(databaseOperationOptions());
  if (!session) return null;
  const owner = await database
    .selectFrom("personalSettings")
    .innerJoin("users", "users.id", "personalSettings.ownerId")
    .select("personalSettings.ownerId")
    .where("users.disabledAt", "is", null)
    .executeTakeFirst(databaseOperationOptions());
  return { userIds: owner ? [owner.ownerId] : [] };
}

export async function detachBrowserSessionAttachments(
  database: Kysely<DatabaseSchema>,
  agentBindingId: string,
): Promise<readonly BrowserSessionId[]> {
  const detached = await database
    .deleteFrom("browserSessionAttachments")
    .where("agentBindingId", "=", agentBindingId)
    .returning("sessionId")
    .execute(databaseOperationOptions());
  return detached.map((row) => row.sessionId);
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
    ])
    .where("profileId", "=", profileId)
    .where("state", "in", ["starting", "ready", "closing"])
    .orderBy("createdAt", "desc")
    .executeTakeFirst(databaseOperationOptions());
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
    ])
    .where("browserSessions.id", "=", sessionId)
    .where((expression) => ownedBrowserSession(expression, ownerId))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("runners")
          .select("runners.id")
          .whereRef("runners.id", "=", "browserSessions.runnerId")
          .where("runners.revokedAt", "is", null)
          .where((owner) =>
            owner.or([
              owner.and([
                owner("runners.ownerKind", "=", "user"),
                owner("runners.ownerUserId", "=", ownerId),
              ]),
              owner.and([
                owner("runners.ownerKind", "=", "deployment"),
                owner("runners.kind", "=", "main"),
              ]),
            ]),
          ),
      ),
    )
    .executeTakeFirst(databaseOperationOptions());
  return row ?? null;
}

export async function listBrowserSessions(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<readonly BrowserSessionRecord[]> {
  return database
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
    ])
    .where((expression) => ownedBrowserSession(expression, ownerId))
    .orderBy(
      sql<number>`case when ${sql.ref("browserSessions.state")} in ('starting', 'ready', 'closing') then 0 else 1 end`,
    )
    .orderBy("browserSessions.createdAt", "desc")
    .execute(databaseOperationOptions());
}

/**
 * The conversations using each session that the reader can open — they are an
 * active member of the task — at most `browserSessionMaxThreads` per
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
    .where("threads.createdBy", "=", input.ownerId);
  const rows = await database
    .selectFrom(ranked.as("ranked"))
    .select(["ranked.sessionId", "ranked.threadId"])
    .where("ranked.recency", "<=", browserSessionMaxThreads)
    .orderBy("ranked.sessionId")
    .orderBy("ranked.recency")
    .execute(databaseOperationOptions());
  const threads = new Map<BrowserSessionId, ThreadId[]>();
  for (const row of rows) {
    threads.set(row.sessionId, [...(threads.get(row.sessionId) ?? []), row.threadId]);
  }
  return threads;
}

/**
 * One conversation's browser use, within its most recently used sessions: per
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
  const authorized = database
    .selectFrom("browserSessionUses")
    .innerJoin("browserSessions", "browserSessions.id", "browserSessionUses.sessionId")
    .leftJoin("browserProfiles", "browserProfiles.id", "browserSessions.profileId")
    .innerJoin("threads", "threads.id", "browserSessionUses.threadId")
    .where("browserSessionUses.threadId", "=", input.threadId)
    .where((eb) => ownedBrowserSession(eb, input.ownerId))
    .where("threads.createdBy", "=", input.ownerId);
  const sessionIds = authorized
    .select("browserSessionUses.sessionId")
    .groupBy("browserSessionUses.sessionId")
    .orderBy((eb) => eb.fn.max("browserSessionUses.lastUsedAt"), "desc")
    .orderBy("browserSessionUses.sessionId")
    .limit(browserUsageSessionsPerRead);
  const uses = authorized.where("browserSessionUses.sessionId", "in", sessionIds);
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
      .execute(databaseOperationOptions()),
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
      .execute(databaseOperationOptions()),
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
    readonly ownerId: UserId;
  },
): Promise<readonly BrowserSessionWithAttachmentCountRecord[]> {
  const query = database
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
  const rows = await query
    .orderBy("browserSessions.createdAt", "desc")
    .execute(databaseOperationOptions());
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
  if (placementKey === undefined) {
    await interruptPendingBrowserTabOpens(database);
  }
  let sessionIds: BrowserSessionId[] = [];
  return withPersonalTransaction(database, async (transaction) => {
    sessionIds = (
      await transaction
        .selectFrom("browserSessions")
        .select("id")
        .where("state", "in", ["starting", "ready", "closing"])
        .$if(placementKey !== undefined, (query) => query.where("placementKey", "=", placementKey!))
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute(databaseOperationOptions())
    ).map(({ id }) => id);
    if (sessionIds.length === 0) return { events: [], failed: 0 };
    let transactionalUpdate = transaction
      .updateTable("browserSessions")
      .set({
        closedAt: now,
        state: "failed",
        updatedAt: now,
      })
      .where("id", "in", sessionIds)
      .where("state", "in", ["starting", "ready", "closing"]);
    if (placementKey) {
      transactionalUpdate = transactionalUpdate.where("placementKey", "=", placementKey);
    }
    const failed = await transactionalUpdate.returning("id").execute(databaseOperationOptions());
    if (failed.length > 0) {
      await transaction
        .deleteFrom("browserSessionAttachments")
        .where(
          "sessionId",
          "in",
          failed.map((session) => session.id),
        )
        .execute(databaseOperationOptions());
    }
    return {
      events: [],
      failed: failed.length,
    };
  });
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
  return withPersonalTransaction(database, async (transaction) => {
    await transaction
      .selectFrom("browserSessions")
      .select("id")
      .where("id", "=", input.sessionId)
      .forNoKeyUpdate()
      .execute(databaseOperationOptions());

    const now = new Date();
    let update = transaction
      .updateTable("browserSessions")
      .set({
        ...(input.state === "closed" || input.state === "failed" ? { closedAt: now } : {}),
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
      ])
      .executeTakeFirst(databaseOperationOptions());
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
          .execute(databaseOperationOptions());
        await transaction
          .deleteFrom("browserSessionAttachments")
          .where("sessionId", "=", input.sessionId)
          .execute(databaseOperationOptions());
      }
      return {
        events: [],
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
      ])
      .where("id", "=", input.sessionId)
      .executeTakeFirst(databaseOperationOptions());
    if (!existing) {
      throw new OpensteerError({ code: "not_found", message: "Browser session not found" });
    }
    if (existing.state === "closed" || existing.state === "failed") {
      return { events: [], session: existing };
    }
    if (existing.state === input.state) {
      return {
        events: [],
        session: existing,
      };
    }
    throw new OpensteerError({
      code: "conflict",
      message: `Browser session cannot transition from ${existing.state} to ${input.state}`,
    });
  });
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
    .executeTakeFirst(databaseOperationOptions());
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
    .execute(databaseOperationOptions());
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
  `.execute(database, databaseOperationOptions());
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
    .where(sql<boolean>`binding -> 'outcome' ->> 'kind' = 'pending'`)
    .where(sql<boolean>`binding ->> 'requestFingerprint' = ${binding.requestFingerprint}`)
    .where(sql<boolean>`binding ->> 'chosenSessionId' = ${binding.chosenSessionId}`)
    .where(sql<boolean>`binding ->> 'initialPageOperationKey' = ${binding.initialPageOperationKey}`)
    .executeTakeFirstOrThrow(databaseOperationOptions());
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
    .executeTakeFirst(databaseOperationOptions());
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
  const actors = await resolvePlaceActors(database, {
    agentBindingIds: [agentBindingId],
    ownerIds: [ownerId],
  });
  const actor = actors[0];
  return actor ? { kind: "task", threadId: actor.threadId, runId } : null;
}

/** Fence pending attempts before accepting Runtime streams after Host restart. */
export async function interruptPendingBrowserTabOpens(
  database: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`update browser_tab_opens
    set binding = jsonb_set(binding, '{outcome}', '{"kind":"failed","reason":"interrupted"}'::jsonb)
    where binding -> 'outcome' ->> 'kind' = 'pending'`.execute(
    database,
    databaseOperationOptions(),
  );
}

export async function latestRunPlace(database: Kysely<DatabaseSchema>, runId: RunId) {
  const row = await database
    .selectFrom("deploymentEvents")
    .selectAll()
    .where("runId", "=", runId)
    .where("type", "=", "place.entered")
    .orderBy("sequence", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const event = eventFromRow(row);
  return event.type === "place.entered" ? event : null;
}

/** The personal event allocator precedes Run locks, including on delegated Runs. */
export async function recordRunPlace(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly runId: RunId;
    readonly bindingGeneration: number;
    readonly data: EventData<"place.entered">;
  },
): Promise<AgentEvent | undefined> {
  return withPersonalTransaction(database, async (transaction) => {
    await transaction
      .selectFrom("runs")
      .select("id")
      .where("id", "=", input.runId)
      .forNoKeyUpdate()
      .execute();
    const run = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .selectAll("runs")
      .where("runs.id", "=", input.runId)
      .executeTakeFirst();
    if (
      !run ||
      run.bindingGeneration !== input.bindingGeneration ||
      !(nonTerminalRunStatuses as readonly string[]).includes(run.status)
    )
      return undefined;
    const last = await transaction
      .selectFrom("deploymentEvents")
      .select("data")
      .where("runId", "=", input.runId)
      .where("type", "=", "place.entered")
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    if (last) {
      const previous = eventDataSchemas["place.entered"].parse(last.data);
      if (placeIdentityKey(previous.place) === placeIdentityKey(input.data.place)) return undefined;
    }
    return appendHostDeploymentEvent(transaction, {
      type: "place.entered",
      runId: input.runId,
      threadId: run.threadId,
      environmentId: run.environmentId,
      // A title cut to its bound can end on half a surrogate pair, which jsonb refuses.
      data: { ...input.data, title: storableText(input.data.title) },
    });
  });
}
