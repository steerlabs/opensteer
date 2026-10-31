import { randomBytes, randomUUID } from "node:crypto";
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
  assertSeparateIphoneApprovalKey,
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
  type ComputerAppApproval,
  type ComputerAppIdentity,
  type IntegrationAccess,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationDefinition,
  type IntegrationServerId,
  type RegisterComputerUseApprovalKey,
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
  computerAppMaxPendingApprovals,
  type ComputerAppApprovalAnswerFrame,
  type ComputerAppApprovalOutcome,
  type ComputerUseInstalledAppsParams,
  type ComputerUseSessionId,
} from "@opensteer/protocol";
import {
  canonicalComputerAppApprovalPublicKey,
  computerAppApprovalKeyId,
  verifyComputerAppApprovalKeyChallenge,
} from "@opensteer/runner-auth";
import type { z } from "zod";
import type { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
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

/**
 * An owner sets phone access from any client. Mac apps are created, widened
 * or unblocked by a signed answer on that Mac; keeping or lowering needs none.
 */
type ComputerConnectionChange =
  | (SetComputerAppConnection & { readonly approval?: ComputerAppApproval })
  | {
      readonly appApproval: "automatic";
      readonly approval: ComputerAppApproval;
      readonly kind: "policy";
      readonly runnerId: RunnerId;
    };

/** Whether a change pushes the Mac its approval list itself, or leaves that to its caller. */
interface ApprovalListPush {
  readonly pushApprovals?: boolean;
}

export interface ComputerAppApprovalServiceOptions {
  readonly computerApps: Pick<
    ComputerAppHub,
    | "appStatus"
    | "reportsApp"
    | "attached"
    | "machinesFor"
    | "approvalRelayRefusal"
    | "relaysComputerAppApprovals"
    | "sendComputerAppApprovalOutcome"
    | "sendComputerAppApprovals"
    | "proveComputerAppApprovalKey"
    | "withRunnerAdmission"
  >;
  readonly computerUse: ComputerUseApprovalGateway | null;
  readonly definitions: readonly IntegrationDefinition[];
  readonly deploymentName: string | null;
  /** Materialises a catalog definition an administrator's first approval needs. */
  readonly installCatalogDefinition: (input: {
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
  readonly onConnectionsChanged: () => void;
  readonly onInputAccessWithdrawn?: (runnerId: RunnerId) => void;
  /** An unexpected failure of work nobody is waiting on, such as pushing a Mac its list. */
  readonly onError?: (error: unknown) => void;
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
  readonly #onConnectionsChanged: () => void;
  readonly #onInputAccessWithdrawn: (runnerId: RunnerId) => void;
  readonly #onError: (error: unknown) => void;
  readonly #onLocalServerApproved: ComputerAppApprovalServiceOptions["onLocalServerApproved"];
  readonly #publishRequestEvents: (events: readonly AgentEvent[]) => void;
  readonly #store: IntegrationPlatformStore;
  /** Each Mac's list push in flight, and whether another is owed after it. */
  readonly #approvalPushes = new Map<RunnerId, { again: boolean }>();

  constructor(options: ComputerAppApprovalServiceOptions) {
    this.#computerApps = options.computerApps;
    this.#computerUse = options.computerUse;
    this.#definitions = options.definitions;
    this.#deploymentName = options.deploymentName;
    this.#installCatalogDefinition = options.installCatalogDefinition;
    this.#listCallableTools = options.listCallableTools;
    this.#listConnections = options.listConnections;
    this.#onConnectionsChanged = options.onConnectionsChanged;
    this.#onInputAccessWithdrawn = options.onInputAccessWithdrawn ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#onLocalServerApproved = options.onLocalServerApproved;
    this.#publishRequestEvents = options.publishRequestEvents;
    this.#store = options.store;
  }

  // ---- the Mac's own stream -------------------------------------------

  /** Offline approvals may wait; an attached computer that cannot show them needs an update. */
  requireApprovalRelay(runnerId: RunnerId): void {
    const refusal = this.#computerApps.approvalRelayRefusal(runnerId);
    if (refusal) throw new OpensteerError({ code: "conflict", message: refusal });
  }

  /**
   * Sends one Mac every approval waiting on it, over its own Runner stream.
   *
   * It is called after anything changes an approval on that Mac, when the
   * stream attaches, and when the Mac asks; the list is always complete, so an
   * approval that ended — declined elsewhere, cancelled, expired, replaced, or
   * taken back with the app — closes its panel by being absent. Pushes for one
   * Mac never overlap and the last one always reflects the last change: a
   * change during a push owes one more.
   */
  pushComputerAppApprovals(runnerId: RunnerId): void {
    if (!this.#computerApps.relaysComputerAppApprovals(runnerId)) return;
    const running = this.#approvalPushes.get(runnerId);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    this.#approvalPushes.set(runnerId, state);
    void (async () => {
      try {
        do {
          state.again = false;
          const list = await this.#store.listComputerAppApprovalsForRunner(
            runnerId,
            computerAppMaxPendingApprovals,
          );
          await this.#computerApps.sendComputerAppApprovals(runnerId, list);
        } while (state.again);
      } catch (error) {
        this.#onError(error);
      } finally {
        this.#approvalPushes.delete(runnerId);
        // A change that arrived while the failed read/send was in flight
        // still owes the Mac its new complete list.
        if (state.again) this.pushComputerAppApprovals(runnerId);
      }
    })();
  }

  /** Every Mac this Host can reach, for a change that is not about one Mac. */
  #pushAllComputerAppApprovals(): void {
    for (const { runnerId } of this.#computerApps.machinesFor(computerUseDefinitionId)) {
      this.pushComputerAppApprovals(runnerId);
    }
  }

  /**
   * The person's answer on that Mac, from its own Runner stream.
   *
   * Allowing consumes the signed approval exactly as it always has — one
   * transaction that verifies the signature against the desktop's registered
   * approval key and creates, widens or unblocks the app, or turns automatic
   * approval on — and declining cancels it. Either way the Mac is told what
   * happened before it is sent the list that no longer holds it, so the page
   * waiting on it learns the answer rather than only that it ended.
   */
  async answerComputerAppApproval(
    runnerId: RunnerId,
    frame: ComputerAppApprovalAnswerFrame,
  ): Promise<void> {
    let outcome: ComputerAppApprovalOutcome;
    let approvedServer:
      Parameters<ComputerAppApprovalServiceOptions["onLocalServerApproved"]>[0] | null = null;
    try {
      const request = await this.#store.getComputerAppSetupRequest({
        runnerId,
        setupRequestId: frame.setupRequestId,
      });
      if (!request) {
        outcome = { kind: "refused", message: "This approval is no longer waiting." };
      } else if (request.kind === "app" && request.definitionId === androidPhoneDefinitionId) {
        outcome = { kind: "refused", message: "Allow phone access from any Opensteer app." };
      } else if (request.kind === "server") {
        // An MCP server to run on this Mac, answered by its owner there.
        const answer = { approval: frame.answer.approval, runnerId, setupRequestId: request.id };
        if (frame.answer.kind === "deny") {
          await this.#store.localMcp.decline(answer);
          outcome = { kind: "declined" };
        } else {
          approvedServer = await this.#store.localMcp.approve(answer);
          outcome = { kind: "allowed" };
        }
        this.#onConnectionsChanged();
      } else if (frame.answer.kind === "deny") {
        const settlement = await this.#store.declineComputerAppSetupFromMac({
          approval: frame.answer.approval,
          requestId: request.id,
          runnerId,
        });
        this.#publishRequestEvents(settlement.requestEvents);
        this.#onConnectionsChanged();
        outcome = { kind: "declined" };
      } else {
        const change: ComputerConnectionChange =
          request.kind === "policy"
            ? {
                appApproval: "automatic",
                approval: frame.answer.approval,
                kind: "policy",
                runnerId,
              }
            : {
                access: request.access,
                app: request.app,
                approval: frame.answer.approval,
                definitionId: request.definitionId,
                kind: "app",
                runnerId,
              };
        await this.setComputerConnection(
          {
            ...change,
            actorUserId: request.ownerUserId,
            isAdministrator: await this.#store.isAdministrator(request.ownerUserId),
            requestId: `computer-app-approval:${request.id}`,
          },
          { pushApprovals: false },
        );
        outcome = { kind: "allowed" };
      }
    } catch (error) {
      if (!(error instanceof OpensteerError)) this.#onError(error);
      outcome = {
        kind: "refused",
        message:
          error instanceof OpensteerError
            ? error.message.slice(0, 1_000)
            : "Opensteer could not record this answer. Try again.",
      };
    }
    await this.#computerApps.sendComputerAppApprovalOutcome(runnerId, {
      outcome,
      setupRequestId: frame.setupRequestId,
    });
    this.pushComputerAppApprovals(runnerId);
    if (approvedServer) this.#onLocalServerApproved(approvedServer);
  }

  /**
   * Pins the key the desktop on that Mac signs its approvals with. The page
   * registers it only on that Mac, from the desktop holding the private half,
   * and registering again replaces it; the Mac is then sent its list again,
   * since approvals it could not show before can be answered now.
   */
  async registerComputerUseApprovalKey(
    input: RegisterComputerUseApprovalKey & {
      readonly ownerUserId: UserId;
      readonly requestId: string;
    },
  ): Promise<{ readonly approvalKeyId: string }> {
    // The owner session nominates the key, but the live Mac must prove its
    // desktop holds the private half before the Host pins it. An owner RPC
    // alone cannot turn a remote process's key into local approval authority.
    await this.#store.getComputerUsePolicy({
      ownerUserId: input.ownerUserId,
      runnerId: input.runnerId,
    });
    const phones =
      (await this.#computerUse?.eligibleMachines(input.ownerUserId, androidPhoneDefinitionId)) ??
      [];
    if (phones.some(({ runnerId }) => runnerId === input.runnerId)) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Phone access is allowed from any Opensteer app; phones do not use approval keys.",
      });
    }
    this.requireApprovalRelay(input.runnerId);
    let publicKey: string;
    try {
      publicKey = canonicalComputerAppApprovalPublicKey(input.publicKey);
    } catch {
      throw new OpensteerError({
        code: "bad_request",
        message: "That approval key is unreadable.",
      });
    }
    const runner = await this.#store.computerAppRunner(input.runnerId);
    if (runner)
      assertSeparateIphoneApprovalKey(
        runner.deviceProfile,
        runner.publicKeyFingerprint,
        computerAppApprovalKeyId(publicKey),
      );
    const challenge = {
      challengeId: randomUUID(),
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      keyId: computerAppApprovalKeyId(publicKey),
      nonce: randomBytes(32).toString("base64url"),
      runnerId: input.runnerId,
    };
    const signature = await this.#computerApps.proveComputerAppApprovalKey(
      input.runnerId,
      challenge,
    );
    if (!signature || !verifyComputerAppApprovalKeyChallenge({ challenge, publicKey, signature })) {
      throw new OpensteerError({
        code: "forbidden",
        message:
          runner?.deviceProfile === "iphone"
            ? "This iPhone did not confirm its approval key. Open Opensteer on this iPhone while it is connected, then try again."
            : "This Mac did not confirm its approval key. Open this Mac's page in Opensteer on the Mac while it is connected, then try again.",
      });
    }
    const registered = await this.#store.registerComputerUseApprovalKey(input);
    this.#onConnectionsChanged();
    this.pushComputerAppApprovals(input.runnerId);
    return { approvalKeyId: registered.approvalKeyId };
  }

  // ---- approvals the Mac answers --------------------------------------

  /** The picker's ask, an unblock, or the automatic policy's signed switch. */
  async requestComputerAppSetup(
    input: z.infer<typeof RequestComputerAppSetupSchema> & { readonly actorUserId: UserId },
  ) {
    if (input.kind === "policy" || input.definitionId !== androidPhoneDefinitionId)
      this.requireApprovalRelay(input.runnerId);
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
      this.pushComputerAppApprovals(request.runnerId);
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
    const { request, settlement } = iphone
      ? await this.#computerApps.withRunnerAdmission(input.runnerId, createRequest)
      : await createRequest();
    this.#publishRequestEvents(settlement.requestEvents);
    this.#onConnectionsChanged();
    this.pushComputerAppApprovals(request.runnerId);
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
    for (const runnerId of settled.runnerIds) this.pushComputerAppApprovals(runnerId);
    if (settled.requestIds.length === 0) return;
    this.#publishRequestEvents(settled.requestEvents);
    this.#onConnectionsChanged();
  }

  async cancelComputerAppSetup(
    input: {
      readonly requestId: string;
      readonly ownerUserId: UserId;
    },
    options: ApprovalListPush = {},
  ) {
    const settlement = await this.#store.cancelComputerAppSetup(input);
    this.#publishRequestEvents(settlement.requestEvents);
    this.#onConnectionsChanged();
    if (settlement.runnerId !== null && options.pushApprovals !== false) {
      this.pushComputerAppApprovals(settlement.runnerId);
    }
  }

  /**
   * The owner's phone access change, or a Mac app's signed approval or
   * unsigned access reduction.
   */
  async setComputerConnection(
    input: ComputerConnectionChange & {
      readonly actorUserId: UserId;
      readonly isAdministrator: boolean;
      readonly requestId: string;
    },
    options: ApprovalListPush = {},
  ) {
    if (input.kind === "app" && input.definitionId === androidPhoneDefinitionId && input.approval) {
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
      await this.#installCatalogDefinition({
        actorUserId: input.actorUserId,
        definitionId: definition.id,
        digest,
        requestId: input.requestId,
      });
    }
    if (input.kind === "policy") {
      // Consuming a signed policy approval is the other way in, so the rule
      // that it is a Mac's holds here too, whatever approval was signed.
      await this.#requireMacForAutomatic(input.runnerId, input.actorUserId);
      await this.#computerApps.withRunnerAdmission(input.runnerId, () =>
        this.#store.setComputerUsePolicy({
          runnerId: input.runnerId,
          ownerUserId: input.actorUserId,
          requestId: input.requestId,
          appApproval: "automatic",
          approval: input.approval,
          definitionDigest: digest,
        }),
      );
      this.#onConnectionsChanged();
      if (options.pushApprovals !== false) this.pushComputerAppApprovals(input.runnerId);
      return null;
    }
    const computerApps = this.#computerApps;
    const mutation = await computerApps.withRunnerAdmission(input.runnerId, async () => {
      try {
        const mutation = await this.#store.setComputerConnection({
          ...(input.approval ? { approval: input.approval } : {}),
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
    if (options.pushApprovals !== false) this.pushComputerAppApprovals(input.runnerId);
    return mutation.connection;
  }

  /** Remove under ask, block under automatic: the words the page uses for each. */
  async disconnectComputerConnection(input: {
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
    this.pushComputerAppApprovals(connection.runnerId);
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
    this.pushComputerAppApprovals(connection.computer.runnerId);
  }

  /**
   * Something removed approvals on Macs this service cannot name — a whole
   * installation going — so every Mac this Host reaches is sent its list.
   */
  approvalsChangedEverywhere(): void {
    this.#pushAllComputerAppApprovals();
  }

  // ---- policy ----------------------------------------------------------

  /**
   * Automatic approval answers "any app on this Mac". A phone is held whole,
   * and nobody lets a task take over a whole phone without being asked, so
   * neither asking for the policy nor consuming a signed one is open to any
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
          ? "Automatic approval is only for apps on a Mac. Approve access in Opensteer on this iPhone."
          : automaticApprovalMacOnlyRefusal,
      });
    }
  }

  async computerUsePolicy(input: { runnerId: RunnerId; ownerUserId: UserId }) {
    const { appApproval, approvalKeyId } = await this.#store.getComputerUsePolicy(input);
    return { appApproval, approvalKeyId };
  }

  /** Turning automatic off works from anywhere; turning it on is a signed setup request. */
  async setComputerUsePolicy(input: {
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
    this.pushComputerAppApprovals(input.runnerId);
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

  /**
   * The only answer to a `computer.app.access` Request from anywhere but the
   * Mac itself: approving means consuming the setup request there.
   */
  async declineComputerAppAccess(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }): Promise<{ readonly request: Request }> {
    const declined = await this.#store.requests.declineComputerAppAccessRequest({
      actorUserId: input.resolvedBy,
      requestId: input.requestId,
      response: RequestResponseSchema.parse(input.response),
    });
    this.#publishRequestEvents(declined.events);
    this.#onConnectionsChanged();
    // The last decline takes the approval with it, so the Mac's panel for it
    // closes wherever the person declined from.
    if (declined.request.payload.kind === "computer.app.access") {
      this.pushComputerAppApprovals(declined.request.payload.runnerId);
    }
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
        message: `${resolved.identity.displayName} is blocked on ${machine.name}. The person can unblock it on that Mac.`,
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
      if (definitionId !== androidPhoneDefinitionId) this.requireApprovalRelay(input.runnerId);
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
        this.pushComputerAppApprovals(input.runnerId);
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
        this.pushComputerAppApprovals(input.runnerId);
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
