import { runDeliverySelection } from "./thread-row-mappers.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { lockDeploymentEvents, withPersonalTransaction } from "./personal-transaction.js";
import { failNodeStop } from "./node-control.js";
import {
  assertThreadCaller,
  lockThreadCaller,
  type ThreadCallerAuthority,
} from "./thread-caller.js";
import { recordPersonWaited } from "./run-visibility.js";
import { taskQuestionNoticeIsPending } from "./task-question-notices.js";
import {
  AgentRequestResponderSchema,
  assertAgentRequestAnswer,
  assertAgentRequestTarget,
} from "./request-agent-response.js";
import type { z } from "zod";
import { readRequestSettlementActor, requestSettlementActor } from "./request-settlement.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import "./connection.js";
import {
  revokeRunGrants,
  runHasActiveGrant,
  runWasStopped,
  type RevokedRunGrant,
} from "./run-grants.js";
import { pendingReplacementAttempt, type RunAttemptRow } from "./run-attempts.js";
import {
  type CommandRow,
  type DatabaseSchema,
  type PendingCommandRow,
  type RunRow,
} from "./schema.js";
import {
  type UserId,
  type RunId,
  type ThreadId,
  type RequestId,
  type RequestResponse,
  type AgentEvent,
  OpensteerError,
  nonTerminalRunStatuses,
  type Request,
  RequestIdSchema,
  ResolvedRequestSchema,
  RequestSettlementProvenanceSchema,
  RequestAgentAnswererSchema,
  UserIdSchema,
  RequestResponseSchema,
  hasSecretRequestFields,
  requestOptionDeclines,
  createId,
  type EnvironmentId,
  type Message,
  type Run,
} from "@opensteer/core";
import { type InsertObject, type Transaction, sql, type Kysely } from "kysely";
import {
  jsonValue,
  threadExecutionIsAvailableToUser,
  lockThreadRow,
  type ChannelLinks,
  requireBoundedIdentity,
  lockCommandIdempotency,
  findCommandByIdempotency,
  idempotencyConflict,
  principalIdForUser,
  returnRunToQueue,
  safeError,
} from "./store-primitives.js";
import {
  channelRunAuthorityIsCurrent,
  channelInputAuthorityIsCurrent,
} from "./channel-execution.js";
import {
  claimConversationBatch,
  claimRunInputBatch,
  deliverConversationInputsInTransaction,
  restartBatchCapacity,
  settleSteer,
  settleStoppedConversationInputs,
} from "./thread-inbox.js";
import { projectThreadState } from "./thread-status.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import { assignmentActivityEventsForRun } from "./assignment-store.js";
import { cancelPending, requestFromRow } from "./request-store.js";
import { threadInputFromRow, messageFromRow, runFromRow } from "./thread-row-mappers.js";
import { isDeepStrictEqual } from "node:util";
import { endStoppedUnconfirmedRun, finalizeRunTransaction } from "./run-finalization.js";

export type RunnerControlInput =
  | {
      readonly idempotencyKey: string;
      readonly requestedBy: UserId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "run.interrupt";
      readonly keepQueueRunning?: true;
      readonly authority?: ThreadCallerAuthority;
    }
  | {
      readonly idempotencyKey: string;
      readonly requestId: RequestId;
      readonly settlementSessionId?: string;
      readonly agentResponder?: z.infer<typeof AgentRequestResponderSchema>;
      readonly requestedBy: UserId;
      readonly response: RequestResponse;
      readonly sealedResponse: {
        readonly envelope: Buffer;
        readonly keyVersion: number;
        readonly requestFingerprint: string;
      };
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "request.respond";
    };
