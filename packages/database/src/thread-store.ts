import { projectDeviceAccessAssignment } from "@opensteer/protocol";
import {
  lockDeploymentEvents,
  withPersonalReadTransaction,
  withPersonalTransaction,
} from "./personal-transaction.js";
import { type TaskPurpose, type TeamTaskOrigin } from "@opensteer/core";
import { requirePersonalOwner } from "./personal-settings-store.js";
import type { MemoryPassExecution } from "./memory-pass-store.js";
import { getThreadNamingInput } from "./execution-store.js";
import { environmentIsAvailableToUser } from "./environment-store.js";
import {
  assertThreadCaller,
  lockThreadCaller,
  withThreadCallerTransaction,
  type ThreadCallerAuthority,
} from "./thread-caller.js";
import { admitThreadWrite, requireThreadWriteAuthority } from "./task-done.js";
import { retryDatabaseTransaction, TransactionScopeChanged } from "./connection.js";
import { prepareThreadInsertion } from "./thread-insertion.js";
import { deploymentHead } from "./deployment-events.js";
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
  type AgentEvent,
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
  type ThreadInputQueue,
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
  threadLatestRunCompletedAtSelection,
  threadProviderSessionSelection,
  threadContinuationIdentitySelection,
  threadFromRow,
  threadsFromRows,
  assignmentFromRow,
  messagesFromRows,
} from "./thread-row-mappers.js";
import { boundedSerializedPrefix } from "./message-window.js";
import {
  assignmentSummaryInTransaction,
  assignmentNameEventsForThread,
  lockThreadNameDestinations,
  type CancelAssignmentInput,
  type CancelAssignmentResult,
  cancelAssignmentInTransaction,
  assignmentTreeChangedReason,
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
  steerThreadInputInTransaction,
  cancelThreadInputInTransaction,
  moveThreadInputInTransaction,
  readThreadInputQueue,
} from "./thread-inbox.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import { projectThreadState } from "./thread-status.js";
export interface CreateThreadInput {
  readonly specialistId?: string;
  readonly expectedHarnessRevision?: number;
  readonly icon?: IconName;
  readonly authority?: ThreadCallerAuthority;
  readonly accessMode?: ThreadAccessMode;
  readonly createdBy: UserId;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly purpose?: TaskPurpose;
  readonly teamOrigin?: TeamTaskOrigin;
  readonly generateTitle?: true;
  readonly id?: ThreadId;
  readonly idempotencyKey: string;
  readonly modelSelection: ModelSelection;
  readonly parentThreadId?: ThreadId;
  readonly title: string;
}
export interface ThreadCreationResult {
  readonly asOfSequence: Sequence;
  readonly event?: AgentEvent;
  readonly thread: Thread;
  readonly wasDuplicate: boolean;
}
export interface ThreadUpdateResult {
  readonly asOfSequence: Sequence;
  readonly events?: readonly AgentEvent[];
  readonly event?: AgentEvent;
  readonly thread: Thread;
}

/**
 * The Host authors attribution: an agent-originated turn carries the source
 * Thread and Run copied from the sending Run's authenticated capability, never
 * a value the sending model supplied.
 */
