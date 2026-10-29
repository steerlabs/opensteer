import { withDatabaseTransaction } from "./connection.js";
import { issueRunGrant, type RevokedRunGrant } from "./run-grants.js";
import { pendingReplacementAttempt } from "./run-attempts.js";
import { type CommandRow, type ProviderSessionTable, type DatabaseSchema } from "./schema.js";
import {
  isPlaceContentPart,
  placeContentLabel,
  surrogateSafeCut,
  threadTitleRequestMaxLength,
  type ThreadExecutionBinding,
  type Message,
  type Run,
  type Thread,
  type Workspace,
  OpensteerError,
  ThreadExecutionBindingSchema,
  type RunId,
  type RunnerId,
  nonTerminalRunStatuses,
  type MessageId,
  MessageIdSchema,
  type UserId,
  type ProviderContinuationIdentity,
  type HarnessInstanceId,
  type ThreadId,
  type AgentEvent,
  type GrantId,
  ProviderContinuationIdentitySchema,
  sameProviderContinuationIdentity,
  type WorkspaceId,
  type EnvironmentId,
  type ProviderSessionId,
} from "@opensteer/core";
import {
  type RunHistoryWindow,
  runHistoryMaxMessages,
  runHistoryMaxSerializedBytes,
} from "@opensteer/protocol";
import { type Kysely, sql } from "kysely";
import {
  jsonValue,
  boundedWindowLimit,
  boundedWindowBytes,
  safeGeneration,
  lockWorkspaceRow,
  threadExecutionIsAvailableToUser,
} from "./store-primitives.js";
import {
  messagesFromRows,
  threadPendingRequestsSelection,
  threadProviderSessionSelection,
  threadContinuationIdentitySelection,
  runFromRow,
  threadFromRow,
} from "./thread-row-mappers.js";
import { readRunThreadState } from "./run-thread-state.js";
import { type DurableWindowReadOptions } from "./snapshot-store.js";
import { newestMessageWindow } from "./message-window.js";
import { workspaceFromRow } from "./store-primitives.js";
import { channelRunAuthorityIsCurrent } from "./channel-execution.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import {
  assertActiveExecutionBinding as assertActiveExecutionBindingInStore,
  assertActiveGrant as assertActiveGrantInStore,
} from "./execution-authority.js";

/**
 * Names the Thread and Run an agent-authored turn came from, resolved once at
 * dispatch so the Runner receives a Host-authored envelope instead of trusting
 * anything the sending model wrote.
 */
export interface RunDispatchContext {
  readonly command: CommandRow;
  readonly executionBinding: ThreadExecutionBinding | null;
  readonly providerSessionStateLayout: "thread" | "session";
  readonly history: readonly Message[];
  readonly initialContext: {
    readonly finalized: boolean;
    readonly messages: readonly Message[];
    readonly omittedCount: number;
    readonly throughSequence: string | null;
  } | null;
  readonly historyWindow: RunHistoryWindow;
  readonly inputs: readonly Message[];
  readonly reports: {
    readonly messages: readonly Message[];
    readonly omittedCount: number;
    readonly throughSequence: string | null;
  };
  readonly membershipGeneration: number;
  /** The ordinal the execution's first event takes. */
  readonly firstOrdinal: number;
  readonly run: Run;
  readonly thread: Thread;
  readonly titleProvisional: boolean;
  readonly titleRequest?: { readonly request: string; readonly icon?: true };
  readonly workspace: Workspace;
}

function executionBindingFromRow(row: {
  readonly bindingGeneration: ProviderSessionTable["bindingGeneration"];
  readonly createdAt: Date;
  readonly harnessInstanceId: ProviderSessionTable["harnessInstanceId"];
  readonly id: ProviderSessionTable["id"];
  readonly leaseExpiresAt: Date | null;
  readonly providerSessionReference: ProviderSessionTable["providerSessionReference"];
  readonly runnerBootId: ProviderSessionTable["runnerBootId"];
  readonly runnerId: ProviderSessionTable["runnerId"];
  readonly status: ProviderSessionTable["status"];
  readonly threadId: ProviderSessionTable["threadId"];
}): ThreadExecutionBinding {
  if (!row.leaseExpiresAt || !row.runnerBootId || !row.runnerId || row.bindingGeneration < 1) {
    throw new OpensteerError({
      code: "conflict",
      message: "Provider session has no active binding",
    });
  }
  return ThreadExecutionBindingSchema.parse({
    bindingGeneration: row.bindingGeneration,
    createdAt: row.createdAt.toISOString(),
    harnessInstanceId: row.harnessInstanceId,
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    providerSessionId: row.id,
    providerSessionReference: row.providerSessionReference,
    runnerBootId: row.runnerBootId,
    runnerId: row.runnerId,
    status: row.status,
    threadId: row.threadId,
  });
}

