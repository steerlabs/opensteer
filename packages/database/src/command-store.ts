import { PersonalRevisionSchema } from "@opensteer/protocol/resources";
import { assignmentWasCancelled } from "./execution-authority.js";
import { assertRequestRevision, refreshRequestState } from "./request-persistence.js";
import { commitPersonalMutation, wakeExecutionCommands } from "./personal-mutation.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { assertRequestOriginMayContinue } from "./resource-access.js";
import { failNodeStop } from "./node-control.js";
import {
  assertThreadCaller,
  callerAuthoritySource,
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
import {
  attemptForBinding,
  pendingReplacementAttempt,
  type RunAttemptRow,
} from "./run-attempts.js";
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
  OpensteerError,
  nonTerminalRunStatuses,
  type Request,
  RequestIdSchema,
  RequestSettlementProvenanceSchema,
  RequestAgentAnswererSchema,
  UserIdSchema,
  RequestResponseSchema,
  hasSecretRequestFields,
  agentGrantAllowsTasks,
  requestFormAnswersProblem,
  requestOptionDeclines,
  createId,
  type EnvironmentId,
  type Message,
  type MessageOrigin,
  type Run,
} from "@opensteer/core";
import { type InsertObject, type Transaction, sql, type Kysely } from "kysely";
import { connectionState } from "./connection-liveness.js";
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
  claimConversationBatch,
  claimRunInputBatch,
  deliverConversationInputsInTransaction,
  restartBatchCapacity,
  settleSteer,
  settleStoppedConversationInputs,
} from "./thread-inbox.js";
import { publishThreadQueues } from "./personal-queue-view.js";
import {
  publishExecutionInput,
  recordExecutionRunChange,
  updateExecutionThread,
} from "./execution-changes.js";
import { refreshExecuteClaimProof } from "./personal-run-state.js";
import { assignmentActivityEventsForRun } from "./assignment-store.js";
import { cancelPending, requestFromRow } from "./request-store.js";
import { messageFromRow, messageOriginFromRow, runFromRow } from "./thread-row-mappers.js";
import { isDeepStrictEqual } from "node:util";
import {
  drainRunFinish,
  endStoppedUnconfirmedRun,
  finalizeRunTransaction,
} from "./run-finalization.js";
import {
  chatEndedMessage,
  connectionIsWaiting,
  liveAgentConnection,
  meetsConnectionFloor,
  sendEligible,
} from "./resource-access.js";
import { lockLineageConnection } from "./thread-caller.js";
import { senderUnlinkedFailure } from "./bridge-admission.js";
import { chatSenderMaySpeak } from "./thread-inbox.js";

