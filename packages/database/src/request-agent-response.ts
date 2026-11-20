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
  agentGrantAllowsTasks,
  threadAccessModeAtMost,
  type Request,
  type RequestId,
} from "@opensteer/core";
import { z } from "zod";
import type { Kysely, Transaction } from "kysely";
import "./connection.js";
import { assertRequestRevision, requestFromRow } from "./request-persistence.js";
import { bindingAgentConnectionId, liveAgentConnection, sendEligible } from "./resource-access.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { threadCallerLineageId } from "./thread-caller.js";
import type { DatabaseSchema } from "./schema.js";
import { PersonalRevisionSchema } from "@opensteer/protocol/resources";
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
async function readConnectionRequest(
  tx: Transaction<DatabaseSchema>,
  authority: Extract<ThreadCallerAuthority, { kind: "connection" }>,
  requestId: RequestId,
) {
  const unavailable = () =>
    new OpensteerError({ code: "forbidden", message: "Request is unavailable" });
  await requirePersonalOwner(tx, authority.userId);
  const connection = await liveAgentConnection(tx, authority.userId, authority.connectionId);
  if (
    !agentGrantAllowsTasks(connection.grant) ||
    !threadAccessModeAtMost(authority.accessMode, connection.accessMode)
  )
    throw unavailable();

  const row = await tx
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
    .where("requests.id", "=", requestId)
    .where("threads.createdBy", "=", authority.userId)
    .$if(connection.grant.scope === "selected", (query) =>
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
          ...(connection.grant.scope === "everything" ? [eb(asker, "is", null)] : []),
        ]),
      ]);
    })
    .executeTakeFirst();
  if (
    !row ||
    !(await threadExecutionIsAvailableToUser(tx, row.originatingThreadId, authority.userId))
  )
    throw unavailable();
  return { request: requestFromRow(row), revision: row.revision };
}

export function readAgentRequest(
  database: Kysely<DatabaseSchema>,
  authority: ThreadCallerAuthority,
  requestId: RequestId,
): Promise<{ readonly request: Request; readonly revision: string }> {
  return withPersonalReadTransaction(database, async (transaction) => {
    if (authority.kind === "connection")
      return readConnectionRequest(transaction, authority, RequestIdSchema.parse(requestId));
    const row = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", RequestIdSchema.parse(requestId))
      .executeTakeFirst();
    if (!row)
      throw new OpensteerError({
        code: "forbidden",
        message: "Request is unavailable",
      });
    await assertAgentRequestTarget(transaction, authority, row.originatingThreadId, {
      readOnly: true,
    });
    // The execution that asked, not only its task: a connection reads only Requests its own
    // lineage made, or, with `everything`, the person's own.
    const reader = await threadCallerLineageId(transaction, authority);
    if (reader) {
      const asker = row.originatingRunId
        ? `run:${row.originatingRunId}`
        : row.originatingOccurrenceId
          ? `trigger:${row.originatingOccurrenceId}`
          : row.originatingWatchActivationId
            ? `watch:${row.originatingWatchActivationId}`
            : row.originatingAgentSessionId
              ? `session:${row.originatingAgentSessionId}`
              : null;
      const askerLineage = asker ? await bindingAgentConnectionId(transaction, asker) : null;
      const connection = await liveAgentConnection(transaction, authority.userId, reader);
      if (!sendEligible(connection, askerLineage))
        throw new OpensteerError({ code: "forbidden", message: "Request is unavailable" });
    }
    return { request: requestFromRow(row), revision: row.revision };
  }).catch((error: unknown) => {
    if (
      error instanceof OpensteerError &&
      (error.code === "forbidden" || error.code === "not_found")
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Request is unavailable",
      });
    throw error;
  });
}
