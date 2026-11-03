import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { SpecialistStore } from "@opensteer/database";
import type { PersonShowMessage } from "@opensteer/protocol";
import {
  isPlaceContentPart,
  OpensteerError,
  placeContentLabel,
  provisionalThreadTitle,
  ThreadIdSchema,
  type AgentEvent,
  type EnvironmentId,
  type HarnessId,
  type Message,
  type Thread,
  type WorkspaceBackingKind,
} from "@opensteer/core";
import type { BrowserUsageCredit, OpensteerStore } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import { computerAppIdentityKey } from "@opensteer/protocol";

import type { BrowserService } from "../../browser/browser-service.js";
import type { BrowserSourceService } from "../../browser/browser-source-service.js";
import type { BrowserTabGroupService } from "../../browser/browser-tab-group-service.js";
import type { PlaceContextService } from "../../computer-use/place-context-service.js";
import type { ComputerUseService } from "../../computer-use/computer-use-service.js";

import type { MachineFullDiskAccessService } from "../../shell/machine-full-disk-access-service.js";
import { specialistPlacement } from "../../agents/specialist-placement.js";
import { delegationPlacement } from "../../agents/delegation-placement.js";
import { environmentDiscovery } from "../../agents/environment-discovery.js";

import type {
  AgentControlRunScope,
  AgentWorkspaceMountService,
  AgentWorkspaceCreator,
} from "../../agents/agent-control-service.js";
import { callerThread, type AgentCaller } from "../agent-caller.js";
import type { ToolCall } from "./index.js";
import {
  assertMutableTarget,
  messageSource,
  assertTarget,
  callerContext,
  callerListScope,
  delegationOrigin,
  fingerprint,
  idempotencyKey,
  mutationAdmission,
  mutationOperationKey,
  operationId,
  requireRun,
  runAdmission,
} from "../operations.js";

