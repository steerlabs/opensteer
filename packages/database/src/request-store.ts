import { runHasActiveGrant } from "./run-grants.js";
import { withDatabaseTransaction } from "./connection.js";
import { isDeepStrictEqual } from "node:util";
import {
  OpensteerError,
  BrowserProfileIdSchema,
  PendingRequestSchema,
  RequestIdSchema,
  RequestJsonObjectSchema,
  RequestResponseSchema,
  RunnerIdSchema,
  createId,
  type AgentEvent,
  type BrowserProfileGrantId,
  type BrowserProfileId,
  type BrowserSourceId,
  type PendingRequest,
  type Request,
  type RequestCancellationReason,
  type RequestId,
  type RequestPayload,
  type RequestPresentation,
  type RequestResponse,
  type RequestRequiredActor,
  type RunId,
  type RunnerId,
  type ThreadId,
  type TriggerOccurrenceId,
  type UserId,
  type WaitingRequest,
  type WorkspaceId,
  type HeldAssignment,
  AssignmentIdSchema,
  ThreadIdSchema,
  browserSessionClosedReason,
} from "@opensteer/core";
import {
  BrowserSessionIdSchema,
  PasswordSignInRequestResponseSchema,
  type DurableWindow,
  type PasswordSignInRequestResponse,
} from "@opensteer/protocol";
import {
  BrowserSignInRequestResponseSchema,
  type BrowserSignInRequestResponse,
} from "@opensteer/protocol/browser-sources";
import {
  ComputerAppIdentitySchema,
  computerAppIdentitiesEqual,
  integrationAccessCovers,
  IntegrationConnectionIdSchema,
  IntegrationConnectionRequirementSchema,
  IntegrationAccessSchema,
  IntegrationInstallManifestSchema,
  IntegrationInstallationSchema,
  integrationInstallManifestSummary,
  integrationProposalName,
  type ComputerAppIdentity,
  type ComputerAppSetupRequest,
  type IntegrationConnectionSummary,
  type IntegrationToolMaterial,
  type IntegrationConnectionId,
  type IntegrationAccess,
  type IntegrationGrant,
  type IntegrationInstallManifest,
  type IntegrationInstallationId,
  type IntegrationProviderAuthorization,
  type IntegrationServerId,
} from "@opensteer/integration-core";
import { sql, type ExpressionBuilder, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import {
  IntegrationGrantStore,
  approveComputerAppAutomaticallyInTransaction,
  installIntegrationInTransaction,
  lockIntegrationCatalogDefinitionInTransaction,
  lockIntegrationInstallationIdentityInTransaction,
  type InstallIntegrationInput,
  type InstallIntegrationMutation,
} from "./integration-platform-stores.js";
import {
  computerAppAccessPresentation,
  computerAppScopeOf,
  computerAppSetupRequestFromRow,
} from "./computer-app-setup.js";
import {
  askForComputerAppApprovalInTransaction,
  computerUsePolicyInTransaction,
  lockComputerApprovalScopeInTransaction,
  discoverComputerRequestWorkspaces,
} from "./computer-app-approvals.js";
import { machineOwnershipIn } from "./machine-ownership.js";
import { cancelPending } from "./request-cancellation.js";
import {
  discoverRequestWorkspaces,
  discoverInstallationRequestWorkspaces,
  lockRequestWorkspaces,
  withRequestWorkspaceLocks,
} from "./request-workspace-locks.js";
import {
  assignmentActivityEventsForRun,
  assignmentClosedToRequestsMessage,
  runAssignmentAcceptsRequests,
} from "./assignment-store.js";
import { requestFromRow, requestInsert, requestOriginEnvironment } from "./request-persistence.js";
import { jsonValue, safeGeneration } from "./store-primitives.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";

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
  | { readonly originatingOccurrenceId?: never; readonly originatingRunId: RunId }
  | { readonly originatingOccurrenceId: TriggerOccurrenceId; readonly originatingRunId?: never };

interface CreateRequestFields {
  readonly callId: string;
  readonly kind: PendingRequest["kind"];
  readonly mode: PendingRequest["mode"];
  readonly originatingThreadId: ThreadId;
  readonly originatingWorkspaceId: WorkspaceId;
  readonly payload: RequestPayload;
  readonly presentation: RequestPresentation;
  readonly requestedBy: UserId;
  readonly requiredActor: RequestRequiredActor;
  readonly targetWorkspaceId: WorkspaceId;
  readonly integrationDetail?: IntegrationRequestDetailInput;
}

export type CreateRequestInput = CreateRequestFields & RequestOriginInput;

/** What one task's ask for an app on a Mac came to. */
export type ComputerAppAccessDecision =
  | {
      readonly connection: IntegrationConnectionSummary;
      readonly kind: "approved";
      readonly requestEvents: readonly AgentEvent[];
    }
  | {
      readonly kind: "workspace-grant";
      readonly replayed: boolean;
      readonly request: Request;
      readonly requestEvents: readonly AgentEvent[];
    }
  | {
      /** The ask waits on the computer itself: the Mac's panel, or the phone in its owner's hand. */
      readonly kind: "computer";
      readonly replayed: boolean;
      readonly request: Request;
      readonly requestEvents: readonly AgentEvent[];
      readonly setupRequest: ComputerAppSetupRequest;
    };

/**
 * What makes two integration Requests the same ask: the resource an access
 * Request would grant, or the exact artifact an installation Request would
 * install.
 */
type IntegrationRequestSubject =
  | { readonly definitionId: string; readonly kind: "integration.install" }
  | { readonly kind: "integration.install"; readonly proposalDigest: string };

export interface RequestMutation {
  readonly events: readonly AgentEvent[];
  readonly replayed: boolean;
  readonly request: Request;
}

export interface PreparedBrowserProfile {
  readonly ciphertext: Uint8Array;
  readonly ciphertextSha256: string;
  readonly id: BrowserProfileId;
  readonly name: string;
  readonly revision: 1;
}

export interface ResolvedBrowserRequest {
  readonly events: readonly AgentEvent[];
  readonly grant: {
    readonly access: "full-control";
    readonly createdAt: Date;
    readonly grantId: BrowserProfileGrantId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  } | null;
  readonly profile: {
    readonly id: BrowserProfileId;
    readonly name: string;
    readonly ownerId: UserId;
    readonly revision: number;
  } | null;
  readonly request: Request;
  readonly saveSessionId: string | null;
}

interface PendingRequestContinuation {
  readonly attemptedAt: string | null;
  readonly reason: string | null;
  readonly request: Request;
  readonly status: "waiting" | "queued" | "undeliverable";
}

interface PendingIntegrationAccessRequest {
  readonly access: IntegrationAccess;
  readonly installationId: IntegrationInstallationId;
  readonly request: Request;
  readonly requestedConnectionId: IntegrationConnectionId | null;
  readonly requestedServerId: IntegrationServerId | null;
}

interface ResolvedIntegrationAccessRequest {
  readonly events: readonly AgentEvent[];
  readonly grant: IntegrationGrant | null;
  readonly request: Request;
}

interface ResolvedIntegrationInstallRequest {
  readonly events: readonly AgentEvent[];
  readonly installation: InstallIntegrationMutation["installation"] | null;
  readonly request: Request;
  readonly requestEvents: readonly AgentEvent[];
}

interface BoundIntegrationAccessInstallation {
  readonly installation: InstallIntegrationMutation["installation"];
  readonly request: Request;
  readonly requestEvents: readonly AgentEvent[];
}

interface SelectedIntegrationAccessServer {
  readonly events: readonly AgentEvent[];
  readonly request: Request;
}

/**
 * Material prepared outside the resolution transaction, bound to the exact
 * private manifest the administrator approved. The installation manifest is
 * a public metadata projection and must not be used as this authority proof.
 */
export interface PreparedIntegrationInstallFulfillment {
  readonly approvalManifest: IntegrationInstallManifest;
  readonly material: Omit<InstallIntegrationInput, "actorUserId" | "requestId">;
}

/**
 * Persistence for the single Request lifecycle. Kind-specific authority
 * changes remain explicit callers of this store, but creation, visibility,
 * replay, withdrawal, cancellation, and continuation bookkeeping do not fork.
 */
export class RequestStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
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
  async #pendingTriggerEquivalent(
    input: RequestOriginInput & {
      readonly requestedBy: UserId;
      readonly targetWorkspaceId: WorkspaceId;
    },
    subject: IntegrationRequestSubject,
  ): Promise<RequestMutation | null> {
    if (input.originatingOccurrenceId === undefined) return null;
    const row = await this.#database
      .selectFrom("requests")
      .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
      .selectAll("requests")
      .where("requests.kind", "=", subject.kind)
      .where("requests.status", "=", "pending")
      .where("requests.requestedBy", "=", input.requestedBy)
      .where("requests.targetWorkspaceId", "=", input.targetWorkspaceId)
      .where((expression) => integrationSubjectFilter(expression, subject))
      .orderBy("requests.createdAt", "asc")
      .orderBy("requests.id", "asc")
      .limit(1)
      .executeTakeFirst();
    return row ? { events: [], replayed: true, request: requestFromRow(row) } : null;
  }

  async create(input: CreateRequestInput): Promise<RequestMutation> {
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => {
        const replay = await transaction
          .selectFrom("requests")
          .select(["originatingWorkspaceId", "targetWorkspaceId"])
          .where(callIdentityFilter(input))
          .executeTakeFirst();
        return [
          input.originatingWorkspaceId,
          input.targetWorkspaceId,
          ...(replay ? [replay.originatingWorkspaceId, replay.targetWorkspaceId] : []),
        ];
      },
      (transaction) => createRequestInTransaction(transaction, input),
      async (transaction) => {
        await lockRequestOrigin(transaction, input);
        if (
          input.kind === "browser.profile.save" &&
          input.payload.kind === "browser.profile.save"
        ) {
          const existing = await transaction
            .selectFrom("requests")
            .select("id")
            .where(callIdentityFilter(input))
            .executeTakeFirst();
          if (!existing)
            await lockSavableBrowserSession(
              transaction,
              BrowserSessionIdSchema.parse(input.payload.sessionId),
              input.requestedBy,
            );
        }
      },
    );
  }

  async createIntegrationInstallRequest(
    input: {
      readonly callId: string;
      readonly manifest: IntegrationInstallManifest;
      readonly originatingThreadId: ThreadId;
      readonly originatingWorkspaceId: WorkspaceId;
      readonly reason: string;
      readonly requestedBy: UserId;
      readonly targetWorkspaceId: WorkspaceId;
    } & RequestOriginInput,
  ): Promise<RequestMutation> {
    const manifest = IntegrationInstallManifestSchema.parse(input.manifest);
    const equivalent = await this.#pendingTriggerEquivalent(input, {
      kind: "integration.install",
      ...(manifest.kind === "catalog"
        ? { definitionId: manifest.definition.id }
        : { proposalDigest: manifest.proposal.digest }),
    });
    if (equivalent) return equivalent;
    return this.create({
      ...requestOriginOf(input),
      callId: input.callId,
      integrationDetail: {
        access: null,
        installationId: null,
        manifest,
        requestedConnectionId: null,
        requestedServerId: null,
      },
      kind: "integration.install",
      mode: "durable",
      originatingThreadId: input.originatingThreadId,
      originatingWorkspaceId: input.originatingWorkspaceId,
      payload: {
        kind: "integration.install",
        manifest: RequestJsonObjectSchema.parse(integrationInstallManifestSummary(manifest)),
        reason: input.reason,
      },
      presentation: {
        ...(manifest.kind === "proposal" ? { agentProposed: true } : {}),
        detail: input.reason,
        kind: "choice",
        options: [
          { hint: "reject-once", id: "declined", label: "Not now" },
          { hint: "confirm", id: "installed", label: "Install" },
        ],
        risk: "high",
        title: `Install ${integrationInstallDisplayName(manifest)}?`,
      },
      requestedBy: input.requestedBy,
      requiredActor: "administrator",
      targetWorkspaceId: input.targetWorkspaceId,
    });
  }

  async createIntegrationAccessRequest(
    input: IntegrationAccessRequestInput,
  ): Promise<RequestMutation> {
    return this.create(await integrationAccessRequestInput(this.#database, input));
  }

  async resolveIntegrationAccessRequest(input: {
    readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }): Promise<ResolvedIntegrationAccessRequest> {
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => {
        const request = await transaction
          .selectFrom("requests")
          .select(["targetWorkspaceId", "originatingWorkspaceId"])
          .where("id", "=", input.requestId)
          .executeTakeFirst();
        return request
          ? [
              request.originatingWorkspaceId,
              request.targetWorkspaceId,
              ...(await discoverRequestWorkspaces(transaction, {
                workspaceId: request.targetWorkspaceId,
                pending: true,
                kinds: ["integration.access"],
              })),
            ]
          : [];
      },
      async (transaction) => {
        const observed = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .selectAll("requests")
          .select([
            "integrationRequestDetails.access as detailAccess",
            "integrationRequestDetails.installationId as detailInstallationId",
            "integrationRequestDetails.requestedConnectionId as detailRequestedConnectionId",
            "integrationRequestDetails.requestedServerId as detailRequestedServerId",
          ])
          .where("requests.id", "=", input.requestId)
          .executeTakeFirst();
        if (
          !observed ||
          observed.kind !== "integration.access" ||
          observed.status !== "pending" ||
          observed.requestedBy !== input.resolvedBy ||
          !observed.detailAccess
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Integration Request is no longer pending",
          });
        }
        const observedRequest = requestFromRow(observed);
        await lockActiveDurableRequestAuthority(transaction, observedRequest);
        const response = withoutClientIntegrationAccount(
          RequestResponseSchema.parse(input.response),
        );
        const mainTarget =
          (await transaction
            .selectFrom("workspaces")
            .select("id")
            .where("id", "=", observedRequest.targetWorkspaceId)
            .where("createdBy", "=", input.resolvedBy)
            .where("kind", "=", "main")
            .executeTakeFirst()) !== undefined;
        const decision = parseIntegrationAccessDecision(response, mainTarget);
        if (observed.detailInstallationId === null) {
          if (decision.decision !== "declined") {
            throw new OpensteerError({
              code: "conflict",
              message: "Install the reviewed integration before granting access",
            });
          }
          const pending = await transaction
            .selectFrom("requests")
            .innerJoin(
              "integrationRequestDetails",
              "integrationRequestDetails.requestId",
              "requests.id",
            )
            .selectAll("requests")
            .select("integrationRequestDetails.installationId as detailInstallationId")
            .where("requests.id", "=", input.requestId)
            .forNoKeyUpdate("requests")
            .executeTakeFirst();
          if (
            !pending ||
            pending.kind !== "integration.access" ||
            pending.status !== "pending" ||
            pending.requestedBy !== input.resolvedBy ||
            pending.detailInstallationId !== null
          ) {
            throw new OpensteerError({
              code: "conflict",
              message: "Integration Request is no longer pending",
            });
          }
          const now = new Date();
          const declinedRow = await transaction
            .updateTable("requests")
            .set({
              resolvedAt: now,
              resolvedBy: input.resolvedBy,
              response: jsonValue(response),
              status: "declined",
            })
            .where("id", "=", input.requestId)
            .where("status", "=", "pending")
            .returningAll()
            .executeTakeFirstOrThrow();
          const declined = requestFromRow(declinedRow);
          await enqueueContinuation(transaction, declined, now);
          return {
            events: await terminalEvents(transaction, declined),
            grant: null,
            request: declined,
          };
        }
        if (decision.decision === "fulfilled") {
          await lockAndValidateIntegrationAccessResources(transaction, {
            installationId: observed.detailInstallationId,
            ownerUserId: input.resolvedBy,
            requestedConnectionId: observed.detailRequestedConnectionId,
            requestedServerId: observed.detailRequestedServerId,
          });
        }
        const row = {
          ...observed,
          detailInstallationId: observed.detailInstallationId,
          detailAccess: observed.detailAccess,
        };
        const request = requestFromRow(row);
        if (
          decision.decision === "fulfilled" &&
          row.detailRequestedConnectionId !== null &&
          decision.connectionId !== row.detailRequestedConnectionId
        ) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Integration access requires the requested account",
          });
        }
        if (
          decision.decision === "fulfilled" &&
          "access" in decision &&
          row.detailAccess === "read-write" &&
          decision.access !== "read-write"
        ) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Integration access does not cover the requested write operations",
          });
        }
        if (decision.decision === "fulfilled" && row.detailRequestedServerId === null) {
          const activeServers = await transaction
            .selectFrom("integrationServers")
            .select("id")
            .where("installationId", "=", row.detailInstallationId)
            .where("status", "!=", "disabled")
            .limit(2)
            .execute();
          if (activeServers.length > 1) {
            throw new OpensteerError({
              code: "conflict",
              message: "Choose the integration server before granting access",
            });
          }
        }
        if (decision.decision === "fulfilled" && decision.connectionId !== null) {
          await validateIntegrationAccessFulfillmentConnection(transaction, {
            connectionId: decision.connectionId,
            installationId: row.detailInstallationId,
            ownerUserId: input.resolvedBy,
            providerAuthorizations: input.providerAuthorizations,
            requestedAccess: row.detailAccess,
            requestedServerId: row.detailRequestedServerId,
          });
        }
        let grant: IntegrationGrant | null = null;
        if (decision.decision === "fulfilled" && mainTarget) {
          await assertMainIntegrationAccessUsable(transaction, {
            connectionId: decision.connectionId,
            installationId: row.detailInstallationId,
            ownerUserId: input.resolvedBy,
            providerAuthorizations: input.providerAuthorizations,
            requestedServerId: row.detailRequestedServerId,
          });
        }
        if (decision.decision === "fulfilled" && !mainTarget) {
          if (!("alias" in decision)) throw new Error("Specialized access decision has no grant");
          grant = await createIntegrationGrantForRequest(transaction, {
            ...decision,
            installationId: row.detailInstallationId,
            ownerUserId: input.resolvedBy,
            providerAuthorizations: input.providerAuthorizations,
            requestedServerId: row.detailRequestedServerId,
            workspaceId: request.targetWorkspaceId,
          });
        }
        // Resource and grant fences precede Request projection; a changed discovery
        // rolls back the grant together with the answer under the Workspace fence.
        await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .select("requests.id")
          .where("requests.kind", "=", "integration.access")
          .where("requests.status", "=", "pending")
          .where("requests.requestedBy", "=", input.resolvedBy)
          .where("requests.targetWorkspaceId", "=", request.targetWorkspaceId)
          .where("integrationRequestDetails.installationId", "=", row.detailInstallationId)
          .orderBy("requests.id", "asc")
          .forNoKeyUpdate("requests")
          .execute();
        const lockedRequest = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .selectAll("requests")
          .select([
            "integrationRequestDetails.access as detailAccess",
            "integrationRequestDetails.installationId as detailInstallationId",
            "integrationRequestDetails.requestedConnectionId as detailRequestedConnectionId",
            "integrationRequestDetails.requestedServerId as detailRequestedServerId",
          ])
          .where("requests.id", "=", input.requestId)
          .forNoKeyUpdate("requests")
          .executeTakeFirst();
        if (
          !lockedRequest ||
          lockedRequest.kind !== "integration.access" ||
          lockedRequest.status !== "pending" ||
          lockedRequest.requestedBy !== input.resolvedBy ||
          !lockedRequest.detailInstallationId ||
          !lockedRequest.detailAccess ||
          lockedRequest.detailInstallationId !== observed.detailInstallationId ||
          lockedRequest.detailRequestedConnectionId !== observed.detailRequestedConnectionId ||
          lockedRequest.detailRequestedServerId !== observed.detailRequestedServerId ||
          lockedRequest.detailAccess !== observed.detailAccess
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Integration Request is no longer pending",
          });
        }
        const persistedResponse =
          decision.decision === "fulfilled" && decision.connectionId
            ? await withAuthoritativeIntegrationAccount(
                transaction,
                response,
                decision.connectionId,
                input.resolvedBy,
              )
            : response;
        const now = new Date();
        const resolvedRow = await transaction
          .updateTable("requests")
          .set({
            resolvedAt: now,
            resolvedBy: input.resolvedBy,
            response: jsonValue(persistedResponse),
            status: decision.decision === "fulfilled" ? "fulfilled" : "declined",
          })
          .where("id", "=", request.id)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();
        const resolved = requestFromRow(resolvedRow);
        await enqueueContinuation(transaction, resolved, now);
        const grantedAccess =
          decision.decision === "fulfilled" && "access" in decision
            ? decision.access
            : row.detailAccess;
        const coveredEvents: AgentEvent[] = [];
        if (decision.decision === "fulfilled" && grantedAccess === "read-write") {
          const covered = await transaction
            .selectFrom("requests")
            .innerJoin(
              "integrationRequestDetails",
              "integrationRequestDetails.requestId",
              "requests.id",
            )
            .selectAll("requests")
            .where("requests.id", "!=", resolved.id)
            .where("requests.kind", "=", "integration.access")
            .where("requests.status", "=", "pending")
            .where("requests.requestedBy", "=", input.resolvedBy)
            .where("requests.targetWorkspaceId", "=", request.targetWorkspaceId)
            .where("integrationRequestDetails.installationId", "=", row.detailInstallationId)
            .where("integrationRequestDetails.access", "=", "read")
            .where(
              "integrationRequestDetails.requestedConnectionId",
              row.detailRequestedConnectionId === null ? "is" : "=",
              row.detailRequestedConnectionId,
            )
            .where(
              "integrationRequestDetails.requestedServerId",
              row.detailRequestedServerId === null ? "is" : "=",
              row.detailRequestedServerId,
            )
            .forNoKeyUpdate("requests")
            .execute();
          for (const pending of covered) {
            const coveredRow = await transaction
              .updateTable("requests")
              .set({
                resolvedAt: now,
                resolvedBy: input.resolvedBy,
                response: jsonValue(persistedResponse),
                responseCommandId: null,
                status: "fulfilled",
              })
              .where("id", "=", pending.id)
              .where("status", "=", "pending")
              .returningAll()
              .executeTakeFirst();
            if (!coveredRow) continue;
            const coveredRequest = requestFromRow(coveredRow);
            await enqueueContinuation(transaction, coveredRequest, now);
            coveredEvents.push(...(await terminalEvents(transaction, coveredRequest)));
          }
        }
        return {
          events: [...coveredEvents, ...(await terminalEvents(transaction, resolved))],
          grant,
          request: resolved,
        };
      },
    );
  }

  async resolveIntegrationInstallRequest(input: {
    readonly preparedFulfillment?: PreparedIntegrationInstallFulfillment;
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }): Promise<ResolvedIntegrationInstallRequest> {
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => [
        ...(await discoverRequestWorkspaces(transaction, { requestId: input.requestId })),
        ...(input.preparedFulfillment
          ? await discoverInstallationRequestWorkspaces(
              transaction,
              input.preparedFulfillment.material.installation,
            )
          : []),
      ],
      async (transaction) => {
        const observed = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .selectAll("requests")
          .select("integrationRequestDetails.manifest as detailManifest")
          .where("requests.id", "=", input.requestId)
          .executeTakeFirst();
        if (
          !observed ||
          observed.kind !== "integration.install" ||
          observed.status !== "pending" ||
          !observed.detailManifest
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Installation Request is no longer pending",
          });
        }
        const observedRequest = requestFromRow(observed);
        await lockActiveDurableRequestAuthority(transaction, observedRequest);
        const response = RequestResponseSchema.parse(input.response);
        if (response.kind !== "choice" || !["installed", "declined"].includes(response.optionId)) {
          throw new OpensteerError({
            code: "bad_request",
            message: "Installation decision is invalid",
          });
        }
        const fulfilled = response.optionId === "installed";
        if (fulfilled !== (input.preparedFulfillment !== undefined)) {
          throw new OpensteerError({
            code: "bad_request",
            message: fulfilled
              ? "Installation fulfillment requires prepared installation material"
              : "A declined installation cannot carry installation material",
          });
        }
        if (input.preparedFulfillment) {
          await lockIntegrationInstallationIdentityInTransaction(
            transaction,
            input.preparedFulfillment.material.installation,
          );
        }
        const row = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .selectAll("requests")
          .select("integrationRequestDetails.manifest as detailManifest")
          .where("requests.id", "=", input.requestId)
          .forNoKeyUpdate("requests")
          .executeTakeFirst();
        if (
          !row ||
          row.kind !== "integration.install" ||
          row.status !== "pending" ||
          !row.detailManifest
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Installation Request is no longer pending",
          });
        }
        const administrator = await transaction
          .selectFrom("users")
          .select("instanceRole")
          .where("id", "=", input.resolvedBy)
          .executeTakeFirst();
        if (administrator?.instanceRole !== "administrator") {
          throw new OpensteerError({
            code: "forbidden",
            message: "Only an administrator may install integrations",
          });
        }
        if (
          input.preparedFulfillment &&
          !isDeepStrictEqual(
            IntegrationInstallManifestSchema.parse(row.detailManifest),
            IntegrationInstallManifestSchema.parse(input.preparedFulfillment.approvalManifest),
          )
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Prepared installation does not match the approved manifest",
          });
        }
        const installationMutation = input.preparedFulfillment
          ? await installIntegrationInTransaction(transaction, {
              ...input.preparedFulfillment.material,
              actorUserId: input.resolvedBy,
              requestId: input.requestId,
            })
          : null;
        const now = new Date();
        const resolvedRow = await transaction
          .updateTable("requests")
          .set({
            resolvedAt: now,
            resolvedBy: input.resolvedBy,
            response: jsonValue(response),
            status: fulfilled ? "fulfilled" : "declined",
          })
          .where("id", "=", input.requestId)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();
        const request = requestFromRow(resolvedRow);
        await enqueueContinuation(transaction, request, now);
        return {
          events: await terminalEvents(transaction, request),
          installation: installationMutation?.installation ?? null,
          request,
          requestEvents: installationMutation?.requestEvents ?? [],
        };
      },
    );
  }

  async loadIntegrationInstallManifest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
  }): Promise<IntegrationInstallManifest> {
    const row = await this.#database
      .selectFrom("requests")
      .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
      .innerJoin("users", (join) => join.on("users.id", "=", input.resolvedBy))
      .select("integrationRequestDetails.manifest")
      .where("requests.id", "=", input.requestId)
      .where("requests.kind", "=", "integration.install")
      .where("requests.status", "=", "pending")
      .where("users.instanceRole", "=", "administrator")
      .executeTakeFirst();
    if (!row?.manifest) {
      throw new OpensteerError({
        code: "conflict",
        message: "Installation Request is unavailable or administrator authority is required",
      });
    }
    return IntegrationInstallManifestSchema.parse(row.manifest);
  }

  async loadIntegrationAccessInstallManifest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
  }): Promise<IntegrationInstallManifest> {
    const row = await this.#database
      .selectFrom("requests")
      .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
      .innerJoin("users", (join) => join.on("users.id", "=", input.resolvedBy))
      .select([
        "integrationRequestDetails.installationId",
        "integrationRequestDetails.manifest",
        "users.instanceRole",
      ])
      .where("requests.id", "=", input.requestId)
      .where("requests.kind", "=", "integration.access")
      .where("requests.status", "=", "pending")
      .executeTakeFirst();
    if (!row?.manifest || row.installationId !== null || row.instanceRole !== "administrator") {
      throw new OpensteerError({
        code: "conflict",
        message: "Integration access installation is unavailable",
      });
    }
    return IntegrationInstallManifestSchema.parse(row.manifest);
  }

  async tryBindExistingIntegrationAccessInstallation(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
  }): Promise<BoundIntegrationAccessInstallation | null> {
    return withRequestWorkspaceLocks(
      this.#database,
      (transaction) => discoverRequestWorkspaces(transaction, { requestId: input.requestId }),
      async (transaction) => {
        const observed = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .selectAll("requests")
          .select([
            "integrationRequestDetails.installationId as detailInstallationId",
            "integrationRequestDetails.manifest as detailManifest",
          ])
          .where("requests.id", "=", input.requestId)
          .executeTakeFirst();
        if (
          !observed ||
          observed.kind !== "integration.access" ||
          observed.status !== "pending" ||
          observed.detailInstallationId !== null ||
          !observed.detailManifest
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Integration access installation is no longer pending",
          });
        }
        await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
        const actor = await transaction
          .selectFrom("users")
          .select("instanceRole")
          .where("id", "=", input.resolvedBy)
          .executeTakeFirst();
        if (observed.requestedBy !== input.resolvedBy && actor?.instanceRole !== "administrator") {
          throw new OpensteerError({
            code: "forbidden",
            message: "Only the requester or an administrator may continue this installation",
          });
        }
        const manifest = IntegrationInstallManifestSchema.parse(observed.detailManifest);
        const candidates = await transaction
          .selectFrom("integrationInstallations")
          .selectAll()
          .where("status", "=", "active")
          .where("sourceKind", "=", manifest.kind === "catalog" ? "built-in" : "proposed")
          .where(
            manifest.kind === "catalog"
              ? sql<boolean>`integration_installations.provenance ->> 'definitionId' = ${manifest.definition.id}`
              : sql<boolean>`integration_installations.provenance ->> 'artifactDigest' = ${manifest.proposal.digest}`,
          )
          .execute();
        const candidate = candidates.find((row) =>
          installedIntegrationMatchesReviewedManifest(row, manifest),
        );
        if (!candidate) return null;
        await lockIntegrationInstallationIdentityInTransaction(transaction, candidate);
        const current = await transaction
          .selectFrom("integrationInstallations")
          .selectAll()
          .where("id", "=", candidate.id)
          .where("status", "=", "active")
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!current || !installedIntegrationMatchesReviewedManifest(current, manifest))
          return null;
        return bindIntegrationAccessInstallation(transaction, {
          installation: integrationInstallationFromRequestRow(current),
          requestEvents: [],
          requestId: input.requestId,
        });
      },
    );
  }

  async installForIntegrationAccessRequest(input: {
    readonly preparedFulfillment: PreparedIntegrationInstallFulfillment;
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
  }): Promise<BoundIntegrationAccessInstallation> {
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => [
        ...(await discoverRequestWorkspaces(transaction, { requestId: input.requestId })),
        ...(input.preparedFulfillment
          ? await discoverInstallationRequestWorkspaces(
              transaction,
              input.preparedFulfillment.material.installation,
            )
          : []),
      ],
      async (transaction) => {
        const observed = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .selectAll("requests")
          .select([
            "integrationRequestDetails.installationId as detailInstallationId",
            "integrationRequestDetails.manifest as detailManifest",
          ])
          .where("requests.id", "=", input.requestId)
          .executeTakeFirst();
        if (
          !observed ||
          observed.kind !== "integration.access" ||
          observed.status !== "pending" ||
          observed.detailInstallationId !== null ||
          !observed.detailManifest
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Integration access installation is no longer pending",
          });
        }
        if (
          !isDeepStrictEqual(
            IntegrationInstallManifestSchema.parse(observed.detailManifest),
            IntegrationInstallManifestSchema.parse(input.preparedFulfillment.approvalManifest),
          )
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Prepared installation does not match the reviewed manifest",
          });
        }
        await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
        await lockIntegrationInstallationIdentityInTransaction(
          transaction,
          input.preparedFulfillment.material.installation,
        );
        const row = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .selectAll("requests")
          .select([
            "integrationRequestDetails.installationId as detailInstallationId",
            "integrationRequestDetails.manifest as detailManifest",
          ])
          .where("requests.id", "=", input.requestId)
          .forNoKeyUpdate("requests")
          .executeTakeFirst();
        const actor = await transaction
          .selectFrom("users")
          .select("instanceRole")
          .where("id", "=", input.resolvedBy)
          .executeTakeFirst();
        const current = await transaction
          .selectFrom("integrationInstallations")
          .selectAll()
          .where("name", "=", input.preparedFulfillment.material.installation.name)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (
          !row ||
          row.kind !== "integration.access" ||
          row.status !== "pending" ||
          row.detailInstallationId !== null ||
          !row.detailManifest ||
          !isDeepStrictEqual(
            IntegrationInstallManifestSchema.parse(row.detailManifest),
            IntegrationInstallManifestSchema.parse(input.preparedFulfillment.approvalManifest),
          )
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Integration access installation is no longer pending",
          });
        }
        const isRequester = row.requestedBy === input.resolvedBy;
        const isAdministrator = actor?.instanceRole === "administrator";
        if (!isRequester && !isAdministrator) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Only the requester or an administrator may continue this installation",
          });
        }
        const exactCurrent =
          current && currentIntegrationMatchesPrepared(current, input.preparedFulfillment.material);
        if (!exactCurrent && !isAdministrator) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Administrator authority is required to install this integration",
          });
        }
        const installationMutation = exactCurrent
          ? {
              installation: IntegrationInstallationSchema.parse({
                createdAt: current.createdAt.toISOString(),
                description: current.description,
                id: current.id,
                manifest: current.manifest,
                name: current.name,
                provenance: current.provenance,
                revision: current.revision,
                sourceKind: current.sourceKind,
                status: current.status,
                title: current.title,
                trust: current.trust,
                updatedAt: current.updatedAt.toISOString(),
                version: current.version,
              }),
              requestEvents: [] as readonly AgentEvent[],
            }
          : await installIntegrationInTransaction(transaction, {
              ...input.preparedFulfillment.material,
              actorUserId: input.resolvedBy,
              requestId: input.requestId,
            });
        return bindIntegrationAccessInstallation(transaction, {
          installation: installationMutation.installation,
          requestEvents: installationMutation.requestEvents,
          requestId: input.requestId,
        });
      },
    );
  }

  async selectIntegrationAccessServer(input: {
    readonly requestId: RequestId;
    readonly requestedServerId: IntegrationServerId;
    readonly resolvedBy: UserId;
  }): Promise<SelectedIntegrationAccessServer> {
    return withRequestWorkspaceLocks(
      this.#database,
      (transaction) => discoverRequestWorkspaces(transaction, { requestId: input.requestId }),
      async (transaction) => {
        const observed = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .selectAll("requests")
          .select([
            "integrationRequestDetails.installationId as detailInstallationId",
            "integrationRequestDetails.requestedConnectionId as detailRequestedConnectionId",
            "integrationRequestDetails.requestedServerId as detailRequestedServerId",
          ])
          .where("requests.id", "=", input.requestId)
          .executeTakeFirst();
        if (
          !observed ||
          observed.kind !== "integration.access" ||
          observed.status !== "pending" ||
          observed.requestedBy !== input.resolvedBy ||
          !observed.detailInstallationId ||
          observed.detailRequestedServerId !== null
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Integration server selection is no longer available",
          });
        }
        await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
        await lockAndValidateIntegrationAccessResources(transaction, {
          installationId: observed.detailInstallationId,
          ownerUserId: input.resolvedBy,
          requestedConnectionId: observed.detailRequestedConnectionId,
          requestedServerId: input.requestedServerId,
        });
        const server = await transaction
          .selectFrom("integrationServers")
          .select("id")
          .where("id", "=", input.requestedServerId)
          .where("installationId", "=", observed.detailInstallationId)
          .where("status", "!=", "disabled")
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!server) {
          throw new OpensteerError({
            code: "conflict",
            message: "Integration server is unavailable",
          });
        }
        const row = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .selectAll("requests")
          .select([
            "integrationRequestDetails.installationId as detailInstallationId",
            "integrationRequestDetails.requestedConnectionId as detailRequestedConnectionId",
            "integrationRequestDetails.requestedServerId as detailRequestedServerId",
          ])
          .where("requests.id", "=", input.requestId)
          .forNoKeyUpdate("requests")
          .executeTakeFirst();
        if (
          !row ||
          row.kind !== "integration.access" ||
          row.status !== "pending" ||
          row.requestedBy !== input.resolvedBy ||
          !row.detailInstallationId ||
          row.detailRequestedServerId !== null
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Integration server selection is no longer available",
          });
        }
        const previous = requestFromRow(row);
        if (previous.payload.kind !== "integration.access")
          throw new Error("Invalid Request payload");
        const payload = {
          ...previous.payload,
          requestedServerId: server.id,
        } satisfies RequestPayload;
        await transaction
          .updateTable("integrationRequestDetails")
          .set({ requestedServerId: server.id })
          .where("requestId", "=", input.requestId)
          .where("requestedServerId", "is", null)
          .executeTakeFirstOrThrow();
        const updated = await transaction
          .updateTable("requests")
          .set({ payload: jsonValue(payload) })
          .where("id", "=", input.requestId)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();
        const request = requestFromRow(updated);
        const event = await appendHostWorkspaceEvent(transaction, {
          data: { request },
          environmentId: await requestOriginEnvironment(transaction, request),
          runId: request.originatingRunId,
          threadId: request.originatingThreadId,
          type: "request.updated",
          workspaceId: request.originatingWorkspaceId,
        });
        return { events: [event], request };
      },
    );
  }

  async get(id: RequestId): Promise<Request | null> {
    const row = await this.#database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? requestFromRow(row) : null;
  }

  async listPendingIntegrationAccessRequests(
    requestedBy: UserId,
  ): Promise<readonly PendingIntegrationAccessRequest[]> {
    const rows = await this.#database
      .selectFrom("requests")
      .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
      .selectAll("requests")
      .select([
        "integrationRequestDetails.access as detailAccess",
        "integrationRequestDetails.installationId as detailInstallationId",
        "integrationRequestDetails.requestedConnectionId as detailRequestedConnectionId",
        "integrationRequestDetails.requestedServerId as detailRequestedServerId",
      ])
      .where("requests.kind", "=", "integration.access")
      .where("requests.requestedBy", "=", requestedBy)
      .where("requests.status", "=", "pending")
      .orderBy("requests.createdAt", "asc")
      .orderBy("requests.id", "asc")
      .execute();
    return rows.flatMap((row) =>
      row.detailInstallationId && row.detailAccess
        ? [
            {
              access: row.detailAccess,
              installationId: row.detailInstallationId,
              request: requestFromRow(row),
              requestedConnectionId: row.detailRequestedConnectionId,
              requestedServerId: row.detailRequestedServerId,
            },
          ]
        : [],
    );
  }

  /** The Request a call opened, or the one it joined. */
  async findByCallIdentity(
    input: { readonly callId: string } & RequestOriginInput,
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
  }): Promise<{ readonly requests: readonly Request[]; readonly window: DurableWindow }> {
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

  async originatingPendingPage(input: {
    readonly before?: string;
    readonly limit: number;
    readonly threadId: ThreadId;
  }): Promise<{ readonly requests: readonly Request[]; readonly window: DurableWindow }> {
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

  /**
   * The pending Requests a person is the one to answer, newest first, each
   * with the work it holds up.
   *
   * Who answers is `requestNotificationAudience`'s rule, the one Request
   * responses enforce: the requester (and, for an integration not yet
   * installed, administrators), a Workspace owner, or an administrator, each
   * only while an active member of the Workspace that asked. The held work is
   * read from the Run's own Assignment and its parents, never from Thread
   * lineage, because a reused Thread's history says nothing about whose work
   * it is doing now. A link the reader could not open ends the chain there.
   */
  async waitingOnUserPage(input: {
    readonly before?: string;
    readonly limit: number;
    readonly userId: UserId;
  }): Promise<{ readonly requests: readonly WaitingRequest[]; readonly window: DurableWindow }> {
    const limit = clampLimit(input.limit);
    const scope = `waiting:${input.userId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    return withDatabaseTransaction(
      this.#database,
      async (transaction) => {
        const viewer = await transaction
          .selectFrom("users")
          .select("instanceRole")
          .where("id", "=", input.userId)
          .executeTakeFirst();
        const administrator = viewer?.instanceRole === "administrator";
        const addressed = transaction
          .selectFrom("requests")
          .innerJoin("workspaceMemberships as membership", (join) =>
            join
              .onRef("membership.workspaceId", "=", "requests.originatingWorkspaceId")
              .on("membership.userId", "=", input.userId)
              .on("membership.state", "=", "active"),
          )
          .where("requests.status", "=", "pending")
          .where((expression) =>
            expression.or([
              expression.and([
                expression("requests.requiredActor", "=", "requester"),
                expression.or([
                  expression("requests.requestedBy", "=", input.userId),
                  ...(administrator
                    ? [
                        expression.and([
                          expression("requests.kind", "=", "integration.access"),
                          sql<boolean>`requests.payload ->> 'installationId' is null`,
                        ]),
                      ]
                    : []),
                ]),
              ]),
              expression.and([
                expression("requests.requiredActor", "=", "workspace-owner"),
                expression("membership.role", "=", "owner"),
              ]),
              ...(administrator
                ? [expression("requests.requiredActor", "=", "administrator")]
                : []),
            ]),
          );
        let page = addressed
          .selectAll("requests")
          .orderBy("requests.createdAt", "desc")
          .orderBy("requests.id", "desc")
          .limit(limit + 1);
        if (anchor) {
          page = page.where((expression) =>
            expression.or([
              expression("requests.createdAt", "<", anchor.createdAt),
              expression.and([
                expression("requests.createdAt", "=", anchor.createdAt),
                expression("requests.id", "<", anchor.id),
              ]),
            ]),
          );
        }
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
          (askingNodeIds.length === 0
            ? []
            : await transaction
                .selectFrom("executionNodes")
                .select(["id", "title"])
                .where("id", "in", askingNodeIds)
                .execute()
          ).map((node) => [node.id, node]),
        );
        return {
          requests: requests.map((request) => ({
            assignments: held.get(request.id) ?? [],
            request: PendingRequestSchema.parse(request),
            subagent: request.originatingNodeId
              ? (askingNodes.get(request.originatingNodeId) ?? null)
              : null,
          })),
          window,
        };
      },
      "repeatable read",
    );
  }

  async visiblePage(input: {
    readonly before?: string;
    readonly limit: number;
    readonly originatingThreadId: ThreadId;
    readonly targetWorkspaceId: WorkspaceId;
  }): Promise<{ readonly requests: readonly Request[]; readonly window: DurableWindow }> {
    const limit = clampLimit(input.limit);
    const scope = `visible:${input.originatingThreadId}:${input.targetWorkspaceId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const visible = (builder: ReturnType<typeof transaction.selectFrom<"requests">>) =>
        builder.where((expression) =>
          expression.or([
            expression("originatingThreadId", "=", input.originatingThreadId),
            expression("targetWorkspaceId", "=", input.targetWorkspaceId),
          ]),
        );
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

  /**
   * How a task asks for one app on one Mac, or for a whole Android phone,
   * decided in one transaction under that computer's row lock.
   *
   * The owner's policy is read under the same lock the decision is written
   * under, so a policy that changes while the task is asking can only change
   * which of these the task gets, never make it fail:
   *
   * - automatic, and no connection or one that already covers the ask: the
   *   connection and this Workspace's grant, inline;
   * - a connection that covers the ask: an ordinary `integration.access`
   *   Request for this Workspace's grant, which the person may approve from
   *   anywhere;
   * - otherwise: a `computer.app.access` Request on the one waiting approval
   *   for that app, which the person answers on the Mac.
   *
   * A phone has no app: `app` is null, its connection is keyed by no app, and
   * the automatic policy never applies to it, because "any app" says nothing
   * about letting a task take over a whole phone.
   *
   * The durable `Request` and the `computer_app_setup_requests` row are one
   * ask seen from two sides — the Thread's card and the approval the desktop
   * on that Mac serves — so they are written together. Replay is the
   * `integration.access` rule: an identical pending ask for the same Thread,
   * Mac, app and access is the same card, and the caller is told so rather
   * than given a second one.
   *
   * `originatingRunId` and `originatingOccurrenceId` carry the usual
   * invariant: exactly one of them, because a Request originates from exactly
   * one execution and a Trigger Occurrence produces no Run row.
   */
  async requestComputerAppAccess(input: {
    readonly reason: string;
    readonly threadTitle: string | null;
    readonly access: IntegrationAccess;
    /** The Mac app the ask names, or null for a phone, whose connection is its display. */
    readonly app: ComputerAppIdentity | null;
    /** Audit correlation for a connection written inline. */
    readonly auditRequestId: string;
    readonly definitionDigest: string;
    readonly definitionId: "android-phone" | "macos-app";
    readonly idempotencyKey?: string;
    readonly originatingOccurrenceId?: TriggerOccurrenceId | null;
    readonly originatingRunId: RunId | null;
    readonly ownerUserId: UserId;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
    /** The tool rows of a connection this ask creates inline. */
    readonly tools: (connectionId: IntegrationConnectionId) => readonly IntegrationToolMaterial[];
    readonly workspaceId: WorkspaceId;
  }): Promise<ComputerAppAccessDecision> {
    if ((input.app === null) !== (input.definitionId === "android-phone")) {
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
          ? ({ originatingOccurrenceId: input.originatingOccurrenceId } as const)
          : null
        : input.originatingOccurrenceId
          ? null
          : ({ originatingRunId: input.originatingRunId } as const);
    if (!origin) {
      throw new OpensteerError({
        code: "bad_request",
        message: "A computer app access Request originates from exactly one Run or Occurrence",
      });
    }
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => [
        input.workspaceId,
        ...(await discoverComputerRequestWorkspaces(transaction, input.runnerId)),
      ],
      async (transaction) => {
        // The asking origin and settlement Workspaces are already fenced.
        const runner = await lockComputerApprovalScopeInTransaction(transaction, {
          runnerId: input.runnerId,
          workspaceIds: [input.workspaceId],
        });
        const ownership =
          runner.revokedAt === null ? await machineOwnershipIn(transaction, runner.id) : null;
        if (runner.revokedAt !== null) {
          throw new OpensteerError({ code: "not_found", message: "Computer not found" });
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
          runnerId: input.runnerId,
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
          .where("integrationConnections.runnerId", "=", input.runnerId)
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
            message: `${app?.displayName ?? runner.name} is blocked on ${runner.name}. The person can unblock it on that Mac.`,
          });
        const covered =
          !!current?.computerAccess &&
          computerAppIdentitiesEqual(current.computerApp, app) &&
          integrationAccessCovers(current.computerAccess, access);
        const policy = await computerUsePolicyInTransaction(
          transaction,
          input.runnerId,
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
            runnerId: input.runnerId,
            tools: input.tools,
            workspaceId: input.workspaceId,
          });
          return {
            connection: approved.connection,
            kind: "approved",
            requestEvents: approved.requestEvents,
          };
        }
        if (current && covered) {
          const mutation = await createRequestInTransaction(
            transaction,
            await integrationAccessRequestInput(transaction, {
              ...origin,
              access,
              callId:
                input.idempotencyKey ??
                `computer.app.grant:${input.definitionId}:${input.runnerId}:${scope.appKey ?? ""}:${access}`,
              installationId: current.installationId,
              originatingThreadId: input.threadId,
              originatingWorkspaceId: input.workspaceId,
              reason: input.reason,
              requestedBy: input.ownerUserId,
              requestedConnectionId: current.id,
              requestedServerId: current.integrationServerId,
              targetWorkspaceId: input.workspaceId,
            }),
          );
          return {
            kind: "workspace-grant",
            replayed: mutation.replayed,
            request: mutation.request,
            requestEvents: mutation.events,
          };
        }
        const { row, settlement } = await askForComputerAppApprovalInTransaction(transaction, {
          access,
          app,
          definitionDigest: input.definitionDigest,
          definitionId: input.definitionId,
          now,
          ownerUserId: input.ownerUserId,
          runnerId: input.runnerId,
          task: {
            reason: input.reason,
            threadId: input.threadId,
            threadTitle: input.threadTitle,
            workspaceId: input.workspaceId,
          },
        });
        const setupRequest = computerAppSetupRequestFromRow(row);
        const mutation = await createRequestInTransaction(transaction, {
          ...origin,
          callId:
            input.idempotencyKey ??
            `computer.app.access:${input.definitionId}:${input.runnerId}:${scope.appKey ?? ""}:${access}`,
          kind: "computer.app.access",
          mode: "durable",
          originatingThreadId: input.threadId,
          originatingWorkspaceId: input.workspaceId,
          payload: {
            access,
            app,
            definitionId: input.definitionId,
            kind: "computer.app.access",
            reason: input.reason,
            runnerId: input.runnerId,
            setupRequestId: setupRequest.id,
            workspaceId: input.workspaceId,
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
          targetWorkspaceId: input.workspaceId,
        });
        return {
          kind: "computer",
          replayed: mutation.replayed,
          request: mutation.request,
          requestEvents: [...settlement.requestEvents, ...mutation.events],
          setupRequest,
        };
      },
      (transaction) => lockRequestOrigin(transaction, origin),
    );
  }

  /**
   * The only answer a person can give from anywhere but that Mac.
   *
   * Approving means consuming the setup request on the computer itself, so a
   * decline is the whole of what web and mobile may say; it takes the approval
   * back with it once no other Thread is waiting on it, because an approval
   * nobody is waiting for is authority left lying around.
   *
   * It takes the Mac's row lock after the complete Workspace set,
   * so a Thread joining the approval cannot commit between this deciding it
   * was the last one waiting and removing the approval under it.
   */
  async declineComputerAppAccessRequest(input: {
    readonly actorUserId: UserId;
    readonly requestId: RequestId;
    readonly response?: RequestResponse;
  }): Promise<{ events: readonly AgentEvent[]; request: Request }> {
    const response = RequestResponseSchema.parse(
      input.response ?? { kind: "external", value: { decision: "declined" } },
    );
    const value = response.kind === "external" ? response.value : undefined;
    if (!value || Object.keys(value).length !== 1 || value.decision !== "declined") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Computer app access is approved on that Mac; from here it can only be declined.",
      });
    }
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => {
        const request = await transaction
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", input.requestId)
          .executeTakeFirst();
        if (!request) return [];
        const payload = requestFromRow(request).payload;
        return [
          request.originatingWorkspaceId,
          request.targetWorkspaceId,
          ...(payload.kind === "computer.app.access"
            ? await discoverComputerRequestWorkspaces(transaction, payload.runnerId)
            : []),
        ];
      },
      async (transaction) => {
        const noLongerPending = () =>
          new OpensteerError({
            code: "conflict",
            message: "Computer app access Request is no longer pending for this requester",
          });
        const named = await transaction
          .selectFrom("requests")
          .select(sql<string>`payload->>'runnerId'`.as("runnerId"))
          .where("id", "=", input.requestId)
          .where("kind", "=", "computer.app.access")
          .executeTakeFirst();
        if (!named) throw noLongerPending();
        await lockComputerApprovalScopeInTransaction(transaction, {
          runnerId: RunnerIdSchema.parse(named.runnerId),
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
        return { events: await terminalEvents(transaction, request), request };
      },
    );
  }

  async declineMachineFullDiskAccessRequest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }): Promise<{ events: readonly AgentEvent[]; request: Request }> {
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
    return withRequestWorkspaceLocks(
      this.#database,
      (transaction) => discoverRequestWorkspaces(transaction, { requestId: input.requestId }),
      async (transaction) => {
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
        await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
        const now = new Date();
        const row = await transaction
          .updateTable("requests")
          .set({
            status: "declined",
            resolvedAt: now,
            resolvedBy: input.resolvedBy,
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
        return { events: await terminalEvents(transaction, request), request };
      },
    );
  }

  async fulfillMachineFullDiskAccessRequests(
    machineId: RunnerId,
  ): Promise<{ events: AgentEvent[]; requests: Request[] }> {
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) =>
        (
          await transaction
            .selectFrom("requests")
            .select(["originatingWorkspaceId", "targetWorkspaceId"])
            .where("kind", "=", "machine.full-disk-access")
            .where("status", "=", "pending")
            .where(sql<string>`payload->>'machineId'`, "=", machineId)
            .execute()
        ).flatMap((row) => [row.originatingWorkspaceId, row.targetWorkspaceId]),
      async (transaction) => {
        const rows = await transaction
          .selectFrom("requests")
          .selectAll()
          .where("kind", "=", "machine.full-disk-access")
          .where("status", "=", "pending")
          .where(sql<string>`payload->>'machineId'`, "=", machineId)
          .orderBy("id", "asc")
          .forNoKeyUpdate()
          .execute();
        const events: AgentEvent[] = [];
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
              response: jsonValue({ kind: "external", value: { decision: "fulfilled" } }),
            })
            .where("id", "=", row.id)
            .where("status", "=", "pending")
            .returningAll()
            .executeTakeFirst();
          if (!resolved) continue;
          const request = requestFromRow(resolved);
          await enqueueContinuation(transaction, request, now);
          events.push(...(await terminalEvents(transaction, request)));
          requests.push(request);
        }
        return { events, requests };
      },
    );
  }

  async resolveBrowserRequest(input: {
    readonly preparedProfile?: PreparedBrowserProfile;
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }): Promise<ResolvedBrowserRequest> {
    return withRequestWorkspaceLocks(
      this.#database,
      (transaction) => discoverRequestWorkspaces(transaction, { requestId: input.requestId }),
      async (transaction) => {
        const observed = await transaction
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", input.requestId)
          .executeTakeFirst();
        if (
          !observed ||
          observed.status !== "pending" ||
          observed.requestedBy !== input.resolvedBy ||
          (observed.kind !== "browser.access" && observed.kind !== "browser.profile.save")
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Browser Request is no longer pending",
          });
        }
        const observedRequest = requestFromRow(observed);
        await lockActiveDurableRequestAuthority(transaction, observedRequest);
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
          (row.kind !== "browser.access" && row.kind !== "browser.profile.save")
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Browser Request is no longer pending",
          });
        }
        const request = requestFromRow(row);
        const response = RequestResponseSchema.parse(input.response);
        if (response.kind !== "external" || !response.value) {
          throw new OpensteerError({
            code: "bad_request",
            message: "Browser Request response is invalid",
          });
        }
        const decision = parseBrowserDecision(response.value);
        if (request.kind === "browser.access" && input.preparedProfile) {
          throw new OpensteerError({
            code: "bad_request",
            message: "Browser access cannot carry a prepared profile revision",
          });
        }
        if (decision.decision === "declined" && input.preparedProfile) {
          throw new OpensteerError({
            code: "bad_request",
            message: "A declined Request cannot create a profile",
          });
        }

        let profile: ResolvedBrowserRequest["profile"] = null;
        let grant: ResolvedBrowserRequest["grant"] = null;
        if (decision.decision === "fulfilled") {
          if (request.kind === "browser.profile.save") {
            const prepared = input.preparedProfile;
            if (!prepared || !("name" in decision) || prepared.name !== decision.name) {
              throw new OpensteerError({
                code: "bad_request",
                message: "A saved Browser Profile requires its prepared first revision",
              });
            }
            profile = await insertBrowserProfile(transaction, {
              ...prepared,
              ownerId: input.resolvedBy,
            });
          } else if ("profileId" in decision) {
            profile =
              (await transaction
                .selectFrom("browserProfiles")
                .select(["id", "name", "ownerId", "revision"])
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
          } else if ("createProfile" in decision) {
            if (input.preparedProfile) {
              throw new OpensteerError({
                code: "bad_request",
                message: "A fresh profile has no prepared revision",
              });
            }
            await assertBrowserProfileCapacity(transaction, input.resolvedBy);
            profile = await transaction
              .insertInto("browserProfiles")
              .values({
                archivedAt: null,
                id: createId("browserProfile"),
                name: decision.createProfile.name,
                ownerId: input.resolvedBy,
                revision: 0,
              })
              .returning(["id", "name", "ownerId", "revision"])
              .executeTakeFirstOrThrow();
          } else {
            throw new OpensteerError({
              code: "bad_request",
              message: "Browser access selection is invalid",
            });
          }
          const targetWorkspace = await transaction
            .selectFrom("workspaces")
            .select("kind")
            .where("id", "=", request.targetWorkspaceId)
            .executeTakeFirstOrThrow();
          if (request.kind === "browser.access" || targetWorkspace.kind === "specialized") {
            grant = await ensureBrowserGrant(transaction, {
              createdBy: input.resolvedBy,
              profileId: profile.id,
              workspaceId: request.targetWorkspaceId,
            });
          }
        }

        const storedResponse: RequestResponse = profile
          ? {
              kind: "external",
              value: { ...response.value, profile: { id: profile.id, name: profile.name } },
            }
          : response;
        const now = new Date();
        const resolvedRow = await transaction
          .updateTable("requests")
          .set({
            resolvedAt: now,
            resolvedBy: input.resolvedBy,
            response: jsonValue(storedResponse),
            status: decision.decision === "declined" ? "declined" : "fulfilled",
          })
          .where("id", "=", request.id)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();
        const resolved = requestFromRow(resolvedRow);
        await enqueueContinuation(transaction, resolved, now);
        return {
          events: await terminalEvents(transaction, resolved),
          grant,
          profile,
          request: resolved,
          saveSessionId:
            request.payload.kind === "browser.profile.save" ? request.payload.sessionId : null,
        };
      },
      async (transaction) => {
        const row = await transaction
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", input.requestId)
          .executeTakeFirst();
        if (row?.kind !== "browser.profile.save" || row.status !== "pending") return;
        const request = requestFromRow(row);
        await lockRequestOrigin(transaction, request);
        if (request.payload.kind === "browser.profile.save") {
          await lockSavableBrowserSession(
            transaction,
            BrowserSessionIdSchema.parse(request.payload.sessionId),
            input.resolvedBy,
          );
        }
      },
    );
  }

  /** The owner said no: the agent is told not to ask for this site again. */
  async declineBrowserSignInRequest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
  }): Promise<RequestMutation> {
    return withRequestWorkspaceLocks(
      this.#database,
      (transaction) => discoverRequestWorkspaces(transaction, { requestId: input.requestId }),
      async (transaction) => {
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
          return { events: [], replayed: true, request: requestFromRow(observed) };
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
        await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
        const now = new Date();
        const resolvedRow = await transaction
          .updateTable("requests")
          .set({
            status: "declined",
            resolvedAt: now,
            resolvedBy: input.resolvedBy,
            response: jsonValue({ kind: "external", value: { decision: "declined" } }),
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
        return {
          events: await terminalEvents(transaction, resolved),
          replayed: false,
          request: resolved,
        };
      },
    );
  }

  /** Settles a sign-in Request without a delivery, such as when its session closed. */
  async fulfilBrowserSignInRequest(input: {
    readonly requestId: RequestId;
    readonly ownerId: UserId;
    readonly response: BrowserSignInRequestResponse;
  }): Promise<{ readonly events: readonly AgentEvent[]; readonly request: Request } | null> {
    return withRequestWorkspaceLocks(
      this.#database,
      (transaction) => discoverRequestWorkspaces(transaction, { requestId: input.requestId }),
      (transaction) => fulfilBrowserSignInRequestInTransaction(transaction, input),
    );
  }

  /**
   * Pending sign-in Requests one Chrome profile could complete now: their
   * (Workspace, site) is allowed and prefers this Chrome, or prefers none that
   * is still connected. Oldest first, so the longest wait completes first; a
   * caller pages with `after` so Requests nobody can answer never hide ones
   * that can be.
   */
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
          .onRef("browserSiteGrants.workspaceId", "=", "requests.targetWorkspaceId")
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

  async findPendingBrowserSignIn(input: {
    readonly ownerId: UserId;
    readonly originatingRunId: RunId;
    readonly site: string;
    readonly workspaceId: WorkspaceId;
  }): Promise<Request | null> {
    const row = await this.#database
      .selectFrom("requests")
      .selectAll()
      .where("kind", "=", "browser.sign-in")
      .where("status", "=", "pending")
      .where("requestedBy", "=", input.ownerId)
      .where("originatingRunId", "=", input.originatingRunId)
      .where("targetWorkspaceId", "=", input.workspaceId)
      .where(sql<string>`payload->>'site'`, "=", input.site)
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();
    return row ? requestFromRow(row) : null;
  }

  /** Live authority for an unattended Passwords operation, without creating a Request. */
  async hasPasswordSignInAuthority(input: {
    readonly originatingRunId: RunId;
    readonly originatingThreadId: ThreadId;
    readonly originatingWorkspaceId: WorkspaceId;
    readonly requestedBy: UserId;
    readonly targetWorkspaceId: WorkspaceId;
  }): Promise<boolean> {
    return withRequestWorkspaceLocks(
      this.#database,
      async () => [input.originatingWorkspaceId, input.targetWorkspaceId],
      async (transaction) => {
        const origin = await lockRequestOrigin(transaction, input);
        if (
          !origin?.running ||
          origin.threadId !== input.originatingThreadId ||
          origin.workspaceId !== input.originatingWorkspaceId ||
          origin.requestedBy !== input.requestedBy ||
          !(await runHasActiveGrant(transaction, input.originatingRunId))
        )
          return false;
        const authority = await lockRequestWorkspaceAuthorities(transaction, input);
        try {
          assertActiveRequestAuthority(
            authority,
            origin.membershipGeneration === null
              ? {}
              : { originatingMembershipGeneration: origin.membershipGeneration },
          );
          return true;
        } catch (error) {
          if (error instanceof OpensteerError) return false;
          throw error;
        }
      },
      (transaction) => lockRequestOrigin(transaction, input),
    );
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
    return withRequestWorkspaceLocks(
      this.#database,
      async (transaction) => {
        const replay = await transaction
          .selectFrom("requests")
          .select(["originatingWorkspaceId", "targetWorkspaceId"])
          .where(callIdentityFilter(input))
          .executeTakeFirst();
        return [
          input.originatingWorkspaceId,
          input.targetWorkspaceId,
          ...(replay ? [replay.originatingWorkspaceId, replay.targetWorkspaceId] : []),
        ];
      },
      async (transaction) => {
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
        if (joined) return recordJoins({ events: [], replayed: true, request: joined });
        const own = await transaction
          .selectFrom("requests")
          .select("id")
          .where(callIdentityFilter(input))
          .executeTakeFirst();
        const origin = own ? undefined : await lockRequestOrigin(transaction, input);
        if (
          origin?.running &&
          origin.threadId === input.originatingThreadId &&
          origin.workspaceId === input.originatingWorkspaceId &&
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
          // A Workspace-scoped sign-in joins only its own Workspace's consent; a
          // legacy one stays bound to the Browser Session it was asked for.
          const open = await (
            payload.sessionId === undefined
              ? pending
                  .where("targetWorkspaceId", "=", input.targetWorkspaceId)
                  .where(sql<string>`payload->>'scope'`, "=", "workspace")
              : pending.where(sql<string>`payload->>'sessionId'`, "=", payload.sessionId)
          )
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
            return recordJoins({ events: [], replayed: true, request: requestFromRow(open) });
          }
        }
        // A replay of the opening call, a new Request, or the refusal for a
        // Run that can no longer ask.
        return recordJoins(await createRequestInTransaction(transaction, fields));
      },
      (transaction) => lockRequestOrigin(transaction, input),
    );
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
   * is being cancelled through that path instead.
   */
  async settlePasswordSignInRequest(input: {
    readonly ownerId: UserId;
    readonly requestId: RequestId;
    readonly settlement:
      | { readonly status: "declined" }
      | { readonly status: "fulfilled"; readonly response: PasswordSignInRequestResponse };
  }): Promise<{ readonly events: readonly AgentEvent[]; readonly request: Request } | null> {
    return withRequestWorkspaceLocks(
      this.#database,
      (transaction) => discoverRequestWorkspaces(transaction, { requestId: input.requestId }),
      async (transaction) => {
        const pending = (row: RequestRow | undefined): row is RequestRow =>
          row?.kind === "browser.password-sign-in" &&
          row.status === "pending" &&
          row.requestedBy === input.ownerId;
        const observed = await transaction
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", input.requestId)
          .executeTakeFirst();
        if (!pending(observed)) return null;
        try {
          await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
        } catch (error) {
          if (error instanceof OpensteerError) return null;
          throw error;
        }
        const row = await transaction
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", input.requestId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!pending(row)) return null;
        const now = new Date();
        const response =
          input.settlement.status === "declined"
            ? { kind: "external" as const, value: { decision: "declined" } }
            : RequestResponseSchema.parse({
                kind: "external",
                value: PasswordSignInRequestResponseSchema.parse(input.settlement.response),
              });
        const resolvedRow = await transaction
          .updateTable("requests")
          .set({
            status: input.settlement.status,
            resolvedAt: now,
            resolvedBy: input.ownerId,
            response: jsonValue(response),
          })
          .where("id", "=", input.requestId)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();
        const resolved = requestFromRow(resolvedRow);
        await enqueueContinuation(transaction, resolved, now);
        return { events: await terminalEvents(transaction, resolved), request: resolved };
      },
    );
  }

  async withdraw(input: {
    readonly requestId: RequestId;
    readonly threadId: ThreadId;
    readonly withdrawnBy: UserId;
  }): Promise<RequestMutation> {
    return withRequestWorkspaceLocks(
      this.#database,
      (transaction) => discoverRequestWorkspaces(transaction, { requestId: input.requestId }),
      async (transaction) => {
        const pending = await transaction
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", input.requestId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!pending) {
          throw new OpensteerError({ code: "conflict", message: "Request is no longer pending" });
        }
        if (
          pending.status === "withdrawn" &&
          pending.mode === "durable" &&
          pending.originatingThreadId === input.threadId &&
          pending.requestedBy === input.withdrawnBy &&
          pending.resolvedBy === input.withdrawnBy
        ) {
          return { events: [], replayed: true, request: requestFromRow(pending) };
        }
        if (pending.status !== "pending") {
          throw new OpensteerError({ code: "conflict", message: "Request is no longer pending" });
        }
        if (pending.mode !== "durable" || pending.originatingThreadId !== input.threadId) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Only the originating Thread may withdraw its pending durable Request",
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
          .set({ resolvedAt: now, resolvedBy: input.withdrawnBy, status: "withdrawn" })
          .where("id", "=", pending.id)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();
        const request = requestFromRow(row);
        await enqueueContinuation(transaction, request, now);
        return {
          events: await terminalEvents(transaction, request),
          replayed: false,
          request,
        };
      },
    );
  }

  async cancelForRun(
    runId: RunId,
    reason: RequestCancellationReason,
    resolvedAt = new Date(),
  ): Promise<readonly AgentEvent[]> {
    return withRequestWorkspaceLocks(
      this.#database,
      (transaction) => discoverRequestWorkspaces(transaction, { runId, pending: true }),
      (transaction) => cancelPending(transaction, { reason, resolvedAt, runId }),
    );
  }

  async listPendingContinuations(limit = 100): Promise<readonly PendingRequestContinuation[]> {
    const rows = await this.#database
      .selectFrom("requestContinuations")
      .innerJoin("requests", "requests.id", "requestContinuations.requestId")
      .selectAll("requests")
      .select([
        "requestContinuations.attemptedAt as continuationAttemptedAt",
        "requestContinuations.reason as continuationReason",
        "requestContinuations.status as continuationStatus",
      ])
      .where("requestContinuations.status", "=", "waiting")
      .orderBy(sql`request_continuations.attempted_at asc nulls first`)
      .orderBy("requestContinuations.createdAt", "asc")
      .limit(clampLimit(limit))
      .execute();
    return rows.map((row) => ({
      attemptedAt: row.continuationAttemptedAt?.toISOString() ?? null,
      reason: row.continuationReason,
      request: requestFromRow(row),
      status: row.continuationStatus,
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

/**
 * The one Request-creation path, exposed to the transaction so a caller that
 * must write a Request together with the authority row it names — a computer
 * app's setup request, for instance — commits both or neither.
 */
type IntegrationAccessRequestInput = {
  readonly access: IntegrationAccess;
  readonly callId: string;
  readonly installationId: IntegrationInstallationId | null;
  readonly manifest?: IntegrationInstallManifest | null;
  readonly originatingThreadId: ThreadId;
  readonly originatingWorkspaceId: WorkspaceId;
  readonly reason: string;
  readonly requestedConnectionId?: IntegrationConnectionId | null;
  readonly requestedBy: UserId;
  readonly requestedServerId: IntegrationServerId | null;
  readonly targetWorkspaceId: WorkspaceId;
} & RequestOriginInput;

/** An ordinary `integration.access` Request, which the person can approve from anywhere. */
async function integrationAccessRequestInput(
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
  const title = installation?.title ?? integrationInstallDisplayName(manifest!);
  // A proposed installation's title came from the document an agent
  // researched, so every surface says so beside it, as the install card does:
  // untrusted text must not read as Opensteer's own prose.
  const agentProposed = installation
    ? installation.sourceKind === "proposed"
    : manifest!.kind === "proposal";
  const summary = manifest
    ? RequestJsonObjectSchema.parse(integrationInstallManifestSummary(manifest))
    : null;
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
    originatingWorkspaceId: input.originatingWorkspaceId,
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
      ...(agentProposed ? { agentProposed: true } : {}),
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
    targetWorkspaceId: input.targetWorkspaceId,
  };
}

async function createRequestInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: CreateRequestInput,
): Promise<RequestMutation> {
  if (input.callId.length < 1 || input.callId.length > 512 || input.callId.includes("\0")) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Request call identity is invalid",
    });
  }
  if (input.kind === "browser.profile.import") {
    throw new OpensteerError({
      code: "bad_request",
      message: "Browser profile import Requests are no longer supported",
    });
  }
  const origin = await lockRequestOrigin(transaction, input);
  if (
    !origin ||
    origin.threadId !== input.originatingThreadId ||
    origin.workspaceId !== input.originatingWorkspaceId ||
    origin.requestedBy !== input.requestedBy
  ) {
    throw new OpensteerError({ code: "forbidden", message: originMismatchMessage(input) });
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
    await lockRequestWorkspaceAuthorities(transaction, {
      originatingWorkspaceId: existing.originatingWorkspaceId,
      requestedBy: existing.requestedBy,
      targetWorkspaceId: existing.targetWorkspaceId,
    });
    const replay = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", existing.id)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    return { events: [], replayed: true, request: requestFromRow(replay) };
  }

  if (!origin.running) {
    throw new OpensteerError({ code: "forbidden", message: originMismatchMessage(input) });
  }
  // A stopped Run is still running until its Runner winds it down, but may not
  // ask for anything more. Revocation holds the Run, as this caller now does.
  if (origin.runId && !(await runHasActiveGrant(transaction, origin.runId))) {
    throw new OpensteerError({ code: "forbidden", message: "Run tool authority has ended" });
  }
  // Closure owns the BrowserSession before appending cancellation events in
  // the Workspace. Save creation and resolution must follow that same order.
  const saveSession =
    input.kind === "browser.profile.save" && input.payload.kind === "browser.profile.save"
      ? await lockSavableBrowserSession(
          transaction,
          BrowserSessionIdSchema.parse(input.payload.sessionId),
          input.requestedBy,
        )
      : null;
  const authority = await lockRequestWorkspaceAuthorities(transaction, {
    originatingWorkspaceId: input.originatingWorkspaceId,
    requestedBy: input.requestedBy,
    targetWorkspaceId: input.targetWorkspaceId,
  });
  // Only a Run signs a membership generation into its authority; a Trigger
  // Occurrence is re-validated against its Trigger's live authority instead.
  assertActiveRequestAuthority(
    authority,
    origin.membershipGeneration === null
      ? {}
      : { originatingMembershipGeneration: origin.membershipGeneration },
  );
  if (
    input.originatingRunId &&
    !(await runAssignmentAcceptsRequests(transaction, input.originatingRunId))
  ) {
    throw new OpensteerError({ code: "conflict", message: assignmentClosedToRequestsMessage });
  }
  if (input.kind === "browser.access" && authority.targetWorkspace.kind !== "specialized") {
    throw new OpensteerError({
      code: "bad_request",
      message: "Browser access Requests must target a specialized Workspace",
    });
  }
  if (input.kind === "browser.profile.save") {
    if (input.payload.kind !== "browser.profile.save") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Browser Profile save Request payload is invalid",
      });
    }
    if (
      authority.targetWorkspace.kind === "specialized" &&
      saveSession?.workspaceId !== input.targetWorkspaceId
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Browser Session is outside the target Workspace",
      });
    }
  }
  if (input.kind === "browser.sign-in") {
    if (input.payload.kind !== "browser.sign-in") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Browser sign-in Request payload is invalid",
      });
    }
    // The session's Workspace is the one the site is remembered for, so a
    // Request can only target the Workspace its live session belongs to.
    const session = await transaction
      .selectFrom("browserSessions")
      .select(["workspaceId", "state"])
      .where("id", "=", BrowserSessionIdSchema.parse(input.payload.sessionId))
      .executeTakeFirst();
    if (
      !session ||
      session.workspaceId !== input.targetWorkspaceId ||
      (session.state !== "starting" && session.state !== "ready")
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "The Browser Session is no longer open in the target Workspace",
        reason: browserSessionClosedReason,
      });
    }
  }
  if (input.kind.startsWith("integration.")) {
    await validateIntegrationRequestDetail(transaction, input);
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
      .where("requests.targetWorkspaceId", "=", input.targetWorkspaceId)
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
      return { events: [], replayed: true, request: requestFromRow(duplicate) };
    }
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
      .where("targetWorkspaceId", "=", input.targetWorkspaceId)
      .where("originatingThreadId", "=", input.originatingThreadId)
      .where(sql<string>`payload->>'definitionId'`, "=", input.payload.definitionId)
      .where(sql<string>`payload->>'runnerId'`, "=", input.payload.runnerId)
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
      return { events: [], replayed: true, request: requestFromRow(duplicate) };
    }
  }
  const { integrationDetail: _integrationDetail, ...requestInput } = input;
  const request = PendingRequestSchema.parse({
    ...requestInput,
    cancellationReason: null,
    createdAt: new Date().toISOString(),
    id: createId("request"),
    originatingOccurrenceId: input.originatingOccurrenceId ?? null,
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
      input.originatingRunId === undefined
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
    return { events: [], replayed: true, request: requestFromRow(replay) };
  }
  if (input.integrationDetail) {
    await insertIntegrationDetail(transaction, inserted.id, input.integrationDetail);
  }
  const canonical = requestFromRow(inserted);
  const event = await appendHostWorkspaceEvent(transaction, {
    data: { request: canonical },
    environmentId: origin.environmentId,
    runId: origin.runId,
    threadId: origin.threadId,
    type: "request.opened",
    workspaceId: origin.workspaceId,
  });
  return {
    events: [
      event,
      ...(canonical.originatingRunId
        ? await assignmentActivityEventsForRun(transaction, canonical.originatingRunId)
        : []),
    ],
    replayed: false,
    request: canonical,
  };
}

