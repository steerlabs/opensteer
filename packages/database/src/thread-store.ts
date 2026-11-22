import { commitPersonalMutation, threadPendingRequestsCount } from "./personal-mutation.js";
import { closeAgentOperationRequestsAboveMode } from "./agent-session-store.js";
import { refreshInputQueue } from "./waiting-inputs.js";
import { lockThreadProviderSession } from "./run-projection-locks.js";
import { compactionReturnHint } from "./compaction-eligibility.js";
import { withPersonalReadTransaction } from "./personal-transaction.js";
import { type TaskPurpose } from "@opensteer/core";
import { requirePersonalOwner } from "./personal-settings-store.js";
import type { MemoryPassExecution } from "./memory-pass-store.js";
import { getThreadNamingInput } from "./execution-store.js";
import { environmentIsAvailableToUser } from "./environment-store.js";
import {
  assertThreadCaller,
  lockThreadCaller,
  threadCallerLineageId,
  withThreadCallerTransaction,
  type ThreadCallerAuthority,
} from "./thread-caller.js";
import { admitThreadWrite, requireThreadWriteAuthority } from "./task-done.js";
import { TransactionScopeChanged } from "./connection.js";
import { prepareThreadInsertion } from "./thread-insertion.js";
import type { Sequence } from "@opensteer/core";
import {
  type IconName,
  IconNameSchema,
  defaultTaskSymbol,
  type ThreadAccessMode,
  type UserId,
  type EnvironmentId,
  type HarnessInstanceId,
  type ThreadId,
  type ModelSelection,
  type Thread,
  type RunId,
  type TriggerOccurrenceId,
  type TriggerWatchActivationId,
  type TriggerRevisionId,
  type TriggerId,
  type MessageId,
  type PlaceContentPart,
  type ContentPart,
  type ThreadInputPolicy,
  type HarnessId,
  type ThreadInput,
  type Message,
  type Run,
  type AssignmentSummary,
  DEFAULT_THREAD_ACCESS_MODE,
  ThreadAccessModeSchema,
  threadAccessModeAtMost,
  ThreadTitleSchema,
  GeneratedThreadTitleSchema,
  type ThreadTitleSource,
  OpensteerError,
  ThreadIdSchema,
  type AssignmentId,
  type AssignmentView,
  AssignmentIdSchema,
  createId,
  ModelSelectionSchema,
  type ProviderContinuationIdentity,
  type ProviderSessionId,
  ProviderContinuationIdentitySchema,
  nonTerminalRunStatuses,
  sameProviderContinuationIdentity,
} from "@opensteer/core";
import { type CommandRow, type ThreadRow, type DatabaseSchema } from "./schema.js";
import { type RevokedRunGrant } from "./run-grants.js";
import type { BrowserUsageCredit } from "./browser-session-store.js";
import {
  type RunToolAdmissionInput,
  type TriggerControlAdmissionInput,
  type WatchControlAdmissionInput,
  type RunToolAdmissionResult,
  admitRunToolCall as persistRunToolAdmission,
  type TriggerControlAdmissionResult,
  admitTriggerControlRequest as persistTriggerControlAdmission,
  admitRunToolCallInTransaction,
  admitTriggerControlRequestInTransaction,
  admitWatchControlRequestInTransaction,
  type AdmissionMode,
} from "./run-tool-admission.js";
import { type DurableWindow } from "@opensteer/protocol";
import { type Transaction, type Kysely, sql } from "kysely";
import {
  findCommandByIdempotency,
  idempotencyConflict,
  boundedLimit,
  boundedWindowLimit,
  boundedWindowBytes,
  decodeWindowCursor,
  encodeWindowCursor,
  safeCount,
  escapeLikePattern,
  lockCommandIdempotency,
  requireExecutionEnvironmentAccess,
  principalIdForUser,
  jsonValue,
  type ChannelLinks,
  lockThreadRow,
} from "./store-primitives.js";
import { isDeepStrictEqual } from "node:util";
import {
  threadPendingRequestsSelection,
  threadVisitSelection,
  threadProviderSessionSelection,
  threadContinuationIdentitySelection,
  threadFromRow,
  threadsFromRows,
  assignmentFromRow,
  messagesFromRows,
} from "./thread-row-mappers.js";
import { boundedSerializedPrefix } from "./message-window.js";
import { republishPendingRequestsShowing } from "./personal-attention-store.js";
import {
  assignmentSummaryInTransaction,
  refreshAssignmentWorkerSummaries,
  lockThreadNameDestinations,
  type CancelAssignmentInput,
  type CancelAssignmentResult,
  cancelAssignmentInTransaction,
  drainAssignmentCancellation,
} from "./assignment-store.js";
import {
  ensureSelectedProviderSession,
  findDelegatedThreadByIdempotency as findDelegatedThreadByIdempotencyInStore,
  delegateThreadInTransaction,
  lockDelegationIdempotency,
  type AssignmentReturnDrain,
  drainPendingAssignmentReturns as drainPendingAssignmentReturnsInStore,
  drainAssignmentReturn as drainAssignmentReturnInStore,
  ensureQueuedRun,
  enqueueThreadInputInTransaction,
  lockThreadInputIdempotency,
  steerThreadInputInTransaction,
  cancelThreadInputInTransaction,
  moveThreadInputInTransaction,
  readThreadInputQueue,
} from "./thread-inbox.js";
import {
  projectThreadState,
  publishRunQueue,
  publishThreadSummary,
  threadMutationHead,
} from "./thread-status.js";
export interface CreateThreadInput {
  readonly expectedHarnessRevision?: number;
  readonly icon?: IconName;
  readonly authority?: ThreadCallerAuthority;
  readonly accessMode?: ThreadAccessMode;
  readonly createdBy: UserId;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly purpose?: TaskPurpose;
  readonly generateTitle?: true;
  readonly id?: ThreadId;
  readonly idempotencyKey: string;
  readonly modelSelection: ModelSelection;
  readonly parentThreadId?: ThreadId;
  readonly title: string;
}
export interface ThreadCreationResult {
  readonly asOfSequence: Sequence;

  readonly thread: Thread;
  readonly wasDuplicate: boolean;
}
export interface ThreadUpdateResult {
  readonly asOfSequence: Sequence;

  readonly thread: Thread;
}

/**
 * The Host authors attribution: an agent-originated turn carries the source
 * Thread and Run copied from the sending Run's authenticated capability, never
 * a value the sending model supplied.
 */
export interface BridgeChatSource {
  readonly conversationId: string;
  readonly sender: { readonly displayName: string; readonly owner: boolean };
}
export type ThreadInputSource =
  | {
      readonly kind: "human";
      readonly clientSessionId?: string;
      /** Facts for the agent only: never part of the request's idempotency fingerprint. */
      readonly origin?: import("@opensteer/core").MessageOrigin;
    }
  | {
      readonly kind: "connection";
      readonly connectionId: string;
      /**
       * A message that came through a messaging bridge: the conversation the reply goes back
       * to and who wrote it. Set by the Home from the chat, never from a tool's input.
       */
      readonly chat?: BridgeChatSource;
    }
  | {
      readonly kind: "agent";
      readonly runId: RunId;
    }
  | {
      readonly kind: "trigger";
      readonly occurrenceId: TriggerOccurrenceId;
    }
  | {
      readonly activationId: TriggerWatchActivationId;
      readonly kind: "watch";
      readonly observationId: string;
      readonly revisionId: TriggerRevisionId;
      readonly triggerId: TriggerId;
    }
  | {
      readonly kind: "platform";
      readonly cause: string;
      readonly referenceId?: string;
      readonly sourceRunId: RunId;
    }
  | {
      /**
       * The Host telling an automation's anchor Thread that it stopped
       * working. It has no Run to continue, so it is checked against the
       * Trigger itself: its owner, and the Thread it is anchored to.
       */
      readonly kind: "automation";
      readonly noticeId: string;
      readonly triggerId: TriggerId;
    }
  | {
      readonly kind: "channel";
      readonly conversationId: string;
      readonly ingressId: string;
      readonly principalId: string;
    };
