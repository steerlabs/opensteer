import { admitThreadWrite, requireThreadWriteAuthority } from "./task-done.js";
import {
  retryDatabaseTransaction,
  withDatabaseTransaction,
  TransactionScopeChanged,
} from "./connection.js";
import { prepareThreadInsertion } from "./thread-insertion.js";
import { workspaceHead } from "./snapshot-store.js";
import type { Sequence } from "@opensteer/core";
import {
  deriveThreadStatus,
  type WorkspaceIconName,
  WorkspaceIconNameSchema,
  defaultTaskSymbol,
  type ThreadAccessMode,
  type UserId,
  type EnvironmentId,
  type HarnessInstanceId,
  type ThreadId,
  type ModelSelection,
  type ThreadRole,
  type WorkspaceId,
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
  CHAT_THREAD_TITLE,
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
  type AgentControlAdmissionInput,
  type TriggerControlAdmissionInput,
  type WatchControlAdmissionInput,
  type AgentControlAdmissionResult,
  admitAgentControlRequest as persistAgentControlAdmission,
  type TriggerControlAdmissionResult,
  admitTriggerControlRequest as persistTriggerControlAdmission,
  admitAgentControlRequestInTransaction,
  admitTriggerControlRequestInTransaction,
  admitWatchControlRequestInTransaction,
  type AdmissionMode,
} from "./agent-control-admission.js";
import { type DurableWindow } from "@opensteer/protocol";
import { type Transaction, type Kysely, sql } from "kysely";
import {
  findCommandByIdempotency,
  idempotencyConflict,
  lockWorkspaceRow,
  requireActiveWorkspaceMembership,
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
  lockThreadNameWorkspaces,
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
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { projectThreadState } from "./thread-status.js";

export interface CreateThreadInput {
  readonly accessMode?: ThreadAccessMode;
  readonly createdBy: UserId;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly home?: boolean;
  readonly generateTitle?: true;
  readonly id?: ThreadId;
  readonly idempotencyKey: string;
  readonly modelSelection: ModelSelection;
  readonly parentThreadId?: ThreadId;
  readonly role?: ThreadRole;
  readonly title: string;
  readonly workspaceId: WorkspaceId;
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
  | { readonly kind: "human" }
  | { readonly kind: "agent"; readonly runId: RunId }
  | { readonly kind: "trigger"; readonly occurrenceId: TriggerOccurrenceId }
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
  readonly quotedMessageId?: MessageId;
  readonly content: readonly ContentPart[];
  readonly idempotencyKey: string;
  readonly policy: ThreadInputPolicy;
  readonly requestedBy: UserId;
  readonly source: ThreadInputSource;
  readonly threadId: ThreadId;
  readonly forwardedPlaces?: true;
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
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly expectedRunId: RunId;
  readonly requestedBy: UserId;
  readonly idempotencyKey: string;
}

export interface CancelThreadInputRequest {
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
  readonly callerIntent?: Pick<AgentControlAdmissionInput, "requestId" | "requestFingerprint">;
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
  readonly icon?: WorkspaceIconName;
  readonly workspaceId: WorkspaceId;
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
  | { readonly kind: "agent"; readonly request: AgentControlAdmissionInput }
  | { readonly kind: "trigger"; readonly request: TriggerControlAdmissionInput }
  | { readonly kind: "watch"; readonly request: WatchControlAdmissionInput };

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
  readonly doneAt: string | null;
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly pendingRequests: number;
  readonly status: ThreadRow["status"];
  readonly title: string;
  readonly updatedAt: string;
  readonly workspaceId: WorkspaceId;
  readonly workspaceName: string;
}

export interface AgentThreadListPage {
  readonly threads: readonly AgentThreadListEntry[];
  readonly window: DurableWindow;
}

export type AgentThreadListScope =
  | { readonly kind: "lineage"; readonly threadId: ThreadId }
  | { readonly kind: "user" }
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId };

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
  const observed = await transaction
    .selectFrom("threads")
    .select("workspaceId")
    .where("id", "=", existingCommand.threadId)
    .executeTakeFirstOrThrow();
  await lockWorkspaceRow(transaction, observed.workspaceId);
  await requireActiveWorkspaceMembership(transaction, observed.workspaceId, input.createdBy, true);
  const existingThread = await transaction
    .selectFrom("threads")
    .selectAll()
    .select([
      threadPendingRequestsSelection,
      threadProviderSessionSelection,
      threadContinuationIdentitySelection,
    ])
    .where("id", "=", existingCommand.threadId)
    .executeTakeFirstOrThrow();
  return {
    asOfSequence: await workspaceHead(transaction, existingThread.workspaceId),
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
    accessMode: input.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
    createdBy: input.createdBy,
    environmentId: input.environmentId,
    harnessInstanceId: input.harnessInstanceId,
    ...(input.home ? { home: true } : {}),
    ...(input.generateTitle ? { generateTitle: true } : {}),
    modelSelection,
    ...(input.id ? { id: input.id } : {}),
    idempotencyKey: input.idempotencyKey,
    ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
    ...(input.role ? { role: input.role } : {}),
    title: input.title,
    workspaceId: input.workspaceId,
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
    throw new OpensteerError({ code: "forbidden", message: "Control admission action mismatch" });
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
  const rows = await database
    .selectFrom("threads")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
    .selectAll("threads")
    .select([
      threadPendingRequestsSelection,
      threadProviderSessionSelection,
      threadContinuationIdentitySelection,
    ])
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
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
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      let query = transaction
        .selectFrom("threads")
        .innerJoin(
          "workspaceMemberships",
          "workspaceMemberships.workspaceId",
          "threads.workspaceId",
        )
        .selectAll("threads")
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("workspaceMemberships.userId", "=", input.ownerId)
        .where("workspaceMemberships.state", "=", "active");
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
          .innerJoin(
            "workspaceMemberships",
            "workspaceMemberships.workspaceId",
            "threads.workspaceId",
          )
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("workspaceMemberships.userId", "=", input.ownerId)
          .where("workspaceMemberships.state", "=", "active")
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
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      const row = await transaction
        .selectFrom("delegations")
        .innerJoin("threads as workerThread", "workerThread.id", "delegations.childThreadId")
        .innerJoin(
          "workspaceMemberships as workerMembership",
          "workerMembership.workspaceId",
          "workerThread.workspaceId",
        )
        .selectAll("delegations")
        .where("delegations.id", "=", input.assignmentId)
        .where("workerMembership.userId", "=", input.ownerId)
        .where("workerMembership.state", "=", "active")
        .executeTakeFirst();
      if (!row) return null;
      const parent = await transaction
        .selectFrom("threads")
        .innerJoin(
          "workspaceMemberships",
          "workspaceMemberships.workspaceId",
          "threads.workspaceId",
        )
        .select("threads.id")
        .where("threads.id", "=", row.parentThreadId)
        .where("workspaceMemberships.userId", "=", input.ownerId)
        .where("workspaceMemberships.state", "=", "active")
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
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      const thread = await transaction
        .selectFrom("threads")
        .innerJoin(
          "workspaceMemberships",
          "workspaceMemberships.workspaceId",
          "threads.workspaceId",
        )
        .select("threads.id")
        .where("threads.id", "=", input.threadId)
        .where("workspaceMemberships.userId", "=", input.ownerId)
        .where("workspaceMemberships.state", "=", "active")
        .executeTakeFirst();
      if (!thread) return null;
      const base = transaction
        .selectFrom("delegations")
        .innerJoin("threads as workerThread", "workerThread.id", "delegations.childThreadId")
        .innerJoin(
          "workspaceMemberships as workerMembership",
          "workerMembership.workspaceId",
          "workerThread.workspaceId",
        )
        .innerJoin("threads as parentThread", "parentThread.id", "delegations.parentThreadId")
        .innerJoin("workspaceMemberships as parentMembership", (join) =>
          join
            .onRef("parentMembership.workspaceId", "=", "parentThread.workspaceId")
            .on("parentMembership.userId", "=", input.ownerId)
            .on("parentMembership.state", "=", "active"),
        )
        .where("workerMembership.userId", "=", input.ownerId)
        .where("workerMembership.state", "=", "active")
        .where((expressions) =>
          expressions.or([
            expressions("delegations.childThreadId", "=", input.threadId),
            expressions("delegations.parentThreadId", "=", input.threadId),
          ]),
        );
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
    readonly workspaceId?: WorkspaceId;
  },
): Promise<AgentThreadListPage> {
  const maxItems = boundedWindowLimit(input.maxItems, 50);
  const maxBytes = boundedWindowBytes(input.maxBytes, 192 * 1_024);
  const anchor = input.before
    ? decodeWindowCursor(input.before, "agent-thread", input.scopeId)
    : null;
  const pattern = input.query === undefined ? null : `%${escapeLikePattern(input.query)}%`;
  const scope = input.scope;
  return withDatabaseTransaction(
    database,
    async (transaction) => {
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
        .innerJoin(
          "workspaceMemberships",
          "workspaceMemberships.workspaceId",
          "threads.workspaceId",
        )
        .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
        .where("workspaceMemberships.userId", "=", input.ownerId)
        .where("workspaceMemberships.state", "=", "active");
      if (scope.kind === "workspace") {
        base = base.where("threads.workspaceId", "=", scope.workspaceId);
      }
      if (input.workspaceId) {
        base = base.where("threads.workspaceId", "=", input.workspaceId);
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
          .select([
            "threads.environmentId",
            "threads.id",
            "threads.parentThreadId",
            "threads.status",
            "threads.title",
            "threads.doneAt",
            "threads.updatedAt",
            "threads.workspaceId",
            "workspaces.name as workspaceName",
          ])
          .select([
            threadPendingRequestsSelection,
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
  const row = await database
    .selectFrom("threads")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
    .selectAll("threads")
    .select([
      threadPendingRequestsSelection,
      threadProviderSessionSelection,
      threadContinuationIdentitySelection,
    ])
    .where("threads.id", "=", threadId)
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .executeTakeFirst();
  return row ? threadFromRow(row) : null;
}

export function admitAgentControlRequest(
  database: Kysely<DatabaseSchema>,
  input: AgentControlAdmissionInput,
  executionNow: () => number = Date.now,
): Promise<AgentControlAdmissionResult> {
  return persistAgentControlAdmission(database, input, executionNow);
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
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      const threadRow = await transaction
        .selectFrom("threads")
        .innerJoin(
          "workspaceMemberships",
          "workspaceMemberships.workspaceId",
          "threads.workspaceId",
        )
        .selectAll("threads")
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("threads.id", "=", threadId)
        .where("workspaceMemberships.userId", "=", ownerId)
        .where("workspaceMemberships.state", "=", "active")
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
  return withDatabaseTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.createdBy, input.idempotencyKey);
    const resolvedInput = {
      ...input,
      accessMode: await resolveCreateThreadAccessMode(transaction, input),
    };
    const requestPayload = canonicalCreateThreadInput(resolvedInput);
    const existing = await findExistingThreadCreation(transaction, resolvedInput, requestPayload);
    if (existing) return existing;

    const id = input.id ?? createId("thread");
    const commandId = createId("command");
    const workspace = await transaction
      .selectFrom("workspaces")
      .select(["homeThreadId", "id", "kind", "status"])
      .where("id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!workspace) throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    const membership = await transaction
      .selectFrom("workspaceMemberships")
      .select(["role", "state"])
      .where("workspaceId", "=", input.workspaceId)
      .where("userId", "=", input.createdBy)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!membership || membership.state !== "active") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Thread creator must be an active Workspace member",
      });
    }
    if (
      input.home &&
      (workspace.kind !== "main" ||
        membership.role !== "owner" ||
        input.parentThreadId ||
        input.role === "work")
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Home must be an owner's root Thread in the Main Workspace",
      });
    }
    if (input.home && workspace.homeThreadId) {
      const home = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", workspace.homeThreadId)
        .executeTakeFirstOrThrow();
      return {
        asOfSequence: await workspaceHead(transaction, home.workspaceId),
        thread: threadFromRow(home),
        wasDuplicate: true,
      };
    }
    const insertThread = await prepareThreadInsertion(transaction, {
      createdBy: input.createdBy,
      environmentId: input.environmentId,
      harnessInstanceId: input.harnessInstanceId,
    });
    if (workspace.status !== "ready") {
      throw new OpensteerError({
        code: "conflict",
        message: "Workspace filesystem is not ready",
        retryable: workspace.status === "provisioning" || workspace.status === "unavailable",
      });
    }
    let lineageRootThreadId = id;
    let listed = true;
    if (input.parentThreadId) {
      const parent = await transaction
        .selectFrom("threads")
        .select(["lineageRootThreadId", "role", "workspaceId"])
        .where("threads.id", "=", input.parentThreadId)
        .executeTakeFirst();
      if (!parent) {
        throw new OpensteerError({ code: "not_found", message: "Parent thread not found" });
      }
      const parentMembership = await transaction
        .selectFrom("workspaceMemberships")
        .select("state")
        .where("workspaceId", "=", parent.workspaceId)
        .where("userId", "=", input.createdBy)
        .executeTakeFirst();
      if (!parentMembership || parentMembership.state !== "active") {
        throw new OpensteerError({
          code: "forbidden",
          message: "Thread creator must be a member of both parent and child Workspaces",
        });
      }
      lineageRootThreadId = parent.lineageRootThreadId;
      listed = parent.role === "conversation";
    }
    const actorPrincipalId = await principalIdForUser(transaction, input.createdBy);
    const thread = await insertThread({
      accessMode: resolvedInput.accessMode,
      capabilityProfileId: input.parentThreadId
        ? "delegated"
        : workspace.kind === "main" && membership.role === "owner"
          ? "main"
          : "workspace",
      createdByPrincipalId: actorPrincipalId,
      id,
      lineageRootThreadId,
      listed,
      modelSelection: jsonValue(ModelSelectionSchema.parse(input.modelSelection)),
      parentThreadId: input.parentThreadId ?? null,
      role: input.role ?? (input.home ? "conversation" : "work"),
      status: deriveThreadStatus({
        earliestActiveRunStatus: null,
        inputQueuePaused: false,
        lastRunFailed: false,
      }),
      title: input.home ? CHAT_THREAD_TITLE : input.title,
      titleSource: input.generateTitle && !input.home ? "provisional" : "chosen",
      icon: null,
      iconSource: input.home ? "chosen" : "provisional",
      workspaceId: input.workspaceId,
    });
    await ensureSelectedProviderSession(transaction, thread);
    if (input.home) {
      await transaction
        .updateTable("workspaces")
        .set({ homeThreadId: thread.id })
        .where("id", "=", workspace.id)
        .where("homeThreadId", "is", null)
        .executeTakeFirstOrThrow();
    }
    await transaction
      .insertInto("commands")
      .values({
        actorPrincipalId,
        authoritySource: jsonValue({ kind: "user-session", userId: input.createdBy }),
        dispatcherId: null,
        environmentId: input.environmentId,
        id: commandId,
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
    const selectedSessionId = await transaction
      .selectFrom("providerSessions")
      .select("id")
      .where("threadId", "=", thread.id)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    const parsedThread = threadFromRow({
      ...thread,
      continuationIdentity: null,
      providerSessionId: selectedSessionId.id,
      pendingRequests: thread.pendingRequestCount,
    });
    const event = await appendHostWorkspaceEvent(transaction, {
      data: { thread: parsedThread, ...(input.home ? { home: true as const } : {}) },
      environmentId: parsedThread.environmentId,
      runId: null,
      threadId: parsedThread.id,
      type: "thread.created",
      workspaceId: parsedThread.workspaceId,
    });
    return {
      asOfSequence: await workspaceHead(transaction, parsedThread.workspaceId),
      event,
      thread: parsedThread,
      wasDuplicate: false,
    };
  });
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
  return withDatabaseTransaction(database, (transaction) =>
    delegateThreadInTransaction(transaction, input),
  );
}