/**
 * The name an approver sees on an installation card. A catalog manifest names
 * its definition outright; a proposal has no definition until it is installed,
 * so it is called what it will be called once installed.
 *
 * A proposal's name is text an agent researched rather than a name Opensteer
 * vouches for, so the Request carrying it is marked `agentProposed`: unmarked,
 * a title like `Gmail — approved by your administrator` would read as the
 * platform's own prose on the card that grants it.
 */
export function integrationInstallDisplayName(manifest: IntegrationInstallManifest): string {
  return manifest.kind === "catalog"
    ? manifest.definition.name
    : integrationProposalName(manifest.proposal);
}

function installManifestSubject(manifest: IntegrationInstallManifest): string {
  return manifest.kind === "catalog"
    ? `catalog:${manifest.definition.id}:${manifest.digest}`
    : `proposal:${manifest.proposal.digest}`;
}

function currentIntegrationMatchesPrepared(
  current: {
    readonly adapterSnapshot: unknown;
    readonly description: string;
    readonly manifest: unknown;
    readonly name: string;
    readonly provenance: unknown;
    readonly sourceKind: string;
    readonly status: string;
    readonly title: string;
    readonly trust: string;
    readonly version: string | null;
  },
  prepared: PreparedIntegrationInstallFulfillment["material"],
): boolean {
  const installation = prepared.installation;
  return (
    current.status === "active" &&
    current.name === installation.name &&
    current.sourceKind === installation.sourceKind &&
    current.title === installation.title &&
    current.description === installation.description &&
    current.trust === installation.trust &&
    current.version === installation.version &&
    isDeepStrictEqual(current.manifest, installation.manifest) &&
    isDeepStrictEqual(current.provenance, installation.provenance) &&
    isDeepStrictEqual(current.adapterSnapshot, prepared.adapterSnapshot)
  );
}

