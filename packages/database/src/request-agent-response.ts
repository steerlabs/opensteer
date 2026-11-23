import { withPersonalReadTransaction } from "./personal-transaction.js";
import {
  EnvironmentIdSchema,
  OpensteerError,
  RequestIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadAccessModeSchema,
  ThreadIdSchema,
  UserIdSchema,
  requestIsAgentAnswerable,
  type Request,
  type RequestId,
} from "@opensteer/core";
import { z } from "zod";
import type { Kysely, SelectQueryBuilder, Transaction } from "kysely";
import "./connection.js";
import { assertRequestRevision, requestFromRow } from "./request-persistence.js";
import { connectionTaskRequestScope } from "./resource-access.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { threadCallerLineageId } from "./thread-caller.js";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import { PersonalRevisionSchema } from "@opensteer/protocol/resources";
import { threadExecutionAdmitted } from "./execution-authority.js";
import { threadExecutionIsAvailableToUser } from "./store-primitives.js";
import { assertThreadCaller, type ThreadCallerAuthority } from "./thread-caller.js";
export const AgentRequestResponderSchema = z.object({
  expectedRevision: PersonalRevisionSchema,
  authority: z.object({
    kind: z.literal("run"),
    userId: UserIdSchema,
    accessMode: ThreadAccessModeSchema,
    scope: z.object({
      bindingGeneration: z.number().int().positive(),
      environmentId: EnvironmentIdSchema,
      requestedBy: UserIdSchema,
      runId: RunIdSchema,
      runnerBootId: z.string().min(1),
      runnerId: RunnerIdSchema,
      threadId: ThreadIdSchema,
    }),
  }),
});
export async function assertAgentRequestTarget(
  transaction: Transaction<DatabaseSchema>,
  authority: ThreadCallerAuthority,
  threadId: Request["originatingThreadId"],
  {
    readOnly = false,
    admitted = false,
  }: {
    readOnly?: boolean;
    admitted?: boolean;
  } = {},
): Promise<void> {
  if (authority.kind === "run" && authority.scope.requestedBy !== authority.userId)
    throw new OpensteerError({
      code: "forbidden",
      message: "Request is unavailable",
    });
  await assertThreadCaller(transaction, authority, {
    threadId,
    readOnly,
    activate: !readOnly,
    admitted,
  });
  if (!(await threadExecutionIsAvailableToUser(transaction, threadId, authority.userId)))
    throw new OpensteerError({
      code: "forbidden",
      message: "Request is unavailable",
    });
}
export function assertAgentRequestAnswer(
  request: Request,
  responder: z.infer<typeof AgentRequestResponderSchema>,
  revision: string,
): void {
  if (
    !requestIsAgentAnswerable(request) ||
    request.originatingRunId === responder.authority.scope.runId
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "This Request needs the person to answer",
    });
  if (request.status !== "pending")
    throw new OpensteerError({
      code: "conflict",
      message: "Request changed; read it again before answering",
    });
  assertRequestRevision({ revision }, responder.expectedRevision);
}
async function connectionRequestsQuery(
  tx: Transaction<DatabaseSchema>,
  authority: Extract<ThreadCallerAuthority, { kind: "connection" }>,
  options?: {
    readonly ownerVerified?: boolean;
    readonly scope?: "everything" | "selected";
  },
) {
  if (!options?.ownerVerified) await requirePersonalOwner(tx, authority.userId);
  const scope = options?.scope ?? (await connectionTaskRequestScope(tx, authority));

  return tx
    .selectFrom("requests")
    .innerJoin("threads", "threads.id", "requests.originatingThreadId")
    .leftJoin("runs", "runs.id", "requests.originatingRunId")
    .leftJoin("threads as runThread", "runThread.id", "runs.threadId")
    .leftJoin("triggerOccurrences", "triggerOccurrences.id", "requests.originatingOccurrenceId")
    .leftJoin(
      "triggers as occurrenceTrigger",
      "occurrenceTrigger.id",
      "triggerOccurrences.triggerId",
    )
    .leftJoin(
      "triggerWatchActivations",
      "triggerWatchActivations.id",
      "requests.originatingWatchActivationId",
    )
    .leftJoin("triggers as watchTrigger", "watchTrigger.id", "triggerWatchActivations.triggerId")
    .leftJoin("agentSessions", "agentSessions.id", "requests.originatingAgentSessionId")
    .selectAll("requests")
    .where("threads.createdBy", "=", authority.userId)
    .where(threadExecutionAdmitted(tx, authority.userId))
    .$if(scope === "selected", (query) =>
      query.where("threads.originConnectionId", "=", authority.connectionId),
    )
    .where((eb) => {
      const asker = eb
        .case()
        .when("requests.originatingRunId", "is not", null)
        .then(eb.ref("runs.connectionId"))
        .when("requests.originatingOccurrenceId", "is not", null)
        .then(eb.ref("occurrenceTrigger.originConnectionId"))
        .when("requests.originatingWatchActivationId", "is not", null)
        .then(eb.ref("watchTrigger.originConnectionId"))
        .else(eb.ref("agentSessions.connectionId"))
        .end();
      return eb.and([
        eb
          .case()
          .when("requests.originatingRunId", "is not", null)
          .then(
            eb.and([
              eb("runThread.id", "is not", null),
              eb.or([
                eb("runThread.originConnectionId", "is", null),
                eb("runThread.originConnectionId", "=", eb.ref("runs.connectionId")),
              ]),
            ]),
          )
          .when("requests.originatingOccurrenceId", "is not", null)
          .then(eb("occurrenceTrigger.id", "is not", null))
          .when("requests.originatingWatchActivationId", "is not", null)
          .then(eb("watchTrigger.id", "is not", null))
          .when("requests.originatingAgentSessionId", "is not", null)
          .then(eb("agentSessions.id", "is not", null))
          .else(true)
          .end(),
        eb.or([
          eb(asker, "=", authority.connectionId),
          ...(scope === "everything" ? [eb(asker, "is", null)] : []),
        ]),
      ]);
    });
}