export async function delegateAdmittedThread(
  database: Kysely<DatabaseSchema>,
  request: AdmittedThreadDelegationRequest,
  executionNow: () => number = Date.now,
): Promise<DelegatedThreadResult> {
  assertThreadMutationAdmission(request.admission, "thread.delegate", request.input);
  return withDatabaseTransaction(database, async (transaction) => {
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
    await admitAgentControlRequestInTransaction(transaction, admission.request, mode, executionNow);
  } else if (admission.kind === "trigger") {
    await admitTriggerControlRequestInTransaction(transaction, admission.request, mode);
  } else {
    await admitWatchControlRequestInTransaction(transaction, admission.request, mode);
  }
}

export async function cancelAssignment(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: CancelAssignmentInput & { readonly admission?: AgentControlAdmissionInput },
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
        if (input.admission) {
          await admitAgentControlRequestInTransaction(
            transaction,
            input.admission,
            "check",
            executionNow,
          );
        }
        await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
        const result = await cancelAssignmentInTransaction(transaction, input, links);
        if (input.admission) {
          await admitAgentControlRequestInTransaction(
            transaction,
            input.admission,
            "admit",
            executionNow,
          );
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
    readonly continuationIdentity: ProviderContinuationIdentity;
    readonly continuation?: { readonly expectedProviderSessionId: ProviderSessionId | null };
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
  return withDatabaseTransaction(database, async (transaction) => {
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
      const observed = await transaction
        .selectFrom("threads")
        .select("workspaceId")
        .where("id", "=", input.threadId)
        .executeTakeFirstOrThrow();
      await lockWorkspaceRow(transaction, observed.workspaceId);
      await requireActiveWorkspaceMembership(
        transaction,
        observed.workspaceId,
        input.requestedBy,
        true,
      );
      const current = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
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
        asOfSequence: await workspaceHead(transaction, current.workspaceId),
        thread: threadFromRow(current),
        event: null,
        wasDuplicate: true,
      };
    }
    const observed = await transaction
      .selectFrom("threads")
      .select("workspaceId")
      .where("id", "=", input.threadId)
      .executeTakeFirst();
    if (!observed) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
    await lockWorkspaceRow(transaction, observed.workspaceId);
    const membership = await transaction
      .selectFrom("workspaceMemberships")
      .select("state")
      .where("workspaceId", "=", observed.workspaceId)
      .where("userId", "=", input.requestedBy)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!membership || membership.state !== "active") {
      throw new OpensteerError({
        code: "forbidden",
        message: "An active Workspace membership is required to change the AI engine",
      });
    }
    const requestedHarness = await transaction
      .selectFrom("harnessInstances")
      .select(["driverKind", "enabled", "environmentId"])
      .where("id", "=", input.harnessInstanceId)
      .forShare()
      .executeTakeFirst();
    if (!requestedHarness?.enabled) {
      throw new OpensteerError({ code: "conflict", message: "AI engine is unavailable" });
    }
    const thread = await transaction
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
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
          .set({ active: false, updatedAt: new Date() })
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
        authoritySource: jsonValue({ kind: "user-session", userId: input.requestedBy }),
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
    const event = await appendHostWorkspaceEvent(transaction, {
      data: { thread: parsedThread },
      environmentId: thread.environmentId,
      runId: null,
      threadId: thread.id,
      type: "thread.execution-updated",
      workspaceId: thread.workspaceId,
    });
    return {
      asOfSequence: await workspaceHead(transaction, parsedThread.workspaceId),
      thread: parsedThread,
      event,
      wasDuplicate: false,
    };
  });
}

