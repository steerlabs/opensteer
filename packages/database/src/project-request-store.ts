import { readableThreadsForOwner } from "./thread-store.js";
import { decodeRequestCursor, heldAssignments, requestPage } from "./request-store.js";
import { isDeepStrictEqual } from "node:util";
import {
  AuthSessionIdSchema,
  HumanRootSchema,
  OpensteerError,
  ProjectEngineRequestEventSchema,
  ProjectEngineRequestSchema,
  ProjectEngineResponseSchema,
  ProjectRunBindingSchema,
  projectRequestAudience,
  requestOptionDeclines,
  type HumanRoot,
  type ProjectEngineRequestEvent,
  type ProjectEngineResponse,
  type ProjectPendingEngineRequest,
  type ProjectRunBinding,
  type GrantId,
  type AgentEvent,
  type RequestId,
  type RunId,
  type UserId,
  type WorkspaceId,
  type ThreadId,
  type RequestView,
  type ThreadRequestWaits,
  type ThreadRequestOutcome,
  ThreadRequestWaitsSchema,
  RequestViewSchema,
  PendingRequestViewSchema,
  CanSchema,
  RequestWaitingOnSchema,
  AutomationSourceSchema,
  RequestCancelledForSchema,
  ThreadRequestOutcomesSchema,
  threadRequestFactLimit,
} from "@opensteer/core";
import type { ProjectRunControl, PendingAgentEvent } from "@opensteer/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { requestFromRow, requestOriginEnvironment } from "./request-persistence.js";
import { assertRequestResponse } from "./command-store.js";
import { assertActiveProjectBinding, projectWorkIsCurrent } from "./execution-authority.js";
import { checkAccess } from "./access-store.js";
import {
  storedProjectDeployment,
  assertProjectAuthority,
} from "./deployment-execution-authority.js";
import { lockRequestWorkspaces } from "./request-workspace-locks.js";
import { requestSettlementActor } from "./request-settlement.js";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import {
  threadFromRow,
  threadPendingRequestsSelection,
  threadProviderSessionSelection,
  threadContinuationIdentitySelection,
} from "./thread-row-mappers.js";

import {
  ProjectExecutionStore,
  type ProjectRequestControlPort,
} from "./project-execution-store.js";

export type ProjectRequestRevocationRoot =
  | { readonly kind: "member"; readonly userId: UserId; readonly memberGenerationCutoff: number }
  | {
      readonly kind: "membership";
      readonly userId: UserId;
      readonly workspaceId: WorkspaceId;
      readonly membershipGenerationCutoff: number;
    }
  | {
      readonly kind: "connection";
      readonly userId: UserId;
      readonly workspaceId: WorkspaceId;
      readonly connectionId: string;
      readonly memberGenerationCutoff: number;
      readonly membershipGenerationCutoff: number;
    };

export interface ProjectRequestCancellation {
  readonly runIds: readonly RunId[];
  readonly events: readonly AgentEvent[];
}

/** E terminalizes waiting work in this transaction and interrupts its Runner after commit. */
export interface ProjectRequestStopPort {
  stop(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly runIds: readonly RunId[];
      readonly reason: "authority-revoked" | "no-eligible-manager";
      readonly requestEvents: readonly AgentEvent[];
    },
  ): Promise<void>;
}

export type ProjectProposalResult =
  | {
      readonly state: "ready";
      readonly request: ProjectPendingEngineRequest;
      readonly replayed: boolean;
      readonly events: readonly AgentEvent[];
    }
  | { readonly state: "settled"; readonly requestId: RequestId }
  | {
      readonly state: "refused";
      readonly control: Extract<ProjectRunControl, { kind: "request.refuse" }>;
    };

function denied(): never {
  throw new OpensteerError({
    code: "forbidden",
    message: "Project Request authority is unavailable",
  });
}
function key(requestId: RequestId, callId: string): string {
  return JSON.stringify(["project-request", requestId, callId]);
}