/** Renews the leases of the named Runs this Runner boot holds, returning those it renewed. */
export async function renewActiveExecutionBindings(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly activeRunIds: readonly RunId[];
    readonly leaseExpiresAt: Date;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
  executionNow: () => number = Date.now,
): Promise<readonly RunId[]> {
  if (input.activeRunIds.length === 0) return [];
  // A lease that ran out stays out: the Runner has already stopped the Run on
  // its own deadline, and the Host's sweep is about to settle it.
  const renewed = await database
    .updateTable("providerSessions")
    .set({ leaseExpiresAt: input.leaseExpiresAt, updatedAt: new Date() })
    .where("active", "=", true)
    .where("runnerId", "=", input.runnerId)
    .where("runnerBootId", "=", input.runnerBootId)
    .where("leaseExpiresAt", ">", new Date(executionNow()))
    .where(
      sql<boolean>`exists (
          select 1
          from runs run
          join threads thread on thread.id = run.thread_id
          join workspace_memberships membership
            on membership.workspace_id = thread.workspace_id
           and membership.user_id = run.requested_by
          where run.id in (${sql.join(input.activeRunIds)})
            and run.provider_session_id = provider_sessions.id
            and run.binding_generation = provider_sessions.binding_generation
            and run.status in ('starting', 'running', 'waiting')
            and run.harness_instance_id = provider_sessions.harness_instance_id
            and run.environment_id = thread.environment_id
            and membership.state = 'active'
            and membership.generation = run.membership_generation
            and opensteer_user_can_execute_environment(
              run.environment_id,
              run.requested_by
            )
        )`,
    )
    .returning(["bindingGeneration", "id"])
    .execute();
  if (renewed.length === 0) return [];
  const runs = await database
    .selectFrom("runs")
    .select(["bindingGeneration", "id", "providerSessionId"])
    .where("id", "in", input.activeRunIds)
    .where("status", "in", ["starting", "running", "waiting"])
    .where(
      "providerSessionId",
      "in",
      renewed.map((session) => session.id),
    )
    .execute();
  return runs
    .filter((run) =>
      renewed.some(
        (session) =>
          session.id === run.providerSessionId &&
          session.bindingGeneration === run.bindingGeneration,
      ),
    )
    .map((run) => run.id);
}

/** Whether a Run still has authority to dispatch work to an auxiliary runtime. */
export async function isRunActive(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  const row = await database
    .selectFrom("runs")
    .select("id")
    .where("id", "=", runId)
    .where("status", "in", nonTerminalRunStatuses)
    .executeTakeFirst();
  return row !== undefined;
}

export async function finalizeRunInitialContext(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly commandId: CommandRow["id"];
    readonly messageIds: readonly MessageId[];
  },
): Promise<
  (NonNullable<RunDispatchContext["initialContext"]> & { readonly finalized: true }) | null
