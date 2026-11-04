import type { AdministrationCommandIdentity } from "@opensteer/database";
import {
  OpensteerError,
  RequestResponseSchema,
  type AgentEvent,
  type Request,
  type RequestId,
  type RequestResponse,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  ComputerAppNotOfferedError,
  type CallableIntegrationTool,
  type IntegrationRequester,
  type IntegrationPlatformStore,
} from "@opensteer/database";
import {
  computerAppIdentitiesEqual,
  computerAppIdentityKey,
  computerAppNamesApp,
  computerAppUsesSessions,
  integrationAccessCovers,
  isComputerAppDefinition,
  type ComputerAppIdentity,
  type IntegrationAccess,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationDefinition,
  type IntegrationServerId,
  type RequestComputerAppSetupSchema,
  type SetComputerAppConnection,
} from "@opensteer/integration-core";
import type { ComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import { computerAppTools } from "@opensteer/integration-core/computer-app-tools";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import {
  ComputerUseInstalledAppsParamsSchema,
  AndroidPhoneInstalledAppsParamsSchema,
  type AndroidPhoneInstalledAppsParams,
  type AndroidPhoneInstalledAppsResult,
  ComputerUseInstalledAppsResultSchema,
  androidPhoneDefinitionId,
  type ComputerUseInstalledAppsParams,
  type ComputerUseSessionId,
} from "@opensteer/protocol";
import type { z } from "zod";
import type { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import type { LocalMcpSecrets } from "./local-mcp-secrets.js";
import {
  ComputerUseError,
  computerUseDefinitionId,
  type ComputerUseHolding,
  type ComputerUseMachineOption,
  type ComputerUseService,
} from "../computer-use/computer-use-service.js";
import {
  computerToolRefs,
  pendingOnComputerNextAction,
  pendingPhoneAccessNextAction,
  pendingWorkspaceGrantNextAction,
  unknownComputerUseMac,
  unknownPhone,
} from "./computer-use-discovery.js";

/** What the approval surfaces and `integration_request` need of sessions. */
export type ComputerUseApprovalGateway = Pick<
  ComputerUseService,
  | "closeForConnection"
  | "eligibleMachines"
  | "eligibleInventory"
  | "holders"
  | "installedApps"
  | "resolveApp"
  | "stop"
  | "threadTitle"
>;

/** An app or a phone a removal took back, which any session holding it must stop using. */
interface RemovedComputerApp {
  readonly appKey: string | null;
  readonly definitionId: string | null;
  readonly runnerId: RunnerId;
}

/**
 * What a session holds when it holds this connection, or null for a computer
 * app that has no sessions — Messages and every app like it — or a
 * connection that does not fit its definition.
 */
export function computerUseHoldingOf(
  definitions: readonly IntegrationDefinition[],
  connection: { readonly appKey: string | null; readonly definitionId: string | null },
): ComputerUseHolding | null {
  const definition = definitions.find(({ id }) => id === connection.definitionId);
  if (
    !definition ||
    !isComputerAppDefinition(definition) ||
    !computerAppUsesSessions(definition.config)
  ) {
    return null;
  }
  if (computerAppNamesApp(definition.config)) {
    return connection.appKey === null ? null : { appKey: connection.appKey, kind: "app" };
  }
  return connection.appKey === null ? { definitionId: definition.id, kind: "display" } : null;
}

/**
 * Removing an app or a phone takes its approval back, so any session holding
 * it ends now rather than running on authority nobody has any more.
 */
export function endComputerUseSessions(
  computerUse: Pick<ComputerUseService, "closeForConnection"> | null,
  definitions: readonly IntegrationDefinition[],
  removed: readonly RemovedComputerApp[],
): void {
  if (!computerUse) return;
  for (const entry of removed) {
    const holding = computerUseHoldingOf(definitions, entry);
    if (holding) computerUse.closeForConnection(entry.runnerId, holding);
  }
}

/** Said when automatic approval is asked for on anything but a Mac. */
export const automaticApprovalMacOnlyRefusal =
  "Automatic approval is only for apps on a Mac. The owner allows phone access from any Opensteer app.";

/** Owner decisions consume exact pending requests; reductions need no new approval. */
type ComputerConnectionChange =
  | (SetComputerAppConnection & { readonly setupRequestId?: string })
  | {
      readonly appApproval: "automatic";
      readonly setupRequestId: string;
      readonly kind: "policy";
      readonly runnerId: RunnerId;
    };

/** The session is revalidated inside admission after any queued wait. */
interface ComputerApprovalAuthorization {
  readonly authorize?: () => Promise<void>;
}

export interface ComputerAppApprovalServiceOptions {
  readonly computerApps: Pick<
    ComputerAppHub,
    | "appStatus"
    | "reportsApp"
    | "attached"
    | "compatibilityReason"
    | "machinesFor"
    | "withRunnerAdmission"
  >;
  readonly computerUse: ComputerUseApprovalGateway | null;
  readonly definitions: readonly IntegrationDefinition[];
  readonly deploymentName: string | null;
  /** Materialises a catalog definition an administrator's first approval needs. */
  readonly installCatalogDefinition: (input: {
    readonly settlementSessionId?: string | undefined;
    readonly actorUserId: UserId;
    readonly definitionId: string;
    readonly digest: string;
    readonly requestId: string;
  }) => Promise<unknown>;
  readonly listCallableTools: (
    scope: IntegrationRequester,
  ) => Promise<readonly CallableIntegrationTool[]>;
  readonly listConnections: (
    ownerUserId: UserId,
  ) => Promise<readonly IntegrationConnectionSummary[]>;
  readonly localMcpSecrets: Pick<LocalMcpSecrets, "saved" | "update">;
  readonly onConnectionsChanged: () => void;
  readonly onInputAccessWithdrawn?: (runnerId: RunnerId) => void;
  /**
   * A Mac's owner allowed an MCP server to run there. Called once that Mac
   * has been told, so the computer knows before anything asks it to start.
   */
  readonly onLocalServerApproved: (approved: {
    readonly launchDigest: string;
    readonly serverId: IntegrationServerId;
  }) => void;
  readonly publishRequestEvents: (events: readonly AgentEvent[]) => void;
  readonly store: IntegrationPlatformStore;
}

/**
 * Who may use which app on which Mac: the owner's policy, blocks, the
 * approvals the Mac answers, the Requests tasks make, and the Mac's own
 * projection of all of it.
 *
 * Every mutation that decides an app's authority runs in that Mac's
 * admission turn, the same queue a call to the Mac is admitted in, so a call
 * never goes out on authority a removal has already taken back. Everything
 * durable is decided by the store in one transaction under the Mac's row
 * lock; this service only chooses the operation and reports what it did.
 */
export class ComputerAppApprovalService {
  readonly #computerApps: ComputerAppApprovalServiceOptions["computerApps"];
  readonly #computerUse: ComputerUseApprovalGateway | null;
  readonly #definitions: readonly IntegrationDefinition[];
  readonly #deploymentName: string | null;
  readonly #installCatalogDefinition: ComputerAppApprovalServiceOptions["installCatalogDefinition"];
  readonly #listCallableTools: ComputerAppApprovalServiceOptions["listCallableTools"];
  readonly #listConnections: ComputerAppApprovalServiceOptions["listConnections"];
  readonly #localMcpSecrets: ComputerAppApprovalServiceOptions["localMcpSecrets"];
  readonly #onConnectionsChanged: () => void;
  readonly #onInputAccessWithdrawn: (runnerId: RunnerId) => void;
  readonly #onLocalServerApproved: ComputerAppApprovalServiceOptions["onLocalServerApproved"];
  readonly #publishRequestEvents: (events: readonly AgentEvent[]) => void;
  readonly #store: IntegrationPlatformStore;

  constructor(options: ComputerAppApprovalServiceOptions) {
    this.#computerApps = options.computerApps;
    this.#computerUse = options.computerUse;
    this.#definitions = options.definitions;
    this.#deploymentName = options.deploymentName;
    this.#installCatalogDefinition = options.installCatalogDefinition;
    this.#listCallableTools = options.listCallableTools;
    this.#listConnections = options.listConnections;
    this.#localMcpSecrets = options.localMcpSecrets;
    this.#onConnectionsChanged = options.onConnectionsChanged;
    this.#onInputAccessWithdrawn = options.onInputAccessWithdrawn ?? (() => undefined);
    this.#onLocalServerApproved = options.onLocalServerApproved;
    this.#publishRequestEvents = options.publishRequestEvents;
    this.#store = options.store;
  }

  /** Owner-only details are loaded on review, never in shared events or client snapshots. */
  async reviewComputerAppSetup(input: {
    readonly setupRequestId: string;
    readonly ownerUserId: UserId;
  }) {
    const request = await this.#store.getComputerAppSetupRequest({
      setupRequestId: input.setupRequestId,
    });
    if (!request)
      throw new OpensteerError({
        code: "conflict",
        message: "This approval is no longer waiting.",
      });
    await this.#store.getComputerUsePolicy({
      runnerId: request.runnerId,
      ownerUserId: input.ownerUserId,
    });
    if (request.ownerUserId !== input.ownerUserId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only this computer’s owner can answer its approvals.",
      });
    let app = null;
    if (request.app) {
      try {
        if (!this.#computerUse) throw new Error("Helper unavailable");
        app = await this.#computerUse.resolveApp({
          app: request.app.bundleId,
          runnerId: request.runnerId,
        });
      } catch {
        throw new OpensteerError({
          code: "conflict",
          message:
            "Can't verify this app right now. Check that its computer is online and try again.",
        });
      }
      if (!app.allowed)
        throw new OpensteerError({
          code: "forbidden",
          message: app.reason ?? "This app cannot be used by agents.",
        });
      if (!computerAppIdentitiesEqual(app.identity, request.app))
        throw new OpensteerError({
          code: "conflict",
          message: "This app changed since it was requested. Request access again.",
        });
    }
    if (request.kind !== "server" || !request.server) return { request, app };
    const { launch, serverId } = request.server;
    return {
      request,
      app,
      savedSecrets: await this.#localMcpSecrets.saved(
        serverId,
        launch,
        await this.#store.localMcp.secrets(serverId, request.runnerId),
      ),
    };
  }

  async respondComputerAppSetup(input: {
    readonly settlementSessionId?: string | undefined;
    readonly setupRequestId: string;
    readonly decision: "allow" | "deny";
    /** Allowing a server: what the owner entered for the secrets its launch declares. */
    readonly secrets?: Readonly<Record<string, string>> | undefined;
    readonly actorUserId: UserId;
    readonly isAdministrator: boolean;
    readonly requestId: string;
    readonly authorize: () => Promise<void>;
  }): Promise<void> {
    const request = await this.#store.getComputerAppSetupRequest({
      setupRequestId: input.setupRequestId,
    });
    if (!request || request.ownerUserId !== input.actorUserId)
      throw new OpensteerError({
        code: "conflict",
        message: "This approval is no longer waiting for you.",
      });
    if (input.secrets && (request.kind !== "server" || input.decision !== "allow"))
      throw new OpensteerError({
        code: "bad_request",
        message: "Only allowing an MCP server takes secrets.",
      });
    if (input.decision === "allow" && request.app)
      await this.reviewComputerAppSetup({
        setupRequestId: request.id,
        ownerUserId: input.actorUserId,
      });
    if (request.kind === "server") {
      const server = request.server;
      // Checked before admission; the values are sealed inside the approval.
      const secrets =
        input.decision === "allow" && server
          ? this.#localMcpSecrets.update(server.serverId, server.launch, input.secrets ?? {})
          : null;
      const approved = await this.#computerApps.withRunnerAdmission(request.runnerId, async () => {
        await input.authorize();
        const answer = {
          settlementSessionId: input.settlementSessionId,
          actorUserId: input.actorUserId,
          runnerId: request.runnerId,
          setupRequestId: request.id,
        };
        if (input.decision === "deny") {
          await this.#store.localMcp.decline(answer);
          return null;
        }
        if (!secrets)
          throw new OpensteerError({
            code: "conflict",
            message: "This approval is no longer waiting.",
          });
        return this.#store.localMcp.approve({ ...answer, secrets });
      });
      this.#onConnectionsChanged();
      if (approved) this.#onLocalServerApproved(approved);
      return;
    }
    if (input.decision === "deny") {
      await this.#computerApps.withRunnerAdmission(request.runnerId, async () => {
        await input.authorize();
        // Recheck current ownership after waiting in admission, including enrolled computers.
        await this.#store.getComputerUsePolicy({
          runnerId: request.runnerId,
          ownerUserId: input.actorUserId,
        });
        await this.cancelComputerAppSetup({
          requestId: request.id,
          settlementSessionId: input.settlementSessionId,
          ownerUserId: input.actorUserId,
        });
      });
      return;
    }
    await this.setComputerConnection(
      {
        ...(request.kind === "policy"
          ? { kind: "policy" as const, appApproval: "automatic" as const }
          : {
              kind: "app" as const,
              access: request.access,
              app: request.app,
              definitionId: request.definitionId,
            }),
        runnerId: request.runnerId,
        setupRequestId: request.id,
        settlementSessionId: input.settlementSessionId,
        actorUserId: input.actorUserId,
        isAdministrator: input.isAdministrator,
        requestId: input.requestId,
      },
      {
        authorize: async () => {
          await input.authorize();
          if (request.app && !this.#computerApps.attached(request.runnerId))
            throw new OpensteerError({
              code: "conflict",
              message:
                "Can't verify this app right now. Check that its computer is online and try again.",
            });
        },
      },
    );
  }

  // ---- approvals the Mac answers --------------------------------------

  /** The picker's ask, an unblock, or the automatic policy. */
  async requestComputerAppSetup(
    input: z.infer<typeof RequestComputerAppSetupSchema> & { readonly actorUserId: UserId },
  ) {
    if (input.kind === "policy") {
      await this.#requireMacForAutomatic(input.runnerId, input.actorUserId);
      const definition = this.#definitions.find(({ id }) => id === computerUseDefinitionId);
      if (!definition)
        throw new OpensteerError({
          code: "not_found",
          message: "Computer use is unavailable on this Deployment.",
        });
      const { request, settlement } = await this.#store.requestComputerAppSetup({
        ...input,
        definitionDigest: integrationDefinitionDigest(definition),
      });
      this.#publishRequestEvents(settlement.requestEvents);
      this.#onConnectionsChanged();
      return request;
    }
    const definition = this.#definitions.find(({ id }) => id === input.definitionId);
    if (
      !definition ||
      !isComputerAppDefinition(definition) ||
      (input.access === "read-write" &&
        !definition.config.operations.some((operation) => operation.effect === "write"))
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: "This app does not offer that access.",
      });
    }
    const iphone =
      (await this.#store.computerAppRunner(input.runnerId))?.deviceProfile === "iphone";
    if (iphone && !definition.config.platforms.includes("ios"))
      throw new OpensteerError({
        code: "forbidden",
        message: "This app is not supported on an iPhone.",
      });
    // The catalog decides whether a connection of this definition names one
    // app, so an approval for a GUI app that arrives without one is refused
    // here rather than written as an app-less row.
    const requiresApp = computerAppNamesApp(definition.config);
    const app = input.app ?? null;
    if (requiresApp !== (app !== null)) {
      throw new OpensteerError({
        code: "bad_request",
        message: requiresApp
          ? "This approval has to name one app on that Mac."
          : "This app is the whole integration on that computer, so it names no app.",
      });
    }
    const createRequest = () => {
      const incompatibility = this.#computerApps.compatibilityReason(input.runnerId);
      if (incompatibility) throw new OpensteerError({ code: "conflict", message: incompatibility });
      if (iphone) {
        const report = this.#computerApps.reportsApp(input.runnerId, definition.id);
        const name =
          this.#computerApps
            .machinesFor(definition.id)
            .find((machine) => machine.runnerId === input.runnerId)?.name ?? "this iPhone";
        if (report !== "reported") {
          const message =
            report === "offline"
              ? `Open Opensteer on ${name} and keep it open, then try again.`
              : report === "connecting"
                ? `Opensteer on ${name} is still connecting. Try again in a moment.`
                : `This version of Opensteer on ${name} doesn't offer ${definition.name}. Update Opensteer on ${name}.`;
          throw new OpensteerError({ code: "conflict", message });
        }
      }
      return this.#store.requestComputerAppSetup({
        access: input.access,
        actorUserId: input.actorUserId,
        app,
        definitionDigest: integrationDefinitionDigest(definition),
        definitionId: input.definitionId,
        requiresApp,
        runnerId: input.runnerId,
      });
    };
    const { request, settlement } = await this.#computerApps.withRunnerAdmission(
      input.runnerId,
      createRequest,
    );
    this.#publishRequestEvents(settlement.requestEvents);
    this.#onConnectionsChanged();
    return request;
  }

  /**
   * Settles the approvals nobody answered inside their week.
   *
   * The row itself is harmless — reads hide an expired one and
   * `setComputerConnection` refuses it — but a `computer.app.access` Request
   * linked to one would sit pending forever, so the sweep declines it and
   * delivers the same continuation a decline anywhere else does.
   */
  async expireComputerAppSetupRequests(): Promise<void> {
    const settled = await this.#store.expireComputerAppSetupRequests();
    if (settled.requestIds.length === 0) return;
    this.#publishRequestEvents(settled.requestEvents);
    this.#onConnectionsChanged();
  }

  async cancelComputerAppSetup(input: {
    readonly settlementSessionId?: string | undefined;
    readonly requestId: string;
    readonly ownerUserId: UserId;
  }) {
    const settlement = await this.#store.cancelComputerAppSetup(input);
    this.#publishRequestEvents(settlement.requestEvents);
    this.#onConnectionsChanged();
  }

  /**
   * The owner's phone access change, or a Mac app approval or access reduction.
   */
  async setComputerConnection(
    input: ComputerConnectionChange & {
      readonly settlementSessionId?: string | undefined;
      readonly actorUserId: UserId;
      readonly isAdministrator: boolean;
      readonly requestId: string;
    },
    options: ComputerApprovalAuthorization = {},
  ) {
    if (
      input.kind === "app" &&
      input.definitionId === androidPhoneDefinitionId &&
      input.setupRequestId
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Allow phone access from any Opensteer app.",
      });
    }
    const definition = this.#definitions.find(
      ({ id }) => id === (input.kind === "policy" ? computerUseDefinitionId : input.definitionId),
    );
    if (
      !definition ||
      !isComputerAppDefinition(definition) ||
      (input.kind === "app" &&
        input.access === "read-write" &&
        !definition.config.operations.some((operation) => operation.effect === "write"))
    ) {
      throw new OpensteerError({ code: "bad_request", message: "Computer app was not found" });
    }
    const digest = integrationDefinitionDigest(definition);
    const installed = (await this.#store.listInstallations()).find(
      (candidate) =>
        candidate.status === "active" &&
        candidate.provenance.definitionId === definition.id &&
        candidate.provenance.definitionDigest === digest,
    );
    if (!installed) {
      if (!input.isAdministrator) {
        throw new OpensteerError({
          code: "forbidden",
          message: `Ask an administrator to add ${definition.name} to ${this.#deploymentName ?? "this Deployment"}.`,
        });
      }
      await options.authorize?.();
      await this.#installCatalogDefinition({
        settlementSessionId: input.settlementSessionId,
        actorUserId: input.actorUserId,
        definitionId: definition.id,
        digest,
        requestId: input.requestId,
      });
    }
    if (input.kind === "policy") {
      // Consuming a policy approval is the other way in, so the rule
      // that it is a Mac's holds here too, whichever client answered.
      await this.#requireMacForAutomatic(input.runnerId, input.actorUserId);
      await this.#computerApps.withRunnerAdmission(input.runnerId, async () => {
        await options.authorize?.();
        return this.#store.setComputerUsePolicy({
          settlementSessionId: input.settlementSessionId,
          runnerId: input.runnerId,
          ownerUserId: input.actorUserId,
          requestId: input.requestId,
          appApproval: "automatic",
          setupRequestId: input.setupRequestId,
          definitionDigest: digest,
        });
      });
      this.#onConnectionsChanged();
      return null;
    }
    const computerApps = this.#computerApps;
    const mutation = await computerApps.withRunnerAdmission(input.runnerId, async () => {
      await options.authorize?.();
      try {
        const mutation = await this.#store.setComputerConnection({
          settlementSessionId: input.settlementSessionId,
          ...(input.setupRequestId ? { setupRequestId: input.setupRequestId } : {}),
          definitionDigest: digest,
          access: input.access,
          actorUserId: input.actorUserId,
          app: input.app ?? null,
          createIfMissing: computerApps.appStatus(input.runnerId, definition.id) !== null,
          definitionId: definition.id,
          requestId: input.requestId,
          runnerId: input.runnerId,
          tools: (connectionId) => computerAppTools(definition, input.access, connectionId),
        });
        if (input.definitionId === androidPhoneDefinitionId && input.access !== "read-write")
          this.#onInputAccessWithdrawn(input.runnerId);
        const reset = mutation.sessionReset;
        if (reset) {
          this.#computerUse?.closeForConnection(
            reset.runnerId,
            reset.kind === "app"
              ? { appKey: reset.appKey, kind: "app" }
              : { definitionId: reset.definitionId, kind: "display" },
          );
        }
        return mutation;
      } catch (error) {
        if (error instanceof ComputerAppNotOfferedError) {
          throw new OpensteerError({
            code: "conflict",
            message: `${error.runnerName} is offline. Turn ${definition.name} on when it is back.`,
          });
        }
        throw error;
      }
    });
    this.#publishRequestEvents(mutation.requestEvents);
    this.#onConnectionsChanged();
    // A change can settle, use up or reissue this app's waiting approval; the
    // Mac shows only what its latest list holds.
    return mutation.connection;
  }

  /** Remove under ask, block under automatic: the words the page uses for each. */
  async disconnectComputerConnection(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<{ readonly notice: null; readonly revokedUpstream: false }> {
    const connection = await this.#store.getComputerConnectionForCall(input);
    if (!connection) {
      throw new OpensteerError({ code: "not_found", message: "Computer app not found" });
    }
    const mutation = await this.#computerApps.withRunnerAdmission(connection.runnerId, async () => {
      const policy =
        connection.connection.definitionId === computerUseDefinitionId
          ? await this.#store.getComputerUsePolicy({
              runnerId: connection.runnerId,
              ownerUserId: input.ownerUserId,
            })
          : null;
      const revoked =
        connection.connection.definitionId === computerUseDefinitionId &&
        policy?.appApproval === "automatic"
          ? await this.#store.blockComputerApp(input)
          : await this.#store.revokeComputerConnection(input);
      if (connection.connection.definitionId === androidPhoneDefinitionId)
        this.#onInputAccessWithdrawn(connection.runnerId);
      endComputerUseSessions(this.#computerUse, this.#definitions, revoked.removedApps);
      return revoked;
    });
    this.#publishRequestEvents(mutation.requestEvents);
    this.#onConnectionsChanged();
    return { notice: null, revokedUpstream: false };
  }

  async blockComputerApp(input: {
    connectionId: IntegrationConnectionId;
    ownerUserId: UserId;
    requestId: string;
  }) {
    const connection = (await this.#listConnections(input.ownerUserId)).find(
      ({ id }) => id === input.connectionId,
    );
    if (!connection?.computer || connection.definitionId !== computerUseDefinitionId)
      throw new OpensteerError({ code: "not_found", message: "Computer app not found" });
    const mutation = await this.#computerApps.withRunnerAdmission(
      connection.computer.runnerId,
      async () => {
        const mutation = await this.#store.blockComputerApp(input);
        endComputerUseSessions(this.#computerUse, this.#definitions, mutation.removedApps);
        return mutation;
      },
    );
    this.#publishRequestEvents(mutation.requestEvents);
    this.#onConnectionsChanged();
  }

  // ---- policy ----------------------------------------------------------

  /**
   * Automatic approval answers "any app on this Mac". A phone is held whole,
   * and nobody lets a task take over a whole phone without being asked, so
   * neither asking for the policy nor consuming one is open to any
   * computer but a Mac this person owns.
   */
  async #requireMacForAutomatic(runnerId: RunnerId, ownerUserId: UserId): Promise<void> {
    const macs =
      (await this.#computerUse?.eligibleMachines(ownerUserId, computerUseDefinitionId)) ?? [];
    if (!macs.some((mac) => mac.runnerId === runnerId)) {
      const iphone = (await this.#store.computerAppRunner(runnerId))?.deviceProfile === "iphone";
      throw new OpensteerError({
        code: "bad_request",
        message: iphone
          ? "Automatic approval is only for apps on a Mac. Approve access in Opensteer from any Opensteer app."
          : automaticApprovalMacOnlyRefusal,
      });
    }
  }

  async computerUsePolicy(input: { runnerId: RunnerId; ownerUserId: UserId }) {
    const { appApproval } = await this.#store.getComputerUsePolicy(input);
    return { appApproval };
  }

  /** Turning automatic off works from anywhere; turning it on consumes a setup request. */
  async setComputerUsePolicy(input: {
    readonly settlementSessionId?: string | undefined;
    runnerId: RunnerId;
    ownerUserId: UserId;
    requestId: string;
    appApproval: "ask";
  }) {
    await this.#computerApps.withRunnerAdmission(input.runnerId, () =>
      this.#store.setComputerUsePolicy(input),
    );
    this.#onConnectionsChanged();
    // Switching off also withdraws a waiting "Allow any app" approval.
    return { appApproval: "ask" as const };
  }

  // ---- the Mac's projection -------------------------------------------

  async computerUseMachines(ownerUserId: UserId) {
    return (await this.computerUseInventory(ownerUserId)).machines;
  }

  async computerUsePhones(ownerUserId: UserId) {
    return (await this.computerUseInventory(ownerUserId)).phones;
  }

  /** A request reads inventory and policy once, then projects each platform's distinct approval model. */
  async computerUseInventory(ownerUserId: UserId) {
    const [inventory, connections] = await Promise.all([
      this.#computerUse?.eligibleInventory(ownerUserId) ?? { machines: [], phones: [] },
      this.#listConnections(ownerUserId),
    ]);
    const policies = new Map(
      await Promise.all(
        inventory.machines.map(
          async (machine) =>
            [
              machine.runnerId,
              await this.#store.getComputerUsePolicy({ runnerId: machine.runnerId, ownerUserId }),
            ] as const,
        ),
      ),
    );
    const byRunner = new Map<RunnerId, typeof connections>();
    for (const connection of connections) {
      const runnerId = connection.computer?.runnerId;
      if (!runnerId || connection.status === "revoked") continue;
      const rows = byRunner.get(runnerId) ?? [];
      byRunner.set(runnerId, [...rows, connection]);
    }
    return {
      machines: inventory.machines.map((machine) => ({
        ...machine,
        appApproval: policies.get(machine.runnerId)!.appApproval,
        apps: (byRunner.get(machine.runnerId) ?? []).flatMap((connection) =>
          connection.definitionId === computerUseDefinitionId && connection.computer?.app
            ? [
                {
                  name: connection.computer.app.displayName,
                  bundleId: connection.computer.app.bundleId,
                  access: connection.computer.access,
                  status: connection.computer.blockedAt
                    ? ("blocked" as const)
                    : ("approved" as const),
                  connectionId: connection.id,
                },
              ]
            : [],
        ),
      })),
      phones: inventory.phones.map((phone) => {
        const connection = (byRunner.get(phone.runnerId) ?? []).find(
          (row) => row.definitionId === androidPhoneDefinitionId,
        );
        return {
          ...phone,
          connection:
            connection?.computer && !connection.computer.blockedAt
              ? { access: connection.computer.access, connectionId: connection.id }
              : null,
        };
      }),
    };
  }

  /** Which Run on this Host holds each app, or the display, on that computer. */
  computerAppHolders(runnerId: RunnerId): ReturnType<ComputerUseApprovalGateway["holders"]> {
    return this.#computerUse?.holders(runnerId) ?? new Map();
  }

  /** Owned app inventory uses no control session and remains available while paused. */
  async installedComputerApps(
    input: {
      readonly actorUserId: UserId;
      readonly runnerId: RunnerId;
    } & Partial<ComputerUseInstalledAppsParams>,
    machines?: readonly ComputerUseMachineOption[],
  ): Promise<
    z.infer<typeof ComputerUseInstalledAppsResultSchema> & {
      readonly unavailableReason?: "offline" | "not-ready";
    }
  >;
  async installedComputerApps(
    input: {
      readonly actorUserId: UserId;
      readonly runnerId: RunnerId;
      readonly definitionId: typeof androidPhoneDefinitionId;
    } & Partial<AndroidPhoneInstalledAppsParams>,
    machines?: readonly ComputerUseMachineOption[],
  ): Promise<AndroidPhoneInstalledAppsResult>;
  async installedComputerApps(
    input: {
      readonly actorUserId: UserId;
      readonly runnerId: RunnerId;
      readonly definitionId?: typeof androidPhoneDefinitionId;
    } & Partial<ComputerUseInstalledAppsParams>,
    machines?: readonly ComputerUseMachineOption[],
  ): Promise<
    | (z.infer<typeof ComputerUseInstalledAppsResultSchema> & {
        readonly unavailableReason?: "offline" | "not-ready";
      })
    | AndroidPhoneInstalledAppsResult
  > {
    const computerUse = this.#computerUse;
    if (!computerUse)
      throw new OpensteerError({
        code: "conflict",
        message: "Computer use is unavailable on this Deployment.",
      });
    try {
      const { actorUserId, runnerId, definitionId, ...params } = input;
      const inventory =
        machines ??
        (await computerUse.eligibleMachines(actorUserId, definitionId ?? computerUseDefinitionId));
      const machine = inventory.find((machine) => machine.runnerId === runnerId);
      if (!machine)
        throw new ComputerUseError(
          "unsupported",
          "Only an owned computer that serves this app can list its apps.",
        );
      if (
        definitionId !== androidPhoneDefinitionId &&
        (machine.state === "offline" || machine.state === "unavailable")
      )
        return {
          apps: [],
          total: 0,
          unavailableReason: machine.state === "offline" ? "offline" : "not-ready",
        };
      if (machine.state === "offline")
        throw new ComputerUseError("offline", `${machine.name} is offline.`);
      return definitionId === androidPhoneDefinitionId
        ? await computerUse.installedApps(
            runnerId,
            actorUserId,
            AndroidPhoneInstalledAppsParamsSchema.parse(params),
            definitionId,
          )
        : await computerUse.installedApps(
            runnerId,
            actorUserId,
            ComputerUseInstalledAppsParamsSchema.parse(params),
          );
    } catch (error) {
      if (!(error instanceof ComputerUseError)) throw error;
      if (input.definitionId !== androidPhoneDefinitionId && error.code === "offline")
        return { apps: [], total: 0, unavailableReason: "offline" };
      throw new OpensteerError({
        cause: error,
        code: error.code === "offline" ? "conflict" : "bad_request",
        message: error.message,
        retryable: error.retryable,
      });
    }
  }

  async stopComputerUseSession(input: {
    readonly actorUserId: UserId;
    readonly sessionId: ComputerUseSessionId;
  }): Promise<void> {
    const computerUse = this.#computerUse;
    if (!computerUse) return;
    try {
      await computerUse.stop(input.sessionId, input.actorUserId);
    } catch (error) {
      if (!(error instanceof ComputerUseError)) throw error;
      throw new OpensteerError({ cause: error, code: "forbidden", message: error.message });
    }
  }

  // ---- tasks asking ----------------------------------------------------

  async declineComputerAppAccess(input: {
    readonly settlementSessionId?: string;
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }): Promise<{ readonly request: Request }> {
    const declined = await this.#store.requests.declineComputerAppAccessRequest({
      actorUserId: input.resolvedBy,
      ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
      requestId: input.requestId,
      response: RequestResponseSchema.parse(input.response),
    });
    this.#publishRequestEvents(declined.events);
    this.#onConnectionsChanged();
    return { request: declined.request };
  }

  /**
   * How a task asks for one app on one Mac, or for a whole Android phone.
   *
   * For a Mac, the Mac resolves the app, because a model naming one has a
   * name, a path or a bundle identifier and never an identity anybody
   * resolved. A phone is asked for whole, by its id, and names no app. What
   * happens next — inline approval, a grant Request, or an approval on the
   * computer itself — is decided by the store under that computer's lock,
   * against the policy as it is at that moment.
   */
  async requestComputerAppAccess(input: {
    readonly access: IntegrationAccess;
    /** The app on a Mac, in the model's words; null asks for a whole phone. */
    readonly app: string | null;
    readonly callId?: string;
    readonly reason: string;
    readonly ownerUserId: UserId;
    readonly originatingRunId: RunId;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  }) {
    const computerUse = this.#computerUse;
    if (!computerUse) {
      throw new OpensteerError({
        code: "conflict",
        message: "Computer use is unavailable on this Deployment.",
      });
    }
    return input.app === null
      ? this.#requestPhoneAccess(computerUse, input)
      : this.#requestMacAppAccess(computerUse, { ...input, app: input.app });
  }

  async #requestMacAppAccess(
    computerUse: ComputerUseApprovalGateway,
    input: Parameters<ComputerAppApprovalService["requestComputerAppAccess"]>[0] & {
      readonly app: string;
    },
  ) {
    const definition = this.#definitions.find(({ id }) => id === computerUseDefinitionId);
    if (!definition || !isComputerAppDefinition(definition)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Computer use is unavailable on this Deployment.",
      });
    }
    const machine = (
      await computerUse.eligibleMachines(input.ownerUserId, computerUseDefinitionId)
    ).find(({ runnerId }) => runnerId === input.runnerId);
    if (!machine) {
      // A phone has no apps to name; the one way to ask for it is whole.
      const phone = (
        await computerUse.eligibleMachines(input.ownerUserId, androidPhoneDefinitionId)
      ).find(({ runnerId }) => runnerId === input.runnerId);
      throw new OpensteerError({
        code: "forbidden",
        message: phone
          ? `${phone.name} is a phone, which is asked for whole: omit app.`
          : unknownComputerUseMac(input.runnerId),
      });
    }
    if (!this.#computerApps.attached(input.runnerId))
      throw new ComputerUseError("offline", `${machine.name} is offline.`);
    let resolved;
    try {
      resolved = await computerUse.resolveApp({
        app: input.app,
        runId: input.originatingRunId,
        runnerId: input.runnerId,
      });
    } catch (error) {
      if (error instanceof ComputerUseError && error.code === "offline")
        throw new ComputerUseError("offline", `${machine.name} is offline.`);
      throw error;
    }
    const connection = (await this.#listConnections(input.ownerUserId)).find(
      (connection) =>
        connection.definitionId === computerUseDefinitionId &&
        connection.status !== "revoked" &&
        connection.computer?.runnerId === input.runnerId &&
        connection.computer.app &&
        computerAppIdentityKey(connection.computer.app) ===
          computerAppIdentityKey(resolved.identity),
    );
    if (connection?.computer?.blockedAt)
      throw new OpensteerError({
        code: "forbidden",
        message: `${resolved.identity.displayName} is blocked on ${machine.name}. The owner can unblock it from any Opensteer app.`,
      });
    if (!resolved.allowed)
      throw new OpensteerError({
        code: "bad_request",
        message: resolved.reason ?? `${resolved.identity.displayName} cannot be used by agents.`,
      });
    const scope = {
      ownerUserId: input.ownerUserId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
    };
    if (
      connection?.computer &&
      computerAppIdentitiesEqual(connection.computer.app, resolved.identity) &&
      integrationAccessCovers(connection.computer.access, input.access)
    ) {
      const toolRefs = computerToolRefs(await this.#listCallableTools(scope), connection.id);
      if (toolRefs.observe && (input.access === "read" || toolRefs.act))
        return { status: "already-available" as const, toolRefs };
    }
    return this.#decide(computerUse, {
      app: resolved.identity,
      computer: machine.name,
      definition,
      input,
    });
  }

  /**
   * A task asking for a whole phone: it must be one of this person's phones
   * here, attached, before anything is written. Access a connection already
   * covers comes straight back; otherwise the owner answers from any Opensteer app.
   */
  async #requestPhoneAccess(
    computerUse: ComputerUseApprovalGateway,
    input: Parameters<ComputerAppApprovalService["requestComputerAppAccess"]>[0],
  ) {
    const definition = this.#definitions.find(({ id }) => id === androidPhoneDefinitionId);
    if (!definition || !isComputerAppDefinition(definition)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Android phones are unavailable on this Deployment.",
      });
    }
    const phone = (
      await computerUse.eligibleMachines(input.ownerUserId, androidPhoneDefinitionId)
    ).find(({ runnerId }) => runnerId === input.runnerId);
    if (!phone) {
      const mac = (
        await computerUse.eligibleMachines(input.ownerUserId, computerUseDefinitionId)
      ).find(({ runnerId }) => runnerId === input.runnerId);
      throw new OpensteerError({
        code: "forbidden",
        message: mac
          ? `${mac.name} is a Mac, whose apps are asked for one at a time: name the app.`
          : unknownPhone(input.runnerId),
      });
    }
    if (!this.#computerApps.attached(input.runnerId))
      throw new ComputerUseError("offline", `${phone.name} is offline.`);
    const connection = (await this.#listConnections(input.ownerUserId)).find(
      (candidate) =>
        candidate.definitionId === androidPhoneDefinitionId &&
        candidate.status !== "revoked" &&
        candidate.computer?.runnerId === input.runnerId,
    );
    if (
      connection?.computer &&
      !connection.computer.blockedAt &&
      integrationAccessCovers(connection.computer.access, input.access)
    ) {
      const toolRefs = computerToolRefs(
        await this.#listCallableTools({
          ownerUserId: input.ownerUserId,
          threadId: input.threadId,
          workspaceId: input.workspaceId,
        }),
        connection.id,
      );
      if (toolRefs.observe && (input.access === "read" || toolRefs.act))
        return { status: "already-available" as const, toolRefs };
    }
    return this.#decide(computerUse, { app: null, computer: phone.name, definition, input });
  }

  /** The store's decision on one ask, taken in the computer's admission turn, and what it owes. */
  async #decide(
    computerUse: ComputerUseApprovalGateway,
    ask: {
      readonly app: ComputerAppIdentity | null;
      readonly computer: string;
      readonly definition: ComputerAppDefinition;
      readonly input: Parameters<ComputerAppApprovalService["requestComputerAppAccess"]>[0];
    },
  ) {
    const { definition, input } = ask;
    const definitionId =
      definition.id === androidPhoneDefinitionId
        ? androidPhoneDefinitionId
        : computerUseDefinitionId;
    const scope = {
      ownerUserId: input.ownerUserId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
    };
    // Read before the admission turn: nothing else waiting on this computer
    // should wait on this Thread's name.
    const threadTitle = await computerUse.threadTitle(input.threadId, input.ownerUserId);
    const decision = await this.#computerApps.withRunnerAdmission(input.runnerId, () => {
      if (!this.#computerApps.attached(input.runnerId))
        throw new ComputerUseError("offline", `${ask.computer} is offline.`);
      return this.#store.requestComputerAppAccess({
        access: input.access,
        app: ask.app,
        auditRequestId: input.callId ?? input.originatingRunId,
        definitionDigest: integrationDefinitionDigest(definition),
        definitionId,
        ...(input.callId === undefined ? {} : { idempotencyKey: input.callId }),
        originatingRunId: input.originatingRunId,
        ownerUserId: input.ownerUserId,
        reason: input.reason,
        runnerId: input.runnerId,
        threadId: input.threadId,
        threadTitle,
        tools: (connectionId) => computerAppTools(definition, input.access, connectionId),
        workspaceId: input.workspaceId,
      });
    });
    this.#publishRequestEvents(decision.requestEvents);
    switch (decision.kind) {
      case "approved":
        this.#onConnectionsChanged();
        return {
          status: "fulfilled" as const,
          toolRefs: computerToolRefs(await this.#listCallableTools(scope), decision.connection.id),
        };
      case "workspace-grant":
        return {
          status: "pending" as const,
          request: decision.request,
          replayed: decision.replayed,
          nextAction: pendingWorkspaceGrantNextAction,
        };
      case "computer":
        this.#onConnectionsChanged();
        return {
          status: "pending" as const,
          request: decision.request,
          replayed: decision.replayed,
          nextAction:
            definitionId === androidPhoneDefinitionId
              ? pendingPhoneAccessNextAction
              : pendingOnComputerNextAction(ask.computer),
        };
    }
  }
}
