import { isDeepStrictEqual } from "node:util";
import { ThreadService } from "../../threads/thread-service.js";
import { ThreadWaitService } from "../../threads/thread-wait.js";
import { readThreadWaitSnapshot } from "@opensteer/database";
import { withDatabaseTransaction } from "@opensteer/database";
import { assertThreadCaller } from "@opensteer/database";
import type { RealtimeHub } from "@opensteer/orchestration";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { SpecialistStore } from "@opensteer/database";
import type { PersonShowMessage } from "@opensteer/protocol";
import {
  catalogDefaultCandidate,
  catalogDefaultModelSelection,
  isPlaceContentPart,
  zeroSequence,
  OpensteerError,
  placeContentLabel,
  provisionalThreadTitle,
  ThreadIdSchema,
  WorkspaceIdSchema,
  type AgentEvent,
  type EnvironmentId,
  type UserId,
  type HarnessId,
  type Message,
  type Thread,
  type ThreadAccessMode,
  type Workspace,
  type WorkspaceBackingKind,
  voiceRequestHandOff,
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
import {
  specialistPlacement,
  resolveDelegationSpecialist,
} from "../../agents/specialist-placement.js";
import { delegationPlacement } from "../../agents/delegation-placement.js";
import { environmentDiscovery } from "../../agents/environment-discovery.js";

import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import type { AgentWorkspaceMountService } from "../../agents/agent-workspace-mount-service.js";
import type { MemoryPassService } from "../../agents/memory-pass-service.js";
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
  operationId,
  requireRun,
  runAdmission,
  threadCallerAuthority,
} from "../operations.js";

interface AgentWorkspaceCreator {
  projectPath(workspace: Workspace): Promise<string>;
  create(input: {
    readonly createdBy: RunToolScope["requestedBy"];
    readonly idempotencyKey: string;
    readonly kind: "project";
    readonly name: string;
  }): Promise<Workspace>;
}

interface ConnectionTask {
  readonly thread: Thread;
  readonly expectedHarnessRevision?: number;
}