> {
  const selectedIds = MessageIdSchema.array().max(runHistoryMaxMessages).parse(input.messageIds);
  return withDatabaseTransaction(database, async (transaction) => {
    const observed = await transaction
      .selectFrom("commands")
      .select(["id", "runId", "threadId", "type"])
      .where("id", "=", input.commandId)
      .executeTakeFirst();
    if (observed?.type !== "run.execute" || !observed.runId || !observed.threadId) {
      throw new OpensteerError({ code: "conflict", message: "Run command is unavailable" });
    }
    // Runner terminalization takes the Run lock first. Re-read the Command
    // after that lock so a retry cannot finalize an older dispatch attempt.
    const run = await transaction
      .selectFrom("runs")
      .select(["id", "initialContext", "status", "threadId"])
      .where("id", "=", observed.runId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const command = await transaction
      .selectFrom("commands")
      .select(["dispatcherId", "runId", "status", "threadId", "type"])
      .where("id", "=", input.commandId)
      .executeTakeFirst();
    if (
      !run ||
      run.status !== "starting" ||
      run.threadId !== observed.threadId ||
      command?.status !== "dispatched" ||
      !command.dispatcherId ||
      command.type !== "run.execute" ||
      command.runId !== run.id ||
      command.threadId !== run.threadId
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Run dispatch no longer owns this initial context",
      });
    }
    const frozen = run.initialContext;
    if (frozen === null) return null;
    let finalized = frozen;
    if (frozen.finalized !== true) {
      let cursor = 0;
      for (const id of selectedIds) {
        while (cursor < frozen.messageIds.length && frozen.messageIds[cursor] !== id) {
          cursor += 1;
        }
        if (cursor === frozen.messageIds.length) {
          throw new OpensteerError({
            code: "bad_request",
            message: "Initial context selection must preserve frozen message order",
          });
        }
        cursor += 1;
      }
      finalized = {
        finalized: true,
        messageIds: selectedIds,
        omittedCount: frozen.omittedCount + frozen.messageIds.length - selectedIds.length,
        throughSequence: frozen.throughSequence,
      };
      if (!Number.isSafeInteger(finalized.omittedCount)) {
        throw new OpensteerError({
          code: "bad_request",
          message: "Initial context count exceeds its limit",
        });
      }
      await transaction
        .updateTable("runs")
        .set({ initialContext: jsonValue(finalized) })
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
    }
    const rows = finalized.messageIds.length
      ? await transaction
          .selectFrom("messages")
          .selectAll()
          .where("id", "in", finalized.messageIds)
          .where("threadId", "=", run.threadId)
          .orderBy("sequence", "asc")
          .execute()
      : [];
    if (rows.length !== finalized.messageIds.length) {
      throw new OpensteerError({
        code: "conflict",
        message: "The finalized initial context is incomplete",
      });
    }
    return {
      finalized: true,
      messages: messagesFromRows(rows),
      omittedCount: finalized.omittedCount,
      throughSequence: finalized.throughSequence,
    };
  });
}

/** What a Run's engine cannot see in its own history about its Thread. */
export function loadRunThreadState(
  database: Kysely<DatabaseSchema>,
  input: { readonly runId: RunId; readonly viewerId: UserId },
) {
  return readRunThreadState(database, input);
}