export interface EnqueueThreadInputRequest {
  readonly compaction?: import("@opensteer/core").CompactionSendChoice;
  readonly maintenance?: import("@opensteer/core").RunMaintenance;
  readonly maintenanceNowMs?: number;
  readonly freshContext?: boolean;
  readonly requireUnassigned?: true;
  readonly authority?: ThreadCallerAuthority;
  readonly quotedMessageId?: MessageId;
  readonly content: readonly ContentPart[];
  readonly idempotencyKey: string;
  readonly policy: ThreadInputPolicy;
  readonly requestedBy: UserId;
  readonly source: ThreadInputSource;
  readonly threadId: ThreadId;
  readonly forwardedPlaces?: true;
  /** Host-resolved model for a managed memory pass's own wake; without it the wake is skipped. */
  readonly memoryPass?: MemoryPassExecution;
  readonly expectedHarnessRevision?: number;
  /** Host-only live route check, called after durable replay and before a new claim. */
  readonly validateNewAttachmentInput?: (selection: {
    readonly driverKind: HarnessId;
    readonly environmentId: EnvironmentId;
    readonly harnessInstanceId: HarnessInstanceId;
    readonly modelSelection: ModelSelection;
    readonly steering: boolean;
  }) => void;
}
export interface EnqueuedThreadInput {
  /** The conversation gained the browser pages its sender included; absent when none. */
  readonly browserUsage?: readonly BrowserUsageCredit[];
  readonly command: CommandRow | null;
  readonly disposition: "cancelled" | "pending" | "steering" | "run-queued";

  readonly input: ThreadInput;
  readonly message: Message;
  /** The grant a restart took from the attempt it interrupts. */
  readonly revokedGrants: readonly RevokedRunGrant[];
  readonly run: Run | null;
  readonly wasDuplicate: boolean;
}
export interface SteerThreadInputRequest {
  readonly sessionId?: import("@opensteer/core").AuthSessionId;
  readonly authority?: ThreadCallerAuthority;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly expectedRunId: RunId;
  readonly requestedBy: UserId;
  readonly idempotencyKey: string;
}
export interface CancelThreadInputRequest {
  readonly sessionId?: import("@opensteer/core").AuthSessionId;
  readonly authority?: ThreadCallerAuthority;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly idempotencyKey: string;
  readonly requestedBy: UserId;
}

/**
 * Withdrawal retires only the queue entry, so the result carries the input and
 * nothing a delivery would: no command, no disposition, no Run.
 */
export interface CancelledThreadInput {
  readonly revokedGrants?: readonly RevokedRunGrant[];

  readonly input: ThreadInput;
  readonly wasDuplicate: boolean;
}
export interface MoveThreadInputRequest {
  readonly sessionId?: import("@opensteer/core").AuthSessionId;
  readonly authority?: ThreadCallerAuthority;
  /** The waiting message to stand in front of, or null for the back of the queue. */
  readonly beforeMessageId: MessageId | null;
  readonly idempotencyKey: string;
  readonly messageId: MessageId;
  readonly requestedBy: UserId;
  readonly threadId: ThreadId;
}
export interface MovedThreadInput {
  readonly revokedGrants?: readonly RevokedRunGrant[];

  readonly wasDuplicate: boolean;
}
export interface DelegateThreadRequest {
  readonly expectedHarnessRevision?: number;
  readonly callerIntent?: Pick<RunToolAdmissionInput, "requestId" | "requestFingerprint">;
  readonly accessMode: ThreadAccessMode;
  readonly createdBy: UserId;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly idempotencyKey: string;
  readonly modelSelection: ModelSelection;
  readonly origin:
    | {
        readonly kind: "run";
        readonly parentRunId: RunId;
        readonly parentThreadId: ThreadId;
      }
    | {
        readonly kind: "trigger";
        readonly occurrenceId: TriggerOccurrenceId;
        readonly parentThreadId: ThreadId;
      }
    | {
        readonly activationId: TriggerWatchActivationId;
        readonly kind: "watch";
        readonly observationId: string;
        readonly parentThreadId: ThreadId;
        readonly revisionId: TriggerRevisionId;
        readonly triggerId: TriggerId;
      };
  readonly task: readonly ContentPart[];
  readonly threadId?: ThreadId;
  readonly title: string;
  readonly titleSource?: ThreadTitleSource;
}
export interface DelegatedThreadResult {
  readonly browserUsage?: readonly BrowserUsageCredit[];
  readonly assignment: import("@opensteer/core").AssignmentSummary;
  readonly command: CommandRow;

  readonly input: ThreadInput;
  readonly message: Message;
  readonly run: Run;
  readonly thread: Thread;
  readonly wasDuplicate: boolean;
}
export type ThreadMutationAdmission =
  | {
      readonly kind: "agent";
      readonly request: RunToolAdmissionInput;
    }
  | {
      readonly kind: "trigger";
      readonly request: TriggerControlAdmissionInput;
    }
  | {
      readonly kind: "watch";
      readonly request: WatchControlAdmissionInput;
    };
export interface AdmittedThreadInputRequest {
  readonly admission: ThreadMutationAdmission;
  readonly input: EnqueueThreadInputRequest;
}
export interface AdmittedThreadDelegationRequest {
  readonly admission: ThreadMutationAdmission;
  readonly input: DelegateThreadRequest;
}
export interface OwnedThreadRead {
  readonly messages: readonly Message[];
  readonly thread: Thread;
}
export interface OwnerThreadPage {
  readonly threads: readonly Thread[];
  readonly window: DurableWindow;
}
interface AgentThreadListEntry {
  readonly assignmentId: AssignmentId | null;
  readonly taskStatus: AssignmentSummary["status"] | null;
  readonly doneAt: string | null;
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly pendingRequests: number;
  readonly status: ThreadRow["status"];
  readonly title: string;
  readonly updatedAt: string;
  readonly newMessages?: number;
  readonly firstNewAt?: string;
}
export interface AgentThreadListPage {
  readonly threads: readonly AgentThreadListEntry[];
  readonly window: DurableWindow;
}
export type AgentThreadListScope =
  | {
      readonly kind: "lineage";
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "personal";
    }
  /** Only the tasks in one connected agent's lineage. */
  | {
      readonly kind: "connection";
      readonly connectionId: string;
    };
