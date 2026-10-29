import { withDatabaseTransaction } from "./connection.js";
import { type CommandRow, type DatabaseSchema } from "./schema.js";
import {
  idempotencyConflict,
  principalIdForUser,
  jsonValue,
  lockCommandIdempotency,
  findCommandByIdempotency,
} from "./store-primitives.js";
import { type Transaction, type Kysely, sql } from "kysely";
import {
  type UserId,
  createId,
  type RunnerId,
  type RunId,
  type ThreadId,
  OpensteerError,
  runnerRunsItsDeployment,
} from "@opensteer/core";
import {
  type MachineAccessPolicy,
  type RunnerShellModule,
  type MachineAccessShare,
  type ShellSessionSummary,
  type ShellCloseReason,
  type ShellAuditEvent,
  type ShellSessionId,
  ShellSessionIdSchema,
  shellAuditEventCap,
  machineAccessMaxActiveSessions,
  machineAccessHistoryMaxSessions,
} from "@opensteer/protocol";
import { isDeepStrictEqual } from "node:util";
import {
  machineOwnershipIn,
  machineIsManagedBy,
  type MachineOwnershipRecord,
} from "./machine-ownership.js";

/** The two machine-access commands whose results are recorded for replay. */
type MachineAccessCommandType = "machine.access.session.stop" | "machine.access.update";

interface MachineAccessCommandPayload {
  readonly request: unknown;
  readonly result: unknown;
  readonly type: MachineAccessCommandType;
}

/**
 * The recorded request and answer behind one machine-access idempotency key.
 *
 * A key is the person's, not the command's, so a key reused for a different
 * request — or for a different command entirely — is a mistake worth naming
 * rather than an answer worth replaying.
 */
function machineAccessCommandPayload(
  row: CommandRow,
  type: MachineAccessCommandType,
  idempotencyKey: string,
): MachineAccessCommandPayload {
  const payload = row.payload;
  if (
    row.type !== type ||
    typeof payload !== "object" ||
    payload === null ||
    !("request" in payload) ||
    !("result" in payload)
  ) {
    throw idempotencyConflict(idempotencyKey);
  }
  return { ...(payload as { readonly request: unknown; readonly result: unknown }), type };
}

async function recordMachineAccessCommand(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly idempotency: { readonly key: string; readonly requestedBy: UserId };
    readonly request: unknown;
    readonly result: unknown;
    readonly type: MachineAccessCommandType;
  },
): Promise<void> {
  const { key, requestedBy } = input.idempotency;
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: await principalIdForUser(transaction, requestedBy),
      authoritySource: jsonValue({ kind: "user-session", userId: requestedBy }),
      dispatcherId: null,
      environmentId: null,
      id: createId("command"),
      idempotencyKey: key,
      lastError: null,
      payload: jsonValue({ request: input.request, result: input.result, type: input.type }),
      requestedBy,
      runId: null,
      status: "succeeded",
      threadId: null,
      type: input.type,
    })
    .executeTakeFirstOrThrow();
}

/** One computer a Run named as a connect target, reachable or not. */
export interface MachineAccessTargetRecord {
  readonly lastSeenAt: Date | null;
  readonly name: string;
  readonly policy: MachineAccessPolicy;
  readonly revision: number;
  /** Null when the machine does not advertise the module at all. */
  readonly shell: RunnerShellModule | null;
}

/** One computer a Run may reach, as the reach query answers it. */
export interface ReachableMachineRecord {
  readonly fullDiskAccess: boolean | null;
  readonly commands: boolean;
  readonly forwarding: boolean;
  readonly hostPublicKey: string;
  readonly lastSeenAt: Date | null;
  readonly name: string;
  readonly platform: "darwin" | "linux";
  readonly runnerId: RunnerId;
  readonly shares: MachineAccessShare[];
}

export interface ShellSessionHistoryRecord extends ShellSessionSummary {
  readonly endReason: ShellCloseReason | null;
  readonly endedAt: Date | null;
  readonly events: readonly ShellAuditEvent[];
}

/** The bare session row, for Stop/history resolution and authorization. */
export interface ShellSessionRecord {
  readonly endedAt: Date | null;
  readonly id: ShellSessionId;
  readonly requestedBy: UserId;
  readonly runnerId: RunnerId;
  readonly startedAt: Date;
  readonly state: "pending" | "active" | "ended";
}