function installedIntegrationMatchesReviewedManifest(
  installation: {
    readonly manifest: unknown;
    readonly provenance: unknown;
    readonly sourceKind: string;
    readonly status: string;
    readonly version: string | null;
  },
  reviewed: IntegrationInstallManifest,
): boolean {
  if (installation.status !== "active") return false;
  const provenance = RequestJsonObjectSchema.safeParse(installation.provenance);
  const installedManifest = RequestJsonObjectSchema.safeParse(installation.manifest);
  if (!provenance.success || !installedManifest.success) return false;
  if (reviewed.kind === "catalog") {
    return (
      installation.sourceKind === "built-in" &&
      installation.version === reviewed.digest &&
      provenance.data.definitionId === reviewed.definition.id &&
      provenance.data.definitionDigest === reviewed.digest &&
      isDeepStrictEqual(installedManifest.data.definition, reviewed.definition)
    );
  }
  const summary = integrationInstallManifestSummary(reviewed);
  if (summary.kind !== "proposal") throw new Error("Invalid proposal summary");
  return (
    installation.sourceKind === "proposed" &&
    installation.version === reviewed.proposal.digest &&
    provenance.data.artifactDigest === reviewed.proposal.digest &&
    provenance.data.proposalKind === reviewed.proposal.kind &&
    isDeepStrictEqual(provenance.data.source, summary.proposal.source) &&
    isDeepStrictEqual(installedManifest.data.proposal, summary.proposal)
  );
}