export async function resumeThreadInputQueue(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  },
): Promise<{
  readonly asOfSequence: Sequence;
  readonly thread: Thread;
  readonly events: readonly AgentEvent[];
}> {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    const observed = await transaction
      .selectFrom("threads")
      .select("workspaceId")
      .where("id", "=", input.threadId)
      .executeTakeFirst();
    if (!observed) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
    await lockWorkspaceRow(transaction, observed.workspaceId);
    await lockThreadRow(transaction, input.threadId);
    const thread = await transaction
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .where("id", "=", input.threadId)
      .executeTakeFirstOrThrow();
    const membership = await requireActiveWorkspaceMembership(
      transaction,
      thread.workspaceId,
      input.requestedBy,
    );
    if (thread.status === "archived")
      throw new OpensteerError({ code: "conflict", message: "Archived threads cannot run" });
    const payload = { type: "thread.inputQueue.resume", threadId: input.threadId };
    const existing = await findCommandByIdempotency(
      transaction,
      input.requestedBy,
      input.idempotencyKey,
    );
    if (existing) {
      if (!isDeepStrictEqual(existing.payload, payload))
        throw idempotencyConflict(input.idempotencyKey);
      return {
        asOfSequence: await workspaceHead(transaction, thread.workspaceId),
        thread: threadFromRow(thread),
        events: [],
      };
    }
    if (
      thread.inputQueuePaused &&
      thread.inputQueuePausedBy !== input.requestedBy &&
      membership.role !== "owner"
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Only the person who paused the queue or a Workspace owner may resume it",
      });
    }
    await transaction
      .insertInto("commands")
      .values({
        actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
        authoritySource: jsonValue({ kind: "workspace-membership", userId: input.requestedBy }),
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
      .set({ inputQueuePaused: false, inputQueuePausedBy: null, updatedAt: new Date() })
      .where("id", "=", thread.id)
      .execute();
    const event = await appendHostWorkspaceEvent(transaction, {
      data: { paused: false },
      environmentId: thread.environmentId,
      runId: null,
      threadId: thread.id,
      type: "thread.input-queue-updated",
      workspaceId: thread.workspaceId,
    });
    const queued = await ensureQueuedRun(transaction, { ...thread, inputQueuePaused: false });
    const statusEvents = await projectThreadState(transaction, thread.id);
    const current = await transaction
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .where("id", "=", thread.id)
      .executeTakeFirstOrThrow();
    return {
      asOfSequence: await workspaceHead(transaction, current.workspaceId),
      thread: threadFromRow(current),
      events: [event, ...queued.events, ...statusEvents],
    };
  });
}

