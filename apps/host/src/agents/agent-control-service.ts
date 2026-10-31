import type { ScreenPresentationService } from "../screen/screen-presentation-service.js";
import { environmentDiscovery } from "./environment-discovery.js";
import type { BrowserTabGroupService } from "../browser/browser-tab-group-service.js";
import { isPlaceContentPart, provisionalThreadTitle } from "@opensteer/core";
import type { PlaceContextService } from "../computer-use/place-context-service.js";
import { createHash } from "node:crypto";
import {
  AgentToolIdSchema,
  capabilityProfileAcceptsTool,
  type AgentToolId,
} from "@opensteer/agent-tools";
import {
  type AgentEvent,
  type EnvironmentId,
  type WorkspaceBackingKind,
  OpensteerError,
  placeContentLabel,
  type Message,
  ThreadIdSchema,
  threadInReach,
  type HarnessId,
  type Thread,
  type Workspace,
  workspaceWakesOnDemand,
} from "@opensteer/core";
import type { WorkspaceStorageChoice } from "@opensteer/workspace";
import type {
  AgentControlAdmissionResult,
  BrowserUsageCredit,
  AgentThreadListScope,
  OpensteerStore,
} from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import {
  AgentControlRequestSchema,
  AgentControlResponseSchema,
  agentWorkspaceView,
  type AgentControlRequest,
  type AgentControlResponse,
} from "@opensteer/protocol";
import type { TriggerControlInput } from "@opensteer/triggers";
import type { MachineFullDiskAccessService } from "../shell/machine-full-disk-access-service.js";
import type { BrowserService } from "../browser/browser-service.js";
import type { BrowserSourceService } from "../browser/browser-source-service.js";
import type { SignedTokenService } from "../identity/host-keys.js";
import {
  RunCapabilityTokenService,
  type RunCapabilityBindingAuthorizer,
  type RunCapabilityClaims,
} from "./run-capability.js";
import {
  delegationEngines,
  delegationHarnessPage,
  delegationPlacement,
} from "./delegation-placement.js";
import { callerWorkspaceStorage } from "../workspace/workspace-service.js";

export type AgentControlRunScope = RunCapabilityClaims<"opensteer-agent-control">;

export interface AgentWorkspaceMountService {
  mount(input: {
    readonly requestId: string;
    readonly scope: AgentControlRunScope;
    readonly workspace: Workspace;
  }): Promise<{ readonly path: string }>;
}

export interface AgentWorkspaceWaker {
  wake(workspaceId: Workspace["id"], reason: string): Promise<void>;
}

export interface AgentWorkspaceCreator {
  create(input: {
    readonly createdBy: AgentControlRunScope["requestedBy"];
    readonly idempotencyKey: string;
    readonly kind: "specialized";
    readonly name: string;
    readonly storage?: WorkspaceStorageChoice;
  }): Promise<Workspace>;
}

export interface AgentTriggerManager {
  manage(
    ownerId: AgentControlRunScope["requestedBy"],
    input: TriggerControlInput,
    actorThreadId: Thread["id"] | null,
  ): Promise<unknown>;
}

type AgentControlBindingAuthorizer = RunCapabilityBindingAuthorizer;

export class AgentControlTokenService extends RunCapabilityTokenService<"opensteer-agent-control"> {
  constructor(options: {
    readonly authorizer: AgentControlBindingAuthorizer;
    readonly lifetimeSeconds?: number;
    readonly tokens: SignedTokenService;
  }) {
    super({ ...options, audience: "opensteer-agent-control" });
  }
}