function integrationInstallationFromRequestRow(row: {
  readonly createdAt: Date;
  readonly description: string;
  readonly id: IntegrationInstallationId;
  readonly manifest: unknown;
  readonly name: string;
  readonly provenance: unknown;
  readonly revision: number;
  readonly sourceKind: "agent-plugin" | "built-in" | "proposed" | "remote-mcp";
  readonly status: "active" | "disabled" | "needs-attention";
  readonly title: string;
  readonly trust: "administrator-approved" | "built-in" | "verified-publisher";
  readonly updatedAt: Date;
  readonly version: string | null;
}): InstallIntegrationMutation["installation"] {
  return IntegrationInstallationSchema.parse({
    createdAt: row.createdAt.toISOString(),
    description: row.description,
    id: row.id,
    manifest: row.manifest,
    name: row.name,
    provenance: row.provenance,
    revision: row.revision,
    sourceKind: row.sourceKind,
    status: row.status,
    title: row.title,
    trust: row.trust,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  });
}

async function bindIntegrationAccessInstallation(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly installation: InstallIntegrationMutation["installation"];
    readonly requestEvents: readonly AgentEvent[];
    readonly requestId: RequestId;
  },
): Promise<BoundIntegrationAccessInstallation> {
  const row = await transaction
    .selectFrom("requests")
    .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
    .selectAll("requests")
    .select([
      "integrationRequestDetails.installationId as detailInstallationId",
      "integrationRequestDetails.manifest as detailManifest",
    ])
    .where("requests.id", "=", input.requestId)
    .forNoKeyUpdate("requests")
    .executeTakeFirst();
  if (
    !row ||
    row.kind !== "integration.access" ||
    row.status !== "pending" ||
    row.detailInstallationId !== null ||
    !row.detailManifest
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "Integration access installation is no longer pending",
    });
  }
  const availableServers = await transaction
    .selectFrom("integrationServers")
    .select("id")
    .where("installationId", "=", input.installation.id)
    .where("status", "!=", "disabled")
    .orderBy("id", "asc")
    .limit(2)
    .execute();
  const requestedServerId = availableServers.length === 1 ? availableServers[0]!.id : null;
  const oldRequest = requestFromRow(row);
  if (oldRequest.payload.kind !== "integration.access") throw new Error("Invalid Request payload");
  const payload = {
    ...oldRequest.payload,
    installationId: input.installation.id,
    manifest: null,
    requestedServerId,
  } satisfies RequestPayload;
  await transaction
    .updateTable("integrationRequestDetails")
    .set({ installationId: input.installation.id, requestedServerId })
    .where("requestId", "=", input.requestId)
    .where("installationId", "is", null)
    .executeTakeFirstOrThrow();
  const updatedRow = await transaction
    .updateTable("requests")
    .set({ payload: jsonValue(payload) })
    .where("id", "=", input.requestId)
    .where("status", "=", "pending")
    .returningAll()
    .executeTakeFirstOrThrow();
  const request = requestFromRow(updatedRow);
  const event = await appendHostWorkspaceEvent(transaction, {
    data: { request },
    environmentId: await requestOriginEnvironment(transaction, request),
    runId: request.originatingRunId,
    threadId: request.originatingThreadId,
    type: "request.updated",
    workspaceId: request.originatingWorkspaceId,
  });
  return {
    installation: input.installation,
    request,
    requestEvents: [...input.requestEvents, event],
  };
}