export async function loadRunDispatchContext(
  database: Kysely<DatabaseSchema>,
  commandId: CommandRow["id"],
  options: DurableWindowReadOptions = {},
): Promise<RunDispatchContext> {
  const maxHistoryItems = boundedWindowLimit(options.maxItems, runHistoryMaxMessages);
  const maxHistoryBytes = boundedWindowBytes(options.maxBytes, runHistoryMaxSerializedBytes);
  const command = await database
    .selectFrom("commands")
    .selectAll()
    .where("id", "=", commandId)
    .executeTakeFirst();
  if (!command?.runId || !command.threadId) {
    throw new OpensteerError({ code: "not_found", message: "Run command not found" });
  }
  const runRow = await database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", command.runId)
    .executeTakeFirstOrThrow();
  if (runRow.reportContext === null) {
    throw new OpensteerError({
      code: "conflict",
      message: "Run context has not been frozen for dispatch",
    });
  }
  // A restart resumes the session its first attempt already filled: it
  // carries only the messages steered into it, never the frozen context again.
  const replacement = await pendingReplacementAttempt(database, runRow.id);
  const restart = replacement !== undefined;
  const recovery = replacement?.reason === "recovery";
  const includeContext = !restart || (recovery && runRow.startedAt === null);
  const reports =
    includeContext && runRow.reportContext.messageIds.length
      ? messagesFromRows(
          await database
            .selectFrom("messages")
            .selectAll()
            .where("id", "in", runRow.reportContext.messageIds)
            .where("threadId", "=", command.threadId)
            .orderBy("sequence", "asc")
            .execute(),
        )
      : [];
  if (includeContext && reports.length !== runRow.reportContext.messageIds.length) {
    throw new OpensteerError({
      code: "conflict",
      message: "The frozen report context is incomplete",
    });
  }
  const initialContext = includeContext ? runRow.initialContext : null;
  const initialMessages = initialContext?.messageIds.length
    ? messagesFromRows(
        await database
          .selectFrom("messages")
          .selectAll()
          .where("id", "in", initialContext.messageIds)
          .where("threadId", "=", command.threadId)
          .orderBy("sequence", "asc")
          .execute(),
      )
    : [];
  if (initialContext && initialMessages.length !== initialContext.messageIds.length) {
    throw new OpensteerError({
      code: "conflict",
      message: "The frozen initial context is incomplete",
    });
  }
  const [threadRow, inputRows, bindingRow] = await Promise.all([
    database
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .where("id", "=", command.threadId)
      .executeTakeFirstOrThrow(),
    recovery
      ? database
          .selectFrom("messages")
          .innerJoin("threadInputs", "threadInputs.messageId", "messages.id")
          .selectAll("messages")
          .where("threadInputs.runId", "=", command.runId)
          .where("threadInputs.state", "=", "claimed")
          .where(sql<string>`messages.author->>'kind'`, "=", "platform")
          .where(sql<string>`messages.author->>'cause'`, "=", "run-recovery")
          .orderBy("messages.sequence", "desc")
          .limit(1)
          .execute()
      : restart
        ? database
            .selectFrom("messages")
            .innerJoin("threadInputs", "threadInputs.messageId", "messages.id")
            .leftJoin("commands", "commands.id", "threadInputs.steerCommandId")
            .selectAll("messages")
            .where("threadInputs.runId", "=", command.runId)
            .where("threadInputs.state", "=", "claimed")
            .where("threadInputs.policy", "!=", "report")
            // What a restart handed over, and what a conversation's dispatch of
            // the replacement took along with it.
            .where((expression) =>
              expression.or([
                expression("threadInputs.steerCommandId", "is", null),
                expression("commands.type", "=", "run.restart"),
              ]),
            )
            .orderBy("messages.sequence", "asc")
            .execute()
        : database
            .selectFrom("messages")
            .innerJoin("threadInputs", "threadInputs.messageId", "messages.id")
            .selectAll("messages")
            .where("messages.runId", "=", command.runId)
            .where("threadInputs.policy", "!=", "report")
            .where("messages.kind", "in", ["input", "run-result", "continuation"])
            .orderBy("sequence", "asc")
            .execute(),
    database
      .selectFrom("providerSessions")
      .selectAll()
      .where("id", "=", runRow.providerSessionId)
      .executeTakeFirst(),
  ]);
  if (inputRows.length === 0) {
    throw new OpensteerError({ code: "conflict", message: "Run has no claimed input batch" });
  }
  if (!bindingRow) {
    throw new OpensteerError({ code: "conflict", message: "Run has no exact provider session" });
  }
  const firstSequence = inputRows[0]!.sequence;
  const [workspaceRow, historyRowsDesc] = await Promise.all([
    database
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", threadRow.workspaceId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom("messages")
      .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
      .selectAll("messages")
      .where("messages.threadId", "=", command.threadId)
      .where("messages.sequence", "<", firstSequence)
      .where((expression) =>
        expression.or([
          expression("threadInputs.messageId", "is", null),
          expression("threadInputs.state", "=", "delivered"),
        ]),
      )
      .orderBy("messages.sequence", "desc")
      .limit(maxHistoryItems + 1)
      .execute(),
  ]);
  const firstAuthored =
    threadRow.titleSource === "provisional" || threadRow.iconSource === "provisional"
      ? await database
          .selectFrom("messages")
          .selectAll()
          .where("threadId", "=", threadRow.id)
          .where("kind", "=", "input")
          .where(sql<boolean>`author->>'kind' in ('human', 'agent', 'trigger', 'watch')`)
          .orderBy("sequence", "asc")
          .limit(1)
          .executeTakeFirst()
      : undefined;
  const firstContent = firstAuthored ? messagesFromRows([firstAuthored])[0]!.content : [];
  // A file alone has no request to name. Labels accompany the authored text,
  // without exposing a place's address or a file's contents to the titler.
  const hasText = firstContent.some((part) => part.type === "text" && part.text.trim().length > 0);
  const titleText = hasText
    ? firstContent
        .flatMap((part) =>
          part.type === "text"
            ? [part.text]
            : part.type === "artifact"
              ? [part.name]
              : isPlaceContentPart(part)
                ? [placeContentLabel(part)]
                : [],
        )
        .join("\n")
        .trim()
    : "";
  const request = titleText
    .slice(0, surrogateSafeCut(titleText, threadTitleRequestMaxLength))
    .trimEnd();
  const historyWindow = newestMessageWindow(
    messagesFromRows(historyRowsDesc),
    maxHistoryItems,
    maxHistoryBytes,
  );
  return {
    command,
    executionBinding:
      bindingRow?.runnerId &&
      bindingRow.runnerBootId &&
      bindingRow.leaseExpiresAt &&
      bindingRow.bindingGeneration > 0
        ? executionBindingFromRow(bindingRow)
        : null,
    providerSessionStateLayout: bindingRow.stateLayout,
    history: historyWindow.items,
    initialContext: initialContext
      ? {
          finalized: initialContext.finalized === true,
          messages: initialMessages,
          omittedCount: initialContext.omittedCount,
          throughSequence: initialContext.throughSequence,
        }
      : null,
    historyWindow: {
      byteCount: historyWindow.byteCount,
      hasEarlier: historyRowsDesc.length > historyWindow.items.length,
      itemCount: historyWindow.items.length,
    },
    inputs: messagesFromRows(inputRows),
    reports: !includeContext
      ? { messages: [], omittedCount: 0, throughSequence: null }
      : {
          messages: reports,
          omittedCount: runRow.reportContext.omittedCount,
          throughSequence: runRow.reportContext.throughSequence,
        },
    membershipGeneration: safeGeneration(runRow.membershipGeneration),
    firstOrdinal: runRow.nextRunnerOrdinal,
    run: runFromRow(runRow),
    thread: threadFromRow(threadRow),
    titleProvisional: threadRow.titleSource === "provisional",
    ...(request
      ? {
          titleRequest: {
            request,
            ...(threadRow.iconSource === "provisional" ? { icon: true as const } : {}),
          },
        }
      : {}),
    workspace: workspaceFromRow(workspaceRow),
  };
}