/**
 * The caller's name is the admission-time snapshot stored on the session, not a
 * join at read time: the review fixed it at admission so history reads the same
 * name forever, even after the calling machine is renamed or revoked.
 */
function shellSessionsWithCaller(database: Kysely<DatabaseSchema>) {
  return database
    .selectFrom("machineAccessSessions")
    .select([
      "machineAccessSessions.bytesIn",
      "machineAccessSessions.bytesOut",
      "machineAccessSessions.callerMachineName",
      "machineAccessSessions.endReason",
      "machineAccessSessions.endedAt",
      "machineAccessSessions.id",
      "machineAccessSessions.requestedBy",
      "machineAccessSessions.runId",
      "machineAccessSessions.startedAt",
      "machineAccessSessions.threadId",
      "machineAccessSessions.threadTitle",
    ]);
}

function shellSessionSummary(row: {
  readonly bytesIn: string;
  readonly bytesOut: string;
  readonly callerMachineName: string;
  readonly id: ShellSessionId;
  readonly requestedBy: UserId;
  readonly runId: RunId;
  readonly startedAt: Date;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
}): ShellSessionSummary {
  return {
    bytesIn: safeByteCount(row.bytesIn),
    bytesOut: safeByteCount(row.bytesOut),
    callerMachineName: row.callerMachineName,
    id: row.id,
    requestedBy: row.requestedBy,
    runId: row.runId,
    startedAt: row.startedAt.toISOString(),
    threadId: row.threadId,
    threadTitle: row.threadTitle,
  };
}

function safeByteCount(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

/** A history page is bounded by serialized size as well as its item count. */
const machineAccessHistoryMaxBytes = 16 * 1_024 * 1_024;

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** `(started_at, id)` is the only ordering the history index can page on. */
function encodeShellHistoryCursor(cursor: {
  readonly id: ShellSessionId;
  readonly startedAt: Date;
}): string {
  return Buffer.from(JSON.stringify([cursor.startedAt.toISOString(), cursor.id]), "utf8").toString(
    "base64url",
  );
}

function decodeShellHistoryCursor(cursor: string): {
  readonly id: ShellSessionId;
  readonly startedAt: Date;
} {
  const invalid = new OpensteerError({
    code: "bad_request",
    message: "Machine access history cursor is invalid",
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) throw invalid;
  const startedAt = typeof decoded[0] === "string" ? Date.parse(decoded[0]) : Number.NaN;
  const id = ShellSessionIdSchema.safeParse(decoded[1]);
  if (!Number.isFinite(startedAt) || !id.success) throw invalid;
  return { id: id.data, startedAt: new Date(startedAt) };
}

/**
 * Replaces the access policy, but only over the revision the editor read.
 *
 * The comparison is part of the write rather than a check before it: two
 * people with the page open would otherwise each read the same revision and
 * each believe they had saved. A conflict changes nothing at all, which is
 * what lets the caller leave live sessions alone.
 *
 * Management, the owner-reach rule and the idempotency record are all decided
 * inside this one transaction, because each of them is a statement about the
 * row being written: a machine whose owner disappeared between the check and
 * the write must not end up admitting "its owner's agents" and nobody, and a
 * retried click must return the revision the first one produced rather than
 * bumping a second.
 */
export async function updateMachineAccessPolicy(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly allowDeployment: boolean;
    readonly expectedRevision: number;
    readonly idempotency?: { readonly key: string; readonly requestedBy: UserId };
    readonly ownerId: UserId;
    readonly policy: MachineAccessPolicy;
    readonly runnerId: RunnerId;
  },
): Promise<
  | { readonly outcome: "conflict"; readonly replayed: boolean }
  | { readonly outcome: "updated"; readonly replayed: boolean; readonly revision: number }
> {
  const request = {
    expectedRevision: input.expectedRevision,
    policy: input.policy,
    runnerId: input.runnerId,
  };
  return withDatabaseTransaction(database, async (transaction) => {
    if (input.idempotency) {
      const { key, requestedBy } = input.idempotency;
      await lockCommandIdempotency(transaction, requestedBy, key);
      const existing = await findCommandByIdempotency(transaction, requestedBy, key);
      if (existing) {
        const stored = machineAccessCommandPayload(existing, "machine.access.update", key);
        if (!isDeepStrictEqual(stored.request, request)) throw idempotencyConflict(key);
        // Said as well as answered. A replay committed nothing: the caller
        // reads the same outcome, but anything the first commit set in
        // motion — live sessions closed because the policy they opened under
        // is gone — must not happen a second time to sessions that started
        // after it and are running under the policy this replay describes.
        return {
          ...(stored.result as
            | { readonly outcome: "conflict" }
            | { readonly outcome: "updated"; readonly revision: number }),
          replayed: true,
        };
      }
    }
    const ownership = await machineOwnershipIn(transaction, input.runnerId);
    if (
      !ownership ||
      !machineIsManagedBy(ownership, input.ownerId, { allowDeployment: input.allowDeployment })
    ) {
      throw new OpensteerError({ code: "not_found", message: "Active Runner not found" });
    }
    // "My agents" has to name somebody. A Deployment-owned machine normally
    // names nobody, so saving owner reach on one would publish a setting that
    // admits no Run at all and reads as if it admitted the person looking.
    if (input.policy.reach === "owner" && ownership.effectiveOwner === null) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "This computer belongs to the Deployment rather than to a person, so it cannot be limited to its owner's agents.",
      });
    }
    const updated = await transaction
      .updateTable("runners")
      .set({
        accessPolicy: jsonValue(input.policy),
        accessPolicyRevision: sql`access_policy_revision + 1`,
        updatedAt: new Date(),
      })
      .where("id", "=", input.runnerId)
      .where("revokedAt", "is", null)
      .where("accessPolicyRevision", "=", input.expectedRevision)
      .returning("accessPolicyRevision")
      .executeTakeFirst();
    const result = updated
      ? { outcome: "updated" as const, revision: updated.accessPolicyRevision }
      : { outcome: "conflict" as const };
    if (input.idempotency) {
      await recordMachineAccessCommand(transaction, {
        idempotency: input.idempotency,
        request,
        result,
        type: "machine.access.update",
      });
    }
    return { ...result, replayed: false };
  });
}