async function validateIntegrationRequestDetail(
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
  if (input.kind === "integration.install") {
    if (
      detail.access !== null ||
      !detail.manifest ||
      detail.installationId ||
      detail.requestedConnectionId ||
      detail.requestedServerId
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Installation Request detail is invalid",
      });
    }
    const manifest = IntegrationInstallManifestSchema.parse(detail.manifest);
    if (manifest.kind === "catalog") {
      await assertCatalogDefinitionAvailable(transaction, manifest.definition.id);
    }
    return;
  }
  if (
    input.kind !== "integration.access" ||
    !detail.access ||
    (detail.installationId === null) === (detail.manifest === null)
  ) {
    throw new OpensteerError({ code: "bad_request", message: "Access Request detail is invalid" });
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

async function assertCatalogDefinitionAvailable(
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

async function lockAndValidateIntegrationAccessResources(
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
    throw new OpensteerError({ code: "conflict", message: "Integration is inactive" });
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
          return requirement.kind === "mcp-oauth"
            ? connection.connectionKind === "mcp-oauth" &&
                connection.integrationServerId === server.id
            : requirement.kind === "computer"
              ? connection.connectionKind === "computer" &&
                connection.integrationServerId === server.id &&
                connection.integrationDefinitionId === requirement.definitionId
              : requirement.kind === "provider" &&
                connection.connectionKind === "provider-account" &&
                connection.integrationDefinitionId === requirement.definitionId &&
                connection.provider === requirement.provider;
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

async function withAuthoritativeIntegrationAccount(
  transaction: Transaction<DatabaseSchema>,
  response: RequestResponse,
  connectionId: IntegrationConnectionId,
  ownerUserId: UserId,
): Promise<RequestResponse> {
  if (response.kind !== "external" || !response.value) {
    throw new Error("Integration access response is not external");
  }
  const account = await transaction
    .selectFrom("integrationConnections")
    .select(["accountIdentifier", "displayName"])
    .where("id", "=", connectionId)
    .where("ownerUserId", "=", ownerUserId)
    .where("connectionKind", "in", ["provider-account", "computer", "mcp-oauth"])
    .executeTakeFirst();
  if (!account) return response;
  return {
    kind: "external",
    value: RequestJsonObjectSchema.parse({ ...response.value, account }),
  };
}

async function validateIntegrationAccessFulfillmentConnection(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly connectionId: IntegrationConnectionId;
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
    readonly requestedAccess: IntegrationAccess;
    readonly requestedServerId: IntegrationServerId | null;
  },
): Promise<void> {
  const connection = await transaction
    .selectFrom("integrationConnections")
    .select(["computerAccess", "connectionKind"])
    .where("id", "=", input.connectionId)
    .where("ownerUserId", "=", input.ownerUserId)
    .where("status", "=", "connected")
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!connection) {
    throw new OpensteerError({
      code: "forbidden",
      message: "The selected integration connection is unavailable",
    });
  }
  const usable = await new IntegrationGrantStore(transaction).isConnectionUsableForAccessRequest({
    connectionId: input.connectionId,
    installationId: input.installationId,
    ownerUserId: input.ownerUserId,
    providerAuthorizations: input.providerAuthorizations,
    requestedServerId: input.requestedServerId,
  });
  if (!usable) {
    throw new OpensteerError({
      code: "forbidden",
      message: "The selected connection belongs to a different integration",
    });
  }
  if (
    connection.connectionKind === "computer" &&
    input.requestedAccess === "read-write" &&
    connection.computerAccess !== "read-write"
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "The selected computer app allows reading only",
    });
  }
}