export async function renameThread(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly actorRunId?: RunId;
    readonly admission?: AgentControlAdmissionInput;
    readonly threadId: ThreadId;
    readonly title: string;
  },
): Promise<ThreadUpdateResult> {
  const title = ThreadTitleSchema.parse(input.title);
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
      const payload = { threadId: input.threadId, title };
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
      const workspaceId = await lockThreadNameWorkspaces(transaction, input.threadId);
      if (!workspaceId)
        throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      await requireActiveWorkspaceMembership(transaction, workspaceId, input.requestedBy, true);
      const workspace = await transaction
        .selectFrom("workspaces")
        .select("homeThreadId")
        .where("id", "=", workspaceId)
        .executeTakeFirstOrThrow();
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", input.threadId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      await requireThreadWriteAuthority(transaction, thread, input, "rename");
      if (workspace.homeThreadId === thread.id) {
        throw new OpensteerError({ code: "bad_request", message: "Chat cannot be renamed" });
      }
      if (existing)
        return {
          asOfSequence: await workspaceHead(transaction, thread.workspaceId),
          thread: threadFromRow(thread),
        };
      const row = await transaction
        .updateTable("threads")
        .set({ title, titleSource: "chosen", updatedAt: new Date() })
        .where("id", "=", thread.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const event =
        thread.title !== title
          ? await appendHostWorkspaceEvent(transaction, {
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
              workspaceId: row.workspaceId,
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
          authoritySource: jsonValue({ kind: "user-session", userId: input.requestedBy }),
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
        asOfSequence: await workspaceHead(transaction, row.workspaceId),
        ...(event ? { event } : {}),
        events,
        thread: threadFromRow({ ...thread, ...row }),
      };
    },
    undefined,
    (error) => error instanceof TransactionScopeChanged,
  );
}

