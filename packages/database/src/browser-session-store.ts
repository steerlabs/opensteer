import { requireNoBrowserStandardCdpLease } from "./browser-standard-cdp-lease.js";
import {
  BrowserPoolAdmissionClosed,
  requireBrowserPoolAdmission,
  type BrowserPoolTargetIdentity,
} from "./browser-pool-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { publishThreadSummary } from "./thread-status.js";
import { itemView } from "./personal-sync-store.js";
import { transcriptIdentity, transcriptPreview } from "./transcript-store.js";
import { lockBrowserHomeRunner } from "./browser-home-store.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { assertPersonalOwner } from "./private-resource-owner.js";
import { eventDataSchemas, type EventData } from "@opensteer/core";
import { storableText } from "./storable-json.js";
import {
  AgentSessionIdSchema,
  type BrowserProfileId,
  BrowserProfileIdSchema,
  type ContentPart,
  OpensteerError,
  type RunId,
  RunIdSchema,
  type RunnerId,
  type ThreadId,
  type UserId,
  createId,
  nonTerminalRunStatuses,
  utf8Prefix,
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
import { withPersonalReadTransaction } from "./personal-transaction.js";
import { type DatabaseSchema } from "./schema.js";
import {
  findCommandByIdempotency,
  idempotencyConflict,
  jsonValue,
  lockCommandIdempotency,
  principalIdForUser,
} from "./store-primitives.js";

export interface BrowserProfileRecord {
  readonly homeRunnerId: RunnerId | null;
  readonly id: BrowserProfileId;
  readonly name: string;
  readonly ownerId: UserId;
  /** `engine-sign-in`: where an AI engine signs in; no connected agent's grant may name it. */
  readonly purpose?: "person" | "engine-sign-in";
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
    readonly purpose?: "person" | "engine-sign-in";
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
  return commitPersonalMutation(transaction, async (tx, mutation) => {
    mutation.bumpResource("browser-profile");
    return tx
      .insertInto("browserProfiles")
      .values({
        archivedAt: null,
        id: createId("browserProfile"),
        name: input.name,
        ownerId: input.ownerId,
        homeRunnerId: input.homeRunnerId,
        purpose: input.purpose ?? "person",
      })
      .returning(["id", "name", "ownerId", "homeRunnerId", "purpose"])
      .executeTakeFirstOrThrow(databaseOperationOptions());
  });
}

export async function createBrowserProfile(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly idempotencyKey: string;
    readonly homeRunnerId?: RunnerId | null;
    readonly name: string;
    readonly ownerId: UserId;
    readonly purpose?: "person" | "engine-sign-in";
  },
): Promise<BrowserProfileRecord> {
  return commitPersonalMutation(database, async (transaction) => {
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
        .select(["id", "name", "ownerId", "homeRunnerId", "purpose"])
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
    .select(["id", "name", "ownerId", "homeRunnerId", "purpose"])
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
    .select(["id", "name", "ownerId", "homeRunnerId", "purpose"])
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
  return commitPersonalMutation(database, (transaction, mutation) =>
    administrationCommand(transaction, input.administration, async () => {
      await assertPersonalOwner(transaction, input.ownerId);
      const row = await transaction
        .updateTable("browserProfiles")
        .set({ name: input.name, updatedAt: new Date() })
        .where("id", "=", input.profileId)
        .where("ownerId", "=", input.ownerId)
        .where("archivedAt", "is", null)
        .returning(["id", "name", "ownerId", "homeRunnerId", "purpose"])
        .executeTakeFirst(databaseOperationOptions());
      if (!row)
        throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
      mutation.bumpResource("browser-profile");
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
  return commitPersonalMutation(database, async (transaction) => {
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
  const now = new Date();
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
  return commitPersonalMutation(transaction, async (_tx, mutation) => {
    if (!owned.archivedAt || deletion) {
      mutation.bumpResource("browser-profile");
      mutation.bumpResource("browser-placement");
      mutation.bumpResource("browser-availability");
    }
    return { sessionIds: live.map((session) => session.id), ...(deletion ? { deletion } : {}) };
  });
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
    readonly pooled?: true;
  },
): Promise<BrowserSessionRecord> {
  const profileId = input.profileId;
  return commitPersonalMutation(database, async (transaction, mutation) => {
    if (input.pooled) await requireBrowserPoolAdmission(transaction, input.runnerId);
    await assertPersonalOwner(transaction, input.ownerId);
    if (profileId !== null) {
      await lockBrowserProfile(transaction, profileId);
      await requireNoBrowserStandardCdpLease(transaction, profileId);
    }
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
    mutation.bumpResource("browser-placement");
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

/** Why a Run binding may not use its session now, from the same facts as tool admission. */
export type BrowserBindingRefusal =
  | "no-run"
  | "binding"
  | "finishing"
  | "lease"
  | "status"
  | "grant"
  | "attempt"
  | "thread"
  | "cancelled";

export interface BrowserSessionCut {
  readonly state: HostedBrowserSessionState;
  /** The session's open page tabs, by catalog identity. */
  readonly tabs: readonly { readonly tabId: string; readonly generation: number }[];
  /** Which of the surfaces asked about are tabs of this session the catalog has closed. */
  readonly closed: readonly string[];
  /**
   * Its attachments. A Run's binding is eligible only while its execution
   * binding holds as tool admission checks it (no finish under way, a live
   * provider lease on the agent's home computer, matching binding
   * generations, an active Run, its thread's environment still admitted for
   * its owner, no cancelled ancestor assignment) and an active grant exists
   * at that binding generation; it then names the Run's current attempt and binding
   * generation, so holds match exactly the actors issued for it. Any other
   * binding (a thread, Trigger or Watch) is not a Run and names no attempt.
   */
  readonly bindings: readonly {
    readonly bindingId: string;
    readonly run: {
      readonly runId: RunId;
      readonly attempt: string | null;
      readonly bindingGeneration: number | null;
      readonly refusal: BrowserBindingRefusal | null;
    } | null;
  }[];
}

/** At most this many reported surfaces are looked up by id in one cut. */
const maxCutSurfaces = 2_048;

/**
 * One session of this owner: its open catalog tabs, which of the given
 * surfaces the catalog has closed, and its attachments' eligibility, read in
 * one repeatable-read snapshot so they describe the same moment. Open tabs come
 * from the open-page index by session; closed ones only by primary key for
 * the surfaces asked about. Null when the owner has no such session: no
 * information, never an empty set.
 */
export async function readBrowserSessionCut(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  sessionId: BrowserSessionId,
  surfaces: readonly string[] = [],
  now: () => number = Date.now,
): Promise<BrowserSessionCut | null> {
  return withPersonalReadTransaction(database, async (transaction) => {
    const session = await transaction
      .selectFrom("browserSessions")
      .leftJoin("browserProfiles", "browserProfiles.id", "browserSessions.profileId")
      .select("browserSessions.state")
      .where("browserSessions.id", "=", sessionId)
      // The same owner fence as every owner read of a session.
      .where((expression) => ownedBrowserSession(expression, ownerId))
      .executeTakeFirst(databaseOperationOptions());
    if (!session) return null;
    const asked = [...new Set(surfaces)].slice(0, maxCutSurfaces);
    const [tabs, closed, attachments] = await Promise.all([
      transaction
        .selectFrom("personalTabs")
        .select(["id", "generation"])
        .where("ownerId", "=", ownerId)
        .where("kind", "=", "page")
        .where("closedAt", "is", null)
        .where(sql<string>`page_binding->>'sessionId'`, "=", sessionId)
        .orderBy("id")
        .execute(databaseOperationOptions()),
      asked.length
        ? transaction
            .selectFrom("personalTabs")
            .select("id")
            .where(sql<boolean>`id = any(${asked}::text[])`)
            .where("ownerId", "=", ownerId)
            .where("kind", "=", "page")
            .where("closedAt", "is not", null)
            .where(sql<string>`page_binding->>'sessionId'`, "=", sessionId)
            .execute(databaseOperationOptions())
        : [],
      transaction
        .selectFrom("browserSessionAttachments")
        .select("agentBindingId")
        .where("sessionId", "=", sessionId)
        .where("ownerId", "=", ownerId)
        .orderBy("agentBindingId")
        .execute(databaseOperationOptions()),
    ]);
    const runIds = attachments.flatMap((row) => {
      const runId = bindingRunId(row.agentBindingId);
      return runId ? [runId] : [];
    });
    const [facts, attempts, grants, cancelled] = runIds.length
      ? await Promise.all([
          transaction
            .selectFrom("runs")
            // Personal authority only: a Run whose owner has no Personal settings is not eligible.
            .leftJoin("personalSettings", (join) =>
              join
                .onRef("personalSettings.ownerId", "=", "runs.requestedBy")
                .on("personalSettings.singletonKey", "=", "personal"),
            )
            .leftJoin("providerSessions", (join) =>
              join
                .onRef("providerSessions.id", "=", "runs.providerSessionId")
                .on("providerSessions.active", "=", true),
            )
            .leftJoin("runners", "runners.id", "providerSessions.runnerId")
            .leftJoin("threads", "threads.id", "runs.threadId")
            .leftJoin("users", "users.id", "runs.requestedBy")
            // Thread admission: the thread's environment is on the owner's agent home computer.
            .leftJoin("executionEnvironments", (join) =>
              join
                .onRef("executionEnvironments.id", "=", "threads.environmentId")
                .onRef(
                  "executionEnvironments.runnerId",
                  "=",
                  "personalSettings.agentHomeComputerId",
                ),
            )
            .select([
              "runs.id as runId",
              "personalSettings.ownerId as personalOwnerId",
              "users.disabledAt",
              "executionEnvironments.id as admittedEnvironmentId",
              "runs.finishIntent",
              "runs.harnessInstanceId as runHarnessInstanceId",
              "runs.status as runStatus",
              "runs.bindingGeneration as runBindingGeneration",
              "personalSettings.agentHomeComputerId",
              "providerSessions.bindingGeneration",
              "providerSessions.harnessInstanceId as providerSessionHarnessInstanceId",
              "providerSessions.leaseExpiresAt",
              "providerSessions.runnerBootId",
              "providerSessions.runnerId",
              "providerSessions.status as providerSessionStatus",
              "runners.revokedAt",
            ])
            .where("runs.id", "in", runIds)
            .execute(databaseOperationOptions()),
          transaction
            .selectFrom("runAttempts")
            .select(["runId", "id", "bindingGeneration"])
            .where("runId", "in", runIds)
            .where("status", "=", "current")
            .execute(databaseOperationOptions()),
          transaction
            .selectFrom("grants")
            .select(["runId", "bindingGeneration", "runnerId", "runnerBootId"])
            .where("runId", "in", runIds)
            .where("status", "=", "active")
            .execute(databaseOperationOptions()),
          // Every Run whose assignment, or any ancestor of it, was cancelled: one query for all.
          sql<{ runId: string }>`
            with recursive ancestors(run_id, id, parent_assignment_id, status) as (
              select r.id, d.id, d.parent_assignment_id, d.status
              from runs r join delegations d on d.id = r.assignment_id
              where r.id = any(${runIds}::text[])
              union
              select a.run_id, p.id, p.parent_assignment_id, p.status
              from delegations p join ancestors a on p.id = a.parent_assignment_id
            )
            select distinct run_id from ancestors where status = 'cancelled'
          `
            .execute(transaction)
            // The connection maps result columns to camel case.
            .then((result) => new Set(result.rows.map((row) => row.runId))),
        ])
      : [[], [], [], new Set<string>()];
    const factsByRun = new Map(facts.map((row) => [row.runId, row]));
    const attemptByRun = new Map(attempts.map((row) => [row.runId as string, row]));
    const at = now();
    const refusal = (runId: RunId): BrowserBindingRefusal | null => {
      const fact = factsByRun.get(runId);
      if (!fact) return "no-run";
      if (fact.finishIntent !== null) return "finishing";
      if (
        fact.personalOwnerId === null ||
        fact.disabledAt !== null ||
        fact.admittedEnvironmentId === null
      )
        return "thread";
      if (cancelled.has(runId)) return "cancelled";
      if (!["starting", "running", "waiting"].includes(fact.runStatus)) return "status";
      if (
        fact.runBindingGeneration === null ||
        fact.bindingGeneration !== fact.runBindingGeneration ||
        fact.runHarnessInstanceId !== fact.providerSessionHarnessInstanceId ||
        fact.runnerId === null ||
        fact.runnerId !== fact.agentHomeComputerId ||
        fact.revokedAt !== null ||
        ["stopped", "broken"].includes(fact.providerSessionStatus ?? "stopped")
      )
        return "binding";
      if (fact.leaseExpiresAt === null || fact.leaseExpiresAt.getTime() <= at) return "lease";
      if (
        !grants.some(
          (grant) =>
            grant.runId === runId &&
            Number(grant.bindingGeneration) === Number(fact.runBindingGeneration) &&
            grant.runnerId === fact.runnerId &&
            grant.runnerBootId === fact.runnerBootId,
        )
      )
        return "grant";
      const attempt = attemptByRun.get(runId);
      // The current attempt, under this binding once it has been dispatched at all.
      if (
        !attempt ||
        (attempt.bindingGeneration !== null &&
          Number(attempt.bindingGeneration) !== Number(fact.runBindingGeneration))
      )
        return "attempt";
      return null;
    };
    return {
      state: session.state,
      tabs: tabs.map((row) => ({ tabId: row.id, generation: Number(row.generation) })),
      closed: closed.map((row) => row.id),
      bindings: attachments.map(({ agentBindingId }) => {
        const runId = bindingRunId(agentBindingId);
        if (!runId) return { bindingId: agentBindingId, run: null };
        const refused = refusal(runId);
        const fact = factsByRun.get(runId);
        return {
          bindingId: agentBindingId,
          run: {
            runId,
            attempt: refused ? null : (attemptByRun.get(runId)?.id ?? null),
            bindingGeneration:
              refused || !fact?.runBindingGeneration ? null : Number(fact.runBindingGeneration),
            refusal: refused,
          },
        };
      }),
    };
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

export async function listBrowserSessionAttachmentBindings(
  database: Kysely<DatabaseSchema>,
  sessionId: BrowserSessionId,
): Promise<readonly string[]> {
  const rows = await database
    .selectFrom("browserSessionAttachments")
    .select("agentBindingId")
    .where("sessionId", "=", sessionId)
    .execute(databaseOperationOptions());
  return rows.map(({ agentBindingId }) => agentBindingId);
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
    .where("threads.removedAt", "is", null)
    .execute(databaseOperationOptions());
  return rows.map(({ id }) => id);
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
    readonly pool?: BrowserPoolTargetIdentity;
  },
): Promise<boolean> {
  return commitPersonalMutation(database, async (transaction, mutation) => {
    if (input.pool) await requireBrowserPoolAdmission(transaction, input.pool.runnerId, input.pool);
    const session = await getBrowserSessionForOwner(transaction, input.sessionId, input.ownerId);
    if (
      input.pool &&
      (session?.state !== "ready" ||
        session.runnerId !== input.pool.runnerId ||
        session.runtimeId !== input.pool.runtimeId)
    )
      throw new BrowserPoolAdmissionClosed();
    if (!session) return false;
    if (session?.profileId) {
      await lockBrowserProfile(transaction, session.profileId);
      await requireNoBrowserStandardCdpLease(transaction, session.profileId, input.agentBindingId);
    }
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
    if (row.created) mutation.bumpResource("browser-placement");
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
  return commitPersonalMutation(database, async (transaction) => {
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
  return commitPersonalMutation(database, async (transaction) => {
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
  return commitPersonalMutation(database, async (tx, mutation) => {
    await tx
      .selectFrom("browserSessionAttachments")
      .select("sessionId")
      .where("agentBindingId", "=", agentBindingId)
      .orderBy("sessionId")
      .orderBy("agentBindingId")
      // FOR UPDATE: Deletes the attachments for this agent binding.
      .forUpdate()
      .execute(databaseOperationOptions());
    const detached = await tx
      .deleteFrom("browserSessionAttachments")
      .where("agentBindingId", "=", agentBindingId)
      .returning("sessionId")
      .execute(databaseOperationOptions());
    if (detached.length) mutation.bumpResource("browser-placement");
    return detached.map((row) => row.sessionId);
  });
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
  pooledRunner?: RunnerId,
): Promise<{
  readonly failed: number;
}> {
  const now = new Date();
  if (placementKey === undefined) {
    await interruptPendingBrowserTabOpens(database);
  }
  let sessionIds: BrowserSessionId[] = [];
  return commitPersonalMutation(database, async (transaction, mutation) => {
    sessionIds = (
      await transaction
        .selectFrom("browserSessions")
        .select("id")
        .where("state", "in", ["starting", "ready", "closing"])
        .$if(placementKey !== undefined, (query) => query.where("placementKey", "=", placementKey!))
        .$if(pooledRunner !== undefined, (query) =>
          query.where(sql<boolean>`
          not exists (
            -- A pooled guest outlives the Home: its ready sessions are the pool's to reattach
            -- or end with their note, whatever the slot's phase, and a closing one ends only
            -- with the runtime's answer.
            select 1 from browser_pool_slots slot
            where slot.runner_id = ${pooledRunner!}
              and slot.runner_id = browser_sessions.runner_id
              and slot.runtime_id = browser_sessions.runtime_id
              and browser_sessions.origin in ('person', 'agent')
              and browser_sessions.state in ('ready', 'closing')
          )
        `),
        )
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute(databaseOperationOptions())
    ).map(({ id }) => id);
    if (sessionIds.length === 0) return { failed: 0 };
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
    if (failed.length) {
      mutation.bumpResource("browser-placement");
      mutation.bumpResource("browser-availability");
      mutation.bumpResource("tab");
    }
    return { failed: failed.length };
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
  readonly session: BrowserSessionRecord;
}> {
  return commitPersonalMutation(database, async (transaction, mutation) => {
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
      .where("state", "not in", ["closed", "failed"])
      .where("state", "!=", input.state);
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
      mutation.bumpResource("browser-placement");
      mutation.bumpResource("browser-availability");
      mutation.bumpResource("tab");
      return { session: row };
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
      return { session: existing };
    }
    if (existing.state === input.state) {
      return { session: existing };
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
    readonly pooled?: true;
  },
): Promise<void> {
  const insert = (target: Kysely<DatabaseSchema>) =>
    target
      .insertInto("browserTabOpens")
      .values({
        ownerId: input.binding.callerUserId,
        idempotencyKey: input.binding.idempotencyKey,
        binding: input.binding,
        identityKey: input.identityKey,
        runnerId: input.runnerId,
      })
      .execute(databaseOperationOptions());
  if (input.pooled)
    return commitPersonalMutation(database, async (tx) => {
      await requireBrowserPoolAdmission(tx, input.runnerId);
      // Pending pooled opens can still have an uncertain outcome. Keep that
      // evidence for park recovery instead of pruning it in the admission write.
      await insert(tx);
    });
  await insert(database);
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
  if (agentBindingId.startsWith("session:")) {
    const session = AgentSessionIdSchema.safeParse(agentBindingId.slice("session:".length));
    if (!session.success) return null;
    // A connected agent's session opens for the one task it works on.
    const row = await database
      .selectFrom("agentSessions")
      .select("threadId")
      .where("id", "=", session.data)
      .where("userId", "=", ownerId)
      .where("status", "=", "active")
      .executeTakeFirst(databaseOperationOptions());
    return row ? { kind: "task", threadId: row.threadId } : null;
  }
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
  const run = await database
    .selectFrom("runs")
    .select("latestPlace")
    .where("id", "=", runId)
    .executeTakeFirst();
  return run?.latestPlace ?? null;
}

export function recordRunTabPlace(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly runId: RunId;
    readonly bindingGeneration: number;
    readonly data: EventData<"place.entered">;
  },
): Promise<boolean> {
  const place = eventDataSchemas["place.entered"].parse({
    ...input.data,
    title: utf8Prefix(storableText(input.data.title), 1024),
  });
  return commitPersonalMutation(database, async (tx, mutation) => {
    const owner = await tx
      .selectFrom("personalSettings")
      .innerJoin("users", "users.id", "personalSettings.ownerId")
      .select("personalSettings.ownerId")
      .where("users.disabledAt", "is", null)
      .limit(1)
      .executeTakeFirst();
    if (!owner) return false;
    const run = await tx
      .selectFrom("runs")
      .select(["threadId", "bindingGeneration", "latestPlace", "finishIntent", "status"])
      .where("id", "=", input.runId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (
      !run ||
      run.finishIntent ||
      run.bindingGeneration !== input.bindingGeneration ||
      !(nonTerminalRunStatuses as readonly string[]).includes(run.status) ||
      run.latestPlace?.tabId === place.tabId
    )
      return false;
    const thread = await tx
      .selectFrom("threads")
      .select("id")
      .where("id", "=", run.threadId)
      .where("createdBy", "=", owner.ownerId)
      .where("removedAt", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!thread) return false;
    const attempt = await tx
      .selectFrom("runAttempts")
      .select("id")
      .where("runId", "=", input.runId)
      .where("bindingGeneration", "=", input.bindingGeneration)
      .where("status", "=", "current")
      .limit(1)
      .executeTakeFirst();
    const { nextTranscriptPosition: position } = await tx
      .updateTable("threads")
      .set({
        latestPlace: place,
        revision: mutation.sequence,
        nextTranscriptPosition: sql<string>`next_transcript_position + 1`,
      })
      .where("id", "=", thread.id)
      .returning("nextTranscriptPosition")
      .executeTakeFirstOrThrow();
    await tx
      .updateTable("runs")
      .set({ latestPlace: place, revision: mutation.sequence })
      .where("id", "=", input.runId)
      .execute();
    const item = await tx
      .insertInto("transcriptItems")
      .values({
        id: transcriptIdentity("place", input.runId, position),
        threadId: thread.id,
        runId: input.runId,
        attemptId: attempt?.id ?? null,
        bindingGeneration: input.bindingGeneration,
        nodeId: null,
        kind: "place",
        position,
        revision: mutation.sequence,
        visible: true,
        isTurnStart: false,
        createdAt: mutation.state.now,
        body: place,
        view: transcriptPreview({ title: place.title, preview: place.site ?? undefined }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const scopeKey = `thread:${thread.id}` as const;
    mutation.change({ scopeKey, entityKind: "item", entityId: item.id, operation: "upsert" }, () =>
      itemView(item),
    );
    await publishThreadSummary(tx, thread.id);
    return true;
  });
}
