import { projectWorkIsCurrent, assertActiveProjectBinding } from "./execution-authority.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  createId,
  HumanRootSchema,
  ProjectRunBindingSchema,
  RunIdSchema,
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
  HarnessInstanceIdSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  TimeZoneSchema,
  MessageContentSchema,
  ThreadInputPolicySchema,
  nonTerminalRunStatuses,
  causalChainMaxDelegations,
  causalChainMaxAutonomousRuns,
  type ThreadId,
  type RunId,
  type CommandId,
  type HumanRoot,
  type ContentPart,
  type ThreadInputPolicy,
  type RunnerId,
  type AgentEvent,
} from "@opensteer/core";
import type { RunRow } from "./schema.js";
import type { ThreadInputSource } from "./thread-store.js";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { TransactionScopeChanged, withDatabaseTransaction } from "./connection.js";
import { resolveProjectRuntime } from "./project-runtime-settings-store.js";
import {
  jsonValue,
  lockWorkspaceRow,
  principalIdForUser,
  requireBoundedIdentity,
} from "./store-primitives.js";
import {
  threadInputFromRow,
  messageFromRow,
  threadRunQueueEntryFromRow,
  threadFromRow,
} from "./thread-row-mappers.js";
import { assignmentEventsInTransaction } from "./assignment-store.js";
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

export const ProjectRuntimeSnapshotSchema = z.strictObject({
  settingsRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  harnessInstanceId: HarnessInstanceIdSchema,
  modelSelection: ModelSelectionSchema,
  accessMode: ThreadAccessModeSchema,
  instructions: z.string(),
  timeZone: TimeZoneSchema,
});
export type ProjectRuntimeSnapshot = z.infer<typeof ProjectRuntimeSnapshotSchema>;

export function projectOriginFromRow(
  row: Pick<
    RunRow,
    "requestedBy" | "membershipGeneration" | "initiatorGeneration" | "originConnectionId"
  >,
): HumanRoot | null {
  if (row.requestedBy === null) {
    if (
      row.membershipGeneration !== null ||
      row.initiatorGeneration !== null ||
      row.originConnectionId !== null
    )
      admissionUnavailable("invalid-root-shape");
    return null;
  }
  return HumanRootSchema.parse({
    userId: row.requestedBy,
    membershipGeneration: Number(row.membershipGeneration),
    initiatorGeneration: Number(row.initiatorGeneration),
    originConnectionId: row.originConnectionId,
  });
}

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

async function reserveProjectRuntime(
  transaction: Transaction<DatabaseSchema>,
  workspaceId: WorkspaceId,
  origin: HumanRoot | null,
  runnerIsConnected: (id: RunnerId) => boolean,
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
  if (origin)
    await transaction
      .selectFrom("workspaceMemberships")
      .select("id")
      .where("workspaceId", "=", workspaceId)
      .where("userId", "=", origin.userId)
      .forShare()
      .executeTakeFirstOrThrow();
  let runtime = await resolveProjectRuntime(transaction, workspaceId, runnerIsConnected);
  if (runtime.state !== "ready") admissionUnavailable(runtime.reason);
  await transaction
    .selectFrom("executionEnvironments")
    .select("id")
    .where("id", "=", runtime.environmentId)
    .forShare()
    .executeTakeFirstOrThrow();
  await transaction
    .selectFrom("harnessInstances")
    .select("id")
    .where("id", "=", runtime.settings.harnessInstanceId)
    .forShare()
    .executeTakeFirstOrThrow();
  await transaction
    .selectFrom("projectRuntimeSettings")
    .select("workspaceId")
    .where("workspaceId", "=", workspaceId)
    .forShare()
    .executeTakeFirstOrThrow();
  runtime = await resolveProjectRuntime(transaction, workspaceId, runnerIsConnected);
  if (runtime.state !== "ready") admissionUnavailable(runtime.reason);
  const principalId = await ensureProjectPrincipal(transaction, workspaceId);
  return { runtime, principalId };
}

