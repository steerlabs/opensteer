import {
  reserveProjectWorkStop,
  finalizeProjectRunTransaction,
  finishTerminalProjectRunTransaction,
} from "./run-finalization.js";
import { readProjectThreadHistory, type ThreadHistoryQuery } from "./thread-history.js";
import { boundedSerializedPrefix } from "./message-window.js";
import { ProjectExecutionStore } from "./project-execution-store.js";
import { HarnessInputSchema } from "@opensteer/protocol";
import {
  projectOriginFromRow,
  projectWorkIsCurrent,
  assertActiveProjectBinding,
  readProjectRunBinding,
} from "./execution-authority.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql, type Selectable, type Kysely } from "kysely";
import { z } from "zod";
import {
  createId,
  HumanRootSchema,
  ProjectRunBindingSchema,
  RunIdSchema,
  ThreadIdSchema,
  AssignmentIdSchema,
  ReplyTargetSchema,
  TriggerOccurrenceIdSchema,
  TriggerWatchActivationIdSchema,
  TriggerRevisionIdSchema,
  TriggerIdSchema,
  type MessageAuthor,
  type ProjectRunBinding,
  type AssignmentId,
  type CausalChainId,
  type ReplyTarget,
  agentDelegationMaxDepth,
  MessageContentSchema,
  ThreadInputPolicySchema,
  nonTerminalRunStatuses,
  causalChainMaxDelegations,
  causalChainMaxAutonomousRuns,
  WorkspaceIdSchema,
  ThreadRoleSchema,
  ThreadTitleSchema,
  type ThreadId,
  type RunId,
  type CommandId,
  type HumanRoot,
  type ContentPart,
  type ThreadInputPolicy,
  type RunnerId,
  type HarnessInstanceId,
  type AgentEvent,
} from "@opensteer/core";
import type { ThreadRow, ThreadInputTable, RunRow } from "./schema.js";
import type { ThreadInputSource } from "./thread-store.js";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { TransactionScopeChanged, withDatabaseTransaction } from "./connection.js";
import {
  ProjectRuntimeSnapshotSchema,
  type ProjectRuntimeSnapshot,
  resolveAdmittedProjectRuntime,
  resolveProjectRuntime,
} from "./project-runtime-settings-store.js";
import {
  jsonValue,
  lockWorkspaceRow,
  principalIdForUser,
  requireBoundedIdentity,
  lockCommandIdempotency,
  encodeWindowCursor,
  decodeWindowCursor,
  escapeLikePattern,
} from "./store-primitives.js";
import {
  threadInputFromRow,
  messageFromRow,
  threadRunQueueEntryFromRow,
  threadFromRow,
  threadPendingRequestsSelection,
  threadProviderSessionSelection,
  threadContinuationIdentitySelection,
} from "./thread-row-mappers.js";
import {
  projectAssignmentEventsInTransaction,
  assignmentSummaryInTransaction,
} from "./assignment-store.js";
import { assertThreadInputCapacity } from "./thread-inbox.js";
import { projectThreadState } from "./thread-status.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { OpensteerError, type WorkspaceId } from "@opensteer/core";
import type { Transaction } from "kysely";
import { createChannelId, type PrincipalId } from "@opensteer/channel-core";
import type { DatabaseSchema } from "./schema.js";