async function findExistingThreadCreation(
  transaction: Transaction<DatabaseSchema>,
  input: CreateThreadInput,
  requestPayload: Readonly<Record<string, unknown>>,
): Promise<ThreadCreationResult | undefined> {
  const existingCommand = await findCommandByIdempotency(
    transaction,
    input.createdBy,
    input.idempotencyKey,
  );
  if (!existingCommand) return undefined;
  if (
    existingCommand.type !== "thread.create" ||
    !existingCommand.threadId ||
    !isDeepStrictEqual(existingCommand.payload, requestPayload)
  ) {
    throw idempotencyConflict(input.idempotencyKey);
  }
  const existingThread = await transaction
    .selectFrom("threads")
    .selectAll()
    .select([
      threadPendingRequestsSelection,
      threadVisitSelection,
      threadProviderSessionSelection,
      threadContinuationIdentitySelection,
    ])
    .where("id", "=", existingCommand.threadId)
    .executeTakeFirstOrThrow();
  return {
    asOfSequence: await threadMutationHead(transaction, existingThread.id),
    thread: threadFromRow(existingThread),
    wasDuplicate: true,
  };
}
function canonicalCreateThreadInput(input: CreateThreadInput): Readonly<Record<string, unknown>> {
  // The idempotency payload is the request as the caller made it. A selection's
  // `nativeModelId` is neither: the Host reads it off the live catalog, so a
  // retry after that catalog changed would read as a different request and be
  // refused instead of returning the Thread the first call created.
  const { nativeModelId: _nativeModelId, ...modelSelection } = input.modelSelection;
  return {
    ...(input.expectedHarnessRevision === undefined
      ? {}
      : {
          expectedHarnessRevision: input.expectedHarnessRevision,
        }),
    ...(input.icon
      ? {
          icon: input.icon,
        }
      : {}),
    accessMode: input.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
    createdBy: input.createdBy,
    environmentId: input.environmentId,
    harnessInstanceId: input.harnessInstanceId,
    ...(input.generateTitle
      ? {
          generateTitle: true,
        }
      : {}),
    modelSelection,
    ...(input.id
      ? {
          id: input.id,
        }
      : {}),
    idempotencyKey: input.idempotencyKey,
    ...(input.parentThreadId
      ? {
          parentThreadId: input.parentThreadId,
        }
      : {}),
    title: input.title,
    purpose: input.purpose ?? "task",
  };
}
async function resolveCreateThreadAccessMode(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: CreateThreadInput,
): Promise<ThreadAccessMode> {
  if (input.accessMode) return ThreadAccessModeSchema.parse(input.accessMode);
  if (!input.parentThreadId) return DEFAULT_THREAD_ACCESS_MODE;
  const parent = await database
    .selectFrom("threads")
    .select("accessMode")
    .where("id", "=", input.parentThreadId)
    .executeTakeFirst();
  return parent?.accessMode ?? DEFAULT_THREAD_ACCESS_MODE;
}
function assertThreadMutationAdmission(
  admission: ThreadMutationAdmission,
  action: "thread.delegate" | "thread.message",
  input: DelegateThreadRequest | EnqueueThreadInputRequest,
): void {
  if (admission.request.action !== action) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Control admission action mismatch",
    });
  }
  const message = "content" in input;
  if (admission.kind === "agent") {
    const sourceMatches = message
      ? input.source.kind === "agent" && input.source.runId === admission.request.runId
      : input.origin.kind === "run" &&
        input.origin.parentRunId === admission.request.runId &&
        input.origin.parentThreadId === admission.request.sourceThreadId;
    const userMatches =
      (message ? input.requestedBy : input.createdBy) === admission.request.requestedBy;
    if (!sourceMatches || !userMatches) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Agent mutation does not match its admitted Run capability",
      });
    }
    return;
  }
  if (admission.kind === "trigger") {
    const sourceMatches = message
      ? input.source.kind === "trigger" &&
        input.source.occurrenceId === admission.request.occurrenceId
      : input.origin.kind === "trigger" &&
        input.origin.occurrenceId === admission.request.occurrenceId &&
        input.origin.parentThreadId === admission.request.threadId;
    const userMatches =
      (message ? input.requestedBy : input.createdBy) === admission.request.requestedBy;
    if (!sourceMatches || !userMatches) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Trigger mutation does not match its admitted Occurrence capability",
      });
    }
    return;
  }
  const sourceMatches = message
    ? input.source.kind === "watch" &&
      input.source.activationId === admission.request.activationId &&
      input.source.observationId === admission.request.observationId
    : input.origin.kind === "watch" &&
      input.origin.activationId === admission.request.activationId &&
      input.origin.observationId === admission.request.observationId &&
      input.origin.parentThreadId === admission.request.anchorThreadId;
  const userMatches =
    (message ? input.requestedBy : input.createdBy) === admission.request.createdBy;
  if (!sourceMatches || !userMatches) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Watch mutation does not match its admitted activation capability",
    });
  }
}
export async function listThreadsForOwner(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  limit = 10_000,
): Promise<readonly Thread[]> {
  await requirePersonalOwner(database, ownerId);
  const rows = await database
    .selectFrom("threads")
    .selectAll("threads")
    .select([
      threadPendingRequestsSelection,
      threadVisitSelection,
      threadProviderSessionSelection,
      threadContinuationIdentitySelection,
    ])
    .orderBy("threads.updatedAt", "desc")
    .limit(boundedLimit(limit, 10_000))
    .execute();
  return threadsFromRows(rows);
}
export async function ownerThreadPageForOwner(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly ownerId: UserId;
  },
): Promise<OwnerThreadPage> {
  const maxItems = boundedWindowLimit(input.maxItems, 100);
  const maxBytes = boundedWindowBytes(input.maxBytes, 192 * 1_024);
  const anchor = input.before
    ? decodeWindowCursor(input.before, "owner-thread", input.ownerId)
    : null;
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      await requirePersonalOwner(transaction, input.ownerId);
      let query = transaction
        .selectFrom("threads")
        .selectAll("threads")
        .select([
          threadPendingRequestsSelection,
          threadVisitSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ]);
      if (anchor) {
        query = query.where((expressions) =>
          expressions.or([
            expressions("threads.updatedAt", "<", anchor.timestamp),
            expressions.and([
              expressions("threads.updatedAt", "=", anchor.timestamp),
              expressions("threads.id", "<", ThreadIdSchema.parse(anchor.id)),
            ]),
          ]),
        );
      }
      const [rows, countRow] = await Promise.all([
        query
          .orderBy("threads.updatedAt", "desc")
          .orderBy("threads.id", "desc")
          .limit(maxItems + 1)
          .execute(),
        transaction
          .selectFrom("threads")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow(),
      ]);
      const window = boundedSerializedPrefix(
        threadsFromRows(rows.slice(0, maxItems)),
        maxItems,
        maxBytes,
      );
      const hasMore = rows.length > window.items.length;
      const oldest = window.items.at(-1);
      return {
        threads: window.items,
        window: {
          byteCount: window.byteCount,
          hasMore,
          itemCount: window.items.length,
          nextBefore:
            hasMore && oldest
              ? encodeWindowCursor("owner-thread", input.ownerId, oldest.updatedAt, oldest.id)
              : null,
          totalItems: safeCount(countRow.count),
        },
      };
    },
    "repeatable read",
  );
}
export async function getAssignment(
  database: Kysely<DatabaseSchema>,
  id: AssignmentId,
): Promise<AssignmentView | null> {
  const row = await database
    .selectFrom("delegations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? assignmentFromRow(row) : null;
}
export async function getAssignmentForOwner(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly assignmentId: AssignmentId;
    readonly ownerId: UserId;
  },
): Promise<AssignmentView | null> {
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      await requirePersonalOwner(transaction, input.ownerId);
      const row = await transaction
        .selectFrom("delegations")
        .innerJoin("threads as workerThread", "workerThread.id", "delegations.childThreadId")
        .selectAll("delegations")
        .where("delegations.id", "=", input.assignmentId)
        .executeTakeFirst();
      if (!row) return null;
      const parent = await transaction
        .selectFrom("threads")
        .select("threads.id")
        .where("threads.id", "=", row.parentThreadId)
        .executeTakeFirst();
      return parent ? assignmentFromRow(row) : null;
    },
    "repeatable read",
  );
}
export async function listThreadAssignmentsForOwner(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly open?: boolean;
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
  },
): Promise<{
  readonly assignments: readonly AssignmentSummary[];
  readonly window: DurableWindow;
} | null> {
  const maxItems = boundedWindowLimit(input.maxItems, 100);
  const maxBytes = boundedWindowBytes(input.maxBytes, 256 * 1_024);
  const anchor = input.before
    ? decodeWindowCursor(input.before, "assignment", input.threadId)
    : null;
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      await requirePersonalOwner(transaction, input.ownerId);
      const thread = await transaction
        .selectFrom("threads")
        .select("threads.id")
        .where("threads.id", "=", input.threadId)
        .executeTakeFirst();
      if (!thread) return null;
      let base = transaction
        .selectFrom("delegations")
        .innerJoin("threads as workerThread", "workerThread.id", "delegations.childThreadId")
        .innerJoin("threads as parentThread", "parentThread.id", "delegations.parentThreadId")
        .where((expressions) =>
          expressions.or([
            expressions("delegations.childThreadId", "=", input.threadId),
            expressions("delegations.parentThreadId", "=", input.threadId),
          ]),
        );
      if (input.open) base = base.where("delegations.status", "=", "open");
      let query = base.selectAll("delegations");
      if (anchor) {
        query = query.where((expressions) =>
          expressions.or([
            expressions("delegations.createdAt", "<", anchor.timestamp),
            expressions.and([
              expressions("delegations.createdAt", "=", anchor.timestamp),
              expressions("delegations.id", "<", AssignmentIdSchema.parse(anchor.id)),
            ]),
          ]),
        );
      }
      const [rows, countRow] = await Promise.all([
        query
          .orderBy("delegations.createdAt", "desc")
          .orderBy("delegations.id", "desc")
          .limit(maxItems + 1)
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      ]);
      const candidates = await Promise.all(
        rows.slice(0, maxItems).map((row) => assignmentSummaryInTransaction(transaction, row)),
      );
      const window = boundedSerializedPrefix(candidates, maxItems, maxBytes);
      if (rows.length > 0 && window.items.length === 0) {
        throw new OpensteerError({
          code: "bad_request",
          message: "Assignment page byte limit cannot hold one summary",
        });
      }
      const hasMore = rows.length > window.items.length;
      const oldest = window.items.at(-1);
      return {
        assignments: window.items,
        window: {
          byteCount: window.byteCount,
          hasMore,
          itemCount: window.items.length,
          nextBefore:
            hasMore && oldest
              ? encodeWindowCursor("assignment", input.threadId, oldest.createdAt, oldest.id)
              : null,
          totalItems: safeCount(countRow.count),
        },
      };
    },
    "repeatable read",
  );
}
export async function agentThreadPageForOwner(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly ownerId: UserId;
    readonly query?: string;
    readonly scope: AgentThreadListScope;
    readonly scopeId: string;
    readonly parentThreadId?: ThreadId;
    readonly changedSince?: Date;
    readonly nativeOnly?: boolean;
  },
): Promise<AgentThreadListPage> {
  const maxItems = boundedWindowLimit(input.maxItems, 50);
  const maxBytes = boundedWindowBytes(input.maxBytes, 192 * 1_024);
  const since = input.changedSince ?? null;
  // A changed page orders by new messages, so its cursor is bound to that order and that time.
  const cursorKind = since ? "agent-thread-changed" : "agent-thread";
  const cursorScope = since ? `${input.scopeId}@${since.toISOString()}` : input.scopeId;
  const anchor = input.before ? decodeWindowCursor(input.before, cursorKind, cursorScope) : null;
  const pattern = input.query === undefined ? null : `%${escapeLikePattern(input.query)}%`;
  const scope = input.scope;
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      await requirePersonalOwner(transaction, input.ownerId);
      const lineageRootThreadId =
        scope.kind === "lineage"
          ? (
              await transaction
                .selectFrom("threads")
                .select("lineageRootThreadId")
                .where("id", "=", scope.threadId)
                .executeTakeFirstOrThrow()
            ).lineageRootThreadId
          : null;
      let base = transaction
        .selectFrom("threads")
        .where("threads.removedAt", "is", null)
        .$if(input.nativeOnly === true, (q) => q.where("threads.worker", "=", "native"))
        .$if(since !== null, (query) =>
          query.innerJoin(changedThreads(transaction, since!).as("changed"), (join) =>
            join.onRef("changed.threadId", "=", "threads.id"),
          ),
        );
      if (input.parentThreadId) {
        base = base.where((eb) =>
          eb.or([
            eb("threads.parentThreadId", "=", input.parentThreadId!),
            eb.exists(
              eb
                .selectFrom("delegations")
                .select("id")
                .whereRef("delegations.childThreadId", "=", "threads.id")
                .where("delegations.parentThreadId", "=", input.parentThreadId!),
            ),
          ]),
        );
      }
      if (scope.kind === "lineage") {
        base = base.where("threads.lineageRootThreadId", "=", lineageRootThreadId!);
      }
      if (scope.kind === "connection") {
        base = base.where("threads.originConnectionId", "=", scope.connectionId);
      }
      if (pattern) {
        base = base.where(sql<boolean>`threads.title ilike ${pattern} escape '\\'`);
      }
      let page = base;
      if (anchor && since) {
        page = page.where(
          sql<boolean>`(changed.last_new_at, threads.id) < (${anchor.timestamp}, ${ThreadIdSchema.parse(anchor.id)})`,
        );
      } else if (anchor) {
        page = page.where((expressions) =>
          expressions.or([
            expressions("threads.updatedAt", "<", anchor.timestamp),
            expressions.and([
              expressions("threads.updatedAt", "=", anchor.timestamp),
              expressions("threads.id", "<", ThreadIdSchema.parse(anchor.id)),
            ]),
          ]),
        );
      }
      const [rows, countRow] = await Promise.all([
        page
          .leftJoinLateral(
            (eb) => {
              let assignment = eb
                .selectFrom("delegations as d")
                .innerJoin("threads as parent", "parent.id", "d.parentThreadId")
                .select(["d.id as assignmentId", "d.status as taskStatus"])
                .whereRef("d.childThreadId", "=", "threads.id");
              if (input.parentThreadId)
                assignment = assignment.where("d.parentThreadId", "=", input.parentThreadId);
              return assignment
                .orderBy(sql`(d.status = 'open')`, "desc")
                .orderBy("d.createdAt", "desc")
                .orderBy("d.id", "desc")
                .limit(1)
                .as("task");
            },
            (join) => join.onTrue(),
          )
          .select(["task.assignmentId", "task.taskStatus"])
          .select([
            "threads.environmentId",
            "threads.id",
            "threads.status",
            "threads.title",
            "threads.doneAt",
            "threads.updatedAt",
          ])
          .select((eb) =>
            eb
              .selectFrom("threads as visibleParent")
              .select("visibleParent.id")
              .whereRef("visibleParent.id", "=", "threads.parentThreadId")
              .as("parentThreadId"),
          )
          .select([
            threadPendingRequestsSelection,
            threadVisitSelection,
            threadProviderSessionSelection,
            threadContinuationIdentitySelection,
          ])
          .$if(since !== null, (query) =>
            query.select([
              sql<string>`changed.new_messages`.as("newMessages"),
              sql<Date>`changed.first_new_at`.as("firstNewAt"),
              sql<Date>`changed.last_new_at`.as("lastNewAt"),
            ]),
          )
          .orderBy(since ? sql`changed.last_new_at` : sql.ref("threads.updatedAt"), "desc")
          .orderBy("threads.id", "desc")
          .limit(maxItems + 1)
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      ]);
      const window = boundedSerializedPrefix(
        rows.slice(0, maxItems).map(({ newMessages, firstNewAt, lastNewAt: _, ...row }) => ({
          ...row,
          updatedAt: row.updatedAt.toISOString(),
          doneAt: row.doneAt?.toISOString() ?? null,
          ...(newMessages !== undefined && firstNewAt !== undefined
            ? { newMessages: Number(newMessages), firstNewAt: firstNewAt.toISOString() }
            : {}),
        })),
        maxItems,
        maxBytes,
      );
      const hasMore = rows.length > window.items.length;
      const oldest = window.items.at(-1);
      const oldestOrder = since
        ? rows[window.items.length - 1]?.lastNewAt?.toISOString()
        : oldest?.updatedAt;
      return {
        threads: window.items,
        window: {
          byteCount: window.byteCount,
          hasMore,
          itemCount: window.items.length,
          nextBefore:
            hasMore && oldest && oldestOrder
              ? encodeWindowCursor(cursorKind, cursorScope, oldestOrder, oldest.id)
              : null,
          totalItems: safeCount(countRow.count),
        },
      };
    },
    "repeatable read",
  );
}
/**
 * Tasks with messages opensteer_task_read shows that are newer than `since`. A message is dated
 * by its creation, or a queued input by its delivery. The union lets both indexes bound the read.
 */