export async function connectionRequests(
  tx: Transaction<DatabaseSchema>,
  authority: Extract<ThreadCallerAuthority, { kind: "connection" }>,
  options?: {
    readonly ownerVerified?: boolean;
    readonly scope?: "everything" | "selected";
  },
): Promise<SelectQueryBuilder<{ readonly requests: RequestRow }, "requests", RequestRow>> {
  const scoped = await connectionRequestsQuery(tx, authority, options);
  return tx.selectFrom(scoped.as("requests")).selectAll("requests");
}

export async function queryConnectionRequestPage(
  tx: Transaction<DatabaseSchema>,
  input: {
    readonly authority: Extract<ThreadCallerAuthority, { kind: "connection" }>;
    readonly lineageRootThreadId: Request["originatingThreadId"] | null;
    readonly originatingThreadId?: Request["originatingThreadId"];
    readonly status: "pending" | "all";
    readonly anchor: { readonly createdAt: Date; readonly id: RequestId } | null;
    readonly limit: number;
  },
): Promise<{ readonly rows: readonly RequestRow[]; readonly total: number }> {
  const scoped = await connectionRequestsQuery(tx, input.authority);
  const base = () => {
    let query = scoped.clearSelect().where("threads.removedAt", "is", null);
    if (input.lineageRootThreadId !== null)
      query = query.where("threads.lineageRootThreadId", "=", input.lineageRootThreadId);
    if (input.originatingThreadId)
      query = query.where("requests.originatingThreadId", "=", input.originatingThreadId);
    if (input.status === "pending") query = query.where("requests.status", "=", "pending");
    return query;
  };
  let pageQuery = base()
    .selectAll("requests")
    .orderBy("requests.createdAt", "desc")
    .orderBy("requests.id", "desc")
    .limit(input.limit + 1);
  if (input.anchor) {
    const anchor = input.anchor;
    pageQuery = pageQuery.where((expression) =>
      expression.or([
        expression("requests.createdAt", "<", anchor.createdAt),
        expression.and([
          expression("requests.createdAt", "=", anchor.createdAt),
          expression("requests.id", "<", anchor.id),
        ]),
      ]),
    );
  }
  const [rows, count] = await Promise.all([
    pageQuery.execute(),
    base()
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow(),
  ]);
  return { rows, total: Number(count.count) };
}

export async function readPendingConnectionRequest(
  tx: Transaction<DatabaseSchema>,
  authority: Extract<ThreadCallerAuthority, { kind: "connection" }>,
  threadId: Request["originatingThreadId"],
  assignmentId?: import("@opensteer/core").AssignmentId,
) {
  const query = await connectionRequestsQuery(tx, authority);
  return query
    .clearSelect()
    .select(["requests.id", "requests.kind"])
    .where("requests.originatingThreadId", "=", threadId)
    .where("requests.status", "=", "pending")
    .where((eb) => (assignmentId ? eb("runs.assignmentId", "=", assignmentId) : eb.val(true)))
    .orderBy("requests.createdAt", "asc")
    .limit(1)
    .executeTakeFirst();
}

async function readConnectionRequest(
  tx: Transaction<DatabaseSchema>,
  authority: Extract<ThreadCallerAuthority, { kind: "connection" }>,
  requestId: RequestId,
) {
  const query = await connectionRequestsQuery(tx, authority);
  const row = await query.where("requests.id", "=", requestId).executeTakeFirst();
  if (!row) throw new OpensteerError({ code: "not_found", message: "Request is unavailable" });
  return { request: requestFromRow(row), revision: row.revision };
}

export function readAgentRequest(
  database: Kysely<DatabaseSchema>,
  authority: ThreadCallerAuthority,
  requestId: RequestId,
): Promise<{ readonly request: Request; readonly revision: string }> {
  const parsedRequestId = RequestIdSchema.parse(requestId);
  return withPersonalReadTransaction(database, async (transaction) => {
    if (authority.kind === "connection")
      return readConnectionRequest(transaction, authority, parsedRequestId);
    if (authority.kind === "run" && authority.scope.requestedBy !== authority.userId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Request is unavailable",
      });
    const reader = await threadCallerLineageId(transaction, authority);
    if (reader) {
      const read = await readConnectionRequest(
        transaction,
        {
          kind: "connection",
          userId: authority.userId,
          connectionId: reader,
          accessMode: authority.accessMode,
        },
        parsedRequestId,
      );
      await assertAgentRequestTarget(transaction, authority, read.request.originatingThreadId, {
        readOnly: true,
      });
      return read;
    }
    const row = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", parsedRequestId)
      .executeTakeFirst();
    if (!row)
      throw new OpensteerError({
        code: "forbidden",
        message: "Request is unavailable",
      });
    await assertAgentRequestTarget(transaction, authority, row.originatingThreadId, {
      readOnly: true,
    });
    return { request: requestFromRow(row), revision: row.revision };
  }).catch((error: unknown) => {
    if (
      error instanceof OpensteerError &&
      (error.code === "forbidden" ||
        (error.code === "not_found" && authority.kind !== "connection"))
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Request is unavailable",
      });
    throw error;
  });
}