export interface ClaimedCommand {
  readonly command: CommandRow;
  readonly events: readonly AgentEvent[];
  /**
   * A durable command that lost execution authority is claimed only so the
   * coordinator can terminalize it without ever handing it to a Runner.
   */
  readonly terminalFailure?: string;
  /** External sender revocation cancels that input, not other people sharing its authority. */
  readonly terminalFailureInput?: "seed-input";
}
async function claimObservedCommand(
  transaction: Transaction<DatabaseSchema>,
  observed: Pick<
    CommandRow,
    "environmentId" | "id" | "payload" | "requestedBy" | "runId" | "threadId" | "type"
  >,
  dispatcherId: string,
): Promise<ClaimedCommand | null> {
  // Follow ./lock-order.ts: an ambiguous prior dispatch may requeue a command
  // just as the old Runner commits its terminal event.
  const run = observed.runId
    ? await transaction
        .selectFrom("runs")
        .select(["environmentId", "id", "status", "threadId", "runOrdinal", "seedInputId"])
        .where("id", "=", observed.runId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow()
    : undefined;
  if (observed.type === "request.respond") {
    const payload = requestResponseCommandPayload(observed.payload);
    const reservation = await transaction
      .selectFrom("requests")
      .select("id")
      .where("id", "=", payload.requestId)
      .$if(observed.runId !== null, (builder) =>
        builder.where("originatingRunId", "=", observed.runId!),
      )
      .$if(observed.threadId !== null, (builder) =>
        builder.where("originatingThreadId", "=", observed.threadId!),
      )
      .where("responseCommandId", "=", observed.id)
      .where("status", "=", "pending")
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!reservation) {
      await transaction
        .updateTable("commands")
        .set({
          lastError: jsonValue({
            message: "The Request response reservation is no longer valid",
          }),
          status: "failed",
          updatedAt: new Date(),
        })
        .where("id", "=", observed.id)
        .where("status", "=", "pending")
        .execute();
      return null;
    }
  }
  if (runnerControlCommandTypes.includes(observed.type as RunnerControlCommandType)) {
    const predecessor = await transaction
      .selectFrom("commands as predecessor")
      .innerJoin("commands as candidate", (join) => join.on("candidate.id", "=", observed.id))
      .select("predecessor.id")
      .whereRef("predecessor.threadId", "=", "candidate.threadId")
      .where("predecessor.type", "in", runnerControlCommandTypes)
      .where("predecessor.status", "in", ["pending", "dispatched"])
      .$if(observed.type === "run.interrupt" && observed.runId !== null, (query) =>
        query.where((expression) =>
          expression.or([
            expression("predecessor.type", "!=", "run.steer"),
            expression("predecessor.runId", "is distinct from", observed.runId),
          ]),
        ),
      )
      .where(
        sql<boolean>`(predecessor.created_at, predecessor.id) < (candidate.created_at, candidate.id)`,
      )
      .executeTakeFirst();
    if (predecessor) return null;
  }
  let workIsAvailable = true;
  let restart: RunAttemptRow | undefined;
  if (observed.type === "run.execute") {
    if (!run || !observed.threadId || run.threadId !== observed.threadId) {
      throw new OpensteerError({
        code: "conflict",
        message: "The Run cannot enter starting from its current state",
      });
    }
    // Another dispatcher may have won this pending Command after we observed
    // it. Claim is a competing lease operation, so that race is an ordinary
    // miss rather than a malformed state.
    if (run.status !== "queued") return null;
    const work = await transaction
      .selectFrom("threadWorkInputs")
      .select("messageId")
      .where("messageId", "=", run.seedInputId)
      .where((expression) =>
        expression.or([
          expression("state", "=", "pending"),
          expression.and([expression("state", "=", "claimed"), expression("runId", "=", run.id)]),
        ]),
      )
      .executeTakeFirst();
    // A cancelled seed still has a reserved Run and command to settle. Refusing
    // the claim here would leave both pending forever after authority revocation.
    // A restart's attempt starts with the messages steered into it; its seed
    // was delivered to the attempt it replaces.
    restart = await pendingReplacementAttempt(transaction, run.id);
    workIsAvailable = work !== undefined || restart !== undefined;
    const predecessor = await transaction
      .selectFrom("runs")
      .select("id")
      .where("threadId", "=", observed.threadId)
      .where("runOrdinal", "<", run.runOrdinal)
      .where("status", "in", nonTerminalRunStatuses)
      .executeTakeFirst();
    if (predecessor) return null;
  }
  let terminalFailure =
    (observed.type === "run.execute" || observed.type === "trigger.execute") &&
    (!observed.threadId ||
      !observed.environmentId ||
      !(await threadExecutionIsAvailableToUser(
        transaction,
        observed.threadId,
        observed.requestedBy,
      )))
      ? "Execution authority for this Thread is no longer available."
      : undefined;
  if (observed.type === "run.execute") {
    if (!run) throw new Error("Claim Run lock was not established");
    await lockThreadRow(transaction, run.threadId);
    const queue = await transaction
      .selectFrom("threads")
      .select("inputQueuePaused")
      .where("id", "=", run.threadId)
      .executeTakeFirstOrThrow();
    if (queue.inputQueuePaused) return null;
  }
  let terminalFailureInput: "seed-input" | undefined;
  if (
    run &&
    observed.type === "run.execute" &&
    !terminalFailure &&
    !(await channelRunAuthorityIsCurrent(transaction, run.id))
  ) {
    terminalFailure = "Messaging access changed before this Run could start.";
    terminalFailureInput = "seed-input";
  }
  if (observed.type === "run.execute" && !terminalFailure && !workIsAvailable) {
    terminalFailure = "The queued work item is no longer available.";
    terminalFailureInput = "seed-input";
  }
  if (observed.type === "run.steer" && run) {
    const steer = await transaction
      .selectFrom("threadInputs")
      .select(["messageId", "runId", "state"])
      .where("steerCommandId", "=", observed.id)
      .executeTakeFirst();
    if (steer && !(await channelInputAuthorityIsCurrent(transaction, steer.messageId))) {
      terminalFailure = "Messaging access changed before this message could be delivered.";
    }
    await lockThreadRow(transaction, run.threadId);
    const currentThread = await transaction
      .selectFrom("threads")
      .select(["inputQueuePaused", "status"])
      .where("id", "=", run.threadId)
      .executeTakeFirstOrThrow();
    if (
      !steer ||
      steer.state !== "claimed" ||
      steer.runId !== run.id ||
      run.status !== "running" ||
      run.threadId !== observed.threadId ||
      run.environmentId !== observed.environmentId ||
      currentThread.inputQueuePaused ||
      currentThread.status === "archived" ||
      !(await runHasActiveGrant(transaction, run.id)) ||
      !(await threadExecutionIsAvailableToUser(transaction, run.threadId, observed.requestedBy))
    ) {
      terminalFailure =
        "The Run can no longer accept this message under its original execution authority.";
    }
  }
  if (run && observed.type === "run.execute") {
    await lockRunProjectionRows(transaction, {
      runIds: [run.id],
      threadIds: [run.threadId],
    });
    if (!terminalFailure && !(await taskQuestionNoticeIsPending(transaction, run.seedInputId))) {
      terminalFailure = "The task question was already answered or withdrawn.";
      terminalFailureInput = "seed-input";
    }
  }
  let claim = transaction
    .updateTable("commands")
    .set((expressions) => ({
      attempts: expressions("attempts", "+", 1),
      dispatcherId,
      status: "dispatched" as const,
      updatedAt: new Date(),
    }))
    .where("id", "=", observed.id)
    .where("status", "=", "pending");
  claim = observed.runId
    ? claim.where("runId", "=", observed.runId)
    : claim.where("runId", "is", null);
  const command = await claim.returningAll().executeTakeFirst();
  if (!command) return null;

  // Control commands target an already active Run and must not rewrite its
  // state. Only dispatching the original turn transitions queued -> starting.
  const events: AgentEvent[] = [];
  if (command.type === "run.execute" && !terminalFailure) {
    if (!run || run.status !== "queued") {
      throw new Error("Claimed Run state changed");
    }
    events.push(
      ...(restart?.reason === "recovery"
        ? []
        : restart
          ? await claimConversationBatch(
              transaction,
              run.id,
              await restartBatchCapacity(transaction, run.id),
            )
          : await claimRunInputBatch(transaction, run.id)),
    );
    const started = await transaction
      .updateTable("runs")
      .set({
        status: "starting",
      })
      .where("id", "=", run.id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (started.numUpdatedRows !== 1n) {
      throw new OpensteerError({
        code: "conflict",
        message: "The Run could not enter starting atomically",
      });
    }
    events.push(
      await appendHostDeploymentEvent(transaction, {
        data: {
          status: "starting",
        },
        environmentId: run.environmentId,
        runId: run.id,
        threadId: run.threadId,
        type: "run.status",
      }),
    );
    events.push(...(await projectThreadState(transaction, run.threadId)));
    events.push(...(await assignmentActivityEventsForRun(transaction, run.id)));
  }
  return {
    command,
    events,
    ...(terminalFailure
      ? {
          terminalFailure,
        }
      : {}),
    ...(terminalFailureInput
      ? {
          terminalFailureInput,
        }
      : {}),
  };
}
const runnerControlCommandTypes = [
  "node.stop",
  "request.respond",
  "run.interrupt",
  "run.restart",
  "run.steer",
] as const;
type RunnerControlCommandType = (typeof runnerControlCommandTypes)[number];
interface SucceededCommand {
  readonly events: readonly AgentEvent[];
  readonly revokedGrants: readonly RevokedRunGrant[];
}
async function succeedCommandInTransaction(
  transaction: Transaction<DatabaseSchema>,
  commandId: CommandRow["id"],
): Promise<SucceededCommand> {
  const none: SucceededCommand = {
    events: [],
    revokedGrants: [],
  };
  const observed = await transaction
    .selectFrom("commands")
    .leftJoin("threads", "threads.id", "commands.threadId")
    .select([
      "commands.payload",
      "commands.runId",
      "commands.type",
      "threads.environmentId",
      "threads.id as threadId",
    ])
    .where("commands.id", "=", commandId)
    .executeTakeFirst();
  if (!observed) return none;
  if (observed.runId) {
    const run = await transaction
      .selectFrom("runs")
      .select("id")
      .where("id", "=", observed.runId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!run) return none;
  }
  if (observed.threadId) await lockThreadRow(transaction, observed.threadId);
  const responsePayload =
    observed.type === "request.respond" ? requestResponseCommandPayload(observed.payload) : null;
  // An accepted answer can be what lets the Run work again, so its projection
  // and the person's waiting messages are fenced before the Request.
  if (responsePayload && observed.runId && observed.threadId)
    await lockRunProjectionRows(transaction, {
      runIds: [observed.runId],
      threadIds: [observed.threadId],
    });
  const pending =
    responsePayload && observed.runId
      ? await transaction
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", responsePayload.requestId)
          .where("originatingRunId", "=", observed.runId)
          .where("responseCommandId", "=", commandId)
          .where("status", "=", "pending")
          .forNoKeyUpdate()
          .executeTakeFirst()
      : null;
  if (responsePayload && !pending) return none;
  const command = await transaction
    .selectFrom("commands")
    .select(["id", "status", "type"])
    .where("id", "=", commandId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!command || !["dispatched", "unknown"].includes(command.status)) return none;
  const now = new Date();
  await transaction
    .updateTable("commands")
    .set({
      lastError: null,
      status: "succeeded",
      updatedAt: now,
    })
    .where("id", "=", commandId)
    .where("status", "in", ["dispatched", "unknown"])
    .execute();
  if (responsePayload && pending && observed.runId && observed.threadId && observed.environmentId) {
    const request = requestFromRow(pending);
    const resolved = await transaction
      .updateTable("requests")
      .set({
        resolvedAt: now,
        resolvedBy:
          responsePayload.settlementProvenance && "kind" in responsePayload.settlementProvenance
            ? null
            : responsePayload.requestedBy,
        settlementProvenance: responsePayload.settlementProvenance
          ? jsonValue(responsePayload.settlementProvenance)
          : null,
        response: jsonValue(responsePayload.response),
        responseCommandId: null,
        status: requestStatusFromValidatedResponse(request, responsePayload.response),
      })
      .where("id", "=", responsePayload.requestId)
      .where("originatingRunId", "=", observed.runId)
      .where("responseCommandId", "=", commandId)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    if (!resolved) return none;
    if (!responsePayload.settlementProvenance || !("kind" in responsePayload.settlementProvenance))
      await recordPersonWaited(transaction, observed.runId);
    const events: AgentEvent[] = [
      await appendHostDeploymentEvent(transaction, {
        data: {
          request: ResolvedRequestSchema.parse(requestFromRow(resolved)),
        },
        environmentId: observed.environmentId,
        runId: observed.runId,
        threadId: observed.threadId,
        type: "request.resolved",
      }),
    ];
    // The engine has its last answer: the Run is working again, which is
    // also when the person's messages written meanwhile can reach it.
    const stillAsking = await transaction
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", observed.runId)
      .where("mode", "=", "live")
      .where("status", "=", "pending")
      .executeTakeFirst();
    let revokedGrants: readonly RevokedRunGrant[] = [];
    if (!stillAsking) {
      const resumed = await transaction
        .updateTable("runs")
        .set({
          status: "running",
        })
        .where("id", "=", observed.runId)
        .where("status", "=", "waiting")
        .executeTakeFirst();
      if (resumed.numUpdatedRows === 1n) {
        const handed = await deliverConversationInputsInTransaction(transaction, observed.runId);
        events.push(...handed.events);
        revokedGrants = handed.revokedGrants;
        events.push(...(await projectThreadState(transaction, observed.threadId)));
      }
    }
    events.push(...(await assignmentActivityEventsForRun(transaction, observed.runId)));
    return {
      events,
      revokedGrants,
    };
  }
  if (
    observed.type !== "run.steer" ||
    !observed.runId ||
    !observed.threadId ||
    !observed.environmentId
  )
    return none;
  const steer = await transaction
    .selectFrom("threadInputs")
    .select("messageId")
    .where("steerCommandId", "=", commandId)
    .where("runId", "=", observed.runId)
    .executeTakeFirst();
  if (!steer) return none;
  const inputRow = await transaction
    .updateTable("threadInputs")
    .set({
      deliveredAt: now,
      state: "delivered",
      updatedAt: now,
    })
    .where("messageId", "=", steer.messageId)
    .where("state", "in", ["claimed", "unknown"])
    .returningAll()
    .executeTakeFirst();
  if (!inputRow) return none;
  const input = threadInputFromRow(inputRow);
  return {
    events: [
      await appendHostDeploymentEvent(transaction, {
        data: {
          input,
        },
        environmentId: observed.environmentId,
        runId: input.runId,
        threadId: observed.threadId,
        type: "thread-input.updated",
      }),
    ],
    revokedGrants: [],
  };
}
function requestResponseDispatchConflict(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: "The Request response reservation was cancelled before dispatch",
  });
}
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    reject,
    resolve,
  };
}
export function assertRequestResponse(
  request: Request,
  response: RequestResponse,
  allowSecrets: boolean,
): void {
  if (request.status !== "pending") {
    throw new OpensteerError({
      code: "conflict",
      message: "Request is already resolved",
    });
  }
  if (request.presentation.kind !== response.kind) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Response kind does not match the pending Request",
    });
  }
  if (response.kind === "choice") {
    if (
      request.presentation.kind !== "choice" ||
      !request.presentation.options.some((option) => option.id === response.optionId)
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Unknown Request option",
      });
    }
    return;
  }
  if (response.kind === "external") return;
  if (request.presentation.kind !== "form") {
    throw new OpensteerError({
      code: "bad_request",
      message: "Request does not accept a form",
    });
  }
  const fields = new Map(request.presentation.fields.map((field) => [field.id, field]));
  if (Object.keys(response.answers).length !== fields.size) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Every requested field must be answered exactly once",
    });
  }
  for (const [fieldId, answers] of Object.entries(response.answers)) {
    const field = fields.get(fieldId);
    if (!field) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Unknown form field ${fieldId}`,
      });
    }
    if (field.secret && !allowSecrets) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Secret answers require the live response channel",
      });
    }
    if (answers.length === 0) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Form field ${fieldId} requires an answer`,
      });
    }
    if (!field.multiSelect && answers.length > 1) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Form field ${fieldId} accepts only one answer`,
      });
    }
    if (
      field.choices &&
      answers.some((answer) => !field.choices?.some((choice) => choice.value === answer))
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Form field ${fieldId} contains an unsupported choice`,
      });
    }
  }
}
function redactSecretRequestAnswers(request: Request, response: RequestResponse): RequestResponse {
  if (request.presentation.kind !== "form" || response.kind !== "form") return response;
  const secretFieldIds = new Set(
    request.presentation.fields.filter((field) => field.secret).map((field) => field.id),
  );
  if (secretFieldIds.size === 0) return response;
  return {
    answers: Object.fromEntries(
      Object.entries(response.answers).map(([fieldId, answers]) => [
        fieldId,
        secretFieldIds.has(fieldId) ? [] : answers,
      ]),
    ),
    kind: "form",
  };
}

