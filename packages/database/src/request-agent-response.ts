import { withPersonalTransaction } from "./personal-transaction.js";
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
import { requestFromRow, requestRevision } from "./request-persistence.js";
import type { DatabaseSchema } from "./schema.js";
import { threadExecutionIsAvailableToUser } from "./store-primitives.js";
import {
  assertThreadCaller,
  lockThreadCaller,
  type ThreadCallerAuthority,
} from "./thread-caller.js";
export const AgentRequestResponderSchema = z.object({
  expectedRevision: z.string().min(1).max(128),
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
): void {
  if (
    !requestIsAgentAnswerable(request) ||
    request.originatingRunId === responder.authority.scope.runId
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "This Request needs the person to answer",
    });
  if (request.status !== "pending" || requestRevision(request) !== responder.expectedRevision)
    throw new OpensteerError({
      code: "conflict",
      message: "Request changed; read it again before answering",
    });
}
export function readAgentRequest(
  database: Kysely<DatabaseSchema>,
  authority: ThreadCallerAuthority,
  requestId: RequestId,
): Promise<Request> {
  return withPersonalTransaction(database, async (transaction) => {
    await lockThreadCaller(transaction, authority);
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
    return requestFromRow(row);
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
export { requestRevision } from "./request-persistence.js";
