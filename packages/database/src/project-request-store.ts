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
} from "@opensteer/core";
import type { ProjectRunControl } from "@opensteer/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { requestFromRow, requestOriginEnvironment } from "./request-persistence.js";
import { assertRequestResponse } from "./command-store.js";
import { checkAccess } from "./access-store.js";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { lockRequestWorkspaces } from "./request-workspace-locks.js";
import { requestSettlementActor } from "./request-settlement.js";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

/** Enqueue and replay lookup share the proposal transaction; neither waits for a Runner. */
export interface ProjectRequestControlPort {
  find(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly binding: ProjectRunBinding;
      readonly idempotencyKey: string;
    },
  ): Promise<ProjectRunControl | null>;
  enqueue(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly binding: ProjectRunBinding;
      readonly idempotencyKey: string;
      readonly control: ProjectRunControl;
    },
  ): Promise<{ readonly created: boolean }>;
}

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

export class ProjectRequestStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly controls: ProjectRequestControlPort;
  constructor(database: Kysely<DatabaseSchema>, controls: ProjectRequestControlPort) {
    this.database = database;
    this.controls = controls;
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
      requestClass: event.data.request.requestClass,
      eligibleManagerCount: recipients.length,
    });
    const reason: Extract<ProjectRunControl, { kind: "request.refuse" }>["reason"] | null =
      source.row.grantStatus !== "active" ||
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
    if (!(await this.recipients(transaction, input.requestId)).includes(input.userId)) denied();
    return transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", input.requestId)
      .executeTakeFirstOrThrow();
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
    if (!(await this.recipients(transaction, row.id)).includes(input.userId)) denied();
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
    if (row.status !== "pending") {
      if (row.resolvedBy !== input.userId || !isDeepStrictEqual(row.response, response)) denied();
      await fencePeople(transaction, [input.userId]);
      await authenticatedResponder(transaction, input.userId, input.sessionId);
      return { replayed: true, events: [] };
    }
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
    await fencePeople(transaction, [input.userId]);
    await authenticatedResponder(transaction, input.userId, input.sessionId);
    if (!(await this.recipients(transaction, row.id)).includes(input.userId)) denied();
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
      source.row.currentBindingGeneration === source.binding.bindingGeneration &&
      (await this.recipients(transaction, row.id)).includes(row.resolvedBy)
    );
  }

  /** Caller has reserved Runs then Workspaces; returned Runs are stopped by E in this transaction. */
  async cancel(
    transaction: Transaction<DatabaseSchema>,
    roots: readonly ProjectRequestRevocationRoot[],
  ): Promise<ProjectRequestCancellation> {
    await assertProjectAuthority(transaction);
    if (!roots.length) return { runIds: [], events: [] };
    const rows = await transaction
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
    const matches = rows.filter((row) =>
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
  ): Promise<ProjectRequestCancellation> {
    await assertProjectAuthority(transaction);
    if ((await eligibleProjectRequestManagers(transaction, workspaceId)).length)
      return { runIds: [], events: [] };
    const rows = await transaction
      .selectFrom("requests")
      .select(["id", "originatingRunId"])
      .where("originatingWorkspaceId", "=", workspaceId)
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
    return {
      runIds: rows.flatMap((row) => (row.originatingRunId ? [row.originatingRunId] : [])),
      events,
    };
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
  reason: "authority-revoked" | "no-eligible-manager",
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
      resolvedAt: new Date(),
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
  if (!row?.requestedBy) return [];
  const root = HumanRootSchema.parse({
    userId: row.requestedBy,
    initiatorGeneration: Number(row.initiatorGeneration),
    membershipGeneration: Number(row.membershipGeneration),
    originConnectionId: row.originConnectionId,
  });
  return (await liveRoot(database, row.workspaceId, root)) ? [root.userId] : [];
}

function projectRequestAudienceSql(userId: UserId) {
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