export class ProductToolHandlers {
  readonly #computerUse:
    Pick<ComputerUseService, "sessionsForRunner" | "authorizeDisplay"> | undefined;
  readonly #personShow:
    | ((userId: AgentControlRunScope["requestedBy"], message: PersonShowMessage) => Promise<number>)
    | undefined;
  readonly #supportsLoginFill: (scope: AgentControlRunScope) => boolean;
  readonly #browserSources: Pick<BrowserSourceService, "agentSignIn">;
  readonly #machineFullDiskAccess: Pick<MachineFullDiskAccessService, "request">;
  readonly #browser: Pick<
    BrowserService,
    | "createProfile"
    | "drainRunPlaces"
    | "closeAgentSession"
    | "listAgentSessions"
    | "listGrantedProfiles"
    | "openAgentSession"
    | "requestAccess"
  >;
  readonly #browserTabs: BrowserTabGroupService | undefined;
  readonly #canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
  readonly #commands: CommandService;
  readonly #environmentWorkspaceBackings: (
    environmentId: EnvironmentId,
  ) => readonly WorkspaceBackingKind[];
  readonly #isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #store: OpensteerStore;
  readonly #onBrowserUsage: ((credits: readonly BrowserUsageCredit[]) => void) | undefined;
  readonly #placeContext: Pick<PlaceContextService, "assertDelegated"> | undefined;
  readonly #workspaceMounts: AgentWorkspaceMountService;

  readonly #workspaces: AgentWorkspaceCreator;

  constructor(options: {
    readonly computerUse?: Pick<ComputerUseService, "sessionsForRunner" | "authorizeDisplay">;
    readonly personShow?: (
      userId: AgentControlRunScope["requestedBy"],
      message: PersonShowMessage,
    ) => Promise<number>;
    readonly supportsLoginFill?: (scope: AgentControlRunScope) => boolean;
    readonly browserSources: Pick<BrowserSourceService, "agentSignIn">;
    readonly machineFullDiskAccess: Pick<MachineFullDiskAccessService, "request">;
    readonly browser: Pick<
      BrowserService,
      | "createProfile"
      | "drainRunPlaces"
      | "closeAgentSession"
      | "listAgentSessions"
      | "listGrantedProfiles"
      | "openAgentSession"
      | "requestAccess"
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
    readonly workspaceMounts: AgentWorkspaceMountService;
    readonly workspaces: AgentWorkspaceCreator;
  }) {
    this.#computerUse = options.computerUse;
    this.#personShow = options.personShow;
    this.#supportsLoginFill = options.supportsLoginFill ?? (() => false);
    this.#browserSources = options.browserSources;
    this.#machineFullDiskAccess = options.machineFullDiskAccess;
    this.#browser = options.browser;
    this.#browserTabs = options.browserTabs;
    this.#canRunHarness = options.canRunHarness;
    this.#commands = options.commands;
    this.#environmentWorkspaceBackings = options.environmentWorkspaceBackings;
    this.#isEnvironmentConnected = options.isEnvironmentConnected;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#store = options.store;
    this.#placeContext = options.placeContext;
    this.#onBrowserUsage = options.onBrowserUsage;
    this.#workspaceMounts = options.workspaceMounts;
    this.#workspaces = options.workspaces;
  }

  async #readableMessages(
    caller: AgentCaller,
    messages: readonly Message[],
  ): Promise<readonly Message[]> {
    if (!messages.some((message) => message.content.some(isPlaceContentPart))) return messages;
    const capabilities =
      caller.kind === "run" ? await this.#store.runPlaceCapabilities(caller.claims.runId) : [];
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
  async #readableMessage(caller: AgentCaller, message: Message): Promise<Message> {
    return (await this.#readableMessages(caller, [message]))[0]!;
  }

  async person_show({ caller, input, operationKey }: ToolCall<"person_show">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "person_show");
    if (await this.#store.runAssignment(claims.runId))
      throw forbidden("A task reaches the person through the Thread that assigned it");

    if (!this.#personShow) throw badRequest("Showing places is unavailable on this Host.");
    let target: PersonShowMessage["target"];
    if ("current" in input.target) {
      await this.#browser.drainRunPlaces(claims.runId);
      const current = await this.#store.latestRunPlace(claims.runId);
      if (!current) throw badRequest("This Run has no current place to show.");
      target = { place: current.data.place };
      const place = current.data.place;
      if (place.kind !== "browser") {
        const session = this.#computerUse
          ?.sessionsForRunner(place.machineId)
          .find(
            (session) =>
              session.runId === claims.runId &&
              (place.kind === "phone"
                ? session.display && place.display === "main"
                : session.apps.some((app) => computerAppIdentityKey(app) === place.appKey)),
          );
        if (!session || !this.#computerUse)
          throw forbidden("This Run's current place is unavailable.");
        await this.#computerUse.authorizeDisplay(
          session.sessionId,
          claims.requestedBy,
          place.kind === "app" ? place.appKey : undefined,
        );
      }
    } else target = input.target;
    const tabId =
      "tabId" in target
        ? target.tabId
        : "place" in target && target.place.kind === "browser"
          ? target.place.surfaceId
          : null;
    if (tabId !== null) {
      if (!this.#browserTabs) throw badRequest("Saved tabs are unavailable on this Host.");
      await this.#browserTabs.authorizeShow(
        {
          kind: "agent",
          ownerId: claims.requestedBy,
          workspaceId: claims.workspaceId,
          threadId: claims.threadId,
          agentBindingId: `run:${claims.runId}`,
        },
        tabId,
      );
    } else if ("threadId" in target) {
      const targetThread = await this.#store.getThreadForOwner(target.threadId, claims.requestedBy);
      if (!targetThread) throw forbidden("Thread is unavailable to this user");
      assertTarget(caller, targetThread);
    }
    const admission = await this.#store.admitAgentControlRequest(
      runAdmission(caller, "person_show", input, requestId),
    );
    const connectedDevices = admission.wasDuplicate
      ? 0
      : await this.#personShow(claims.requestedBy, {
          type: "host.show",
          workspaceId: claims.workspaceId,
          threadId: claims.threadId,
          runId: claims.runId,
          target,
        });
    return {
      connectedDevices,
      status: admission.wasDuplicate
        ? "already-requested"
        : connectedDevices > 0
          ? "sent-unconfirmed"
          : "no-device-connected",
    };
  }

  async person_message({ caller, input, operationKey }: ToolCall<"person_message">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "person_message");
    if (await this.#store.runAssignment(claims.runId))
      throw forbidden("A task reaches the person through the Thread that assigned it");

    const result = await this.#commands.publishPersonMessage({
      admission: runAdmission(caller, "person_message", input, requestId),
      message: input.message,
    });
    return { messageId: result.message.id };
  }

  async environment_list({ caller, input }: ToolCall<"environment_list">) {
    const currentThread = callerThread(caller);
    const claims = { requestedBy: caller.userId };

    const result = await environmentDiscovery({
      store: this.#store,
      userId: claims.requestedBy,
      parent: currentThread,
      input,
      connected: this.#isEnvironmentConnected,
      canRun: this.#canRunHarness,
      workspaceBackings: this.#environmentWorkspaceBackings,
    });
    return { ...result };
  }

  async project_list({ caller, input }: ToolCall<"project_list">) {
    const claims = { requestedBy: caller.userId };

    if (caller.reach.kind !== "user") {
      const workspaceId =
        caller.reach.kind === "workspace"
          ? caller.reach.workspaceId
          : callerThread(caller).workspaceId;
      const workspace = await this.#store.getWorkspaceForOwner(workspaceId, caller.userId);
      const projects =
        !input.before && workspace?.kind === "project"
          ? [
              {
                id: workspace.id,
                kind: workspace.kind,
                name: workspace.name,
                status: workspace.status,
              },
            ]
          : [];
      return {
        projects,
        window: {
          byteCount: new TextEncoder().encode(JSON.stringify(projects)).byteLength,
          hasMore: false,
          itemCount: projects.length,
          nextBefore: null,
          totalItems: projects.length,
        },
      };
    }
    const page = await this.#store.workspacePageForOwner({
      ownerId: claims.requestedBy,
      maxBytes: 64 * 1_024,
      maxItems: input.limit,
      ...(input.before ? { before: input.before } : {}),
    });
    return {
      projects: page.workspaces
        .filter(({ kind }) => kind === "project")
        .map(({ id, kind, name, status }) => ({ id, kind, name, status })),
      window: page.window,
    };
  }

  async project_create({ caller, input, operationKey }: ToolCall<"project_create">) {
    if (caller.reach.kind !== "user") throw forbidden("Creating a Project requires user reach");
    const claims = { requestedBy: caller.userId };
    const requestId = operationId(caller, operationKey, "project_create");

    const workspace = await this.#workspaces.create({
      createdBy: claims.requestedBy,
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.color ? { color: input.color } : {}),
      idempotencyKey: idempotencyKey(caller, requestId, "workspace"),
      kind: "project",
      name: input.name,
    });
    return {
      id: workspace.id,
      slug: workspace.slug,
      path:
        caller.kind !== "run"
          ? await this.#workspaces.projectPath(workspace)
          : (
              await this.#workspaceMounts.mount({
                requestId: requestId,
                scope: requireRun(caller).claims,
                workspace,
              })
            ).path,
    };
  }

  async thread_list({ caller, input }: ToolCall<"thread_list">) {
    const claims = { requestedBy: caller.userId };

    const scope = callerListScope(caller);
    if (input.workspaceId) {
      const workspace = await this.#store.getWorkspaceForOwner(
        input.workspaceId,
        claims.requestedBy,
      );
      if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
      if (scope.kind === "workspace" && workspace.id !== scope.workspaceId) {
        throw forbidden("Caller can list Threads only in its Workspace");
      }
    }

    const page = await this.#store.agentThreadPageForOwner({
      ...(input.before ? { before: input.before } : {}),
      maxBytes: 128 * 1_024,
      maxItems: input.limit,
      ownerId: claims.requestedBy,
      ...(input.query ? { query: input.query } : {}),
      scope,
      scopeId: caller.kind === "connection" ? caller.key : callerThread(caller).id,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
    const response = {
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
      window: page.window,
    };

    return response;
  }

  async thread_read({ caller, input }: ToolCall<"thread_read">) {
    const claims = { requestedBy: caller.userId };

    const thread = await this.#store.getThreadForOwner(input.threadId, claims.requestedBy);
    if (!thread) throw forbidden("Thread is unavailable to this user");
    assertTarget(caller, thread);

    const page = await this.#store.threadMessagePageForOwner({
      ...(input.query ? { query: input.query } : {}),
      ...(input.aroundMessageId ? { aroundMessageId: input.aroundMessageId } : {}),
      ...(input.before ? { before: input.before } : {}),
      maxItems: input.maxMessages,
      maxBytes: 400 * 1_024,
      ownerId: claims.requestedBy,
      threadId: input.threadId,
    });
    if (!page) throw forbidden("Thread is unavailable to this user");
    const assignments = await this.#store.listThreadAssignmentsForOwner({
      threadId: thread.id,
      ownerId: claims.requestedBy,
      maxItems: 25,
      maxBytes: 128 * 1_024,
      ...(input.assignmentBefore ? { before: input.assignmentBefore } : {}),
    });
    if (!assignments) throw forbidden("Thread is unavailable to this user");
    return {
      assignments: assignments.assignments,
      assignmentWindow: assignments.window,
      messages: await this.#readableMessages(
        caller,
        page.messages.map(({ addressedToUserId: _addressedToUserId, ...message }) => message),
      ),
      thread,
      window: page.window,
    };
  }

  async thread_write({ caller, input, operationKey }: ToolCall<"thread_write">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "thread_write");

    const { operationKey: _operationKey, ...write } = input;
    const threadId = write.threadId ?? claims.threadId;
    const target = await this.#store.getThreadForOwner(threadId, caller.userId);
    if (!target) throw forbidden("Thread is unavailable");
    assertMutableTarget(caller, target);
    const command = {
      threadId,
      requestedBy: claims.requestedBy,
      actorRunId: claims.runId,
      idempotencyKey: idempotencyKey(caller, requestId, "thread.write"),
    };
    if (write.action === "done" || write.action === "reopen") {
      const result = await this.#commands.setThreadDone({
        ...command,
        done: write.action === "done",
        admission: runAdmission(caller, "thread_write", input, requestId, [threadId]),
      });
      return {
        thread: await this.#writtenThreadSummary(result.thread, claims.requestedBy),
        doneWhenRunEnds: result.doneWhenRunEnds,
      };
    }
    const result =
      write.action === "rename"
        ? await this.#commands.renameThread({
            ...command,
            admission: runAdmission(caller, "thread_write", input, requestId, [threadId]),
            title: write.title!,
          })
        : await this.#commands.setThreadIcon({
            ...command,
            admission: runAdmission(caller, "thread_write", input, requestId, [threadId]),
            icon: write.icon!,
          });
    return {
      thread: await this.#writtenThreadSummary(result.thread, claims.requestedBy),
      doneWhenRunEnds: false,
    };
  }

  async assignment_cancel({ caller, input, operationKey }: ToolCall<"assignment_cancel">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "assignment_cancel");

    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: input.assignmentId,
      ownerId: caller.userId,
    });
    if (!assignment) throw forbidden("Assignment is unavailable");
    const target = await this.#store.getThreadForOwner(assignment.workerThreadId, caller.userId);
    if (!target) throw forbidden("Thread is unavailable");
    assertMutableTarget(caller, target);
    const cancelled = await this.#commands.cancelAssignment({
      assignmentId: input.assignmentId,
      requestedBy: claims.requestedBy,
      actorRunId: claims.runId,
      idempotencyKey: idempotencyKey(caller, requestId, "assignment.cancel"),
      admission: runAdmission(caller, "assignment_cancel", input, requestId, [
        assignment.workerThreadId,
      ]),
    });
    return { assignment: cancelled.assignment };
  }

  async request_list({ caller, input }: ToolCall<"request_list">) {
    const claims = callerContext(caller);

    const page = await this.#store.requests.visiblePage({
      ...(input.before ? { before: input.before } : {}),
      limit: input.limit,
      originatingThreadId: claims.threadId,
      targetWorkspaceId: claims.workspaceId,
    });
    return { requests: page.requests, window: page.window };
  }

  async request_withdraw({ caller, input }: ToolCall<"request_withdraw">) {
    const claims = requireRun(caller).claims;

    const withdrawn = await this.#store.requests.withdraw({
      requestId: input.requestId,
      threadId: claims.threadId,
      withdrawnBy: claims.requestedBy,
    });
    for (const event of withdrawn.events) this.#onWorkspaceEvent(event);
    return { request: withdrawn.request };
  }

  async prepareDelegation({ caller, input }: ToolCall<"thread_delegate">) {
    const currentThread = callerThread(caller);
    const claims = callerContext(caller);
    const existingThread = input.threadId
      ? await this.#store.getThreadForOwner(input.threadId, claims.requestedBy)
      : null;
    if (input.threadId && !existingThread) throw forbidden("Target Thread is unavailable");
    if (existingThread) {
      assertMutableTarget(caller, existingThread);
      if (existingThread.role !== "work" || existingThread.id === currentThread.id) {
        throw badRequest("Choose another work Thread for the assignment");
      }
    }
    const targetWorkspaceId =
      existingThread?.workspaceId ??
      input.workspaceId ??
      (input.specialist ? currentThread.workspaceId : undefined);
    if (!targetWorkspaceId) throw badRequest("Choose a target Workspace or work Thread");
    const workspace = await this.#store.getWorkspaceForOwner(targetWorkspaceId, claims.requestedBy);
    if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
    if (caller.reach.kind !== "user" && workspace.id !== currentThread.workspaceId) {
      throw forbidden("Caller can delegate only inside its Workspace");
    }
    const registrations =
      input.specialist || existingThread?.specialistId
        ? await new SpecialistStore(this.#store.database).list(workspace.id, claims.requestedBy)
        : [];
    const specialist = existingThread?.specialistId
      ? registrations.find((r) => r.id === existingThread.specialistId)
      : (registrations.find((r) => r.id === input.specialist) ??
        registrations.find(
          (r) => r.plugin === input.specialist && r.ownerUserId === claims.requestedBy,
        ) ??
        registrations.find((r) => r.plugin === input.specialist));
    if ((input.specialist || existingThread?.specialistId) && !specialist)
      throw badRequest("Specialist is not registered in this Workspace");
    if (
      existingThread &&
      input.specialist &&
      input.specialist !== specialist?.id &&
      input.specialist !== specialist?.plugin
    )
      throw badRequest("An existing Thread keeps its specialist binding");
    if (specialist && specialist.ownerUserId !== claims.requestedBy)
      throw forbidden(
        `${specialist.plugin} uses ${specialist.ownerName ?? specialist.ownerUserId}'s accounts; add it for yourself to use your own`,
      );
    if (specialist?.status === "pending")
      throw badRequest(
        `Specialist is pending: ${specialist.access
          .filter((a) => a.state !== "bound")
          .map((a) => `${a.type}: ${a.state} (${a.reason})`)
          .join("; ")}`,
      );
    if (specialist)
      await new SpecialistStore(this.#store.database).assertRunnable(
        specialist.id,
        workspace.id,
        claims.requestedBy,
      );
    if (specialist && (input.model || input.harnessInstanceId || input.environmentId))
      throw badRequest("Specialist execution is selected by its registration");
    const chosenEnvironmentId = input.environmentId;
    const environmentId =
      existingThread?.environmentId ??
      chosenEnvironmentId ??
      (specialist && workspace.backing.kind === "local-directory"
        ? workspace.backing.ownerEnvironmentId
        : currentThread.environmentId);
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
    const placement =
      specialist && !existingThread
        ? await specialistPlacement(this.#store, {
            environment,
            parent: currentThread,
            specialist,
            canRun: (engine) => this.#canRunHarness(environment.id, engine),
          })
        : await delegationPlacement(this.#store, {
            environment,
            existingThread,
            harnessInstanceId: input.harnessInstanceId,
            model: input.model,
            parent: currentThread,
          });

    return { existingThread, workspace, specialist, environment, placement, chosenEnvironmentId };
  }
  async thread_delegate({ caller, input, operationKey }: ToolCall<"thread_delegate">) {
    const currentThread = callerThread(caller);
    const claims = callerContext(caller);
    if (input.places)
      input = {
        ...input,
        places: input.places.map((part) => {
          if (part.type !== "browser-page") return part;
          const { auto: _auto, documentId: _documentId, ...forwarded } = part;
          return forwarded;
        }),
      };
    const requestId = operationId(
      caller,
      mutationOperationKey(caller, input, operationKey),
      "thread_delegate",
    );

    if (caller.kind !== "run" && input.places?.length)
      throw badRequest("Program delegation cannot forward place references");

    return this.#commands.withInputAdmission(
      claims.requestedBy,
      idempotencyKey(caller, requestId, "delegate"),
      async () => {
        const {
          existingThread,
          workspace,
          specialist,
          environment,
          placement,
          chosenEnvironmentId,
        } = await this.prepareDelegation({ caller, input, operationKey });
        const delegateInput = {
          ...(specialist ? { specialistId: specialist.id } : {}),
          callerIntent: {
            requestId: requestId,
            requestFingerprint: fingerprint(input),
          },
          accessMode: existingThread?.accessMode ?? caller.accessMode,
          ...(existingThread ? { threadId: existingThread.id } : {}),
          createdBy: claims.requestedBy,
          environmentId: environment.id,
          harnessInstanceId: placement.harnessInstanceId,
          idempotencyKey: idempotencyKey(caller, requestId, "delegate"),
          modelSelection: placement.modelSelection,
          origin: delegationOrigin(caller, input.observationId ?? requestId),
          task: [{ text: input.task, type: "text" }, ...(input.places ?? [])],
          title: input.title ?? provisionalThreadTitle(input.task),
          titleSource: input.title === undefined ? "provisional" : "chosen",
          ...(input.icon ? { icon: input.icon } : {}),
          workspaceId: workspace.id,
        } as const;
        const replayed = await this.#store.findDelegatedThreadByIdempotency(delegateInput);
        if (replayed) {
          return {
            assignmentId: replayed.assignment.id,
            input: replayed.input,
            message: await this.#readableMessage(caller, replayed.message),
            run: replayed.run,
            thread: replayed.thread,
          };
        }
        if (input.places?.length) {
          if (!this.#placeContext) throw conflict("Place forwarding is unavailable on this Host");
          await this.#placeContext.assertDelegated({
            ownerId: claims.requestedBy,
            parent: currentThread,
            parts: input.places,
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
          admission: mutationAdmission(
            caller,
            "thread_delegate",
            input,
            requestId,
            existingThread ? [existingThread.id] : [],
          ),
          input: delegateInput,
        });
        if (delegated.browserUsage) this.#onBrowserUsage?.(delegated.browserUsage);
        return {
          assignmentId: delegated.assignment.id,
          input: delegated.input,
          message: await this.#readableMessage(caller, delegated.message),
          run: delegated.run,
          thread: delegated.thread,
        };
      },
    );
  }

  async browser_profile_create({
    caller,
    input,
    operationKey,
  }: ToolCall<"browser_profile_create">) {
    const claims = callerContext(caller);
    const requestId = operationId(caller, operationKey, "browser_profile_create");

    const profile = await this.#browser.createProfile({
      name: input.name,
      ownerId: claims.requestedBy,
      idempotencyKey: idempotencyKey(caller, requestId, "browserProfile"),
      workspaceId: claims.workspaceId,
    });
    return { profile: { id: profile.id, name: profile.name } };
  }

  async browser_profile_list({ caller }: ToolCall<"browser_profile_list">) {
    const claims = callerContext(caller);

    const profiles = await this.#browser.listGrantedProfiles(
      claims.requestedBy,
      claims.workspaceId,
      caller.key,
    );
    return { profiles };
  }

  async sign_in({ caller, input, operationKey }: ToolCall<"sign_in">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "sign_in");

    return await this.#browserSources.agentSignIn({
      loginFill: this.#supportsLoginFill(claims),
      callId: requestId,
      canRequest: true,
      ownerId: claims.requestedBy,
      reason: input.reason,
      runId: claims.runId,
      ...(input.sessionId === undefined
        ? {}
        : { sessionId: BrowserSessionIdSchema.parse(input.sessionId) }),
      site: input.site,
      threadId: claims.threadId,
      workspaceId: claims.workspaceId,
    });
  }

  async machine_full_disk_access_request({
    caller,
    input,
    operationKey,
  }: ToolCall<"machine_full_disk_access_request">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "machine_full_disk_access_request");

    return await this.#machineFullDiskAccess.request({
      callId: requestId,
      computer: input.computer,
      reason: input.reason,
      claims,
    });
  }

  async browser_access_request({
    caller,
    input,
    operationKey,
  }: ToolCall<"browser_access_request">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "browser_access_request");

    const workspaceId = input.workspaceId ?? claims.workspaceId;
    if (caller.reach.kind !== "user" && workspaceId !== claims.workspaceId) {
      throw forbidden("Caller can request browser access only for its Workspace");
    }

    return await this.#browser.requestAccess({
      callId: requestId,
      originatingWorkspaceId: claims.workspaceId,
      ownerId: claims.requestedBy,
      reason: input.reason,
      runId: claims.runId,
      suggestion: input.suggestion,
      threadId: claims.threadId,
      workspaceId,
    });
  }

  async browser_tab_read({ caller, input }: ToolCall<"browser_tab_read">) {
    const claims = callerContext(caller);

    const agentBindingId = caller.key;

    if (!this.#browserTabs) throw badRequest("Saved tab organization is unavailable on this Host.");
    const actor = {
      kind: "agent" as const,
      ownerId: claims.requestedBy,
      workspaceId: claims.workspaceId,
      threadId: claims.threadId,
      agentBindingId,
    };
    const read = input;
    return this.#browserTabs.read(actor, read);
  }

  async browser_tab_write({ caller, input, operationKey }: ToolCall<"browser_tab_write">) {
    const claims = callerContext(caller);
    const requestId = operationId(caller, operationKey, "browser_tab_write");
    const agentBindingId = caller.key;

    if (!this.#browserTabs) throw badRequest("Saved tab organization is unavailable on this Host.");
    const actor = {
      kind: "agent" as const,
      ownerId: claims.requestedBy,
      workspaceId: claims.workspaceId,
      threadId: claims.threadId,
      agentBindingId,
    };
    const { operationKey: _operationKey, ...write } = input;
    return this.#browserTabs.write(
      actor,
      write,
      idempotencyKey(caller, requestId, "browser.tab.write"),
    );
  }

  async browser_session_list({ caller }: ToolCall<"browser_session_list">) {
    const claims = callerContext(caller);

    const agentBindingId = caller.key;

    return {
      sessions: await this.#browser.listAgentSessions({
        agentBindingId,
        ownerId: claims.requestedBy,
        workspaceId: claims.workspaceId,
      }),
    };
  }

  async browser_session_open({ caller, input }: ToolCall<"browser_session_open">) {
    const claims = callerContext(caller);

    const agentBindingId = caller.key;

    const chosenEnvironmentId = input.environmentId;
    if (chosenEnvironmentId) {
      const environment = await this.#store.getEnvironment(chosenEnvironmentId);
      if (!environment) throw badRequest("Selected execution environment does not exist");
      if (
        !(await this.#store.environmentIsAvailableToUser(chosenEnvironmentId, claims.requestedBy))
      ) {
        throw forbidden("Selected execution environment is unavailable to this user");
      }
    }

    const opened = await this.#browser.openAgentSession({
      agentBindingId,
      ...(chosenEnvironmentId ? { chosenEnvironmentId } : {}),
      environmentId: claims.environmentId,
      ...(input.fresh ? { fresh: input.fresh } : {}),
      ownerId: claims.requestedBy,
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.sessionId ? { sessionId: BrowserSessionIdSchema.parse(input.sessionId) } : {}),
      workspaceId: claims.workspaceId,
    });
    return { session: opened.session, wasExisting: opened.wasExisting };
  }

  async browser_session_close({ caller, input }: ToolCall<"browser_session_close">) {
    const claims = callerContext(caller);

    const agentBindingId = caller.key;

    return {
      closed: true,
      sessionId: await this.#browser.closeAgentSession({
        agentBindingId,
        ownerId: claims.requestedBy,
        sessionId: BrowserSessionIdSchema.parse(input.sessionId),
        workspaceId: claims.workspaceId,
      }),
    };
  }

  async thread_message({ caller, input, operationKey }: ToolCall<"thread_message">) {
    const anchor = callerThread(caller);
    const requestId = operationId(
      caller,
      mutationOperationKey(caller, input, operationKey),
      "thread_message",
    );
    const observationId = input.observationId ?? requestId;
    const destination =
      input.threadId === "home"
        ? (await this.#store.findMainWorkspaceForOwner(caller.userId))?.homeThreadId
        : ThreadIdSchema.parse(input.threadId);
    if (!destination) throw badRequest("Chat has not been started yet");
    if (destination === anchor.id && caller.kind === "run")
      throw badRequest("An agent cannot message its own active Thread");
    const thread = await this.#store.getThreadForOwner(destination, caller.userId);
    if (!thread) throw forbidden("Thread is unavailable to this user");
    assertMutableTarget(caller, thread);
    if (thread.specialistId && input.delivery !== "report")
      await new SpecialistStore(this.#store.database).assertRunnable(
        thread.specialistId,
        thread.workspaceId,
        caller.userId,
      );
    const delivered = await this.#commands.enqueueAdmittedThreadInput({
      admission: mutationAdmission(caller, "thread_message", input, requestId, [thread.id]),
      input: {
        content: [{ type: "text", text: input.message }],
        idempotencyKey: idempotencyKey(caller, requestId, "message"),
        policy: input.delivery,
        requestedBy: caller.userId,
        source: messageSource(caller, observationId),
        threadId: thread.id,
      },
    });
    return {
      assignmentId: delivered.input.assignmentId,
      disposition: delivered.disposition,
      input: delivered.input,
      message: delivered.message,
      run: delivered.run,
      thread,
    };
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
