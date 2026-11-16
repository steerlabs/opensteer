import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { requestSettlementActor, readRequestSettlementProvenance } from "./request-settlement.js";
import {
  OpensteerError,
  PendingRequestSchema,
  RequestJsonObjectSchema,
  RequestResponseSchema,
  type AgentEvent,
  type Request,
  type RequestId,
  type RequestPayload,
  type RequestResponse,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  IntegrationAccessSchema,
  IntegrationConnectionIdSchema,
  IntegrationConnectionRequirementSchema,
  IntegrationInstallManifestSchema,
  IntegrationInstallationSchema,
  integrationInstallManifestSummary,
  type IntegrationAccess,
  type IntegrationGrant,
  type IntegrationConnectionId,
  type IntegrationInstallManifest,
  type IntegrationInstallationId,
  type IntegrationProviderAuthorization,
  type IntegrationServerId,
} from "@opensteer/integration-core";
import { sql, type Kysely, type Transaction } from "kysely";
import { isDeepStrictEqual } from "node:util";
import "./connection.js";
import {
  IntegrationGrantStore,
  installIntegrationInTransaction,
  lockIntegrationInstallationIdentityInTransaction,
  type InstallIntegrationInput,
  type InstallIntegrationMutation,
} from "./integration-platform-stores.js";
import { requestFromRow, requestOriginEnvironment } from "./request-persistence.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import {
  enqueueContinuation,
  integrationAccessRequestInput,
  integrationInstallDisplayName,
  lockAndValidateIntegrationAccessResources,
  type IntegrationAccessRequestInput,
  lockActiveDurableRequestAuthority,
  requestOriginOf,
  terminalEvents,
  type RequestMutation,
  type RequestOriginInput,
  type RequestStore,
} from "./request-store.js";

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
 * Requests for service integrations: installing one, and access to an
 * installation's account, with the grants their fulfilment writes in the same
 * transaction. Device access and setup Requests stay with `RequestStore`.
 */
export class IntegrationRequestStore {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #requests: Pick<RequestStore, "create" | "pendingTriggerEquivalent">;

  constructor(
    database: Kysely<DatabaseSchema>,
    requests: Pick<RequestStore, "create" | "pendingTriggerEquivalent">,
  ) {
    this.#database = database;
    this.#requests = requests;
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
    const equivalent = await this.#requests.pendingTriggerEquivalent(input, {
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
    return this.#requests.create({
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
    return this.#requests.create(await integrationAccessRequestInput(this.#database, input));
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