export class AgentControlService {
  readonly #allowMainChatRunScreenShow: boolean;
  readonly #screenPresentation: ScreenPresentationService | undefined;
  readonly #supportsLoginFill: (scope: AgentControlRunScope) => boolean;
  readonly #browserSources: Pick<BrowserSourceService, "agentSignIn">;
  readonly #machineFullDiskAccess: Pick<MachineFullDiskAccessService, "request">;
  readonly #browser: Pick<
    BrowserService,
    | "createProfile"
    | "profileSiteData"
    | "closeAgentSession"
    | "listAgentSessions"
    | "listGrantedProfiles"
    | "openAgentSession"
    | "requestAccess"
    | "requestSaveProfile"
  >;
  readonly #browserTabs: BrowserTabGroupService | undefined;
  readonly #canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
  readonly #commands: CommandService;
  readonly #defaultWorkspaceBacking: WorkspaceBackingKind;
  readonly #environmentWorkspaceBackings: (
    environmentId: EnvironmentId,
  ) => readonly WorkspaceBackingKind[];
  readonly #isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #store: OpensteerStore;
  readonly #onBrowserUsage: ((credits: readonly BrowserUsageCredit[]) => void) | undefined;
  readonly #placeContext: Pick<PlaceContextService, "assertDelegated"> | undefined;
  readonly #tokens: AgentControlTokenService;
  readonly #triggers: AgentTriggerManager | undefined;
  readonly #workspaceMounts: AgentWorkspaceMountService;
  readonly #workspaceWake: AgentWorkspaceWaker | undefined;
  readonly #workspaces: AgentWorkspaceCreator;

  constructor(options: {
    readonly allowMainChatRunScreenShow?: boolean;
    readonly screenPresentation?: ScreenPresentationService;
    readonly supportsLoginFill?: (scope: AgentControlRunScope) => boolean;
    readonly browserSources: Pick<BrowserSourceService, "agentSignIn">;
    readonly machineFullDiskAccess: Pick<MachineFullDiskAccessService, "request">;
    readonly browser: Pick<
      BrowserService,
      | "createProfile"
      | "profileSiteData"
      | "closeAgentSession"
      | "listAgentSessions"
      | "listGrantedProfiles"
      | "openAgentSession"
      | "requestAccess"
      | "requestSaveProfile"
    >;
    readonly browserTabs?: BrowserTabGroupService;
    readonly canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
    readonly commands: CommandService;
    readonly defaultWorkspaceBacking: WorkspaceBackingKind;
    readonly environmentWorkspaceBackings: (
      environmentId: EnvironmentId,
    ) => readonly WorkspaceBackingKind[];
    readonly isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
    readonly onWorkspaceEvent: (event: AgentEvent) => void;
    readonly store: OpensteerStore;
    readonly onBrowserUsage?: (credits: readonly BrowserUsageCredit[]) => void;
    readonly placeContext?: Pick<PlaceContextService, "assertDelegated">;
    readonly tokens: AgentControlTokenService;
    readonly triggers?: AgentTriggerManager;
    readonly workspaceMounts: AgentWorkspaceMountService;
    readonly workspaceWake?: AgentWorkspaceWaker;
    readonly workspaces: AgentWorkspaceCreator;
  }) {
    this.#allowMainChatRunScreenShow = options.allowMainChatRunScreenShow ?? false;
    this.#screenPresentation = options.screenPresentation;
    this.#supportsLoginFill = options.supportsLoginFill ?? (() => false);
    this.#browserSources = options.browserSources;
    this.#machineFullDiskAccess = options.machineFullDiskAccess;
    this.#browser = options.browser;
    this.#browserTabs = options.browserTabs;
    this.#canRunHarness = options.canRunHarness;
    this.#commands = options.commands;
    this.#defaultWorkspaceBacking = options.defaultWorkspaceBacking;
    this.#environmentWorkspaceBackings = options.environmentWorkspaceBackings;
    this.#isEnvironmentConnected = options.isEnvironmentConnected;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#store = options.store;
    this.#placeContext = options.placeContext;
    this.#onBrowserUsage = options.onBrowserUsage;
    this.#tokens = options.tokens;
    this.#triggers = options.triggers;
    this.#workspaceMounts = options.workspaceMounts;
    this.#workspaceWake = options.workspaceWake;
    this.#workspaces = options.workspaces;
  }

  async #readableMessages(
    runId: AgentControlRunScope["runId"],
    messages: readonly Message[],
  ): Promise<readonly Message[]> {
    if (!messages.some((message) => message.content.some(isPlaceContentPart))) return messages;
    const capabilities = await this.#store.runPlaceCapabilities(runId);
    return messages.map((message) => ({
      ...message,
      content: message.content.map((part) => {
        if (!isPlaceContentPart(part)) return part;
        const capability =
          part.type === "browser-page" ? "browser-page-input-v1" : "native-place-input-v1";
        return capabilities.includes(capability)
          ? part
          : { type: "text" as const, text: placeContentLabel(part) };
      }),
    }));
  }
  async #readableMessage(runId: AgentControlRunScope["runId"], message: Message): Promise<Message> {
    return (await this.#readableMessages(runId, [message]))[0]!;
  }

  async handle(token: string, input: unknown): Promise<AgentControlResponse> {
    const claims = await this.#tokens.authenticate(token);
    const request = AgentControlRequestSchema.parse(input);
    if (request.type === "thread.delegate" && request.places)
      request.places = request.places.map((part) => {
        if (part.type !== "browser-page") return part;
        const { auto: _auto, documentId: _documentId, ...forwarded } = part;
        return forwarded;
      });
    const isMainProfile = claims.capabilityProfileId === "main";
    const [currentThread, mainMembership] = await Promise.all([
      this.#store.getThreadForOwner(claims.threadId, claims.requestedBy),
      isMainProfile
        ? this.#store.workspaceMembershipForUser(claims.workspaceId, claims.requestedBy)
        : null,
    ]);
    if (
      !currentThread ||
      currentThread.workspaceId !== claims.workspaceId ||
      currentThread.environmentId !== claims.environmentId ||
      currentThread.capabilityProfileId !== claims.capabilityProfileId
    ) {
      throw forbidden("Run no longer belongs to its claimed Workspace and environment");
    }
    if (isMainProfile) {
      if (!mainMembership || mainMembership.state !== "active" || mainMembership.role !== "owner") {
        throw forbidden("Main coordination requires active owner authority in this Workspace");
      }
    }

    assertToolAllowed(claims.capabilityProfileId, request);

    if (request.type === "screen.show") {
      let receipt: import("@opensteer/core").ScreenPresentationReceipt;
      try {
        const service = this.#screenPresentation;
        if (
          !this.#allowMainChatRunScreenShow ||
          !service ||
          !(await this.#store.runnerCapabilities(claims.runnerId))?.includes("screen-show-v1")
        ) {
          receipt = { outcome: "unsupported" };
        } else {
          const assertInput = async () => {
            const admitted = await this.#store.screenPresentationInput({
              ...claims,
              messageId: request.messageId,
            });
            if (
              !admitted ||
              !service.registry.matches(request.messageId, claims.requestedBy, claims.threadId) ||
              !service.registry.inputWasSent(
                request.messageId,
                claims.runId,
                claims.bindingGeneration,
                admitted.steerCommandId,
              )
            )
              throw forbidden("Input is not admitted to this Run");
          };
          await assertInput();
          await this.#admit(claims, request);
          const previous = service.registry.replay(request.messageId, request.target);
          if (previous) receipt = await previous;
          else {
            await service.authorizeTarget(claims.requestedBy, request.target);
            // Target resolution may wait on several services. The attempt and input must still stand.
            await assertInput();
            receipt = await service.registry.show(request.messageId, request.target);
          }
        }
      } catch {
        receipt = { outcome: "unavailable", reason: "forbidden" };
      }
      return AgentControlResponseSchema.parse({
        type: "screen.show.result",
        requestId: request.requestId,
        receipt,
      });
    }

    if (request.type === "trigger.control") {
      await this.#admit(claims, request);
      if (!this.#triggers) throw new Error("Trigger management is not configured");
      const result = await this.#triggers.manage(
        claims.requestedBy,
        triggerControlInput(claims, request),
        currentThread.id,
      );
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        result,
        type: "trigger.control.result",
      });
    }

    if (request.type === "environment.list") {
      await this.#admit(claims, request);
      const result = await environmentDiscovery({
        store: this.#store,
        userId: claims.requestedBy,
        parent: currentThread,
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
    if (request.type === "workspace.list") {
      await this.#admit(claims, request);
      const page = await this.#store.workspacePageForOwner({
        ownerId: claims.requestedBy,
        maxBytes: 64 * 1_024,
        maxItems: request.limit,
        ...(request.before ? { before: request.before } : {}),
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        type: "workspace.list.result",
        window: page.window,
        workspaces: page.workspaces.map(({ id, kind, name, status }) => ({
          id,
          kind,
          name,
          status,
        })),
      });
    }

    if (request.type === "workspace.inspect") {
      await this.#admit(claims, request);
      const [workspacePage, threadPage, environmentRows] = await Promise.all([
        this.#store.workspacePageForOwner({
          ...(request.workspaceBefore ? { before: request.workspaceBefore } : {}),
          maxBytes: 64 * 1_024,
          maxItems: request.maxWorkspaces ?? 25,
          ownerId: claims.requestedBy,
        }),
        this.#store.ownerThreadPageForOwner({
          ...(request.threadBefore ? { before: request.threadBefore } : {}),
          maxBytes: 64 * 1_024,
          maxItems: request.maxThreads ?? 50,
          ownerId: claims.requestedBy,
        }),
        this.#store.listEnvironmentsForUser(claims.requestedBy, 65),
      ]);
      const environments = environmentRows.slice(0, 64);
      const harnessPage = await delegationHarnessPage(this.#store, claims.requestedBy, request);
      const harnesses = harnessPage.harnesses;
      return AgentControlResponseSchema.parse({
        environments: environments.map(({ id, kind, name }) => ({
          compatibleHarnessInstanceIds: harnesses
            .filter(
              (harness) =>
                harness.environmentId === id && this.#canRunHarness(id, harness.driverKind),
            )
            .map((harness) => harness.id),
          connected: this.#isEnvironmentConnected(id),
          id,
          kind,
          name,
          workspaceBackings: this.#environmentWorkspaceBackings(id),
        })),
        environmentsTruncated: environmentRows.length > 64,
        delegationDefault: {
          environmentId: currentThread.environmentId,
          harnessInstanceId: currentThread.harnessInstanceId,
          model: {
            modelId: currentThread.modelSelection.modelId,
            options: currentThread.modelSelection.options,
            providerId: currentThread.modelSelection.providerId,
          },
        },
        harnesses: await delegationEngines(this.#store, harnesses, request.modelPage),
        harnessesTruncated: harnessPage.nextCursor !== undefined,
        ...(harnessPage.nextCursor !== undefined
          ? { harnessesNextCursor: harnessPage.nextCursor }
          : {}),
        requestId: request.requestId,
        threads: threadPage.threads,
        threadWindow: threadPage.window,
        type: "workspace.inspect.result",
        workspaces: workspacePage.workspaces.map(({ id, kind, name, status }) => ({
          id,
          kind,
          name,
          status,
        })),
        workspaceWindow: workspacePage.window,
      });
    }

    if (request.type === "workspace.create") {
      await this.#admit(claims, request);
      const workspace = await this.#workspaces.create({
        createdBy: claims.requestedBy,
        ...(request.icon ? { icon: request.icon } : {}),
        ...(request.color ? { color: request.color } : {}),
        idempotencyKey: idempotencyKey(claims, request.requestId, "workspace"),
        kind: "specialized",
        name: request.name,
        storage: callerWorkspaceStorage({
          callerEnvironmentId: claims.environmentId,
          defaultBacking: this.#defaultWorkspaceBacking,
          requested: request.storage,
        }),
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        type: "workspace.create.result",
        workspace: agentWorkspaceView(workspace),
      });
    }

    if (request.type === "workspace.mount") {
      const workspace = await this.#store.getWorkspaceForOwner(
        request.workspaceId,
        claims.requestedBy,
      );
      if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
      if (workspace.kind === "main") {
        throw badRequest("Main is not a valid mount target; its path is the Run Workspace");
      }
      if (workspace.status !== "ready") {
        // A Workspace whose storage sleeps is not a failed mount, it is a mount
        // that arrived first: the wake cancels a quiescing archive, and the
        // agent's retry mounts the restored filesystem.
        if (workspaceWakesOnDemand(workspace.status)) {
          void this.#workspaceWake?.wake(workspace.id, "agent-workspace-mount");
          throw conflict("Target Workspace filesystem is waking", true);
        }
        throw conflict(
          "Target Workspace filesystem is not ready",
          workspace.status === "provisioning" || workspace.status === "unavailable",
        );
      }
      const admission = await this.#admit(claims, request);
      const mounted = await this.#workspaceMounts.mount({
        requestId: request.requestId,
        scope: claims,
        workspace,
      });
      void admission;
      return AgentControlResponseSchema.parse({
        path: mounted.path,
        requestId: request.requestId,
        type: "workspace.mount.result",
        workspaceId: workspace.id,
      });
    }

    if (request.type === "thread.list") {
      const scope = threadListScope(currentThread);
      if (request.workspaceId) {
        const workspace = await this.#store.getWorkspaceForOwner(
          request.workspaceId,
          claims.requestedBy,
        );
        if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
        if (scope.kind === "workspace" && workspace.id !== currentThread.workspaceId) {
          throw forbidden("This capability profile can list Threads only in its Workspace");
        }
      }
      await this.#admit(claims, request);
      const page = await this.#store.agentThreadPageForOwner({
        ...(request.before ? { before: request.before } : {}),
        maxBytes: 128 * 1_024,
        maxItems: request.limit,
        ownerId: claims.requestedBy,
        ...(request.query ? { query: request.query } : {}),
        scope,
        scopeId: claims.threadId,
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      });
      const response = AgentControlResponseSchema.parse({
        requestId: request.requestId,
        threads: page.threads.map((summary) => ({
          environmentConnected: this.#isEnvironmentConnected(summary.environmentId),
          environmentId: summary.environmentId,
          id: summary.id,
          parentThreadId: summary.parentThreadId,
          pendingRequests: summary.pendingRequests,
          status: summary.status,
          doneAt: summary.doneAt,
          title: summary.title,
          updatedAt: summary.updatedAt,
          workspaceId: summary.workspaceId,
          workspaceName: summary.workspaceName,
        })),
        type: "thread.list.result",
        window: page.window,
      });
      if (response.type !== "thread.list.result") throw new Error("Thread list response mismatch");
      if ((await this.#store.runnerCapabilities(claims.runnerId))?.includes("task-done-v1"))
        return response;
      return {
        ...response,
        threads: response.threads.map(({ doneAt: _doneAt, ...summary }) => summary),
      };
    }

    if (request.type === "thread.read") {
      const thread = await this.#store.getThreadForOwner(request.threadId, claims.requestedBy);
      if (!thread) throw forbidden("Thread is unavailable to this user");
      this.#assertThreadScope(currentThread, thread);
      await this.#admit(claims, request);
      const page = await this.#store.threadMessagePageForOwner({
        ...(request.query ? { query: request.query } : {}),
        ...(request.aroundMessageId ? { aroundMessageId: request.aroundMessageId } : {}),
        ...(request.before ? { before: request.before } : {}),
        maxItems: request.maxMessages,
        maxBytes: 400 * 1_024,
        ownerId: claims.requestedBy,
        threadId: request.threadId,
      });
      if (!page) throw forbidden("Thread is unavailable to this user");
      const assignments = await this.#store.listThreadAssignmentsForOwner({
        threadId: thread.id,
        ownerId: claims.requestedBy,
        maxItems: 25,
        maxBytes: 128 * 1_024,
        ...(request.assignmentBefore ? { before: request.assignmentBefore } : {}),
      });
      if (!assignments) throw forbidden("Thread is unavailable to this user");
      return AgentControlResponseSchema.parse({
        assignments: assignments.assignments,
        assignmentWindow: assignments.window,
        messages: await this.#readableMessages(claims.runId, page.messages),
        requestId: request.requestId,
        thread,
        type: "thread.read.result",
        ...(this.#screenPresentation &&
        (await this.#store.runnerCapabilities(claims.runnerId))?.includes("screen-show-v1")
          ? {
              presentableSurfaces: await this.#screenPresentation.presentableSurfaces(
                claims.requestedBy,
                thread.id,
              ),
            }
          : {}),
        window: page.window,
      });
    }

    if (request.type === "thread.write") {
      if (!(await this.#store.runnerCapabilities(claims.runnerId))?.includes("task-done-v1"))
        throw forbidden("This Runner does not support task-done-v1");
      const write = request.input;
      const threadId = write.threadId ?? claims.threadId;
      const input = {
        threadId,
        requestedBy: claims.requestedBy,
        actorRunId: claims.runId,
        idempotencyKey: idempotencyKey(claims, request.requestId, "thread.write"),
      };
      if (write.action === "done" || write.action === "reopen") {
        const result = await this.#commands.setThreadDone({
          ...input,
          done: write.action === "done",
          admission: this.#admissionRequest(claims, request),
        });
        return AgentControlResponseSchema.parse({
          type: "thread.write.result",
          requestId: request.requestId,
          thread: await this.#writtenThreadSummary(result.thread, claims.requestedBy),
          doneWhenRunEnds: result.doneWhenRunEnds,
        });
      }
      const result =
        write.action === "rename"
          ? await this.#commands.renameThread({
              ...input,
              admission: this.#admissionRequest(claims, request),
              title: write.title!,
            })
          : await this.#commands.setThreadIcon({
              ...input,
              admission: this.#admissionRequest(claims, request),
              icon: write.icon!,
            });
      return AgentControlResponseSchema.parse({
        type: "thread.write.result",
        requestId: request.requestId,
        thread: await this.#writtenThreadSummary(result.thread, claims.requestedBy),
        doneWhenRunEnds: false,
      });
    }

    if (request.type === "assignment.cancel") {
      const cancelled = await this.#commands.cancelAssignment({
        assignmentId: request.assignmentId,
        requestedBy: claims.requestedBy,
        actorRunId: claims.runId,
        idempotencyKey: idempotencyKey(claims, request.requestId, "assignment.cancel"),
        admission: this.#admissionRequest(claims, request),
      });
      return AgentControlResponseSchema.parse({
        assignment: cancelled.assignment,
        requestId: request.requestId,
        type: "assignment.cancel.result",
      });
    }

    if (request.type === "request.list") {
      await this.#admit(claims, request);
      const page = await this.#store.requests.visiblePage({
        ...(request.before ? { before: request.before } : {}),
        limit: request.limit,
        originatingThreadId: claims.threadId,
        targetWorkspaceId: claims.workspaceId,
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        requests: page.requests,
        type: "request.list.result",
        window: page.window,
      });
    }

    if (request.type === "request.withdraw") {
      await this.#admit(claims, request);
      const withdrawn = await this.#store.requests.withdraw({
        requestId: request.targetRequestId,
        threadId: claims.threadId,
        withdrawnBy: claims.requestedBy,
      });
      for (const event of withdrawn.events) this.#onWorkspaceEvent(event);
      return AgentControlResponseSchema.parse({
        request: withdrawn.request,
        requestId: request.requestId,
        type: "request.withdraw.result",
      });
    }

    if (request.type === "thread.delegate") {
      return this.#commands.withInputAdmission(
        claims.requestedBy,
        idempotencyKey(claims, request.requestId, "delegate"),
        async () => {
          const existingThread = request.threadId
            ? await this.#store.getThreadForOwner(request.threadId, claims.requestedBy)
            : null;
          if (request.threadId && !existingThread) throw forbidden("Target Thread is unavailable");
          if (existingThread) {
            this.#assertThreadScope(currentThread, existingThread);
            if (existingThread.role !== "work" || existingThread.id === currentThread.id) {
              throw badRequest("Choose another work Thread for the assignment");
            }
          }
          const targetWorkspaceId = existingThread?.workspaceId ?? request.workspaceId;
          if (!targetWorkspaceId) throw badRequest("Choose a target Workspace or work Thread");
          const workspace = await this.#store.getWorkspaceForOwner(
            targetWorkspaceId,
            claims.requestedBy,
          );
          if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
          if (!isMainProfile && workspace.id !== currentThread.workspaceId) {
            throw forbidden("This capability profile can delegate only inside its Workspace");
          }
          const chosenEnvironmentId = request.environmentId;
          const environmentId =
            existingThread?.environmentId ?? chosenEnvironmentId ?? currentThread.environmentId;
          const environment = await this.#store.getEnvironment(environmentId);
          if (!environment) throw badRequest("Selected execution environment does not exist");
          if (
            chosenEnvironmentId &&
            !(await this.#store.environmentIsAvailableToUser(environment.id, claims.requestedBy))
          ) {
            throw forbidden("Selected execution environment is unavailable to this user");
          }
          // The owning-machine fence is a fact about the Workspace, not about how
          // the environment was named: an inherited environment lands on the wrong
          // disk exactly as easily as a chosen one, and the Run would be queued
          // before the dispatcher could refuse it.
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
            parent: currentThread,
          });
          const delegateInput = {
            callerIntent: {
              requestId: request.requestId,
              requestFingerprint: this.#admissionRequest(claims, request).requestFingerprint,
            },
            accessMode: existingThread?.accessMode ?? currentThread.accessMode,
            ...(existingThread ? { threadId: existingThread.id } : {}),
            createdBy: claims.requestedBy,
            environmentId: environment.id,
            harnessInstanceId: placement.harnessInstanceId,
            idempotencyKey: idempotencyKey(claims, request.requestId, "delegate"),
            modelSelection: placement.modelSelection,
            origin: {
              kind: "run",
              parentRunId: claims.runId,
              parentThreadId: claims.threadId,
            },
            task: [{ text: request.task, type: "text" }, ...(request.places ?? [])],
            title: request.title ?? provisionalThreadTitle(request.task),
            titleSource: request.title === undefined ? "provisional" : "chosen",
            ...(request.icon ? { icon: request.icon } : {}),
            workspaceId: workspace.id,
          } as const;
          const replayed = await this.#store.findDelegatedThreadByIdempotency(delegateInput);
          if (replayed) {
            return AgentControlResponseSchema.parse({
              requestId: request.requestId,
              result: {
                assignmentId: replayed.assignment.id,
                input: replayed.input,
                message: await this.#readableMessage(claims.runId, replayed.message),
                run: replayed.run,
                thread: replayed.thread,
              },
              type: "thread.delegate.result",
            });
          }
          if (request.places?.length) {
            if (!this.#placeContext) throw conflict("Place forwarding is unavailable on this Host");
            await this.#placeContext.assertDelegated({
              ownerId: claims.requestedBy,
              parent: currentThread,
              parts: request.places,
              ...(existingThread ? { targetThread: existingThread } : {}),
              workspaceId: workspace.id,
            });
          }
          if (workspace.status !== "ready") {
            throw conflict(
              "Target Workspace filesystem is not ready",
              workspace.status === "provisioning" || workspace.status === "unavailable",
            );
          }
          if (!chosenEnvironmentId && !this.#isEnvironmentConnected(environment.id)) {
            throw conflict("Selected execution environment is not connected", true);
          }
          const harness = await this.#store.getHarnessInstance(delegateInput.harnessInstanceId);
          if (!harness?.enabled) throw badRequest("Selected harness is disabled or unavailable");
          if (
            this.#isEnvironmentConnected(environment.id) &&
            !this.#canRunHarness(environment.id, harness.driverKind)
          ) {
            throw badRequest(
              `Selected execution environment cannot run harness driver ${harness.driverKind}`,
            );
          }
          const delegated = await this.#commands.delegateAdmittedThread({
            admission: { kind: "agent", request: this.#admissionRequest(claims, request) },
            input: delegateInput,
          });
          if (delegated.browserUsage) this.#onBrowserUsage?.(delegated.browserUsage);
          return AgentControlResponseSchema.parse({
            requestId: request.requestId,
            result: {
              assignmentId: delegated.assignment.id,
              input: delegated.input,
              message: await this.#readableMessage(claims.runId, delegated.message),
              run: delegated.run,
              thread: delegated.thread,
            },
            type: "thread.delegate.result",
          });
        },
      );
    }

    if (request.type === "browser.profile.create") {
      await this.#admit(claims, request);
      const profile = await this.#browser.createProfile({
        name: request.name,
        ownerId: claims.requestedBy,
        idempotencyKey: idempotencyKey(claims, request.requestId, "browserProfile"),
        workspaceId: claims.workspaceId,
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        profile: { id: profile.id, name: profile.name },
        type: "browser.profile.create.result",
      });
    }
    if (request.type === "browser.profile.list") {
      await this.#admit(claims, request);
      const profiles = await this.#browser.listGrantedProfiles(
        claims.requestedBy,
        claims.workspaceId,
      );
      const data =
        request.site === undefined
          ? undefined
          : await this.#browser.profileSiteData({
              ownerId: claims.requestedBy,
              profileIds: profiles.map(({ id }) => id),
              site: request.site,
            });
      return AgentControlResponseSchema.parse({
        profiles: data
          ? profiles.map((profile) => ({ ...profile, siteData: data.profiles.get(profile.id) }))
          : profiles,
        ...(data ? { site: data.site } : {}),
        requestId: request.requestId,
        type: "browser.profile.list.result",
      });
    }
    if (request.type === "browser.sign-in" || request.type === "sign-in") {
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        result: await this.#browserSources.agentSignIn({
          loginFill: this.#supportsLoginFill(claims),
          callId: request.requestId,
          // Delegated Threads use sites already allowed; only Threads that own
          // their Workspace's objective may ask the owner for a new one.
          canRequest:
            claims.capabilityProfileId === "main" || claims.capabilityProfileId === "workspace",
          ownerId: claims.requestedBy,
          reason: request.reason,
          runId: claims.runId,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          site: request.site,
          threadId: claims.threadId,
          workspaceId: claims.workspaceId,
        }),
        type: request.type === "sign-in" ? "sign-in.result" : "browser.sign-in.result",
      });
    }

    if (request.type === "machine.full-disk-access.request") {
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        result: await this.#machineFullDiskAccess.request({
          callId: request.requestId,
          computer: request.computer,
          reason: request.reason,
          claims,
        }),
        requestId: request.requestId,
        type: "machine.full-disk-access.request.result",
      });
    }

    if (request.type === "browser.access.request") {
      const workspaceId = request.workspaceId ?? claims.workspaceId;
      if (!isMainProfile && workspaceId !== claims.workspaceId) {
        throw forbidden(
          "This capability profile can request browser access only for its Workspace",
        );
      }
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        result: await this.#browser.requestAccess({
          callId: request.requestId,
          originatingWorkspaceId: claims.workspaceId,
          ownerId: claims.requestedBy,
          reason: request.reason,
          runId: claims.runId,
          suggestion: request.suggestion,
          threadId: claims.threadId,
          workspaceId,
        }),
        requestId: request.requestId,
        type: "browser.access.request.result",
      });
    }

    const agentBindingId = `run:${claims.runId}`;
    if (request.type === "browser.tab.read" || request.type === "browser.tab.write") {
      await this.#admit(claims, request);
      if (!this.#browserTabs)
        throw badRequest("Saved tab organization is unavailable on this Host.");
      const actor = {
        kind: "agent" as const,
        ownerId: claims.requestedBy,
        workspaceId: claims.workspaceId,
        threadId: claims.threadId,
        agentBindingId,
      };
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        type:
          request.type === "browser.tab.read"
            ? "browser.tab.read.result"
            : "browser.tab.write.result",
        result:
          request.type === "browser.tab.read"
            ? await this.#browserTabs.read(actor, request.input)
            : await this.#browserTabs.write(
                actor,
                request.input,
                idempotencyKey(claims, request.requestId, "browser.tab.write"),
              ),
      });
    }
    if (request.type === "browser.session.list") {
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        sessions: await this.#browser.listAgentSessions({
          agentBindingId,
          ownerId: claims.requestedBy,
          workspaceId: claims.workspaceId,
        }),
        type: "browser.session.list.result",
      });
    }
    if (request.type === "browser.profile.save") {
      if (claims.capabilityProfileId !== "main" && claims.capabilityProfileId !== "workspace") {
        throw forbidden("This capability profile cannot save a browser profile");
      }
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        result: await this.#browser.requestSaveProfile({
          callId: request.requestId,
          originatingWorkspaceId: claims.workspaceId,
          ownerId: claims.requestedBy,
          reason: request.reason,
          runId: claims.runId,
          sessionId: request.sessionId,
          ...(request.suggestedName ? { suggestedName: request.suggestedName } : {}),
          threadId: claims.threadId,
          workspaceId: claims.workspaceId,
        }),
        requestId: request.requestId,
        type: "browser.profile.save.result",
      });
    }
    if (request.type === "browser.session.open") {
      const chosenEnvironmentId = request.environmentId;
      if (chosenEnvironmentId) {
        const environment = await this.#store.getEnvironment(chosenEnvironmentId);
        if (!environment) throw badRequest("Selected execution environment does not exist");
        if (
          !(await this.#store.environmentIsAvailableToUser(chosenEnvironmentId, claims.requestedBy))
        ) {
          throw forbidden("Selected execution environment is unavailable to this user");
        }
      }
      await this.#admit(claims, request);
      const opened = await this.#browser.openAgentSession({
        agentBindingId,
        ...(chosenEnvironmentId ? { chosenEnvironmentId } : {}),
        environmentId: claims.environmentId,
        ...(request.fresh ? { fresh: request.fresh } : {}),
        ownerId: claims.requestedBy,
        ...(request.profileId ? { profileId: request.profileId } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        workspaceId: claims.workspaceId,
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        session: opened.session,
        type: "browser.session.open.result",
        wasExisting: opened.wasExisting,
      });
    }
    if (request.type === "browser.session.close") {
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        sessionId: await this.#browser.closeAgentSession({
          agentBindingId,
          ownerId: claims.requestedBy,
          sessionId: request.sessionId,
          workspaceId: claims.workspaceId,
        }),
        type: "browser.session.close.result",
      });
    }

    // Only delegation forwards structured references; an ordinary agent message grants none.
    if (request.content.some(isPlaceContentPart)) {
      throw badRequest(
        "A message from an agent cannot include a place reference. Forward selected references with thread_delegate places; ordinary messages use text instead.",
      );
    }
    const home = request.threadId === "home";
    const destination = home
      ? (await this.#store.findMainWorkspaceForOwner(claims.requestedBy))?.homeThreadId
      : ThreadIdSchema.parse(request.threadId);
    if (!destination) throw badRequest("Chat has not been started yet");
    if (destination === claims.threadId) {
      throw badRequest("An agent cannot message its own active Thread");
    }
    const thread = await this.#store.getThreadForOwner(destination, claims.requestedBy);
    if (!thread) throw forbidden("Thread is unavailable to this user");
    // Any Thread may leave its person's Home a report. Work there needs the
    // same reach as addressing Home by id.
    if (!home || request.delivery !== "report") this.#assertThreadScope(currentThread, thread);
    const delivered = await this.#commands.enqueueAdmittedThreadInput({
      admission: { kind: "agent", request: this.#admissionRequest(claims, request) },
      input: {
        content: request.content,
        idempotencyKey: idempotencyKey(claims, request.requestId, "message"),
        policy: request.delivery,
        requestedBy: claims.requestedBy,
        source: { kind: "agent", runId: claims.runId },
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

  async #writtenThreadSummary(thread: Thread, requestedBy: AgentControlRunScope["requestedBy"]) {
    const workspace = await this.#store.getWorkspaceForOwner(thread.workspaceId, requestedBy);
    if (!workspace) throw forbidden("Workspace is unavailable to this user");
    return {
      doneAt: thread.doneAt,
      environmentConnected: this.#isEnvironmentConnected(thread.environmentId),
      environmentId: thread.environmentId,
      id: thread.id,
      parentThreadId: thread.parentThreadId,
      pendingRequests: thread.pendingRequests,
      status: thread.status,
      title: thread.title,
      updatedAt: thread.updatedAt,
      workspaceId: thread.workspaceId,
      workspaceName: workspace.name,
    };
  }

  #assertThreadScope(current: Thread, target: Thread): void {
    if (threadInReach(current, target)) return;
    throw forbidden(
      current.capabilityProfileId === "workspace"
        ? "This capability profile can access Threads only in its Workspace"
        : "A delegated Thread can read only Threads in its delegation lineage",
    );
  }

  async #admit(
    claims: AgentControlRunScope,
    request: AgentControlRequest,
  ): Promise<AgentControlAdmissionResult> {
    return this.#store.admitAgentControlRequest(this.#admissionRequest(claims, request));
  }

  #admissionRequest(claims: AgentControlRunScope, request: AgentControlRequest) {
    return {
      action:
        request.type === "trigger.control"
          ? request.tool
          : request.type === "sign-in"
            ? "browser.sign-in"
            : request.type,
      bindingGeneration: claims.bindingGeneration,
      environmentId: claims.environmentId,
      membershipGeneration: claims.membershipGeneration,
      requestFingerprint: createHash("sha256")
        .update(JSON.stringify(request), "utf8")
        .digest("hex"),
      requestId: request.requestId,
      requestedBy: claims.requestedBy,
      runId: claims.runId,
      runnerBootId: claims.runnerBootId,
      runnerId: claims.runnerId,
      sourceThreadId: claims.threadId,
      workspaceId: claims.workspaceId,
    } as const;
  }
}