export async function setThreadIcon(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly actorRunId?: RunId;
    readonly admission?: AgentControlAdmissionInput;
    readonly threadId: ThreadId;
    readonly icon: WorkspaceIconName | null;
  },
): Promise<ThreadUpdateResult> {
  const icon = WorkspaceIconNameSchema.parse(input.icon ?? defaultTaskSymbol);
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
      const payload = { threadId: input.threadId, icon: input.icon };
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
      const workspaceId = await lockThreadNameWorkspaces(transaction, input.threadId);
      if (!workspaceId)
        throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      await requireActiveWorkspaceMembership(transaction, workspaceId, input.requestedBy, true);
      const workspace = await transaction
        .selectFrom("workspaces")
        .select("homeThreadId")
        .where("id", "=", workspaceId)
        .executeTakeFirstOrThrow();
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", input.threadId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      await requireThreadWriteAuthority(transaction, thread, input, "set_icon");
      if (workspace.homeThreadId === thread.id) {
        throw new OpensteerError({ code: "bad_request", message: "Chat's icon cannot be changed" });
      }
      if (existing)
        return {
          asOfSequence: await workspaceHead(transaction, thread.workspaceId),
          thread: threadFromRow(thread),
        };
      const row = await transaction
        .updateTable("threads")
        .set({ icon, iconSource: "chosen", updatedAt: new Date() })
        .where("id", "=", thread.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const event =
        thread.icon !== icon
          ? await appendHostWorkspaceEvent(transaction, {
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
              workspaceId: row.workspaceId,
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
          authoritySource: jsonValue({ kind: "user-session", userId: input.requestedBy }),
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
        asOfSequence: await workspaceHead(transaction, row.workspaceId),
        ...(event ? { event } : {}),
        events,
        thread: threadFromRow({ ...thread, ...row }),
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
    readonly icon?: WorkspaceIconName | undefined;
  },
): Promise<{ readonly event: AgentEvent; readonly events: readonly AgentEvent[] } | null> {
  const title =
    input.title === undefined ? undefined : GeneratedThreadTitleSchema.parse(input.title);
  const icon = input.icon === undefined ? undefined : WorkspaceIconNameSchema.parse(input.icon);
  if (title === undefined && icon === undefined) return null;
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      if (!(await lockThreadNameWorkspaces(transaction, input.threadId))) return null;
      const renamed =
        title === undefined
          ? undefined
          : await transaction
              .updateTable("threads")
              .set({ title, titleSource: "generated", updatedAt: new Date() })
              .where("id", "=", input.threadId)
              .where("titleSource", "=", "provisional")
              .returning("id")
              .executeTakeFirst();
      const marked =
        icon === undefined
          ? undefined
          : await transaction
              .updateTable("threads")
              .set({ icon, iconSource: "generated", updatedAt: new Date() })
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
      const event = await appendHostWorkspaceEvent(transaction, {
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
        workspaceId: row.workspaceId,
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
  return withDatabaseTransaction(database, async (transaction) => {
    const observed = await transaction
      .selectFrom("threads")
      .select("workspaceId")
      .where("id", "=", input.threadId)
      .executeTakeFirst();
    if (!observed) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
    await lockWorkspaceRow(transaction, observed.workspaceId);
    const membership = await transaction
      .selectFrom("workspaceMemberships")
      .select("state")
      .where("workspaceId", "=", observed.workspaceId)
      .where("userId", "=", input.requestedBy)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!membership || membership.state !== "active") {
      throw new OpensteerError({
        code: "forbidden",
        message: "An active Workspace membership is required to change the access mode",
      });
    }
    const thread = await transaction
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
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
        asOfSequence: await workspaceHead(transaction, thread.workspaceId),
        thread: threadFromRow(thread),
      };

    const updatedAt = new Date();
    const row = await transaction
      .updateTable("threads")
      .set({ accessMode, updatedAt })
      .where("id", "=", thread.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const updated = threadFromRow({ ...thread, ...row });
    const event = await appendHostWorkspaceEvent(transaction, {
      data: { accessMode },
      environmentId: updated.environmentId,
      runId: null,
      threadId: updated.id,
      type: "thread.access-mode-updated",
      workspaceId: updated.workspaceId,
    });
    return {
      asOfSequence: await workspaceHead(transaction, updated.workspaceId),
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
  const resolvedInput = {
    ...input,
    accessMode: await resolveCreateThreadAccessMode(database, input),
  };
  return withDatabaseTransaction(
    database,
    async (transaction) =>
      (await findExistingThreadCreation(
        transaction,
        resolvedInput,
        canonicalCreateThreadInput(resolvedInput),
      )) ?? null,
  );
}

export async function enqueueThreadInput(
  database: Kysely<DatabaseSchema>,
  input: EnqueueThreadInputRequest,
): Promise<EnqueuedThreadInput> {
  return withDatabaseTransaction(database, (transaction) =>
    enqueueThreadInputInTransaction(transaction, input),
  );
}

export async function steerThreadInput(
  database: Kysely<DatabaseSchema>,
  input: SteerThreadInputRequest,
): Promise<EnqueuedThreadInput> {
  return withDatabaseTransaction(database, (transaction) =>
    steerThreadInputInTransaction(transaction, input),
  );
}

export async function cancelThreadInput(
  database: Kysely<DatabaseSchema>,
  input: CancelThreadInputRequest,
): Promise<CancelledThreadInput> {
  return withDatabaseTransaction(database, (transaction) =>
    cancelThreadInputInTransaction(transaction, input),
  );
}

export async function moveThreadInput(
  database: Kysely<DatabaseSchema>,
  input: MoveThreadInputRequest,
): Promise<MovedThreadInput> {
  return withDatabaseTransaction(database, (transaction) =>
    moveThreadInputInTransaction(transaction, input),
  );
}

export async function getThreadInputQueue(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly threadId: ThreadId;
    readonly requestedBy: UserId;
  },
): Promise<ThreadInputQueue> {
  return withDatabaseTransaction(database, (transaction) =>
    readThreadInputQueue(transaction, input),
  );
}

export async function enqueueAdmittedThreadInput(
  database: Kysely<DatabaseSchema>,
  request: AdmittedThreadInputRequest,
  executionNow: () => number = Date.now,
): Promise<EnqueuedThreadInput> {
  assertThreadMutationAdmission(request.admission, "thread.message", request.input);
  return withDatabaseTransaction(database, async (transaction) => {
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