/**
 * Runner ACKs only retain the redacted form response. Admission already validated the
 * original plaintext response before sealing it, so terminalization must not require
 * redacted secret answers to be present again.
 */
function requestStatusFromValidatedResponse(
  request: Request,
  response: RequestResponse,
): "fulfilled" | "declined" {
  if (response.kind !== "choice" || request.presentation.kind !== "choice") return "fulfilled";
  const option = request.presentation.options.find(({ id }) => id === response.optionId)!;
  return requestOptionDeclines(option) ? "declined" : "fulfilled";
}

/**
 * The admission every Thread turn shares: personal ownership and execution authority, taken under the documented
 * declared lock order in ./lock-order.ts.
 */
function canonicalRunnerControlInput(input: RunnerControlInput): Readonly<Record<string, unknown>> {
  switch (input.type) {
    case "request.respond":
      return {
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        requestedBy: input.requestedBy,
        responseFingerprint: input.sealedResponse.requestFingerprint,
        ...(input.agentResponder
          ? {
              agentResponder: AgentRequestResponderSchema.parse(input.agentResponder),
            }
          : {}),
        runId: input.runId,
        threadId: input.threadId,
        type: input.type,
      };
    case "run.interrupt":
      return {
        ...(input.keepQueueRunning ? { keepQueueRunning: true } : {}),
        idempotencyKey: input.idempotencyKey,
        requestedBy: input.requestedBy,
        runId: input.runId,
        threadId: input.threadId,
        type: input.type,
      };
  }
}
function omitRequestResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const {
    response: _response,
    settlementProvenance: _provenance,
    ...safe
  } = payload as Readonly<Record<string, unknown>>;
  return safe;
}
function requestResponseCommandPayload(payload: unknown): {
  readonly requestId: RequestId;
  readonly requestedBy: UserId;
  readonly response: RequestResponse;
  readonly settlementProvenance?:
    z.infer<typeof RequestAgentAnswererSchema> | z.infer<typeof RequestSettlementProvenanceSchema>;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new OpensteerError({
      code: "internal",
      message: "Request response command is invalid",
    });
  }
  const value = payload as Readonly<Record<string, unknown>>;
  return {
    ...(value.settlementProvenance
      ? {
          settlementProvenance: RequestAgentAnswererSchema.or(
            RequestSettlementProvenanceSchema,
          ).parse(value.settlementProvenance),
        }
      : {}),
    requestId: RequestIdSchema.parse(value.requestId),
    requestedBy: UserIdSchema.parse(value.requestedBy),
    response: RequestResponseSchema.parse(value.response),
  };
}
function dispatchFailure(publicMessage: string): {
  readonly code: "dispatch_failed";
  readonly message: string;
  readonly retryable: false;
  readonly status: "failed";
} {
  const message = publicMessage.trim().slice(0, 500);
  return {
    code: "dispatch_failed",
    message: message || "The AI engine could not be started.",
    retryable: false,
    status: "failed",
  };
}
export async function enqueueRunnerControl(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: RunnerControlInput,
): Promise<{
  readonly command: CommandRow;
  readonly events: readonly AgentEvent[];
  readonly revokedGrants: readonly RevokedRunGrant[];
  readonly wasDuplicate: boolean;
}> {
  if (input.type === "request.respond") {
    if (input.agentResponder && input.agentResponder.authority.userId !== input.requestedBy)
      throw new OpensteerError({
        code: "forbidden",
        message: "Request is unavailable",
      });
    requireBoundedIdentity(
      input.sealedResponse.requestFingerprint,
      "Request response fingerprint",
      255,
    );
  }
  return withPersonalTransaction(database, (transaction) =>
    enqueueRunnerControlInTransaction(transaction, links, input),
  );
}
export async function enqueueRunnerControlInTransaction(
  transaction: Transaction<DatabaseSchema>,
  links: ChannelLinks,
  input: RunnerControlInput,
) {
  const controlPayload = canonicalRunnerControlInput(input);
  await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
  if (input.type === "run.interrupt")
    await lockThreadCaller(transaction, input.authority, [input.runId]);
  if (input.type === "request.respond" && input.agentResponder)
    await lockThreadCaller(transaction, input.agentResponder.authority, [input.runId]);
  const existing = await findCommandByIdempotency(
    transaction,
    input.requestedBy,
    input.idempotencyKey,
  );
  if (existing) {
    const comparableExistingPayload =
      input.type === "request.respond" ? omitRequestResponse(existing.payload) : existing.payload;
    if (
      existing.type !== input.type ||
      existing.threadId !== input.threadId ||
      !isDeepStrictEqual(comparableExistingPayload, controlPayload)
    ) {
      throw idempotencyConflict(input.idempotencyKey);
    }
    if (input.type === "run.interrupt") {
      await assertThreadCaller(transaction, input.authority, {
        threadId: input.threadId,
      });
    }
    if (input.type === "request.respond" && input.agentResponder)
      await assertAgentRequestTarget(transaction, input.agentResponder.authority, input.threadId);
    return {
      command: existing,
      events: [],
      revokedGrants: [],
      wasDuplicate: true,
    };
  }
  const thread = await transaction
    .selectFrom("threads")
    .select(["environmentId", "id", "purpose", "status"])
    .where("id", "=", input.threadId)
    .executeTakeFirst();
  if (!thread)
    throw new OpensteerError({
      code: "not_found",
      message: "Thread not found",
    });
  let targetRunStatus: RunRow["status"] | null = null;
  let targetRunBound = false;
  {
    const run = await transaction
      .selectFrom("runs")
      .select(["bindingGeneration", "id", "requestedBy", "status", "threadId"])
      .where("id", "=", input.runId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!run || run.threadId !== input.threadId) {
      throw new OpensteerError({
        code: "not_found",
        message: "Run not found for thread",
      });
    }
    if (["completed", "failed", "interrupted"].includes(run.status)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Run is already terminal",
      });
    }
    targetRunStatus = run.status;
    targetRunBound = run.bindingGeneration !== null;
    await requirePersonalOwner(transaction, input.requestedBy);
    if (input.type === "request.respond" && run.status !== "waiting") {
      throw new OpensteerError({
        code: "conflict",
        message: "Run is not awaiting a Request",
      });
    }
    if (input.type === "request.respond" && !(await runHasActiveGrant(transaction, run.id))) {
      throw new OpensteerError({
        code: "conflict",
        message: "This Run was stopped, so it no longer takes answers",
      });
    }
  }
  if (input.type === "run.interrupt")
    await assertThreadCaller(transaction, input.authority, {
      threadId: input.threadId,
    });
  if (input.type === "request.respond" && input.agentResponder)
    await assertAgentRequestTarget(transaction, input.agentResponder.authority, input.threadId);
  const controlEvents: AgentEvent[] = [];
  // A Run the dispatcher has not bound yet has never reached a Runner, and
  // under this lock it never will: binding requires `starting`. It ends
  // here, as a queued Run does, rather than waiting on an interrupt the
  // Runner would answer for a Run it does not hold.
  const endsHere =
    input.type === "run.interrupt" &&
    (targetRunStatus === "queued" || (targetRunStatus === "starting" && !targetRunBound));
  if (input.type === "run.interrupt") {
    await lockThreadRow(transaction, thread.id);
    if (thread.purpose === "voice") {
      // Stopping a conversation's reply ends that exchange; the conversation
      // stays open, so the person's next message is answered without a Resume.
      await lockRunProjectionRows(transaction, {
        runIds: [input.runId],
        threadIds: [thread.id],
      });
      controlEvents.push(...(await settleStoppedConversationInputs(transaction, input.runId)));
    } else if (!input.keepQueueRunning) {
      await transaction
        .updateTable("threads")
        .set({
          inputQueuePaused: true,
          inputQueuePausedBy: sql<UserId>`case
              when input_queue_paused then input_queue_paused_by
              else ${input.requestedBy}
            end`,
          updatedAt: new Date(),
        })
        .where("id", "=", thread.id)
        .execute();
      controlEvents.push(
        await appendHostDeploymentEvent(transaction, {
          data: {
            paused: true,
          },
          environmentId: thread.environmentId,
          runId: null,
          threadId: thread.id,
          type: "thread.input-queue-updated",
        }),
      );
    }
    // Finalizing a Run that ends here settles its Requests and Thread state.
    if (!endsHere) {
      // Nothing a stopped Run asked for can be answered any more.
      controlEvents.push(
        ...(await cancelPending(transaction, {
          reason: "run-ended",
          resolvedAt: new Date(),
          runId: input.runId,
        })),
      );
      // With nothing left to answer, the Run is running again until it stops.
      await transaction
        .updateTable("runs")
        .set({
          status: "running",
        })
        .where("id", "=", input.runId)
        .where("status", "=", "waiting")
        .execute();
      controlEvents.push(...(await projectThreadState(transaction, thread.id)));
    }
  }
  const actorPrincipalId = await principalIdForUser(transaction, input.requestedBy);
  let reservedRequest: {
    readonly requestId: RequestId;
    readonly response: RequestResponse;
  } | null = null;
  if (input.type === "request.respond") {
    const pending = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", input.requestId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (
      !pending ||
      pending.status !== "pending" ||
      pending.responseCommandId !== null ||
      pending.mode !== "live" ||
      pending.originatingRunId !== input.runId ||
      pending.originatingThreadId !== input.threadId
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Response does not match the Run's pending Request",
      });
    }
    const request = requestFromRow(pending);
    await requirePersonalOwner(transaction, input.requestedBy);
    if (input.agentResponder) assertAgentRequestAnswer(request, input.agentResponder);
    if (
      !input.agentResponder &&
      request.requiredActor === "requester" &&
      request.requestedBy !== input.requestedBy
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Only the member this Request targets may answer it",
      });
    }
    const containsSecrets = hasSecretRequestFields(request);
    assertRequestResponse(request, input.response, containsSecrets);
    reservedRequest = {
      requestId: input.requestId,
      response: redactSecretRequestAnswers(request, input.response),
    };
  }
  const command = await persistRunnerControlCommand(transaction, {
    actorPrincipalId,
    authoritySource: jsonValue(
      input.type === "request.respond" && input.agentResponder
        ? {
            kind: "thread-agent",
            runId: input.agentResponder.authority.scope.runId,
            threadId: input.agentResponder.authority.scope.threadId,
            userId: input.requestedBy,
          }
        : {
            kind: "user-session",
            userId: input.requestedBy,
          },
    ),
    dispatcherId: null,
    environmentId: thread.environmentId,
    id: createId("command"),
    idempotencyKey: input.idempotencyKey,
    lastError: null,
    payload: jsonValue(
      reservedRequest
        ? {
            ...controlPayload,
            response: reservedRequest.response,
            settlementProvenance:
              input.type === "request.respond" && input.agentResponder
                ? {
                    kind: "agent",
                    runId: input.agentResponder.authority.scope.runId,
                    threadId: input.agentResponder.authority.scope.threadId,
                    title: (
                      await transaction
                        .selectFrom("threads")
                        .select("title")
                        .where("id", "=", input.agentResponder.authority.scope.threadId)
                        .executeTakeFirstOrThrow()
                    ).title,
                  }
                : await readRequestSettlementActor(
                    transaction,
                    input.requestedBy,
                    input.type === "request.respond" ? input.settlementSessionId : undefined,
                  ),
          }
        : controlPayload,
    ),
    ...(input.type === "request.respond"
      ? {
          encryptedRequestResponse: input.sealedResponse.envelope,
          requestResponseKeyVersion: input.sealedResponse.keyVersion,
        }
      : {}),
    requestedBy: input.requestedBy,
    runId: input.runId,
    status: "pending",
    threadId: input.threadId,
    type: input.type,
  });
  if (reservedRequest) {
    const reserved = await transaction
      .updateTable("requests")
      .set({
        responseCommandId: command.id,
      })
      .where("id", "=", reservedRequest.requestId)
      .where("status", "=", "pending")
      .where("responseCommandId", "is", null)
      .executeTakeFirst();
    if (reserved.numUpdatedRows !== 1n) {
      throw new OpensteerError({
        code: "conflict",
        message: "Request response is already in flight",
      });
    }
  }
  if (endsHere) {
    const events = await finalizeRunTransaction(transaction, {
      completedAt: new Date(),
      links,
      source: "host",
      queuedInputCancellation: "activation-input",
      runId: input.runId,
      status: "interrupted",
    });
    const interruptedCommand = await transaction
      .updateTable("commands")
      .set({
        lastError: null,
        status: "succeeded",
        updatedAt: new Date(),
      })
      .where("id", "=", command.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      command: interruptedCommand,
      events: [...controlEvents, ...events],
      revokedGrants: [],
      wasDuplicate: false,
    };
  }
  // Stopping ends what the Run may do now, not only once the Runner has
  // wound it down: its tools stop working while the interrupt is delivered.
  const revokedGrants =
    input.type === "run.interrupt"
      ? await revokeRunGrants(transaction, [input.runId], "stopped")
      : [];
  if (reservedRequest)
    await requestSettlementActor(
      transaction,
      input.requestedBy,
      input.type === "request.respond" ? input.settlementSessionId : undefined,
    );
  if (input.type === "request.respond" && input.agentResponder)
    await assertAgentRequestTarget(transaction, input.agentResponder.authority, input.threadId);
  return {
    command,
    events: controlEvents,
    revokedGrants,
    wasDuplicate: false,
  };
}
export async function claimNextCommand(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
  dispatcherId: string,
): Promise<ClaimedCommand | null> {
  return withPersonalTransaction(database, async (transaction) => {
    const candidate = await transaction
      .selectFrom("commands")
      .leftJoin("threads", "threads.id", "commands.threadId")
      .select([
        "commands.environmentId as environmentId",
        "commands.id as id",
        "commands.payload as payload",
        "commands.requestedBy as requestedBy",
        "commands.runId as runId",
        "commands.threadId as threadId",
        "commands.type as type",
      ])
      .where("commands.environmentId", "=", environmentId)
      .where("commands.status", "=", "pending")
      .where((expression) =>
        expression.or([
          expression("commands.type", "!=", "run.execute"),
          expression("threads.inputQueuePaused", "=", false),
        ]),
      )
      .where((expression) =>
        expression.or([
          expression("commands.type", "!=", "run.execute"),
          expression.not(
            expression.exists(
              expression
                .selectFrom("runs as predecessor")
                .innerJoin("runs as candidate", "candidate.threadId", "predecessor.threadId")
                .select("predecessor.id")
                .whereRef("candidate.id", "=", "commands.runId")
                .whereRef("predecessor.runOrdinal", "<", "candidate.runOrdinal")
                .where("predecessor.status", "in", nonTerminalRunStatuses),
            ),
          ),
        ]),
      )
      .orderBy("commands.createdAt", "asc")
      .executeTakeFirst();
    if (!candidate) return null;
    return claimObservedCommand(transaction, candidate, dispatcherId);
  });
}