const toolForAction: Readonly<
  Record<Exclude<AgentControlRequest["type"], "trigger.control">, AgentToolId>
> = {
  "screen.show": "screen.show",
  "machine.full-disk-access.request": "machine.full-disk-access.request",
  "browser.access.request": "browser.access.request",
  // Previous-release Runners still send this action; it shares the current permission.
  "browser.sign-in": "sign-in",
  "sign-in": "sign-in",
  "browser.profile.create": "browser.profile.create",
  "browser.profile.list": "browser.profile.list",
  "browser.profile.save": "browser.profile.save",
  "browser.session.close": "browser.session.close",
  "browser.session.list": "browser.session.list",
  "browser.tab.read": "browser.tab.read",
  "browser.tab.write": "browser.tab.write",
  "browser.session.open": "browser.session.open",
  "request.list": "request.list",
  "request.withdraw": "request.withdraw",
  "assignment.cancel": "assignment.cancel",
  "thread.delegate": "thread.delegate",
  "thread.list": "thread.list",
  "thread.message": "thread.message",
  "thread.read": "thread.read",
  "thread.write": "thread.write",
  "workspace.create": "workspace.create",
  "workspace.inspect": "workspace.list",
  "workspace.list": "workspace.list",
  "environment.list": "environment.list",
  "workspace.mount": "workspace.mount",
};