export async function eligibleProjectRequestManagers(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<readonly UserId[]> {
  await assertProjectAuthority(database);
  const members = await database
    .selectFrom("workspaceMemberships")
    .innerJoin("users", "users.id", "workspaceMemberships.userId")
    .select("users.id")
    .where("workspaceMemberships.workspaceId", "=", workspaceId)
    .where("workspaceMemberships.state", "=", "active")
    .where("users.memberKind", "=", "full")
    .where("users.memberState", "=", "active")
    .where("users.admittedAt", "is not", null)
    .where("users.disabledAt", "is", null)
    .orderBy("users.id")
    .execute();
  const eligible: UserId[] = [];
  for (const member of members) {
    const decision = await checkAccess(database, {
      principal: { kind: "person", userId: member.id },
      callerKind: "person",
      target: { kind: "project", workspaceId },
      action: "manage",
    });
    if (decision.allowed) eligible.push(member.id);
  }
  return eligible;
}

async function storedBinding(database: Kysely<DatabaseSchema>, grantId: GrantId) {
  const row = await database
    .selectFrom("grants as grant")
    .innerJoin("runs as run", "run.id", "grant.runId")
    .innerJoin("threads as thread", "thread.id", "run.threadId")
    .innerJoin("principals as principal", "principal.id", "run.actorPrincipalId")
    .select([
      "grant.id as grantId",
      "grant.attemptId",
      "grant.bindingGeneration",
      "grant.runnerId",
      "grant.runnerBootId",
      "grant.status as grantStatus",
      "run.id as runId",
      "run.threadId",
      "run.environmentId",
      "run.requestedBy",
      "run.actorPrincipalId",
      "run.authoritySource",
      "run.status as runStatus",
      "run.initiatorGeneration",
      "run.membershipGeneration",
      "run.originConnectionId",
      "run.bindingGeneration as currentBindingGeneration",
      "thread.workspaceId",
      "principal.id as principalId",
      "principal.kind as principalKind",
      "principal.workspaceId as principalWorkspaceId",
    ])
    .where("grant.id", "=", grantId)
    .executeTakeFirst();
  if (!row || row.principalKind !== "project" || row.principalWorkspaceId !== row.workspaceId)
    denied();
  const origin =
    row.requestedBy === null
      ? null
      : HumanRootSchema.parse({
          userId: row.requestedBy,
          initiatorGeneration: Number(row.initiatorGeneration),
          membershipGeneration: Number(row.membershipGeneration),
          originConnectionId: row.originConnectionId,
        });
  const binding = ProjectRunBindingSchema.parse({
    authority: {
      version: 1,
      principal: { kind: "project", workspaceId: row.workspaceId, principalId: row.principalId },
      origin,
    },
    grantId: row.grantId,
    bindingGeneration: row.bindingGeneration,
    runnerId: row.runnerId,
    runnerBootId: row.runnerBootId,
    runId: row.runId,
    threadId: row.threadId,
    environmentId: row.environmentId,
    workspaceId: row.workspaceId,
  });
  return { row, binding, origin };
}

async function liveRoot(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  origin: HumanRoot,
) {
  const access = await checkAccess(database, {
    principal: { kind: "person", userId: origin.userId },
    callerKind: "person",
    target: { kind: "project", workspaceId },
    action: "use",
    expectedMemberGeneration: origin.initiatorGeneration,
    expectedMembershipGeneration: origin.membershipGeneration,
  });
  if (!access.allowed) return false;
  if (origin.originConnectionId === null) return true;
  const connection = await database
    .selectFrom("agentConnections")
    .select("id")
    .where("id", "=", origin.originConnectionId)
    .where("userId", "=", origin.userId)
    .where("revokedAt", "is", null)
    .where("memberGeneration", "=", String(origin.initiatorGeneration))
    .where("membershipGeneration", "=", String(origin.membershipGeneration))
    .where((eb) => eb.or([eb("workspaceId", "is", null), eb("workspaceId", "=", workspaceId)]))
    .executeTakeFirst();
  return !!connection;
}

async function audience(
  database: Kysely<DatabaseSchema>,
  binding: ProjectRunBinding,
): Promise<readonly UserId[]> {
  if (binding.authority.origin)
    return (await liveRoot(database, binding.workspaceId, binding.authority.origin))
      ? [binding.authority.origin.userId]
      : [];
  return eligibleProjectRequestManagers(database, binding.workspaceId);
}

function pending(row: RequestRow): ProjectPendingEngineRequest {
  if (row.status !== "pending" || !row.originatingRunId || !row.originatingGrantId) denied();
  const proposal = ProjectEngineRequestSchema.parse({
    id: row.id,
    callId: row.callId,
    createdAt: row.createdAt.toISOString(),
    mode: row.mode,
    kind: row.kind,
    payload: row.payload,
    presentation: row.presentation,
    requestClass: row.kind === "harness.input" ? "question" : "harness-approval",
    ...(row.originatingNodeId ? { originatingNodeId: row.originatingNodeId } : {}),
  });
  const assignment =
    row.requestedBy === null
      ? { requestedBy: null, requiredActor: "workspace-owner" as const }
      : { requestedBy: row.requestedBy, requiredActor: "requester" as const };
  return {
    ...proposal,
    ...assignment,
    status: "pending",
    cancellationReason: null,
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    originatingRunId: row.originatingRunId,
    originatingOccurrenceId: null,
    originatingGrantId: row.originatingGrantId,
    originatingThreadId: row.originatingThreadId,
    originatingWorkspaceId: row.originatingWorkspaceId,
    targetWorkspaceId: row.targetWorkspaceId,
  };
}

export type ProjectRequestViewFacts = Pick<
  RequestView,
  "answer" | "waitingOn" | "source" | "resolvedByName" | "cancelledFor"
>;

export class ProjectRequestStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly controls: ProjectRequestControlPort;
  constructor(
    database: Kysely<DatabaseSchema>,
    controls: ProjectRequestControlPort = new ProjectExecutionStore(),
  ) {
    this.database = database;
    this.controls = controls;
  }

  async threadFacts(input: { readonly threadIds: readonly ThreadId[]; readonly userId: UserId }) {
    return this.readFacts(input);
  }

  async activityFacts(
    binding: ProjectRunBinding,
    input: { readonly threadId: ThreadId; readonly requestIds: readonly RequestId[] },
    runnerIsAttached: (runnerId: import("@opensteer/core").RunnerId, bootId: string) => boolean,
  ) {
    if (binding.authority.principal.workspaceId !== binding.workspaceId) denied();
    await assertActiveProjectBinding(this.database, binding, { runnerIsAttached });
    if (input.requestIds.length > threadRequestFactLimit)
      throw new OpensteerError({
        code: "conflict",
        reason: "project-request-activity-unavailable",
        message: "Request activity exceeds its bounded fact window",
      });
    return this.readFacts({
      threadIds: [input.threadId],
      workspaceId: binding.workspaceId,
      requestIds: input.requestIds,
    });
  }

  private async readFacts(
    input: {
      readonly threadIds: readonly ThreadId[];
      readonly requestIds?: readonly RequestId[];
    } & (
      | { readonly userId: UserId; readonly workspaceId?: never }
      | { readonly workspaceId: WorkspaceId; readonly userId?: never }
    ),
  ): Promise<
    ReadonlyMap<
      ThreadId,
      {
        readonly requestWaits: ThreadRequestWaits;
        readonly requestOutcomes: readonly ThreadRequestOutcome[];
      }
    >
  > {
    if (!input.threadIds.length) return new Map();
    const result = await sql<{
      threadId: ThreadId;
      requestWaits: unknown;
      requestOutcomes: unknown;
    }>`with visible as materialized (
      select t.id from threads t
      join workspaces w on w.id = t.workspace_id
      ${
        input.userId
          ? sql`join workspace_memberships m on m.workspace_id = w.id and m.user_id = ${input.userId}
      join users u on u.id = m.user_id`
          : sql``
      }
      where t.id in (${sql.join(input.threadIds)}) and ${storedProjectDeployment}
        and w.kind = 'project' and w.deleted_at is null
        and w.status not in ('deleting', 'deleted')
        ${input.userId ? sql`and m.state = 'active' and u.member_state = 'active' and u.admitted_at is not null and u.disabled_at is null` : sql`and w.id = ${input.workspaceId}`}
    ), ranked as (
      select r.id, r.originating_thread_id as thread_id, r.kind, r.status,
        r.created_at, r.resolved_at, r.resolved_by, r.requested_by, r.cancellation_reason,
        count(*) over (partition by r.originating_thread_id, (r.status = 'pending')) as total,
        row_number() over (partition by r.originating_thread_id, (r.status = 'pending')
          order by case when r.status = 'pending' then r.created_at end asc,
            case when r.status <> 'pending' then r.resolved_at end desc,
            case when r.status = 'pending' then r.id end asc, r.id desc) as position
      from requests r join visible v on v.id = r.originating_thread_id
      where r.originating_grant_id is not null
        ${input.requestIds ? sql`and r.id in (${input.requestIds.length ? sql.join(input.requestIds) : sql`null`})` : sql``}
    ), facts as (
      select r.*, case when r.kind = 'harness.input' then 'question' else 'approval' end as class,
        requester.display_name as requester_name, resolver.display_name as resolver_name
      from ranked r
      left join users requester on requester.id = r.requested_by
      left join users resolver on resolver.id = r.resolved_by
      where r.position <= ${threadRequestFactLimit}
    )
    select v.id as thread_id,
      jsonb_build_object('total', coalesce(max(f.total) filter (where f.status = 'pending'), 0),
        'items', coalesce(jsonb_agg(jsonb_build_object(
          'requestId', f.id, 'class', f.class, 'since', f.created_at,
          'waitingOn', case when f.requested_by is null then jsonb_build_object('kind', 'managers')
            else jsonb_build_object('kind', 'person', 'name', f.requester_name) end)
          order by f.position) filter (where f.status = 'pending'), '[]'::jsonb)) as request_waits,
      coalesce(jsonb_agg(case when f.status = 'cancelled' then
        jsonb_build_object('requestId', f.id, 'class', f.class, 'status', f.status,
          'at', f.resolved_at, 'reason', f.cancellation_reason) ||
          case when f.requested_by is not null and
            f.cancellation_reason in ('authority-revoked', 'membership-revoked')
            then jsonb_build_object('cancelledFor', jsonb_build_object('name', f.requester_name))
            else '{}'::jsonb end
        else jsonb_build_object('requestId', f.id, 'class', f.class, 'status', f.status,
          'at', f.resolved_at, 'resolvedByName', f.resolver_name) end order by f.position)
        filter (where f.status <> 'pending'), '[]'::jsonb) as request_outcomes
      from visible v left join facts f on f.thread_id = v.id group by v.id
    `.execute(this.database);
    return new Map(
      result.rows.map((row) => [
        row.threadId,
        {
          requestWaits: ThreadRequestWaitsSchema.parse(row.requestWaits),
          requestOutcomes: ThreadRequestOutcomesSchema.parse(row.requestOutcomes),
        },
      ]),
    );
  }

  /** E calls after authenticating the Runner fence; commit precedes event acknowledgement. */
  async propose(
    transaction: Transaction<DatabaseSchema>,
    input: ProjectEngineRequestEvent,
  ): Promise<ProjectProposalResult> {
    const event = ProjectEngineRequestEventSchema.parse(input);
    await assertProjectAuthority(transaction);
    await transaction
      .selectFrom("runs")
      .select("id")
      .where("id", "=", event.binding.runId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await lockRequestWorkspaces(transaction, [event.binding.workspaceId]);
    const source = await storedBinding(transaction, event.binding.grantId);
    if (!isDeepStrictEqual(source.binding, event.binding)) denied();
    const idempotencyKey = key(event.data.request.id, event.data.request.callId);
    const previous = await this.controls.find(transaction, {
      binding: source.binding,
      idempotencyKey,
    });
    if (previous?.kind === "request.refuse") return { state: "refused", control: previous };
    const existing = await transaction
      .selectFrom("requests")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("id", "=", event.data.request.id),
          eb.and([
            eb("originatingRunId", "=", source.binding.runId),
            eb("callId", "=", event.data.request.callId),
          ]),
        ]),
      )
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (existing) {
      if (
        existing.id !== event.data.request.id ||
        existing.originatingGrantId !== source.binding.grantId ||
        existing.callId !== event.data.request.callId ||
        existing.kind !== event.data.request.kind ||
        !isDeepStrictEqual(existing.presentation, event.data.request.presentation) ||
        !isDeepStrictEqual(existing.payload, event.data.request.payload) ||
        existing.originatingNodeId !== (event.data.request.originatingNodeId ?? null)
      )
        denied();
      if (existing.status !== "pending") return { state: "settled", requestId: existing.id };
      return { state: "ready", request: pending(existing), replayed: true, events: [] };
    }
    const recipients = await audience(transaction, source.binding);
    const decision = projectRequestAudience({
      origin: source.origin,
      requestClass:
        event.data.request.presentation.kind === "form" &&
        event.data.request.presentation.fields.some((field) => field.secret)
          ? "unsupported"
          : event.data.request.requestClass,
      eligibleManagerCount: recipients.length,
    });
    const reason: Extract<ProjectRunControl, { kind: "request.refuse" }>["reason"] | null =
      source.row.grantStatus !== "active" ||
      !["starting", "running", "waiting"].includes(source.row.runStatus) ||
      !(await projectWorkIsCurrent(transaction, source.row)) ||
      source.row.currentBindingGeneration !== source.binding.bindingGeneration ||
      (source.origin !== null && recipients.length === 0)
        ? "authority-revoked"
        : decision.state === "refused"
          ? decision.reason
          : null;
    if (reason) {
      const control: Extract<ProjectRunControl, { kind: "request.refuse" }> = {
        kind: "request.refuse",
        requestId: event.data.request.id,
        callId: event.data.request.callId,
        reason,
      };
      await this.controls.enqueue(transaction, {
        binding: source.binding,
        idempotencyKey,
        control,
      });
      return { state: "refused", control };
    }
    if (decision.state !== "ready") denied();
    if (event.data.request.originatingNodeId) {
      const node = await transaction
        .selectFrom("executionNodes")
        .select("id")
        .where("id", "=", event.data.request.originatingNodeId)
        .where("runId", "=", source.binding.runId)
        .where("attemptId", "=", source.row.attemptId)
        .executeTakeFirst();
      if (!node) denied();
    }
    const request = event.data.request;
    const row = await transaction
      .insertInto("requests")
      .values({
        id: request.id,
        callId: request.callId,
        kind: request.kind,
        mode: "live",
        status: "pending",
        createdAt: new Date(),
        originatingGrantId: source.binding.grantId,
        originatingRunId: source.binding.runId,
        originatingOccurrenceId: null,
        originatingThreadId: source.binding.threadId,
        originatingWorkspaceId: source.binding.workspaceId,
        targetWorkspaceId: source.binding.workspaceId,
        originatingNodeId: request.originatingNodeId ?? null,
        requestedBy: source.origin?.userId ?? null,
        requiredActor: decision.requiredActor,
        payload: jsonValue(request.payload),
        presentation: jsonValue(request.presentation),
        response: null,
        resolvedAt: null,
        resolvedBy: null,
        cancellationReason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const events =
      row.requestedBy === null
        ? []
        : [
            await appendHostWorkspaceEvent(transaction, {
              type: "request.opened",
              data: { request: requestFromRow(row) },
              environmentId: source.binding.environmentId,
              runId: source.binding.runId,
              threadId: source.binding.threadId,
              workspaceId: source.binding.workspaceId,
            }),
          ];
    events.push(
      ...(await appendRequestFactInvalidations(transaction, [row.originatingThreadId], {
        requestId: row.id,
        runId: row.originatingRunId,
        type: "opened",
      })),
    );
    await fencePeople(transaction, recipients);
    if (source.origin && !(await liveRoot(transaction, source.binding.workspaceId, source.origin)))
      denied();
    return { state: "ready", request: pending(row), replayed: false, events };
  }

  async recipients(
    transaction: Transaction<DatabaseSchema>,
    requestId: RequestId,
  ): Promise<readonly UserId[]> {
    return projectRequestRecipients(transaction, requestId);
  }

  async detail(
    transaction: Transaction<DatabaseSchema>,
    input: { requestId: RequestId; userId: UserId },
  ) {
    await assertProjectAuthority(transaction);
    const row = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", input.requestId)
      .where("originatingGrantId", "is not", null)
      .where(projectRequestReadSql(transaction, input.userId))
      .executeTakeFirst();
    if (!row) denied();
    return row;
  }

  async viewFacts(
    transaction: Transaction<DatabaseSchema>,
    input: { readonly userId: UserId; readonly requestIds: readonly RequestId[] },
  ): Promise<ReadonlyMap<RequestId, ProjectRequestViewFacts>> {
    if (input.requestIds.length > 100)
      throw new TypeError("Request view limit must not exceed 100");
    if (!input.requestIds.length) return new Map();
    const rows = await transaction
      .selectFrom("requests")
      .leftJoin("users as requester", "requester.id", "requests.requestedBy")
      .leftJoin("users as resolver", "resolver.id", "requests.resolvedBy")
      .leftJoin("runs as askingRun", "askingRun.id", "requests.originatingRunId")
      .leftJoin("triggerOccurrences as occurrence", (join) =>
        join.on(
          "occurrence.id",
          "=",
          sql<
            import("@opensteer/core").TriggerOccurrenceId
          >`asking_run.authority_source->>'occurrenceId'`,
        ),
      )
      .leftJoin("triggers as automation", (join) =>
        join
          .on(
            "automation.id",
            "=",
            sql<
              import("@opensteer/core").TriggerId
            >`coalesce(asking_run.authority_source->>'triggerId', occurrence.trigger_id)`,
          )
          .onRef("automation.workspaceId", "=", "requests.originatingWorkspaceId"),
      )
      .select([
        "requests.id",
        "requests.status",
        "requests.requestedBy",
        "requests.cancellationReason",
        "requester.displayName as requesterName",
        "resolver.displayName as resolverName",
        "automation.name as sourceName",
        "askingRun.authoritySource",
        projectRequestAudienceSql(input.userId).as("canAnswer"),
      ])
      .where("requests.id", "in", [...input.requestIds])
      .where(storedProjectDeployment)
      .where("requests.originatingGrantId", "is not", null)
      .where(projectRequestReadSql(transaction, input.userId))
      .execute();
    return new Map(
      rows.map((row) => {
        const sourceKind =
          row.authoritySource?.kind === "watch-observation"
            ? "watch"
            : row.authoritySource?.kind === "trigger-occurrence"
              ? "trigger"
              : null;
        const source =
          sourceKind && row.requestedBy === null && row.sourceName
            ? AutomationSourceSchema.parse({ kind: sourceKind, name: row.sourceName })
            : undefined;
        const cancelledFor =
          row.requestedBy !== null &&
          row.status === "cancelled" &&
          (row.cancellationReason === "authority-revoked" ||
            row.cancellationReason === "membership-revoked")
            ? RequestCancelledForSchema.parse({ name: row.requesterName })
            : undefined;
        return [
          row.id,
          {
            ...(row.status === "pending"
              ? {
                  answer: CanSchema.parse(
                    row.canAnswer
                      ? { allowed: true }
                      : {
                          allowed: false,
                          reason: row.requestedBy === null ? "manager-only" : "requester-only",
                        },
                  ),
                }
              : {}),
            waitingOn:
              row.status === "pending"
                ? RequestWaitingOnSchema.parse(
                    row.requestedBy === null
                      ? { kind: "managers" }
                      : { kind: "person", name: row.requesterName },
                  )
                : null,
            resolvedByName: row.resolverName,
            ...(source ? { source } : {}),
            ...(cancelledFor ? { cancelledFor } : {}),
          },
        ] as const;
      }),
    );
  }

  async detailView(
    transaction: Transaction<DatabaseSchema>,
    input: { requestId: RequestId; userId: UserId },
  ) {
    const row = await this.detail(transaction, input);
    const facts = (
      await this.viewFacts(transaction, { userId: input.userId, requestIds: [row.id] })
    ).get(row.id);
    if (!facts) denied();
    return RequestViewSchema.parse({ ...requestFromRow(row), ...facts });
  }

  async listViews(
    transaction: Transaction<DatabaseSchema>,
    userId: UserId,
    limit = 100,
    before?: { readonly createdAt: Date; readonly id: RequestId },
  ) {
    const rows = await this.list(transaction, userId, limit, before);
    const facts = await this.viewFacts(transaction, {
      userId,
      requestIds: rows.map((row) => row.id),
    });
    return rows.map((row) => {
      const display = facts.get(row.id);
      if (!display) denied();
      return RequestViewSchema.parse({ ...requestFromRow(row), ...display });
    });
  }

  async cancelledEventViews(
    transaction: Transaction<DatabaseSchema>,
    events: readonly Extract<AgentEvent, { type: "request.cancelled" }>[],
    userId: UserId,
  ) {
    const facts = await this.viewFacts(transaction, {
      userId,
      requestIds: [...new Set(events.map((event) => event.data.requestId))],
    });
    return events.flatMap((event) => {
      const display = facts.get(event.data.requestId);
      return display
        ? [
            {
              ...event,
              data: {
                ...event.data,
                ...(display.cancelledFor ? { cancelledFor: display.cancelledFor } : {}),
              },
            },
          ]
        : [];
    });
  }

  async pageViews(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly userId: UserId;
      readonly threadId?: ThreadId;
      readonly limit: number;
      readonly before?: string;
    },
  ) {
    await assertProjectAuthority(transaction);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new OpensteerError({ code: "bad_request", message: "Request page limit is invalid" });
    if (
      input.threadId &&
      !(await readableThreadsForOwner(transaction, input.userId, input.threadId)
        .select("threads.id")
        .executeTakeFirst())
    )
      denied();
    const scope = input.threadId
      ? `originating-pending:${input.threadId}`
      : `waiting:${input.userId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    const addressed = transaction
      .selectFrom("requests")
      .where(
        input.threadId
          ? projectRequestReadSql(transaction, input.userId)
          : projectRequestAudienceSql(input.userId),
      )
      .where("originatingGrantId", "is not", null)
      .where("status", "=", "pending")
      .$call((query) =>
        input.threadId ? query.where("originatingThreadId", "=", input.threadId) : query,
      );
    let query = addressed
      .selectAll()
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(input.limit + 1);
    if (anchor)
      query = query.where((eb) =>
        eb.or([
          eb("createdAt", "<", anchor.createdAt),
          eb.and([eb("createdAt", "=", anchor.createdAt), eb("id", "<", anchor.id)]),
        ]),
      );
    const rows = await query.execute();
    const count = await addressed
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const page = requestPage(rows, Number(count.count), input.limit, scope);
    const facts = await this.viewFacts(transaction, {
      userId: input.userId,
      requestIds: page.requests.map((request) => request.id),
    });
    const requests = page.requests.map((request) => {
      const display = facts.get(request.id);
      if (!display) denied();
      return PendingRequestViewSchema.parse({ ...request, ...display });
    });
    return {
      requests,
      window: { ...page.window, byteCount: Buffer.byteLength(JSON.stringify(requests)) },
    };
  }

  async waitingPage(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly userId: UserId;
      readonly limit: number;
      readonly before?: string;
    },
  ) {
    const page = await this.pageViews(transaction, input);
    const held = await heldAssignments(
      transaction,
      page.requests.map((request) => request.id),
      input.userId,
    );
    const nodeIds = page.requests.flatMap((request) =>
      request.originatingNodeId ? [request.originatingNodeId] : [],
    );
    const nodes = new Map(
      (nodeIds.length
        ? await transaction
            .selectFrom("executionNodes")
            .select(["id", "title"])
            .where("id", "in", nodeIds)
            .execute()
        : []
      ).map((node) => [node.id, node]),
    );
    const requests = page.requests.map((request) => ({
      assignments: held.get(request.id) ?? [],
      presentation: null,
      request,
      subagent: request.originatingNodeId ? (nodes.get(request.originatingNodeId) ?? null) : null,
    }));
    return {
      requests,
      window: { ...page.window, byteCount: Buffer.byteLength(JSON.stringify(requests)) },
    };
  }

  async list(
    transaction: Transaction<DatabaseSchema>,
    userId: UserId,
    limit = 100,
    before?: { readonly createdAt: Date; readonly id: RequestId },
  ): Promise<readonly RequestRow[]> {
    await assertProjectAuthority(transaction);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Request limit must be between 1 and 100");
    let query = transaction
      .selectFrom("requests")
      .selectAll()
      .where(projectRequestAudienceSql(userId))
      .where("originatingGrantId", "is not", null)
      .where("status", "=", "pending")
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(limit);
    if (before)
      query = query.where((eb) =>
        eb.or([
          eb("createdAt", "<", before.createdAt),
          eb.and([eb("createdAt", "=", before.createdAt), eb("id", "<", before.id)]),
        ]),
      );
    return query.execute();
  }

  async count(transaction: Transaction<DatabaseSchema>, userId: UserId): Promise<number> {
    await assertProjectAuthority(transaction);
    const row = await transaction
      .selectFrom("requests")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("status", "=", "pending")
      .where("originatingGrantId", "is not", null)
      .where(projectRequestAudienceSql(userId))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async answer(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly requestId: RequestId;
      readonly userId: UserId;
      readonly sessionId: string;
      readonly response: ProjectEngineResponse;
    },
  ): Promise<{ readonly replayed: boolean; readonly events: readonly AgentEvent[] }> {
    await assertProjectAuthority(transaction);
    const observed = await this.detail(transaction, input);
    if (!observed.originatingRunId || !observed.originatingGrantId) denied();
    await transaction
      .selectFrom("runs")
      .select("id")
      .where("id", "=", observed.originatingRunId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await lockRequestWorkspaces(transaction, [observed.originatingWorkspaceId]);
    const row = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", input.requestId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (!(await this.recipients(transaction, row.id)).includes(input.userId))
      throw new OpensteerError({
        code: "forbidden",
        reason: row.requestedBy === null ? "manager-only" : "requester-only",
        message: "Only the Request audience may answer",
      });
    if (row.status !== "pending") {
      if (row.resolvedBy !== input.userId || !isDeepStrictEqual(row.response, input.response))
        throw new OpensteerError({
          code: "conflict",
          reason: "request-already-settled",
          message: "Request was already settled",
        });
      await fencePeople(transaction, [input.userId]);
      await authenticatedResponder(transaction, input.userId, input.sessionId);
      return { replayed: true, events: [] };
    }
    const source = await storedBinding(transaction, observed.originatingGrantId);
    if (
      source.row.grantStatus !== "active" ||
      source.row.currentBindingGeneration !== source.binding.bindingGeneration
    )
      denied();
    const response = ProjectEngineResponseSchema.parse(input.response);
    if (response.kind !== row.presentation.kind) denied();
    if (
      row.presentation.kind === "choice" &&
      response.kind === "choice" &&
      !row.presentation.options.some((option) => option.id === response.optionId)
    )
      denied();
    if (row.requestedBy !== null) assertRequestResponse(requestFromRow(row), response, false);
    else if (row.presentation.kind === "form" && response.kind === "form") {
      if (Object.keys(response.answers).length !== row.presentation.fields.length) denied();
      for (const field of row.presentation.fields) {
        const answers = response.answers[field.id];
        if (
          field.secret ||
          !answers?.length ||
          (!field.multiSelect && answers.length > 1) ||
          (field.choices &&
            answers.some((answer) => !field.choices?.some((choice) => choice.value === answer)))
        )
          denied();
      }
    }
    await this.controls.enqueue(transaction, {
      binding: source.binding,
      idempotencyKey: key(row.id, row.callId),
      control: { kind: "request.resolve", requestId: row.id, response },
    });
    const option =
      row.presentation.kind === "choice" && response.kind === "choice"
        ? row.presentation.options.find((candidate) => candidate.id === response.optionId)
        : undefined;
    await transaction
      .updateTable("requests")
      .set({
        status: option && requestOptionDeclines(option) ? "declined" : "fulfilled",
        resolvedBy: input.userId,
        response: jsonValue(response),
        resolvedAt: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
    const resolved = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    const events =
      resolved.requestedBy === null
        ? []
        : [
            await appendHostWorkspaceEvent(transaction, {
              type: "request.resolved",
              data: { request: requestFromRow(resolved) },
              environmentId: source.binding.environmentId,
              runId: source.binding.runId,
              threadId: source.binding.threadId,
              workspaceId: source.binding.workspaceId,
            }),
          ];
    events.push(
      ...(await appendRequestFactInvalidations(transaction, [row.originatingThreadId], {
        requestId: row.id,
        runId: row.originatingRunId,
        type: "resolved",
      })),
    );
    await fencePeople(transaction, [input.userId]);
    await authenticatedResponder(transaction, input.userId, input.sessionId);
    if (!(await this.recipients(transaction, row.id)).includes(input.userId))
      throw new OpensteerError({
        code: "forbidden",
        reason: row.requestedBy === null ? "manager-only" : "requester-only",
        message: "Only the Request audience may answer",
      });
    return { replayed: false, events };
  }

  async canContinue(
    transaction: Transaction<DatabaseSchema>,
    requestId: RequestId,
  ): Promise<boolean> {
    await assertProjectAuthority(transaction);
    const row = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirst();
    if (
      !row?.originatingGrantId ||
      !row.originatingRunId ||
      !row.resolvedBy ||
      !["fulfilled", "declined"].includes(row.status)
    )
      return false;
    await transaction
      .selectFrom("runs")
      .select("id")
      .where("id", "=", row.originatingRunId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await lockRequestWorkspaces(transaction, [row.originatingWorkspaceId]);
    const source = await storedBinding(transaction, row.originatingGrantId);
    await transaction
      .selectFrom("requests")
      .select("id")
      .where("id", "=", row.id)
      .forNoKeyUpdate()
      .execute();
    await fencePeople(transaction, [row.resolvedBy]);
    return (
      source.row.grantStatus === "active" &&
      ["starting", "running", "waiting"].includes(source.row.runStatus) &&
      (await projectWorkIsCurrent(transaction, source.row)) &&
      source.row.currentBindingGeneration === source.binding.bindingGeneration &&
      (await this.recipients(transaction, row.id)).includes(row.resolvedBy)
    );
  }

  async discover(
    transaction: Transaction<DatabaseSchema>,
    roots: readonly ProjectRequestRevocationRoot[],
  ) {
    await assertProjectAuthority(transaction);
    const rows = roots.length ? await requestsForRoots(transaction, roots) : [];
    return {
      runIds: [...new Set(rows.map((row) => row.runId))].sort(),
      workspaceIds: [...new Set(rows.map((row) => row.workspaceId))].sort(),
    };
  }

  async discoverManagerless(
    transaction: Transaction<DatabaseSchema>,
    workspaceIds: readonly WorkspaceId[],
  ) {
    await assertProjectAuthority(transaction);
    if (!workspaceIds.length) return { runIds: [], workspaceIds: [] };
    const rows = await transaction
      .selectFrom("requests")
      .select(["originatingRunId", "originatingWorkspaceId"])
      .where("originatingWorkspaceId", "in", [...workspaceIds])
      .where("requestedBy", "is", null)
      .where("originatingGrantId", "is not", null)
      .where("status", "=", "pending")
      .execute();
    return {
      runIds: [
        ...new Set(rows.flatMap((row) => (row.originatingRunId ? [row.originatingRunId] : []))),
      ].sort(),
      workspaceIds: [...new Set(rows.map((row) => row.originatingWorkspaceId))].sort(),
    };
  }

  /** Caller has reserved Runs then Workspaces; returned Runs are stopped by E in this transaction. */
  async cancel(
    transaction: Transaction<DatabaseSchema>,
    roots: readonly ProjectRequestRevocationRoot[],
  ): Promise<ProjectRequestCancellation> {
    await assertProjectAuthority(transaction);
    if (!roots.length) return { runIds: [], events: [] };
    const matches = await requestsForRoots(transaction, roots);
    const events = await cancelRows(
      transaction,
      matches.map((row) => row.id),
      "authority-revoked",
    );
    return { runIds: [...new Set(matches.map((row) => row.runId))], events };
  }

  async cancelManagerless(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: WorkspaceId,
    work: ProjectRequestStopPort,
  ): Promise<ProjectRequestCancellation> {
    await assertProjectAuthority(transaction);
    if ((await eligibleProjectRequestManagers(transaction, workspaceId)).length)
      return { runIds: [], events: [] };
    return this.cancelPlannedManagerless(transaction, [workspaceId], work);
  }

  /** Final eligibility was computed by the serialized access writer, before its user writes. */
  async cancelPlannedManagerless(
    transaction: Transaction<DatabaseSchema>,
    workspaceIds: readonly WorkspaceId[],
    work: ProjectRequestStopPort,
  ): Promise<ProjectRequestCancellation> {
    await assertProjectAuthority(transaction);
    if (!workspaceIds.length) return { runIds: [], events: [] };
    const rows = await transaction
      .selectFrom("requests")
      .select(["id", "originatingRunId"])
      .where("originatingWorkspaceId", "in", [...workspaceIds])
      .where("originatingGrantId", "is not", null)
      .where("requestedBy", "is", null)
      .where("status", "=", "pending")
      .orderBy("id")
      .execute();
    const events = await cancelRows(
      transaction,
      rows.map((row) => row.id),
      "no-eligible-manager",
    );
    const runIds = [
      ...new Set(rows.flatMap((row) => (row.originatingRunId ? [row.originatingRunId] : []))),
    ];
    if (runIds.length)
      await work.stop(transaction, {
        runIds,
        reason: "no-eligible-manager",
        requestEvents: events,
      });
    return { runIds, events };
  }

  async cancelRun(
    transaction: Transaction<DatabaseSchema>,
    input: Parameters<import("./run-finalization.js").ProjectRunRequestCancellation>[1],
  ): Promise<readonly AgentEvent[]> {
    await assertProjectAuthority(transaction);
    const rows = await transaction
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", input.runId)
      .where("originatingGrantId", "is not", null)
      .where("status", "=", "pending")
      .orderBy("id")
      .execute();
    return cancelRows(
      transaction,
      rows.map((row) => row.id),
      input.reason,
      input.resolvedAt,
    );
  }

  async cancelEngineRequest(
    transaction: Transaction<DatabaseSchema>,
    event: Extract<PendingAgentEvent, { readonly type: "request.cancelled" }>,
  ): Promise<readonly AgentEvent[]> {
    await assertProjectAuthority(transaction);
    const row = await transaction
      .selectFrom("requests")
      .innerJoin("grants", "grants.id", "requests.originatingGrantId")
      .select("requests.id")
      .where("requests.id", "=", event.data.requestId)
      .where("requests.originatingRunId", "=", event.runId)
      .where("grants.runId", "=", event.runId)
      .where("grants.bindingGeneration", "=", event.bindingGeneration)
      .executeTakeFirst();
    if (!row) denied();
    return cancelRows(transaction, [row.id], event.data.reason);
  }
}

async function fencePeople(transaction: Transaction<DatabaseSchema>, ids: readonly UserId[]) {
  if (ids.length)
    await transaction
      .selectFrom("users")
      .select("id")
      .where("id", "in", [...ids])
      .orderBy("id")
      .forShare()
      .execute();
}
async function cancelRows(
  transaction: Transaction<DatabaseSchema>,
  ids: readonly RequestId[],
  reason: NonNullable<RequestRow["cancellationReason"]>,
  resolvedAt = new Date(),
) {
  if (!ids.length) return [];
  await transaction
    .selectFrom("requests")
    .select("id")
    .where("id", "in", [...ids])
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  const rows = await transaction
    .updateTable("requests")
    .set({
      status: "cancelled",
      cancellationReason: reason,
      resolvedAt,
      resolvedBy: null,
      responseCommandId: null,
    })
    .where("id", "in", [...ids])
    .where("status", "=", "pending")
    .returningAll()
    .execute();
  const events: AgentEvent[] = [];
  for (const row of rows)
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        type: "request.cancelled",
        data: { requestId: row.id, reason },
        environmentId: await requestOriginEnvironment(transaction, row),
        runId: row.originatingRunId,
        threadId: row.originatingThreadId,
        workspaceId: row.originatingWorkspaceId,
      }),
    );
  events.push(
    ...(await appendRequestFactInvalidations(
      transaction,
      rows.map((row) => row.originatingThreadId),
    )),
  );
  return events;
}

async function appendRequestFactInvalidations(
  transaction: Transaction<DatabaseSchema>,
  threadIds: readonly ThreadId[],
  requestFact?: {
    readonly requestId: RequestId;
    readonly runId: RunId | null;
    readonly type: "opened" | "resolved";
  },
): Promise<AgentEvent[]> {
  if (!threadIds.length) return [];
  const threads = await transaction
    .selectFrom("threads")
    .selectAll()
    .select([
      threadPendingRequestsSelection,
      threadProviderSessionSelection,
      threadContinuationIdentitySelection,
    ])
    .where("id", "in", [...new Set(threadIds)])
    .orderBy("id")
    .execute();
  const events: AgentEvent[] = [];
  for (const row of threads)
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        type: "thread.execution-updated",
        data: { thread: threadFromRow(row), ...(requestFact ? { requestFact } : {}) },
        environmentId: row.environmentId,
        workspaceId: row.workspaceId,
        threadId: row.id,
        runId: null,
      }),
    );
  return events;
}

export async function projectRequestRecipients(
  transaction: Transaction<DatabaseSchema>,
  requestId: RequestId,
): Promise<readonly UserId[]> {
  await assertProjectAuthority(transaction);
  const row = await transaction
    .selectFrom("requests")
    .select("originatingGrantId")
    .where("id", "=", requestId)
    .executeTakeFirst();
  if (!row?.originatingGrantId) return [];
  const source = await storedBinding(transaction, row.originatingGrantId);
  return audience(transaction, source.binding);
}

export async function projectRunRecipients(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<readonly UserId[]> {
  await assertProjectAuthority(database);
  const row = await database
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select([
      "runs.requestedBy",
      "runs.initiatorGeneration",
      "runs.membershipGeneration",
      "runs.originConnectionId",
      "threads.workspaceId",
    ])
    .where("runs.id", "=", runId)
    .executeTakeFirst();
  if (!row) return [];
  if (row.requestedBy === null) return eligibleProjectRequestManagers(database, row.workspaceId);
  const root = HumanRootSchema.parse({
    userId: row.requestedBy,
    initiatorGeneration: Number(row.initiatorGeneration),
    membershipGeneration: Number(row.membershipGeneration),
    originConnectionId: row.originConnectionId,
  });
  return (await liveRoot(database, row.workspaceId, root)) ? [root.userId] : [];
}

function projectRequestReadSql(database: Kysely<DatabaseSchema>, userId: UserId) {
  return sql<boolean>`requests.originating_thread_id in (${readableThreadsForOwner(database, userId).select("threads.id")})`;
}

export function projectRequestAudienceSql(userId: UserId) {
  return sql<boolean>`exists (
        select 1 from grants g join runs r on r.id = g.run_id
        join workspace_memberships m on m.workspace_id = requests.originating_workspace_id
        join users u on u.id = m.user_id
        where g.id = requests.originating_grant_id and m.user_id = ${userId}
          and m.state = 'active' and u.member_state = 'active' and u.admitted_at is not null
          and u.disabled_at is null and exists (
            select 1 from workspaces w where w.id = requests.originating_workspace_id
              and w.deleted_at is null and w.status not in ('deleting', 'deleted')) and (
            (r.requested_by = u.id and r.initiator_generation = u.authority_generation
              and r.membership_generation = m.generation
              and (r.origin_connection_id is null or exists (
                select 1 from agent_connections c where c.id = r.origin_connection_id
                  and c.user_id = u.id and c.revoked_at is null
                  and c.member_generation = r.initiator_generation and c.membership_generation = r.membership_generation
                  and (c.workspace_id is null or c.workspace_id = requests.originating_workspace_id))))
            or (r.requested_by is null and m.role = 'owner' and u.member_kind = 'full')
          )
      )`;
}

async function authenticatedResponder(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  sessionId: string,
) {
  await requestSettlementActor(transaction, userId, sessionId);
  const session = await transaction
    .selectFrom("authSessions")
    .innerJoin("users", "users.id", "authSessions.userId")
    .select("authSessions.id")
    .where("authSessions.id", "=", AuthSessionIdSchema.parse(sessionId))
    .where("authSessions.userId", "=", userId)
    .whereRef("authSessions.memberGeneration", "=", "users.authorityGeneration")
    .forShare("authSessions")
    .executeTakeFirst();
  if (!session) denied();
}

async function requestsForRoots(
  database: Kysely<DatabaseSchema>,
  roots: readonly ProjectRequestRevocationRoot[],
) {
  const rows = await database
    .selectFrom("requests as request")
    .innerJoin("runs as run", "run.id", "request.originatingRunId")
    .innerJoin("threads as thread", "thread.id", "run.threadId")
    .select([
      "request.id",
      "run.id as runId",
      "run.requestedBy",
      "run.initiatorGeneration",
      "run.membershipGeneration",
      "run.originConnectionId",
      "thread.workspaceId",
    ])
    .where("run.requestedBy", "in", [...new Set(roots.map((root) => root.userId))])
    .where("request.originatingGrantId", "is not", null)
    .where("request.status", "=", "pending")
    .orderBy("request.id")
    .execute();
  return rows.filter((row) =>
    roots.some((root) => {
      if (row.requestedBy !== root.userId || row.initiatorGeneration === null) return false;
      if (root.kind === "member")
        return Number(row.initiatorGeneration) <= root.memberGenerationCutoff;
      if (
        row.workspaceId !== root.workspaceId ||
        Number(row.membershipGeneration) > root.membershipGenerationCutoff
      )
        return false;
      return (
        root.kind === "membership" ||
        (row.originConnectionId === root.connectionId &&
          Number(row.initiatorGeneration) <= root.memberGenerationCutoff)
      );
    }),
  );
}

/** Q's part of AccessWorkRevocationPort; E composes its other work scopes and terminalizer. */
export function projectRequestRevocationHooks(
  requests: ProjectRequestStore,
  work: ProjectRequestStopPort,
) {
  return {
    discover: (
      transaction: Transaction<DatabaseSchema>,
      roots: readonly ProjectRequestRevocationRoot[],
    ) => requests.discover(transaction, roots),
    cancel: async (
      transaction: Transaction<DatabaseSchema>,
      roots: readonly ProjectRequestRevocationRoot[],
    ): Promise<void> => {
      const cancelled = await requests.cancel(transaction, roots);
      if (cancelled.runIds.length)
        await work.stop(transaction, {
          runIds: cancelled.runIds,
          reason: "authority-revoked",
          requestEvents: cancelled.events,
        });
    },
  };
}

export function projectRequestActivityFact(
  fact: ThreadRequestWaits["items"][number] | ThreadRequestOutcome,
) {
  const title = fact.class === "question" ? "Question" : "Approval";
  if ("waitingOn" in fact)
    return {
      title,
      status: "pending",
      text:
        fact.waitingOn.kind === "person"
          ? `Waiting for ${fact.waitingOn.name}`
          : "Waiting for managers",
    };
  if (fact.status !== "cancelled") {
    const text =
      fact.status === "fulfilled"
        ? `Answered by ${fact.resolvedByName}`
        : fact.status === "declined"
          ? `Declined by ${fact.resolvedByName}`
          : "Withdrawn";
    return { title, status: fact.status, text };
  }
  const reasons = {
    "run-ended": "Cancelled: run ended",
    "process-lost": "Cancelled: process lost",
    "source-closed": "Cancelled: source closed",
    "thread-archived": "Cancelled: task closed",
    "workspace-deleted": "Cancelled: Project deleted",
    "resource-deleted": "Cancelled: resource deleted",
    "membership-revoked": "Cancelled: membership revoked",
    "authority-revoked": "Cancelled: authority revoked",
    "no-eligible-manager": "Cancelled: no manager left",
  };
  return {
    title,
    status: fact.status,
    text: fact.cancelledFor ? `Cancelled: ${fact.cancelledFor.name} left` : reasons[fact.reason],
  };
}
