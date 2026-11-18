import { requirePersonalOwner } from "./personal-settings-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { requestSettlementActor, readRequestSettlementProvenance } from "./request-settlement.js";
import {
  OpensteerError,
  RequestJsonObjectSchema,
  RequestResponseSchema,
  type Request,
  type RequestId,
  type RequestPayload,
  type RequestResponse,
  type UserId,
} from "@opensteer/core";
import {
  IntegrationAccessSchema,
  IntegrationConnectionIdSchema,
  IntegrationConnectionRequirementSchema,
  IntegrationInstallManifestSchema,
  IntegrationInstallationSchema,
  type IntegrationAccess,
  type IntegrationGrant,
  type IntegrationConnectionId,
  type IntegrationInstallManifest,
  type IntegrationInstallationId,
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
import {
  assertRequestRevision,
  refreshRequestState,
  requestFromRow,
} from "./request-persistence.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import {
  enqueueContinuation,
  integrationAccessRequestInput,
  lockAndValidateIntegrationAccessResources,
  type IntegrationAccessRequestInput,
  lockActiveDurableRequestAuthority,
  type RequestMutation,
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
  readonly request: Request;
  readonly grant: IntegrationGrant | null;
}
interface BoundIntegrationAccessInstallation {
  readonly installation: InstallIntegrationMutation["installation"];
  readonly request: Request;
}
interface SelectedIntegrationAccessServer {
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

/** Device app and local-server access, settled with their grants in one transaction. */
export class IntegrationRequestStore {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #requests: Pick<RequestStore, "create">;

  constructor(database: Kysely<DatabaseSchema>, requests: Pick<RequestStore, "create">) {
    this.#database = database;
    this.#requests = requests;
  }

  async createIntegrationAccessRequest(
    input: IntegrationAccessRequestInput,
  ): Promise<RequestMutation> {
    return this.#requests.create(await integrationAccessRequestInput(this.#database, input));
  }
  async resolveIntegrationAccessRequest(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<ResolvedIntegrationAccessRequest> {
    return commitPersonalMutation(this.#database, async (transaction) => {
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
      assertRequestRevision(observed, input.expectedRevision);
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
          grant: null,
          request: await refreshRequestState(transaction, declined.id),
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
          await refreshRequestState(transaction, coveredRequest.id);
        }
      }
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return {
        grant,
        request: await refreshRequestState(transaction, resolved.id),
      };
    });
  }
  async loadIntegrationAccessInstallManifest(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
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
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
  }): Promise<BoundIntegrationAccessInstallation | null> {
    return commitPersonalMutation(this.#database, async (transaction) => {
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
      assertRequestRevision(observed, input.expectedRevision);
      await lockActiveDurableRequestAuthority(transaction, requestFromRow(observed));
      await requirePersonalOwner(transaction, input.resolvedBy);
      const manifest = IntegrationInstallManifestSchema.parse(observed.detailManifest);
      const candidates = await transaction
        .selectFrom("integrationInstallations")
        .selectAll()
        .where("status", "=", "active")
        .where("sourceKind", "=", "built-in")
        .where(
          sql<boolean>`integration_installations.provenance ->> 'definitionId' = ${manifest.definition.id}`,
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
        requestId: input.requestId,
      });
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return bound;
    });
  }
  async installForIntegrationAccessRequest(input: {
    readonly preparedFulfillment: PreparedIntegrationInstallFulfillment;
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
  }): Promise<BoundIntegrationAccessInstallation> {
    if (
      !installedIntegrationMatchesReviewedManifest(
        input.preparedFulfillment.material.installation,
        input.preparedFulfillment.approvalManifest,
      )
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Prepared device installation does not match the reviewed manifest",
      });
    }
    return commitPersonalMutation(this.#database, async (transaction) => {
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
      assertRequestRevision(observed, input.expectedRevision);
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
          }
        : await installIntegrationInTransaction(transaction, {
            ...input.preparedFulfillment.material,
            actorUserId: input.resolvedBy,
            requestId: input.requestId,
          });
      const bound = await bindIntegrationAccessInstallation(transaction, {
        installation: installationMutation.installation,
        requestId: input.requestId,
      });
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return bound;
    });
  }
  async selectIntegrationAccessServer(input: {
    readonly requestId: RequestId;
    readonly requestedServerId: IntegrationServerId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
  }): Promise<SelectedIntegrationAccessServer> {
    return commitPersonalMutation(this.#database, async (transaction) => {
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
      assertRequestRevision(observed, input.expectedRevision);
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
      return {
        request: await refreshRequestState(transaction, request.id),
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
    isDeepStrictEqual(current.provenance, installation.provenance)
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
  return (
    installation.sourceKind === "built-in" &&
    installation.version === reviewed.digest &&
    provenance.data.definitionId === reviewed.definition.id &&
    provenance.data.definitionDigest === reviewed.digest &&
    isDeepStrictEqual(installedManifest.data.definition, reviewed.definition)
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
  readonly sourceKind: "plugin" | "built-in";
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
  return {
    installation: input.installation,
    request: await refreshRequestState(transaction, request.id),
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
    .where("connectionKind", "=", "computer")
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
  });
}