function assertToolAllowed(
  profileId: AgentControlRunScope["capabilityProfileId"],
  request: AgentControlRequest,
): void {
  const toolId = AgentToolIdSchema.parse(
    request.type === "trigger.control" ? request.tool : toolForAction[request.type],
  );
  if (!capabilityProfileAcceptsTool(profileId, toolId)) {
    throw forbidden(`Capability profile ${profileId} does not allow ${toolId}`);
  }
}

/**
 * A Trigger create has no model-supplied idempotency key: the Run that asked
 * for it is the authority, so the key is derived from that Run exactly like
 * every other agent-initiated create.
 */
function triggerControlInput(
  claims: AgentControlRunScope,
  request: Extract<AgentControlRequest, { readonly type: "trigger.control" }>,
): TriggerControlInput {
  if (request.input.operation !== "create") {
    return request.input;
  }
  return {
    ...request.input,
    idempotencyKey: idempotencyKey(claims, request.requestId, "trigger.create"),
  };
}

function threadListScope(current: Thread): AgentThreadListScope {
  switch (current.capabilityProfileId) {
    case "main":
      return { kind: "user" };
    case "workspace":
      return { kind: "workspace", workspaceId: current.workspaceId };
    case "delegated":
    case "trigger":
      return { kind: "lineage", threadId: current.id };
  }
}

function idempotencyKey(claims: AgentControlRunScope, requestId: string, action: string): string {
  return `agent:${claims.runId}:${requestId}:${action}`;
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