function changedThreads(transaction: Transaction<DatabaseSchema>, since: Date) {
  const changedAt = sql<Date>`coalesce(thread_inputs.updated_at, messages.created_at)`;
  // Milliseconds, as cursors carry; the bound itself compares at full precision.
  const dated = sql<Date>`date_trunc('milliseconds', ${changedAt})`;
  return transaction
    .selectFrom("messages")
    .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
    .select(({ fn }) => [
      "messages.threadId",
      fn.countAll<string>().as("newMessages"),
      // The oldest new message's own time, where opensteer_task_read's history shows it.
      sql<Date>`min(messages.created_at)`.as("firstNewAt"),
      sql<Date>`max(${dated})`.as("lastNewAt"),
    ])
    .where(
      "messages.id",
      "in",
      transaction
        .selectFrom("messages")
        .select("id")
        .where("createdAt", ">", since)
        .union(
          transaction
            .selectFrom("threadInputs")
            .select("messageId as id")
            .where("updatedAt", ">", since),
        ),
    )
    .where("messages.kind", "!=", "continuation")
    .where("messages.published", "=", true)
    .where(changedAt, ">", since)
    .groupBy("messages.threadId");
}
export async function getThreadForOwner(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  ownerId: UserId,
  lineageConnectionId?: string,
  nativeOnly?: boolean,
): Promise<Thread | null> {
  return withPersonalReadTransaction(database, async (tx) => {
    await requirePersonalOwner(tx, ownerId);
    const row = await tx
      .selectFrom("threads")
      .selectAll("threads")
      .select([
        threadPendingRequestsSelection,
        threadVisitSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .where("threads.id", "=", threadId)
      .where("threads.createdBy", "=", ownerId)
      .where("threads.removedAt", "is", null)
      .$if(nativeOnly === true, (query) => query.where("threads.worker", "=", "native"))
      .$if(lineageConnectionId !== undefined, (query) =>
        query.where("threads.originConnectionId", "=", lineageConnectionId!),
      )
      .executeTakeFirst();
    return row
      ? { ...threadFromRow(row), returnHint: await compactionReturnHint(tx, threadId) }
      : null;
  });
}
export function admitRunToolCall(
  database: Kysely<DatabaseSchema>,
  input: RunToolAdmissionInput,
  executionNow: () => number = Date.now,
): Promise<RunToolAdmissionResult> {
  return persistRunToolAdmission(database, input, executionNow);
}
export function admitTriggerControlRequest(
  database: Kysely<DatabaseSchema>,
  input: TriggerControlAdmissionInput,
): Promise<TriggerControlAdmissionResult> {
  return persistTriggerControlAdmission(database, input);
}
export async function readThreadForOwner(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  ownerId: UserId,
  maxMessages = 100,
): Promise<OwnedThreadRead | null> {
  const limit = boundedLimit(maxMessages, 200);
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      await requirePersonalOwner(transaction, ownerId);
      const threadRow = await transaction
        .selectFrom("threads")
        .selectAll("threads")
        .select([
          threadPendingRequestsSelection,
          threadVisitSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("threads.id", "=", threadId)
        .where("threads.removedAt", "is", null)
        .executeTakeFirst();
      if (!threadRow) return null;
      const messageRows = await transaction
        .selectFrom("messages")
        .selectAll()
        .where("threadId", "=", threadId)
        .where("published", "=", true)
        .orderBy("sequence", "desc")
        .limit(limit)
        .execute();
      return {
        messages: messagesFromRows(messageRows.reverse()),
        thread: {
          ...threadFromRow(threadRow),
          returnHint: await compactionReturnHint(transaction, threadId),
        },
      };
    },
    "repeatable read",
  );
}
export async function createThread(
  database: Kysely<DatabaseSchema>,
  input: CreateThreadInput,
): Promise<ThreadCreationResult> {
  return commitPersonalMutation(database, (tx) =>
    withThreadCallerTransaction(tx, input, (tx) => createThreadInTransaction(tx, input)),
  );
}
export async function createThreadInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: CreateThreadInput,
  prepared?: {
    readonly insertThread?: Awaited<ReturnType<typeof prepareThreadInsertion>>;
    readonly unlisted?: true;
  },
): Promise<ThreadCreationResult> {
  await requirePersonalOwner(transaction, input.createdBy);
  await lockCommandIdempotency(transaction, input.createdBy, input.idempotencyKey);
  // The Voice task's slot is claimed before the environment it will run in is locked.
  if (input.purpose === "voice")
    await transaction
      .selectFrom("personalSettings")
      .select("singletonKey")
      .where("singletonKey", "=", "personal")
      .forNoKeyUpdate()
      .execute();
  const resolvedInput = {
    ...input,
    accessMode: await resolveCreateThreadAccessMode(transaction, input),
  };
  const requestPayload = canonicalCreateThreadInput(resolvedInput);
  const existing = await findExistingThreadCreation(transaction, resolvedInput, requestPayload);
  if (existing) return existing;
  const id = input.id ?? createId("thread");
  const insertThread =
    prepared?.insertThread ??
    (await prepareThreadInsertion(
      transaction,
      {
        createdBy: input.createdBy,
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
      },
      input.expectedHarnessRevision,
    ));
  const parent = input.parentThreadId
    ? await transaction
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", input.parentThreadId)
        .executeTakeFirstOrThrow()
    : null;
  const actorPrincipalId = await principalIdForUser(transaction, input.createdBy);
  const purpose = input.purpose ?? "task";
  // Lineage is fixed at creation: the creator's connection, otherwise the parent task's.
  const originConnectionId =
    (input.authority ? await threadCallerLineageId(transaction, input.authority) : null) ??
    parent?.originConnectionId ??
    null;
  const thread = await insertThread({
    ...(originConnectionId ? { originConnectionId } : {}),
    accessMode: resolvedInput.accessMode,
    createdByPrincipalId: actorPrincipalId,
    id,
    lineageRootThreadId: parent?.lineageRootThreadId ?? id,
    listed: !prepared?.unlisted && purpose === "task" && parent === null,
    modelSelection: jsonValue(ModelSelectionSchema.parse(input.modelSelection)),
    parentThreadId: input.parentThreadId ?? null,
    purpose,
    status: "idle",
    title: input.title,
    titleSource: input.generateTitle ? "provisional" : "chosen",
    icon: input.icon ?? null,
    iconSource: input.icon ? "chosen" : "provisional",
  });
  await ensureSelectedProviderSession(transaction, thread);
  if (purpose === "voice")
    await transaction
      .updateTable("personalSettings")
      .set({
        voiceThreadId: thread.id,
      })
      .where("singletonKey", "=", "personal")
      .where("voiceThreadId", "is", null)
      .executeTakeFirstOrThrow();
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId,
      authoritySource: jsonValue({
        kind: "user-session",
        userId: input.createdBy,
      }),
      dispatcherId: null,
      environmentId: input.environmentId,
      id: createId("command"),
      idempotencyKey: input.idempotencyKey,
      lastError: null,
      payload: requestPayload,
      requestedBy: input.createdBy,
      runId: null,
      status: "succeeded",
      threadId: id,
      type: "thread.create",
    })
    .executeTakeFirstOrThrow();
  const selected = await transaction
    .selectFrom("providerSessions")
    .select("id")
    .where("threadId", "=", thread.id)
    .where("active", "=", true)
    .executeTakeFirstOrThrow();
  const parsedThread = threadFromRow({
    ...thread,
    continuationIdentity: null,
    providerSessionId: selected.id,
    pendingRequests: thread.pendingRequestCount,
  });
  await publishThreadSummary(transaction, id);
  return {
    asOfSequence: await threadMutationHead(transaction, parsedThread.id),
    thread: parsedThread,
    wasDuplicate: false,
  };
}
export async function findDelegatedThreadByIdempotency(
  database: Kysely<DatabaseSchema>,
  input: DelegateThreadRequest,
): Promise<DelegatedThreadResult | null> {
  return findDelegatedThreadByIdempotencyInStore(database, input);
}
export async function hasHumanIncludedPlace(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  part: PlaceContentPart,
): Promise<boolean> {
  const row = await database
    .selectFrom("messages")
    .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
    .select("messages.id")
    .where("messages.threadId", "=", threadId)
    .where(sql<string>`messages.author->>'kind'`, "=", "human")
    .where(sql<boolean>`messages.content @> ${JSON.stringify([part])}::jsonb`)
    .where((eb) =>
      eb.or([eb("threadInputs.state", "is", null), eb("threadInputs.state", "!=", "cancelled")]),
    )
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
export async function delegateThread(
  database: Kysely<DatabaseSchema>,
  input: DelegateThreadRequest,
): Promise<DelegatedThreadResult> {
  return commitPersonalMutation(database, (transaction) =>
    delegateThreadInTransaction(transaction, input),
  );
}
export async function delegateAdmittedThread(
  database: Kysely<DatabaseSchema>,
  request: AdmittedThreadDelegationRequest,
  executionNow: () => number = Date.now,
): Promise<DelegatedThreadResult> {
  assertThreadMutationAdmission(request.admission, "thread.delegate", request.input);
  return commitPersonalMutation(database, async (transaction) => {
    await admitThreadMutation(transaction, request.admission, "check", executionNow);
    await lockDelegationIdempotency(transaction, request.input);
    const result = await delegateThreadInTransaction(transaction, request.input);
    await admitThreadMutation(transaction, request.admission, "admit", executionNow);
    return result;
  });
}

/**
 * The receipt follows the mutation's own lock prefix, so a dead binding or an
 * exhausted quota is first checked without locks: the caller gets that refusal
 * instead of an error from work it was never entitled to start.
 */
async function admitThreadMutation(
  transaction: Transaction<DatabaseSchema>,
  admission: ThreadMutationAdmission,
  mode: AdmissionMode,
  executionNow: () => number = Date.now,
): Promise<void> {
  if (admission.kind === "agent") {
    await admitRunToolCallInTransaction(transaction, admission.request, mode, executionNow);
  } else if (admission.kind === "trigger") {
    await admitTriggerControlRequestInTransaction(transaction, admission.request, mode);
  } else {
    await admitWatchControlRequestInTransaction(transaction, admission.request, mode);
  }
}
export async function cancelAssignment(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: CancelAssignmentInput & {
    readonly admission?: RunToolAdmissionInput;
  },
  executionNow: () => number = Date.now,
): Promise<CancelAssignmentResult> {
  if (
    input.admission &&
    (input.admission.action !== "assignment.cancel" ||
      input.admission.runId !== input.actorRunId ||
      input.admission.requestedBy !== input.requestedBy)
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Assignment cancel admission disagrees with Run",
    });
  }
  const result = await commitPersonalMutation(database, async (transaction) => {
    if (input.admission) {
      await admitRunToolCallInTransaction(transaction, input.admission, "check", executionNow);
    }
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    if (input.admission) {
      await admitRunToolCallInTransaction(transaction, input.admission, "admit", executionNow);
    }
    return cancelAssignmentInTransaction(transaction, input);
  });
  const cleanup = await drainAssignmentCancellation(database, links, input.assignmentId);
  return { ...result, ...cleanup };
}