function withoutClientIntegrationAccount(response: RequestResponse): RequestResponse {
  if (response.kind !== "external" || !response.value) return response;
  const value = { ...response.value };
  delete value.account;
  return { kind: "external", value: RequestJsonObjectSchema.parse(value) };
}

type IntegrationAccessDecision =
  | { readonly decision: "declined" }
  | {
      readonly connectionId: IntegrationConnectionId | null;
      readonly decision: "fulfilled";
    }
  | {
      readonly access: IntegrationAccess;
      readonly alias: string;
      readonly connectionId: IntegrationConnectionId | null;
      readonly decision: "fulfilled";
      readonly isDefault: boolean;
    };

function parseIntegrationAccessDecision(
  response: RequestResponse,
  mainTarget: boolean,
): IntegrationAccessDecision {
  if (response.kind !== "external" || !response.value) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Integration Request response is invalid",
    });
  }
  const value = response.value;
  if (value.decision === "declined") return { decision: "declined" };
  if (mainTarget) {
    if (
      value.decision !== "fulfilled" ||
      !("connectionId" in value) ||
      (value.connectionId !== null && typeof value.connectionId !== "string")
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Integration access decision is invalid",
      });
    }
    return {
      connectionId:
        value.connectionId === null
          ? null
          : IntegrationConnectionIdSchema.parse(value.connectionId),
      decision: "fulfilled",
    };
  }
  if (
    value.decision !== "fulfilled" ||
    !IntegrationAccessSchema.safeParse(value.access).success ||
    typeof value.alias !== "string" ||
    typeof value.isDefault !== "boolean" ||
    !("connectionId" in value) ||
    (value.connectionId !== null && typeof value.connectionId !== "string")
  ) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Integration grant selection is invalid",
    });
  }
  const alias = value.alias.trim();
  if (!alias || alias.length > 80) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Integration grant alias is invalid",
    });
  }
  return {
    access: IntegrationAccessSchema.parse(value.access),
    alias,
    connectionId:
      value.connectionId === null ? null : IntegrationConnectionIdSchema.parse(value.connectionId),
    decision: "fulfilled",
    isDefault: value.isDefault,
  };
}