export class ProjectWorkStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly dependencies: { readonly runnerIsConnected: (runnerId: RunnerId) => boolean };

  constructor(database: Kysely<DatabaseSchema>, dependencies: ProjectWorkStore["dependencies"]) {
    this.database = database;
    this.dependencies = dependencies;
  }

  async admitProjectWork(input: ProjectWorkAdmission) {
    await assertProjectAuthority(this.database);
    return withDatabaseTransaction(
      this.database,
      (transaction) => this.admitInTransaction(transaction, input),
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
        const { runtime, principalId } = await reserveProjectRuntime(
          transaction,
          binding.workspaceId,
          origin,
          this.dependencies.runnerIsConnected,
        );
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
            environmentId: runtime.environmentId,
            harnessInstanceId: runtime.settings.harnessInstanceId,
            modelSelection: jsonValue(runtime.settings.modelSelection),
            accessMode: runtime.settings.accessMode,
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
            ...(await assignmentEventsInTransaction(transaction, assignment, "assignment.created")),
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
    const { runtime, principalId } = await reserveProjectRuntime(
      transaction,
      observed.workspaceId,
      origin,
      this.dependencies.runnerIsConnected,
    );
    const humanPrincipalId =
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
      thread.environmentId !== runtime.environmentId ||
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
              principalId: humanPrincipalId,
              displayName: user.displayName,
            }
          : {
              kind: "connection",
              connectionId: source.connectionId,
              displayName: user.displayName,
            };
    } else return admissionUnavailable("source-unavailable");
    const exchangeKey = projectExchangeKey(
      projectExchangeFromRow(
        {
          threadId: thread.id,
          actorPrincipalId: principalId,
          requestedBy: origin?.userId ?? null,
          membershipGeneration: origin ? String(origin.membershipGeneration) : null,
          initiatorGeneration: origin ? String(origin.initiatorGeneration) : null,
          originConnectionId: origin?.originConnectionId ?? null,
          authoritySource: sourceIdentity,
          assignmentId: assignment?.id ?? null,
          replyTarget: assignment?.replyTarget ?? null,
        },
        thread.workspaceId,
      ),
    );
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
    if (policy === "steer") admissionUnavailable("steering-not-supported");
    await assertThreadInputCapacity(
      transaction,
      thread.id,
      Buffer.byteLength(JSON.stringify(content)),
      policy,
    );
    const snapshot = ProjectRuntimeSnapshotSchema.parse({
      settingsRevision: runtime.settings.revision,
      harnessInstanceId: runtime.settings.harnessInstanceId,
      modelSelection: runtime.settings.modelSelection,
      accessMode: runtime.settings.accessMode,
      instructions: runtime.settings.instructions,
      timeZone: runtime.settings.timeZone,
    });
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
      assignment?.causalChainId ?? parent?.causalChainId ?? createId("causalChain");
    if (!parent)
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
    if (parent && policy !== "report" && !currentRuns.some((run) => run.status === "queued")) {
      const budget = await transaction
        .updateTable("causalChains")
        .set((expression) => ({ usedAutonomousRuns: expression("usedAutonomousRuns", "+", 1) }))
        .where("id", "=", causalChainId)
        .whereRef("usedAutonomousRuns", "<", "maxAutonomousRuns")
        .returning("id")
        .executeTakeFirst();
      if (!budget) admissionUnavailable("autonomous-run-budget-exhausted");
    }
    const now = new Date();
    const message = await transaction
      .insertInto("messages")
      .values({
        id: messageId,
        threadId: thread.id,
        runId: null,
        sequence: thread.nextMessageSequence,
        actorPrincipalId: humanPrincipalId,
        kind: "input",
        author: jsonValue(author),
        content: jsonValue(content),
        createdAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const receipt = await transaction
      .insertInto("threadInputs")
      .values({
        ...root,
        messageId,
        threadId: thread.id,
        causalChainId,
        assignmentId: assignment?.id ?? null,
        cancelReason: null,
        deliveredAt: null,
        idempotencyKey,
        policy: policy === "report" ? "report" : "queue",
        queueRank: thread.nextMessageSequence,
        replyTarget: assignment?.replyTarget ? jsonValue(assignment.replyTarget) : null,
        requestFingerprint: fingerprint,
        runId: null,
        state: "pending",
        steerCommandId: null,
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
      runId: null,
      workspaceId: thread.workspaceId,
    });
    const events: AgentEvent[] = [messageEvent];
    let runId: RunId | null = null;
    let commandId: CommandId | null = null;
    const queued = currentRuns.find((run) => run.status === "queued");
    if (policy !== "report" && !queued) {
      runId = createId("run");
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
          environmentId: runtime.environmentId,
          harnessInstanceId: snapshot.harnessInstanceId,
          modelSelection: jsonValue(snapshot.modelSelection),
          accessMode: snapshot.accessMode,
          activationInputId: messageId,
          seedInputId: messageId,
          assignmentId: assignment?.id ?? null,
          causalChainId,
          providerSessionId,
          replyTarget: assignment?.replyTarget ? jsonValue(assignment.replyTarget) : null,
          runOrdinal: thread.nextRunOrdinal,
          status: "queued",
          startedAt: null,
          completedAt: null,
          createdAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      commandId = createId("command");
      await transaction
        .insertInto("commands")
        .values({
          ...root,
          id: commandId,
          threadId: thread.id,
          environmentId: runtime.environmentId,
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
    }
    await transaction
      .updateTable("threads")
      .set({ nextMessageSequence: sql<string>`next_message_sequence + 1`, updatedAt: now })
      .where("id", "=", thread.id)
      .execute();
    if (origin)
      await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", origin.userId)
        .where("authorityGeneration", "=", String(origin.initiatorGeneration))
        .where("memberState", "=", "active")
        .where("admittedAt", "is not", null)
        .where("disabledAt", "is", null)
        .forShare()
        .executeTakeFirstOrThrow();
    return {
      input: threadInputFromRow(receipt),
      runId,
      commandId,
      events: [...events, ...(await projectThreadState(transaction, thread.id))],
      wasDuplicate: false,
    };
  }
}