export async function acquireExecutionBinding(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly bindingLeaseExpiresAt: Date;
    readonly continuationIdentity: ProviderContinuationIdentity;
    readonly harnessInstanceId: HarnessInstanceId;
    readonly leaseTokenHash: string;
    readonly membershipGeneration: number;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  },
): Promise<
  ThreadExecutionBinding & {
    readonly continuationEvent?: AgentEvent;
    readonly grantId: GrantId;
    readonly revokedGrants: readonly RevokedRunGrant[];
  }
> {
  return withDatabaseTransaction(database, async (transaction) => {
    const continuationIdentity = ProviderContinuationIdentitySchema.parse(
      input.continuationIdentity,
    );
    const run = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select([
        "runs.environmentId",
        "runs.harnessInstanceId",
        "runs.modelSelection",
        "runs.providerSessionId",
        "runs.membershipGeneration",
        "runs.requestedBy",
        "runs.status",
        "runs.threadId",
        "runs.runOrdinal",
        "threads.workspaceId",
      ])
      .where("runs.id", "=", input.runId)
      .forNoKeyUpdate("runs")
      .executeTakeFirst();
    if (!run) throw new OpensteerError({ code: "not_found", message: "Run not found" });
    if (run.threadId !== input.threadId) {
      throw new OpensteerError({ code: "conflict", message: "Run does not match thread" });
    }
    if (run.status !== "starting") {
      throw new OpensteerError({
        code: "conflict",
        message: "Run is not awaiting an execution binding",
      });
    }
    if (safeGeneration(run.membershipGeneration) !== input.membershipGeneration) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Run membership generation does not match its dispatch capability",
      });
    }
    await lockWorkspaceRow(transaction, run.workspaceId);
    if (
      !(await threadExecutionIsAvailableToUser(
        transaction,
        run.threadId,
        run.requestedBy,
        input.membershipGeneration,
      ))
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Run execution authority is no longer active",
      });
    }
    // Parent fences follow ./lock-order.ts; SHARE also permits foreign-key inserts.
    await transaction
      .selectFrom("executionEnvironments")
      .select("id")
      .where("id", "=", run.environmentId)
      .forShare()
      .executeTakeFirstOrThrow();
    const harness = await transaction
      .selectFrom("harnessInstances")
      .select("enabled")
      .where("id", "=", input.harnessInstanceId)
      .forShare()
      .executeTakeFirst();
    if (!harness?.enabled) {
      throw new OpensteerError({ code: "conflict", message: "AI engine is unavailable" });
    }
    if (!(await channelRunAuthorityIsCurrent(transaction, input.runId))) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Messaging access changed before this Run could start",
      });
    }
    const thread = await transaction
      .selectFrom("threads")
      .innerJoin("executionEnvironments", "executionEnvironments.id", "threads.environmentId")
      .innerJoin("harnessInstances", "harnessInstances.id", "threads.harnessInstanceId")
      .select([
        "threads.environmentId",
        "threads.id as threadId",
        "threads.harnessInstanceId",
        "threads.workspaceId",
        "executionEnvironments.runnerId",
        "harnessInstances.driverKind",
      ])
      .where("threads.id", "=", input.threadId)
      .forNoKeyUpdate("threads")
      .executeTakeFirst();
    if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
    if (thread.runnerId !== input.runnerId) {
      throw new OpensteerError({
        code: "conflict",
        message: "The connected Runner does not own this thread's execution environment",
      });
    }
    if (
      thread.harnessInstanceId !== input.harnessInstanceId ||
      run.harnessInstanceId !== input.harnessInstanceId
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Run harness does not match thread",
      });
    }
    if (thread.driverKind !== continuationIdentity.driverKind) {
      throw new OpensteerError({
        code: "conflict",
        message: "Harness continuation identity does not match its driver",
      });
    }
    if (!run.providerSessionId) {
      throw new OpensteerError({
        code: "conflict",
        message: "Historical Run has no known ProviderSession",
      });
    }
    const session = await transaction
      .selectFrom("providerSessions")
      .selectAll()
      .where("id", "=", run.providerSessionId)
      .where("threadId", "=", run.threadId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!session?.active || session.harnessInstanceId !== input.harnessInstanceId) {
      throw new OpensteerError({
        code: "conflict",
        message: "Run's selected provider session is no longer current",
      });
    }
    if (
      session.continuationIdentity &&
      !sameProviderContinuationIdentity(session.continuationIdentity, continuationIdentity)
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Provider session continuation identity does not match this execution",
      });
    }
    // A reference only identifies native state; it does not prove that the
    // first input was accepted. Earlier unstarted attempts need an ordered
    // Runner terminal or proof that dispatch never began: a Run that was never
    // bound, or whose execute was never claimed. Without a reference, even a
    // confirmed start cannot be resumed.
    const unsafeRun = await transaction
      .selectFrom("runs")
      .select("id")
      .$if(session.stateLayout === "session", (query) =>
        query.where("providerSessionId", "=", session.id),
      )
      .$if(session.stateLayout === "thread", (query) =>
        query.where("threadId", "=", session.threadId),
      )
      .where("runOrdinal", "<", run.runOrdinal)
      .where((eb) =>
        eb.or([
          ...(session.providerSessionReference === null ? [eb("startedAt", "is not", null)] : []),
          eb.and([
            eb("startedAt", "is", null),
            eb("bindingGeneration", "is not", null),
            eb.not(
              eb.exists(
                eb
                  .selectFrom("workspaceEvents")
                  .select("eventId")
                  .whereRef("workspaceEvents.runId", "=", "runs.id")
                  .where("runnerOrdinal", "is not", null)
                  .where("type", "in", ["run.failed", "run.interrupted"]),
              ),
            ),
            eb.not(
              eb.exists(
                eb
                  .selectFrom("commands")
                  .select("commands.id")
                  .whereRef("commands.runId", "=", "runs.id")
                  .where("commands.type", "=", "run.execute")
                  .where("attempts", "=", 0),
              ),
            ),
          ]),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    const priorReference =
      session.providerSessionReference === null && session.stateLayout === "thread"
        ? await transaction
            .selectFrom("providerSessions")
            .select("id")
            .where("threadId", "=", session.threadId)
            .where("id", "!=", session.id)
            .where("providerSessionReference", "is not", null)
            .limit(1)
            .executeTakeFirst()
        : null;
    if (unsafeRun || priorReference) {
      throw new OpensteerError({
        code: "conflict",
        message:
          "This AI session has an uncertain native start and cannot be replayed. Choose Start fresh in the AI menu to continue in this conversation.",
      });
    }
    const replacement = await pendingReplacementAttempt(transaction, input.runId);
    if (replacement?.reason === "recovery") {
      const lost = await transaction
        .selectFrom("runAttempts")
        .select("runnerBootId")
        .where("runId", "=", input.runId)
        .where("bindingGeneration", "is not", null)
        .orderBy("ordinal", "desc")
        .limit(1)
        .executeTakeFirst();
      const runner = await transaction
        .selectFrom("runners")
        .select("capabilities")
        .where("id", "=", input.runnerId)
        .executeTakeFirstOrThrow();
      if (
        lost?.runnerBootId !== input.runnerBootId &&
        !runner.capabilities.includes("earlier-boots-contained-v1")
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "The Runner restarted before the Run reached a terminal event",
          reason: "earlier-boots-not-contained",
        });
      }
    }
    let continuationEvent: AgentEvent | undefined;
    if (!session.continuationIdentity) {
      await transaction
        .updateTable("providerSessions")
        .set({ continuationIdentity: jsonValue(continuationIdentity), updatedAt: new Date() })
        .where("id", "=", session.id)
        .where("continuationIdentity", "is", null)
        .executeTakeFirstOrThrow();
      continuationEvent = await appendHostWorkspaceEvent(transaction, {
        data: { continuationIdentity },
        environmentId: thread.environmentId,
        runId: input.runId,
        threadId: thread.threadId,
        type: "thread.continuation-established",
        workspaceId: thread.workspaceId,
      });
    }
    const row = await transaction
      .updateTable("providerSessions")
      .set({
        bindingGeneration: session.bindingGeneration + 1,
        leaseExpiresAt: input.bindingLeaseExpiresAt,
        leaseTokenHash: input.leaseTokenHash,
        runnerBootId: input.runnerBootId,
        runnerId: input.runnerId,
        status: "starting",
        updatedAt: new Date(),
      })
      .where("id", "=", session.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("runs")
      .set({ bindingGeneration: row.bindingGeneration })
      .where("id", "=", input.runId)
      .executeTakeFirstOrThrow();
    const { grantId, revokedGrants } = await issueRunGrant(transaction, {
      bindingGeneration: row.bindingGeneration,
      modelSelection: run.modelSelection,
      runId: input.runId,
      runnerBootId: input.runnerBootId,
      runnerId: input.runnerId,
    });
    return {
      ...executionBindingFromRow(row),
      grantId,
      revokedGrants,
      ...(continuationEvent ? { continuationEvent } : {}),
    };
  });
}

