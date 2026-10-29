import {
  environmentDiscovery,
  type EnvironmentDiscoveryStore,
} from "../agents/environment-discovery.js";
import { createHash } from "node:crypto";
import {
  provisionalThreadTitle,
  OpensteerError,
  type EnvironmentId,
  type HarnessId,
  type WorkspaceBackingKind,
} from "@opensteer/core";
import type { OpensteerStore, WatchControlAdmissionInput } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import {
  AgentControlRequestSchema,
  AgentControlResponseSchema,
  type AgentControlRequest,
  type AgentControlResponse,
} from "@opensteer/protocol";
import type { WatchControlScope, WatchControlTokenService } from "./watch-capability.js";
import {
  assertProgramToolAllowed,
  assertProgramMessageScope,
  assertProgramDelegationScope,
} from "./program-authority.js";
import { delegationPlacement } from "../agents/delegation-placement.js";
import { requestFingerprintForToolContract, requestForToolContract } from "./tool-contract.js";

type WatchCommandService = Pick<
  CommandService,
  "delegateAdmittedThread" | "enqueueAdmittedThreadInput"
>;
type WatchControlStore = EnvironmentDiscoveryStore &
  Pick<
    OpensteerStore,
    | "environmentIsAvailableToUser"
    | "findDelegatedThreadByIdempotency"
    | "findMainWorkspaceForOwner"
    | "getEnvironment"
    | "getHarnessCatalog"
    | "getHarnessInstance"
    | "getThreadForOwner"
    | "getWorkspaceForOwner"
    | "listHarnessInstances"
  >;

export class WatchControlService {
  readonly #canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
  readonly #commands: WatchCommandService;
  readonly #environmentWorkspaceBackings: (id: EnvironmentId) => readonly WorkspaceBackingKind[];
  readonly #isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
  readonly #store: WatchControlStore;
  readonly #tokens: Pick<WatchControlTokenService, "authenticate">;

  constructor(options: {
    readonly canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
    readonly commands: WatchCommandService;
    readonly environmentWorkspaceBackings: (id: EnvironmentId) => readonly WorkspaceBackingKind[];
    readonly isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
    readonly store: WatchControlStore;
    readonly tokens: Pick<WatchControlTokenService, "authenticate">;
  }) {
    this.#canRunHarness = options.canRunHarness;
    this.#commands = options.commands;
    this.#environmentWorkspaceBackings = options.environmentWorkspaceBackings;
    this.#isEnvironmentConnected = options.isEnvironmentConnected;
    this.#store = options.store;
    this.#tokens = options.tokens;
  }

  async handle(token: string, value: unknown): Promise<AgentControlResponse> {
    const claims = await this.#tokens.authenticate(token);
    const request = AgentControlRequestSchema.parse(
      requestForToolContract(claims.toolContractVersion, value),
    );
    if (
      request.type !== "thread.delegate" &&
      request.type !== "thread.message" &&
      request.type !== "environment.list"
    ) {
      throw forbidden(
        "Watch programs may call only thread_message, thread_delegate and environment_list",
      );
    }
    const anchor = await this.#store.getThreadForOwner(claims.anchorThreadId, claims.createdBy);
    if (
      !anchor ||
      anchor.environmentId !== claims.environmentId ||
      anchor.workspaceId !== claims.workspaceId
    ) {
      throw forbidden("Watch no longer belongs to its anchor Thread");
    }
    assertProgramToolAllowed("watch", anchor, request);
    if (request.type === "environment.list") {
      const result = await environmentDiscovery({
        store: this.#store,
        userId: claims.createdBy,
        parent: anchor,
        input: request,
        connected: this.#isEnvironmentConnected,
        canRun: this.#canRunHarness,
        workspaceBackings: this.#environmentWorkspaceBackings,
      });
      return AgentControlResponseSchema.parse({
        ...result,
        requestId: request.requestId,
        type: "environment.list.result",
      });
    }
    const observationId = request.observationId ?? request.requestId;
    const admission = watchAdmission(claims, request, observationId);
    if (request.type === "thread.message") {
      const destination =
        request.threadId === "home"
          ? (await this.#store.findMainWorkspaceForOwner(claims.createdBy))?.homeThreadId
          : request.threadId;
      if (!destination) throw forbidden("Chat has not been started yet");
      const thread = await this.#store.getThreadForOwner(destination, claims.createdBy);
      if (!thread) throw forbidden("Thread is unavailable to this user");
      assertProgramMessageScope(anchor, thread, request);
      const delivered = await this.#commands.enqueueAdmittedThreadInput({
        admission: { kind: "watch", request: admission },
        input: {
          content: request.content,
          idempotencyKey: watchIdempotencyKey(claims, observationId, "message"),
          policy: request.delivery,
          requestedBy: claims.createdBy,
          source: {
            activationId: claims.activationId,
            kind: "watch",
            observationId,
            revisionId: claims.revisionId,
            triggerId: claims.triggerId,
          },
          threadId: thread.id,
        },
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        result: {
          assignmentId: delivered.input.assignmentId,
          disposition: delivered.disposition,
          input: delivered.input,
          message: delivered.message,
          run: delivered.run,
          thread,
        },
        type: "thread.message.result",
      });
    }

