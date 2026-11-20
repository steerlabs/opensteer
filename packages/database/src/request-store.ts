import { expiredPersonalSignInRequests, nextPersonalRequestDeadline } from "./request-deadlines.js";
import { computerConnectionDeviceId } from "./integration-connections.js";
import type {
  IntegrationConnectionSummary as LegacyIntegrationConnectionSummary,
  ComputerAppSetupRequest as LegacyComputerAppSetupRequest,
} from "@opensteer/integration-core";
import { legacySelfConnection, legacySelfSetupRequest } from "./device-legacy-store.js";
import { requireSelfDeviceId } from "./device-inventory-store.js";
import { DeviceIdSchema, isPhoneDisplayDefinitionId, type DeviceId } from "@opensteer/core";
import { deviceOwnershipIn } from "./machine-ownership.js";
import { getDeviceSelfRunnerId } from "./device-inventory-store.js";
import { getBrowserSessionForOwner } from "./browser-session-store.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalReadTransaction } from "./personal-transaction.js";
import { lockBrowserHomeRunner } from "./browser-home-store.js";
import { assertActiveGrant } from "./execution-authority.js";
import { enqueueChannelConversationStatus } from "./channel-deliveries.js";
import { nearestListedThread } from "./thread-lineage.js";
import { requestSettlementActor, readRequestSettlementProvenance } from "./request-settlement.js";
import {
  AssignmentIdSchema,
  BrowserProfileIdSchema,
  OpensteerError,
  PendingRequestSchema,
  RequestIdSchema,
  RequestJsonObjectSchema,
  RequestPresentationSchema,
  RequestResponseSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  browserSessionClosedReason,
  createId,
  requestFormAnswersProblem,
  type BrowserProfileId,
  type BrowserSourceId,
  type HeldAssignment,
  type PendingRequest,
  type Request,
  type RequestCancellationReason,
  type RequestId,
  type RequestPayload,
  type RequestPresentation,
  type RequestRequiredActor,
  type RequestResponse,
  type RunId,
  type RunnerId,
  type ThreadId,
  type TriggerOccurrenceId,
  type TriggerWatchActivationId,
  type UserId,
  type WaitingRequest,
} from "@opensteer/core";
import {
  ComputerAppIdentitySchema,
  IntegrationAccessSchema,
  IntegrationConnectionRequirementSchema,
  IntegrationInstallManifestSchema,
  computerAppIdentitiesEqual,
  integrationAccessCovers,
  type ComputerAppIdentity,
  type DeviceComputerAppSetupRequest as ComputerAppSetupRequest,
  type IntegrationAccess,
  type IntegrationConnectionId,
  type DeviceIntegrationConnectionSummary as IntegrationConnectionSummary,
  type IntegrationInstallManifest,
  type IntegrationInstallationId,
  type IntegrationServerId,
  type IntegrationToolMaterial,
} from "@opensteer/integration-core";
import {
  deviceAccess,
  type MachineAccessPolicy,
  BrowserSessionIdSchema,
  PasswordSignInRequestResponseSchema,
  type DurableWindow,
  type PasswordSignInRequestResponse,
} from "@opensteer/protocol";
import {
  BrowserSignInRequestResponseSchema,
  type BrowserSignInRequestResponse,
} from "@opensteer/protocol/browser-sources";
import { sql, type ExpressionBuilder, type Kysely, type Transaction } from "kysely";
import {
  assignmentClosedToRequestsMessage,
  runAssignmentAcceptsRequests,
} from "./assignment-store.js";
import {
  askForComputerAppApprovalInTransaction,
  computerUsePolicyInTransaction,
  lockComputerApprovalScopeInTransaction,
} from "./computer-app-approvals.js";
import {
  computerAppAccessPresentation,
  computerAppScopeOf,
  computerAppSetupRequestFromRow,
} from "./computer-app-setup.js";
import "./connection.js";
import { lockIntegrationCatalogDefinitionInTransaction } from "./integration-platform-stores.js";
import { approveComputerAppAutomaticallyInTransaction } from "./computer-connection-writes.js";
import { deviceAccessStates } from "./device-store.js";
import { machineIsManagedBy } from "./machine-ownership.js";
import { cancelPending } from "./request-cancellation.js";
import {
  assertRequestRevision,
  refreshRequestState,
  lockRequestThreads,
  requestFromRow,
  requestInsert,
} from "./request-persistence.js";
import { insertBrowserProfileOnLockedHome } from "./browser-session-store.js";
import { runHasActiveGrant } from "./run-grants.js";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import {
  jsonValue,
  lockThreadRow,
  threadPathLinks,
  type ChannelLinks,
} from "./store-primitives.js";
import { commitPersonalMutation } from "./personal-mutation.js";
export { cancelPending } from "./request-cancellation.js";
export { requestFromRow, requestInsert } from "./request-persistence.js";
export interface IntegrationRequestDetailInput {
  readonly access: IntegrationAccess | null;
  readonly installationId: IntegrationInstallationId | null;
  readonly manifest: IntegrationInstallManifest | null;
  readonly requestedConnectionId: IntegrationConnectionId | null;
  readonly requestedServerId: IntegrationServerId | null;
}

/**
 * A Request originates from exactly one execution. A Run signs its own
 * authority; a Trigger Occurrence carries the same facts through the Trigger it
 * belongs to and produces no Run row, so the two are mutually exclusive rather
 * than one being a fallback for the other.
 */
export type RequestOriginInput =
  | {
      readonly originatingOccurrenceId?: never;
      readonly originatingWatchActivationId?: never;
      readonly originatingRunId: RunId;
    }
  | {
      readonly originatingOccurrenceId: TriggerOccurrenceId;
      readonly originatingWatchActivationId?: never;
      readonly originatingRunId?: never;
    }
  | {
      readonly originatingRunId?: never;
      readonly originatingOccurrenceId?: never;
      readonly originatingWatchActivationId: TriggerWatchActivationId;
    };
interface CreateRequestFields {
  readonly callId: string;
  readonly kind: PendingRequest["kind"];
  readonly mode: PendingRequest["mode"];
  readonly originatingThreadId: ThreadId;
  readonly payload: RequestPayload;
  readonly presentation: RequestPresentation;
  readonly requestedBy: UserId;
  readonly requiredActor: RequestRequiredActor;
  readonly integrationDetail?: IntegrationRequestDetailInput;
}
export type CreateRequestInput = CreateRequestFields & RequestOriginInput;

/** What one task's ask for an app on a Mac came to. */
export type DeviceComputerAppAccessDecision =
  | {
      readonly connection: IntegrationConnectionSummary;
      readonly kind: "approved";
    }
  | {
      readonly kind: "personal-grant";
      readonly replayed: boolean;
      readonly request: Request;
    }
  | {
      /** The ask waits on the computer itself: the Mac's panel, or the phone in its owner's hand. */
      readonly kind: "computer";
      readonly replayed: boolean;
      readonly request: Request;
      readonly setupRequest: ComputerAppSetupRequest;
    };

export type ComputerAppAccessDecision =
  | (Omit<Extract<DeviceComputerAppAccessDecision, { kind: "approved" }>, "connection"> & {
      readonly connection: LegacyIntegrationConnectionSummary;
    })
  | (Omit<Extract<DeviceComputerAppAccessDecision, { kind: "computer" }>, "setupRequest"> & {
      readonly setupRequest: LegacyComputerAppSetupRequest;
    })
  | Extract<DeviceComputerAppAccessDecision, { kind: "personal-grant" }>;
export interface RequestMutation {
  readonly replayed: boolean;
  readonly request: Request;
}
export interface ResolvedBrowserRequest {
  readonly profile: {
    readonly homeRunnerId: RunnerId | null;
    readonly id: BrowserProfileId;
    readonly name: string;
    readonly ownerId: UserId;
  } | null;
  readonly request: Request;
}
interface PendingRequestContinuation {
  readonly attemptedAt: string | null;
  readonly reason: string | null;
  readonly request: Request;
  readonly status: "waiting" | "queued" | "undeliverable";
}

/**
 * Persistence for the single Request lifecycle. Kind-specific authority
 * changes remain explicit callers of this store, but creation, visibility,
 * replay, withdrawal, cancellation, and continuation bookkeeping do not fork.
 */
const personAuthorities = ["user-session", "channel-ingress"];
export class RequestStore {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #links: ChannelLinks;
  readonly #executionNow: () => number;
  constructor(
    database: Kysely<DatabaseSchema>,
    links: ChannelLinks = threadPathLinks,
    executionNow: () => number = Date.now,
  ) {
    this.#executionNow = executionNow;
    this.#links = links;
    this.#database = database;
  }