/**
 * Delivers one live Request response across a transactional send boundary.
 *
 * The transaction holds the fences in ./lock-order.ts until the Runner
 * reports that it accepted the response.
 * The receipt callback then waits for this transaction to commit before the
 * Runner acknowledgement is released to the dispatcher. Cancellation either
 * wins before the envelope is opened or waits until the accepted response is
 * durable; it can never commit in the middle of secret delivery.
 */
export async function dispatchRequestResponse(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  send: (beforeAck: () => Promise<void>) => Promise<void>,
): Promise<SucceededCommand> {
  const committed = deferred<void>();
  // A send failure can happen before the Runner ever invokes beforeAck. Keep
  // both sides observed so neither a rollback nor a rejected commit gate can
  // become an unhandled rejection.
  void committed.promise.catch(() => undefined);
  let sendPromise: Promise<void> | undefined;
  try {
    // Non-retrying: the Runner send/acknowledgement gate cannot safely be replayed.
    const events = await database.transaction().execute(async (transaction) => {
      await lockDeploymentEvents(transaction);
      const observed = await transaction
        .selectFrom("commands")
        .innerJoin("requests", "requests.responseCommandId", "commands.id")
        .select([
          "commands.requestedBy as respondingUserId",
          "commands.payload as responsePayload",
          "commands.runId",
          "commands.threadId",
          "requests.id as requestId",
          "requests.originatingRunId",
          "requests.originatingThreadId",
        ])
        .where("commands.id", "=", commandId)
        .where("commands.type", "=", "request.respond")
        .executeTakeFirst();
      if (
        !observed ||
        !observed.runId ||
        !observed.threadId ||
        observed.runId !== observed.originatingRunId ||
        observed.threadId !== observed.originatingThreadId
      ) {
        throw requestResponseDispatchConflict();
      }
      const payload = observed.responsePayload as Readonly<Record<string, unknown>>;
      const agentResponder = payload.agentResponder
        ? AgentRequestResponderSchema.parse(payload.agentResponder)
        : undefined;
      if (agentResponder && agentResponder.authority.userId !== observed.respondingUserId)
        throw requestResponseDispatchConflict();
      if (agentResponder)
        await lockThreadCaller(transaction, agentResponder.authority, [observed.runId], true);
      const run = await transaction
        .selectFrom("runs")
        .select(["requestedBy", "status", "threadId"])
        .where("id", "=", observed.runId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !run ||
        run.threadId !== observed.threadId ||
        !["starting", "running", "waiting"].includes(run.status) ||
        !(await runHasActiveGrant(transaction, observed.runId))
      ) {
        throw requestResponseDispatchConflict();
      }
      await requirePersonalOwner(transaction, observed.respondingUserId);
      if (agentResponder)
        await assertAgentRequestTarget(transaction, agentResponder.authority, observed.threadId, {
          admitted: true,
        });
      await lockThreadRow(transaction, observed.threadId);
      await lockRunProjectionRows(transaction, {
        runIds: [observed.runId],
        threadIds: [observed.threadId],
      });
      const requestRow = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", observed.requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const command = await transaction
        .selectFrom("commands")
        .select(["id", "requestedBy", "runId", "status", "threadId", "type"])
        .where("id", "=", commandId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !requestRow ||
        requestRow.mode !== "live" ||
        requestRow.status !== "pending" ||
        requestRow.responseCommandId !== commandId ||
        requestRow.originatingRunId !== observed.runId ||
        requestRow.originatingThreadId !== observed.threadId ||
        !command ||
        command.type !== "request.respond" ||
        command.status !== "dispatched" ||
        command.runId !== observed.runId ||
        command.threadId !== observed.threadId
      ) {
        throw requestResponseDispatchConflict();
      }
      const request = requestFromRow(requestRow);
      if (agentResponder) assertAgentRequestAnswer(request, agentResponder);
      if (
        !agentResponder &&
        request.requiredActor === "requester" &&
        request.requestedBy !== command.requestedBy
      ) {
        throw requestResponseDispatchConflict();
      }
      const accepted = deferred<void>();
      sendPromise = send(async () => {
        accepted.resolve();
        await committed.promise;
      });
      void sendPromise.catch(accepted.reject);
      await accepted.promise;
      if (agentResponder)
        await assertAgentRequestTarget(transaction, agentResponder.authority, observed.threadId, {
          admitted: true,
        });
      const succeeded = await succeedCommandInTransaction(transaction, commandId);
      if (succeeded.events.filter((event) => event.type === "request.resolved").length !== 1) {
        throw new OpensteerError({
          code: "internal",
          message: "Accepted Request response did not produce its durable resolution",
        });
      }
      return succeeded;
    });
    committed.resolve();
    // Reaching the commit proves that the Runner receipt arrived. A caller
    // abort racing after that receipt cannot turn the durable response back
    // into an uncertain command.
    await sendPromise?.catch(() => undefined);
    return events;
  } catch (error) {
    committed.reject(error);
    await sendPromise?.catch(() => undefined);
    throw error;
  }
}