export function drainPendingAssignmentReturns(
  database: Kysely<DatabaseSchema>,
  limit?: number,
): Promise<AssignmentReturnDrain> {
  return drainPendingAssignmentReturnsInStore(database, limit);
}
export function drainAssignmentReturn(
  database: Kysely<DatabaseSchema>,
  assignmentId: AssignmentId,
): Promise<"settled" | "waiting" | "held"> {
  return drainAssignmentReturnInStore(database, assignmentId);
}
export async function updateThreadExecutionSelection(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly authority?: ThreadCallerAuthority;
    readonly continuationIdentity: ProviderContinuationIdentity;
    readonly continuation?: {
      readonly expectedProviderSessionId: ProviderSessionId | null;
    };
    readonly harnessInstanceId: HarnessInstanceId;
    readonly idempotencyKey: string;
    readonly modelSelection: ModelSelection;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  },
): Promise<{
  readonly asOfSequence: Sequence;
  readonly thread: Thread;

  readonly wasDuplicate: boolean;
}> {
  const modelSelection = ModelSelectionSchema.parse(input.modelSelection);
  const continuationIdentity = ProviderContinuationIdentitySchema.parse(input.continuationIdentity);
  const requestPayload = {
    continuationIdentity,
    continuation: input.continuation ?? null,
    harnessInstanceId: input.harnessInstanceId,
    modelSelection,
    threadId: input.threadId,
  };
  return commitPersonalMutation(database, (tx) =>
    withThreadCallerTransaction(tx, input, async (transaction) => {
      await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
      const existingCommand = await findCommandByIdempotency(
        transaction,
        input.requestedBy,
        input.idempotencyKey,
      );
      if (existingCommand) {
        if (
          existingCommand.type !== "thread.execution.update" ||
          existingCommand.threadId !== input.threadId ||
          !isDeepStrictEqual(existingCommand.payload, requestPayload)
        ) {
          throw idempotencyConflict(input.idempotencyKey);
        }
        const current = await transaction
          .selectFrom("threads")
          .selectAll()
          .select([
            threadPendingRequestsSelection,
            threadVisitSelection,
            threadProviderSessionSelection,
            threadContinuationIdentitySelection,
          ])
          .where("id", "=", input.threadId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        await requireExecutionEnvironmentAccess(
          transaction,
          current.environmentId,
          input.requestedBy,
          "Only the execution owner can change this task's AI account",
        );
        return {
          asOfSequence: await threadMutationHead(transaction, current.id),
          thread: threadFromRow(current),
          wasDuplicate: true,
        };
      }
      const observed = await transaction
        .selectFrom("threads")
        .where("id", "=", input.threadId)
        .where("removedAt", "is", null)
        .executeTakeFirst();
      if (!observed)
        throw new OpensteerError({
          code: "not_found",
          message: "Task not found",
        });
      await requirePersonalOwner(transaction, input.requestedBy);
      const requestedHarness = await transaction
        .selectFrom("harnessInstances")
        .select(["driverKind", "enabled", "environmentId"])
        .where("id", "=", input.harnessInstanceId)
        .forShare()
        .executeTakeFirst();
      if (!requestedHarness?.enabled) {
        throw new OpensteerError({
          code: "conflict",
          message: "AI engine is unavailable",
        });
      }
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadVisitSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", input.threadId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      await requireExecutionEnvironmentAccess(
        transaction,
        thread.environmentId,
        input.requestedBy,
        "Only the execution owner can change this task's AI account",
      );
      const activeRun = await transaction
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", thread.id)
        .where("status", "in", nonTerminalRunStatuses)
        .executeTakeFirst();
      if (activeRun) {
        throw new OpensteerError({
          code: "conflict",
          message: "The AI engine cannot change while a Run is active",
          retryable: true,
        });
      }
      if (requestedHarness.environmentId !== thread.environmentId) {
        throw new OpensteerError({
          code: "bad_request",
          message: "AI account belongs to a different computer",
        });
      }
      if (requestedHarness.driverKind !== continuationIdentity.driverKind) {
        throw new OpensteerError({
          code: "bad_request",
          message: "AI engine continuation identity does not match its driver",
        });
      }
      const selectionChanged =
        thread.harnessInstanceId !== input.harnessInstanceId ||
        !isDeepStrictEqual(thread.modelSelection, modelSelection);
      if (selectionChanged)
        await transaction
          .selectFrom("providerSessions")
          .select("id")
          .where("threadId", "=", thread.id)
          .where((eb) => eb.or([eb("contextSnapshot", "is not", null), eb("active", "=", true)]))
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
      const selected = (await lockThreadProviderSession(transaction, thread.id)) ?? null;
      const compatible =
        selected !== null &&
        (selected.continuationIdentity
          ? sameProviderContinuationIdentity(selected.continuationIdentity, continuationIdentity)
          : selected.harnessInstanceId === input.harnessInstanceId);
      if (!compatible && input.continuation === undefined) {
        throw new OpensteerError({
          code: "conflict",
          message: "Changing native provider context requires the expected current session",
        });
      }
      if (
        input.continuation &&
        input.continuation.expectedProviderSessionId !== (selected?.id ?? null)
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "The selected provider session changed before this AI engine update",
        });
      }
      if (selectionChanged) {
        await transaction
          .updateTable("providerSessions")
          .set({ contextSnapshot: null })
          .where("threadId", "=", thread.id)
          .where("contextSnapshot", "is not", null)
          .execute();
        await publishThreadSummary(transaction, thread.id);
      }
      let providerSessionId = selected?.id ?? null;
      if (compatible && selected && input.continuation === undefined) {
        await transaction
          .updateTable("providerSessions")
          .set({
            continuationIdentity: jsonValue(continuationIdentity),
            harnessInstanceId: input.harnessInstanceId,
            updatedAt: new Date(),
          })
          .where("id", "=", selected.id)
          .executeTakeFirstOrThrow();
      } else {
        if (selected) {
          await transaction
            .updateTable("providerSessions")
            .set({
              active: false,
              updatedAt: new Date(),
            })
            .where("id", "=", selected.id)
            .executeTakeFirstOrThrow();
        }
        providerSessionId = createId("providerSession");
        await transaction
          .insertInto("providerSessions")
          .values({
            active: true,
            bindingGeneration: 0,
            continuationIdentity: jsonValue(continuationIdentity),
            harnessInstanceId: input.harnessInstanceId,
            id: providerSessionId,
            leaseExpiresAt: null,
            leaseTokenHash: null,
            providerSessionReference: null,
            runnerBootId: null,
            runnerId: null,
            status: "starting",
            stateLayout: "session",
            threadId: thread.id,
          })
          .executeTakeFirstOrThrow();
      }
      const now = new Date();
      const row = await transaction
        .updateTable("threads")
        .set({
          harnessInstanceId: input.harnessInstanceId,
          modelSelection: jsonValue(modelSelection),
          updatedAt: now,
        })
        .where("id", "=", thread.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const parsedThread = {
        ...threadFromRow({
          ...thread,
          ...row,
          continuationIdentity,
          providerSessionId,
        }),
        returnHint: await compactionReturnHint(transaction, thread.id),
      };
      await transaction
        .insertInto("commands")
        .values({
          actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
          authoritySource: jsonValue({
            kind: "user-session",
            userId: input.requestedBy,
          }),
          dispatcherId: null,
          environmentId: thread.environmentId,
          id: createId("command"),
          idempotencyKey: input.idempotencyKey,
          lastError: null,
          payload: jsonValue(requestPayload),
          requestedBy: input.requestedBy,
          runId: null,
          status: "succeeded",
          threadId: thread.id,
          type: "thread.execution.update",
        })
        .executeTakeFirstOrThrow();
      await publishThreadSummary(transaction, thread.id);
      return {
        asOfSequence: await threadMutationHead(transaction, parsedThread.id),
        thread: parsedThread,
        wasDuplicate: false,
      };
    }),
  );
}
export async function resumeThreadInputQueue(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly authority?: ThreadCallerAuthority;
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  },
): Promise<{
  readonly asOfSequence: Sequence;
  readonly thread: Thread;
}> {
  return commitPersonalMutation(database, (tx) =>
    withThreadCallerTransaction(tx, input, async (transaction) => {
      await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
      const observed = await transaction
        .selectFrom("threads")
        .where("id", "=", input.threadId)
        .where("removedAt", "is", null)
        .executeTakeFirst();
      if (!observed)
        throw new OpensteerError({
          code: "not_found",
          message: "Task not found",
        });
      await lockThreadRow(transaction, input.threadId);
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadVisitSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", input.threadId)
        .executeTakeFirstOrThrow();
      await assertThreadCaller(transaction, input.authority, {
        threadId: input.threadId,
        activate: true,
      });
      await requirePersonalOwner(transaction, input.requestedBy);
      if (thread.status === "archived")
        throw new OpensteerError({
          code: "conflict",
          message: "Archived tasks cannot run",
        });
      const payload = {
        type: "thread.inputQueue.resume",
        threadId: input.threadId,
      };
      const existing = await findCommandByIdempotency(
        transaction,
        input.requestedBy,
        input.idempotencyKey,
      );
      if (existing) {
        if (!isDeepStrictEqual(existing.payload, payload))
          throw idempotencyConflict(input.idempotencyKey);
        return {
          asOfSequence: await threadMutationHead(transaction, thread.id),
          thread: threadFromRow(thread),
        };
      }
      await transaction
        .insertInto("commands")
        .values({
          actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
          authoritySource: jsonValue({
            kind: "user-session",
            userId: input.requestedBy,
          }),
          dispatcherId: null,
          environmentId: thread.environmentId,
          id: createId("command"),
          idempotencyKey: input.idempotencyKey,
          lastError: null,
          payload: jsonValue(payload),
          requestedBy: input.requestedBy,
          runId: null,
          status: "succeeded",
          threadId: thread.id,
          type: payload.type,
        })
        .execute();
      if (thread.inputQueuePaused) {
        await transaction
          .updateTable("threads")
          .set({ inputQueuePaused: false, inputQueuePausedBy: null, updatedAt: new Date() })
          .where("id", "=", thread.id)
          .execute();
        await refreshInputQueue(transaction, thread.id);
        await publishRunQueue(transaction, thread.id);
      }
      await ensureQueuedRun(transaction, { ...thread, inputQueuePaused: false });
      await projectThreadState(transaction, thread.id, new Date(), thread.inputQueuePaused);
      const current = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadVisitSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", thread.id)
        .executeTakeFirstOrThrow();
      return {
        asOfSequence: await threadMutationHead(transaction, current.id),
        thread: threadFromRow(current),
      };
    }),
  );
}
export async function renameThread(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly authority?: ThreadCallerAuthority;
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly actorRunId?: RunId;
    readonly admission?: RunToolAdmissionInput;
    readonly threadId: ThreadId;
    readonly title: string;
  },
): Promise<ThreadUpdateResult> {
  const title = ThreadTitleSchema.parse(input.title);
  return commitPersonalMutation(
    database,
    async (transaction) => {
      await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
      await lockThreadCaller(transaction, input.authority);
      const payload = {
        threadId: input.threadId,
        title,
      };
      const existing = await findCommandByIdempotency(
        transaction,
        input.requestedBy,
        input.idempotencyKey,
      );
      if (
        existing &&
        (existing.type !== "thread.rename" || !isDeepStrictEqual(existing.payload, payload))
      ) {
        throw idempotencyConflict(input.idempotencyKey);
      }
      if (input.actorRunId)
        await transaction
          .selectFrom("runs")
          .select("id")
          .where("id", "=", input.actorRunId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
      await admitThreadWrite(transaction, input);
      const destination = await lockThreadNameDestinations(transaction, input.threadId);
      if (!destination)
        throw new OpensteerError({
          code: "not_found",
          message: "Task not found",
        });
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadVisitSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", input.threadId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!thread)
        throw new OpensteerError({
          code: "not_found",
          message: "Task not found",
        });
      await requireThreadWriteAuthority(transaction, thread, input, "rename");
      if (existing)
        return {
          asOfSequence: await threadMutationHead(transaction, thread.id),
          thread: threadFromRow(thread),
        };
      const row = await transaction
        .updateTable("threads")
        .set({
          title,
          titleSource: "chosen",
          updatedAt: new Date(),
        })
        .where("id", "=", thread.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (thread.title !== title) {
        await publishThreadSummary(transaction, row.id);
        await refreshAssignmentWorkerSummaries(transaction, row.id);
        await republishPendingRequestsShowing(transaction, row.id, "title");
      }
      const actorPrincipalId = await principalIdForUser(transaction, input.requestedBy);
      await transaction
        .insertInto("commands")
        .values({
          actorPrincipalId,
          authoritySource: jsonValue({
            kind: "user-session",
            userId: input.requestedBy,
          }),
          dispatcherId: null,
          environmentId: thread.environmentId,
          id: createId("command"),
          idempotencyKey: input.idempotencyKey,
          lastError: null,
          payload,
          requestedBy: input.requestedBy,
          runId: null,
          status: "succeeded",
          threadId: thread.id,
          type: "thread.rename",
        })
        .executeTakeFirstOrThrow();
      return {
        asOfSequence: await threadMutationHead(transaction, row.id),
        thread: threadFromRow({
          ...thread,
          ...row,
        }),
      };
    },
    (error) => error instanceof TransactionScopeChanged,
  );
}
export async function setThreadIcon(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly authority?: ThreadCallerAuthority;
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly actorRunId?: RunId;
    readonly admission?: RunToolAdmissionInput;
    readonly threadId: ThreadId;
    readonly icon: IconName | null;
  },
): Promise<ThreadUpdateResult> {
  const icon = IconNameSchema.parse(input.icon ?? defaultTaskSymbol);
  return commitPersonalMutation(
    database,
    async (transaction) => {
      await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
      await lockThreadCaller(transaction, input.authority);
      const payload = {
        threadId: input.threadId,
        icon: input.icon,
      };
      const existing = await findCommandByIdempotency(
        transaction,
        input.requestedBy,
        input.idempotencyKey,
      );
      if (
        existing &&
        (existing.type !== "thread.icon.set" || !isDeepStrictEqual(existing.payload, payload))
      ) {
        throw idempotencyConflict(input.idempotencyKey);
      }
      if (input.actorRunId)
        await transaction
          .selectFrom("runs")
          .select("id")
          .where("id", "=", input.actorRunId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
      await admitThreadWrite(transaction, input);
      const destination = await lockThreadNameDestinations(transaction, input.threadId);
      if (!destination)
        throw new OpensteerError({
          code: "not_found",
          message: "Task not found",
        });
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadVisitSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", input.threadId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!thread)
        throw new OpensteerError({
          code: "not_found",
          message: "Task not found",
        });
      await requireThreadWriteAuthority(transaction, thread, input, "set_icon");
      if (existing)
        return {
          asOfSequence: await threadMutationHead(transaction, thread.id),
          thread: threadFromRow(thread),
        };
      const row = await transaction
        .updateTable("threads")
        .set({
          icon,
          iconSource: "chosen",
          updatedAt: new Date(),
        })
        .where("id", "=", thread.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (thread.icon !== icon) {
        await publishThreadSummary(transaction, row.id);
        await refreshAssignmentWorkerSummaries(transaction, row.id);
      }
      const actorPrincipalId = await principalIdForUser(transaction, input.requestedBy);
      await transaction
        .insertInto("commands")
        .values({
          actorPrincipalId,
          authoritySource: jsonValue({
            kind: "user-session",
            userId: input.requestedBy,
          }),
          dispatcherId: null,
          environmentId: thread.environmentId,
          id: createId("command"),
          idempotencyKey: input.idempotencyKey,
          lastError: null,
          payload,
          requestedBy: input.requestedBy,
          runId: null,
          status: "succeeded",
          threadId: thread.id,
          type: "thread.icon.set",
        })
        .executeTakeFirstOrThrow();
      return {
        asOfSequence: await threadMutationHead(transaction, row.id),
        thread: threadFromRow({
          ...thread,
          ...row,
        }),
      };
    },
    (error) => error instanceof TransactionScopeChanged,
  );
}
export async function applyGeneratedThreadName(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly threadId: ThreadId;
    readonly title?: string | undefined;
    readonly icon?: IconName | undefined;
    readonly namingAuthority?: NonNullable<Awaited<ReturnType<typeof getThreadNamingInput>>> & {
      readonly harnessRevision: number;
      readonly expiresAt: number;
    };
  },
): Promise<ThreadId | null> {
  const title =
    input.title === undefined ? undefined : GeneratedThreadTitleSchema.parse(input.title);
  const icon = input.icon === undefined ? undefined : IconNameSchema.parse(input.icon);
  if (title === undefined && icon === undefined) return null;
  return commitPersonalMutation(
    database,
    async (transaction) => {
      if (!(await lockThreadNameDestinations(transaction, input.threadId))) return null;
      if (input.namingAuthority) {
        const authority = input.namingAuthority;
        const current = await getThreadNamingInput(transaction, input.threadId);
        const account = await transaction
          .selectFrom("harnessInstances")
          .selectAll()
          .where("id", "=", authority.harnessInstanceId)
          .executeTakeFirst();
        if (
          !current ||
          current.sourceMessageId !== authority.sourceMessageId ||
          current.principalId !== authority.principalId ||
          current.requestedBy !== authority.requestedBy ||
          Date.now() >= authority.expiresAt ||
          !account?.enabled ||
          account.removedAt ||
          account.runtimeRevision !== authority.harnessRevision ||
          account.environmentId !== authority.environmentId ||
          !(await environmentIsAvailableToUser(
            transaction,
            authority.environmentId,
            authority.requestedBy,
          ))
        )
          return null;
      }
      const renamed =
        title === undefined
          ? undefined
          : await transaction
              .updateTable("threads")
              .set({
                title,
                titleSource: "generated",
                updatedAt: new Date(),
              })
              .where("id", "=", input.threadId)
              .where("titleSource", "=", "provisional")
              .returning("id")
              .executeTakeFirst();
      const marked =
        icon === undefined
          ? undefined
          : await transaction
              .updateTable("threads")
              .set({
                icon,
                iconSource: "generated",
                updatedAt: new Date(),
              })
              .where("id", "=", input.threadId)
              .where("iconSource", "=", "provisional")
              .returning("id")
              .executeTakeFirst();
      if (!renamed && !marked) return null;
      const row = await transaction
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", input.threadId)
        .executeTakeFirstOrThrow();
      await publishThreadSummary(transaction, row.id);
      await refreshAssignmentWorkerSummaries(transaction, row.id);
      if (renamed) await republishPendingRequestsShowing(transaction, row.id, "title");
      return row.id;
    },
    (error) => error instanceof TransactionScopeChanged,
  );
}
export async function updateThreadAccessMode(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly accessMode: ThreadAccessMode;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  },
): Promise<ThreadUpdateResult> {
  const accessMode = ThreadAccessModeSchema.parse(input.accessMode);
  return commitPersonalMutation(database, async (transaction) => {
    const observed = await transaction
      .selectFrom("threads")
      .select(["id", "worker", "accessMode", "environmentId"])
      .where("id", "=", input.threadId)
      .where("removedAt", "is", null)
      .executeTakeFirst();
    if (!observed)
      throw new OpensteerError({
        code: "not_found",
        message: "Task not found",
      });
    await requirePersonalOwner(transaction, input.requestedBy);
    await requireExecutionEnvironmentAccess(
      transaction,
      observed.environmentId,
      input.requestedBy,
      "Only the execution owner can change this task's access mode",
    );
    const lowersDirectWork =
      observed.worker === "external" && !threadAccessModeAtMost(observed.accessMode, accessMode);
    if (lowersDirectWork)
      await closeAgentOperationRequestsAboveMode(transaction, observed.id, accessMode, new Date());
    const thread = await transaction
      .selectFrom("threads")
      .selectAll()
      .select([
        lowersDirectWork
          ? threadPendingRequestsCount.as("pendingRequests")
          : threadPendingRequestsSelection,
        threadVisitSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .where("id", "=", input.threadId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (thread.accessMode === accessMode)
      return {
        asOfSequence: await threadMutationHead(transaction, observed.id),
        thread: threadFromRow(thread),
      };
    const updatedAt = new Date();
    const row = await transaction
      .updateTable("threads")
      .set({
        accessMode,
        updatedAt,
      })
      .where("id", "=", thread.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const updated = threadFromRow({
      ...thread,
      ...row,
    });
    await publishThreadSummary(transaction, updated.id);
    return { asOfSequence: await threadMutationHead(transaction, updated.id), thread: updated };
  });
}

/**
 * Resolves an exact Thread-create retry before checking ephemeral Runner
 * availability. HTTP admission uses this to preserve idempotency when a
 * previously successful Thread's pinned environment later disconnects.
 */
export async function findThreadCreationByIdempotency(
  database: Kysely<DatabaseSchema>,
  input: CreateThreadInput,
): Promise<ThreadCreationResult | null> {
  return withPersonalReadTransaction(database, async (transaction) => {
    await requirePersonalOwner(transaction, input.createdBy);
    const resolvedInput = {
      ...input,
      accessMode: await resolveCreateThreadAccessMode(transaction, input),
    };
    return (
      (await findExistingThreadCreation(
        transaction,
        resolvedInput,
        canonicalCreateThreadInput(resolvedInput),
      )) ?? null
    );
  });
}
export async function enqueueThreadInput(
  database: Kysely<DatabaseSchema>,
  input: EnqueueThreadInputRequest,
): Promise<EnqueuedThreadInput> {
  return commitPersonalMutation(database, async (transaction) => {
    await lockThreadInputIdempotency(transaction, input);
    await lockThreadCaller(transaction, input.authority);
    const result = await enqueueThreadInputInTransaction(transaction, input);
    await assertThreadCaller(transaction, input.authority, {
      threadId: input.threadId,
      enqueue: input.authority?.kind === "connection" && input.policy === "queue",
    });
    return result;
  });
}
export async function steerThreadInput(
  database: Kysely<DatabaseSchema>,
  input: SteerThreadInputRequest,
): Promise<EnqueuedThreadInput> {
  return commitPersonalMutation(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    await lockThreadCaller(transaction, input.authority, [input.expectedRunId]);
    const result = await steerThreadInputInTransaction(transaction, input);
    await assertThreadCaller(transaction, input.authority, {
      threadId: input.threadId,
      activate: true,
    });
    return result;
  });
}
async function lockQueueCaller(
  transaction: Transaction<DatabaseSchema>,
  input: CancelThreadInputRequest | MoveThreadInputRequest,
): Promise<void> {
  // A Run caller and the target's active Runs are locked in one statement, in ID order. The
  // Personal mutation fence keeps that set stable until the queue projection locks it again.
  await lockThreadCaller(
    transaction,
    input.authority,
    [],
    false,
    input.authority?.kind === "run" ? input.threadId : undefined,
  );
}
export async function cancelThreadInput(
  database: Kysely<DatabaseSchema>,
  input: CancelThreadInputRequest,
): Promise<CancelledThreadInput> {
  return commitPersonalMutation(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    await lockQueueCaller(transaction, input);
    const result = await cancelThreadInputInTransaction(transaction, input);
    await assertThreadCaller(transaction, input.authority, {
      threadId: input.threadId,
    });
    return result;
  });
}
export async function moveThreadInput(
  database: Kysely<DatabaseSchema>,
  input: MoveThreadInputRequest,
): Promise<MovedThreadInput> {
  return commitPersonalMutation(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    await lockQueueCaller(transaction, input);
    const result = await moveThreadInputInTransaction(transaction, input);
    await assertThreadCaller(transaction, input.authority, {
      threadId: input.threadId,
    });
    return result;
  });
}
export async function getThreadInputQueue(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly authority?: ThreadCallerAuthority;
    readonly threadId: ThreadId;
    readonly requestedBy: UserId;
    readonly expectedRevision?: string;
    readonly sessionId?: import("@opensteer/core").AuthSessionId;
  },
) {
  return withPersonalReadTransaction(database, async (transaction) => {
    await assertThreadCaller(transaction, input.authority, {
      threadId: input.threadId,
      readOnly: true,
    });
    const head = await transaction
      .selectFrom("clientSyncState")
      .select("sequence")
      .executeTakeFirstOrThrow();
    return { ...(await readThreadInputQueue(transaction, input)), asOfSequence: head.sequence };
  });
}
export async function enqueueAdmittedThreadInput(
  database: Kysely<DatabaseSchema>,
  request: AdmittedThreadInputRequest,
  executionNow: () => number = Date.now,
): Promise<EnqueuedThreadInput> {
  assertThreadMutationAdmission(request.admission, "thread.message", request.input);
  return commitPersonalMutation(database, async (transaction) => {
    await admitThreadMutation(transaction, request.admission, "check", executionNow);
    await lockCommandIdempotency(
      transaction,
      request.input.requestedBy,
      request.input.idempotencyKey,
    );
    // Admission and mutation commit together; input discovery establishes the shared lock prefix.
    const result = await enqueueThreadInputInTransaction(transaction, request.input);
    await admitThreadMutation(transaction, request.admission, "admit", executionNow);
    return result;
  });
}