export type RunnerControlInput =
  | {
      readonly idempotencyKey: string;
      readonly requestedBy: UserId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "run.interrupt";
      readonly keepQueueRunning?: true;
      readonly expectedBindingGeneration?: number | null;
      readonly stop?: { readonly id: CommandRow["id"]; readonly bootId: string };
      readonly authority?: ThreadCallerAuthority;
      /** The teammate whose ask this task answers withdrew it; no one here stopped it. */
      readonly teamCancel?: { readonly teamId: string; readonly requestId: string };
    }
  | {
      readonly idempotencyKey: string;
      readonly requestId: RequestId;
      readonly expectedRevision: string;
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
  > & { readonly connectionId: string | null },
  dispatcherId: string,
): Promise<ClaimedCommand | null> {
  const lineage =
    observed.type === "run.execute" || observed.type === "run.steer" ? observed.connectionId : null;
  await lockLineageConnection(transaction, lineage);
  // A tick enqueued before its chat was paused, listed before the pause: held at its claim, as a
  // queued Run is, and listed again when the chat is back.
  if (observed.type === "trigger.execute" && (await triggerCommandHeld(transaction, observed.id)))
    return null;
  // Follow ./lock-order.ts: an ambiguous prior dispatch may requeue a command
  // just as the old Runner commits its terminal event.
  const run = observed.runId
    ? await transaction
        .selectFrom("runs")
        .select([
          "environmentId",
          "id",
          "status",
          "threadId",
          "runOrdinal",
          "seedInputId",
          "finishIntent",
          "assignmentId",
          "admittedGrantRevision",
          "admittedAccessMode",
        ])
        .where("id", "=", observed.runId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow()
    : undefined;
  if (run?.finishIntent) return null;
  if (
    run?.assignmentId &&
    observed.type !== "run.interrupt" &&
    (await assignmentWasCancelled(transaction, run.assignmentId))
  )
    return null;
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
  if (lineage && run && !terminalFailure) {
    await lockThreadRow(transaction, run.threadId);
    const thread = await transaction
      .selectFrom("threads")
      .select("originConnectionId")
      .where("id", "=", run.threadId)
      .executeTakeFirstOrThrow();
    let waiting = false;
    let chatEnded = false;
    const connection = await liveAgentConnection(transaction, observed.requestedBy, lineage).catch(
      (error: unknown) => {
        if (error instanceof OpensteerError && error.code === "forbidden") {
          waiting = connectionIsWaiting(error);
          chatEnded = error.message === chatEndedMessage;
          return null;
        }
        throw error;
      },
    );
    // A chat paused after this command was listed: its Run, or a message steered into one, is
    // held, pending, with its message kept, and is listed again when the chat is back. Only an
    // end is terminal. The one read that found it not live said which.
    if (
      !connection &&
      (observed.type === "run.execute" || observed.type === "run.steer") &&
      waiting
    )
      return null;
    if (
      !connection ||
      !agentGrantAllowsTasks(connection.grant) ||
      !sendEligible(connection, thread.originConnectionId) ||
      ((observed.type === "run.steer" || run.admittedGrantRevision !== null) &&
        !meetsConnectionFloor(connection, run.admittedGrantRevision, run.admittedAccessMode))
    ) {
      terminalFailure = chatEnded
        ? chatEndedMessage
        : "The connected agent's access ended before this work could be delivered.";
      if (observed.type === "run.execute") terminalFailureInput = "seed-input";
    }
  }
  // A Run whose message's sender may no longer speak (the person linked "me" to another
  // identity) ends at its claim, as a queued message is cancelled at its turn: its message is
  // cancelled with it, and the chat hears nothing (run-finalization reads this failure).
  if (lineage && run && observed.type === "run.execute" && !terminalFailure && workIsAvailable) {
    const seed = await transaction
      .selectFrom("threadInputs")
      .select(["authoritySource", "connectionId", "requestedBy", "state"])
      .where("messageId", "=", run.seedInputId)
      .executeTakeFirst();
    if (seed && seed.state === "pending" && !(await chatSenderMaySpeak(transaction, seed))) {
      terminalFailure = senderUnlinkedFailure;
      terminalFailureInput = "seed-input";
    }
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
  if (command.type === "run.execute" && command.runId)
    await refreshExecuteClaimProof(transaction, command.runId);

  // Control commands target an already active Run and must not rewrite its
  // state. Only dispatching the original turn transitions queued -> starting.
  if (command.type === "run.execute" && !terminalFailure) {
    if (!run || run.status !== "queued") {
      throw new Error("Claimed Run state changed");
    }
    if (!restart) await claimRunInputBatch(transaction, run.id);
    else if (restart.reason !== "recovery")
      await claimConversationBatch(
        transaction,
        run.id,
        await restartBatchCapacity(transaction, run.id),
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
    await commitPersonalMutation(transaction, (tx, mutation) =>
      recordExecutionRunChange(tx, mutation, {
        runId: run.id,
        threadId: run.threadId,
        transition: "status",
      }),
    );
    await updateExecutionThread(transaction, run.threadId, command.updatedAt);
    await assignmentActivityEventsForRun(transaction, run.id);
  }
  return {
    command,

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
  readonly revokedGrants: readonly RevokedRunGrant[];
}
async function succeedCommandInTransaction(
  transaction: Transaction<DatabaseSchema>,
  commandId: CommandRow["id"],
): Promise<SucceededCommand> {
  const none: SucceededCommand = {
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
      commandIds: [commandId],
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
  if (responsePayload && (!pending || pending.revision !== responsePayload.expectedRevision))
    return none;
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
    await refreshRequestState(transaction, resolved.id);
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
        // The resumed state is projected before a hand-off can restart the attempt:
        // thread state ranks ahead of run attempts, and a restart leaves the Run running.
        await updateExecutionThread(transaction, observed.threadId, now);
        await commitPersonalMutation(transaction, (tx, mutation) =>
          recordExecutionRunChange(tx, mutation, {
            runId: observed.runId!,
            threadId: observed.threadId!,
            transition: "status",
          }),
        );
        const handed = await deliverConversationInputsInTransaction(transaction, observed.runId);
        revokedGrants = handed.revokedGrants;
      }
    }
    await assignmentActivityEventsForRun(transaction, observed.runId);
    return {
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
  await publishExecutionInput(transaction, inputRow);
  return none;
}

function requestResponseDispatchConflict(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: "The Request response reservation was cancelled before dispatch",
  });
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
  if (!allowSecrets && request.presentation.fields.some((field) => field.secret)) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Secret answers require the live response channel",
    });
  }
  const problem = requestFormAnswersProblem(request.presentation.fields, response.answers);
  if (problem !== null) throw new OpensteerError({ code: "bad_request", message: problem });
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
        expectedRevision: PersonalRevisionSchema.parse(input.expectedRevision),
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
        ...(input.stop ? { stop: input.stop } : {}),
        ...(input.keepQueueRunning ? { keepQueueRunning: true } : {}),
        ...(input.expectedBindingGeneration !== undefined
          ? { expectedBindingGeneration: input.expectedBindingGeneration }
          : {}),
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
  readonly expectedRevision: string;
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
    expectedRevision: PersonalRevisionSchema.parse(value.expectedRevision),
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
  return commitPersonalMutation(database, (transaction) =>
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

      revokedGrants: [],
      wasDuplicate: true,
    };
  }
  const thread = await transaction
    .selectFrom("threads")
    .select(["environmentId", "id", "originConnectionId", "purpose", "status"])
    .where("id", "=", input.threadId)
    .executeTakeFirst();
  if (!thread)
    throw new OpensteerError({
      code: "not_found",
      message: "Task not found",
    });
  let targetRunStatus: RunRow["status"] | null = null;
  let targetRunMayHaveBeenSent = false;
  {
    const run = await transaction
      .selectFrom("runs")
      .select([
        "bindingGeneration",
        "connectionId",
        "id",
        "requestedBy",
        "status",
        "threadId",
        "finishIntent",
      ])
      .where("id", "=", input.runId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!run || run.threadId !== input.threadId) {
      throw new OpensteerError({
        code: "not_found",
        message: "Run not found for thread",
      });
    }
    if (
      input.type === "run.interrupt" &&
      input.expectedBindingGeneration !== undefined &&
      run.bindingGeneration !== input.expectedBindingGeneration
    )
      throw new OpensteerError({ code: "conflict", message: "The Run execution changed" });
    if (run.finishIntent)
      throw new OpensteerError({
        code: "conflict",
        message: "The Run is finishing",
        retryable: true,
      });
    if (["completed", "failed", "interrupted"].includes(run.status)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Run is already terminal",
      });
    }
    targetRunStatus = run.status;
    targetRunMayHaveBeenSent = run.bindingGeneration !== null;
    if (
      input.type === "run.interrupt" &&
      input.expectedBindingGeneration !== undefined &&
      run.status === "starting" &&
      run.connectionId &&
      run.bindingGeneration !== null
    ) {
      const attempt = await attemptForBinding(transaction, run.id, run.bindingGeneration);
      if (
        attempt?.connectionId === run.connectionId &&
        attempt.admittedGrantRevision === null &&
        attempt.firstEventAt === null
      )
        targetRunMayHaveBeenSent = false;
    }
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
    if (input.type === "request.respond") {
      await assertRequestOriginMayContinue(transaction, run.requestedBy, {
        connectionId: run.connectionId,
        threadOriginConnectionId: thread.originConnectionId,
      });
    }
  }
  if (input.type === "run.interrupt")
    await assertThreadCaller(transaction, input.authority, {
      threadId: input.threadId,
    });
  if (input.type === "request.respond" && input.agentResponder)
    await assertAgentRequestTarget(transaction, input.agentResponder.authority, input.threadId);
  // Binding and stamping a connection handoff both require a starting Run under this lock.
  const endsHere =
    input.type === "run.interrupt" &&
    (targetRunStatus === "queued" || (targetRunStatus === "starting" && !targetRunMayHaveBeenSent));
  if (input.type === "run.interrupt") {
    await lockThreadRow(transaction, thread.id);
    if (thread.purpose === "voice") {
      // Stopping a conversation's reply ends that exchange; the conversation
      // stays open, so the person's next message is answered without a Resume.
      await lockRunProjectionRows(transaction, {
        runIds: [input.runId],
        threadIds: [thread.id],
      });
      await settleStoppedConversationInputs(transaction, input.runId);
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
      await commitPersonalMutation(transaction, async (tx, mutation) => {
        await tx
          .updateTable("threads")
          .set({ inputQueueRevision: mutation.sequence, revision: mutation.sequence })
          .where("id", "=", thread.id)
          .execute();
      });
      await publishThreadQueues(transaction, thread.id);
    }
    // Finalizing a Run that ends here settles its Requests and Thread state.
    if (!endsHere) {
      // Nothing a stopped Run asked for can be answered any more.
      await cancelPending(transaction, {
        reason: "run-ended",
        resolvedAt: new Date(),
        runId: input.runId,
        cancelHandedOffPlugins: true,
      });
      // With nothing left to answer, the Run is running again until it stops.
      await transaction
        .updateTable("runs")
        .set({
          status: "running",
        })
        .where("id", "=", input.runId)
        .where("status", "=", "waiting")
        .execute();
      await updateExecutionThread(transaction, thread.id, new Date());
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
    assertRequestRevision(pending, input.expectedRevision);
    const request = requestFromRow(pending);
    await requirePersonalOwner(transaction, input.requestedBy);
    if (input.agentResponder)
      assertAgentRequestAnswer(request, input.agentResponder, pending.revision);
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
      input.type === "run.interrupt" && input.teamCancel
        ? { kind: "team-cancel", ...input.teamCancel }
        : callerAuthoritySource(
            input.type === "request.respond" ? input.agentResponder?.authority : input.authority,
            input.requestedBy,
          ),
    ),
    dispatcherId: null,
    environmentId: thread.environmentId,
    id: (input.type === "run.interrupt" ? input.stop?.id : undefined) ?? createId("command"),
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
    await finalizeRunTransaction(transaction, {
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
    revokedGrants,
    wasDuplicate: false,
  };
}
export async function claimNextCommand(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
  dispatcherId: string,
): Promise<ClaimedCommand | null> {
  return commitPersonalMutation(database, async (transaction) => {
    const candidate = await transaction
      .selectFrom("commands")
      .leftJoin("threads", "threads.id", "commands.threadId")
      .leftJoin("runs", "runs.id", "commands.runId")
      .select([
        "runs.connectionId",
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
      .where((expression) => expression.not(chatWorkHeld()))
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
 * The dispatched command is the durable intent. Authorize its handoff under
 * the commit fence, then let the Runner wait on its own transport.
 */
export type RequestResponseSendFence = (
  enqueue: (binding: {
    runId: RunId;
    threadId: ThreadId;
    environmentId: EnvironmentId;
    bindingGeneration: number;
  }) => void,
) => Promise<void>;

export async function dispatchRequestResponse(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  send: (
    beforeAck: () => Promise<void>,
    fenceSend: RequestResponseSendFence,
    bindingGeneration: number,
  ) => Promise<void>,
): Promise<SucceededCommand> {
  const lockIntent = async (transaction: Transaction<DatabaseSchema>, receipt: boolean) => {
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
      .select(["bindingGeneration", "environmentId", "status", "threadId", "finishIntent"])
      .where("id", "=", observed.runId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (
      !run ||
      run.bindingGeneration === null ||
      run.threadId !== observed.threadId ||
      run.finishIntent !== null ||
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
      commandIds: [commandId],
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
      requestRow.revision !== payload.expectedRevision ||
      requestRow.responseCommandId !== commandId ||
      requestRow.originatingRunId !== observed.runId ||
      requestRow.originatingThreadId !== observed.threadId ||
      !command ||
      command.type !== "request.respond" ||
      (command.status !== "dispatched" && !(receipt && command.status === "unknown")) ||
      command.runId !== observed.runId ||
      command.threadId !== observed.threadId
    ) {
      throw requestResponseDispatchConflict();
    }
    const request = requestFromRow(requestRow);
    if (agentResponder) assertAgentRequestAnswer(request, agentResponder, requestRow.revision);
    if (
      !agentResponder &&
      request.requiredActor === "requester" &&
      request.requestedBy !== command.requestedBy
    ) {
      throw requestResponseDispatchConflict();
    }
    return {
      runId: observed.runId,
      threadId: observed.threadId,
      environmentId: run.environmentId,
      bindingGeneration: run.bindingGeneration,
    };
  };
  const binding = await commitPersonalMutation(database, async (tx) => {
    const binding = await lockIntent(tx, false);
    await stampDispatchIntent(tx, commandId);
    return binding;
  });
  const checkBinding = async (tx: Transaction<DatabaseSchema>, receipt: boolean) => {
    const current = await lockIntent(tx, receipt);
    if (
      current.runId !== binding.runId ||
      current.threadId !== binding.threadId ||
      current.environmentId !== binding.environmentId ||
      current.bindingGeneration !== binding.bindingGeneration
    ) {
      throw requestResponseDispatchConflict();
    }
  };
  let result: SucceededCommand | undefined;
  try {
    await send(
      async () => {
        result = await commitPersonalMutation(database, async (tx) => {
          await checkBinding(tx, true);
          const succeeded = await succeedCommandInTransaction(tx, commandId);
          const accepted = await tx
            .selectFrom("commands")
            .select("id")
            .where("id", "=", commandId)
            .where("status", "=", "succeeded")
            .executeTakeFirst();
          if (!accepted) throw requestResponseDispatchConflict();
          return succeeded;
        });
      },
      async (enqueue) => {
        // Cancellation and binding changes take this same fence. Keep it only
        // through synchronous transport enqueue, never through the receipt.
        await commitPersonalMutation(
          database,
          async (tx) => {
            await checkBinding(tx, false);
            enqueue(binding);
          },
          undefined,
          "non-retrying",
        );
      },
      binding.bindingGeneration,
    );
  } catch (error) {
    if (!result) throw error;
  }
  if (!result) throw requestResponseDispatchConflict();
  return result;
}

async function stampDispatchIntent(
  transaction: Transaction<DatabaseSchema>,
  commandId: CommandRow["id"],
) {
  await transaction
    .updateTable("commands")
    .set({ updatedAt: new Date() })
    .where("id", "=", commandId)
    .where("status", "=", "dispatched")
    .executeTakeFirstOrThrow();
}

export async function listPendingCommands(
  database: Kysely<DatabaseSchema>,
  limit = 500,
): Promise<readonly PendingCommandRow[]> {
  return (
    database
      .selectFrom("commands")
      .leftJoin("threads", "threads.id", "commands.threadId")
      .leftJoin("runs", "runs.id", "commands.runId")
      .selectAll("commands")
      .select("runs.harnessInstanceId as runHarnessInstanceId")
      .where("commands.status", "=", "pending")
      .where("runs.finishIntent", "is", null)
      .where((expression) =>
        expression.or([
          expression("commands.type", "!=", "run.execute"),
          expression.and([
            expression("threads.inputQueuePaused", "=", false),
            expression("runs.status", "=", "queued"),
          ]),
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
      // A paused chat's work waits for the chat, not for time: it is not listed until it is back.
      .where((expression) => expression.not(chatWorkHeld()))
      .orderBy("commands.createdAt", "asc")
      .limit(Math.min(Math.max(limit, 1), 20_000))
      .execute()
  );
}
/**
 * The command is a paused chat's work, held until the chat is back (asked of the one state
 * function): a Run in the chat's lineage or a message steered into one, or an automation's run
 * whose lineage is the chat
 * (`triggers.origin_connection_id`, as authority and Disconnect read it). A paused chat's
 * schedule fires nothing, so only a tick enqueued before the pause is held here. Reads `commands`
 * and the left-joined `runs`.
 */
function chatWorkHeld() {
  return sql<boolean>`((commands.type in ('run.execute', 'run.steer') and runs.connection_id is not null
      and exists (
        select 1 from agent_connections
        where agent_connections.id = runs.connection_id
          and agent_connections.bridge_account_id is not null
          and ${connectionState()} = 'waiting'))
    or (commands.type = 'trigger.execute' and exists (
        select 1 from trigger_occurrences held_occurrence
        join triggers held_trigger on held_trigger.id = held_occurrence.trigger_id
        join agent_connections
          on agent_connections.id = coalesce(held_occurrence.connection_id,
            held_trigger.origin_connection_id)
        where held_occurrence.command_id = commands.id
          and agent_connections.bridge_account_id is not null
          and ${connectionState()} = 'waiting')))`;
}
/** The automation tick belongs to a chat (its own lineage) that is paused. */
async function triggerCommandHeld(
  transaction: Transaction<DatabaseSchema>,
  commandId: CommandRow["id"],
): Promise<boolean> {
  const { rows } = await sql<{ held: boolean }>`
    select exists (
      select 1 from trigger_occurrences held_occurrence
      join triggers held_trigger on held_trigger.id = held_occurrence.trigger_id
      join agent_connections
        on agent_connections.id = coalesce(held_occurrence.connection_id,
          held_trigger.origin_connection_id)
      where held_occurrence.command_id = ${commandId}
        and agent_connections.bridge_account_id is not null
        and ${connectionState()} = 'waiting') as held`.execute(transaction);
  return rows[0]?.held === true;
}
export async function claimCommand(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  dispatcherId: string,
): Promise<ClaimedCommand | null> {
  return commitPersonalMutation(database, async (transaction) => {
    const observed = await transaction
      .selectFrom("commands")
      .leftJoin("runs", "runs.id", "commands.runId")
      .select([
        "commands.environmentId",
        "commands.id",
        "commands.payload",
        "commands.requestedBy",
        "commands.runId",
        "commands.threadId",
        "commands.type",
        "runs.connectionId",
      ])
      .where("commands.id", "=", commandId)
      .where("commands.status", "=", "pending")
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
  readonly origin: MessageOrigin | undefined;
  readonly run: Run;
  readonly reauthorize?: () => Promise<void>;
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
    .where("id", "=", row.targetRunId)
    .executeTakeFirstOrThrow();
  return {
    message: messageFromRow(row),
    origin: messageOriginFromRow(row),
    run: runFromRow(runRow),
    ...(runRow.connectionId
      ? {
          reauthorize: async () => {
            const current = await database
              .selectFrom("runs")
              .innerJoin("threads", "threads.id", "runs.threadId")
              .select([
                "runs.bindingGeneration",
                "runs.status",
                "runs.admittedGrantRevision",
                "runs.admittedAccessMode",
                "threads.originConnectionId",
              ])
              .where("runs.id", "=", runRow.id)
              .executeTakeFirst();
            const connection = await liveAgentConnection(
              database,
              runRow.requestedBy,
              runRow.connectionId!,
            );
            if (
              !current ||
              current.bindingGeneration !== runRow.bindingGeneration ||
              !["running", "waiting"].includes(current.status) ||
              !agentGrantAllowsTasks(connection.grant) ||
              !sendEligible(connection, current.originConnectionId) ||
              !meetsConnectionFloor(
                connection,
                current.admittedGrantRevision,
                current.admittedAccessMode,
              )
            )
              throw new OpensteerError({
                code: "forbidden",
                message: "The connected agent's access ended before this work could be delivered.",
              });
          },
        }
      : {}),
    runId: row.targetRunId,
    threadId: row.targetThreadId,
  };
}
export async function retryCommand(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  commandId: CommandRow["id"],
  error: unknown,
): Promise<void> {
  return commitPersonalMutation(database, async (transaction) => {
    const observed = await transaction
      .selectFrom("commands")
      .select(["id", "runId", "type"])
      .where("id", "=", commandId)
      .where("status", "=", "dispatched")
      .executeTakeFirst();
    if (!observed) return;
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
      await sql`
        insert into trigger_occurrence_attempts (
          occurrence_id, execution_generation, connection_id, runner_id, runner_boot_id,
          admitted_grant_revision, admitted_access_mode, terminal_evidence_at, contact_lost_at
        )
        select id, execution_generation, connection_id, runner_id, runner_boot_id,
          admitted_grant_revision, admitted_access_mode, terminal_evidence_at, contact_lost_at
        from trigger_occurrences
        where command_id = ${commandId} and status = 'running'
          and connection_id is not null and runner_id is not null and runner_boot_id is not null
          and (terminal_evidence_at is null or contact_lost_at is not null)
      `.execute(transaction);
      await transaction
        .updateTable("triggerOccurrences")
        .set({
          admittedGrantRevision: null,
          admittedAccessMode: null,
          terminalEvidenceAt: null,
          contactLostAt: null,
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
    return;
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
): Promise<void> {
  const observed = await database
    .selectFrom("commands")
    .select(["runId", "type"])
    .where("id", "=", commandId)
    .executeTakeFirst();
  if (!observed) return;
  if (observed.type === "node.stop") {
    await failNodeStop(database, commandId, publicMessage);
    return;
  }
  if (observed.type === "run.steer") return refuseSteer(database, commandId, publicMessage);
  const failure = {
    ...dispatchFailure(publicMessage),
    code: failureCode,
  };
  if (observed.type !== "run.execute" || !observed.runId) {
    await commitPersonalMutation(database, async (transaction) => {
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
    return;
  }
  await commitPersonalMutation(database, (transaction) =>
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
  await drainRunFinish(database, links, observed.runId!);
}
export async function refuseSteer(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  reason: string,
  reasonCode?: string,
  pendingOnly = false,
): Promise<void> {
  return commitPersonalMutation(database, (transaction) =>
    settleSteer(transaction, commandId, "failed", reason, reasonCode, pendingOnly),
  );
}
export async function markSteerUnknown(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  reason: string,
): Promise<void> {
  return commitPersonalMutation(database, (transaction) =>
    settleSteer(transaction, commandId, "unknown", reason),
  );
}
export async function succeedCommand(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
): Promise<SucceededCommand> {
  return commitPersonalMutation(database, (transaction) =>
    succeedCommandInTransaction(transaction, commandId),
  );
}

/** Caller owns the Run and projection fences; dispatch happens after commit. */
export async function persistRunnerControlCommand(
  transaction: Transaction<DatabaseSchema>,
  values: InsertObject<DatabaseSchema, "commands">,
): Promise<CommandRow> {
  const command = await transaction
    .insertInto("commands")
    .values(values)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (command.status === "pending") await wakeExecutionCommands(transaction);
  return command;
}