    if (request.places?.length)
      throw badRequest("Watch delegation cannot forward place references.");
    const existingThread = request.threadId
      ? await this.#store.getThreadForOwner(request.threadId, claims.createdBy)
      : null;
    if (request.threadId && !existingThread) throw forbidden("Target Thread is unavailable");
    if (existingThread && (existingThread.role !== "work" || existingThread.id === anchor.id)) {
      throw badRequest("Choose another work Thread for the assignment");
    }
    const targetWorkspaceId = existingThread?.workspaceId ?? request.workspaceId;
    if (!targetWorkspaceId) throw badRequest("Choose a target Workspace or work Thread");
    assertProgramDelegationScope(anchor, targetWorkspaceId, existingThread);
    const workspace = await this.#store.getWorkspaceForOwner(targetWorkspaceId, claims.createdBy);
    if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
    const environmentId =
      existingThread?.environmentId ?? request.environmentId ?? anchor.environmentId;
    const environment = await this.#store.getEnvironment(environmentId);
    if (!environment) throw badRequest("Selected execution environment does not exist");
    if (
      request.environmentId &&
      !(await this.#store.environmentIsAvailableToUser(environment.id, claims.createdBy))
    ) {
      throw forbidden("Selected execution environment is unavailable to this user");
    }
    if (
      workspace.backing.kind === "local-directory" &&
      workspace.backing.ownerEnvironmentId !== environment.id
    ) {
      throw badRequest("A local-directory Workspace can run only in its owning environment");
    }
    const placement = await delegationPlacement(this.#store, {
      environment,
      existingThread,
      harnessInstanceId: request.harnessInstanceId,
      model: request.model,
      parent: anchor,
    });
    const delegateInput = {
      callerIntent: {
        requestId: request.requestId,
        requestFingerprint: admission.requestFingerprint,
      },
      accessMode: existingThread?.accessMode ?? anchor.accessMode,
      ...(existingThread ? { threadId: existingThread.id } : {}),
      createdBy: claims.createdBy,
      environmentId: environment.id,
      harnessInstanceId: placement.harnessInstanceId,
      idempotencyKey: watchIdempotencyKey(claims, observationId, "delegate"),
      modelSelection: placement.modelSelection,
      origin: {
        activationId: claims.activationId,
        kind: "watch",
        observationId,
        parentThreadId: anchor.id,
        revisionId: claims.revisionId,
        triggerId: claims.triggerId,
      },
      task: [
        {
          text: request.task,
          type: "text",
        },
      ],
      title: request.title ?? provisionalThreadTitle(request.task),
      titleSource: request.title === undefined ? "provisional" : "chosen",
      ...(request.icon ? { icon: request.icon } : {}),
      workspaceId: workspace.id,
    } as const;
    const replayed = await this.#store.findDelegatedThreadByIdempotency(delegateInput);
    if (replayed) return delegationResponse(request.requestId, replayed);
    if (workspace.status !== "ready") throw conflict("Target Workspace is not ready", true);
    const connected = this.#isEnvironmentConnected(environment.id);
    if (!connected) throw conflict("Selected execution environment is not connected", true);
    const harness = await this.#store.getHarnessInstance(placement.harnessInstanceId);
    if (!harness?.enabled || !this.#canRunHarness(environment.id, harness.driverKind)) {
      throw conflict("Selected AI engine is not available on the requested work location");
    }
    const delegated = await this.#commands.delegateAdmittedThread({
      admission: { kind: "watch", request: admission },
      input: delegateInput,
    });
    return delegationResponse(request.requestId, delegated);
  }
}

function watchAdmission(
  claims: WatchControlScope,
  request: Extract<
    ReturnType<typeof AgentControlRequestSchema.parse>,
    { readonly type: "thread.delegate" | "thread.message" }
  >,
  observationId: string,
): WatchControlAdmissionInput {
  const versioned = requestFingerprintForToolContract(
    claims.toolContractVersion,
    request,
  ) as AgentControlRequest;
  const { requestId: _requestId, ...fingerprinted } = versioned;
  return {
    action: request.type,
    activationId: claims.activationId,
    anchorThreadId: claims.anchorThreadId,
    createdBy: claims.createdBy,
    environmentId: claims.environmentId,
    executionGeneration: claims.executionGeneration,
    membershipGeneration: claims.membershipGeneration,
    observationId,
    requestFingerprint: createHash("sha256")
      .update(JSON.stringify(fingerprinted), "utf8")
      .digest("hex"),
    requestId: request.requestId,
    revisionId: claims.revisionId,
    triggerId: claims.triggerId,
    workspaceId: claims.workspaceId,
  };
}

function watchIdempotencyKey(
  claims: WatchControlScope,
  observationId: string,
  action: string,
): string {
  return `watch:${claims.activationId}:${observationId}:${action}`;
}

function delegationResponse(
  requestId: string,
  delegated: Awaited<ReturnType<OpensteerStore["delegateAdmittedThread"]>>,
): AgentControlResponse {
  return AgentControlResponseSchema.parse({
    requestId,
    result: {
      assignmentId: delegated.assignment.id,
      input: delegated.input,
      message: delegated.message,
      run: delegated.run,
      thread: delegated.thread,
    },
    type: "thread.delegate.result",
  });
}

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}

function badRequest(message: string): OpensteerError {
  return new OpensteerError({ code: "bad_request", message });
}

function conflict(message: string, retryable = false): OpensteerError {
  return new OpensteerError({ code: "conflict", message, retryable });
}