/** The caller reserves the Project and its memberships before looking up its principal. */
export async function ensureProjectPrincipal(
  transaction: Transaction<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<PrincipalId> {
  const workspace = await transaction
    .selectFrom("workspaces")
    .select(["name", "kind", "status", "deletedAt"])
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  if (
    !workspace ||
    workspace.kind !== "project" ||
    workspace.deletedAt !== null ||
    workspace.status === "deleting" ||
    workspace.status === "deleted"
  )
    throw new OpensteerError({ code: "workspace_unavailable", message: "Project is unavailable" });
  const existing = await transaction
    .selectFrom("principals")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("kind", "=", "project")
    .executeTakeFirst();
  if (existing) return existing.id;
  const inserted = await transaction
    .insertInto("principals")
    .values({
      id: createChannelId("principal"),
      kind: "project",
      workspaceId,
      userId: null,
      displayName: workspace.name,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflict((conflict) =>
      conflict.column("workspaceId").where("workspaceId", "is not", null).doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  if (inserted) return inserted.id;
  const winner = await transaction
    .selectFrom("principals")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("kind", "=", "project")
    .executeTakeFirstOrThrow();
  return winner.id;
}

export type ProjectExchange = {
  readonly project: import("@opensteer/core").ProjectAuthority["principal"];
  readonly threadId: import("@opensteer/core").ThreadId;
  readonly assignmentId: import("@opensteer/core").AssignmentId | null;
  readonly replyTarget: import("@opensteer/core").ReplyTarget | null;
} & (
  | { readonly origin: import("@opensteer/core").HumanRoot }
  | {
      readonly origin: null;
      readonly source: {
        readonly kind: "trigger" | "watch" | "platform";
        readonly id: string;
        readonly incarnation: string;
      };
    }
);

export function projectExchangeKey(exchange: ProjectExchange): string {
  return canonicalJson([
    "project-exchange-v1",
    exchange.project.workspaceId,
    exchange.project.principalId,
    exchange.threadId,
    exchange.origin
      ? [
          "human",
          exchange.origin.userId,
          exchange.origin.initiatorGeneration,
          exchange.origin.membershipGeneration,
          exchange.origin.originConnectionId,
        ]
      : ["unattended", exchange.source.kind, exchange.source.id, exchange.source.incarnation],
    exchange.assignmentId,
    exchange.replyTarget,
  ]);
}

export type ProjectWorkSource =
  | Exclude<ThreadInputSource, { kind: "channel" | "automation" | "trigger" | "watch" }>
  | (Extract<ThreadInputSource, { kind: "trigger" | "watch" }> & {
      readonly executionGeneration: number;
    });

export interface ProjectWorkAdmission {
  readonly threadId: ThreadId;
  readonly origin: HumanRoot | null;
  readonly source: ProjectWorkSource;
  readonly content: readonly ContentPart[];
  readonly policy: ThreadInputPolicy;
  readonly idempotencyKey: string;
}

export {
  ProjectRuntimeSnapshotSchema,
  type ProjectRuntimeSnapshot,
} from "./project-runtime-settings-store.js";

export { projectOriginFromRow } from "./execution-authority.js";

function admissionUnavailable(reason: string): never {
  throw new OpensteerError({
    code: "conflict",
    reason,
    message: `Project work is unavailable: ${reason}`,
  });
}

const ProjectInputSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  z.strictObject({ kind: z.literal("connection"), connectionId: z.string().min(1).max(255) }),
  z.strictObject({ kind: z.literal("agent"), runId: RunIdSchema }),
  z.strictObject({
    kind: z.literal("platform"),
    sourceRunId: RunIdSchema,
    cause: z.string().min(1).max(120),
    referenceId: z.string().min(1).max(255).optional(),
  }),
  z.strictObject({
    kind: z.literal("trigger"),
    executionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    occurrenceId: TriggerOccurrenceIdSchema,
  }),
  z.strictObject({
    kind: z.literal("watch"),
    executionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    activationId: TriggerWatchActivationIdSchema,
    observationId: z.string().min(1).max(512),
    revisionId: TriggerRevisionIdSchema,
    triggerId: TriggerIdSchema,
  }),
]);

const ProjectWorkAdmissionSchema = z.strictObject({
  threadId: ThreadIdSchema,
  origin: HumanRootSchema.nullable(),
  source: ProjectInputSourceSchema,
  content: MessageContentSchema,
  policy: ThreadInputPolicySchema,
  idempotencyKey: z.string().min(1).max(4096),
});

export function projectExchangeFromRow(
  row: Pick<
    RunRow,
    | "threadId"
    | "actorPrincipalId"
    | "requestedBy"
    | "membershipGeneration"
    | "initiatorGeneration"
    | "originConnectionId"
    | "authoritySource"
    | "assignmentId"
    | "replyTarget"
  >,
  workspaceId: WorkspaceId,
): ProjectExchange {
  const common = {
    project: { kind: "project" as const, principalId: row.actorPrincipalId, workspaceId },
    threadId: row.threadId,
    assignmentId: row.assignmentId,
    replyTarget: row.replyTarget === null ? null : ReplyTargetSchema.parse(row.replyTarget),
  };
  const origin = projectOriginFromRow(row);
  if (origin) return { ...common, origin };
  const source = row.authoritySource;
  if (source.kind === "trigger-occurrence")
    return {
      ...common,
      origin: null,
      source: {
        kind: "trigger",
        id: TriggerOccurrenceIdSchema.parse(source.occurrenceId),
        incarnation: z.string().min(1).parse(source.incarnation),
      },
    };
  if (source.kind === "watch-observation")
    return {
      ...common,
      origin: null,
      source: {
        kind: "watch",
        id: canonicalJson([source.activationId, source.observationId]),
        incarnation: canonicalJson([source.revisionId, source.incarnation]),
      },
    };
  return admissionUnavailable("unattended-source-not-supported");
}

async function reserveProjectMembership(
  transaction: Transaction<DatabaseSchema>,
  workspaceId: WorkspaceId,
  origin: HumanRoot,
) {
  const membership = await transaction
    .selectFrom("workspaceMemberships")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("userId", "=", origin.userId)
    .where("state", "=", "active")
    .where("generation", "=", String(origin.membershipGeneration))
    .forShare()
    .executeTakeFirst();
  if (!membership) admissionUnavailable("captured-root-unavailable");
}

export async function reserveProjectRuntime(
  transaction: Transaction<DatabaseSchema>,
  workspaceId: WorkspaceId,
  origin: HumanRoot | null,
  runnerIsConnected: (id: RunnerId) => boolean,
  admitted?: ProjectRuntimeSnapshot,
  additionalHarnesses: readonly HarnessInstanceId[] = [],
) {
  const observedRunner = await transaction
    .selectFrom("executionEnvironments")
    .select("runnerId")
    .where(
      "id",
      "=",
      (
        await transaction
          .selectFrom("workspaces")
          .select("ownerEnvironmentId")
          .where("id", "=", workspaceId)
          .executeTakeFirstOrThrow()
      ).ownerEnvironmentId,
    )
    .executeTakeFirstOrThrow();
  if (!observedRunner.runnerId) admissionUnavailable("computer-offline");
  await transaction
    .selectFrom("runners")
    .select("id")
    .where("id", "=", observedRunner.runnerId)
    .forShare()
    .executeTakeFirstOrThrow();
  if (origin) await reserveProjectMembership(transaction, workspaceId, origin);
  const resolve = () =>
    admitted
      ? resolveAdmittedProjectRuntime(transaction, workspaceId, admitted, runnerIsConnected)
      : resolveProjectRuntime(transaction, workspaceId, runnerIsConnected);
  let runtime = await resolve();
  if (runtime.state !== "ready") admissionUnavailable(runtime.reason);
  const environmentId = runtime.environmentId;
  await transaction
    .selectFrom("executionEnvironments")
    .select("id")
    .where("id", "=", runtime.environmentId)
    .forShare()
    .executeTakeFirstOrThrow();
  const harnessIds = [...new Set([runtime.settings.harnessInstanceId, ...additionalHarnesses])];
  const harnesses = await transaction
    .selectFrom("harnessInstances")
    .select(["id", "environmentId"])
    .where("id", "in", harnessIds)
    .orderBy("id")
    .forShare()
    .execute();
  if (
    harnesses.length !== harnessIds.length ||
    harnesses.some((row) => row.environmentId !== environmentId)
  )
    admissionUnavailable("engine-unavailable");
  if (!admitted)
    await transaction
      .selectFrom("projectRuntimeSettings")
      .select("workspaceId")
      .where("workspaceId", "=", workspaceId)
      .forShare()
      .executeTakeFirstOrThrow();
  runtime = await resolve();
  if (runtime.state !== "ready") admissionUnavailable(runtime.reason);
  if (
    runtime.environmentId !== environmentId ||
    !harnessIds.includes(runtime.settings.harnessInstanceId)
  )
    admissionUnavailable("placement-changed");
  const principalId = await ensureProjectPrincipal(transaction, workspaceId);
  const snapshot = ProjectRuntimeSnapshotSchema.parse({
    settingsRevision:
      admitted?.settingsRevision ??
      ("revision" in runtime.settings ? runtime.settings.revision : undefined),
    harnessInstanceId: runtime.settings.harnessInstanceId,
    modelSelection: runtime.settings.modelSelection,
    accessMode: runtime.settings.accessMode,
    instructions: runtime.settings.instructions,
    timeZone: runtime.settings.timeZone,
  });
  return {
    environmentId: runtime.environmentId,
    principalId,
    snapshot,
    runnerId: observedRunner.runnerId,
  };
}

async function queueProjectRun(
  transaction: Transaction<DatabaseSchema>,
  thread: ThreadRow,
  receipt: Selectable<ThreadInputTable>,
  snapshot: ProjectRuntimeSnapshot,
) {
  const now = new Date();
  const environmentId = thread.environmentId;
  const root = {
    actorPrincipalId: receipt.actorPrincipalId,
    requestedBy: receipt.requestedBy,
    membershipGeneration: receipt.membershipGeneration,
    initiatorGeneration: receipt.initiatorGeneration,
    originConnectionId: receipt.originConnectionId,
    authoritySource: jsonValue(receipt.authoritySource),
  };
  if (receipt.requestedBy === null || receipt.authoritySource.parentRunId !== undefined) {
    const budget = await transaction
      .updateTable("causalChains")
      .set((expression) => ({ usedAutonomousRuns: expression("usedAutonomousRuns", "+", 1) }))
      .where("id", "=", receipt.causalChainId)
      .whereRef("usedAutonomousRuns", "<", "maxAutonomousRuns")
      .returning("id")
      .executeTakeFirst();
    if (!budget) admissionUnavailable("autonomous-run-budget-exhausted");
  }
  const events: AgentEvent[] = [];
  const runId = createId("run");
  const providerSessionId = createId("providerSession");
  await transaction
    .insertInto("providerSessions")
    .values({
      id: providerSessionId,
      threadId: thread.id,
      harnessInstanceId: snapshot.harnessInstanceId,
      active: false,
      stateLayout: "session",
      continuationIdentity: null,
      providerSessionReference: null,
      runnerId: null,
      runnerBootId: null,
      bindingGeneration: 0,
      leaseTokenHash: null,
      leaseExpiresAt: null,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  const run = await transaction
    .insertInto("runs")
    .values({
      ...root,
      id: runId,
      threadId: thread.id,
      environmentId: environmentId,
      harnessInstanceId: snapshot.harnessInstanceId,
      modelSelection: jsonValue(snapshot.modelSelection),
      accessMode: snapshot.accessMode,
      activationInputId: receipt.messageId,
      seedInputId: receipt.messageId,
      assignmentId: receipt.assignmentId,
      causalChainId: receipt.causalChainId,
      providerSessionId,
      replyTarget: receipt.replyTarget === null ? null : jsonValue(receipt.replyTarget),
      runOrdinal: thread.nextRunOrdinal,
      status: "queued",
      startedAt: null,
      completedAt: null,
      createdAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const commandId = createId("command");
  await transaction
    .insertInto("commands")
    .values({
      ...root,
      id: commandId,
      threadId: thread.id,
      environmentId: environmentId,
      runId,
      idempotencyKey: `run:${runId}`,
      type: "run.execute.project",
      payload: jsonValue({ type: "run.execute.project", runId, threadId: thread.id }),
      status: "pending",
      dispatcherId: null,
      lastError: null,
    })
    .execute();
  await transaction
    .updateTable("threads")
    .set({ nextRunOrdinal: thread.nextRunOrdinal + 1 })
    .where("id", "=", thread.id)
    .execute();
  events.push(
    await appendHostWorkspaceEvent(transaction, {
      type: "run.queued",
      data: { run: threadRunQueueEntryFromRow(run) },
      environmentId: thread.environmentId,
      threadId: thread.id,
      runId,
      workspaceId: thread.workspaceId,
    }),
  );
  return { run, commandId, events };
}

const ProjectThreadCreationSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  origin: HumanRootSchema,
  title: ThreadTitleSchema,
  role: ThreadRoleSchema,
  home: z.boolean(),
  idempotencyKey: z.string().min(1).max(4096),
});

export async function fenceProjectHumanRoot(
  transaction: Transaction<DatabaseSchema>,
  origin: HumanRoot,
) {
  const user = await transaction
    .selectFrom("users")
    .select("id")
    .where("id", "=", origin.userId)
    .where("authorityGeneration", "=", String(origin.initiatorGeneration))
    .where("memberState", "=", "active")
    .where("admittedAt", "is not", null)
    .where("disabledAt", "is", null)
    .forShare()
    .executeTakeFirst();
  if (!user) admissionUnavailable("captured-root-unavailable");
}

export class ProjectWorkStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly dependencies: {
    readonly cancelRunRequests?:
      import("./run-finalization.js").ProjectRunRequestCancellation | undefined;
    readonly runnerIsConnected: (runnerId: RunnerId) => boolean;
    readonly runnerIsAttached: (runnerId: RunnerId, runnerBootId: string) => boolean;
  };

  constructor(database: Kysely<DatabaseSchema>, dependencies: ProjectWorkStore["dependencies"]) {
    this.database = database;
    this.dependencies = dependencies;
  }

  async projectThread(binding: ProjectRunBinding, threadId: ThreadId) {
    await assertActiveProjectBinding(this.database, binding, this.dependencies);
    const row = await this.database
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .where("id", "=", ThreadIdSchema.parse(threadId))
      .where("workspaceId", "=", binding.workspaceId)
      .executeTakeFirst();
    if (!row)
      throw new OpensteerError({ code: "forbidden", message: "Thread is outside this Project" });
    return threadFromRow(row);
  }

  async projectHistory(binding: ProjectRunBinding, input: Omit<ThreadHistoryQuery, "ownerId">) {
    await assertActiveProjectBinding(this.database, binding, this.dependencies);
    return readProjectThreadHistory(
      this.database,
      { ...input, binding },
      this.dependencies.runnerIsAttached,
    );
  }

  async projectThreads(
    binding: ProjectRunBinding,
    input: {
      readonly limit: number;
      readonly before?: string;
      readonly query?: string;
      readonly parentThreadId?: ThreadId;
    },
  ) {
    await assertActiveProjectBinding(this.database, binding, this.dependencies);
    z.number().int().min(1).max(50).parse(input.limit);
    if (input.parentThreadId) await this.projectThread(binding, input.parentThreadId);
    const scopeId = canonicalJson([
      binding.authority.principal,
      binding.runId,
      binding.bindingGeneration,
      input.query ?? null,
      input.parentThreadId ?? null,
    ]);
    const anchor = input.before ? decodeWindowCursor(input.before, "agent-thread", scopeId) : null;
    let query = this.database
      .selectFrom("threads")
      .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
      .where("threads.workspaceId", "=", binding.workspaceId);
    if (input.parentThreadId)
      query = query.where((eb) =>
        eb.or([
          eb("threads.parentThreadId", "=", input.parentThreadId ?? null),
          eb.exists(
            eb
              .selectFrom("delegations")
              .select("id")
              .whereRef("delegations.childThreadId", "=", "threads.id")
              .where("delegations.parentThreadId", "=", input.parentThreadId ?? binding.threadId),
          ),
        ]),
      );
    if (input.query)
      query = query.where(
        sql<boolean>`threads.title ilike ${`%${escapeLikePattern(input.query)}%`} escape '\\'`,
      );
    if (anchor)
      query = query.where((eb) =>
        eb.or([
          eb("threads.updatedAt", "<", anchor.timestamp),
          eb.and([
            eb("threads.updatedAt", "=", anchor.timestamp),
            eb("threads.id", "<", ThreadIdSchema.parse(anchor.id)),
          ]),
        ]),
      );
    const rows = await query
      .selectAll("threads")
      .select([
        "workspaces.name as workspaceName",
        threadPendingRequestsSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .select((eb) => [
        eb
          .selectFrom("delegations")
          .select("id")
          .whereRef("childThreadId", "=", "threads.id")
          .orderBy("createdAt", "desc")
          .orderBy("id", "desc")
          .limit(1)
          .as("assignmentId"),
        eb
          .selectFrom("delegations")
          .select("status")
          .whereRef("childThreadId", "=", "threads.id")
          .orderBy("createdAt", "desc")
          .orderBy("id", "desc")
          .limit(1)
          .as("taskStatus"),
      ])
      .orderBy("threads.updatedAt", "desc")
      .orderBy("threads.id", "desc")
      .limit(input.limit + 1)
      .execute();
    const window = boundedSerializedPrefix(
      rows.slice(0, input.limit).map((row) => ({
        ...threadFromRow(row),
        assignmentId: row.assignmentId,
        taskStatus: row.taskStatus,
        workspaceName: row.workspaceName,
      })),
      input.limit,
      128 * 1024,
    );
    const last = window.items.at(-1);
    return {
      threads: window.items,
      hasMore: rows.length > window.items.length,
      nextBefore:
        rows.length > window.items.length && last
          ? encodeWindowCursor("agent-thread", scopeId, last.updatedAt, last.id)
          : null,
    };
  }

  async projectTask(binding: ProjectRunBinding, assignmentId: AssignmentId) {
    await assertActiveProjectBinding(this.database, binding, this.dependencies);
    const row = await this.database
      .selectFrom("delegations")
      .innerJoin("threads", "threads.id", "delegations.childThreadId")
      .innerJoin("threads as parent", "parent.id", "delegations.parentThreadId")
      .selectAll("delegations")
      .where("delegations.id", "=", AssignmentIdSchema.parse(assignmentId))
      .where("threads.workspaceId", "=", binding.workspaceId)
      .where("parent.workspaceId", "=", binding.workspaceId)
      .executeTakeFirst();
    if (!row)
      throw new OpensteerError({ code: "forbidden", message: "Task is outside this Project" });
    return {
      summary: await assignmentSummaryInTransaction(this.database, row),
      result: row.resultText,
      row,
    };
  }

  async cancelProjectTask(bindingInput: ProjectRunBinding, assignmentIdInput: AssignmentId) {
    const binding = ProjectRunBindingSchema.parse(bindingInput);
    const assignmentId = AssignmentIdSchema.parse(assignmentIdInput);
    await assertActiveProjectBinding(this.database, binding, this.dependencies);
    return withDatabaseTransaction(
      this.database,
      async (transaction) => {
        const task = await transaction
          .selectFrom("delegations")
          .innerJoin("threads", "threads.id", "delegations.childThreadId")
          .selectAll("delegations")
          .where("delegations.id", "=", assignmentId)
          .where("delegations.parentRunId", "=", binding.runId)
          .where("threads.workspaceId", "=", binding.workspaceId)
          .executeTakeFirst();
        if (!task) admissionUnavailable("task-not-assigned-by-this-run");
        if (task.status !== "open") return { events: [] as AgentEvent[] };
        const discover = async () => {
          const branch = await sql<{ id: ThreadId }>`with recursive branch(id) as (
          select child_thread_id from delegations where id = ${assignmentId}
          union select d.child_thread_id from delegations d join branch b on d.parent_thread_id=b.id where d.status='open'
        ) select t.id from branch b join threads t on t.id=b.id where t.workspace_id=${binding.workspaceId} order by t.id`.execute(
            transaction,
          );
          const threadIds = branch.rows.map((row) => row.id);
          const assignments = await transaction
            .selectFrom("delegations")
            .selectAll()
            .where("childThreadId", "in", threadIds)
            .where("status", "=", "open")
            .orderBy("id")
            .execute();
          const runs = assignments.length
            ? await transaction
                .selectFrom("runs")
                .selectAll()
                .where(
                  "assignmentId",
                  "in",
                  assignments.map((row) => row.id),
                )
                .where("status", "in", nonTerminalRunStatuses)
                .orderBy("id")
                .execute()
            : [];
          return { threadIds, assignments, runs };
        };
        const observed = await discover();
        const runIds = [...new Set([binding.runId, ...observed.runs.map((row) => row.id)])].sort();
        await transaction
          .selectFrom("runs")
          .select("id")
          .where("id", "in", runIds)
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        await lockWorkspaceRow(transaction, binding.workspaceId);
        const reserved = await discover();
        if (!reserved.assignments.length) return { events: [] as AgentEvent[] };
        if (
          reserved.runs.some((row) => !runIds.includes(row.id)) ||
          reserved.threadIds.some((id) => !observed.threadIds.includes(id))
        )
          throw new TransactionScopeChanged();
        const source = await transaction
          .selectFrom("runs")
          .selectAll()
          .where("id", "=", binding.runId)
          .executeTakeFirstOrThrow();
        const sourceKey = projectExchangeKey({
          ...projectExchangeFromRow(source, binding.workspaceId),
          assignmentId: null,
          replyTarget: null,
        });
        if (
          reserved.runs.some(
            (row) =>
              row.causalChainId !== source.causalChainId ||
              projectExchangeKey({
                ...projectExchangeFromRow(row, binding.workspaceId),
                threadId: binding.threadId,
                assignmentId: null,
                replyTarget: null,
              }) !== sourceKey,
          )
        )
          admissionUnavailable("task-origin-mismatch");
        await reserveProjectWorkStop(transaction, {
          runIds,
          workspaceIds: [binding.workspaceId],
          threadIds: reserved.threadIds,
        });
        await assertActiveProjectBinding(transaction, binding, this.dependencies);
        const events: AgentEvent[] = [];
        const now = new Date();
        for (const assignment of reserved.assignments) {
          const cancelled = await transaction
            .updateTable("delegations")
            .set((eb) => ({
              status: "cancelled",
              finishedAt: now,
              resultStatus: "undeliverable",
              completedAt: now,
              resultReason: "assignment-cancelled",
              resultAttemptedAt: now,
              revision: eb("revision", "+", 1),
              updatedAt: now,
            }))
            .where("id", "=", assignment.id)
            .where("status", "=", "open")
            .returningAll()
            .executeTakeFirst();
          if (cancelled)
            events.push(
              ...(await projectAssignmentEventsInTransaction(
                transaction,
                cancelled,
                "assignment.updated",
                cancelled.childRunId,
              )),
            );
        }
        const cancelledInputs = await transaction
          .updateTable("threadInputs")
          .set({ state: "cancelled", cancelReason: "assignment-closed", updatedAt: now })
          .where(
            "assignmentId",
            "in",
            reserved.assignments.map((row) => row.id),
          )
          .where("state", "in", ["pending", "claimed", "unknown"])
          .returningAll()
          .execute();
        for (const receipt of cancelledInputs)
          events.push(
            await appendHostWorkspaceEvent(transaction, {
              type: "thread-input.updated",
              data: { input: threadInputFromRow(receipt) },
              environmentId: source.environmentId,
              workspaceId: binding.workspaceId,
              threadId: receipt.threadId,
              runId: receipt.runId,
            }),
          );
        for (const run of reserved.runs)
          events.push(
            ...(await finalizeProjectRunTransaction(transaction, {
              runId: run.id,
              source: "host",
              status: "interrupted",
              completedAt: now,
              deferAttemptCleanup: true,
              cancelRequests: this.dependencies.cancelRunRequests,
            })),
          );
        const stoppedIds = reserved.runs.map((row) => row.id);
        if (stoppedIds.length) {
          await transaction
            .selectFrom("executionNodes")
            .select("id")
            .where("runId", "in", stoppedIds)
            .where("status", "=", "running")
            .orderBy("id")
            .forNoKeyUpdate()
            .execute();
          await transaction
            .selectFrom("runAttempts")
            .select("id")
            .where("runId", "in", stoppedIds)
            .where("endedAt", "is", null)
            .orderBy("id")
            .forNoKeyUpdate()
            .execute();
          for (const id of stoppedIds) await finishTerminalProjectRunTransaction(transaction, id);
        }
        return { events };
      },
      "read committed",
      (error) => error instanceof TransactionScopeChanged,
    );
  }

  async resolveProjectCaller(binding: ProjectRunBinding) {
    const thread = await this.projectThread(binding, binding.threadId);
    const run = await this.database
      .selectFrom("runs")
      .select("authoritySource")
      .where("id", "=", binding.runId)
      .executeTakeFirstOrThrow();
    const snapshot = ProjectRuntimeSnapshotSchema.parse(run.authoritySource.projectRuntime);
    return { thread, accessMode: snapshot.accessMode };
  }

  async createProjectThread(input: z.input<typeof ProjectThreadCreationSchema>) {
    const request = ProjectThreadCreationSchema.parse(input);
    requireBoundedIdentity(request.idempotencyKey, "Project Thread identity", 4096);
    if (request.home && request.role !== "conversation")
      admissionUnavailable("chat-must-be-conversation");
    await assertProjectAuthority(this.database);
    return withDatabaseTransaction(this.database, async (transaction) => {
      const key = `project-thread:${createHash("sha256")
        .update(canonicalJson([request.workspaceId, request.origin, request.idempotencyKey]))
        .digest("hex")}`;
      await lockCommandIdempotency(transaction, request.origin.userId, key);
      if (request.origin.originConnectionId !== null) {
        const connection = await transaction
          .selectFrom("agentConnections")
          .select("id")
          .where("id", "=", request.origin.originConnectionId)
          .where("userId", "=", request.origin.userId)
          .where("workspaceId", "=", request.workspaceId)
          .where("memberGeneration", "=", String(request.origin.initiatorGeneration))
          .where("membershipGeneration", "=", String(request.origin.membershipGeneration))
          .where("revokedAt", "is", null)
          .forShare()
          .executeTakeFirst();
        if (!connection) admissionUnavailable("captured-root-unavailable");
      }
      const root = await transaction
        .selectFrom("workspaceMemberships")
        .innerJoin("users", "users.id", "workspaceMemberships.userId")
        .select("workspaceMemberships.id")
        .where("workspaceMemberships.workspaceId", "=", request.workspaceId)
        .where("users.id", "=", request.origin.userId)
        .where("users.authorityGeneration", "=", String(request.origin.initiatorGeneration))
        .where("users.admittedAt", "is not", null)
        .where("users.disabledAt", "is", null)
        .where("users.memberState", "=", "active")
        .where("workspaceMemberships.state", "=", "active")
        .where("workspaceMemberships.generation", "=", String(request.origin.membershipGeneration))
        .executeTakeFirst();
      if (!root) admissionUnavailable("captured-root-unavailable");
      await lockWorkspaceRow(transaction, request.workspaceId);
      const workspace = await transaction
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", request.workspaceId)
        .where("kind", "=", "project")
        .where("deletedAt", "is", null)
        .where("status", "=", "ready")
        .executeTakeFirst();
      if (!workspace) admissionUnavailable("workspace-unavailable");
      const prior = await transaction
        .selectFrom("commands")
        .select(["payload", "threadId"])
        .where("requestedBy", "=", request.origin.userId)
        .where("idempotencyKey", "=", key)
        .where("type", "=", "thread.create")
        .executeTakeFirst();
      if (prior && !isDeepStrictEqual(prior.payload, request))
        admissionUnavailable("idempotency-conflict");
      const existingId = prior?.threadId ?? (request.home ? workspace.homeThreadId : null);
      if (existingId) {
        const existing = await transaction
          .selectFrom("threads")
          .selectAll()
          .select([
            threadPendingRequestsSelection,
            threadProviderSessionSelection,
            threadContinuationIdentitySelection,
          ])
          .where("id", "=", existingId)
          .where("workspaceId", "=", workspace.id)
          .executeTakeFirstOrThrow();
        await reserveProjectMembership(transaction, workspace.id, request.origin);
        await fenceProjectHumanRoot(transaction, request.origin);
        return {
          thread: threadFromRow(existing),
          events: [] as AgentEvent[],
          wasDuplicate: true,
        };
      }
      const { environmentId, snapshot, principalId } = await reserveProjectRuntime(
        transaction,
        workspace.id,
        request.origin,
        this.dependencies.runnerIsConnected,
      );
      const actorPrincipalId = await principalIdForUser(transaction, request.origin.userId);
      const now = new Date();
      const threadId = createId("thread");
      const thread = await transaction
        .insertInto("threads")
        .values({
          id: threadId,
          lineageRootThreadId: threadId,
          parentThreadId: null,
          workspaceId: workspace.id,
          createdBy: request.origin.userId,
          createdByPrincipalId: principalId,
          environmentId,
          harnessInstanceId: snapshot.harnessInstanceId,
          modelSelection: jsonValue(snapshot.modelSelection),
          accessMode: snapshot.accessMode,
          role: request.role,
          title: request.title,
          titleSource: "chosen",
          status: "idle",
          listed: true,
          inheritsMain: false,
          icon: null,
          iconSource: "provisional",
          color: workspace.color,
          askedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (request.home)
        await transaction
          .updateTable("workspaces")
          .set({ homeThreadId: thread.id })
          .where("id", "=", workspace.id)
          .execute();
      await transaction
        .insertInto("commands")
        .values({
          id: createId("command"),
          type: "thread.create",
          status: "succeeded",
          requestedBy: request.origin.userId,
          actorPrincipalId,
          authoritySource: jsonValue({ kind: "user-session", userId: request.origin.userId }),
          idempotencyKey: key,
          payload: jsonValue(request),
          environmentId,
          threadId: thread.id,
          runId: null,
          dispatcherId: null,
          lastError: null,
        })
        .execute();
      await fenceProjectHumanRoot(transaction, request.origin);
      const dto = threadFromRow({
        ...thread,
        providerSessionId: null,
        continuationIdentity: null,
        pendingRequests: 0,
      });
      const event = await appendHostWorkspaceEvent(transaction, {
        type: "thread.created",
        data: { thread: dto, ...(request.home ? { home: true as const } : {}) },
        workspaceId: workspace.id,
        environmentId,
        threadId: thread.id,
        runId: null,
      });
      return { thread: dto, events: [event], wasDuplicate: false };
    });
  }

  async admitProjectWork(input: ProjectWorkAdmission) {
    ProjectWorkAdmissionSchema.parse(input);
    await assertProjectAuthority(this.database);
    return withDatabaseTransaction(
      this.database,
      (transaction) => this.admitInTransaction(transaction, input),
      undefined,
      (error) => error instanceof TransactionScopeChanged,
    );
  }

  async recoverPendingProjectWork(threadId: ThreadId) {
    ThreadIdSchema.parse(threadId);
    await assertProjectAuthority(this.database);
    return withDatabaseTransaction(
      this.database,
      async (transaction) => {
        const pending = await transaction
          .selectFrom("threadInputs")
          .innerJoin("threads", "threads.id", "threadInputs.threadId")
          .selectAll("threadInputs")
          .select("threads.workspaceId")
          .where("threadInputs.threadId", "=", threadId)
          .where("threadInputs.state", "=", "pending")
          .where("threadInputs.policy", "=", "queue")
          .orderBy("threadInputs.queueRank")
          .orderBy("threadInputs.messageId")
          .limit(1)
          .executeTakeFirst();
        if (!pending)
          return {
            state: "idle" as const,
            runId: null,
            commandId: null,
            events: [] as AgentEvent[],
          };
        const reserved = await transaction
          .selectFrom("runs")
          .selectAll()
          .where("threadId", "=", threadId)
          .where("status", "in", nonTerminalRunStatuses)
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        if (pending.authoritySource.kind === "trigger-occurrence")
          await transaction
            .selectFrom("triggerOccurrences")
            .select("id")
            .where("id", "=", TriggerOccurrenceIdSchema.parse(pending.authoritySource.occurrenceId))
            .forShare()
            .execute();
        await lockWorkspaceRow(transaction, pending.workspaceId);
        const active = await transaction
          .selectFrom("runs")
          .selectAll()
          .where("threadId", "=", threadId)
          .where("status", "in", nonTerminalRunStatuses)
          .execute();
        if (active.some((run) => !reserved.some((row) => row.id === run.id)))
          throw new TransactionScopeChanged();
        const queued = active.find((run) => run.status === "queued");
        if (queued)
          return {
            state: "queued" as const,
            runId: queued.id,
            commandId: null,
            events: [] as AgentEvent[],
          };
        const savedRuntime = ProjectRuntimeSnapshotSchema.safeParse(
          pending.authoritySource.projectRuntime,
        );
        if (!savedRuntime.success) admissionUnavailable("admitted-runtime-snapshot-missing");
        const snapshot = savedRuntime.data;
        const placement = await reserveProjectRuntime(
          transaction,
          pending.workspaceId,
          projectOriginFromRow(pending),
          this.dependencies.runnerIsConnected,
          snapshot,
        );
        const thread = await transaction
          .selectFrom("threads")
          .selectAll()
          .where("id", "=", threadId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        if (thread.status === "archived" || thread.inputQueuePaused)
          return {
            state: "unavailable" as const,
            runId: null,
            commandId: null,
            events: [] as AgentEvent[],
          };
        if (pending.authoritySource.kind === "watch-observation")
          await transaction
            .selectFrom("triggerWatchActivations")
            .select("id")
            .where(
              "id",
              "=",
              TriggerWatchActivationIdSchema.parse(pending.authoritySource.activationId),
            )
            .forShare()
            .execute();
        await transaction
          .selectFrom("causalChains")
          .select("id")
          .where("id", "=", pending.causalChainId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        await transaction
          .selectFrom("delegations")
          .select("id")
          .where("childThreadId", "=", thread.id)
          .where("status", "=", "open")
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const receipt = await transaction
          .selectFrom("threadInputs")
          .selectAll()
          .where("messageId", "=", pending.messageId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        if (receipt.state !== "pending") throw new TransactionScopeChanged();
        if (
          placement.principalId !== receipt.actorPrincipalId ||
          !(await projectWorkIsCurrent(transaction, receipt))
        ) {
          const cancelled = await transaction
            .updateTable("threadInputs")
            .set({
              state: "cancelled",
              cancelReason: "execution-authority-unavailable",
              updatedAt: new Date(),
            })
            .where("messageId", "=", receipt.messageId)
            .returningAll()
            .executeTakeFirstOrThrow();
          const event = await appendHostWorkspaceEvent(transaction, {
            type: "thread-input.updated",
            data: { input: threadInputFromRow(cancelled) },
            workspaceId: thread.workspaceId,
            environmentId: thread.environmentId,
            threadId: thread.id,
            runId: null,
          });
          return { state: "cancelled" as const, runId: null, commandId: null, events: [event] };
        }
        const result = await queueProjectRun(transaction, thread, receipt, placement.snapshot);
        const origin = projectOriginFromRow(receipt);
        if (origin) await fenceProjectHumanRoot(transaction, origin);
        return {
          state: "queued" as const,
          runId: result.run.id,
          commandId: result.commandId,
          events: [...result.events, ...(await projectThreadState(transaction, thread.id))],
        };
      },
      undefined,
      (error) => error instanceof TransactionScopeChanged,
    );
  }

  async deliverAssignmentResult(assignmentId: AssignmentId) {
    AssignmentIdSchema.parse(assignmentId);
    await assertProjectAuthority(this.database);
    return withDatabaseTransaction(
      this.database,
      async (transaction) => {
        const observed = await transaction
          .selectFrom("delegations")
          .innerJoin("runs", "runs.id", "delegations.childRunId")
          .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
          .innerJoin("threads as worker", "worker.id", "delegations.childThreadId")
          .innerJoin("threads as parent", "parent.id", "delegations.parentThreadId")
          .selectAll("delegations")
          .select([
            "worker.workspaceId",
            "parent.workspaceId as parentWorkspaceId",
            "principals.kind as actorKind",
            "principals.workspaceId as actorWorkspaceId",
          ])
          .where("delegations.id", "=", assignmentId)
          .executeTakeFirst();
        if (
          !observed ||
          observed.actorKind !== "project" ||
          observed.actorWorkspaceId !== observed.workspaceId ||
          observed.parentWorkspaceId !== observed.workspaceId
        )
          admissionUnavailable("assignment-unavailable");
        if (observed.resultStatus !== "pending" || observed.status === "open")
          return { state: "settled" as const, events: [] as AgentEvent[] };
        if (!observed.parentRunId || !observed.resultRunId)
          admissionUnavailable("project-program-assignment-result-not-supported");
        const requiredIds = [
          ...new Set([observed.parentRunId, observed.childRunId, observed.resultRunId]),
        ];
        const reserved = await transaction
          .selectFrom("runs")
          .selectAll()
          .where((expression) =>
            expression.or([
              expression("id", "in", requiredIds),
              expression.and([
                expression("threadId", "=", observed.parentThreadId),
                expression("status", "in", nonTerminalRunStatuses),
              ]),
            ]),
          )
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        await lockWorkspaceRow(transaction, observed.workspaceId);
        const current = await transaction
          .selectFrom("runs")
          .select("id")
          .where("threadId", "=", observed.parentThreadId)
          .where("status", "in", nonTerminalRunStatuses)
          .execute();
        if (current.some((run) => !reserved.some((row) => row.id === run.id)))
          throw new TransactionScopeChanged();
        const parent = reserved.find((run) => run.id === observed.parentRunId);
        const child = reserved.find((run) => run.id === observed.resultRunId);
        const original = reserved.find((run) => run.id === observed.childRunId);
        if (
          !parent ||
          !child ||
          !original ||
          child.threadId !== observed.childThreadId ||
          child.assignmentId !== assignmentId ||
          !["completed", "failed"].includes(child.status)
        )
          admissionUnavailable("assignment-result-unavailable");
        const rootsMatch =
          isDeepStrictEqual(projectOriginFromRow(parent), projectOriginFromRow(child)) &&
          isDeepStrictEqual(projectOriginFromRow(original), projectOriginFromRow(child)) &&
          child.actorPrincipalId === parent.actorPrincipalId &&
          original.actorPrincipalId === child.actorPrincipalId;
        let refusal =
          !rootsMatch ||
          !(await projectWorkIsCurrent(transaction, parent)) ||
          !(await projectWorkIsCurrent(transaction, child))
            ? "execution-authority-unavailable"
            : null;
        if (child.status === "completed") {
          const grant = await transaction
            .selectFrom("grants")
            .select("id")
            .where("runId", "=", child.id)
            .where("bindingGeneration", "=", child.bindingGeneration)
            .where("status", "=", "active")
            .executeTakeFirst();
          const retained = grant
            ? await readProjectRunBinding(transaction, { runId: child.id, grantId: grant.id })
            : null;
          if (
            !retained ||
            retained.binding.authority.principal.workspaceId !== observed.workspaceId
          )
            refusal = "execution-binding-unavailable";
        }
        if (parent.assignmentId) {
          const task = await transaction
            .selectFrom("delegations")
            .select("status")
            .where("id", "=", parent.assignmentId)
            .executeTakeFirst();
          if (!task || task.status !== "open") refusal = "parent-task-ended";
        }
        if (!observed.resultText) refusal = "no-reply";
        if (!refusal) {
          const snapshot = ProjectRuntimeSnapshotSchema.safeParse(
            parent.authoritySource.projectRuntime,
          );
          if (!snapshot.success) admissionUnavailable("admitted-runtime-snapshot-missing");
          await reserveProjectRuntime(
            transaction,
            observed.workspaceId,
            projectOriginFromRow(parent),
            this.dependencies.runnerIsConnected,
            snapshot.data,
            [child.harnessInstanceId],
          );
        }
        const thread = await transaction
          .selectFrom("threads")
          .selectAll()
          .where("id", "=", parent.threadId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        await transaction
          .selectFrom("causalChains")
          .select("id")
          .where("id", "=", parent.causalChainId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        const assignments = await transaction
          .selectFrom("delegations")
          .selectAll()
          .where((expression) =>
            expression.or([
              expression("id", "=", assignmentId),
              expression.and([
                expression("childThreadId", "=", parent.threadId),
                expression("status", "=", "open"),
              ]),
            ]),
          )
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const row = assignments.find((item) => item.id === assignmentId);
        if (!row || row.resultStatus !== "pending" || row.status === "open")
          return { state: "settled" as const, events: [] as AgentEvent[] };
        const now = new Date();
        if (refusal) {
          const stopped = await transaction
            .updateTable("delegations")
            .set((expression) => ({
              resultStatus: "undeliverable",
              resultReason: refusal,
              completedAt: now,
              resultAttemptedAt: now,
              updatedAt: now,
              revision: expression("revision", "+", 1),
            }))
            .where("id", "=", row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          return {
            state: "undeliverable" as const,
            events: await projectAssignmentEventsInTransaction(
              transaction,
              stopped,
              "assignment.updated",
            ),
          };
        }
        if (thread.status === "archived") admissionUnavailable("thread-unavailable");
        const admitted = await this.admitInTransaction(transaction, {
          threadId: parent.threadId,
          origin: projectOriginFromRow(parent),
          source: {
            kind: "platform",
            cause: "assignment-result",
            referenceId: row.id,
            sourceRunId: parent.id,
          },
          content: [{ type: "text", text: row.resultText ?? "" }],
          policy: "queue",
          idempotencyKey: `assignment:${row.id}:result`,
        });
        const delivered = await transaction
          .updateTable("delegations")
          .set((expression) => ({
            resultStatus: "delivered",
            resultMessageId: admitted.input.messageId,
            resultReason: null,
            completedAt: now,
            resultAttemptedAt: now,
            updatedAt: now,
            revision: expression("revision", "+", 1),
          }))
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          state: "delivered" as const,
          events: [
            ...admitted.events,
            ...(await projectAssignmentEventsInTransaction(
              transaction,
              delivered,
              "assignment.updated",
            )),
          ],
        };
      },
      undefined,
      (error) => error instanceof TransactionScopeChanged,
    );
  }

  async delegateProjectWork(input: {
    readonly binding: ProjectRunBinding;
    readonly title: string;
    readonly content: readonly ContentPart[];
    readonly idempotencyKey: string;
  }) {
    const binding = ProjectRunBindingSchema.parse(input.binding);
    if (binding.authority.origin === null)
      throw new OpensteerError({
        code: "conflict",
        reason: "creatorless-tasks-not-supported",
        message: "Creatorless tasks are not supported yet",
      });
    const title = z.string().trim().min(1).max(240).parse(input.title);
    const content = MessageContentSchema.parse(input.content);
    z.uuid().parse(input.idempotencyKey);
    const fingerprint = createHash("sha256")
      .update(canonicalJson(["project-delegation-v1", binding.authority.principal, title, content]))
      .digest("hex");
    await assertProjectAuthority(this.database);
    return withDatabaseTransaction(
      this.database,
      async (transaction) => {
        const parent = await transaction
          .selectFrom("runs")
          .selectAll()
          .where("id", "=", binding.runId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!parent) admissionUnavailable("source-unavailable");
        await assertActiveProjectBinding(transaction, binding, this.dependencies);
        const origin = projectOriginFromRow(parent);
        if (!origin)
          throw new OpensteerError({
            code: "conflict",
            reason: "creatorless-tasks-not-supported",
            message: "Creatorless tasks are not supported yet",
          });
        const prior = await transaction
          .selectFrom("agentControlRequests")
          .selectAll()
          .where("runId", "=", parent.id)
          .where("requestId", "=", input.idempotencyKey)
          .forShare()
          .executeTakeFirst();
        if (prior) {
          if (
            prior.action !== "thread.delegate" ||
            prior.requestFingerprint !== fingerprint ||
            !prior.resultMessageId
          )
            admissionUnavailable("idempotency-conflict");
          const child = await transaction
            .selectFrom("delegations")
            .select(["id", "childThreadId", "childRunId"])
            .where("initialInputMessageId", "=", prior.resultMessageId)
            .executeTakeFirstOrThrow();
          return {
            threadId: child.childThreadId,
            assignmentId: child.id,
            runId: child.childRunId,
            events: [] as AgentEvent[],
            wasDuplicate: true,
          };
        }
        await lockWorkspaceRow(transaction, binding.workspaceId);
        const { environmentId, snapshot, principalId } = await reserveProjectRuntime(
          transaction,
          binding.workspaceId,
          origin,
          this.dependencies.runnerIsConnected,
          undefined,
          [parent.harnessInstanceId],
        );
        await assertActiveProjectBinding(transaction, binding, this.dependencies);
        const parentThread = await transaction
          .selectFrom("threads")
          .selectAll()
          .where("id", "=", binding.threadId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        const depth = await sql<{ depth: string }>`with recursive lineage as (
        select id,parent_thread_id,1 as depth from threads where id = ${parentThread.id}
        union all select t.id,t.parent_thread_id,l.depth+1 from threads t join lineage l on l.parent_thread_id=t.id where l.depth <= ${agentDelegationMaxDepth}
      ) select max(depth)::text as depth from lineage`.execute(transaction);
        if (Number(depth.rows[0]?.depth) >= agentDelegationMaxDepth)
          admissionUnavailable("delegation-depth-exhausted");
        const budget = await transaction
          .updateTable("causalChains")
          .set((expression) => ({ usedDelegations: expression("usedDelegations", "+", 1) }))
          .where("id", "=", parent.causalChainId)
          .whereRef("usedDelegations", "<", "maxDelegations")
          .returning("id")
          .executeTakeFirst();
        if (!budget) admissionUnavailable("delegation-budget-exhausted");
        const threadId = createId("thread");
        const now = new Date();
        const childRow = await transaction
          .insertInto("threads")
          .values({
            id: threadId,
            lineageRootThreadId: parentThread.lineageRootThreadId,
            workspaceId: binding.workspaceId,
            parentThreadId: parentThread.id,
            createdBy: origin.userId,
            createdByPrincipalId: principalId,
            environmentId: environmentId,
            harnessInstanceId: snapshot.harnessInstanceId,
            modelSelection: jsonValue(snapshot.modelSelection),
            accessMode: snapshot.accessMode,
            status: "idle",
            title,
            listed: true,
            inheritsMain: false,
            role: "work",
            icon: null,
            iconSource: "provisional",
            color: parentThread.color,
            askedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const createdEvent = await appendHostWorkspaceEvent(transaction, {
          type: "thread.created",
          data: {
            thread: threadFromRow({
              ...childRow,
              providerSessionId: null,
              continuationIdentity: null,
              pendingRequests: 0,
            }),
          },
          environmentId: childRow.environmentId,
          workspaceId: childRow.workspaceId,
          threadId: childRow.id,
          runId: null,
        });
        const assignmentId = createId("delegation");
        const admitted = await this.admitInTransaction(
          transaction,
          {
            threadId,
            origin,
            source: { kind: "agent", runId: parent.id },
            content,
            policy: "queue",
            idempotencyKey: input.idempotencyKey,
          },
          {
            id: assignmentId,
            causalChainId: parent.causalChainId,
            parentRunId: parent.id,
            replyTarget:
              parent.replyTarget === null ? null : ReplyTargetSchema.parse(parent.replyTarget),
          },
        );
        if (!admitted.runId) admissionUnavailable("delegation-run-unavailable");
        const assignment = await transaction
          .insertInto("delegations")
          .values({
            id: assignmentId,
            parentThreadId: parent.threadId,
            parentRunId: parent.id,
            parentOccurrenceId: null,
            parentWatchActivationId: null,
            parentAssignmentId: parent.assignmentId,
            childThreadId: threadId,
            childRunId: admitted.runId,
            initialInputMessageId: admitted.input.messageId,
            objective: title,
            origin: "run",
            status: "open",
            finishedAt: null,
            replyTarget: parent.replyTarget === null ? null : jsonValue(parent.replyTarget),
            resultAttemptedAt: null,
            resultMessageId: null,
            resultReason: null,
            resultRunId: null,
            resultStatus: "pending",
            resultText: null,
            completedAt: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("agentControlRequests")
          .values({
            runId: parent.id,
            requestId: input.idempotencyKey,
            sourceThreadId: parent.threadId,
            action: "thread.delegate",
            actionClass: "thread.delegate",
            requestFingerprint: fingerprint,
            resultMessageId: admitted.input.messageId,
          })
          .execute();
        return {
          threadId,
          assignmentId,
          runId: admitted.runId,
          events: [
            createdEvent,
            ...admitted.events,
            ...(await projectAssignmentEventsInTransaction(
              transaction,
              assignment,
              "assignment.created",
            )),
          ],
          wasDuplicate: false,
        };
      },
      undefined,
      (error) => error instanceof TransactionScopeChanged,
    );
  }

  /** Caller-owned transactions reserve source Runs and target Runs before their Workspace set. */
  async admitInTransaction(
    transaction: Transaction<DatabaseSchema>,
    input: ProjectWorkAdmission,
    assignment?: {
      readonly id: AssignmentId;
      readonly causalChainId: CausalChainId;
      readonly parentRunId: RunId;
      readonly replyTarget: ReplyTarget | null;
    },
  ) {
    ProjectWorkAdmissionSchema.parse(input);
    await assertProjectAuthority(transaction);
    let origin = HumanRootSchema.nullable().parse(input.origin);
    const source = ProjectInputSourceSchema.parse(input.source);
    const content = MessageContentSchema.parse(input.content);
    const policy = ThreadInputPolicySchema.parse(input.policy);
    requireBoundedIdentity(input.idempotencyKey, "Project input identity", 4096);
    if (content.some((part) => part.type !== "text"))
      admissionUnavailable("input-publication-not-supported");
    if ((source.kind === "human" || source.kind === "connection") && !origin)
      admissionUnavailable("captured-root-unavailable");
    if (source.kind === "human" && origin?.originConnectionId !== null)
      admissionUnavailable("source-origin-mismatch");
    let connectionScope: WorkspaceId | undefined;
    if (source.kind === "connection") {
      if (!origin || origin.originConnectionId !== source.connectionId)
        admissionUnavailable("source-origin-mismatch");
      const connection = await transaction
        .selectFrom("agentConnections")
        .select(["id", "workspaceId"])
        .where("id", "=", source.connectionId)
        .where("userId", "=", origin.userId)
        .where("memberGeneration", "=", String(origin.initiatorGeneration))
        .where("membershipGeneration", "=", String(origin.membershipGeneration))
        .where("revokedAt", "is", null)
        .forShare()
        .executeTakeFirst();
      if (!connection || !connection.workspaceId) admissionUnavailable("captured-root-unavailable");
      connectionScope = connection.workspaceId ?? undefined;
    }
    const parentId =
      source.kind === "agent"
        ? source.runId
        : source.kind === "platform"
          ? source.sourceRunId
          : null;
    const observedParent = parentId
      ? await transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .select(["runs.id", "threads.workspaceId"])
          .where("runs.id", "=", parentId)
          .executeTakeFirst()
      : null;
    if (parentId && !observedParent) admissionUnavailable("source-unavailable");
    const program =
      source.kind === "trigger"
        ? await transaction
            .selectFrom("triggerOccurrences")
            .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
            .select([
              "triggerOccurrences.id",
              "triggerOccurrences.executionGeneration",
              "triggerOccurrences.causalChainId",
              "triggers.workspaceId",
              "triggers.anchorThreadId",
            ])
            .where("triggerOccurrences.id", "=", source.occurrenceId)
            .executeTakeFirst()
        : source.kind === "watch"
          ? await transaction
              .selectFrom("triggerWatchActivations")
              .select(["id", "executionGeneration", "workspaceId", "anchorThreadId"])
              .where("id", "=", source.activationId)
              .where("triggerId", "=", source.triggerId)
              .where("revisionId", "=", source.revisionId)
              .executeTakeFirst()
          : null;
    if (
      (source.kind === "trigger" || source.kind === "watch") &&
      (!program ||
        origin ||
        String(program.executionGeneration) !== String(source.executionGeneration) ||
        program.anchorThreadId !== input.threadId)
    )
      admissionUnavailable("source-unavailable");
    const scope = observedParent?.workspaceId ?? program?.workspaceId ?? connectionScope;
    const observed = origin
      ? await transaction
          .selectFrom("threads")
          .innerJoin(
            "workspaceMemberships",
            "workspaceMemberships.workspaceId",
            "threads.workspaceId",
          )
          .innerJoin("users", "users.id", "workspaceMemberships.userId")
          .select("threads.workspaceId")
          .where("threads.id", "=", input.threadId)
          .where("users.id", "=", origin.userId)
          .where("users.authorityGeneration", "=", String(origin.initiatorGeneration))
          .where("users.admittedAt", "is not", null)
          .where("users.memberState", "=", "active")
          .where("users.disabledAt", "is", null)
          .where("workspaceMemberships.state", "=", "active")
          .where("workspaceMemberships.generation", "=", String(origin.membershipGeneration))
          .$call((query) =>
            scope === undefined ? query : query.where("threads.workspaceId", "=", scope),
          )
          .executeTakeFirst()
      : scope
        ? await transaction
            .selectFrom("threads")
            .select("workspaceId")
            .where("id", "=", input.threadId)
            .where("workspaceId", "=", scope)
            .executeTakeFirst()
        : null;
    if (!observed) admissionUnavailable("captured-root-unavailable");
    const observedRuns = await transaction
      .selectFrom("runs")
      .selectAll()
      .where((expression) =>
        expression.or([
          expression.and([
            expression("threadId", "=", input.threadId),
            expression("status", "in", nonTerminalRunStatuses),
          ]),
          ...(parentId ? [expression("id", "=", parentId)] : []),
        ]),
      )
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    if (source.kind === "trigger") {
      const occurrence = await transaction
        .selectFrom("triggerOccurrences")
        .select("id")
        .where("id", "=", source.occurrenceId)
        .where("executionGeneration", "=", source.executionGeneration)
        .forShare()
        .executeTakeFirst();
      if (!occurrence) admissionUnavailable("source-unavailable");
    }
    const parent = parentId ? observedRuns.find((run) => run.id === parentId) : null;
    if (
      parentId &&
      (!parent ||
        !isDeepStrictEqual(projectOriginFromRow(parent), origin) ||
        !(await projectWorkIsCurrent(transaction, parent)))
    )
      admissionUnavailable("source-origin-mismatch");
    if (parent) origin = projectOriginFromRow(parent);
    if (assignment && assignment.parentRunId !== parent?.id)
      admissionUnavailable("assignment-source-mismatch");
    await lockWorkspaceRow(transaction, observed.workspaceId);
    const steerTarget =
      policy === "steer"
        ? observedRuns.find(
            (run) =>
              run.threadId === input.threadId &&
              ["starting", "running", "waiting"].includes(run.status),
          )
        : undefined;
    if (policy === "steer" && !steerTarget) admissionUnavailable("no-active-project-exchange");
    const inheritedRuntime = steerTarget
      ? ProjectRuntimeSnapshotSchema.safeParse(steerTarget.authoritySource.projectRuntime)
      : source.kind === "platform" && parent
        ? ProjectRuntimeSnapshotSchema.safeParse(parent.authoritySource.projectRuntime)
        : null;
    if (inheritedRuntime && !inheritedRuntime.success)
      admissionUnavailable("admitted-runtime-snapshot-missing");
    const { environmentId, snapshot, principalId } = await reserveProjectRuntime(
      transaction,
      observed.workspaceId,
      origin,
      this.dependencies.runnerIsConnected,
      inheritedRuntime?.success ? inheritedRuntime.data : undefined,
      parent ? [parent.harnessInstanceId] : [],
    );
    const senderPrincipalId =
      (source.kind === "human" || source.kind === "connection") && origin
        ? await principalIdForUser(transaction, origin.userId)
        : principalId;
    const thread = await transaction
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", input.threadId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (
      thread.workspaceId !== observed.workspaceId ||
      thread.environmentId !== environmentId ||
      thread.status === "archived"
    )
      admissionUnavailable("thread-unavailable");
    const currentRuns = await transaction
      .selectFrom("runs")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("status", "in", nonTerminalRunStatuses)
      .orderBy("runOrdinal")
      .execute();
    if (currentRuns.some((run) => !observedRuns.some((reserved) => reserved.id === run.id)))
      throw new TransactionScopeChanged();
    let sourceIdentity: Readonly<Record<string, unknown>>;
    let author: MessageAuthor;
    if (parent) {
      const {
        projectRuntime: _runtime,
        parentRunId: _parent,
        ...identity
      } = parent.authoritySource;
      sourceIdentity = { ...identity, parentRunId: parent.id };
      author =
        source.kind === "platform"
          ? {
              kind: "platform",
              cause: source.cause,
              ...(source.referenceId ? { referenceId: source.referenceId } : {}),
            }
          : {
              kind: "agent",
              runId: parent.id,
              threadId: parent.threadId,
              workspaceId: thread.workspaceId,
              workspaceName: (
                await transaction
                  .selectFrom("workspaces")
                  .select("name")
                  .where("id", "=", thread.workspaceId)
                  .executeTakeFirstOrThrow()
              ).name,
              displayName: thread.title,
            };
    } else if (source.kind === "trigger" && program) {
      sourceIdentity = {
        kind: "trigger-occurrence",
        occurrenceId: source.occurrenceId,
        incarnation: String(program.executionGeneration),
      };
      const trigger = await transaction
        .selectFrom("triggerOccurrences")
        .select(["triggerId", "event"])
        .where("id", "=", source.occurrenceId)
        .executeTakeFirstOrThrow();
      author = {
        kind: "trigger",
        displayName: "Project Trigger",
        occurrenceId: source.occurrenceId,
        triggerId: trigger.triggerId,
        source: trigger.event.source.kind,
      };
    } else if (source.kind === "watch" && program) {
      const activation = await transaction
        .selectFrom("triggerWatchActivations")
        .select(["executionGeneration", "desired"])
        .where("id", "=", source.activationId)
        .forShare()
        .executeTakeFirstOrThrow();
      if (
        activation.executionGeneration !== String(program.executionGeneration) ||
        activation.desired !== "active"
      )
        admissionUnavailable("source-unavailable");
      sourceIdentity = {
        kind: "watch-observation",
        activationId: source.activationId,
        observationId: source.observationId,
        revisionId: source.revisionId,
        triggerId: source.triggerId,
        incarnation: String(activation.executionGeneration),
      };
      author = {
        kind: "watch",
        displayName: "Project Watch",
        activationId: source.activationId,
        revisionId: source.revisionId,
        triggerId: source.triggerId,
      };
    } else if (origin && (source.kind === "human" || source.kind === "connection")) {
      sourceIdentity =
        source.kind === "human"
          ? { kind: "workspace-membership", userId: origin.userId }
          : { kind: "connection", userId: origin.userId, connectionId: source.connectionId };
      const user = await transaction
        .selectFrom("users")
        .select("displayName")
        .where("id", "=", origin.userId)
        .executeTakeFirstOrThrow();
      author =
        source.kind === "human"
          ? {
              kind: "human",
              userId: origin.userId,
              principalId: senderPrincipalId,
              displayName: user.displayName,
            }
          : {
              kind: "connection",
              connectionId: source.connectionId,
              displayName: user.displayName,
            };
    } else return admissionUnavailable("source-unavailable");
    const baseExchange = projectExchangeFromRow(
      {
        threadId: thread.id,
        actorPrincipalId: principalId,
        requestedBy: origin?.userId ?? null,
        membershipGeneration: origin ? String(origin.membershipGeneration) : null,
        initiatorGeneration: origin ? String(origin.initiatorGeneration) : null,
        originConnectionId: origin?.originConnectionId ?? null,
        authoritySource: sourceIdentity,
        assignmentId: null,
        replyTarget: null,
      },
      thread.workspaceId,
    );
    const openAssignment = await transaction
      .selectFrom("delegations")
      .innerJoin("runs", "runs.id", "delegations.childRunId")
      .selectAll("runs")
      .select([
        "delegations.id as activeAssignmentId",
        "delegations.replyTarget as assignmentReplyTarget",
      ])
      .where("delegations.childThreadId", "=", thread.id)
      .where("delegations.status", "=", "open")
      .executeTakeFirst();
    const sameAssignmentRoot =
      openAssignment &&
      projectExchangeKey({
        ...projectExchangeFromRow(openAssignment, thread.workspaceId),
        assignmentId: null,
        replyTarget: null,
      }) === projectExchangeKey(baseExchange);
    const assignmentId =
      assignment?.id ?? (sameAssignmentRoot ? openAssignment.activeAssignmentId : null);
    const replyTarget =
      assignment?.replyTarget ??
      (sameAssignmentRoot && openAssignment.assignmentReplyTarget
        ? ReplyTargetSchema.parse(openAssignment.assignmentReplyTarget)
        : null);
    if (replyTarget !== null) admissionUnavailable("channel-replies-not-supported");
    const exchangeKey = projectExchangeKey({ ...baseExchange, assignmentId, replyTarget });
    const idempotencyKey = `project-input:${createHash("sha256")
      .update(canonicalJson([exchangeKey, input.idempotencyKey]))
      .digest("hex")}`;
    const fingerprint = createHash("sha256")
      .update(canonicalJson([exchangeKey, input.source, content, policy]))
      .digest("hex");
    const existing = await transaction
      .selectFrom("threadInputs")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("actorPrincipalId", "=", principalId)
      .where("idempotencyKey", "=", idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw new OpensteerError({
          code: "conflict",
          reason: "idempotency-conflict",
          message: "Project input identity was reused with different content",
        });
      const original = await transaction
        .selectFrom("runs")
        .leftJoin("commands", "commands.runId", "runs.id")
        .select(["runs.id", "commands.id as commandId"])
        .where("runs.seedInputId", "=", existing.messageId)
        .where("commands.type", "=", "run.execute.project")
        .executeTakeFirst();
      return {
        input: threadInputFromRow(existing),
        runId: existing.runId ?? original?.id ?? null,
        commandId: existing.steerCommandId ?? original?.commandId ?? null,
        events: [] as AgentEvent[],
        wasDuplicate: true,
      };
    }
    let steerBinding: import("@opensteer/core").ProjectRunBinding | null = null;
    if (policy === "steer") {
      if (
        !steerTarget ||
        projectExchangeKey(projectExchangeFromRow(steerTarget, thread.workspaceId)) !== exchangeKey
      )
        admissionUnavailable("steer-exchange-mismatch");
      const grant = await transaction
        .selectFrom("grants")
        .select("id")
        .where("runId", "=", steerTarget.id)
        .where("bindingGeneration", "=", steerTarget.bindingGeneration)
        .where("status", "=", "active")
        .executeTakeFirst();
      const original = grant
        ? await readProjectRunBinding(transaction, { runId: steerTarget.id, grantId: grant.id })
        : null;
      if (!original) admissionUnavailable("steer-binding-unavailable");
      await assertActiveProjectBinding(transaction, original.binding, this.dependencies);
      steerBinding = original.binding;
    }
    await assertThreadInputCapacity(
      transaction,
      thread.id,
      Buffer.byteLength(JSON.stringify(content)),
      policy,
    );
    const authoritySource = { ...sourceIdentity, projectRuntime: snapshot };
    const root = {
      actorPrincipalId: principalId,
      requestedBy: origin?.userId ?? null,
      membershipGeneration: origin?.membershipGeneration ?? null,
      initiatorGeneration: origin?.initiatorGeneration ?? null,
      originConnectionId: origin?.originConnectionId ?? null,
      authoritySource: jsonValue(authoritySource),
    };
    if (
      thread.harnessInstanceId !== snapshot.harnessInstanceId ||
      !isDeepStrictEqual(thread.modelSelection, snapshot.modelSelection)
    )
      await transaction
        .updateTable("threads")
        .set({
          harnessInstanceId: snapshot.harnessInstanceId,
          modelSelection: jsonValue(snapshot.modelSelection),
          accessMode: snapshot.accessMode,
        })
        .where("id", "=", thread.id)
        .execute();
    const messageId = createId("message");
    const causalChainId =
      steerTarget?.causalChainId ??
      assignment?.causalChainId ??
      (sameAssignmentRoot ? openAssignment.causalChainId : null) ??
      parent?.causalChainId ??
      createId("causalChain");
    if (!steerTarget && !parent && !sameAssignmentRoot)
      await transaction
        .insertInto("causalChains")
        .values({
          id: causalChainId,
          rootMessageId: messageId,
          rootOccurrenceId: null,
          maxDelegations: causalChainMaxDelegations,
          maxAutonomousRuns: causalChainMaxAutonomousRuns,
          usedDelegations: 0,
          usedAutonomousRuns: 0,
          createdAt: new Date(),
        })
        .execute();
    await transaction
      .selectFrom("delegations")
      .select("id")
      .where("childThreadId", "=", thread.id)
      .where("status", "=", "open")
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    const now = new Date();
    const message = await transaction
      .insertInto("messages")
      .values({
        id: messageId,
        threadId: thread.id,
        runId: steerBinding?.runId ?? null,
        sequence: thread.nextMessageSequence,
        actorPrincipalId: senderPrincipalId,
        kind: source.kind === "platform" ? "continuation" : "input",
        author: jsonValue(author),
        content: jsonValue(content),
        createdAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const steer = steerBinding
      ? await new ProjectExecutionStore().enqueueCommand(transaction, {
          binding: steerBinding,
          idempotencyKey: `steer:${messageId}`,
          control: {
            kind: "run.steer",
            input: HarnessInputSchema.parse({
              author: message.author,
              content: message.content,
              createdAt: message.createdAt.toISOString(),
              kind: message.kind,
              messageId: message.id,
            }),
          },
        })
      : null;
    const receipt = await transaction
      .insertInto("threadInputs")
      .values({
        ...root,
        messageId,
        threadId: thread.id,
        causalChainId,
        assignmentId,
        cancelReason: null,
        deliveredAt: null,
        idempotencyKey,
        policy,
        queueRank: thread.nextMessageSequence,
        replyTarget: replyTarget ? jsonValue(replyTarget) : null,
        requestFingerprint: fingerprint,
        runId: steerBinding?.runId ?? null,
        state: steerBinding ? "claimed" : "pending",
        steerCommandId: steer?.commandId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const messageEvent = await appendHostWorkspaceEvent(transaction, {
      type: "message.created",
      data: { message: messageFromRow(message), input: threadInputFromRow(receipt) },
      environmentId: thread.environmentId,
      threadId: thread.id,
      runId: steerBinding?.runId ?? null,
      workspaceId: thread.workspaceId,
    });
    const events: AgentEvent[] = [messageEvent];
    let runId: RunId | null = steerBinding?.runId ?? null;
    let commandId: CommandId | null = steer?.commandId ?? null;
    const queued = currentRuns.find((run) => run.status === "queued");
    if (!steerBinding && policy !== "report" && !queued) {
      const queued = await queueProjectRun(transaction, thread, receipt, snapshot);
      runId = queued.run.id;
      commandId = queued.commandId;
      events.push(...queued.events);
    }
    await transaction
      .updateTable("threads")
      .set({ nextMessageSequence: sql<string>`next_message_sequence + 1`, updatedAt: now })
      .where("id", "=", thread.id)
      .execute();
    if (origin) await fenceProjectHumanRoot(transaction, origin);
    return {
      input: threadInputFromRow(receipt),
      runId,
      commandId,
      events: [...events, ...(await projectThreadState(transaction, thread.id))],
      wasDuplicate: false,
    };
  }
}
