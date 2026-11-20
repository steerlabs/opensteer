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
import type { Kysely, Transaction } from "kysely";
import "./connection.js";
import { assertRequestRevision, requestFromRow } from "./request-persistence.js";
import { bindingAgentConnectionId, liveAgentConnection, sendEligible } from "./resource-access.js";
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
export function readAgentRequest(
  database: Kysely<DatabaseSchema>,
  authority: ThreadCallerAuthority,
  requestId: RequestId,
): Promise<{ readonly request: Request; readonly revision: string }> {
  return withPersonalReadTransaction(database, async (transaction) => {
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