export type ThreadInputSource =
  | {
      readonly kind: "human";
    }
  | {
      readonly kind: "connection";
      readonly connectionId: string;
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
  readonly freshContext?: boolean;
  readonly teamRequest?: {
    readonly id: import("@opensteer/core").TeamAgentRequestId;
    readonly triggerMessageId: import("@opensteer/core").TeamMessageId;
    readonly source: import("@opensteer/core").TeamSource;
  };
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
  readonly events: readonly AgentEvent[];
  readonly input: ThreadInput;
  readonly message: Message;
  /** The grant a restart took from the attempt it interrupts. */
  readonly revokedGrants: readonly RevokedRunGrant[];
  readonly run: Run | null;
  readonly wasDuplicate: boolean;
}
export interface SteerThreadInputRequest {
  readonly authority?: ThreadCallerAuthority;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly expectedRunId: RunId;
  readonly requestedBy: UserId;
  readonly idempotencyKey: string;
}
export interface CancelThreadInputRequest {
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
  readonly events: readonly AgentEvent[];
  readonly input: ThreadInput;
  readonly wasDuplicate: boolean;
}
export interface MoveThreadInputRequest {
  readonly authority?: ThreadCallerAuthority;
  /** The waiting message to stand in front of, or null for the back of the queue. */
  readonly beforeMessageId: MessageId | null;
  readonly idempotencyKey: string;
  readonly messageId: MessageId;
  readonly requestedBy: UserId;
  readonly threadId: ThreadId;
}
export interface MovedThreadInput {
  readonly events: readonly AgentEvent[];
  readonly wasDuplicate: boolean;
}
export interface DelegateThreadRequest {
  readonly specialistId?: string;
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
  readonly events: readonly AgentEvent[];
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
      threadLatestRunCompletedAtSelection,
      threadProviderSessionSelection,
      threadContinuationIdentitySelection,
    ])
    .where("id", "=", existingCommand.threadId)
    .executeTakeFirstOrThrow();
  return {
    asOfSequence: await deploymentHead(transaction),
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
    ...(input.specialistId
      ? {
          specialistId: input.specialistId,
        }
      : {}),
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
    teamOrigin: input.teamOrigin ?? null,
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
      threadLatestRunCompletedAtSelection,
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
          threadLatestRunCompletedAtSelection,
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
    readonly deviceAccessRequests?: "include";
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
        rows
          .slice(0, maxItems)
          .map(async (row) =>
            projectDeviceAccessAssignment(
              await assignmentSummaryInTransaction(transaction, row),
              input.deviceAccessRequests === "include",
            ),
          ),
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
  },
): Promise<AgentThreadListPage> {
  const maxItems = boundedWindowLimit(input.maxItems, 50);
  const maxBytes = boundedWindowBytes(input.maxBytes, 192 * 1_024);
  const anchor = input.before
    ? decodeWindowCursor(input.before, "agent-thread", input.scopeId)
    : null;
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
      let base = transaction.selectFrom("threads");
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
      if (pattern) {
        base = base.where(sql<boolean>`threads.title ilike ${pattern} escape '\\'`);
      }
      let page = base;
      if (anchor) {
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
            threadLatestRunCompletedAtSelection,
            threadProviderSessionSelection,
            threadContinuationIdentitySelection,
          ])
          .orderBy("threads.updatedAt", "desc")
          .orderBy("threads.id", "desc")
          .limit(maxItems + 1)
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      ]);
      const window = boundedSerializedPrefix(
        rows.slice(0, maxItems).map((row) => ({
          ...row,
          updatedAt: row.updatedAt.toISOString(),
          doneAt: row.doneAt?.toISOString() ?? null,
        })),
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
              ? encodeWindowCursor("agent-thread", input.scopeId, oldest.updatedAt, oldest.id)
              : null,
          totalItems: safeCount(countRow.count),
        },
      };
    },
    "repeatable read",
  );
}
export async function getThreadForOwner(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  ownerId: UserId,
): Promise<Thread | null> {
  await requirePersonalOwner(database, ownerId);
  const row = await database
    .selectFrom("threads")
    .selectAll("threads")
    .select([
      threadPendingRequestsSelection,
      threadVisitSelection,
      threadLatestRunCompletedAtSelection,
      threadProviderSessionSelection,
      threadContinuationIdentitySelection,
    ])
    .where("threads.id", "=", threadId)
    .where("threads.createdBy", "=", ownerId)
    .executeTakeFirst();
  return row ? threadFromRow(row) : null;
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
          threadLatestRunCompletedAtSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("threads.id", "=", threadId)
        .executeTakeFirst();
      if (!threadRow) return null;
      const messageRows = await transaction
        .selectFrom("messages")
        .selectAll()
        .where("threadId", "=", threadId)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return {
        messages: messagesFromRows(messageRows.reverse()),
        thread: threadFromRow(threadRow),
      };
    },
    "repeatable read",
  );
}
export async function createThread(
  database: Kysely<DatabaseSchema>,
  input: CreateThreadInput,
): Promise<ThreadCreationResult> {
  return withThreadCallerTransaction(database, input, (transaction) =>
    createThreadInTransaction(transaction, input),
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
  const thread = await insertThread({
    accessMode: resolvedInput.accessMode,
    specialistId: input.specialistId ?? parent?.specialistId ?? null,
    createdByPrincipalId: actorPrincipalId,
    id,
    lineageRootThreadId: parent?.lineageRootThreadId ?? id,
    listed: !prepared?.unlisted && purpose === "task" && parent === null,
    modelSelection: jsonValue(ModelSelectionSchema.parse(input.modelSelection)),
    parentThreadId: input.parentThreadId ?? null,
    purpose,
    teamId: input.teamOrigin?.teamId ?? null,
    channelId: input.teamOrigin?.channelId ?? null,
    threadRootId: input.teamOrigin?.threadRootId ?? null,
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
  const event = await appendHostDeploymentEvent(transaction, {
    data: {
      thread: parsedThread,
    },
    environmentId: parsedThread.environmentId,
    runId: null,
    threadId: id,
    type: "thread.created",
  });
  return {
    asOfSequence: await deploymentHead(transaction),
    event,
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
  return withPersonalTransaction(database, (transaction) =>
    delegateThreadInTransaction(transaction, input),
  );
}
export async function delegateAdmittedThread(
  database: Kysely<DatabaseSchema>,
  request: AdmittedThreadDelegationRequest,
  executionNow: () => number = Date.now,
): Promise<DelegatedThreadResult> {
  assertThreadMutationAdmission(request.admission, "thread.delegate", request.input);
  return withPersonalTransaction(database, async (transaction) => {
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
  // Work that joined the tree after its snapshot cannot be locked in order
  // inside the same transaction; a fresh attempt snapshots it first.
  return retryDatabaseTransaction(
    () =>
      database.transaction().execute(async (transaction) => {
        await lockDeploymentEvents(transaction);
        if (input.admission) {
          await admitRunToolCallInTransaction(transaction, input.admission, "check", executionNow);
        }
        await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
        const result = await cancelAssignmentInTransaction(transaction, input, links);
        if (input.admission) {
          await admitRunToolCallInTransaction(transaction, input.admission, "admit", executionNow);
        }
        return result;
      }),
    (error) => error instanceof OpensteerError && error.reason === assignmentTreeChangedReason,
  );
}
export function drainPendingAssignmentReturns(
  database: Kysely<DatabaseSchema>,
  limit?: number,
): Promise<AssignmentReturnDrain> {
  return drainPendingAssignmentReturnsInStore(database, limit);
}
export function drainAssignmentReturn(
  database: Kysely<DatabaseSchema>,
  assignmentId: import("@opensteer/core").AssignmentId,
): Promise<readonly AgentEvent[]> {
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
  readonly event: AgentEvent | null;
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
  return withThreadCallerTransaction(database, input, async (transaction) => {
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
          threadLatestRunCompletedAtSelection,
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
        "Only the execution owner can change this Thread's AI engine",
      );
      return {
        asOfSequence: await deploymentHead(transaction),
        thread: threadFromRow(current),
        event: null,
        wasDuplicate: true,
      };
    }
    const observed = await transaction
      .selectFrom("threads")
      .where("id", "=", input.threadId)
      .executeTakeFirst();
    if (!observed)
      throw new OpensteerError({
        code: "not_found",
        message: "Thread not found",
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
        threadLatestRunCompletedAtSelection,
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
      "Only the execution owner can change this Thread's AI engine",
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
        message: "AI engine belongs to a different execution environment",
      });
    }
    if (requestedHarness.driverKind !== continuationIdentity.driverKind) {
      throw new OpensteerError({
        code: "bad_request",
        message: "AI engine continuation identity does not match its driver",
      });
    }
    const selected =
      (await transaction
        .selectFrom("providerSessions")
        .selectAll()
        .where("threadId", "=", thread.id)
        .where("active", "=", true)
        .forNoKeyUpdate()
        .executeTakeFirst()) ?? null;
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
    const parsedThread = threadFromRow({
      ...thread,
      ...row,
      continuationIdentity,
      providerSessionId,
    });
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
    const event = await appendHostDeploymentEvent(transaction, {
      data: {
        thread: parsedThread,
      },
      environmentId: thread.environmentId,
      runId: null,
      threadId: thread.id,
      type: "thread.execution-updated",
    });
    return {
      asOfSequence: await deploymentHead(transaction),
      thread: parsedThread,
      event,
      wasDuplicate: false,
    };
  });
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
  readonly events: readonly AgentEvent[];
}> {
  return withThreadCallerTransaction(database, input, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    const observed = await transaction
      .selectFrom("threads")
      .where("id", "=", input.threadId)
      .executeTakeFirst();
    if (!observed)
      throw new OpensteerError({
        code: "not_found",
        message: "Thread not found",
      });
    await lockThreadRow(transaction, input.threadId);
    const thread = await transaction
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
        threadVisitSelection,
        threadLatestRunCompletedAtSelection,
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
        message: "Archived threads cannot run",
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
        asOfSequence: await deploymentHead(transaction),
        thread: threadFromRow(thread),
        events: [],
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
    await transaction
      .updateTable("threads")
      .set({
        inputQueuePaused: false,
        inputQueuePausedBy: null,
        updatedAt: new Date(),
      })
      .where("id", "=", thread.id)
      .execute();
    const event = await appendHostDeploymentEvent(transaction, {
      data: {
        paused: false,
      },
      environmentId: thread.environmentId,
      runId: null,
      threadId: thread.id,
      type: "thread.input-queue-updated",
    });
    const queued = await ensureQueuedRun(transaction, {
      ...thread,
      inputQueuePaused: false,
    });
    const statusEvents = await projectThreadState(transaction, thread.id);
    const current = await transaction
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
        threadVisitSelection,
        threadLatestRunCompletedAtSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .where("id", "=", thread.id)
      .executeTakeFirstOrThrow();
    return {
      asOfSequence: await deploymentHead(transaction),
      thread: threadFromRow(current),
      events: [event, ...queued.events, ...statusEvents],
    };
  });
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
  return withPersonalTransaction(
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
          message: "Thread not found",
        });
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadVisitSelection,
          threadLatestRunCompletedAtSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", input.threadId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!thread)
        throw new OpensteerError({
          code: "not_found",
          message: "Thread not found",
        });
      await requireThreadWriteAuthority(transaction, thread, input, "rename");
      if (existing)
        return {
          asOfSequence: await deploymentHead(transaction),
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
      const event =
        thread.title !== title
          ? await appendHostDeploymentEvent(transaction, {
              data: {
                status: row.status,
                title: row.title,
                icon: row.icon,
                inputQueuePaused: row.inputQueuePaused,
                pendingRequests: row.pendingRequestCount,
              },
              environmentId: row.environmentId,
              runId: null,
              threadId: row.id,
              type: "thread.state-changed",
            })
          : undefined;
      const events = event
        ? [event, ...(await assignmentNameEventsForThread(transaction, row.id))]
        : [];
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
        asOfSequence: await deploymentHead(transaction),
        ...(event
          ? {
              event,
            }
          : {}),
        events,
        thread: threadFromRow({
          ...thread,
          ...row,
        }),
      };
    },
    undefined,
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
  return withPersonalTransaction(
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
          message: "Thread not found",
        });
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadVisitSelection,
          threadLatestRunCompletedAtSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", input.threadId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!thread)
        throw new OpensteerError({
          code: "not_found",
          message: "Thread not found",
        });
      await requireThreadWriteAuthority(transaction, thread, input, "set_icon");
      if (existing)
        return {
          asOfSequence: await deploymentHead(transaction),
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
      const event =
        thread.icon !== icon
          ? await appendHostDeploymentEvent(transaction, {
              data: {
                status: row.status,
                title: row.title,
                icon: row.icon,
                inputQueuePaused: row.inputQueuePaused,
                pendingRequests: row.pendingRequestCount,
              },
              environmentId: row.environmentId,
              runId: null,
              threadId: row.id,
              type: "thread.state-changed",
            })
          : undefined;
      const events = event
        ? [event, ...(await assignmentNameEventsForThread(transaction, row.id))]
        : [];
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
        asOfSequence: await deploymentHead(transaction),
        ...(event
          ? {
              event,
            }
          : {}),
        events,
        thread: threadFromRow({
          ...thread,
          ...row,
        }),
      };
    },
    undefined,
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
): Promise<{
  readonly event: AgentEvent;
  readonly events: readonly AgentEvent[];
} | null> {
  const title =
    input.title === undefined ? undefined : GeneratedThreadTitleSchema.parse(input.title);
  const icon = input.icon === undefined ? undefined : IconNameSchema.parse(input.icon);
  if (title === undefined && icon === undefined) return null;
  return withPersonalTransaction(
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
      const event = await appendHostDeploymentEvent(transaction, {
        data: {
          status: row.status,
          title: row.title,
          icon: row.icon,
          inputQueuePaused: row.inputQueuePaused,
          pendingRequests: row.pendingRequestCount,
        },
        environmentId: row.environmentId,
        runId: null,
        threadId: row.id,
        type: "thread.state-changed",
      });
      return {
        event,
        events: [event, ...(await assignmentNameEventsForThread(transaction, row.id))],
      };
    },
    undefined,
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
  return withPersonalTransaction(database, async (transaction) => {
    const observed = await transaction
      .selectFrom("threads")
      .where("id", "=", input.threadId)
      .executeTakeFirst();
    if (!observed)
      throw new OpensteerError({
        code: "not_found",
        message: "Thread not found",
      });
    await requirePersonalOwner(transaction, input.requestedBy);
    const thread = await transaction
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
        threadVisitSelection,
        threadLatestRunCompletedAtSelection,
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
      "Only the execution owner can change this Thread's access mode",
    );
    if (thread.accessMode === accessMode)
      return {
        asOfSequence: await deploymentHead(transaction),
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
    const event = await appendHostDeploymentEvent(transaction, {
      data: {
        accessMode,
      },
      environmentId: updated.environmentId,
      runId: null,
      threadId: updated.id,
      type: "thread.access-mode-updated",
    });
    return {
      asOfSequence: await deploymentHead(transaction),
      event,
      thread: updated,
    };
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
  return withPersonalTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    await lockThreadCaller(transaction, input.authority);
    const result = await enqueueThreadInputInTransaction(transaction, input);
    await assertThreadCaller(transaction, input.authority, {
      threadId: input.threadId,
    });
    return result;
  });
}
export async function steerThreadInput(
  database: Kysely<DatabaseSchema>,
  input: SteerThreadInputRequest,
): Promise<EnqueuedThreadInput> {
  return withPersonalTransaction(database, async (transaction) => {
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
export async function cancelThreadInput(
  database: Kysely<DatabaseSchema>,
  input: CancelThreadInputRequest,
): Promise<CancelledThreadInput> {
  return withPersonalTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    await lockThreadCaller(transaction, input.authority);
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
  return withPersonalTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    await lockThreadCaller(transaction, input.authority);
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
  },
): Promise<ThreadInputQueue> {
  return withPersonalReadTransaction(database, async (transaction) => {
    await assertThreadCaller(transaction, input.authority, {
      threadId: input.threadId,
      readOnly: true,
    });
    return readThreadInputQueue(transaction, input);
  });
}
export async function enqueueAdmittedThreadInput(
  database: Kysely<DatabaseSchema>,
  request: AdmittedThreadInputRequest,
  executionNow: () => number = Date.now,
): Promise<EnqueuedThreadInput> {
  assertThreadMutationAdmission(request.admission, "thread.message", request.input);
  return withPersonalTransaction(database, async (transaction) => {
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
