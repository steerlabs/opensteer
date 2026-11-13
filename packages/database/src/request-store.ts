import { getBrowserSessionForOwner } from "./browser-session-store.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalReadTransaction, withPersonalTransaction } from "./personal-transaction.js";
import { lockBrowserHomeRunner } from "./browser-home-store.js";
import { assertActiveGrant } from "./execution-authority.js";
import { ReplyTargetSchema } from "@opensteer/core";
import { enqueueChannelConversationStatus } from "./channel-deliveries.js";
import { requestSettlementActor, readRequestSettlementProvenance } from "./request-settlement.js";
import {
  AssignmentIdSchema,
  BrowserProfileIdSchema,
  OpensteerError,
  PendingRequestSchema,
  ResolvedRequestSchema,
  RequestIdSchema,
  RequestJsonObjectSchema,
  RequestResponseSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  browserSessionClosedReason,
  createId,
  type AgentEvent,
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
  type UserId,
  type WaitingRequest,
} from "@opensteer/core";
import {
  ComputerAppIdentitySchema,
  IntegrationAccessSchema,
  IntegrationConnectionIdSchema,
  IntegrationConnectionRequirementSchema,
  IntegrationInstallManifestSchema,
  IntegrationInstallationSchema,
  computerAppIdentitiesEqual,
  integrationAccessCovers,
  integrationInstallManifestSummary,
  integrationProposalName,
  type ComputerAppIdentity,
  type ComputerAppSetupRequest,
  type IntegrationAccess,
  type IntegrationGrant,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationInstallManifest,
  type IntegrationInstallationId,
  type IntegrationProviderAuthorization,
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
import { isDeepStrictEqual } from "node:util";
import {
  assignmentActivityEventsForRun,
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
import {
  IntegrationGrantStore,
  approveComputerAppAutomaticallyInTransaction,
  installIntegrationInTransaction,
  lockIntegrationCatalogDefinitionInTransaction,
  lockIntegrationInstallationIdentityInTransaction,
  type InstallIntegrationInput,
  type InstallIntegrationMutation,
} from "./integration-platform-stores.js";
import { deviceAccessStates } from "./device-store.js";
import { machineOwnershipIn, machineIsManagedBy } from "./machine-ownership.js";
import { cancelPending } from "./request-cancellation.js";
import { requestFromRow, requestInsert, requestOriginEnvironment } from "./request-persistence.js";
import { insertBrowserProfileOnLockedHome } from "./browser-session-store.js";
import { runHasActiveGrant } from "./run-grants.js";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import { jsonValue, threadPathLinks, type ChannelLinks } from "./store-primitives.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
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
      readonly originatingRunId: RunId;
    }
  | {
      readonly originatingOccurrenceId: TriggerOccurrenceId;
      readonly originatingRunId?: never;
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
export type ComputerAppAccessDecision =
  | {
      readonly connection: IntegrationConnectionSummary;
      readonly kind: "approved";
      readonly requestEvents: readonly AgentEvent[];
    }
  | {
      readonly kind: "personal-grant";
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
  | {
      readonly definitionId: string;
      readonly kind: "integration.install";
    }
  | {
      readonly kind: "integration.install";
      readonly proposalDigest: string;
    };
export interface RequestMutation {
  readonly events: readonly AgentEvent[];
  readonly replayed: boolean;
  readonly request: Request;
}
export interface ResolvedBrowserRequest {
  readonly events: readonly AgentEvent[];
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
interface PendingIntegrationAccessRequest {
  readonly access: IntegrationAccess;
  readonly installationId: IntegrationInstallationId;
  readonly request: Request;
  readonly requestedConnectionId: IntegrationConnectionId | null;
  readonly requestedServerId: IntegrationServerId | null;
}
interface ResolvedIntegrationAccessRequest {
  readonly events: readonly AgentEvent[];
  readonly request: Request;
  readonly grant: IntegrationGrant | null;
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
  async #pendingTriggerEquivalent(
    input: RequestOriginInput & {
      readonly requestedBy: UserId;
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
      .where((expression) => integrationSubjectFilter(expression, subject))
      .orderBy("requests.createdAt", "asc")
      .orderBy("requests.id", "asc")
      .limit(1)
      .executeTakeFirst();
    return row
      ? {
          events: [],
          replayed: true,
          request: requestFromRow(row),
        }
      : null;
  }
  async createDeviceAccessRequest(
    input: {
      readonly callId: string;
      readonly machineId: RunnerId;
      readonly access: "browser" | "apps" | "files";
      readonly reason: string;
      readonly originatingRunId: RunId;
      readonly originatingThreadId: ThreadId;
      readonly requestedBy: UserId;
    },
    isOnline: () => boolean,
  ): Promise<RequestMutation> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      const machine = await transaction
        .selectFrom("runners")
        .select("name")
        .where("id", "=", input.machineId)
        .executeTakeFirst();
      if (!machine)
        throw new OpensteerError({ code: "forbidden", message: "Owned device not found" });
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
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<{ events: readonly AgentEvent[]; request: Request }> {
    const value = input.response.kind === "external" ? input.response.value : undefined;
    if (!value || Object.keys(value).length !== 1 || value.decision !== "declined")
      throw new OpensteerError({
        code: "bad_request",
        message:
          "Turn device access on through machine.access.update; this response can only decline.",
      });
    return withPersonalTransaction(this.#database, async (transaction) => {
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (!row || row.kind !== "device.access" || row.payload.kind !== "device.access")
        throw new OpensteerError({ code: "not_found", message: "Device access Request not found" });
      const ownership = await machineOwnershipIn(transaction, row.payload.machineId);
      if (!ownership || !machineIsManagedBy(ownership, input.resolvedBy))
        throw new OpensteerError({
          code: "forbidden",
          message: "Only this device's owner can answer its access Request.",
        });
      if (row.status !== "pending")
        throw new OpensteerError({
          code: "conflict",
          message: "Device access Request is no longer pending",
        });
      await lockActiveDurableRequestAuthority(transaction, requestFromRow(row));
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
      return { events: await terminalEvents(transaction, request), request };
    });
  }
  async create(input: CreateRequestInput): Promise<RequestMutation> {
    return withPersonalTransaction(this.#database, async (personalTransaction) => {
      await (async (transaction) => {
        await lockRequestOrigin(transaction, input);
      })(personalTransaction);
      return ((transaction) => createRequestInTransaction(this.#links, transaction, input))(
        personalTransaction,
      );
    });
  }
  async createIntegrationInstallRequest(
    input: {
      readonly callId: string;
      readonly manifest: IntegrationInstallManifest;
      readonly originatingThreadId: ThreadId;
      readonly reason: string;
      readonly requestedBy: UserId;
    } & RequestOriginInput,
  ): Promise<RequestMutation> {
    const manifest = IntegrationInstallManifestSchema.parse(input.manifest);
    const equivalent = await this.#pendingTriggerEquivalent(input, {
      kind: "integration.install",
      ...(manifest.kind === "catalog"
        ? {
            definitionId: manifest.definition.id,
          }
        : {
            proposalDigest: manifest.proposal.digest,
          }),
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
      payload: {
        kind: "integration.install",
        manifest: RequestJsonObjectSchema.parse(integrationInstallManifestSummary(manifest)),
        reason: input.reason,
      },
      presentation: {
        ...(manifest.kind === "proposal"
          ? {
              agentProposed: true,
            }
          : {}),
        detail: input.reason,
        kind: "choice",
        options: [
          {
            hint: "reject-once",
            id: "declined",
            label: "Not now",
          },
          {
            hint: "confirm",
            id: "installed",
            label: "Install",
          },
        ],
        risk: "high",
        title: `Install ${integrationInstallDisplayName(manifest)}?`,
      },
      requestedBy: input.requestedBy,
      requiredActor: "owner",
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
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<ResolvedIntegrationAccessRequest> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      const response = withoutClientIntegrationAccount(RequestResponseSchema.parse(input.response));
      const decision = parseIntegrationAccessDecision(response);
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
            settlementProvenance: await readRequestSettlementProvenance(
              transaction,
              input.resolvedBy,
              input.settlementSessionId,
            ),
            response: jsonValue(response),
            status: "declined",
          })
          .where("id", "=", input.requestId)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();
        const declined = requestFromRow(declinedRow);
        await enqueueContinuation(transaction, declined, now);
        await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
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
      const grant =
        decision.decision === "fulfilled"
          ? await createPersonalIntegrationGrantForRequest(transaction, {
              ...decision,
              installationId: row.detailInstallationId,
              ownerUserId: input.resolvedBy,
              providerAuthorizations: input.providerAuthorizations,
              requestedServerId: row.detailRequestedServerId,
            })
          : null;
      // Resource and grant fences precede Request projection; a changed discovery

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
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
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
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return {
        events: [...coveredEvents, ...(await terminalEvents(transaction, resolved))],
        grant,
        request: resolved,
      };
    });
  }
  async resolveIntegrationInstallRequest(input: {
    readonly preparedFulfillment?: PreparedIntegrationInstallFulfillment;
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<ResolvedIntegrationInstallRequest> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      await requirePersonalOwner(transaction, input.resolvedBy);
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
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
          response: jsonValue(response),
          status: fulfilled ? "fulfilled" : "declined",
        })
        .where("id", "=", input.requestId)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(resolvedRow);
      await enqueueContinuation(transaction, request, now);
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return {
        events: await terminalEvents(transaction, request),
        installation: installationMutation?.installation ?? null,
        request,
        requestEvents: installationMutation?.requestEvents ?? [],
      };
    });
  }
  async loadIntegrationInstallManifest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
  }): Promise<IntegrationInstallManifest> {
    await requirePersonalOwner(this.#database, input.resolvedBy);
    const row = await this.#database
      .selectFrom("requests")
      .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
      .innerJoin("users", (join) => join.on("users.id", "=", input.resolvedBy))
      .select("integrationRequestDetails.manifest")
      .where("requests.id", "=", input.requestId)
      .where("requests.kind", "=", "integration.install")
      .where("requests.status", "=", "pending")
      .executeTakeFirst();
    if (!row?.manifest) {
      throw new OpensteerError({
        code: "conflict",
        message: "Installation Request is unavailable or the personal owner is required",
      });
    }
    return IntegrationInstallManifestSchema.parse(row.manifest);
  }
  async loadIntegrationAccessInstallManifest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
  }): Promise<IntegrationInstallManifest> {
    await requirePersonalOwner(this.#database, input.resolvedBy);
    const row = await this.#database
      .selectFrom("requests")
      .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
      .innerJoin("users", (join) => join.on("users.id", "=", input.resolvedBy))
      .select(["integrationRequestDetails.installationId", "integrationRequestDetails.manifest"])
      .where("requests.id", "=", input.requestId)
      .where("requests.kind", "=", "integration.access")
      .where("requests.status", "=", "pending")
      .executeTakeFirst();
    if (!row?.manifest || row.installationId !== null) {
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
    readonly settlementSessionId?: string;
  }): Promise<BoundIntegrationAccessInstallation | null> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      await requirePersonalOwner(transaction, input.resolvedBy);
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
      if (!current || !installedIntegrationMatchesReviewedManifest(current, manifest)) return null;
      const bound = await bindIntegrationAccessInstallation(transaction, {
        installation: integrationInstallationFromRequestRow(current),
        requestEvents: [],
        requestId: input.requestId,
      });
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return bound;
    });
  }
  async installForIntegrationAccessRequest(input: {
    readonly preparedFulfillment: PreparedIntegrationInstallFulfillment;
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
  }): Promise<BoundIntegrationAccessInstallation> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      await requirePersonalOwner(transaction, input.resolvedBy);
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
      const exactCurrent =
        current && currentIntegrationMatchesPrepared(current, input.preparedFulfillment.material);
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
      const bound = await bindIntegrationAccessInstallation(transaction, {
        installation: installationMutation.installation,
        requestEvents: installationMutation.requestEvents,
        requestId: input.requestId,
      });
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return bound;
    });
  }
  async selectIntegrationAccessServer(input: {
    readonly requestId: RequestId;
    readonly requestedServerId: IntegrationServerId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
  }): Promise<SelectedIntegrationAccessServer> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      const previous = requestFromRow(row);
      if (previous.payload.kind !== "integration.access")
        throw new Error("Invalid Request payload");
      const payload = {
        ...previous.payload,
        requestedServerId: server.id,
      } satisfies RequestPayload;
      await transaction
        .updateTable("integrationRequestDetails")
        .set({
          requestedServerId: server.id,
        })
        .where("requestId", "=", input.requestId)
        .where("requestedServerId", "is", null)
        .executeTakeFirstOrThrow();
      const updated = await transaction
        .updateTable("requests")
        .set({
          payload: jsonValue(payload),
        })
        .where("id", "=", input.requestId)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(updated);
      const event = await appendHostDeploymentEvent(transaction, {
        data: {
          request: PendingRequestSchema.parse(request),
        },
        environmentId: await requestOriginEnvironment(transaction, request),
        runId: request.originatingRunId,
        threadId: request.originatingThreadId,
        type: "request.updated",
      });
      return {
        events: [event],
        request,
      };
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
  async settleIntegrationInput(input: {
    readonly caller: Parameters<typeof assertActiveGrant>[1];
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly action: "accept" | "decline" | "cancel";
  }): Promise<RequestMutation> {
    return withPersonalTransaction(this.#database, async (personalTransaction) => {
      await (async (transaction) => {
        const request = await transaction
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", input.requestId)
          .executeTakeFirst();
        if (request) {
          const origin = await lockRequestOrigin(transaction, request);
          if (!origin?.running)
            throw new OpensteerError({
              code: "conflict",
              message: "The calling Run has ended",
            });
        }
      })(personalTransaction);
      return (async (transaction) => {
        const observed = await transaction
          .selectFrom("requests")
          .selectAll()
          .where("id", "=", input.requestId)
          .executeTakeFirst();
        if (
          !observed ||
          observed.kind !== "integration.input" ||
          observed.status !== "pending" ||
          observed.originatingRunId !== input.caller.runId ||
          observed.requestedBy !== input.resolvedBy
        )
          throw new OpensteerError({
            code: "conflict",
            message: "Device input is no longer pending",
          });
        const pending = requestFromRow(observed);
        await lockActiveDurableRequestAuthority(transaction, pending);
        await assertActiveGrant(transaction, input.caller, this.#executionNow);
        if (
          pending.presentation.kind !== "form" ||
          pending.presentation.fields.some((field) => !field.secret)
        )
          throw new Error("Device input requires secret form fields");
        const response: RequestResponse =
          input.action === "accept"
            ? {
                kind: "form",
                answers: Object.fromEntries(
                  pending.presentation.fields.map((field) => [field.id, []]),
                ),
              }
            : {
                kind: "external",
                value: {
                  decision: input.action,
                },
              };
        const row = await transaction
          .updateTable("requests")
          .set({
            status: input.action === "accept" ? "fulfilled" : "declined",
            resolvedAt: new Date(),
            resolvedBy: input.resolvedBy,
            response: jsonValue(response),
            settlementProvenance: await readRequestSettlementProvenance(
              transaction,
              input.resolvedBy,
              input.settlementSessionId,
            ),
          })
          .where("id", "=", input.requestId)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirst();
        if (!row)
          throw new OpensteerError({
            code: "conflict",
            message: "Device input is no longer pending",
          });
        await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
        const request = requestFromRow(row);
        return {
          request,
          events: await terminalEvents(transaction, request),
          replayed: false,
        };
      })(personalTransaction);
    });
  }
  async cancelIntegrationInputs(
    reason: RequestCancellationReason,
    requestId?: RequestId,
  ): Promise<readonly AgentEvent[]> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      const rows = await transaction
        .selectFrom("requests")
        .select("id")
        .where("kind", "=", "integration.input")
        .where("status", "=", "pending")
        .$if(requestId !== undefined, (query) => query.where("id", "=", requestId!))
        .execute();
      return cancelPending(transaction, {
        reason,
        resolvedAt: new Date(),
        requestIds: rows.map(({ id }) => id),
      });
    });
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
  }): Promise<{ readonly requests: readonly WaitingRequest[]; readonly window: DurableWindow }> {
    const limit = clampLimit(input.limit);
    const scope = `waiting:${input.userId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    return withPersonalReadTransaction(
      this.#database,
      async (transaction) => {
        await requirePersonalOwner(transaction, input.userId);
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
                .selectFrom("executionNodes")
                .select(["id", "title"])
                .where("id", "in", askingNodeIds)
                .execute()
            : []
          ).map((node) => [node.id, node]),
        );
        return {
          requests: requests.map((request) => ({
            assignments: held.get(request.id) ?? [],
            presentation: null,
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

  async connectionPage(input: { userId: UserId; before?: string; limit: number }) {
    const limit = clampLimit(input.limit);
    const scope = `connection:${input.userId}`;
    const anchor = input.before ? decodeRequestCursor(input.before, scope) : null;
    await requirePersonalOwner(this.#database, input.userId);
    let query = this.#database.selectFrom("requests").selectAll("requests");
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
    return withPersonalTransaction(this.#database, async (personalTransaction) => {
      await ((transaction) => lockRequestOrigin(transaction, origin))(personalTransaction);
      return (async (transaction) => {
        const runner = await lockComputerApprovalScopeInTransaction(transaction, {
          runnerId: input.runnerId,
        });
        const ownership =
          runner.revokedAt === null ? await machineOwnershipIn(transaction, runner.id) : null;
        if (runner.revokedAt !== null) {
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
            message: `${app?.displayName ?? runner.name} is blocked on ${runner.name}. The owner can unblock it from any Opensteer app.`,
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
          });
          return {
            connection: approved.connection,
            kind: "approved",
            requestEvents: approved.requestEvents,
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
                `computer.app.grant:${input.definitionId}:${input.runnerId}:${scope.appKey ?? ""}:${access}`,
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
          },
        });
        const setupRequest = computerAppSetupRequestFromRow(row);
        const mutation = await createRequestInTransaction(this.#links, transaction, {
          ...origin,
          callId:
            input.idempotencyKey ??
            `computer.app.access:${input.definitionId}:${input.runnerId}:${scope.appKey ?? ""}:${access}`,
          kind: "computer.app.access",
          mode: "durable",
          originatingThreadId: input.threadId,
          payload: {
            access,
            app,
            definitionId: input.definitionId,
            kind: "computer.app.access",
            reason: input.reason,
            runnerId: input.runnerId,
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
          requestEvents: [...settlement.requestEvents, ...mutation.events],
          setupRequest,
        };
      })(personalTransaction);
    });
  }

  async declineComputerAppAccessRequest(input: {
    readonly actorUserId: UserId;
    readonly settlementSessionId?: string;
    readonly requestId: RequestId;
    readonly response?: RequestResponse;
  }): Promise<{
    events: readonly AgentEvent[];
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
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      return {
        events: await terminalEvents(transaction, request),
        request,
      };
    });
  }
  async declineMachineFullDiskAccessRequest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<{
    events: readonly AgentEvent[];
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
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      return {
        events: await terminalEvents(transaction, request),
        request,
      };
    });
  }
  async fulfillMachineFullDiskAccessRequests(machineId: RunnerId): Promise<{
    events: AgentEvent[];
    requests: Request[];
  }> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
        events.push(...(await terminalEvents(transaction, request)));
        requests.push(request);
      }
      return {
        events,
        requests,
      };
    });
  }
  async resolveBrowserRequest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<ResolvedBrowserRequest> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      await lockActiveDurableRequestAuthority(transaction, observedRequest);
      if (creation && "profileId" in creation) {
        await transaction
          .selectFrom("browserProfiles")
          .select("id")
          .where("id", "=", creation.profileId)
          .forShare()
          .executeTakeFirst();
      }
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
      return {
        events: await terminalEvents(transaction, resolved),
        profile,
        request: resolved,
      };
    });
  }

  /** The owner said no: the agent is told not to ask for this site again. */
  async declineBrowserSignInRequest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
  }): Promise<RequestMutation> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
          events: [],
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
      await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
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
      return {
        events: await terminalEvents(transaction, resolved),
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
    readonly events: readonly AgentEvent[];
    readonly request: Request;
  } | null> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
  }): Promise<boolean> {
    return withPersonalReadTransaction(this.#database, async (transaction) => {
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .executeTakeFirst();
      if (
        !row ||
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
    return withPersonalTransaction(this.#database, async (personalTransaction) => {
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
            events: [],
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
              events: [],
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
  async settlePasswordSignInRequest(input: {
    readonly ownerId: UserId;
    readonly settlementSessionId?: string;
    readonly requestId: RequestId;
    readonly settlement:
      | {
          readonly status: "declined";
        }
      | {
          readonly status: "fulfilled";
          readonly response: PasswordSignInRequestResponse;
        };
  }): Promise<{
    readonly events: readonly AgentEvent[];
    readonly request: Request;
  } | null> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!eligible(row)) return null;
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
      return {
        events: await terminalEvents(transaction, resolved),
        request: resolved,
      };
    });
  }
  async withdraw(input: {
    readonly requestId: RequestId;
    readonly threadId: ThreadId;
    readonly withdrawnBy: UserId;
  }): Promise<RequestMutation> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
          events: [],
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
      return {
        events: await terminalEvents(transaction, request),
        replayed: false,
        request,
      };
    });
  }
  async cancelForRun(
    runId: RunId,
    reason: RequestCancellationReason,
    resolvedAt = new Date(),
  ): Promise<readonly AgentEvent[]> {
    return withPersonalTransaction(this.#database, (transaction) =>
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
    return withPersonalTransaction(this.#database, async (transaction) => {
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
  async listPendingContinuations(limit = 100): Promise<readonly PendingRequestContinuation[]> {
    const pending = this.#database
      .selectFrom("requestContinuations")
      .innerJoin("requests", "requests.id", "requestContinuations.requestId")
      .selectAll("requests")
      .select([
        "requestContinuations.attemptedAt as continuationAttemptedAt",
        "requestContinuations.reason as continuationReason",
        "requestContinuations.status as continuationStatus",
      ])
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
      )
      .orderBy(sql`request_continuations.attempted_at asc nulls first`)
      .orderBy("requestContinuations.createdAt", "asc")
      .orderBy("requests.id", "asc");
    const page = await pending
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
  readonly reason: string;
  readonly requestedConnectionId?: IntegrationConnectionId | null;
  readonly requestedBy: UserId;
  readonly requestedServerId: IntegrationServerId | null;
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
      ...(agentProposed
        ? {
            agentProposed: true,
          }
        : {}),
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
      events: [],
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
        message: "Use device_access_request for device access.",
      });
    const payload = input.payload;
    const runner = await transaction
      .selectFrom("runners")
      .select(["accessPolicy", "allowedModules", "moduleDescriptors", "revokedAt", "kind"])
      .where("id", "=", payload.machineId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const ownership = await machineOwnershipIn(transaction, payload.machineId);
    if (
      !runner ||
      runner.revokedAt ||
      runner.kind === "managed" ||
      !ownership ||
      !machineIsManagedBy(ownership, input.requestedBy)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Only an owned active device can receive an access Request.",
      });
    if (!deviceOnline())
      throw new OpensteerError({
        code: "runner_offline",
        reason: "device-offline",
        message: "That device is offline. Do not request access while it is offline.",
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
    if (duplicate) return { replayed: true, request: requestFromRow(duplicate), events: [] };
    const state = deviceAccessStates(
      runner.accessPolicy,
      runner.allowedModules,
      runner.moduleDescriptors,
      runner.kind === "main" && ownership.ownerKind === "deployment",
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
  if (input.kind === "integration.access" || input.kind === "integration.install") {
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
        events: [],
        replayed: true,
        request: requestFromRow(duplicate),
      };
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
      return {
        events: [],
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
    return {
      events: [],
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
    if (run.replyTarget && !sibling) {
      const target = ReplyTargetSchema.parse(run.replyTarget);
      await enqueueChannelConversationStatus(transaction, {
        conversationId: target.conversationId,
        text: `The agent has asked for your input. Open the Thread in Opensteer: ${links.threadUrl(canonical.originatingThreadId)}`,
      });
    }
  }
  const event = await appendHostDeploymentEvent(transaction, {
    data: {
      request: PendingRequestSchema.parse(canonical),
    },
    environmentId: origin.environmentId,
    runId: origin.runId,
    threadId: origin.threadId,
    type: "request.opened",
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
  readonly sourceKind: "plugin" | "built-in" | "proposed" | "remote-mcp";
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
    .set({
      installationId: input.installation.id,
      requestedServerId,
    })
    .where("requestId", "=", input.requestId)
    .where("installationId", "is", null)
    .executeTakeFirstOrThrow();
  const updatedRow = await transaction
    .updateTable("requests")
    .set({
      payload: jsonValue(payload),
    })
    .where("id", "=", input.requestId)
    .where("status", "=", "pending")
    .returningAll()
    .executeTakeFirstOrThrow();
  const request = requestFromRow(updatedRow);
  const event = await appendHostDeploymentEvent(transaction, {
    data: {
      request: PendingRequestSchema.parse(request),
    },
    environmentId: await requestOriginEnvironment(transaction, request),
    runId: request.originatingRunId,
    threadId: request.originatingThreadId,
    type: "request.updated",
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
    value: RequestJsonObjectSchema.parse({
      ...response.value,
      account,
    }),
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
  const value = {
    ...response.value,
  };
  delete value.account;
  return {
    kind: "external",
    value: RequestJsonObjectSchema.parse(value),
  };
}
type IntegrationAccessDecision =
  | { readonly decision: "declined" }
  | {
      readonly decision: "fulfilled";
      readonly access: IntegrationAccess;
      readonly alias: string;
      readonly connectionId: IntegrationConnectionId | null;
      readonly isDefault: boolean;
    };
function parseIntegrationAccessDecision(response: RequestResponse): IntegrationAccessDecision {
  if (response.kind !== "external" || !response.value)
    throw new OpensteerError({
      code: "bad_request",
      message: "Integration Request response is invalid",
    });
  const value = response.value;
  if (value.decision === "declined") return { decision: "declined" };
  if (
    value.decision !== "fulfilled" ||
    !IntegrationAccessSchema.safeParse(value.access).success ||
    typeof value.alias !== "string" ||
    typeof value.isDefault !== "boolean" ||
    !("connectionId" in value) ||
    (value.connectionId !== null && typeof value.connectionId !== "string")
  )
    throw new OpensteerError({
      code: "bad_request",
      message: "Choose the personal account and access to grant.",
    });
  const alias = value.alias.trim();
  if (!alias || alias.length > 80)
    throw new OpensteerError({
      code: "bad_request",
      message: "Integration grant alias is invalid",
    });
  return {
    decision: "fulfilled",
    access: IntegrationAccessSchema.parse(value.access),
    alias,
    isDefault: value.isDefault,
    connectionId:
      value.connectionId === null ? null : IntegrationConnectionIdSchema.parse(value.connectionId),
  };
}
async function createPersonalIntegrationGrantForRequest(
  transaction: Transaction<DatabaseSchema>,
  input: Extract<IntegrationAccessDecision, { alias: string }> & {
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
    readonly requestedServerId: IntegrationServerId | null;
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
  const event = await appendHostDeploymentEvent(transaction, {
    data: {
      request: ResolvedRequestSchema.parse(request),
    },
    environmentId: await requestOriginEnvironment(transaction, request),
    runId: request.originatingRunId,
    threadId: request.originatingThreadId,
    type: "request.resolved",
  });
  return [
    event,
    ...(request.originatingRunId
      ? await assignmentActivityEventsForRun(transaction, request.originatingRunId)
      : []),
  ];
}
type BrowserSignInRequestScope = {
  readonly settlementSessionId?: string;
  readonly requestId: RequestId;
  readonly ownerId: UserId;
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
  readonly events: readonly AgentEvent[];
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
  return {
    events: await terminalEvents(transaction, resolved),
    request: resolved,
  };
}
async function enqueueContinuation(
  transaction: Transaction<DatabaseSchema>,
  request: Request,
  createdAt: Date,
): Promise<void> {
  if (
    request.kind === "integration.input" ||
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
  readonly originatingRunId?: RunId | null;
};

/** Narrows an origin-carrying input back to the exclusive pair `create` takes. */
function requestOriginOf(input: RequestOriginSelector): RequestOriginInput {
  if (input.originatingRunId != null)
    return {
      originatingRunId: input.originatingRunId,
    };
  if (input.originatingOccurrenceId != null) {
    return {
      originatingOccurrenceId: input.originatingOccurrenceId,
    };
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
function callIdentityFilter(
  input: {
    readonly callId: string;
  } & RequestOriginSelector,
) {
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
async function lockActiveDurableRequestAuthority(
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
  machineId: RunnerId,
  policy: MachineAccessPolicy,
): Promise<readonly AgentEvent[]> {
  const access = deviceAccess(policy);
  const ownership = await machineOwnershipIn(transaction, machineId);
  const rows = await transaction
    .selectFrom("requests")
    .selectAll()
    .where("kind", "=", "device.access")
    .where("status", "=", "pending")
    .where(sql<string>`payload->>'machineId'`, "=", machineId)
    .orderBy("id")
    .execute();
  const events: AgentEvent[] = [];
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
      events.push(
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
    events.push(...(await terminalEvents(transaction, fulfilled)));
  }
  return events;
}