  /**
   * A Trigger fires again on its own schedule and every Occurrence carries a
   * fresh call identity, so the same unanswered ask would open one Request per
   * tick until somebody answers it. Folding it into the equivalent pending
   * Request is scoped to Occurrence origins on purpose: a Run-originated
   * Request's continuation is delivered to the Run that opened it, so handing a
   * second Run the first Run's Request would strand the second Run's reply.
   *
   * Two Occurrences can pass this check concurrently and both insert. That race
   * is accepted — this is dedup, not an invariant, and its cost is one extra
   * card to approve rather than a broken guarantee.
   */
  async createDeviceAccessRequest(
    input: {
      readonly callId: string;
      readonly machineId: DeviceId;
      readonly access: "browser" | "apps" | "files";
      readonly reason: string;
      readonly originatingRunId: RunId;
      readonly originatingThreadId: ThreadId;
      readonly requestedBy: UserId;
    },
    isOnline: () => boolean,
  ): Promise<RequestMutation> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const machine = await transaction
        .selectFrom("devices")
        .select("name")
        .where("id", "=", input.machineId)
        .executeTakeFirst();
      if (!machine)
        throw new OpensteerError({ code: "forbidden", message: "Owned computer not found" });
      const label = { browser: "Browser", apps: "Apps", files: "Files and commands" }[input.access];
      return createRequestInTransaction(
        this.#links,
        transaction,
        {
          callId: input.callId,
          kind: "device.access",
          mode: "durable",
          requiredActor: "owner",
          originatingRunId: input.originatingRunId,
          originatingThreadId: input.originatingThreadId,
          requestedBy: input.requestedBy,
          payload: {
            kind: "device.access",
            machineId: input.machineId,
            machineName: machine.name,
            access: input.access,
            reason: input.reason,
          },
          presentation: {
            kind: "external",
            subject: { kind: "machine", id: input.machineId },
            title: `Let your agent use ${label} on ${machine.name}?`,
            detail: input.reason,
          },
        },
        isOnline,
      );
    });
  }
  async declineDeviceAccessRequest(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<{ request: Request }> {
    const value = input.response.kind === "external" ? input.response.value : undefined;
    if (!value || Object.keys(value).length !== 1 || value.decision !== "declined")
      throw new OpensteerError({
        code: "bad_request",
        message:
          "Turn device access on through machine.access.update; this response can only decline.",
      });
    return commitPersonalMutation(this.#database, async (transaction) => {
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (!row || row.kind !== "device.access" || row.payload.kind !== "device.access")
        throw new OpensteerError({
          code: "not_found",
          message: "Computer access Request not found",
        });
      const ownership = await deviceOwnershipIn(transaction, row.payload.machineId);
      if (!ownership || !machineIsManagedBy(ownership, input.resolvedBy))
        throw new OpensteerError({
          code: "forbidden",
          message: "Only this computer's owner can answer its access Request.",
        });
      if (row.status !== "pending")
        throw new OpensteerError({
          code: "conflict",
          message: "Computer access Request is no longer pending",
        });
      assertRequestRevision(row, input.expectedRevision);
      await lockActiveDurableRequestAuthority(transaction, requestFromRow(row));
      await lockRequestThreads(transaction, [row.originatingThreadId]);
      const now = new Date();
      const resolved = await transaction
        .updateTable("requests")
        .set({
          status: "declined",
          resolvedAt: now,
          resolvedBy: input.resolvedBy,
          response: jsonValue(input.response),
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(resolved);
      await enqueueContinuation(transaction, request, now);
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return { request: await refreshRequestState(transaction, request.id) };
    });
  }
  /**
   * The person answers or dismisses a question an agent asked with
   * `ask_person`. Only the person it asked may answer, and the answer must fit
   * the questions; the task that asked wakes with it however late it comes.
   */
  async answerPersonQuestion(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<{ request: Request }> {
    const declined =
      input.response.kind === "external" &&
      input.response.value !== undefined &&
      Object.keys(input.response.value).length === 1 &&
      input.response.value.decision === "declined";
    if (input.response.kind !== "form" && !declined)
      throw new OpensteerError({
        code: "bad_request",
        message: "Answer a question with its answers, or dismiss it.",
      });
    return commitPersonalMutation(this.#database, async (transaction) => {
      const origin = await transaction
        .selectFrom("requests")
        .select("originatingThreadId")
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (origin) await lockRequestThreads(transaction, [origin.originatingThreadId]);
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || row.kind !== "person.question")
        throw new OpensteerError({ code: "not_found", message: "Question not found" });
      if (row.status !== "pending")
        throw new OpensteerError({ code: "conflict", message: "Question is no longer pending" });
      if (row.requestedBy !== input.resolvedBy)
        throw new OpensteerError({
          code: "forbidden",
          message: "Only the person it asked can answer this question.",
        });
      assertRequestRevision(row, input.expectedRevision);
      const pending = requestFromRow(row);
      if (pending.presentation.kind !== "form")
        throw new Error("A person question is presented as a form");
      if (input.response.kind === "form") {
        const problem = requestFormAnswersProblem(
          pending.presentation.fields,
          input.response.answers,
        );
        if (problem !== null) throw new OpensteerError({ code: "bad_request", message: problem });
      }
      await lockActiveDurableRequestAuthority(transaction, pending);
      const now = new Date();
      const resolved = await transaction
        .updateTable("requests")
        .set({
          status: declined ? "declined" : "fulfilled",
          resolvedAt: now,
          resolvedBy: input.resolvedBy,
          response: jsonValue(input.response),
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
        })
        .where("id", "=", row.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(resolved);
      await enqueueContinuation(transaction, request, now);
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return { request: await refreshRequestState(transaction, request.id) };
    });
  }
  async create(
    input: CreateRequestInput,
    transaction?: Transaction<DatabaseSchema>,
  ): Promise<RequestMutation> {
    return commitPersonalMutation(transaction ?? this.#database, (t) =>
      createRequestInTransaction(this.#links, t, input),
    );
  }
  async settlePluginRequest(input: {
    requestId: RequestId;
    expectedRevision?: string;
    resolvedBy: UserId;
    settlementSessionId?: string;
    decision: "fulfilled" | "declined";
  }): Promise<RequestMutation> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (!row || !row.kind.startsWith("plugin."))
        throw new OpensteerError({ code: "not_found", message: "Plugin Request is unavailable." });
      if (row.requestedBy !== input.resolvedBy)
        throw new OpensteerError({
          code: "forbidden",
          message: "Only the person asked may answer this Request.",
        });
      if (row.status !== "pending")
        throw new OpensteerError({
          code: "conflict",
          message: "Plugin Request is no longer pending.",
        });
      if (input.expectedRevision !== undefined) assertRequestRevision(row, input.expectedRevision);
      await lockActiveDurableRequestAuthority(transaction, requestFromRow(row));
      await lockThreadRow(transaction, row.originatingThreadId);
      const now = new Date();
      const resolved = await transaction
        .updateTable("requests")
        .set({
          status: input.decision,
          resolvedAt: now,
          resolvedBy: input.resolvedBy,
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
          response: jsonValue({ kind: "external", value: { decision: input.decision } }),
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(resolved);
      await enqueueContinuation(transaction, request, now);
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return { request: await refreshRequestState(transaction, request.id), replayed: false };
    });
  }
  cancelPluginRequests(
    requestIds: readonly RequestId[],
    reason: RequestCancellationReason,
  ): Promise<readonly RequestId[]> {
    if (!requestIds.length) return Promise.resolve([]);
    return commitPersonalMutation(this.#database, async (tx) => {
      await tx
        .selectFrom("threads")
        .select("id")
        .where(
          "id",
          "in",
          tx
            .selectFrom("requests")
            .select("originatingThreadId")
            .where("id", "in", [...requestIds])
            .where("status", "=", "pending"),
        )
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      return cancelPending(tx, { requestIds, reason, resolvedAt: new Date() });
    });
  }
  async endPluginExecutionRequest(
    requestId: RequestId,
    reason: "plugin-interrupted" | "plugin-expired" | "run-ended",
  ): Promise<readonly RequestId[]> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      // The Personal mutation fence serializes Request settlement. Read the kind
      // under that fence, then write the continuation before locking the Request.
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", requestId)
        .executeTakeFirst();
      if (
        !row ||
        !["plugin.approval", "plugin.input"].includes(row.kind) ||
        row.status === "cancelled" ||
        row.status === "withdrawn"
      )
        return [];
      const now = new Date();
      if (reason === "run-ended")
        await transaction
          .updateTable("requestContinuations")
          .set({
            status: "undeliverable",
            reason: "Plugin execution stopped with its Run",
            updatedAt: now,
          })
          .where("requestId", "=", requestId)
          .execute();
      else
        await transaction
          .insertInto("requestContinuations")
          .values({
            requestId,
            status: "waiting",
            reason: null,
            attemptedAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflict((c) =>
            c.column("requestId").doUpdateSet({
              status: "waiting",
              reason: null,
              attemptedAt: null,
              updatedAt: now,
            }),
          )
          .execute();
      await lockThreadRow(transaction, row.originatingThreadId);
      const updated = await transaction
        .updateTable("requests")
        .set({
          status: "cancelled",
          cancellationReason: reason,
          response: null,
          resolvedBy: null,
          settlementProvenance: null,
          resolvedAt: now,
        })
        .where("id", "=", requestId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(updated);
      await refreshRequestState(transaction, request.id);
      return [request.id];
    });
  }
  async get(id: RequestId): Promise<Request | null> {
    const row = await this.#database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? requestFromRow(row) : null;
  }
  async revision(id: RequestId): Promise<string | null> {
    const row = await this.#database
      .selectFrom("requests")
      .select("revision")
      .where("id", "=", id)
      .executeTakeFirst();
    return row?.revision ?? null;
  }
  /** The Request a call opened, or the one it joined. */
  async findByCallIdentity(
    input: {
      readonly callId: string;
    } & RequestOriginInput,
  ): Promise<Request | null> {
    const row = await this.#database
      .selectFrom("requests")
      .selectAll()
      .where(callIdentityFilter(input))
      .executeTakeFirst();
    if (row) return requestFromRow(row);
    const origin = requestOriginOf(input);
    if (origin.originatingRunId === undefined) return null;
    return joinedRequest(this.#database, origin.originatingRunId, input.callId);
  }
  async originatingPage(input: {
    readonly before?: string;
    readonly limit: number;
    readonly threadId: ThreadId;
  }): Promise<{
    readonly requests: readonly Request[];
    readonly window: DurableWindow;
  }> {
    const limit = clampLimit(input.limit);
    const scope = `originating:${input.threadId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    let query = this.#database
      .selectFrom("requests")
      .selectAll()
      .where("originatingThreadId", "=", input.threadId)
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1);
    if (anchor) {
      query = query.where((expression) =>
        expression.or([
          expression("createdAt", "<", anchor.createdAt),
          expression.and([
            expression("createdAt", "=", anchor.createdAt),
            expression("id", "<", anchor.id),
          ]),
        ]),
      );
    }
    const [rows, count] = await Promise.all([
      query.execute(),
      this.#database
        .selectFrom("requests")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("originatingThreadId", "=", input.threadId)
        .executeTakeFirstOrThrow(),
    ]);
    return requestPage(rows, Number(count.count), limit, scope);
  }
  async referenceForOwner(input: {
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
    readonly requestId: RequestId;
  }): Promise<Request | null> {
    return withPersonalReadTransaction(this.#database, async (transaction) => {
      await requirePersonalOwner(transaction, input.ownerId);
      const row = await transaction
        .selectFrom("requests")
        .innerJoin("threads", "threads.id", "requests.originatingThreadId")
        .selectAll("requests")
        .where("requests.id", "=", input.requestId)
        .where("requests.originatingThreadId", "=", input.threadId)
        .where("threads.createdBy", "=", input.ownerId)
        .executeTakeFirst();
      return row ? requestFromRow(row) : null;
    });
  }

  async originatingPendingPage(input: {
    readonly before?: string;
    readonly limit: number;
    readonly threadId: ThreadId;
  }): Promise<{
    readonly requests: readonly Request[];
    readonly window: DurableWindow;
  }> {
    const limit = clampLimit(input.limit);
    const scope = `originating-pending:${input.threadId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    let query = this.#database
      .selectFrom("requests")
      .selectAll()
      .where("originatingThreadId", "=", input.threadId)
      .where("status", "=", "pending")
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1);
    if (anchor) {
      query = query.where((expression) =>
        expression.or([
          expression("createdAt", "<", anchor.createdAt),
          expression.and([
            expression("createdAt", "=", anchor.createdAt),
            expression("id", "<", anchor.id),
          ]),
        ]),
      );
    }
    const [rows, count] = await Promise.all([
      query.execute(),
      this.#database
        .selectFrom("requests")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("originatingThreadId", "=", input.threadId)
        .where("status", "=", "pending")
        .executeTakeFirstOrThrow(),
    ]);
    return requestPage(rows, Number(count.count), limit, scope);
  }

  async waitingOnUserPage(input: {
    readonly before?: string;
    readonly limit: number;
    readonly userId: UserId;
  }): Promise<{
    readonly requests: readonly WaitingRequest[];
    readonly window: DurableWindow;
    readonly pendingRequestsRevision: string;
  }> {
    const limit = clampLimit(input.limit);
    const scope = `waiting:${input.userId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    return withPersonalReadTransaction(
      this.#database,
      async (transaction) => {
        await requirePersonalOwner(transaction, input.userId);
        // Read first, in this snapshot: the page is at least as new as the revision it reports.
        const { pendingRequestsRevision } = await transaction
          .selectFrom("clientSyncState")
          .select("pendingRequestsRevision")
          .executeTakeFirstOrThrow();
        const addressed = transaction.selectFrom("requests").where("status", "=", "pending");
        let page = addressed
          .selectAll()
          .orderBy("createdAt", "desc")
          .orderBy("id", "desc")
          .limit(limit + 1);
        if (anchor)
          page = page.where((eb) =>
            eb.or([
              eb("createdAt", "<", anchor.createdAt),
              eb.and([eb("createdAt", "=", anchor.createdAt), eb("id", "<", anchor.id)]),
            ]),
          );
        const [rows, count] = await Promise.all([
          page.execute(),
          addressed.select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
        ]);
        const { requests, window } = requestPage(rows, Number(count.count), limit, scope);
        const held = await heldAssignments(
          transaction,
          requests.map(({ id }) => id),
          input.userId,
        );
        const askingNodeIds = requests.flatMap((request) =>
          request.originatingNodeId ? [request.originatingNodeId] : [],
        );
        const askingNodes = new Map(
          (askingNodeIds.length
            ? await transaction
                .selectFrom("executionNodes as node")
                .leftJoin("executionNodes as parent", "parent.id", "node.parentNodeId")
                .select([
                  "node.id",
                  "node.title",
                  "parent.id as parentId",
                  "parent.title as parentTitle",
                ])
                .where("node.id", "in", askingNodeIds)
                .execute()
            : []
          ).map(({ id, title, parentId, parentTitle }) => [
            id,
            {
              id,
              title,
              within: parentId && parentTitle ? { id: parentId, title: parentTitle } : null,
            },
          ]),
        );
        const presented = await waitingRequestPresentations(transaction, requests, held);
        return {
          requests: requests.map((request) => ({
            assignments: held.get(request.id) ?? [],
            presentation: presented.get(request.id) ?? null,
            request: PendingRequestSchema.parse(request),
            subagent: request.originatingNodeId
              ? (askingNodes.get(request.originatingNodeId) ?? null)
              : null,
          })),
          window,
          pendingRequestsRevision,
        };
      },
      "repeatable read",
    );
  }

  /** With `lineageConnectionId`, only Requests from tasks in that connection's lineage. */
  async connectionPage(input: {
    userId: UserId;
    before?: string;
    limit: number;
    lineageConnectionId?: string;
  }) {
    const limit = clampLimit(input.limit);
    const scope = input.lineageConnectionId
      ? `connection:${input.userId}:${input.lineageConnectionId}`
      : `connection:${input.userId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    await requirePersonalOwner(this.#database, input.userId);
    let query = this.#database
      .selectFrom("requests")
      .selectAll("requests")
      .$if(input.lineageConnectionId !== undefined, (builder) =>
        builder.where(({ exists, selectFrom }) =>
          exists(
            selectFrom("threads")
              .select("threads.id")
              .whereRef("threads.id", "=", "requests.originatingThreadId")
              .where("threads.originConnectionId", "=", input.lineageConnectionId!),
          ),
        ),
      );
    const count = await query
      .clearSelect()
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    if (anchor)
      query = query.where((eb) =>
        eb.or([
          eb("createdAt", "<", anchor.createdAt),
          eb.and([eb("createdAt", "=", anchor.createdAt), eb("id", "<", anchor.id)]),
        ]),
      );
    const rows = await query
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1)
      .execute();
    return requestPage(rows, Number(count.count), limit, scope);
  }
  async visiblePage(input: {
    readonly before?: string;
    readonly limit: number;
    readonly originatingThreadId: ThreadId;
  }): Promise<{
    readonly requests: readonly Request[];
    readonly window: DurableWindow;
  }> {
    const limit = clampLimit(input.limit);
    const scope = `visible:${input.originatingThreadId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    return withPersonalReadTransaction(this.#database, async (transaction) => {
      const visible = (builder: ReturnType<typeof transaction.selectFrom<"requests">>) =>
        builder.where("originatingThreadId", "=", input.originatingThreadId);
      let pageQuery = visible(transaction.selectFrom("requests"))
        .selectAll()
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1);
      if (anchor) {
        pageQuery = pageQuery.where((expression) =>
          expression.or([
            expression("createdAt", "<", anchor.createdAt),
            expression.and([
              expression("createdAt", "=", anchor.createdAt),
              expression("id", "<", anchor.id),
            ]),
          ]),
        );
      }
      const [rows, count] = await Promise.all([
        pageQuery.execute(),
        visible(transaction.selectFrom("requests"))
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow(),
      ]);
      return requestPage(rows, Number(count.count), limit, scope);
    });
  }

  async requestComputerAppAccess(
    input: Omit<Parameters<RequestStore["requestDeviceComputerAppAccess"]>[0], "deviceId"> & {
      readonly runnerId: RunnerId;
    },
  ): Promise<ComputerAppAccessDecision> {
    const result = await this.requestDeviceComputerAppAccess({
      ...input,
      deviceId: await requireSelfDeviceId(this.#database, input.runnerId),
    });
    if (result.kind === "computer")
      return {
        ...result,
        setupRequest: await legacySelfSetupRequest(this.#database, result.setupRequest),
      };
    if (result.kind === "approved")
      return {
        ...result,
        connection: await legacySelfConnection(this.#database, result.connection),
      };
    return result;
  }

  async requestDeviceComputerAppAccess(input: {
    readonly reason: string;
    readonly threadTitle: string | null;
    readonly access: IntegrationAccess;
    /** The Mac app the ask names, or null for a phone, whose connection is its display. */
    readonly app: ComputerAppIdentity | null;
    /** Audit correlation for a connection written inline. */
    readonly auditRequestId: string;
    readonly definitionDigest: string;
    readonly definitionId: "android-phone" | "iphone-screen" | "macos-app";
    readonly idempotencyKey?: string;
    readonly originatingOccurrenceId?: TriggerOccurrenceId | null;
    readonly originatingRunId: RunId | null;
    readonly ownerUserId: UserId;
    readonly deviceId: DeviceId;
    readonly threadId: ThreadId;
    /** The tool rows of a connection this ask creates inline. */
    readonly tools: (connectionId: IntegrationConnectionId) => readonly IntegrationToolMaterial[];
  }): Promise<DeviceComputerAppAccessDecision> {
    if ((input.app === null) !== isPhoneDisplayDefinitionId(input.definitionId)) {
      throw new OpensteerError({
        code: "bad_request",
        message: "A Mac app access ask names its app; a phone access ask names none",
      });
    }
    const app = input.app === null ? null : ComputerAppIdentitySchema.parse(input.app);
    const access = IntegrationAccessSchema.parse(input.access);
    const origin =
      input.originatingRunId === null
        ? input.originatingOccurrenceId
          ? ({
              originatingOccurrenceId: input.originatingOccurrenceId,
            } as const)
          : null
        : input.originatingOccurrenceId
          ? null
          : ({
              originatingRunId: input.originatingRunId,
            } as const);
    if (!origin) {
      throw new OpensteerError({
        code: "bad_request",
        message: "A computer app access Request originates from exactly one Run or Occurrence",
      });
    }
    return commitPersonalMutation(this.#database, async (personalTransaction) => {
      await ((transaction) => lockRequestOrigin(transaction, origin))(personalTransaction);
      return (async (transaction) => {
        const runner = await lockComputerApprovalScopeInTransaction(transaction, {
          deviceId: input.deviceId,
        });
        const ownership =
          runner.removedAt === null ? await deviceOwnershipIn(transaction, runner.id) : null;
        if (runner.removedAt !== null) {
          throw new OpensteerError({
            code: "not_found",
            message: "Computer not found",
          });
        }
        // Only the computer's owner can answer its access Requests.
        if (ownership?.effectiveOwner !== input.ownerUserId) {
          throw new OpensteerError({
            code: "forbidden",
            message: `Only the person who added ${runner.name} can approve ${app === null ? "access to it" : "an app on it"}.`,
          });
        }
        const now = new Date();
        const scope = computerAppScopeOf({
          app,
          definitionId: input.definitionId,
          deviceId: input.deviceId,
        });
        // This observation chooses the approval path under the Mac's fence.
        // Each accepting path revalidates it after taking installation/server
        // fences; locking the Connection here would reverse that resource order.
        const current = await transaction
          .selectFrom("integrationConnections")
          .innerJoin(
            "integrationServers",
            "integrationServers.id",
            "integrationConnections.integrationServerId",
          )
          .select([
            "integrationConnections.computerAccess",
            "integrationConnections.computerApp",
            "integrationConnections.computerBlockedAt",
            "integrationConnections.id",
            "integrationConnections.integrationServerId",
            "integrationServers.installationId",
          ])
          .where("integrationConnections.connectionKind", "=", "computer")
          .where(computerConnectionDeviceId, "=", input.deviceId)
          .where("integrationConnections.integrationDefinitionId", "=", input.definitionId)
          // `= null` matches nothing, so a phone's app-less connection is found with `is`.
          .where(
            "integrationConnections.computerAppKey",
            scope.appKey === null ? "is" : "=",
            scope.appKey,
          )
          .where("integrationConnections.status", "!=", "revoked")
          .executeTakeFirst();
        if (current?.computerBlockedAt)
          throw new OpensteerError({
            code: "forbidden",
            message: `${app?.displayName ?? runner.name} is blocked on ${runner.name}. The owner can unblock it from any Opensteer app.`,
          });
        const covered =
          !!current?.computerAccess &&
          computerAppIdentitiesEqual(current.computerApp, app) &&
          integrationAccessCovers(current.computerAccess, access);
        const policy = await computerUsePolicyInTransaction(
          transaction,
          input.deviceId,
          input.ownerUserId,
        );
        // Automatic approval never widens or re-identifies a connection, so an
        // ask it cannot answer is the prompt the ask policy would have shown.
        // It is a Mac's "any app" and never reaches an ask that names no app.
        if (app !== null && policy.appApproval === "automatic" && (!current || covered)) {
          const approved = await approveComputerAppAutomaticallyInTransaction(transaction, {
            access,
            actorUserId: input.ownerUserId,
            app,
            definitionDigest: input.definitionDigest,
            definitionId: input.definitionId,
            requestId: input.auditRequestId,
            runner,
            deviceId: input.deviceId,
            tools: input.tools,
          });
          return {
            connection: approved.connection,
            kind: "approved",
          };
        }
        if (current && covered) {
          const mutation = await createRequestInTransaction(
            this.#links,
            transaction,
            await integrationAccessRequestInput(transaction, {
              ...origin,
              access,
              callId:
                input.idempotencyKey ??
                `computer.app.grant:${input.definitionId}:${input.deviceId}:${scope.appKey ?? ""}:${access}`,
              installationId: current.installationId,
              originatingThreadId: input.threadId,
              reason: input.reason,
              requestedBy: input.ownerUserId,
              requestedConnectionId: current.id,
              requestedServerId: current.integrationServerId,
            }),
          );
          return {
            kind: "personal-grant",
            replayed: mutation.replayed,
            request: mutation.request,
          };
        }
        const { row } = await askForComputerAppApprovalInTransaction(transaction, {
          access,
          app,
          definitionDigest: input.definitionDigest,
          definitionId: input.definitionId,
          now,
          ownerUserId: input.ownerUserId,
          deviceId: input.deviceId,
          task: {
            reason: input.reason,
            threadId: input.threadId,
            threadTitle: input.threadTitle,
          },
        });
        const setupRequest = computerAppSetupRequestFromRow(row);
        const mutation = await createRequestInTransaction(this.#links, transaction, {
          ...origin,
          callId:
            input.idempotencyKey ??
            `computer.app.access:${input.definitionId}:${input.deviceId}:${scope.appKey ?? ""}:${access}`,
          kind: "computer.app.access",
          mode: "durable",
          originatingThreadId: input.threadId,
          payload: {
            access,
            app,
            definitionId: input.definitionId,
            kind: "computer.app.access",
            reason: input.reason,
            deviceId: input.deviceId,
            setupRequestId: setupRequest.id,
          },
          presentation: computerAppAccessPresentation({
            access,
            app,
            reason: input.reason,
            runnerName: runner.name,
            setupRequestId: setupRequest.id,
          }),
          requestedBy: input.ownerUserId,
          // Only the requester owns this computer. Phones are allowed from any
          // Opensteer app; Mac apps are approved on the Mac.
          requiredActor: "requester",
        });
        return {
          kind: "computer",
          replayed: mutation.replayed,
          request: mutation.request,
          setupRequest,
        };
      })(personalTransaction);
    });
  }

  async declineComputerAppAccessRequest(input: {
    readonly actorUserId: UserId;
    readonly settlementSessionId?: string;
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly response?: RequestResponse;
  }): Promise<{
    request: Request;
  }> {
    const response = RequestResponseSchema.parse(
      input.response ?? {
        kind: "external",
        value: {
          decision: "declined",
        },
      },
    );
    const value = response.kind === "external" ? response.value : undefined;
    if (!value || Object.keys(value).length !== 1 || value.decision !== "declined") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Computer app access is approved on that Mac; from here it can only be declined.",
      });
    }
    return commitPersonalMutation(this.#database, async (transaction) => {
      const noLongerPending = () =>
        new OpensteerError({
          code: "conflict",
          message: "Computer app access Request is no longer pending for this requester",
        });
      const named = await transaction
        .selectFrom("requests")
        .select(sql<string>`coalesce(payload->>'deviceId',payload->>'runnerId')`.as("runnerId"))
        .where("id", "=", input.requestId)
        .where("kind", "=", "computer.app.access")
        .executeTakeFirst();
      if (!named) throw noLongerPending();
      await lockComputerApprovalScopeInTransaction(transaction, {
        deviceId: DeviceIdSchema.parse(named.runnerId),
      });
      const observed = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (
        !observed ||
        observed.status !== "pending" ||
        observed.kind !== "computer.app.access" ||
        observed.requestedBy !== input.actorUserId
      ) {
        throw noLongerPending();
      }
      const observedRequest = requestFromRow(observed);
      if (observedRequest.payload.kind !== "computer.app.access") {
        throw new Error("Computer app access Request payload does not match its kind");
      }
      await lockActiveDurableRequestAuthority(transaction, observedRequest);
      await lockRequestThreads(transaction, [observed.originatingThreadId]);
      assertRequestRevision(observed, input.expectedRevision);
      const setupRequestId = observedRequest.payload.setupRequestId;
      // Another Thread may still be waiting on this same approval, and its
      // card is authority to keep the row. Only the last decline takes it.
      const alsoWaiting = await transaction
        .selectFrom("requests")
        .select("id")
        .where("kind", "=", "computer.app.access")
        .where("status", "=", "pending")
        .where("id", "!=", observedRequest.id)
        .where(sql<string>`payload->>'setupRequestId'`, "=", setupRequestId)
        .limit(1)
        .executeTakeFirst();
      const now = new Date();
      if (!alsoWaiting) {
        await transaction
          .deleteFrom("computerAppSetupRequests")
          .where("id", "=", setupRequestId)
          .execute();
      }
      const row = await transaction
        .updateTable("requests")
        .set({
          resolvedAt: now,
          resolvedBy: input.actorUserId,
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.actorUserId,
            input.settlementSessionId,
          ),
          response: jsonValue(response),
          responseCommandId: null,
          status: "declined",
        })
        .where("id", "=", input.requestId)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw new OpensteerError({
          code: "conflict",
          message: "Computer app access Request is no longer pending",
        });
      }
      const request = requestFromRow(row);
      await enqueueContinuation(transaction, request, now);
      await requestSettlementActor(transaction, input.actorUserId, input.settlementSessionId);
      await refreshRequestState(transaction, request.id);
      return {
        request,
      };
    });
  }
  async declineMachineFullDiskAccessRequest(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<{
    request: Request;
  }> {
    // Only "not now" is a person's to say; the grant itself arrives from the
    // machine, so any other external value here is a client that misunderstood.
    const value = input.response.kind === "external" ? input.response.value : undefined;
    const declined =
      value !== undefined && Object.keys(value).length === 1 && value.decision === "declined";
    if (!declined) {
      throw new OpensteerError({
        code: "bad_request",
        message: "macOS Full Disk Access Requests can only be declined by a person",
      });
    }
    return commitPersonalMutation(this.#database, async (transaction) => {
      const observed = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (
        !observed ||
        observed.status !== "pending" ||
        observed.kind !== "machine.full-disk-access" ||
        observed.requestedBy !== input.resolvedBy
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "macOS Full Disk Access Request is no longer pending for this requester",
        });
      }
      assertRequestRevision(observed, input.expectedRevision);
      await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
      await lockRequestThreads(transaction, [observed.originatingThreadId]);
      const now = new Date();
      const row = await transaction
        .updateTable("requests")
        .set({
          status: "declined",
          resolvedAt: now,
          resolvedBy: input.resolvedBy,
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
          response: jsonValue(input.response),
        })
        .where("id", "=", input.requestId)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirst();
      if (!row)
        throw new OpensteerError({
          code: "conflict",
          message: "macOS Full Disk Access Request is no longer pending",
        });
      const request = requestFromRow(row);
      await enqueueContinuation(transaction, request, now);
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      await refreshRequestState(transaction, request.id);
      return {
        request,
      };
    });
  }
  async fulfillMachineFullDiskAccessRequests(machineId: RunnerId): Promise<{
    requests: Request[];
  }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const pending = transaction
        .selectFrom("requests")
        .selectAll()
        .where("kind", "=", "machine.full-disk-access")
        .where("status", "=", "pending")
        .where(sql<string>`payload->>'machineId'`, "=", machineId);
      const parents = await pending
        .clearSelect()
        .select("originatingThreadId")
        .distinct()
        .execute();
      await lockRequestThreads(
        transaction,
        parents.map(({ originatingThreadId }) => originatingThreadId),
      );
      const rows = await pending.orderBy("id").forNoKeyUpdate().execute();
      const requests: Request[] = [];
      for (const row of rows) {
        try {
          await lockActiveDurableRequestAuthority(transaction, requestFromRow(row));
        } catch (error) {
          // Revocation and cancellation own Requests whose origin authority has ended.
          if (error instanceof OpensteerError) continue;
          throw error;
        }
        const now = new Date();
        const resolved = await transaction
          .updateTable("requests")
          .set({
            status: "fulfilled",
            resolvedAt: now,
            resolvedBy: row.requestedBy,
            response: jsonValue({
              kind: "external",
              value: {
                decision: "fulfilled",
              },
            }),
          })
          .where("id", "=", row.id)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirst();
        if (!resolved) continue;
        const request = requestFromRow(resolved);
        await enqueueContinuation(transaction, request, now);
        await refreshRequestState(transaction, request.id);
        requests.push(request);
      }
      return {
        requests,
      };
    });
  }
  async resolveBrowserRequest(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<ResolvedBrowserRequest> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const observed = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (
        !observed ||
        observed.status !== "pending" ||
        observed.requestedBy !== input.resolvedBy ||
        observed.kind !== "browser.access"
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Browser Request is no longer pending",
        });
      }
      const parsedResponse = RequestResponseSchema.parse(input.response);
      const creation =
        parsedResponse.kind === "external" && parsedResponse.value
          ? parseBrowserDecision(parsedResponse.value)
          : undefined;
      const homeRunnerId =
        creation && "createProfile" in creation
          ? creation.createProfile.homeRunnerId === null
            ? null
            : await lockBrowserHomeRunner(
                transaction,
                input.resolvedBy,
                creation.createProfile.homeRunnerId,
              )
          : undefined;
      const observedRequest = requestFromRow(observed);
      if (creation && "profileId" in creation) {
        await transaction
          .selectFrom("browserProfiles")
          .select("id")
          .where("id", "=", creation.profileId)
          .forShare()
          .executeTakeFirst();
      }
      await lockActiveDurableRequestAuthority(transaction, observedRequest);
      await lockRequestThreads(transaction, [observed.originatingThreadId]);
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !row ||
        row.status !== "pending" ||
        row.requestedBy !== input.resolvedBy ||
        row.kind !== "browser.access"
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Browser Request is no longer pending",
        });
      }
      assertRequestRevision(row, input.expectedRevision);
      const request = requestFromRow(row);
      const response = RequestResponseSchema.parse(input.response);
      if (response.kind !== "external" || !response.value) {
        throw new OpensteerError({
          code: "bad_request",
          message: "Browser Request response is invalid",
        });
      }
      const decision = parseBrowserDecision(response.value);
      let profile: ResolvedBrowserRequest["profile"] = null;
      if (decision.decision === "fulfilled") {
        if ("profileId" in decision) {
          profile =
            (await transaction
              .selectFrom("browserProfiles")
              .select(["id", "name", "ownerId", "homeRunnerId"])
              .where("id", "=", decision.profileId)
              .where("ownerId", "=", input.resolvedBy)
              .where("archivedAt", "is", null)
              .executeTakeFirst()) ?? null;
          if (!profile) {
            throw new OpensteerError({
              code: "forbidden",
              message: "Browser Profile is unavailable",
            });
          }
        } else if ("createProfile" in decision && homeRunnerId !== undefined) {
          profile = await insertBrowserProfileOnLockedHome(transaction, {
            name: decision.createProfile.name,
            homeRunnerId,
            ownerId: input.resolvedBy,
          });
        } else {
          throw new OpensteerError({
            code: "bad_request",
            message: "Browser access selection is invalid",
          });
        }
      }
      const storedResponse: RequestResponse = profile
        ? {
            kind: "external",
            value: {
              ...response.value,
              profile: {
                id: profile.id,
                name: profile.name,
              },
            },
          }
        : response;
      const now = new Date();
      const resolvedRow = await transaction
        .updateTable("requests")
        .set({
          resolvedAt: now,
          resolvedBy: input.resolvedBy,
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
          response: jsonValue(storedResponse),
          status: decision.decision === "declined" ? "declined" : "fulfilled",
        })
        .where("id", "=", request.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
      const resolved = requestFromRow(resolvedRow);
      await enqueueContinuation(transaction, resolved, now);
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      await refreshRequestState(transaction, resolved.id);
      return {
        profile,
        request: resolved,
      };
    });
  }

  /** The owner said no: the agent is told not to ask for this site again. */
  async declineBrowserSignInRequest(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
  }): Promise<RequestMutation> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const observed = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (
        observed?.kind === "browser.sign-in" &&
        observed.status === "declined" &&
        observed.requestedBy === input.resolvedBy &&
        observed.resolvedBy === input.resolvedBy
      ) {
        return {
          replayed: true,
          request: requestFromRow(observed),
        };
      }
      if (
        !observed ||
        observed.kind !== "browser.sign-in" ||
        observed.status !== "pending" ||
        observed.requestedBy !== input.resolvedBy
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "The sign-in Request is no longer pending",
        });
      }
      assertRequestRevision(observed, input.expectedRevision);
      await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
      await lockRequestThreads(transaction, [observed.originatingThreadId]);
      const now = new Date();
      const resolvedRow = await transaction
        .updateTable("requests")
        .set({
          status: "declined",
          resolvedAt: now,
          resolvedBy: input.resolvedBy,
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
          response: jsonValue({
            kind: "external",
            value: {
              decision: "declined",
            },
          }),
        })
        .where("id", "=", input.requestId)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirst();
      if (!resolvedRow) {
        throw new OpensteerError({
          code: "conflict",
          message: "The sign-in Request is no longer pending",
        });
      }
      const resolved = requestFromRow(resolvedRow);
      await enqueueContinuation(transaction, resolved, now);
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      await refreshRequestState(transaction, resolved.id);
      return {
        replayed: false,
        request: resolved,
      };
    });
  }

  /** Settles a sign-in Request without a delivery, such as when its session closed. */
  async fulfilBrowserSignInRequest(input: {
    readonly requestId: RequestId;
    readonly ownerId: UserId;
    readonly settlementSessionId?: string;
    readonly response: BrowserSignInRequestResponse;
  }): Promise<{
    readonly request: Request;
  } | null> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const result = await fulfilBrowserSignInRequestInTransaction(transaction, input);
      await requestSettlementActor(transaction, input.ownerId, input.settlementSessionId);
      return result;
    });
  }

  async listDeliverableBrowserSignIns(input: {
    readonly ownerId: UserId;
    readonly sourceId: BrowserSourceId;
    /** The last Request of the previous page. */
    readonly after: RequestId | null;
    readonly limit: number;
  }): Promise<readonly Request[]> {
    let query = this.#database
      .selectFrom("requests")
      .innerJoin("browserSiteGrants", (join) =>
        join
          .onRef("browserSiteGrants.ownerId", "=", "requests.requestedBy")
          .on(sql<boolean>`browser_site_grants.site = requests.payload->>'site'`)
          .on("browserSiteGrants.revokedAt", "is", null),
      )
      .leftJoin("browserSources as preferred", (join) =>
        join
          .onRef("preferred.id", "=", "browserSiteGrants.preferredSourceId")
          .on("preferred.revokedAt", "is", null),
      )
      .selectAll("requests")
      .where("requests.kind", "=", "browser.sign-in")
      .where("requests.status", "=", "pending")
      .where("requests.requestedBy", "=", input.ownerId)
      .where((eb) =>
        eb.or([eb("preferred.id", "=", input.sourceId), eb("preferred.id", "is", null)]),
      );
    if (input.after) {
      query = query.where(
        sql<boolean>`(requests.created_at, requests.id) > (select created_at, id from public.requests where id = ${input.after})`,
      );
    }
    const rows = await query
      .orderBy("requests.createdAt", "asc")
      .orderBy("requests.id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map(requestFromRow);
  }

  async listUngrantedBrowserSignIns(input: {
    readonly ownerId: UserId;
    readonly after: RequestId | null;
    readonly limit: number;
  }): Promise<readonly Request[]> {
    let query = this.#database
      .selectFrom("requests")
      .leftJoin("browserSiteGrants", (join) =>
        join
          .onRef("browserSiteGrants.ownerId", "=", "requests.requestedBy")
          .on(sql<boolean>`browser_site_grants.site = requests.payload->>'site'`)
          .on("browserSiteGrants.revokedAt", "is", null),
      )
      .selectAll("requests")
      .where("requests.kind", "=", "browser.sign-in")
      .where("requests.status", "=", "pending")
      .where("requests.requestedBy", "=", input.ownerId)
      .where("browserSiteGrants.ownerId", "is", null);
    if (input.after) {
      query = query.where(
        sql<boolean>`(requests.created_at, requests.id) > (select created_at, id from public.requests where id = ${input.after})`,
      );
    }
    const rows = await query
      .orderBy("requests.createdAt", "asc")
      .orderBy("requests.id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map(requestFromRow);
  }
  async findPendingBrowserSignIn(input: {
    readonly ownerId: UserId;
    readonly originatingRunId: RunId;
    readonly site: string;
  }): Promise<Request | null> {
    const row = await this.#database
      .selectFrom("requests")
      .selectAll()
      .where("kind", "=", "browser.sign-in")
      .where("status", "=", "pending")
      .where("requestedBy", "=", input.ownerId)
      .where("originatingRunId", "=", input.originatingRunId)
      .where(sql<string>`payload->>'site'`, "=", input.site)
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();
    return row ? requestFromRow(row) : null;
  }

  /** Whether a durable Request from this Run, outside `except`, still waits for someone. */
  async hasPendingDurableRequest(input: {
    readonly except: readonly RequestId[];
    readonly originatingRunId: RunId;
  }): Promise<boolean> {
    let pending = this.#database
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", input.originatingRunId)
      .where("mode", "=", "durable")
      .where("status", "=", "pending");
    if (input.except.length > 0) pending = pending.where("id", "not in", input.except);
    return (await pending.limit(1).executeTakeFirst()) !== undefined;
  }

  /** Current requester authority over a stored durable sign-in, independent of its Run's status. */
  async hasDurablePasswordSignInRequestAuthority(input: {
    readonly ownerId: UserId;
    readonly requestId: RequestId;
    readonly expectedRevision?: string;
  }): Promise<boolean> {
    return withPersonalReadTransaction(this.#database, async (transaction) => {
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (
        !row ||
        (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) ||
        row.kind !== "browser.password-sign-in" ||
        row.status !== "pending" ||
        row.requestedBy !== input.ownerId ||
        row.requiredActor !== "requester"
      )
        return false;
      try {
        await lockActiveDurableRequestAuthority(transaction, requestFromRow(row));
        return true;
      } catch (error) {
        if (error instanceof OpensteerError) return false;
        throw error;
      }
    });
  }

  /** Live authority for an unattended Passwords operation, without creating a Request. */
  async hasActiveRunPasswordSignInAuthority(input: {
    readonly originatingRunId: RunId;
    readonly originatingThreadId: ThreadId;
    readonly requestedBy: UserId;
  }): Promise<boolean> {
    return withPersonalReadTransaction(this.#database, async (transaction) => {
      const origin = await lockRequestOrigin(transaction, input, false);
      if (
        !origin?.running ||
        origin.threadId !== input.originatingThreadId ||
        origin.requestedBy !== input.requestedBy ||
        !(await runHasActiveGrant(transaction, input.originatingRunId))
      )
        return false;
      await requirePersonalOwner(transaction, input.requestedBy);
      return true;
    });
  }

  /** Opens or joins one operation's Request, recording its Run's calls atomically. */
  async openPasswordSignIn(
    input: CreateRequestFields & {
      readonly originatingRunId: RunId;
      readonly joinedCallIds?: readonly string[];
    },
  ): Promise<RequestMutation> {
    const { joinedCallIds, ...fields } = input;
    const payload = input.payload;
    if (input.kind !== "browser.password-sign-in" || payload.kind !== "browser.password-sign-in") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Only a password sign-in can join an open Request",
      });
    }
    return commitPersonalMutation(this.#database, async (personalTransaction) => {
      await ((transaction) => lockRequestOrigin(transaction, input))(personalTransaction);
      return (async (transaction) => {
        const recordJoins = async (mutation: RequestMutation): Promise<RequestMutation> => {
          for (const callId of new Set(joinedCallIds ?? [])) {
            if (callId === mutation.request.callId) continue;
            if (callId.length < 1 || callId.length > 512 || callId.includes("\0"))
              throw new OpensteerError({
                code: "bad_request",
                message: "Request call identity is invalid",
              });
            await transaction
              .insertInto("requestCallJoins")
              .values({
                callId,
                originatingRunId: input.originatingRunId,
                requestId: mutation.request.id,
              })
              .onConflict((conflict) =>
                conflict.columns(["originatingRunId", "callId"]).doNothing(),
              )
              .execute();
          }
          return mutation;
        };
        const joined = await joinedRequest(transaction, input.originatingRunId, input.callId);
        if (joined)
          return recordJoins({
            replayed: true,
            request: joined,
          });
        const own = await transaction
          .selectFrom("requests")
          .select("id")
          .where(callIdentityFilter(input))
          .executeTakeFirst();
        const origin = own ? undefined : await lockRequestOrigin(transaction, input);
        if (
          origin?.running &&
          origin.threadId === input.originatingThreadId &&
          origin.requestedBy === input.requestedBy
        ) {
          const pending = transaction
            .selectFrom("requests")
            .selectAll()
            .where("kind", "=", "browser.password-sign-in")
            .where("status", "=", "pending")
            .where("requestedBy", "=", input.requestedBy)
            .where("originatingRunId", "=", input.originatingRunId)
            .where(sql<string>`payload->>'site'`, "=", payload.site)
            .where(sql<string>`payload->>'operationId'`, "=", payload.operationId);

          // legacy one stays bound to the Browser Session it was asked for.
          const open = await pending
            .where(sql<string>`payload->>'scope'`, "=", "personal")
            .orderBy("createdAt", "asc")
            .orderBy("id", "asc")
            .limit(1)
            .executeTakeFirst();
          if (open) {
            await transaction
              .insertInto("requestCallJoins")
              .values({
                callId: input.callId,
                originatingRunId: input.originatingRunId,
                requestId: open.id,
              })
              .execute();
            return recordJoins({
              replayed: true,
              request: requestFromRow(open),
            });
          }
        }
        // A replay of the opening call, a new Request, or the refusal for a
        // Run that can no longer ask.
        return recordJoins(await createRequestInTransaction(this.#links, transaction, fields));
      })(personalTransaction);
    });
  }

  /** Oldest first; the Host settles these when their sessions cannot answer. */
  async listPendingPasswordSignIns(input: {
    readonly after: RequestId | null;
    readonly limit: number;
  }): Promise<readonly Request[]> {
    let query = this.#database
      .selectFrom("requests")
      .selectAll()
      .where("kind", "=", "browser.password-sign-in")
      .where("status", "=", "pending");
    if (input.after) {
      query = query.where(
        sql<boolean>`(created_at, id) > (select created_at, id from public.requests where id = ${input.after})`,
      );
    }
    const rows = await query
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map(requestFromRow);
  }

  /**
   * Settles a pending password sign-in with what its runtime reported, or with
   * what the Host knows when the runtime cannot answer. Returns null when the
   * Request is no longer pending, or its originating authority is gone and it
   * is being cancelled through that path instead. A broker commit failure may
   * replace an authorized outcome with interruption without changing the saved
   * human decision's provenance or its durable event.
   */
  nextDeadline() {
    return nextPersonalRequestDeadline(this.#database);
  }

  /** Answers how many due sign-in Requests it settled or cancelled. */
  async expirePasswordSignIns(now: Date): Promise<number> {
    const due = await expiredPersonalSignInRequests(this.#database, now);
    // A Request that fails to settle does not end the sweep: the rest still
    // get their turn, and the failures are thrown together at the end.
    const failures: unknown[] = [];
    let settled = 0;
    for (const { id, requestedBy } of due) {
      try {
        const result = await this.settlePasswordSignInRequest({
          requestId: id,
          ownerId: requestedBy,
          settlement: { status: "fulfilled", response: { outcome: "expired" } },
        });
        if (!result)
          await commitPersonalMutation(this.#database, (tx) =>
            cancelPending(tx, {
              requestIds: [id],
              reason: "authority-revoked",
              resolvedAt: now,
            }),
          );
        settled += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Expiring password sign-in Requests failed");
    return settled;
  }

  async settlePasswordSignInRequest(input: {
    readonly ownerId: UserId;
    readonly settlementSessionId?: string;
    readonly requestId: RequestId;
    readonly expectedRevision?: string;
    readonly settlement:
      | {
          readonly status: "declined";
        }
      | {
          readonly status: "fulfilled";
          readonly response: PasswordSignInRequestResponse;
        };
  }): Promise<{
    readonly request: Request;
  } | null> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const eligible = (row: RequestRow | undefined): row is RequestRow =>
        row?.kind === "browser.password-sign-in" &&
        row.requestedBy === input.ownerId &&
        (row.status === "pending" ||
          (input.settlement.status === "fulfilled" &&
            input.settlement.response.outcome === "interrupted" &&
            row.status === "fulfilled" &&
            row.response?.kind === "external" &&
            row.response.value?.outcome === "authorized"));
      const observed = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (!eligible(observed)) return null;
      if (observed.status === "pending") {
        try {
          await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
        } catch (error) {
          if (error instanceof OpensteerError) return null;
          throw error;
        }
      }
      await lockRequestThreads(transaction, [observed.originatingThreadId]);
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!eligible(row)) return null;
      if (input.expectedRevision !== undefined) assertRequestRevision(row, input.expectedRevision);
      if (
        input.settlement.status === "fulfilled" &&
        input.settlement.response.outcome === "authorized" &&
        (row.payload.kind !== "browser.password-sign-in" ||
          Date.parse(row.payload.expiresAt) <= Date.now())
      )
        return null;
      const now = new Date();
      const response =
        input.settlement.status === "declined"
          ? {
              kind: "external" as const,
              value: {
                decision: "declined",
              },
            }
          : RequestResponseSchema.parse({
              kind: "external",
              value: PasswordSignInRequestResponseSchema.parse(input.settlement.response),
            });
      const resolvedRow = await transaction
        .updateTable("requests")
        .set({
          status: input.settlement.status,
          ...(row.status === "pending"
            ? {
                resolvedAt: now,
                resolvedBy: input.ownerId,
                settlementProvenance: await readRequestSettlementProvenance(
                  transaction,
                  input.ownerId,
                  input.settlementSessionId,
                ),
              }
            : {}),
          response: jsonValue(response),
        })
        .where("id", "=", input.requestId)
        .where("status", "=", row.status)
        .returningAll()
        .executeTakeFirstOrThrow();
      const resolved = requestFromRow(resolvedRow);
      await enqueueContinuation(transaction, resolved, now);
      await requestSettlementActor(transaction, input.ownerId, input.settlementSessionId);
      await refreshRequestState(transaction, resolved.id);
      return {
        request: resolved,
      };
    });
  }
  async withdraw(input: {
    readonly requestId: RequestId;
    readonly threadId: ThreadId;
    readonly withdrawnBy: UserId;
  }): Promise<RequestMutation> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      await lockRequestThreads(transaction, [input.threadId]);
      const pending = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!pending) {
        throw new OpensteerError({
          code: "conflict",
          message: "Request is no longer pending",
        });
      }
      if (
        pending.status === "withdrawn" &&
        pending.mode === "durable" &&
        pending.originatingThreadId === input.threadId &&
        pending.requestedBy === input.withdrawnBy &&
        pending.resolvedBy === input.withdrawnBy
      ) {
        return {
          replayed: true,
          request: requestFromRow(pending),
        };
      }
      if (pending.status !== "pending") {
        throw new OpensteerError({
          code: "conflict",
          message: "Request is no longer pending",
        });
      }
      if (pending.mode !== "durable" || pending.originatingThreadId !== input.threadId) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Only the task that opened a pending Request may withdraw it",
        });
      }
      if (pending.requestedBy !== input.withdrawnBy) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Request actor is no longer valid",
        });
      }
      const now = new Date();
      const row = await transaction
        .updateTable("requests")
        .set({
          resolvedAt: now,
          resolvedBy: input.withdrawnBy,
          status: "withdrawn",
        })
        .where("id", "=", pending.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(row);
      await enqueueContinuation(transaction, request, now);
      await refreshRequestState(transaction, request.id);
      return {
        replayed: false,
        request,
      };
    });
  }
  async cancelForRun(
    runId: RunId,
    reason: RequestCancellationReason,
    resolvedAt = new Date(),
  ): Promise<readonly RequestId[]> {
    return commitPersonalMutation(this.#database, (transaction) =>
      cancelPending(transaction, {
        reason,
        resolvedAt,
        runId,
      }),
    );
  }

  /** A person's steers the engine has taken so far: a hold's cutoff, free of any clock. */
  async personSteerCount(runId: RunId): Promise<number> {
    const { count } = await this.#database
      .selectFrom("threadInputs")
      .innerJoin("commands", "commands.id", "threadInputs.steerCommandId")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("commands.runId", "=", runId)
      .where("commands.type", "=", "run.steer")
      .where("threadInputs.deliveredAt", "is not", null)
      .where(sql<string>`thread_inputs.authority_source->>'kind'`, "in", personAuthorities)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
  async holdSnapshot(requestId: RequestId, runId: RunId, steersAtAdmission: number) {
    const row = await this.#database
      .selectFrom("requests")
      .innerJoin("runs", "runs.id", "requests.originatingRunId")
      .selectAll("requests")
      .select(["runs.status as runStatus", "runs.phase as runPhase", "runs.voiceSessionId"])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom("threadInputs")
              .select("threadInputs.messageId")
              .whereRef("threadInputs.threadId", "=", "runs.threadId")
              .where("threadInputs.state", "=", "pending")
              .where("threadInputs.policy", "!=", "report")
              .where(sql<string>`thread_inputs.authority_source->>'kind'`, "in", personAuthorities),
          )
          .as("queued"),
      )
      .where("requests.id", "=", requestId)
      .where("requests.mode", "=", "durable")
      .where("runs.id", "=", runId)
      .executeTakeFirst();
    return row
      ? {
          request: requestFromRow(row),
          run: {
            status: row.runStatus,
            phase: row.runPhase,
            voiceSessionId: row.voiceSessionId,
          },
          steered: (await this.personSteerCount(runId)) > steersAtAdmission,
          queued: row.queued,
        }
      : null;
  }
  async markToolDelivered(
    requestId: RequestId,
    claims: Parameters<typeof assertActiveGrant>[1],
  ): Promise<"delivered" | "already-delivered" | "refused"> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .select(["phase", "voiceSessionId"])
        .where("id", "=", claims.runId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!run || run.phase !== "turn" || run.voiceSessionId !== null) return "refused";
      try {
        await assertActiveGrant(transaction, claims, this.#executionNow);
      } catch (error) {
        if (error instanceof OpensteerError && error.code === "forbidden") return "refused";
        throw error;
      }
      const request = await transaction
        .selectFrom("requests")
        .select("status")
        .where("id", "=", requestId)
        .where("mode", "=", "durable")
        .where("originatingRunId", "=", claims.runId)
        .executeTakeFirst();
      if (!request || request.status === "pending") return "refused";
      const now = new Date(this.#executionNow());
      const updated = await transaction
        .updateTable("requestContinuations")
        .set({
          status: "delivered",
          attemptedAt: now,
          updatedAt: now,
        })
        .where("requestId", "=", requestId)
        .where("status", "=", "waiting")
        .executeTakeFirst();
      if (updated.numUpdatedRows === 1n) return "delivered";
      const existing = await transaction
        .selectFrom("requestContinuations")
        .select("status")
        .where("requestId", "=", requestId)
        .executeTakeFirst();
      if (existing?.status === "delivered") return "already-delivered";
      if (!existing && (request.status === "withdrawn" || request.status === "cancelled"))
        return "delivered";
      return "refused";
    });
  }
  #eligibleContinuations(excludedRuns: ReadonlySet<RunId>) {
    let pending = this.#database
      .selectFrom("requestContinuations")
      .innerJoin("requests", "requests.id", "requestContinuations.requestId")
      .where("requestContinuations.status", "=", "waiting")
      .where((eb) =>
        eb.or([
          eb("requests.originatingRunId", "is", null),
          eb.exists(
            eb
              .selectFrom("runs as originRun")
              .select("originRun.id")
              .whereRef("originRun.id", "=", "requests.originatingRunId")
              .where((origin) =>
                origin.or([
                  origin("originRun.status", "in", ["completed", "failed", "interrupted"]),
                  origin("originRun.phase", "=", "background"),
                  origin("originRun.voiceSessionId", "is not", null),
                ]),
              )
              .where((gate) =>
                gate.or([
                  // A call's Run spans unrelated turns, so its Requests never settle as one batch.
                  gate("originRun.voiceSessionId", "is not", null),
                  // A question the person answered continues the task by itself: the
                  // agent asked it to hear back, not to wait on anything else it asked.
                  sql<boolean>`requests.kind = 'person.question'`,
                  gate.not(
                    gate.exists(
                      gate
                        .selectFrom("requests as sibling")
                        .select("sibling.id")
                        .whereRef("sibling.originatingRunId", "=", "originRun.id")
                        .where("sibling.mode", "=", "durable")
                        .where("sibling.status", "=", "pending"),
                    ),
                  ),
                  gate.exists(
                    gate
                      .selectFrom("runs as newerRun")
                      .select("newerRun.id")
                      .whereRef("newerRun.threadId", "=", "originRun.threadId")
                      .whereRef("newerRun.runOrdinal", ">", "originRun.runOrdinal"),
                  ),
                ]),
              ),
          ),
        ]),
      );
    if (excludedRuns.size) {
      pending = pending.where((eb) =>
        eb.or([
          eb("requests.originatingRunId", "is", null),
          eb("requests.originatingRunId", "not in", [...excludedRuns]),
        ]),
      );
    }
    return pending;
  }

  async nextContinuationDeadline(
    retryMs: number,
    excludedRuns: ReadonlySet<RunId>,
    asOf: Date,
  ): Promise<Date | null> {
    // An unattempted row is due at the time the caller's pass judges by, never
    // at a later read of the clock: "due" then means the same to the listing
    // and to this answer.
    const now = asOf;
    const row = await this.#eligibleContinuations(excludedRuns)
      .select(
        sql<Date>`coalesce(attempted_at + ${retryMs} * interval '1 millisecond', ${now})`.as(
          "deadline",
        ),
      )
      .orderBy("deadline")
      .limit(1)
      .executeTakeFirst();
    return row?.deadline ?? null;
  }

  async listPendingContinuations(
    limit = 100,
    retryBefore?: Date,
    excludedRuns: ReadonlySet<RunId> = new Set(),
  ): Promise<readonly PendingRequestContinuation[]> {
    const pending = this.#eligibleContinuations(excludedRuns)
      .selectAll("requests")
      .select([
        "requestContinuations.attemptedAt as continuationAttemptedAt",
        "requestContinuations.reason as continuationReason",
        "requestContinuations.status as continuationStatus",
      ])
      .orderBy(sql`request_continuations.attempted_at asc nulls first`)
      .orderBy("requestContinuations.createdAt", "asc")
      .orderBy("requests.id", "asc");
    const due = retryBefore
      ? pending.where((eb) =>
          eb.or([
            eb("requestContinuations.attemptedAt", "is", null),
            eb("requestContinuations.attemptedAt", "<=", retryBefore),
          ]),
        )
      : pending;
    const page = await due
      .clearSelect()
      .select(["requests.id", "requests.originatingRunId"])
      .limit(clampLimit(limit))
      .execute();
    if (page.length === 0) return [];
    const runIds = [
      ...new Set(
        page.flatMap(({ originatingRunId }) => (originatingRunId ? [originatingRunId] : [])),
      ),
    ];
    const triggerIds = page
      .filter(({ originatingRunId }) => originatingRunId === null)
      .map(({ id }) => id);
    // A row limit must never split the outcomes delivered for one Run.
    const rows = await pending
      .where((eb) =>
        eb.or([
          ...(runIds.length > 0 ? [eb("requests.originatingRunId", "in", runIds)] : []),
          ...(triggerIds.length > 0 ? [eb("requests.id", "in", triggerIds)] : []),
        ]),
      )
      .execute();
    return rows.map((row) => ({
      attemptedAt: row.continuationAttemptedAt?.toISOString() ?? null,
      reason: row.continuationReason,
      request: requestFromRow(row),
      status: "waiting" as const,
    }));
  }
  async recordContinuationAttempt(input: {
    readonly reason: string | null;
    readonly requestId: RequestId;
    readonly status: "queued" | "undeliverable" | "waiting";
  }): Promise<boolean> {
    if (input.status === "undeliverable" && !input.reason?.trim()) {
      throw new OpensteerError({
        code: "bad_request",
        message: "An undeliverable continuation requires a reason",
      });
    }
    if (input.status !== "undeliverable" && input.reason !== null) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Queued and waiting continuation attempts cannot persist a reason",
      });
    }
    const attemptedAt = new Date();
    const result = await this.#database
      .updateTable("requestContinuations")
      .set({
        attemptedAt,
        reason: input.status === "undeliverable" ? input.reason!.trim().slice(0, 2_000) : null,
        status: input.status,
        updatedAt: attemptedAt,
      })
      .where("requestId", "=", input.requestId)
      .where("status", "=", "waiting")
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}

/** An ordinary `integration.access` Request, which the person can approve from anywhere. */
export async function integrationAccessRequestInput(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: IntegrationAccessRequestInput,
): Promise<CreateRequestInput> {
  const access = IntegrationAccessSchema.parse(input.access);
  const manifest = input.manifest ? IntegrationInstallManifestSchema.parse(input.manifest) : null;
  if ((input.installationId === null) === (manifest === null)) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Integration access must target an installation or install manifest",
    });
  }
  // The approval card must name the integration the agent is asking for. The
  // binding itself is still validated transactionally when the Request is
  // created; this read only supplies the display title.
  const installation = input.installationId
    ? await database
        .selectFrom("integrationInstallations")
        .select(["sourceKind", "title"])
        .where("id", "=", input.installationId)
        .executeTakeFirst()
    : null;
  if (input.installationId && !installation) {
    throw new OpensteerError({
      code: "conflict",
      message: "Integration installation is no longer available",
    });
  }
  const title = installation?.title ?? manifest!.definition.name;
  const summary = manifest ? RequestJsonObjectSchema.parse(manifest) : null;
  return {
    ...requestOriginOf(input),
    callId: input.callId,
    integrationDetail: {
      access,
      installationId: input.installationId,
      manifest,
      requestedConnectionId: input.requestedConnectionId ?? null,
      requestedServerId: input.requestedServerId,
    },
    kind: "integration.access",
    mode: "durable",
    originatingThreadId: input.originatingThreadId,
    payload: {
      access,
      installationId: input.installationId,
      kind: "integration.access",
      manifest: summary,
      reason: input.reason,
      requestedConnectionId: input.requestedConnectionId ?? null,
      requestedServerId: input.requestedServerId,
    },
    presentation: {
      detail: input.reason,
      kind: "external",
      subject: {
        id: input.installationId ?? installManifestSubject(manifest!),
        kind: input.installationId ? "integration-installation" : "integration-install-manifest",
      },
      title: `${title} access`,
    },
    requestedBy: input.requestedBy,
    requiredActor: "requester",
  };
}

export function installManifestSubject(manifest: IntegrationInstallManifest): string {
  return `catalog:${manifest.definition.id}:${manifest.digest}`;
}
export async function validateIntegrationRequestDetail(
  transaction: Transaction<DatabaseSchema>,
  input: CreateRequestInput,
): Promise<void> {
  const detail = input.integrationDetail;
  if (!detail) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Integration Request detail is required",
    });
  }
  if (
    input.kind !== "integration.access" ||
    !detail.access ||
    (detail.installationId === null) === (detail.manifest === null)
  ) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Access Request detail is invalid",
    });
  }
  if (detail.installationId) {
    await lockAndValidateIntegrationAccessResources(transaction, {
      installationId: detail.installationId,
      ownerUserId: input.requestedBy,
      requestedConnectionId: detail.requestedConnectionId,
      requestedServerId: detail.requestedServerId,
    });
  } else {
    if (detail.requestedConnectionId || detail.requestedServerId) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Pre-install access cannot bind an account or server",
      });
    }
    const manifest = IntegrationInstallManifestSchema.parse(detail.manifest);
    if (manifest.kind === "catalog") {
      await lockIntegrationCatalogDefinitionInTransaction(transaction, manifest.definition.id);
    }
  }
}
export async function assertCatalogDefinitionAvailable(
  transaction: Transaction<DatabaseSchema>,
  definitionId: string,
): Promise<void> {
  // Installation takes the same exact-definition lock. The active check and
  // Request insert therefore share one linearized transaction boundary.
  await lockIntegrationCatalogDefinitionInTransaction(transaction, definitionId);
  const installed = await transaction
    .selectFrom("integrationInstallations")
    .select("id")
    .where("sourceKind", "=", "built-in")
    .where("status", "=", "active")
    .where(sql<boolean>`integration_installations.provenance ->> 'definitionId' = ${definitionId}`)
    .executeTakeFirst();
  if (installed) {
    throw new OpensteerError({
      code: "conflict",
      message:
        "Catalog integration is already installed; search current integration inventory before requesting setup",
    });
  }
}
export async function lockAndValidateIntegrationAccessResources(
  transaction: Transaction<DatabaseSchema>,
  detail: {
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly requestedConnectionId: IntegrationConnectionId | null;
    readonly requestedServerId: IntegrationServerId | null;
  },
): Promise<void> {
  const installation = await transaction
    .selectFrom("integrationInstallations")
    .select("id")
    .where("id", "=", detail.installationId)
    .where("status", "=", "active")
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!installation) {
    throw new OpensteerError({
      code: "conflict",
      message: "Integration is inactive",
    });
  }
  if (detail.requestedServerId) {
    const server = await transaction
      .selectFrom("integrationServers")
      .select("id")
      .where("id", "=", detail.requestedServerId)
      .where("installationId", "=", detail.installationId)
      .where("status", "!=", "disabled")
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!server) {
      throw new OpensteerError({
        code: "conflict",
        message: "Integration server is inactive",
      });
    }
  }
  if (detail.requestedConnectionId) {
    const connection = await transaction
      .selectFrom("integrationConnections")
      .select([
        "connectionKind",
        "id",
        "integrationDefinitionId",
        "integrationServerId",
        "provider",
      ])
      .where("id", "=", detail.requestedConnectionId)
      .where("ownerUserId", "=", detail.ownerUserId)
      .where("status", "!=", "revoked")
      .forNoKeyUpdate()
      .executeTakeFirst();
    const servers = connection
      ? await transaction
          .selectFrom("integrationServers")
          .select(["connectionRequirement", "id"])
          .where("installationId", "=", detail.installationId)
          .where("status", "=", "active")
          .$if(detail.requestedServerId !== null, (query) =>
            query.where("id", "=", detail.requestedServerId!),
          )
          .execute()
      : [];
    const compatible = connection
      ? servers.some((server) => {
          const requirement = IntegrationConnectionRequirementSchema.parse(
            server.connectionRequirement,
          );
          return (
            requirement.kind === "computer" &&
            connection.connectionKind === "computer" &&
            connection.integrationServerId === server.id &&
            connection.integrationDefinitionId === requirement.definitionId
          );
        })
      : false;
    if (!compatible) {
      throw new OpensteerError({
        code: "conflict",
        message: "Requested integration account is unavailable",
      });
    }
  }
}

export type IntegrationAccessRequestInput = {
  readonly access: IntegrationAccess;
  readonly callId: string;
  readonly installationId: IntegrationInstallationId | null;
  readonly manifest?: IntegrationInstallManifest | null;
  readonly originatingThreadId: ThreadId;
  readonly reason: string;
  readonly requestedConnectionId?: IntegrationConnectionId | null;
  readonly requestedBy: UserId;
  readonly requestedServerId: IntegrationServerId | null;
} & RequestOriginInput;

/**
 * The one Request-creation path, exposed to the transaction so a caller that
 * must write a Request together with the authority row it names — a computer
 * app's setup request, for instance — commits both or neither.
 */

async function createRequestInTransaction(
  links: ChannelLinks,
  transaction: Transaction<DatabaseSchema>,
  input: CreateRequestInput,
  deviceOnline?: () => boolean,
): Promise<RequestMutation> {
  if (input.callId.length < 1 || input.callId.length > 512 || input.callId.includes("\0")) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Request call identity is invalid",
    });
  }
  const origin = await lockRequestOrigin(transaction, input);
  if (
    !origin ||
    origin.threadId !== input.originatingThreadId ||
    origin.requestedBy !== input.requestedBy
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: originMismatchMessage(input),
    });
  }
  const existing = await transaction
    .selectFrom("requests")
    .selectAll()
    .where(callIdentityFilter(input))
    .executeTakeFirst();
  if (existing) {
    // Replay stays canonical after a Run ends or authority is removed. It
    // still locks both authority scopes before the Request so a concurrent
    // revocation/deletion cannot leave the caller with stale pending state.
    await requirePersonalOwner(transaction, existing.requestedBy);
    const replay = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", existing.id)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    return {
      replayed: true,
      request: requestFromRow(replay),
    };
  }
  if (!origin.running) {
    throw new OpensteerError({
      code: "forbidden",
      message: originMismatchMessage(input),
    });
  }
  // A stopped Run is still running until its Runner winds it down, but may not
  // ask for anything more. Revocation holds the Run, as this caller now does.
  if (origin.runId && !(await runHasActiveGrant(transaction, origin.runId))) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
  }
  await requirePersonalOwner(transaction, input.requestedBy);

  if (input.kind === "device.access") {
    if (
      input.payload.kind !== "device.access" ||
      !deviceOnline ||
      input.mode !== "durable" ||
      input.requiredActor !== "owner" ||
      !input.originatingRunId
    )
      throw new OpensteerError({
        code: "bad_request",
        message: "Use computer_access_request for device access.",
      });
    const payload = input.payload;
    const deviceId = payload.machineId;
    const device = await transaction
      .selectFrom("devices")
      .select("accessPolicy")
      .where("id", "=", deviceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const selfRunnerId = await getDeviceSelfRunnerId(transaction, payload.machineId);
    const runner = selfRunnerId
      ? await transaction
          .selectFrom("runners")
          .select(["allowedModules", "moduleDescriptors", "revokedAt", "kind"])
          .where("id", "=", selfRunnerId)
          .executeTakeFirst()
      : undefined;
    const ownership = await deviceOwnershipIn(transaction, payload.machineId);
    if (
      !device ||
      (runner?.revokedAt !== null && runner !== undefined) ||
      !ownership ||
      !machineIsManagedBy(ownership, input.requestedBy)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Only an owned active computer can receive an access Request.",
      });
    if (!deviceOnline())
      throw new OpensteerError({
        code: "runner_offline",
        reason: "device-offline",
        message: "That computer is offline. Do not request access while it is offline.",
        details: { machineId: payload.machineId, capability: payload.access },
      });
    const duplicate = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("kind", "=", "device.access")
      .where("originatingThreadId", "=", input.originatingThreadId)
      .where("requestedBy", "=", input.requestedBy)
      .where("status", "in", ["pending", "declined"])
      .where(sql<string>`payload->>'machineId'`, "=", payload.machineId)
      .where(sql<string>`payload->>'access'`, "=", payload.access)
      .orderBy("createdAt")
      .orderBy("id")
      .executeTakeFirst();
    if (duplicate) return { replayed: true, request: requestFromRow(duplicate) };
    const state = deviceAccessStates(
      device.accessPolicy,
      runner?.allowedModules ?? ["integrations"],
      runner?.moduleDescriptors ?? { integrations: { platform: "ios" } },
      runner?.kind === "main" && ownership.ownerKind === "deployment",
    )[payload.access];
    if (state !== "disabled")
      throw new OpensteerError({
        code: "conflict",
        reason: state === "enabled" ? "device-access-on" : "device-access-unsupported",
        message:
          state === "enabled"
            ? "That device's access is already on."
            : "That device does not support this capability.",
      });
  }
  if (input.kind === "browser.sign-in") {
    if (input.payload.kind !== "browser.sign-in") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Browser sign-in Request payload is invalid",
      });
    }

    const session = await getBrowserSessionForOwner(
      transaction,
      BrowserSessionIdSchema.parse(input.payload.sessionId),
      input.requestedBy,
    );
    if (!session || (session.state !== "starting" && session.state !== "ready")) {
      throw new OpensteerError({
        code: "conflict",
        message: "The Browser Session is no longer open",
        reason: browserSessionClosedReason,
      });
    }
  }
  if (input.kind === "integration.access") {
    await validateIntegrationRequestDetail(transaction, input);
  }
  await lockRequestThreads(transaction, [input.originatingThreadId]);
  // Occurrence is re-validated against its Trigger's live authority instead.

  if (
    input.originatingRunId &&
    !(await runAssignmentAcceptsRequests(transaction, input.originatingRunId))
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: assignmentClosedToRequestsMessage,
    });
  }
  const integrationDetail = input.integrationDetail;
  if (input.kind === "integration.access" && integrationDetail?.access) {
    // Resource validation locks the installation or catalog-definition
    // identity before this lookup. The multi-column subject cannot be
    // protected by one SQL index because pre-install asks have no
    // installation id yet.
    let duplicateQuery = transaction
      .selectFrom("requests")
      .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
      .selectAll("requests")
      .where("requests.kind", "=", "integration.access")
      .where("requests.status", "=", "pending")
      .where("requests.requestedBy", "=", input.requestedBy)
      .where("integrationRequestDetails.access", "=", integrationDetail.access);
    duplicateQuery =
      integrationDetail.requestedConnectionId === null
        ? duplicateQuery.where("integrationRequestDetails.requestedConnectionId", "is", null)
        : duplicateQuery.where(
            "integrationRequestDetails.requestedConnectionId",
            "=",
            integrationDetail.requestedConnectionId,
          );
    duplicateQuery =
      integrationDetail.requestedServerId === null
        ? duplicateQuery.where("integrationRequestDetails.requestedServerId", "is", null)
        : duplicateQuery.where(
            "integrationRequestDetails.requestedServerId",
            "=",
            integrationDetail.requestedServerId,
          );
    duplicateQuery = integrationDetail.installationId
      ? duplicateQuery.where(
          "integrationRequestDetails.installationId",
          "=",
          integrationDetail.installationId,
        )
      : duplicateQuery
          .where("integrationRequestDetails.installationId", "is", null)
          .where(
            sql<boolean>`integration_request_details.manifest = ${JSON.stringify(integrationDetail.manifest)}::jsonb`,
          );
    const duplicate = await duplicateQuery
      .orderBy("requests.createdAt", "asc")
      .orderBy("requests.id", "asc")
      .limit(1)
      .executeTakeFirst();
    if (duplicate) {
      return {
        replayed: true,
        request: requestFromRow(duplicate),
      };
    }
  }
  if (input.kind === "person.question") {
    // Asking the same thing again while it waits is the same question, whatever
    // Run asks it, so a background pass that wakes twice raises one card.
    const duplicate = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("kind", "=", "person.question")
      .where("status", "=", "pending")
      .where("requestedBy", "=", input.requestedBy)
      .where("originatingThreadId", "=", input.originatingThreadId)
      .where(
        sql<boolean>`presentation = ${JSON.stringify(RequestPresentationSchema.parse(input.presentation))}::jsonb`,
      )
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();
    if (duplicate) return { replayed: true, request: requestFromRow(duplicate) };
  }
  if (input.payload.kind === "computer.app.access") {
    // The same ask for the same app is the same card, whatever call identity
    // the Run gave it: the app, the computer and the access are the whole
    // subject, and the setup request they all name is unique per app already.
    // A phone's ask names no app, so its subject is the phone itself.
    const { app } = input.payload;
    const duplicate = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("kind", "=", "computer.app.access")
      .where("status", "=", "pending")
      .where("requestedBy", "=", input.requestedBy)
      .where("originatingThreadId", "=", input.originatingThreadId)
      .where(sql<string>`payload->>'definitionId'`, "=", input.payload.definitionId)
      .where(
        sql<string>`coalesce(payload->>'deviceId',payload->>'runnerId')`,
        "=",
        input.payload.deviceId,
      )
      .where(
        app === null
          ? sql<boolean>`payload->'app' = 'null'::jsonb`
          : sql<boolean>`lower(payload->'app'->>'bundleId') = ${app.bundleId.toLowerCase()}`,
      )
      .where(sql<string>`payload->>'access'`, "=", input.payload.access)
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();
    if (duplicate) {
      return {
        replayed: true,
        request: requestFromRow(duplicate),
      };
    }
  }
  const { integrationDetail: _integrationDetail, ...requestInput } = input;
  const request = PendingRequestSchema.parse({
    ...requestInput,
    cancellationReason: null,
    createdAt: new Date().toISOString(),
    id: createId("request"),
    originatingOccurrenceId: input.originatingOccurrenceId ?? null,
    originatingWatchActivationId: input.originatingWatchActivationId ?? null,
    originatingRunId: input.originatingRunId ?? null,
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  });
  const inserted = await transaction
    .insertInto("requests")
    .values(requestInsert(request))
    // Call identity is unique per origin through a partial index, so the
    // conflict target has to name that index's predicate too.
    .onConflict((conflict) =>
      input.originatingWatchActivationId !== undefined
        ? conflict
            .columns(["originatingWatchActivationId", "callId"])
            .where("originatingWatchActivationId", "is not", null)
            .doNothing()
        : input.originatingRunId === undefined
          ? conflict
              .columns(["originatingOccurrenceId", "callId"])
              .where("originatingOccurrenceId", "is not", null)
              .doNothing()
          : conflict
              .columns(["originatingRunId", "callId"])
              .where("originatingRunId", "is not", null)
              .doNothing(),
    )
    .returningAll()
    .executeTakeFirst();
  if (!inserted) {
    const replay = await transaction
      .selectFrom("requests")
      .selectAll()
      .where(callIdentityFilter(input))
      .executeTakeFirstOrThrow();
    return {
      replayed: true,
      request: requestFromRow(replay),
    };
  }
  if (input.integrationDetail) {
    await insertIntegrationDetail(transaction, inserted.id, input.integrationDetail);
  }
  const canonical = requestFromRow(inserted);
  if (canonical.mode === "durable" && canonical.originatingRunId) {
    const run = await transaction
      .selectFrom("runs")
      .select("replyTarget")
      .where("id", "=", canonical.originatingRunId)
      .executeTakeFirstOrThrow();
    // One notice covers a Run's open asks: they all wait in the same Thread.
    const sibling = await transaction
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", canonical.originatingRunId)
      .where("mode", "=", "durable")
      .where("status", "=", "pending")
      .where("id", "!=", canonical.id)
      .executeTakeFirst();
    if (run.replyTarget?.kind === "channel" && !sibling) {
      const target = run.replyTarget;
      await enqueueChannelConversationStatus(transaction, {
        conversationId: target.conversationId,
        text: `The agent has asked for your input. Open the Thread in Opensteer: ${links.threadUrl(canonical.originatingThreadId)}`,
      });
    }
  }
  return { replayed: false, request: await refreshRequestState(transaction, canonical.id) };
}

export async function insertIntegrationDetail(
  transaction: Transaction<DatabaseSchema>,
  requestId: RequestId,
  detail: IntegrationRequestDetailInput,
): Promise<void> {
  await transaction
    .insertInto("integrationRequestDetails")
    .values({
      access: detail.access,
      installationId: detail.installationId,
      manifest: detail.manifest ? jsonValue(detail.manifest) : null,
      requestId,
      requestedConnectionId: detail.requestedConnectionId,
      requestedServerId: detail.requestedServerId,
    })
    .executeTakeFirstOrThrow();
}
type BrowserSignInRequestScope = {
  readonly settlementSessionId?: string;
  readonly requestId: RequestId;
  readonly ownerId: UserId;
  readonly expectedRevision?: string;
  readonly scope?: {
    readonly sessionId: string;
    readonly site: string;
  };
};
function pendingBrowserSignInMatches(
  row: RequestRow | undefined,
  input: BrowserSignInRequestScope,
): row is RequestRow {
  if (
    !row ||
    (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) ||
    row.kind !== "browser.sign-in" ||
    row.status !== "pending" ||
    row.requestedBy !== input.ownerId
  ) {
    return false;
  }
  if (!input.scope) return true;
  const payload = requestFromRow(row).payload;
  return (
    payload.kind === "browser.sign-in" &&
    payload.site === input.scope.site &&
    payload.sessionId === input.scope.sessionId
  );
}

/**
 * Whether a sign-in Request could be fulfilled now for exactly this scope:
 * still pending and its originating authority still active. Checked
 * immediately before a sign-in reaches the browser, so a declined or orphaned
 * Request never signs anything in.
 */
export async function browserSignInRequestDeliverableInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: BrowserSignInRequestScope,
): Promise<boolean> {
  const row = await transaction
    .selectFrom("requests")
    .selectAll()
    .where("id", "=", input.requestId)
    .executeTakeFirst();
  if (!pendingBrowserSignInMatches(row, input)) return false;
  try {
    await lockActiveDurableRequestAuthority(transaction, requestFromRow(row));
  } catch (error) {
    if (error instanceof OpensteerError) return false;
    throw error;
  }
  const current = await transaction
    .selectFrom("requests")
    .selectAll()
    .where("id", "=", input.requestId)
    .forShare()
    .executeTakeFirst();
  return pendingBrowserSignInMatches(current, input);
}

/**
 * Resolves a pending `browser.sign-in` Request in the caller's transaction, so
 * the receipt of a delivered sign-in and the Request it answers commit together.
 * Returns null when the Request is no longer pending for exactly this scope:
 * the sign-in already happened, so the caller still records it.
 * The caller fences the accepting session after its remaining domain writes.
 */
export async function fulfilBrowserSignInRequestInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: BrowserSignInRequestScope & {
    readonly response: BrowserSignInRequestResponse;
  },
): Promise<{
  readonly request: Request;
} | null> {
  const matches = (row: RequestRow | undefined): row is RequestRow =>
    pendingBrowserSignInMatches(row, input);
  const observed = await transaction
    .selectFrom("requests")
    .selectAll()
    .where("id", "=", input.requestId)
    .executeTakeFirst();
  if (!matches(observed)) return null;
  await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
  await lockRequestThreads(transaction, [observed.originatingThreadId]);
  const row = await transaction
    .selectFrom("requests")
    .selectAll()
    .where("id", "=", input.requestId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!matches(row)) return null;
  const now = new Date();
  const response = RequestResponseSchema.parse({
    kind: "external",
    value: BrowserSignInRequestResponseSchema.parse(input.response),
  });
  const resolvedRow = await transaction
    .updateTable("requests")
    .set({
      status: "fulfilled",
      resolvedAt: now,
      resolvedBy: input.ownerId,
      settlementProvenance: await readRequestSettlementProvenance(
        transaction,
        input.ownerId,
        input.settlementSessionId,
      ),
      response: jsonValue(response),
    })
    .where("id", "=", input.requestId)
    .where("status", "=", "pending")
    .returningAll()
    .executeTakeFirstOrThrow();
  const resolved = requestFromRow(resolvedRow);
  await enqueueContinuation(transaction, resolved, now);
  await refreshRequestState(transaction, resolved.id);
  return {
    request: resolved,
  };
}
export async function enqueueContinuation(
  transaction: Transaction<DatabaseSchema>,
  request: Request,
  createdAt: Date,
): Promise<void> {
  if (
    request.mode !== "durable" ||
    (request.status !== "fulfilled" && request.status !== "declined")
  ) {
    return;
  }
  await transaction
    .insertInto("requestContinuations")
    .values({
      attemptedAt: null,
      createdAt,
      reason: null,
      requestId: request.id,
      status: "waiting",
      updatedAt: createdAt,
    })
    .onConflict((conflict) => conflict.column("requestId").doNothing())
    .execute();
}
type BrowserDecision =
  | {
      readonly decision: "declined";
    }
  | {
      readonly decision: "fulfilled";
      readonly profileId: BrowserProfileId;
    }
  | {
      readonly createProfile: {
        readonly name: string;
        readonly homeRunnerId?: RunnerId | null;
      };
      readonly decision: "fulfilled";
    }
  | {
      readonly decision: "fulfilled";
      readonly name: string;
    };
function parseBrowserDecision(value: Readonly<Record<string, unknown>>): BrowserDecision {
  if (value.decision === "declined" && Object.keys(value).length === 1) {
    return {
      decision: "declined",
    };
  }
  if (value.decision !== "fulfilled") {
    throw new OpensteerError({
      code: "bad_request",
      message: "Browser Request decision is invalid",
    });
  }
  if (typeof value.profileId === "string" && Object.keys(value).length === 2) {
    return {
      decision: "fulfilled",
      profileId: BrowserProfileIdSchema.parse(value.profileId),
    };
  }
  if (typeof value.name === "string" && Object.keys(value).length === 2) {
    return {
      decision: "fulfilled",
      name: boundedProfileName(value.name),
    };
  }
  if (
    value.createProfile &&
    typeof value.createProfile === "object" &&
    !Array.isArray(value.createProfile) &&
    Object.keys(value).length === 2
  ) {
    const profile = value.createProfile as Readonly<Record<string, unknown>>;
    if (
      typeof profile.name === "string" &&
      Object.keys(profile).every((key) => key === "name" || key === "homeRunnerId")
    ) {
      return {
        createProfile: {
          name: boundedProfileName(profile.name),
          ...(profile.homeRunnerId === undefined
            ? {}
            : {
                homeRunnerId: RunnerIdSchema.nullable().parse(profile.homeRunnerId),
              }),
        },
        decision: "fulfilled",
      };
    }
  }
  throw new OpensteerError({
    code: "bad_request",
    message: "Browser Request decision is invalid",
  });
}
function boundedProfileName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Browser Profile name is invalid",
    });
  }
  return name;
}
type RequestOriginSelector = {
  readonly originatingOccurrenceId?: TriggerOccurrenceId | null;
  readonly originatingWatchActivationId?: TriggerWatchActivationId | null | undefined;
  readonly originatingRunId?: RunId | null;
};

/** Narrows an origin-carrying input back to the exclusive pair `create` takes. */
export function requestOriginOf(input: RequestOriginSelector): RequestOriginInput {
  if (input.originatingRunId != null)
    return {
      originatingRunId: input.originatingRunId,
    };
  if (input.originatingOccurrenceId != null) {
    return {
      originatingOccurrenceId: input.originatingOccurrenceId,
    };
  }
  if (input.originatingWatchActivationId != null)
    return { originatingWatchActivationId: input.originatingWatchActivationId };
  throw new OpensteerError({
    code: "bad_request",
    message: "A Request must originate from a Run or an automation occurrence",
  });
}

/** The one call-identity predicate, resolved against whichever origin is set. */
async function joinedRequest(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  originatingRunId: RunId,
  callId: string,
): Promise<Request | null> {
  const row = await database
    .selectFrom("requestCallJoins")
    .innerJoin("requests", "requests.id", "requestCallJoins.requestId")
    .selectAll("requests")
    .where("requestCallJoins.originatingRunId", "=", originatingRunId)
    .where("requestCallJoins.callId", "=", callId)
    .executeTakeFirst();
  return row ? requestFromRow(row) : null;
}
function callIdentityFilter(
  input: {
    readonly callId: string;
  } & RequestOriginSelector,
) {
  const origin = requestOriginOf(input);
  return (expression: ExpressionBuilder<DatabaseSchema, "requests">) =>
    expression.and([
      expression("callId", "=", input.callId),
      origin.originatingWatchActivationId !== undefined
        ? expression("originatingWatchActivationId", "=", origin.originatingWatchActivationId)
        : origin.originatingRunId === undefined
          ? expression("originatingOccurrenceId", "=", origin.originatingOccurrenceId)
          : expression("originatingRunId", "=", origin.originatingRunId),
    ]);
}
function originMismatchMessage(input: RequestOriginSelector): string {
  return input.originatingRunId != null
    ? "Request origin does not match its signed Run authority"
    : "Request origin does not match its signed Trigger Occurrence authority";
}
type LockedRequestOrigin = {
  readonly environmentId: DatabaseSchema["runs"]["environmentId"];
  /** Present only for a Run, which signs the generation into its authority. */

  readonly requestedBy: UserId;
  readonly running: boolean;
  readonly runId: RunId | null;
  readonly threadId: ThreadId;
};
async function lockRequestOrigin(
  transaction: Transaction<DatabaseSchema>,
  input: RequestOriginSelector,
  lock = true,
): Promise<LockedRequestOrigin | undefined> {
  const origin = requestOriginOf(input);
  if (origin.originatingWatchActivationId !== undefined) {
    if (lock) {
      const parent = await transaction
        .selectFrom("triggerWatchActivations")
        .select("anchorThreadId")
        .where("id", "=", origin.originatingWatchActivationId)
        .executeTakeFirst();
      if (parent) await lockRequestThreads(transaction, [parent.anchorThreadId]);
    }
    const watch = await transaction
      .selectFrom("triggerWatchActivations")
      .selectAll()
      .where("id", "=", origin.originatingWatchActivationId)
      .$if(lock, (q) => q.forNoKeyUpdate())
      .executeTakeFirst();
    return watch
      ? {
          environmentId: watch.environmentId,
          requestedBy: watch.createdBy,
          runId: null,
          running: watch.desired === "active" && watch.observed === "running",
          threadId: watch.anchorThreadId,
        }
      : undefined;
  }
  if (origin.originatingRunId === undefined) {
    const occurrence = await transaction
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .select([
        "triggerOccurrences.environmentId",
        "triggerOccurrences.status",
        "triggers.anchorThreadId",
        "triggers.createdBy",
      ])
      .where("triggerOccurrences.id", "=", origin.originatingOccurrenceId)
      .$if(lock, (query) => query.forNoKeyUpdate("triggerOccurrences"))
      .executeTakeFirst();
    if (!occurrence) return undefined;
    return {
      environmentId: occurrence.environmentId,
      requestedBy: occurrence.createdBy,
      runId: null,
      running: occurrence.status === "running",
      threadId: occurrence.anchorThreadId,
    };
  }
  const run = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select(["runs.environmentId", "runs.id", "runs.requestedBy", "runs.status", "runs.threadId"])
    .where("runs.id", "=", origin.originatingRunId)
    .$if(lock, (query) => query.forNoKeyUpdate("runs"))
    .executeTakeFirst();
  if (!run) return undefined;
  return {
    environmentId: run.environmentId,
    requestedBy: run.requestedBy,
    runId: run.id,
    running: run.status === "running",
    threadId: run.threadId,
  };
}
export async function lockActiveDurableRequestAuthority(
  transaction: Transaction<DatabaseSchema>,
  request: Request,
): Promise<void> {
  if (request.mode !== "durable") {
    throw new OpensteerError({
      code: "conflict",
      message: "Request is not durable",
    });
  }
  // Durable answers validate immutable origin fields; they do not depend on Run status.

  const origin = await lockRequestOrigin(transaction, request, false);
  if (
    !origin ||
    origin.threadId !== request.originatingThreadId ||
    origin.requestedBy !== request.requestedBy
  ) {
    throw new OpensteerError({
      code: "conflict",
      message:
        request.originatingRunId === null
          ? "Request origin no longer matches its signed Trigger Occurrence authority"
          : "Request origin no longer matches its signed Run authority",
    });
  }
  await requirePersonalOwner(transaction, request.requestedBy);
}
function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Request page limit must be an integer from 1 through 500",
    });
  }
  return limit;
}

function encodeRequestCursor(createdAt: string, id: RequestId, scope: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id, scope }), "utf8").toString("base64url");
}

function decodeRequestCursor(
  cursor: string,
  scope: string,
): { readonly createdAt: Date; readonly id: RequestId } {
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error("invalid");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (value.scope !== scope || typeof value.createdAt !== "string") {
      throw new Error("scope");
    }
    const createdAt = new Date(value.createdAt);
    if (Number.isNaN(createdAt.valueOf())) throw new Error("date");
    return { createdAt, id: RequestIdSchema.parse(value.id) };
  } catch {
    throw new OpensteerError({ code: "bad_request", message: "Request page cursor is invalid" });
  }
}

/** Each Request's held work, innermost first, cut where the reader could not open a link. */
async function heldAssignments(
  transaction: Transaction<DatabaseSchema>,
  requestIds: readonly RequestId[],
  userId: UserId,
): Promise<ReadonlyMap<RequestId, HeldAssignment[]>> {
  if (requestIds.length === 0) return new Map();
  const links = await sql<{
    readonly assignmentId: string;
    readonly depth: number;
    readonly parentThreadId: string;
    readonly readable: boolean;
    readonly requestId: string;
    readonly workerThreadId: string;
    readonly workerTitle: string;
  }>`
    with recursive chain as (
      select requests.id as request_id, held.id as assignment_id,
        held.parent_assignment_id, held.parent_thread_id, held.child_thread_id, 0 as depth
      from public.requests
      join public.runs on runs.id = requests.originating_run_id
      join public.delegations as held on held.id = runs.assignment_id
      where requests.id in (${sql.join(requestIds)})
      union all
      select chain.request_id, held.id, held.parent_assignment_id, held.parent_thread_id,
        held.child_thread_id, chain.depth + 1
      from chain
      join public.delegations as held on held.id = chain.parent_assignment_id
    )
    select chain.request_id as "requestId", chain.assignment_id as "assignmentId",
      chain.parent_thread_id as "parentThreadId", chain.child_thread_id as "workerThreadId",
      chain.depth, worker.title as "workerTitle",
      exists (select 1 from public.personal_settings settings join public.users owner on owner.id = settings.owner_id
        where settings.owner_id = ${userId} and owner.disabled_at is null) as readable
    from chain
    join public.threads as worker on worker.id = chain.child_thread_id
    join public.threads as parent on parent.id = chain.parent_thread_id
    order by chain.request_id, chain.depth
  `.execute(transaction);
  const held = new Map<RequestId, HeldAssignment[]>();
  const cut = new Set<string>();
  for (const link of links.rows) {
    const requestId = RequestIdSchema.parse(link.requestId);
    if (cut.has(requestId)) continue;
    if (!link.readable) {
      cut.add(requestId);
      continue;
    }
    const chain = held.get(requestId) ?? [];
    chain.push({
      id: AssignmentIdSchema.parse(link.assignmentId),
      parentThreadId: ThreadIdSchema.parse(link.parentThreadId),
      workerThread: { id: ThreadIdSchema.parse(link.workerThreadId), title: link.workerTitle },
    });
    held.set(requestId, chain);
  }
  return held;
}

/**
 * Where a Request asked outside any listed task shows: the nearest listed task
 * above the work it holds up, through the task linked under that one. A
 * monitor running in its own task, or work it handed out, asks there.
 */
type WaitingRequestPresentation = NonNullable<WaitingRequest["presentation"]>;
async function waitingRequestPresentations(
  transaction: Transaction<DatabaseSchema>,
  requests: readonly Pick<Request, "id" | "originatingThreadId">[],
  held: ReadonlyMap<RequestId, readonly HeldAssignment[]>,
): Promise<ReadonlyMap<RequestId, WaitingRequestPresentation>> {
  const outermost = new Map(
    requests.map((request) => [
      request.id,
      held.get(request.id)?.at(-1)?.parentThreadId ?? request.originatingThreadId,
    ]),
  );
  const presented = new Map<RequestId, WaitingRequestPresentation>();
  if (outermost.size === 0) return presented;
  const unlisted = new Set(
    (
      await transaction
        .selectFrom("threads")
        .select("id")
        .where("id", "in", [...new Set(outermost.values())])
        .where("listed", "=", false)
        .where("parentThreadId", "is not", null)
        .execute()
    ).map(({ id }) => id),
  );
  const places = new Map<
    ThreadId,
    { readonly threadId: ThreadId; readonly via: ThreadId } | null
  >();
  for (const threadId of unlisted) {
    const found = await nearestListedThread(transaction, threadId);
    places.set(threadId, found?.via ? { threadId: found.threadId, via: found.via } : null);
  }
  const vias = [...places.values()].flatMap((place) => (place ? [place.via] : []));
  const titles = new Map(
    (vias.length
      ? await transaction
          .selectFrom("threads")
          .select(["id", "title"])
          .where("id", "in", vias)
          .execute()
      : []
    ).map((row) => [row.id, row.title]),
  );
  for (const [requestId, threadId] of outermost) {
    const place = places.get(threadId);
    const title = place ? titles.get(place.via) : undefined;
    if (place && title !== undefined)
      presented.set(requestId, {
        threadId: place.threadId,
        workerThread: { id: place.via, title },
      });
  }
  return presented;
}

function requestPage(
  rows: readonly RequestRow[],
  totalItems: number,
  limit: number,
  scope: string,
): { readonly requests: readonly Request[]; readonly window: DurableWindow } {
  const requests = rows.slice(0, limit).map(requestFromRow);
  const hasMore = rows.length > limit;
  const oldest = requests.at(-1);
  return {
    requests,
    window: {
      byteCount: Buffer.byteLength(JSON.stringify(requests)),
      hasMore,
      itemCount: requests.length,
      nextBefore:
        hasMore && oldest ? encodeRequestCursor(oldest.createdAt, oldest.id, scope) : null,
      totalItems,
    },
  };
}

export async function fulfillDeviceAccessRequestsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  machineId: DeviceId,
  policy: MachineAccessPolicy,
): Promise<readonly RequestId[]> {
  const access = deviceAccess(policy);
  const ownership = await deviceOwnershipIn(transaction, machineId);
  const rows = await transaction
    .selectFrom("requests")
    .selectAll()
    .where("kind", "=", "device.access")
    .where("status", "=", "pending")
    .where(sql<string>`payload->>'machineId'`, "=", machineId)
    .orderBy("id")
    .execute();
  await lockRequestThreads(
    transaction,
    rows.map(({ originatingThreadId }) => originatingThreadId),
  );
  const settled: RequestId[] = [];
  for (const row of rows) {
    const request = requestFromRow(row);
    if (request.payload.kind !== "device.access") throw new Error("Device access payload mismatch");
    let authorized = ownership !== null && machineIsManagedBy(ownership, request.requestedBy);
    try {
      await lockActiveDurableRequestAuthority(transaction, request);
    } catch (error) {
      if (!(error instanceof OpensteerError)) throw error;
      authorized = false;
    }
    if (!authorized) {
      settled.push(
        ...(await cancelPending(transaction, {
          requestIds: [request.id],
          reason: "authority-revoked",
          resolvedAt: new Date(),
        })),
      );
      continue;
    }
    if (!access[request.payload.access]) continue;
    const now = new Date();
    const resolved = await transaction
      .updateTable("requests")
      .set({
        status: "fulfilled",
        resolvedAt: now,
        resolvedBy: request.requestedBy,
        response: jsonValue({ kind: "external", value: { decision: "fulfilled" } }),
      })
      .where("id", "=", request.id)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    if (!resolved) continue;
    const fulfilled = requestFromRow(resolved);
    await enqueueContinuation(transaction, fulfilled, now);
    await refreshRequestState(transaction, fulfilled.id);
    settled.push(fulfilled.id);
  }
  return settled;
}