/** Keep messaging admission live until the Runner accepts the exact command. */
export async function dispatchChannelCommand(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  send: (beforeAck: () => Promise<void>) => Promise<void>,
): Promise<SucceededCommand> {
  const committed = deferred<void>();
  void committed.promise.catch(() => undefined);
  let sendPromise: Promise<void> | undefined;
  try {
    // Non-retrying: the Runner send/acknowledgement gate cannot safely be replayed.
    const events = await database.transaction().execute(async (transaction) => {
      await lockDeploymentEvents(transaction);
      const observed = await transaction
        .selectFrom("commands")
        .innerJoin("threads", "threads.id", "commands.threadId")
        .select(["commands.runId", "commands.type", "commands.authoritySource"])
        .where("commands.id", "=", commandId)
        .where("commands.status", "=", "dispatched")
        .executeTakeFirst();
      if (
        !observed?.runId ||
        observed.authoritySource.kind !== "channel-ingress" ||
        (observed.type !== "run.execute" && observed.type !== "run.steer")
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Messaging command is no longer dispatchable",
        });
      }
      const run = await transaction
        .selectFrom("runs")
        .select(["status", "threadId", "requestedBy"])
        .where("id", "=", observed.runId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      if (
        observed.type === "run.execute"
          ? run.status !== "starting"
          : !["running", "waiting"].includes(run.status)
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Messaging Run is no longer active",
        });
      }
      const steer =
        observed.type === "run.steer"
          ? await transaction
              .selectFrom("threadInputs")
              .select("messageId")
              .where("steerCommandId", "=", commandId)
              .executeTakeFirst()
          : null;
      const authorized =
        observed.type === "run.execute"
          ? await channelRunAuthorityIsCurrent(transaction, observed.runId)
          : steer !== undefined &&
            steer !== null &&
            (await channelInputAuthorityIsCurrent(transaction, steer.messageId));
      if (
        !authorized ||
        !(await threadExecutionIsAvailableToUser(transaction, run.threadId, run.requestedBy))
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Messaging access changed before dispatch",
        });
      }
      await lockThreadRow(transaction, run.threadId);
      const command = await transaction
        .selectFrom("commands")
        .select("status")
        .where("id", "=", commandId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      if (command.status !== "dispatched") {
        throw new OpensteerError({
          code: "conflict",
          message: "Messaging command is no longer dispatchable",
        });
      }
      const accepted = deferred<void>();
      sendPromise = send(async () => {
        accepted.resolve();
        await committed.promise;
      });
      void sendPromise.catch(accepted.reject);
      await accepted.promise;
      return succeedCommandInTransaction(transaction, commandId);
    });
    committed.resolve();
    await sendPromise?.catch(() => undefined);
    return events;
  } catch (error) {
    committed.reject(error);
    await sendPromise?.catch(() => undefined);
    throw error;
  }
}
export async function listPendingCommands(
  database: Kysely<DatabaseSchema>,
  limit = 500,
): Promise<readonly PendingCommandRow[]> {
  return database
    .selectFrom("commands")
    .leftJoin("threads", "threads.id", "commands.threadId")
    .leftJoin("runs", "runs.id", "commands.runId")
    .selectAll("commands")
    .select("runs.harnessInstanceId as runHarnessInstanceId")
    .where("commands.status", "=", "pending")
    .where((expression) =>
      expression.or([
        expression("commands.type", "!=", "run.execute"),
        expression("threads.inputQueuePaused", "=", false),
      ]),
    )
    .where((expression) =>
      expression.or([
        expression("commands.type", "!=", "run.execute"),
        expression.not(
          expression.exists(
            expression
              .selectFrom("runs as predecessor")
              .innerJoin("runs as candidate", "candidate.threadId", "predecessor.threadId")
              .select("predecessor.id")
              .whereRef("candidate.id", "=", "commands.runId")
              .whereRef("predecessor.runOrdinal", "<", "candidate.runOrdinal")
              .where("predecessor.status", "in", nonTerminalRunStatuses),
          ),
        ),
      ]),
    )
    .orderBy("commands.createdAt", "asc")
    .limit(Math.min(Math.max(limit, 1), 20_000))
    .execute();
}
export async function claimCommand(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  dispatcherId: string,
): Promise<ClaimedCommand | null> {
  return withPersonalTransaction(database, async (transaction) => {
    const observed = await transaction
      .selectFrom("commands")
      .select(["environmentId", "id", "payload", "requestedBy", "runId", "threadId", "type"])
      .where("id", "=", commandId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (!observed) return null;
    return claimObservedCommand(transaction, observed, dispatcherId);
  });
}
export async function loadSteerDispatchInput(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
): Promise<{
  readonly message: Message;
  readonly run: Run;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}> {
  const row = await database
    .selectFrom("commands")
    .innerJoin("threadInputs", "threadInputs.steerCommandId", "commands.id")
    .innerJoin("messages", "messages.id", "threadInputs.messageId")
    .selectAll("messages")
    .select(["commands.runId as targetRunId", "commands.threadId as targetThreadId"])
    .where("commands.id", "=", commandId)
    .where("commands.type", "=", "run.steer")
    .executeTakeFirst();
  if (!row?.targetRunId || !row.targetThreadId) {
    throw new OpensteerError({
      code: "not_found",
      message: "Steer input not found",
    });
  }
  const runRow = await database
    .selectFrom("runs")
    .selectAll()
    .select(runDeliverySelection)
    .where("id", "=", row.targetRunId)
    .executeTakeFirstOrThrow();
  return {
    message: messageFromRow(row),
    run: runFromRow(runRow),
    runId: row.targetRunId,
    threadId: row.targetThreadId,
  };
}
export async function retryCommand(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  commandId: CommandRow["id"],
  error: unknown,
): Promise<readonly AgentEvent[]> {
  return withPersonalTransaction(database, async (transaction) => {
    const observed = await transaction
      .selectFrom("commands")
      .select(["id", "runId", "type"])
      .where("id", "=", commandId)
      .where("status", "=", "dispatched")
      .executeTakeFirst();
    if (!observed) return [];
    if (observed.type === "trigger.execute") {
      await transaction
        .selectFrom("triggerOccurrences")
        .select("id")
        .where("commandId", "=", commandId)
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
    }
    const run = observed.runId
      ? await transaction
          .selectFrom("runs")
          .select(["environmentId", "id", "status", "threadId", "voiceSessionId"])
          .where("id", "=", observed.runId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow()
      : undefined;
    if (observed.type === "run.execute") {
      if (!run || run.status !== "starting") {
        throw new OpensteerError({
          code: "conflict",
          message: "The Run cannot return to queued from its current state",
        });
      }
      if (run.voiceSessionId)
        return finalizeRunTransaction(transaction, {
          runId: run.id,
          completedAt: new Date(),
          links,
          source: "host",
          status: "interrupted",
          queuedInputCancellation: "seed-input",
        });
      await lockThreadRow(transaction, run.threadId);
      await lockRunProjectionRows(transaction, {
        runIds: [run.id],
        threadIds: [run.threadId],
      });
      // A stop is final: the Run ends rather than going back to its queue.
      if (await runWasStopped(transaction, run.id)) {
        return endStoppedUnconfirmedRun(transaction, {
          links,
          runId: run.id,
        });
      }
    }
    let retry = transaction
      .updateTable("commands")
      .set({
        dispatcherId: null,
        lastError: safeError(error),
        status: "pending",
        updatedAt: new Date(),
      })
      .where("id", "=", commandId)
      .where("status", "=", "dispatched")
      .returning(["runId", "type"]);
    retry = observed.runId
      ? retry.where("runId", "=", observed.runId)
      : retry.where("runId", "is", null);
    const command = await retry.executeTakeFirst();
    if (command?.type === "run.execute") {
      if (!run) throw new Error("Retry Run lock was not established");
      return returnRunToQueue(transaction, {
        run,
      });
    } else if (command?.type === "trigger.execute") {
      await transaction
        .updateTable("triggerOccurrences")
        .set({
          runnerBootId: null,
          runnerId: null,
          startedAt: null,
          status: "pending",
          updatedAt: new Date(),
        })
        .where("commandId", "=", commandId)
        .where("status", "=", "running")
        .execute();
    }
    return [];
  });
}
export async function failCommand(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  commandId: CommandRow["id"],
  publicMessage: string,
  queuedInputCancellation:
    "activation-input" | "authority-cohort" | "seed-input" = "activation-input",
  failureCode: "dispatch_failed" | "runner_restarted" = "dispatch_failed",
): Promise<readonly AgentEvent[]> {
  const observed = await database
    .selectFrom("commands")
    .select(["runId", "type"])
    .where("id", "=", commandId)
    .executeTakeFirst();
  if (!observed) return [];
  if (observed.type === "node.stop") return failNodeStop(database, commandId, publicMessage);
  if (observed.type === "run.steer") return refuseSteer(database, commandId, publicMessage);
  const failure = {
    ...dispatchFailure(publicMessage),
    code: failureCode,
  };
  if (observed.type !== "run.execute" || !observed.runId) {
    await withPersonalTransaction(database, async (transaction) => {
      if (observed.type === "trigger.execute") {
        await transaction
          .selectFrom("triggerOccurrences")
          .select("id")
          .where("commandId", "=", commandId)
          .orderBy("id", "asc")
          .forNoKeyUpdate()
          .execute();
      }
      const now = new Date();
      const failed = await transaction
        .updateTable("commands")
        .set({
          lastError: jsonValue(failure),
          status: "failed",
          updatedAt: now,
        })
        .where("id", "=", commandId)
        .where("status", "=", "dispatched")
        .returning("type")
        .executeTakeFirst();
      if (failed?.type === "request.respond") {
        await transaction
          .updateTable("requests")
          .set({
            responseCommandId: null,
          })
          .where("responseCommandId", "=", commandId)
          .where("status", "=", "pending")
          .execute();
      }
      if (observed.type === "trigger.execute") {
        await transaction
          .updateTable("triggerOccurrences")
          .set({
            completedAt: now,
            error: jsonValue(failure),
            status: "failed",
            updatedAt: now,
          })
          .where("commandId", "=", commandId)
          .where("status", "in", ["pending", "running"])
          .execute();
      }
    });
    return [];
  }
  const terminalEvents = await withPersonalTransaction(database, (transaction) =>
    finalizeRunTransaction(transaction, {
      completedAt: new Date(),
      expectedCommandId: commandId,
      failure,
      links,
      source: "host",
      queuedInputCancellation,
      runId: observed.runId!,
      status: "failed",
    }),
  );
  return terminalEvents;
}
export async function refuseSteer(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  reason: string,
  reasonCode?: string,
): Promise<readonly AgentEvent[]> {
  return withPersonalTransaction(database, (transaction) =>
    settleSteer(transaction, commandId, "failed", reason, reasonCode),
  );
}
export async function markSteerUnknown(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  reason: string,
): Promise<readonly AgentEvent[]> {
  return withPersonalTransaction(database, (transaction) =>
    settleSteer(transaction, commandId, "unknown", reason),
  );
}
export async function succeedCommand(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
): Promise<SucceededCommand> {
  return withPersonalTransaction(database, (transaction) =>
    succeedCommandInTransaction(transaction, commandId),
  );
}

/** Caller owns the Run and projection fences; dispatch happens after commit. */
export function persistRunnerControlCommand(
  transaction: Transaction<DatabaseSchema>,
  values: InsertObject<DatabaseSchema, "commands">,
): Promise<CommandRow> {
  return transaction.insertInto("commands").values(values).returningAll().executeTakeFirstOrThrow();
}