async function createIntegrationGrantForRequest(
  transaction: Transaction<DatabaseSchema>,
  input: Extract<IntegrationAccessDecision, { alias: string }> & {
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
    readonly requestedServerId: IntegrationServerId | null;
    readonly workspaceId: WorkspaceId;
  },
): Promise<IntegrationGrant> {
  const grantStore = new IntegrationGrantStore(transaction);
  if (input.requestedServerId) {
    const requestedServer = await transaction
      .selectFrom("integrationServers")
      .select("connectionRequirement")
      .where("id", "=", input.requestedServerId)
      .where("installationId", "=", input.installationId)
      .where("status", "=", "active")
      .executeTakeFirst();
    const requiresConnection =
      requestedServer &&
      IntegrationConnectionRequirementSchema.parse(requestedServer.connectionRequirement).kind !==
        "none";
    const usable =
      input.connectionId !== null &&
      (await grantStore.isConnectionUsableForAccessRequest({
        connectionId: input.connectionId,
        installationId: input.installationId,
        ownerUserId: input.ownerUserId,
        providerAuthorizations: input.providerAuthorizations,
        requestedServerId: input.requestedServerId,
      }));
    if (!requestedServer || (requiresConnection ? !usable : input.connectionId !== null)) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Grant targets a different integration server",
      });
    }
  }
  return grantStore.createGrantInTransaction(transaction, {
    access: input.access,
    alias: input.alias,
    connectionId: input.connectionId,
    createdBy: input.ownerUserId,
    installationId: input.installationId,
    isDefault: input.isDefault,
    ownerUserId: input.ownerUserId,
    providerAuthorizations: input.providerAuthorizations,
    workspaceId: input.workspaceId,
  });
}

async function assertMainIntegrationAccessUsable(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly connectionId: IntegrationConnectionId | null;
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
    readonly requestedServerId: IntegrationServerId | null;
  },
): Promise<void> {
  if (input.connectionId !== null) {
    const usable = await new IntegrationGrantStore(transaction).isConnectionUsableForAccessRequest({
      connectionId: input.connectionId,
      installationId: input.installationId,
      ownerUserId: input.ownerUserId,
      providerAuthorizations: input.providerAuthorizations,
      requestedServerId: input.requestedServerId,
    });
    if (usable) return;
  } else {
    const installation = await transaction
      .selectFrom("integrationInstallations")
      .select("id")
      .where("id", "=", input.installationId)
      .where("status", "=", "active")
      .executeTakeFirst();
    const servers = installation
      ? await transaction
          .selectFrom("integrationServers")
          .select("connectionRequirement")
          .where("installationId", "=", input.installationId)
          .where("status", "=", "active")
          .$if(input.requestedServerId !== null, (query) =>
            query.where("id", "=", input.requestedServerId!),
          )
          .execute()
      : [];
    const hasActiveSkill = installation
      ? (await transaction
          .selectFrom("integrationSkills")
          .select("id")
          .where("installationId", "=", input.installationId)
          .where("status", "=", "active")
          .limit(1)
          .executeTakeFirst()) !== undefined
      : false;
    if (
      installation &&
      ((input.requestedServerId === null && hasActiveSkill) ||
        servers.some(
          ({ connectionRequirement }) =>
            IntegrationConnectionRequirementSchema.parse(connectionRequirement).kind === "none",
        ))
    ) {
      return;
    }
  }
  throw new OpensteerError({
    code: "forbidden",
    message: "Integration account is not usable for this access request",
  });
}

async function insertIntegrationDetail(
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

async function terminalEvents(
  transaction: Transaction<DatabaseSchema>,
  request: Request,
): Promise<readonly AgentEvent[]> {
  if (request.status === "pending" || request.status === "cancelled") {
    throw new Error("Request resolution event requires a non-cancellation terminal state");
  }
  const event = await appendHostWorkspaceEvent(transaction, {
    data: { request },
    environmentId: await requestOriginEnvironment(transaction, request),
    runId: request.originatingRunId,
    threadId: request.originatingThreadId,
    type: "request.resolved",
    workspaceId: request.originatingWorkspaceId,
  });
  return [
    event,
    ...(request.originatingRunId
      ? await assignmentActivityEventsForRun(transaction, request.originatingRunId)
      : []),
  ];
}

type BrowserSignInRequestScope = {
  readonly requestId: RequestId;
  readonly ownerId: UserId;
  readonly scope?: {
    readonly sessionId: string;
    readonly site: string;
    readonly workspaceId: WorkspaceId;
  };
};

function pendingBrowserSignInMatches(
  row: RequestRow | undefined,
  input: BrowserSignInRequestScope,
): row is RequestRow {
  if (
    !row ||
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
    row.targetWorkspaceId === input.scope.workspaceId &&
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
 */
export async function fulfilBrowserSignInRequestInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: BrowserSignInRequestScope & { readonly response: BrowserSignInRequestResponse },
): Promise<{ readonly events: readonly AgentEvent[]; readonly request: Request } | null> {
  const matches = (row: RequestRow | undefined): row is RequestRow =>
    pendingBrowserSignInMatches(row, input);
  const observed = await transaction
    .selectFrom("requests")
    .selectAll()
    .where("id", "=", input.requestId)
    .executeTakeFirst();
  if (!matches(observed)) return null;
  await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
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
      response: jsonValue(response),
    })
    .where("id", "=", input.requestId)
    .where("status", "=", "pending")
    .returningAll()
    .executeTakeFirstOrThrow();
  const resolved = requestFromRow(resolvedRow);
  await enqueueContinuation(transaction, resolved, now);
  return { events: await terminalEvents(transaction, resolved), request: resolved };
}

async function enqueueContinuation(
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
  | { readonly decision: "declined" }
  | { readonly decision: "fulfilled"; readonly profileId: BrowserProfileId }
  | { readonly createProfile: { readonly name: string }; readonly decision: "fulfilled" }
  | { readonly decision: "fulfilled"; readonly name: string };

function parseBrowserDecision(value: Readonly<Record<string, unknown>>): BrowserDecision {
  if (value.decision === "declined" && Object.keys(value).length === 1) {
    return { decision: "declined" };
  }
  if (value.decision !== "fulfilled") {
    throw new OpensteerError({
      code: "bad_request",
      message: "Browser Request decision is invalid",
    });
  }
  if (typeof value.profileId === "string" && Object.keys(value).length === 2) {
    return { decision: "fulfilled", profileId: BrowserProfileIdSchema.parse(value.profileId) };
  }
  if (typeof value.name === "string" && Object.keys(value).length === 2) {
    return { decision: "fulfilled", name: boundedProfileName(value.name) };
  }
  if (
    value.createProfile &&
    typeof value.createProfile === "object" &&
    !Array.isArray(value.createProfile) &&
    Object.keys(value).length === 2
  ) {
    const profile = value.createProfile as Readonly<Record<string, unknown>>;
    if (typeof profile.name === "string" && Object.keys(profile).length === 1) {
      return {
        createProfile: { name: boundedProfileName(profile.name) },
        decision: "fulfilled",
      };
    }
  }
  throw new OpensteerError({ code: "bad_request", message: "Browser Request decision is invalid" });
}

function boundedProfileName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120) {
    throw new OpensteerError({ code: "bad_request", message: "Browser Profile name is invalid" });
  }
  return name;
}