export async function renewExecutionBinding(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly bindingGeneration: number;
    readonly leaseExpiresAt: Date;
    readonly leaseTokenHash: string;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  },
  executionNow: () => number = Date.now,
): Promise<boolean> {
  const run = await database
    .selectFrom("runs")
    .select(["providerSessionId", "threadId"])
    .where("id", "=", input.runId)
    .where("status", "in", ["starting", "running", "waiting"])
    .executeTakeFirst();
  if (!run?.providerSessionId || run.threadId !== input.threadId) return false;
  const result = await database
    .updateTable("providerSessions")
    .set({ leaseExpiresAt: input.leaseExpiresAt, updatedAt: new Date() })
    .where("active", "=", true)
    .where("threadId", "=", input.threadId)
    .where("id", "=", run.providerSessionId)
    .where("runnerId", "=", input.runnerId)
    .where("runnerBootId", "=", input.runnerBootId)
    .where("bindingGeneration", "=", input.bindingGeneration)
    .where("leaseTokenHash", "=", input.leaseTokenHash)
    .where("leaseExpiresAt", ">", new Date(executionNow()))
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * Who a Run acts for, when it is that Thread's in that Workspace: the person
 * whose integration grants its gateway calls use. Null for any other Run.
 */
export async function runRequester(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly runId: RunId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<UserId | null> {
  const row = await database
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select("runs.requestedBy")
    .where("runs.id", "=", input.runId)
    .where("runs.threadId", "=", input.threadId)
    .where("threads.workspaceId", "=", input.workspaceId)
    .executeTakeFirst();
  return row?.requestedBy ?? null;
}

export async function assertActiveExecutionBinding(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly bindingGeneration: number;
    readonly environmentId: EnvironmentId;
    readonly membershipGeneration: number;
    readonly requestedBy: UserId;
    readonly runId: RunId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  },
  executionNow: () => number = Date.now,
): Promise<void> {
  await withDatabaseTransaction(database, (transaction) =>
    assertActiveExecutionBindingInStore(transaction, input, executionNow),
  );
}

export async function assertActiveGrant(
  database: Kysely<DatabaseSchema>,
  input: Parameters<typeof assertActiveExecutionBinding>[1] & {
    readonly grantId?: GrantId | undefined;
  },
  executionNow: () => number = Date.now,
): Promise<void> {
  await withDatabaseTransaction(database, (transaction) =>
    assertActiveGrantInStore(transaction, input, executionNow),
  );
}

export async function bindProviderSession(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly bindingGeneration: number;
    readonly engineStart?: "cold" | "warm";
    readonly harnessInstanceId: HarnessInstanceId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerSessionReference: string;
    readonly runId: RunId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
  },
): Promise<void> {
  await withDatabaseTransaction(database, async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select([
        "runs.membershipGeneration",
        "runs.providerSessionId",
        "runs.requestedBy",
        "runs.status",
        "runs.threadId",
        "threads.workspaceId",
      ])
      .where("runs.id", "=", input.runId)
      .forNoKeyUpdate("runs")
      .executeTakeFirst();
    if (
      !run ||
      run.threadId !== input.threadId ||
      run.providerSessionId !== input.providerSessionId ||
      !["starting", "running", "waiting"].includes(run.status)
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Provider session run does not match thread",
      });
    }
    await lockWorkspaceRow(transaction, run.workspaceId);
    if (
      !(await threadExecutionIsAvailableToUser(
        transaction,
        run.threadId,
        run.requestedBy,
        safeGeneration(run.membershipGeneration),
      ))
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Run execution authority is no longer active",
      });
    }
    const result = await transaction
      .updateTable("providerSessions")
      .set({
        providerSessionReference: input.providerSessionReference,
        // A Runner states its binding again after reconnecting, possibly
        // once the Run is already under way; that must not move it back.
        status: sql<
          "ready" | "running"
        >`case when status = 'starting' then 'ready' else status end`,
        updatedAt: new Date(),
      })
      .where("id", "=", input.providerSessionId)
      .where("active", "=", true)
      .where("threadId", "=", input.threadId)
      .where("harnessInstanceId", "=", input.harnessInstanceId as HarnessInstanceId)
      .where("runnerId", "=", input.runnerId)
      .where("runnerBootId", "=", input.runnerBootId)
      .where("bindingGeneration", "=", input.bindingGeneration)
      .where((expression) =>
        expression.or([
          expression("providerSessionReference", "is", null),
          expression("providerSessionReference", "=", input.providerSessionReference),
        ]),
      )
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new OpensteerError({ code: "conflict", message: "Stale provider session binding" });
    }
    if (input.engineStart) {
      await transaction
        .updateTable("runAttempts")
        .set({ engineStart: input.engineStart })
        .where("runId", "=", input.runId)
        .where("bindingGeneration", "=", input.bindingGeneration)
        .execute();
    }
  });
}