/**
 * Whose Threads `reach: "owner"` admits.
 *
 * A user-owned machine names its person directly. The Personal main machine
 * is owned by the Deployment and has no `owner_user_id`, so its effective
 * owner is the person who established the Deployment — otherwise the one
 * computer a Personal user always has could never be reached from a Run.
 */
export async function effectiveMachineOwner(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<MachineOwnershipRecord | null> {
  return machineOwnershipIn(database, runnerId);
}

/**
 * The same answer for a page of computers at once.
 *
 * The Machines list needs it for every row it may offer access controls for,
 * and asking per row would run the Deployment-shape and owner lookups once
 * per machine to reach the same two facts.
 */
export async function effectiveMachineOwners(
  database: Kysely<DatabaseSchema>,
  runnerIds: readonly RunnerId[],
): Promise<ReadonlyMap<RunnerId, MachineOwnershipRecord>> {
  const owners = new Map<RunnerId, MachineOwnershipRecord>();
  if (runnerIds.length === 0) return owners;
  const runners = await database
    .selectFrom("runners")
    .select(["id", "kind", "ownerKind", "ownerUserId"])
    .where("id", "in", [...runnerIds])
    .where("revokedAt", "is", null)
    .execute();
  let personalOwner: UserId | null | undefined;
  const deploymentIsPersonal = await isPersonalDeployment(database);
  for (const runner of runners) {
    if (runner.ownerKind === "user") {
      owners.set(runner.id, { effectiveOwner: runner.ownerUserId, ownerKind: "user" });
      continue;
    }
    if (
      !runnerRunsItsDeployment({
        deploymentIsPersonal,
        ownerKind: runner.ownerKind,
        runnerKind: runner.kind,
      })
    ) {
      owners.set(runner.id, { effectiveOwner: null, ownerKind: "deployment" });
      continue;
    }
    personalOwner ??= await personalDeploymentOwner(database);
    owners.set(runner.id, { effectiveOwner: personalOwner, ownerKind: "deployment" });
  }
  return owners;
}

/**
 * The whole session row, for resolving a Stop or a history read to its
 * machine and authorizing it — even for a session that has already ended. An
 * unknown id returns null and discloses nothing.
 */
export async function getShellSession(
  database: Kysely<DatabaseSchema>,
  sessionId: ShellSessionId,
): Promise<ShellSessionRecord | null> {
  const session = await database
    .selectFrom("machineAccessSessions")
    .select(["endedAt", "id", "requestedBy", "runnerId", "startedAt", "state"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  if (!session) return null;
  return {
    endedAt: session.endedAt,
    id: session.id,
    requestedBy: session.requestedBy,
    runnerId: session.runnerId,
    startedAt: session.startedAt,
    state: session.state,
  };
}

/**
 * One computer as a connect target names it, whoever is asking.
 *
 * Admission has to explain a refusal in a sentence that names the machine, so
 * it needs the name and the descriptor even when reach denies the caller —
 * which is exactly what the reach query withholds. This is not a viewer's
 * inventory read either: it discloses nothing but what a refusal already
 * says, and only to a Run that named the id.
 */
export async function getMachineAccessTarget(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<MachineAccessTargetRecord | null> {
  const runner = await database
    .selectFrom("runners")
    .select(["accessPolicy", "accessPolicyRevision", "lastSeenAt", "moduleDescriptors", "name"])
    .where("id", "=", runnerId)
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  if (!runner) return null;
  return {
    lastSeenAt: runner.lastSeenAt,
    name: runner.name,
    policy: runner.accessPolicy,
    revision: runner.accessPolicyRevision,
    shell: runner.moduleDescriptors.shell ?? null,
  };
}

/**
 * Every computer this person's Runs may reach over SSH.
 *
 * Deliberately not a filter over `listRunners`: that is a viewer's inventory
 * of the machines they administer, and reach is a different question with a
 * different answer — a Deployment-reachable machine belongs in this list for
 * someone who can see nothing else about it.
 */
export async function listReachableMachines(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  callerRunnerId: RunnerId,
): Promise<readonly ReachableMachineRecord[]> {
  const personalOwner = (await isPersonalDeployment(database))
    ? await personalDeploymentOwner(database)
    : null;
  const rows = await database
    .selectFrom("runners")
    .select(["accessPolicy", "id", "lastSeenAt", "moduleDescriptors", "name"])
    .where("revokedAt", "is", null)
    // A Run never reaches the machine it runs on over SSH.
    .where("id", "!=", callerRunnerId)
    .where(sql<boolean>`module_descriptors ? 'shell'`)
    .where((expression) =>
      expression.or([
        expression(sql<string>`access_policy ->> 'reach'`, "=", "deployment"),
        expression.and([
          expression(sql<string>`access_policy ->> 'reach'`, "=", "owner"),
          expression.or([
            expression.and([
              expression("ownerKind", "=", "user"),
              expression("ownerUserId", "=", userId),
            ]),
            ...(personalOwner === userId
              ? [
                  expression.and([
                    expression("kind", "=", "main"),
                    expression("ownerKind", "=", "deployment"),
                    expression("ownerUserId", "is", null),
                  ]),
                ]
              : []),
          ]),
        ]),
      ]),
    )
    // By name, with the id breaking ties: the budget keeps the first entries
    // it can fit, and which machines a Run can see should be decided the way
    // a person reads the list rather than by how their ids happened to sort.
    .orderBy("name", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.flatMap((row) => {
    const shell = row.moduleDescriptors.shell;
    // The filter above reads the raw descriptor; this is the parsed one.
    if (!shell) return [];
    return [
      {
        commands: row.accessPolicy.commands,
        forwarding: row.accessPolicy.forwarding,
        fullDiskAccess: shell.fullDiskAccess ?? null,
        hostPublicKey: shell.hostPublicKey,
        lastSeenAt: row.lastSeenAt,
        name: row.name,
        platform: shell.platform,
        runnerId: row.id,
        shares: row.accessPolicy.shares,
      },
    ];
  });
}

/**
 * Writes the session down before the target is asked to serve it, so a Host
 * that dies during the open still has a row it can end on its next start.
 */
export async function reserveShellSession(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly callerMachineName: string;
    readonly callerRunnerId: RunnerId;
    readonly policyRevision: number;
    readonly requestedBy: UserId;
    readonly runId: RunId;
    readonly runnerId: RunnerId;
    readonly sessionId: ShellSessionId;
    readonly startedAt: Date;
    readonly threadId: ThreadId;
    readonly threadTitle: string;
  },
): Promise<void> {
  await database
    .insertInto("machineAccessSessions")
    .values({
      bytesIn: 0,
      bytesOut: 0,
      callerMachineName: input.callerMachineName,
      callerRunnerId: input.callerRunnerId,
      endReason: null,
      endedAt: null,
      id: input.sessionId,
      policyRevision: input.policyRevision,
      requestedBy: input.requestedBy,
      runId: input.runId,
      runnerId: input.runnerId,
      startedAt: input.startedAt,
      state: "pending",
      threadId: input.threadId,
      threadTitle: input.threadTitle,
    })
    .executeTakeFirstOrThrow();
}

/** Promotes a paired session; a session that already ended stays ended. */
export async function activateShellSession(
  database: Kysely<DatabaseSchema>,
  sessionId: ShellSessionId,
): Promise<boolean> {
  const result = await database
    .updateTable("machineAccessSessions")
    .set({ state: "active" })
    .where("id", "=", sessionId)
    .where("state", "=", "pending")
    .where("endedAt", "is", null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * Ends one session and reports whether this call is the one that ended it.
 *
 * The first terminal call wins: every path to the end of a session races the
 * others, and the one that arrived first is the true story. It writes the
 * final absolute byte counters once — the caller passes the totals it saw —
 * and a duplicate call changes neither the reason nor the counters, so an
 * idempotent Stop is safe to fire from more than one place.
 */
export async function endShellSession(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly bytesIn?: number;
    readonly bytesOut?: number;
    readonly endedAt?: Date;
    /** A Stop the person may click twice; the second click reports the first. */
    readonly idempotency?: { readonly key: string; readonly requestedBy: UserId };
    readonly reason: ShellCloseReason;
    readonly sessionId: ShellSessionId;
  },
): Promise<{ readonly ended: boolean }> {
  const request = { sessionId: input.sessionId };
  return withDatabaseTransaction(database, async (transaction) => {
    if (input.idempotency) {
      const { key, requestedBy } = input.idempotency;
      await lockCommandIdempotency(transaction, requestedBy, key);
      const existing = await findCommandByIdempotency(transaction, requestedBy, key);
      if (existing) {
        const stored = machineAccessCommandPayload(existing, "machine.access.session.stop", key);
        if (!isDeepStrictEqual(stored.request, request)) throw idempotencyConflict(key);
        // The recorded answer, and no second closure: the session this key
        // ended is already ended, and saying `false` now would tell the
        // person their click did nothing.
        return stored.result as { readonly ended: boolean };
      }
    }
    const session = await transaction
      .selectFrom("machineAccessSessions")
      .select(["endedAt", "id"])
      .where("id", "=", input.sessionId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const ended = Boolean(session) && session?.endedAt === null;
    if (ended) {
      await transaction
        .updateTable("machineAccessSessions")
        .set({
          bytesIn: input.bytesIn ?? 0,
          bytesOut: input.bytesOut ?? 0,
          endReason: input.reason,
          endedAt: input.endedAt ?? new Date(),
          state: "ended",
        })
        .where("id", "=", input.sessionId)
        .where("endedAt", "is", null)
        .executeTakeFirstOrThrow();
    }
    if (input.idempotency) {
      await recordMachineAccessCommand(transaction, {
        idempotency: input.idempotency,
        request,
        result: { ended },
        type: "machine.access.session.stop",
      });
    }
    return { ended };
  });
}

/** No session survives a Host epoch, so every open row ends at startup. */
export async function endAllOpenShellSessions(
  database: Kysely<DatabaseSchema>,
  reason: ShellCloseReason,
): Promise<number> {
  const result = await database
    .updateTable("machineAccessSessions")
    .set({ endReason: reason, endedAt: new Date(), state: "ended" })
    .where("endedAt", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/**
 * Appends audited requests up to the cap, then one marker saying the rest
 * were dropped. A session that floods its own history must not be able to
 * push another machine's out of the table.
 */
export async function appendShellEvents(
  database: Kysely<DatabaseSchema>,
  sessionId: ShellSessionId,
  events: readonly { readonly at: Date; readonly event: ShellAuditEvent }[],
): Promise<number> {
  if (events.length === 0) return 0;
  return withDatabaseTransaction(database, async (transaction) => {
    const existing = await transaction
      .selectFrom("machineAccessEvents")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("sessionId", "=", sessionId)
      .executeTakeFirstOrThrow();
    const stored = Number(existing.count);
    if (stored > shellAuditEventCap) return 0;
    const room = shellAuditEventCap - stored;
    const admitted = events.slice(0, room).map((entry) => ({
      at: entry.at,
      event: jsonValue(entry.event),
      sessionId,
    }));
    const truncated =
      events.length > room
        ? [
            {
              at: events[room]?.at ?? new Date(),
              event: jsonValue<ShellAuditEvent>({ kind: "truncated" }),
              sessionId,
            },
          ]
        : [];
    const rows = [...admitted, ...truncated];
    if (rows.length === 0) return 0;
    await transaction.insertInto("machineAccessEvents").values(rows).execute();
    return admitted.length;
  });
}

/** The sessions open on one computer right now, newest first. */
export async function listActiveShellSessions(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<readonly ShellSessionSummary[]> {
  const rows = await shellSessionsWithCaller(database)
    .where("machineAccessSessions.runnerId", "=", runnerId)
    .where("endedAt", "is", null)
    .orderBy("startedAt", "desc")
    .orderBy("machineAccessSessions.id", "desc")
    .limit(machineAccessMaxActiveSessions)
    .execute();
  return rows.map(shellSessionSummary);
}

/**
 * One page of a computer's session history, newest first, each session with
 * the requests it was audited making.
 */
export async function listShellHistory(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly before?: string;
    readonly limit: number;
    readonly runnerId: RunnerId;
  },
): Promise<{
  readonly nextCursor: string | null;
  readonly sessions: readonly ShellSessionHistoryRecord[];
}> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > machineAccessHistoryMaxSessions
  ) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Machine access history page limit is invalid",
    });
  }
  const cursor = input.before ? decodeShellHistoryCursor(input.before) : null;
  let query = shellSessionsWithCaller(database).where(
    "machineAccessSessions.runnerId",
    "=",
    input.runnerId,
  );
  if (cursor) {
    query = query.where((expression) =>
      expression.or([
        expression("startedAt", "<", cursor.startedAt),
        expression.and([
          expression("startedAt", "=", cursor.startedAt),
          expression("machineAccessSessions.id", "<", cursor.id),
        ]),
      ]),
    );
  }
  const rows = await query
    .orderBy("startedAt", "desc")
    .orderBy("machineAccessSessions.id", "desc")
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit);
  const sessionIds = page.map((row) => row.id);
  const events =
    sessionIds.length === 0
      ? []
      : await database
          .selectFrom("machineAccessEvents")
          .select(["event", "sessionId"])
          .where("sessionId", "in", sessionIds)
          .orderBy("sessionId", "asc")
          .orderBy("id", "asc")
          .execute();
  const eventsBySession = new Map<ShellSessionId, ShellAuditEvent[]>();
  for (const row of events) {
    const list = eventsBySession.get(row.sessionId) ?? [];
    list.push(row.event);
    eventsBySession.set(row.sessionId, list);
  }
  const sessions = page.map((row) => ({
    ...shellSessionSummary(row),
    endReason: row.endReason,
    endedAt: row.endedAt,
    events: eventsBySession.get(row.id) ?? [],
  }));
  // A machine that flooded its audit could otherwise return dozens of
  // thousand-event sessions in one page. Trim from the end until the page is
  // under the response cap and re-point the cursor so the client fetches the
  // dropped sessions next. A single session always fits (≤ 1,001 × 8 KiB).
  let hasMore = rows.length > input.limit;
  while (sessions.length > 1 && serializedByteLength(sessions) > machineAccessHistoryMaxBytes) {
    sessions.pop();
    hasMore = true;
  }
  const last = sessions.at(-1);
  return {
    nextCursor:
      hasMore && last
        ? encodeShellHistoryCursor({ id: last.id, startedAt: new Date(last.startedAt) })
        : null,
    sessions,
  };
}

async function isPersonalDeployment(database: Kysely<DatabaseSchema>): Promise<boolean> {
  const deployment = await database
    .selectFrom("deployments")
    .select("deploymentShape")
    .where("singletonKey", "=", "primary")
    .executeTakeFirst();
  return deployment?.deploymentShape.kind === "personal";
}

/** A Personal Deployment has exactly one established owner. */
async function personalDeploymentOwner(database: Kysely<DatabaseSchema>): Promise<UserId | null> {
  const owner = await database
    .selectFrom("users")
    .select("id")
    .where("instanceRole", "=", "administrator")
    .where("disabledAt", "is", null)
    .orderBy("createdAt", "asc")
    .executeTakeFirst();
  return owner?.id ?? null;
}