type RequestOriginSelector = {
  readonly originatingOccurrenceId?: TriggerOccurrenceId | null;
  readonly originatingRunId?: RunId | null;
};

/** Narrows an origin-carrying input back to the exclusive pair `create` takes. */
function requestOriginOf(input: RequestOriginSelector): RequestOriginInput {
  if (input.originatingRunId != null) return { originatingRunId: input.originatingRunId };
  if (input.originatingOccurrenceId != null) {
    return { originatingOccurrenceId: input.originatingOccurrenceId };
  }
  throw new OpensteerError({
    code: "bad_request",
    message: "A Request must originate from a Run or a Trigger Occurrence",
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

function callIdentityFilter(input: { readonly callId: string } & RequestOriginSelector) {
  const origin = requestOriginOf(input);
  return (expression: ExpressionBuilder<DatabaseSchema, "requests">) =>
    expression.and([
      expression("callId", "=", input.callId),
      origin.originatingRunId === undefined
        ? expression("originatingOccurrenceId", "=", origin.originatingOccurrenceId)
        : expression("originatingRunId", "=", origin.originatingRunId),
    ]);
}

function integrationSubjectFilter(
  expression: ExpressionBuilder<DatabaseSchema, "integrationRequestDetails" | "requests">,
  subject: IntegrationRequestSubject,
) {
  return "definitionId" in subject
    ? expression(
        sql<string>`integration_request_details.manifest -> 'definition' ->> 'id'`,
        "=",
        subject.definitionId,
      )
    : expression(
        sql<string>`integration_request_details.manifest -> 'proposal' ->> 'digest'`,
        "=",
        subject.proposalDigest,
      );
}

function originMismatchMessage(input: RequestOriginSelector): string {
  return input.originatingRunId != null
    ? "Request origin does not match its signed Run authority"
    : "Request origin does not match its signed Trigger Occurrence authority";
}

type LockedRequestOrigin = {
  readonly environmentId: DatabaseSchema["runs"]["environmentId"];
  /** Present only for a Run, which signs the generation into its authority. */
  readonly membershipGeneration: number | null;
  readonly requestedBy: UserId;
  readonly running: boolean;
  readonly runId: RunId | null;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
};

async function lockRequestOrigin(
  transaction: Transaction<DatabaseSchema>,
  input: RequestOriginSelector,
  lock = true,
): Promise<LockedRequestOrigin | undefined> {
  const origin = requestOriginOf(input);
  if (origin.originatingRunId === undefined) {
    const occurrence = await transaction
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .select([
        "triggerOccurrences.environmentId",
        "triggerOccurrences.status",
        "triggers.anchorThreadId",
        "triggers.createdBy",
        "triggers.workspaceId",
      ])
      .where("triggerOccurrences.id", "=", origin.originatingOccurrenceId)
      .$if(lock, (query) => query.forNoKeyUpdate("triggerOccurrences"))
      .executeTakeFirst();
    if (!occurrence) return undefined;
    return {
      environmentId: occurrence.environmentId,
      membershipGeneration: null,
      requestedBy: occurrence.createdBy,
      runId: null,
      running: occurrence.status === "running",
      threadId: occurrence.anchorThreadId,
      workspaceId: occurrence.workspaceId,
    };
  }
  const run = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select([
      "runs.environmentId",
      "runs.id",
      "runs.membershipGeneration",
      "runs.requestedBy",
      "runs.status",
      "runs.threadId",
      "threads.workspaceId",
    ])
    .where("runs.id", "=", origin.originatingRunId)
    .$if(lock, (query) => query.forNoKeyUpdate("runs"))
    .executeTakeFirst();
  if (!run) return undefined;
  return {
    environmentId: run.environmentId,
    membershipGeneration: safeGeneration(run.membershipGeneration),
    requestedBy: run.requestedBy,
    runId: run.id,
    running: run.status === "running",
    threadId: run.threadId,
    workspaceId: run.workspaceId,
  };
}

type LockedWorkspaceAuthority = {
  readonly membership:
    | {
        readonly generation: string | number;
        readonly state: DatabaseSchema["workspaceMemberships"]["state"];
      }
    | undefined;
  readonly workspace:
    | {
        readonly kind: DatabaseSchema["workspaces"]["kind"];
        readonly status: DatabaseSchema["workspaces"]["status"];
      }
    | undefined;
};

type LockedRequestWorkspaceAuthorities = {
  readonly originatingMembership: LockedWorkspaceAuthority["membership"];
  readonly originatingWorkspace: LockedWorkspaceAuthority["workspace"];
  readonly targetMembership: LockedWorkspaceAuthority["membership"];
  readonly targetWorkspace: LockedWorkspaceAuthority["workspace"];
};

type ActiveRequestWorkspaceAuthorities = {
  readonly originatingMembership: NonNullable<LockedWorkspaceAuthority["membership"]>;
  readonly originatingWorkspace: NonNullable<LockedWorkspaceAuthority["workspace"]>;
  readonly targetMembership: NonNullable<LockedWorkspaceAuthority["membership"]>;
  readonly targetWorkspace: NonNullable<LockedWorkspaceAuthority["workspace"]>;
};

async function lockRequestWorkspaceAuthorities(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly originatingWorkspaceId: WorkspaceId;
    readonly requestedBy: UserId;
    readonly targetWorkspaceId: WorkspaceId;
  },
): Promise<LockedRequestWorkspaceAuthorities> {
  const workspaceIds = [...new Set([input.originatingWorkspaceId, input.targetWorkspaceId])].sort();
  await lockRequestWorkspaces(transaction, workspaceIds);
  const workspaces = new Map<WorkspaceId, LockedWorkspaceAuthority["workspace"]>();
  for (const row of await transaction
    .selectFrom("workspaces")
    .select(["id", "kind", "status"])
    .where("id", "in", workspaceIds)
    .execute())
    workspaces.set(row.id, row);

  // Membership writers own these Workspace fences before changing rows.
  const memberships = new Map<WorkspaceId, LockedWorkspaceAuthority["membership"]>();
  for (const workspaceId of workspaceIds) {
    const membership = await transaction
      .selectFrom("workspaceMemberships")
      .select(["generation", "state"])
      .where("workspaceId", "=", workspaceId)
      .where("userId", "=", input.requestedBy)
      .executeTakeFirst();
    memberships.set(workspaceId, membership);
  }

  return {
    originatingMembership: memberships.get(input.originatingWorkspaceId),
    originatingWorkspace: workspaces.get(input.originatingWorkspaceId),
    targetMembership: memberships.get(input.targetWorkspaceId),
    targetWorkspace: workspaces.get(input.targetWorkspaceId),
  };
}

function assertActiveRequestAuthority(
  authority: LockedRequestWorkspaceAuthorities,
  input: { readonly originatingMembershipGeneration?: number } = {},
): asserts authority is ActiveRequestWorkspaceAuthorities {
  if (
    !authority.originatingWorkspace ||
    authority.originatingWorkspace.status !== "ready" ||
    !authority.targetWorkspace ||
    authority.targetWorkspace.status !== "ready"
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "Request Workspace authority is not ready",
    });
  }
  if (
    !authority.originatingMembership ||
    authority.originatingMembership.state !== "active" ||
    !authority.targetMembership ||
    authority.targetMembership.state !== "active"
  ) {
    throw new OpensteerError({ code: "forbidden", message: "Request authority was revoked" });
  }
  if (
    input.originatingMembershipGeneration !== undefined &&
    safeGeneration(authority.originatingMembership.generation) !==
      input.originatingMembershipGeneration
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Request origin membership no longer matches its signed Run authority",
    });
  }
}

async function lockActiveDurableRequestAuthority(
  transaction: Transaction<DatabaseSchema>,
  request: Request,
): Promise<LockedRequestWorkspaceAuthorities> {
  if (request.mode !== "durable") {
    throw new OpensteerError({ code: "conflict", message: "Request is not durable" });
  }
  // Durable answers validate immutable origin fields; they do not depend on Run status.
  // The Workspace fences serialize changes to the authority that can revoke them.
  const origin = await lockRequestOrigin(transaction, request, false);
  if (
    !origin ||
    origin.threadId !== request.originatingThreadId ||
    origin.workspaceId !== request.originatingWorkspaceId ||
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
  const authority = await lockRequestWorkspaceAuthorities(transaction, request);
  assertActiveRequestAuthority(authority);
  return authority;
}

async function lockSavableBrowserSession(
  transaction: Transaction<DatabaseSchema>,
  sessionId: ReturnType<typeof BrowserSessionIdSchema.parse>,
  ownerId: UserId,
): Promise<{ readonly workspaceId: WorkspaceId }> {
  const session = await transaction
    .selectFrom("browserSessions")
    .innerJoin(
      "workspaceMemberships",
      "workspaceMemberships.workspaceId",
      "browserSessions.workspaceId",
    )
    .select("browserSessions.workspaceId")
    .where("browserSessions.id", "=", sessionId)
    .where("browserSessions.profileId", "is", null)
    .where("browserSessions.state", "=", "ready")
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .forNoKeyUpdate("browserSessions")
    .executeTakeFirst();
  if (!session) {
    throw new OpensteerError({
      code: "conflict",
      message: "The source Browser Session is no longer available to save",
    });
  }
  return session;
}

async function insertBrowserProfile(
  transaction: Transaction<DatabaseSchema>,
  input: PreparedBrowserProfile & { readonly ownerId: UserId },
): Promise<NonNullable<ResolvedBrowserRequest["profile"]>> {
  await assertBrowserProfileCapacity(transaction, input.ownerId);
  const profile = await transaction
    .insertInto("browserProfiles")
    .values({
      archivedAt: null,
      id: input.id,
      name: boundedProfileName(input.name),
      ownerId: input.ownerId,
      revision: input.revision,
    })
    .returning(["id", "name", "ownerId", "revision"])
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("browserProfileRevisions")
    .values({
      ciphertext: input.ciphertext,
      ciphertextSha256: input.ciphertextSha256,
      profileId: input.id,
      revision: input.revision,
    })
    .executeTakeFirstOrThrow();
  return profile;
}

async function assertBrowserProfileCapacity(
  transaction: Transaction<DatabaseSchema>,
  ownerId: UserId,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-profile:${ownerId}`}, 0))`.execute(
    transaction,
  );
  const active = await transaction
    .selectFrom("browserProfiles")
    .select("id")
    .where("ownerId", "=", ownerId)
    .where("archivedAt", "is", null)
    .limit(128)
    .execute();
  if (active.length >= 128) {
    throw new OpensteerError({ code: "conflict", message: "Browser profile limit reached" });
  }
}

async function ensureBrowserGrant(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly createdBy: UserId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<NonNullable<ResolvedBrowserRequest["grant"]>> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`browser-grants:${input.createdBy}`}, 0))`.execute(
    transaction,
  );
  // Under the grant lock a deletion also takes, so approval never grants a deleted profile.
  const profile = await transaction
    .selectFrom("browserProfiles")
    .select("archivedAt")
    .where("id", "=", input.profileId)
    .where("ownerId", "=", input.createdBy)
    .executeTakeFirst();
  if (!profile || profile.archivedAt) {
    throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
  }
  const existing = await transaction
    .selectFrom("browserProfileGrants")
    .select(["id", "createdAt", "profileId", "workspaceId"])
    .where("workspaceId", "=", input.workspaceId)
    .where("createdBy", "=", input.createdBy)
    .where("profileId", "=", input.profileId)
    .where("revokedAt", "is", null)
    .forNoKeyUpdate()
    .executeTakeFirst();
  // Approval selects authority to use; it need not create a new grant.
  // Check this before capacity, since reusing access consumes no additional slot.
  if (existing) {
    return {
      access: "full-control",
      createdAt: existing.createdAt,
      grantId: existing.id,
      profileId: existing.profileId,
      workspaceId: existing.workspaceId,
    };
  }
  const active = await transaction
    .selectFrom("browserProfileGrants")
    .innerJoin("browserProfiles", "browserProfiles.id", "browserProfileGrants.profileId")
    .select("browserProfileGrants.id")
    .where("browserProfileGrants.revokedAt", "is", null)
    .where("browserProfiles.ownerId", "=", input.createdBy)
    .limit(100)
    .execute();
  if (active.length >= 100) {
    throw new OpensteerError({
      code: "resource_exhausted",
      message: "Active browser grant limit reached",
    });
  }
  const row = await transaction
    .insertInto("browserProfileGrants")
    .values({
      access: "full-control",
      createdBy: input.createdBy,
      id: createId("browserProfileGrant"),
      profileId: input.profileId,
      revokedAt: null,
      workspaceId: input.workspaceId,
    })
    .returning(["access", "createdAt", "id", "profileId", "workspaceId"])
    .executeTakeFirstOrThrow();
  return {
    access: "full-control",
    createdAt: row.createdAt,
    grantId: row.id,
    profileId: row.profileId,
    workspaceId: row.workspaceId,
  };
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
      exists (
        select 1 from public.workspace_memberships as membership
        where membership.workspace_id = worker.workspace_id
          and membership.user_id = ${userId} and membership.state = 'active'
      ) and exists (
        select 1 from public.workspace_memberships as membership
        where membership.workspace_id = parent.workspace_id
          and membership.user_id = ${userId} and membership.state = 'active'
      ) as readable
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

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Request page limit must be an integer from 1 through 500",
    });
  }
  return limit;
}