/**
 * What a Run's capability tokens are scoped to, while it holds an active grant
 * for its current binding: the Host reissues them from this alone.
 */
export async function runCapabilityScope(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<{
  readonly bindingGeneration: number;
  readonly capabilityProfileId: DatabaseSchema["threads"]["capabilityProfileId"];
  readonly environmentId: EnvironmentId;
  readonly grantId: GrantId;
  readonly membershipGeneration: number;
  readonly requestedBy: UserId;
  readonly runId: RunId;
  readonly runnerBootId: string;
  readonly runnerId: RunnerId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
} | null> {
  const row = await database
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin("grants", (join) =>
      join
        .onRef("grants.runId", "=", "runs.id")
        .onRef("grants.bindingGeneration", "=", "runs.bindingGeneration")
        .on("grants.status", "=", "active"),
    )
    .select([
      "grants.bindingGeneration",
      "grants.id as grantId",
      "grants.runnerBootId",
      "grants.runnerId",
      "runs.environmentId",
      "runs.membershipGeneration",
      "runs.requestedBy",
      "runs.threadId",
      "threads.capabilityProfileId",
      "threads.workspaceId",
    ])
    .where("runs.id", "=", runId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    bindingGeneration: row.bindingGeneration,
    capabilityProfileId: row.capabilityProfileId,
    environmentId: row.environmentId,
    grantId: row.grantId,
    membershipGeneration: safeGeneration(row.membershipGeneration),
    requestedBy: row.requestedBy,
    runId,
    runnerBootId: row.runnerBootId,
    runnerId: row.runnerId,
    threadId: row.threadId,
    workspaceId: row.workspaceId,
  };
}