export class ProductToolHandlers {
  readonly #threads: ThreadService;
  readonly #realtime: Pick<RealtimeHub, "observe" | "sendToUsers">;
  readonly #computerUse:
    Pick<ComputerUseService, "sessionsForRunner" | "authorizeDisplay"> | undefined;
  readonly #personShow:
    | ((userId: RunToolScope["requestedBy"], message: PersonShowMessage) => Promise<number>)
    | undefined;
  readonly #supportsLoginFill: (scope: RunToolScope) => boolean;
  readonly #browserSources: Pick<BrowserSourceService, "agentSignIn" | "agentUseCard">;
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
  readonly #harnessAccessModes: (
    environmentId: EnvironmentId,
    driverKind: HarnessId,
  ) => readonly ThreadAccessMode[] | undefined;
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
  readonly #memoryPasses: Pick<MemoryPassService, "admissionSelection"> | undefined;
  readonly #workspaces: AgentWorkspaceCreator;

  constructor(options: {
    readonly threads: ThreadService;
    readonly realtime: Pick<RealtimeHub, "observe" | "sendToUsers">;
    readonly computerUse?: Pick<ComputerUseService, "sessionsForRunner" | "authorizeDisplay">;
    readonly personShow?: (
      userId: RunToolScope["requestedBy"],
      message: PersonShowMessage,
    ) => Promise<number>;
    readonly supportsLoginFill?: (scope: RunToolScope) => boolean;
    readonly browserSources: Pick<BrowserSourceService, "agentSignIn" | "agentUseCard">;
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
    /** The access modes an engine enforces on a computer; undefined when it cannot run there. */
    readonly harnessAccessModes: (
      environmentId: EnvironmentId,
      driverKind: HarnessId,
    ) => readonly ThreadAccessMode[] | undefined;
    readonly commands: CommandService;
    readonly defaultWorkspaceBacking: WorkspaceBackingKind;
    readonly environmentWorkspaceBackings: (
      environmentId: EnvironmentId,
    ) => readonly WorkspaceBackingKind[];
    readonly isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
    readonly memoryPasses?: Pick<MemoryPassService, "admissionSelection">;
    readonly onWorkspaceEvent: (event: AgentEvent) => void;
    readonly store: OpensteerStore;
    readonly onBrowserUsage?: (credits: readonly BrowserUsageCredit[]) => void;
    readonly placeContext?: Pick<PlaceContextService, "assertDelegated">;
    readonly workspaceMounts: AgentWorkspaceMountService;
    readonly workspaces: AgentWorkspaceCreator;
  }) {
    this.#threads = options.threads;
    this.#memoryPasses = options.memoryPasses;
    this.#realtime = options.realtime;
    this.#computerUse = options.computerUse;
    this.#personShow = options.personShow;
    this.#supportsLoginFill = options.supportsLoginFill ?? (() => false);
    this.#browserSources = options.browserSources;
    this.#machineFullDiskAccess = options.machineFullDiskAccess;
    this.#browser = options.browser;
    this.#browserTabs = options.browserTabs;
    this.#canRunHarness = options.canRunHarness;
    this.#harnessAccessModes = options.harnessAccessModes;
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

  async preparePersonShow({ caller, input }: ToolCall<"person_show">) {
    const claims = requireRun(caller).claims;
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
    return target;
  }

  async person_show(call: ToolCall<"person_show">) {
    const { caller, input, operationKey } = call;
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "person_show");
    const target = await this.preparePersonShow(call);
    if (!this.#personShow) throw badRequest("Showing places is unavailable on this Host.");
    const admission = await this.#store.admitRunToolCall(
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
    const currentThread = caller.kind === "connection" ? undefined : callerThread(caller);
    const claims = { requestedBy: caller.userId };

    const result = await environmentDiscovery({
      store: this.#store,
      userId: claims.requestedBy,
      ...(currentThread ? { parent: currentThread } : {}),
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
    this.#realtime.sendToUsers([caller.userId], { type: "host.plugins-changed" });
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
    const threadId =
      input.threadId === "home"
        ? (await this.#store.findMainWorkspaceForOwner(caller.userId))?.homeThreadId
        : input.threadId;
    if (!threadId) throw conflict("Chat has not been started yet");
    const thread = await this.#store.getThreadForOwner(threadId, claims.requestedBy);
    if (!thread) throw forbidden("Thread is unavailable to this user");
    assertTarget(caller, thread);

    const page = await this.#store.threadMessagePageForOwner({
      ...(input.query ? { query: input.query } : {}),
      ...(input.aroundMessageId ? { aroundMessageId: input.aroundMessageId } : {}),
      ...(input.before ? { before: input.before } : {}),
      maxItems: input.maxMessages,
      maxBytes: 256 * 1_024,
      ownerId: claims.requestedBy,
      threadId: thread.id,
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
      execution: {
        threadId: thread.id,
        environmentId: thread.environmentId,
        harnessInstanceId: thread.harnessInstanceId,
        modelSelection: thread.modelSelection,
      },
      queue: await this.#queue(caller, thread.id),
      window: page.window,
    };
  }

  async thread_write({ caller, input, operationKey }: ToolCall<"thread_write">) {
    if (caller.kind === "connection" && !input.threadId)
      throw badRequest("Connected agents must name threadId");
    if (input.action === "interrupt") {
      const threadId = input.threadId ?? callerThread(caller).id;
      await this.#threads.assertTarget(caller, threadId);
      const interruptKey = idempotencyKey(
        caller,
        operationId(caller, operationKey, "thread_write"),
        "interrupt",
      );
      const previous = await this.#store.database
        .selectFrom("commands")
        .select("runId")
        .where("requestedBy", "=", caller.userId)
        .where("idempotencyKey", "=", interruptKey)
        .where("type", "=", "run.interrupt")
        .executeTakeFirst();
      const active = previous?.runId
        ? { id: previous.runId }
        : await this.#store.database
            .selectFrom("runs")
            .select("id")
            .where("threadId", "=", threadId)
            .where("status", "in", ["queued", "starting", "running", "waiting"])
            .orderBy("runOrdinal", "asc")
            .limit(1)
            .executeTakeFirst();
      if (active)
        await this.#threads.interrupt(caller, {
          type: "run.interrupt",
          threadId,
          runId: active.id,
          idempotencyKey: interruptKey,
        });
      const updated = await this.#threads.assertTarget(caller, threadId);
      return {
        thread: await this.#writtenThreadSummary(updated, caller.userId),
        doneWhenRunEnds: false,
        ...(active ? { interruptedRunId: active.id } : {}),
      };
    }
    if (caller.kind !== "run") {
      const threadId = input.threadId ?? callerThread(caller).id;
      const shared = {
        threadId,
        idempotencyKey: idempotencyKey(
          caller,
          operationId(caller, operationKey, "thread_write"),
          "thread.write",
        ),
      };
      const write =
        input.action === "rename"
          ? { ...shared, action: input.action, title: input.title! }
          : input.action === "set_icon"
            ? { ...shared, action: input.action, icon: input.icon! }
            : { ...shared, action: input.action };
      const result = await this.#threads.write(caller, write);
      return {
        thread: await this.#writtenThreadSummary(result.thread, caller.userId),
        doneWhenRunEnds: result.doneWhenRunEnds,
      };
    }
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

  async assignmentTargets({ caller, input }: ToolCall<"assignment_cancel">) {
    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: input.assignmentId,
      ownerId: caller.userId,
    });
    if (!assignment) throw forbidden("Assignment is unavailable");
    return [assignment.workerThreadId];
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
    if (caller.kind === "connection")
      return this.#store.requests.connectionPage({
        userId: caller.userId,
        limit: input.limit,
        ...(input.before ? { before: input.before } : {}),
        ...(caller.reach.kind === "workspace" ? { workspaceId: caller.reach.workspaceId } : {}),
      });
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
    const specialist = await resolveDelegationSpecialist(
      this.#store,
      claims.requestedBy,
      workspace.id,
      input.specialist,
      existingThread,
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
        ? await this.#specialistPlacement({
            userId: claims.requestedBy,
            environmentId: environment.id,
            accessMode: caller.accessMode,
            specialist,
            caller: currentThread,
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
  async authorizeDelegation(call: ToolCall<"thread_delegate">) {
    if (call.caller.kind === "connection") {
      if (!(await this.#priorConnectionTask(call.caller, call.input, call.operationKey)))
        await this.#prepareConnectionDelegation(call.caller, call.input);
    } else await this.prepareDelegation(call);
  }
  /**
   * The task an earlier call under this operationKey already created. Its
   * placement came from the person's defaults at that time, so a retry returns
   * it rather than resolving today's defaults; only what the caller itself
   * specified must still match.
   */
  async #priorConnectionTask(
    caller: Extract<AgentCaller, { kind: "connection" }>,
    input: ToolCall<"thread_delegate">["input"],
    operationKey: string,
  ): Promise<ConnectionTask | null> {
    if (input.threadId) return null;
    const requestId = operationId(caller, operationKey, "thread_delegate");
    const key = idempotencyKey(caller, requestId, "create");
    const prior = await this.#store.database
      .selectFrom("commands")
      .select(["type", "threadId", "payload"])
      .where("requestedBy", "=", caller.userId)
      .where("idempotencyKey", "=", key)
      .executeTakeFirst();
    if (!prior) return null;
    const requested = prior.payload as Readonly<Record<string, unknown>>;
    const asked = {
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
      ...(input.harnessInstanceId === undefined
        ? {}
        : { harnessInstanceId: input.harnessInstanceId }),
      ...(input.model === undefined ? {} : { modelSelection: input.model }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.icon === undefined ? {} : { icon: input.icon }),
    };
    const specialist = input.specialist
      ? await resolveDelegationSpecialist(
          this.#store,
          caller.userId,
          WorkspaceIdSchema.parse(requested.workspaceId),
          input.specialist,
          null,
        )
      : null;
    if (
      prior.type !== "thread.create" ||
      !prior.threadId ||
      Object.entries(asked).some(([field, value]) => !isDeepStrictEqual(requested[field], value)) ||
      (specialist !== null && requested.specialistId !== specialist?.id)
    )
      throw new OpensteerError({
        code: "conflict",
        message: "The idempotency key was already used for a different command",
      });
    const { expectedHarnessRevision } = requested;
    return {
      thread: await this.#threads.assertTarget(caller, prior.threadId),
      ...(typeof expectedHarnessRevision === "number" ? { expectedHarnessRevision } : {}),
    };
  }
  async #createConnectionTask(
    caller: Extract<AgentCaller, { kind: "connection" }>,
    input: ToolCall<"thread_delegate">["input"],
    requestId: string,
  ): Promise<ConnectionTask> {
    const {
      existing,
      workspace,
      environmentId,
      harnessInstanceId,
      harnessRevision,
      modelSelection,
      specialist,
    } = await this.#prepareConnectionDelegation(caller, input);
    if (existing) return { thread: existing };
    const expected =
      harnessRevision === undefined ? {} : { expectedHarnessRevision: harnessRevision };
    const { thread } = await this.#threads.create(
      caller,
      {
        type: "thread.create",
        workspaceId: workspace.id,
        environmentId,
        harnessInstanceId,
        modelSelection,
        accessMode: caller.accessMode,
        title: input.title ?? provisionalThreadTitle(input.task),
        ...(!input.title ? { generateTitle: true } : {}),
        idempotencyKey: idempotencyKey(caller, requestId, "create"),
      },
      {
        ...(specialist ? { specialistId: specialist.id } : {}),
        ...expected,
        ...(input.icon ? { icon: input.icon } : {}),
      },
    );
    return { thread, ...expected };
  }
  async thread_delegate({ caller, input, operationKey }: ToolCall<"thread_delegate">) {
    if (caller.kind === "connection") {
      const requestId = operationId(caller, operationKey, "thread_delegate");
      const { thread: created, expectedHarnessRevision } =
        (await this.#priorConnectionTask(caller, input, operationKey)) ??
        (await this.#createConnectionTask(caller, input, requestId));
      const delivered = await this.#threads.sendInput(caller, {
        ...(expectedHarnessRevision === undefined ? {} : { expectedHarnessRevision }),
        threadId: created.id,
        requestedBy: caller.userId,
        content: [{ type: "text", text: input.task }],
        policy: "queue",
        requireUnassigned: true,
        source: messageSource(caller, requestId),
        idempotencyKey: idempotencyKey(caller, requestId, "message"),
      });
      return {
        assignmentId: null,
        thread: await this.#store.getThreadForOwner(created.id, caller.userId),
        input: delivered.input,
        message: delivered.message,
        run: delivered.run,
      };
    }
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
    const requestId = operationId(caller, operationKey, "thread_delegate");

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
          ...(placement.harnessRevision === undefined
            ? {}
            : { expectedHarnessRevision: placement.harnessRevision }),
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

  async browser_profile_list({ caller }: ToolCall<"browser_profile_list">) {
    const claims = callerContext(caller);

    const profiles = await this.#browser.listGrantedProfiles(
      claims.requestedBy,
      claims.workspaceId,
      caller.key,
    );
    return { profiles };
  }

  async use_card({ caller, input, operationKey }: ToolCall<"use_card">) {
    const claims = requireRun(caller).claims;
    // A card already approved still works on a call; a Request's answer can't reach its Thread.
    const voiceCall = await this.#store.voiceCallForRun(claims.runId);
    const result = await this.#browserSources.agentUseCard({
      callId: operationId(caller, operationKey, "use_card"),
      canRequest: !voiceCall,
      ownerId: claims.requestedBy,
      reason: input.reason,
      runId: claims.runId,
      sessionId: input.sessionId,
      site: input.site,
      threadId: claims.threadId,
      workspaceId: claims.workspaceId,
    });
    return voiceCall && result.status === "needs-approval"
      ? { ...result, guidance: voiceRequestHandOff }
      : result;
  }

  async sign_in({ caller, input, operationKey }: ToolCall<"sign_in">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "sign_in");
    // Saved logins still work on a call; a Request's answer can't reach its Thread.
    const voiceCall = await this.#store.voiceCallForRun(claims.runId);

    const result = await this.#browserSources.agentSignIn({
      loginFill: this.#supportsLoginFill(claims),
      callId: requestId,
      canRequest: !voiceCall,
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
    return voiceCall && result.status === "unavailable" && result.reason === "needs-approval"
      ? { ...result, guidance: voiceRequestHandOff }
      : result;
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

  async browser_profile_request({
    caller,
    input,
    operationKey,
  }: ToolCall<"browser_profile_request">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "browser_profile_request");

    const workspaceId = input.workspaceId ?? claims.workspaceId;
    if (caller.reach.kind !== "user" && workspaceId !== claims.workspaceId) {
      throw forbidden("Caller can request a browser profile only for its Workspace");
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
    const anchor = caller.kind === "connection" ? null : callerThread(caller);
    const requestId = operationId(caller, operationKey, "thread_message");
    const observationId = input.observationId ?? requestId;
    const destination =
      input.threadId === "home"
        ? (await this.#store.findMainWorkspaceForOwner(caller.userId))?.homeThreadId
        : ThreadIdSchema.parse(input.threadId);
    if (!destination) throw conflict("Chat has not been started yet");
    if (destination === anchor?.id && caller.kind === "run")
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
    const memoryPass =
      caller.kind === "program" && caller.program.kind === "trigger"
        ? await this.#memoryPasses?.admissionSelection(caller.program.occurrenceId, thread)
        : undefined;
    const delivered = await this.#threads.sendInput(
      caller,
      {
        content: [{ type: "text", text: input.message }],
        idempotencyKey: idempotencyKey(caller, requestId, "message"),
        policy: input.delivery,
        requestedBy: caller.userId,
        source: messageSource(caller, observationId),
        threadId: thread.id,
        ...(memoryPass ? { memoryPass } : {}),
      },
      caller.kind === "connection"
        ? undefined
        : mutationAdmission(caller, "thread_message", input, requestId, [thread.id]),
    );
    return {
      assignmentId: delivered.input.assignmentId,
      disposition: delivered.disposition,
      input: delivered.input,
      message: delivered.message,
      run: delivered.run,
      thread: await this.#store.getThreadForOwner(thread.id, caller.userId),
    };
  }
  async #prepareConnectionDelegation(
    caller: Extract<AgentCaller, { kind: "connection" }>,
    input: ToolCall<"thread_delegate">["input"],
  ) {
    if (!input.workspaceId && !input.threadId)
      throw badRequest("A connected agent must name workspaceId or threadId");
    if (input.places?.length) throw badRequest("Connected agents cannot forward place references");
    const existing = input.threadId
      ? await this.#threads.assertTarget(caller, input.threadId)
      : null;
    if (existing && existing.role !== "work") throw badRequest("Choose a work Thread");
    const workspaceId = existing?.workspaceId ?? input.workspaceId!;
    if (
      caller.reach.kind !== "user" &&
      (caller.reach.kind !== "workspace" || caller.reach.workspaceId !== workspaceId)
    )
      throw forbidden("Target Thread is outside the caller's reach");
    const workspace = await this.#store.getWorkspaceForOwner(workspaceId, caller.userId);
    if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
    const specialist = await resolveDelegationSpecialist(
      this.#store,
      caller.userId,
      workspace.id,
      input.specialist,
      existing,
    );
    if (specialist && (input.model || input.harnessInstanceId || input.environmentId))
      throw badRequest("Specialist execution is selected by its registration");
    if (existing) {
      const assignment = await this.#store.database
        .selectFrom("delegations")
        .select("id")
        .where("childThreadId", "=", existing.id)
        .where("status", "=", "open")
        .executeTakeFirst();
      if (assignment) throw conflict("Thread already has an open Assignment");
    }
    const preferences = await this.#store.getExecutionPreferences(caller.userId);
    const environmentId =
      existing?.environmentId ??
      input.environmentId ??
      (workspace.backing.kind === "local-directory"
        ? workspace.backing.ownerEnvironmentId
        : preferences.history[0]?.environmentId);
    if (!environmentId) throw badRequest("Choose an execution environment");
    if (specialist && !existing) {
      const environment = await this.#store.getEnvironment(environmentId);
      if (!environment) throw badRequest("Selected execution environment does not exist");
      const placement = await this.#specialistPlacement({
        userId: caller.userId,
        environmentId: environment.id,
        accessMode: caller.accessMode,
        specialist,
      });
      return { existing, workspace, environmentId, ...placement, specialist };
    }
    const preferred = preferences.history.find((entry) => entry.environmentId === environmentId);
    const named =
      existing?.harnessInstanceId ?? input.harnessInstanceId ?? preferred?.harnessInstanceId;
    const automatic = named ? null : await this.#automaticDefault(caller.userId, environmentId);
    const harnessInstanceId = named ?? automatic?.harnessInstanceId;
    if (!harnessInstanceId) throw badRequest("Choose harnessInstanceId for the new task");
    const modelSelection =
      existing?.modelSelection ??
      input.model ??
      (preferred?.harnessInstanceId === harnessInstanceId ? preferred.modelSelection : undefined) ??
      automatic?.modelSelection ??
      catalogDefaultModelSelection(
        await this.#store.getHarnessCatalog(environmentId, harnessInstanceId),
      );
    if (!modelSelection) throw badRequest("Choose a model for the new task");
    return {
      existing,
      workspace,
      environmentId,
      harnessInstanceId,
      harnessRevision: undefined,
      modelSelection,
      specialist,
    };
  }
  async #automaticDefault(userId: UserId, environmentId: EnvironmentId) {
    const [{ excludedAccounts }, harnesses, catalogs] = await Promise.all([
      this.#store.getAutomaticModelConfig(userId),
      this.#store.listHarnessInstances({ environmentIds: [environmentId] }),
      this.#store.listHarnessCatalogs([environmentId]),
    ]);
    const chosen = catalogDefaultCandidate({
      accounts: harnesses.map((harness) => ({
        harnessInstanceId: harness.id,
        isDefault: harness.isDefault,
        sourceId: harness.sourceId,
        enabled: harness.enabled,
        removed: harness.removedAt !== null,
        // A new task waits for its computer like any other.
        available: true,
        catalog:
          catalogs.find((record) => record.harnessInstanceId === harness.id)?.catalog ?? null,
      })),
      excludedAccounts,
      canRun: () => ({ ok: true }),
    });
    return chosen
      ? {
          harnessInstanceId: chosen.account.harnessInstanceId,
          modelSelection: chosen.modelSelection,
        }
      : null;
  }
  #specialistPlacement(request: Parameters<typeof specialistPlacement>[1]) {
    return specialistPlacement(
      {
        store: this.#store,
        runners: {
          isAvailable: this.#isEnvironmentConnected,
          canRunHarness: this.#canRunHarness,
          harnessAccessModes: this.#harnessAccessModes,
        },
      },
      request,
    );
  }
  async thread_configure({ caller, input, operationKey }: ToolCall<"thread_configure">) {
    const target = await this.#threads.assertTarget(caller, input.threadId);
    const thread = (
      await this.#threads.configure(caller, {
        type: "thread.execution.update",
        threadId: target.id,
        harnessInstanceId: input.harnessInstanceId ?? target.harnessInstanceId,
        modelSelection: input.modelSelection ?? target.modelSelection,
        ...(input.continuation ? { continuation: input.continuation } : {}),
        idempotencyKey: idempotencyKey(
          caller,
          operationId(caller, operationKey, "thread_configure"),
          "configure",
        ),
      })
    ).thread;
    return {
      threadId: thread.id,
      environmentId: thread.environmentId,
      harnessInstanceId: thread.harnessInstanceId,
      modelSelection: thread.modelSelection,
    };
  }
  async thread_queue({ caller, input, operationKey }: ToolCall<"thread_queue">) {
    await this.#threads.assertTarget(caller, input.threadId);
    const command = {
      threadId: input.threadId,
      idempotencyKey: idempotencyKey(
        caller,
        operationId(caller, operationKey, "thread_queue"),
        "queue",
      ),
    };
    let changed;
    switch (input.action) {
      case "cancel":
        changed = await this.#threads.cancel(caller, {
          ...command,
          type: "thread.input.cancel",
          messageId: input.messageId!,
        });
        break;
      case "move":
        await this.#threads.move(caller, {
          ...command,
          type: "thread.input.move",
          messageId: input.messageId!,
          beforeMessageId: input.beforeMessageId!,
        });
        break;
      case "steer":
        changed = await this.#threads.steer(caller, {
          ...command,
          type: "thread.input.steer",
          messageId: input.messageId!,
          expectedRunId: input.expectedRunId!,
        });
        break;
      case "resume":
        await this.#threads.resume(caller, { ...command, type: "thread.inputQueue.resume" });
        break;
    }
    return {
      ...(await this.#queue(caller, input.threadId)),
      ...(changed ? { input: changed.input } : {}),
    };
  }
  async #queue(caller: AgentCaller, threadId: Thread["id"]) {
    const queue = await this.#store.getThreadInputQueue({
      threadId,
      requestedBy: caller.userId,
      authority: threadCallerAuthority(caller),
    });
    const messages = await this.#readableMessages(
      caller,
      queue.items.map(({ message }) => message),
    );
    return {
      paused: queue.paused,
      items: queue.items.map((item, index) => {
        const message = messages[index]!;
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
          .join("\n");
        return {
          ...item,
          message: {
            id: message.id,
            author: message.author,
            preview: text.slice(0, 500),
            truncated: text.length > 500,
          },
        };
      }),
    };
  }
  async thread_wait(call: ToolCall<"thread_wait">) {
    const { caller, input } = call;
    let runId: import("@opensteer/core").RunId | undefined;
    let afterSequence: import("@opensteer/core").Sequence | undefined;
    const wait = new ThreadWaitService({
      subscribe: (wake) => {
        const anchorId = caller.kind === "connection" ? undefined : callerThread(caller).id;
        const detach = this.#realtime.observe((change) => {
          if (
            // Revocation ends a connection's whole session, so the service owns that wake.
            ("threadId" in change &&
              (change.threadId === input.threadId || change.threadId === anchorId)) ||
            change.type === "host.machines.changed" ||
            (caller.kind === "program" && change.type === "host.triggers-changed")
          )
            wake();
        });
        const detachMembership = this.#store.onWorkspaceMembershipChanged((membership) => {
          if (membership.userId === caller.userId) wake();
        });
        return () => {
          detach();
          detachMembership();
        };
      },
      read: async () => {
        await call.checkLive?.();
        const thread = await this.#store.getThreadForOwner(input.threadId, caller.userId);
        if (!thread) throw forbidden("Thread is unavailable");
        assertTarget(caller, thread);
        await withDatabaseTransaction(this.#store.database, (tx) =>
          assertThreadCaller(tx, threadCallerAuthority(caller)),
        );
        const snapshot = await readThreadWaitSnapshot(this.#store.database, {
          threadId: thread.id,
          userId: caller.userId,
          ...(runId ? { runId } : {}),
          ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
          ...(afterSequence ? { afterSequence } : {}),
        });
        runId ??= snapshot.run?.id;
        afterSequence ??= snapshot.lastSequence ?? zeroSequence;
        const connection =
          caller.kind === "connection"
            ? await this.#store.database
                .selectFrom("agentConnections")
                .select("expiresAt")
                .where("id", "=", caller.connectionId)
                .executeTakeFirst()
            : undefined;
        await call.checkLive?.();
        return {
          ...snapshot,
          ...(connection ? { authorityExpiresAt: connection.expiresAt.getTime() } : {}),
          connected: this.#isEnvironmentConnected(thread.environmentId),
          messages: await this.#readableMessages(caller, snapshot.messages),
        };
      },
    });
    return wait.wait({
      timeoutMs: input.timeoutMs,
      ...(call.signal ? { signal: call.signal } : {}),
    });
  }
  async #writtenThreadSummary(thread: Thread, requestedBy: RunToolScope["requestedBy"]) {
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
