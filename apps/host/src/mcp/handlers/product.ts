import { ThreadDetailSchema } from "@opensteer/agent-tools/outputs";
import {
  readAgentThreadRecent,
  readAgentThreadActivity,
  encodeThreadHistoryCursor,
  assignmentSummaryInTransaction,
} from "@opensteer/database";
import { activityItem, messageItem, taskItem, boundedThreadItems } from "../thread-items.js";
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
  refused,
  placeContentLabel,
  provisionalThreadTitle,
  requestTitleText,
  type Request,
  type AssignmentSummary,
  compareSequence,
  placeIdentityKey,
  ThreadIdSchema,
  MessageIdSchema,
  WorkspaceIdSchema,
  type AgentEvent,
  type PlaceContentPart,
  type PlaceIdentity,
  type EnvironmentId,
  type UserId,
  type HarnessId,
  type Message,
  type Thread,
  type ThreadAccessMode,
  type Workspace,
  type WorkspaceBackingKind,
} from "@opensteer/core";
import type { BrowserUsageCredit, OpensteerStore } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import { computerAppIdentityKey } from "@opensteer/protocol";

import type { BrowserService } from "../../browser/browser-service.js";
import type { BrowserSourceService } from "../../browser/browser-source-service.js";
import { passwordsOfferGuidance } from "../../browser/passwords-offers.js";
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

const assignedRunRefusal = "A task reaches the person through the Thread that assigned it";
const assignedRunNext = "Send it to the assigner with thread_message.";
const unknownEnvironment = "Selected execution environment does not exist";
const chooseEnvironmentNext = "See the current choices with environment_list.";

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
    | "readablePlaces"
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
      | "readablePlaces"
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
    const parts = messages.flatMap((message) =>
      message.content
        .filter(isPlaceContentPart)
        .map((part) => ({ threadId: message.threadId, part, place: placeOfPart(part) })),
    );
    if (parts.length === 0) return messages;
    const [capabilities, readable] = await Promise.all([
      caller.kind === "run"
        ? this.#store.runPlaceCapabilities(caller.claims.runId)
        : ([] as readonly string[]),
      this.#browser.readablePlaces(caller.userId, parts),
    ]);
    const readableParts = new Set(readable.map(({ part }) => part));
    return messages.map((message) => ({
      ...message,
      content: message.content.map((part) => {
        if (!isPlaceContentPart(part)) return part;
        if (!readableParts.has(part)) return { type: "text" as const, text: "[Place unavailable]" };
        const capability =
          part.type === "browser-page" ? "browser-page-input-v1" : "native-place-input-v1";
        return capabilities.includes(capability)
          ? part
          : { type: "text" as const, text: placeContentLabel(part) };
      }),
    }));
  }
  async preparePersonShow({ caller, input }: ToolCall<"person_show">) {
    const claims = requireRun(caller).claims;
    if (await this.#store.runAssignment(claims.runId))
      throw forbidden(assignedRunRefusal, assignedRunNext);

    if (!this.#personShow) throw badRequest("Showing places is unavailable on this Host.");
    let target: PersonShowMessage["target"];
    if ("current" in input.target || "runId" in input.target) {
      const targetRunId = "runId" in input.target ? input.target.runId : claims.runId;
      if (targetRunId !== claims.runId) {
        const run = await this.#store.database
          .selectFrom("runs")
          .select("threadId")
          .where("id", "=", targetRunId)
          .executeTakeFirst();
        const thread = run
          ? await this.#store.getThreadForOwner(run.threadId, claims.requestedBy)
          : null;
        if (!thread) throw forbidden("Run is unavailable to this user");
        assertTarget(caller, thread);
      }
      await this.#browser.drainRunPlaces(targetRunId);
      const current = await this.#store.latestRunPlace(targetRunId);
      if (!current)
        throw badRequest(
          "This Run has not worked in a place yet.",
          "current" in input.target
            ? "Pass target.tabId, from browser_tab_read or Browser Harness surfaceId."
            : "Read recentPlaces with thread_read.",
        );
      target = { place: current.data.place, runId: targetRunId };
      const place = current.data.place;
      if (place.kind === "phone") {
        // A phone's tab outlives the Run's hold, and agents release before they reply.
        const owners = await this.#store.effectiveMachineOwners([place.machineId]);
        if (owners.get(place.machineId)?.effectiveOwner !== claims.requestedBy)
          throw forbidden("This Run's current place is unavailable.");
      } else if (place.kind === "app") {
        const session = this.#computerUse
          ?.sessionsForRunner(place.machineId)
          .find(
            (session) =>
              session.runId === targetRunId &&
              session.apps.some((app) => computerAppIdentityKey(app) === place.appKey),
          );
        if (!session || !this.#computerUse) throw forbidden("This Run's app session ended.");
        await this.#computerUse.authorizeDisplay(
          session.sessionId,
          claims.requestedBy,
          place.appKey,
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
      throw forbidden(assignedRunRefusal, assignedRunNext);

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

    if (input.parentThreadId === "self" && caller.kind === "connection")
      throw badRequest("Connected agents must name parentThreadId; self needs an anchor Thread");
    const parentThreadId =
      input.parentThreadId === "self" ? callerThread(caller).id : input.parentThreadId;
    if (parentThreadId) {
      const parent = await this.#store.getThreadForOwner(parentThreadId, caller.userId);
      if (!parent) throw forbidden("Parent Thread is unavailable");
      assertTarget(caller, parent);
    }
    const page = await this.#store.agentThreadPageForOwner({
      ...(parentThreadId ? { parentThreadId } : {}),
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
        assignmentId: summary.assignmentId,
        taskStatus: summary.taskStatus,
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
      hasMore: page.window.hasMore,
      nextBefore: page.window.nextBefore,
    };

    return response;
  }

  async thread_read({ caller, input }: ToolCall<"thread_read">) {
    const claims = { requestedBy: caller.userId };
    const threadId =
      input.threadId === "home"
        ? (await this.#store.findMainWorkspaceForOwner(caller.userId))?.homeThreadId
        : input.threadId === "self"
          ? this.#targetThreadId(caller)
          : input.threadId;
    if (!threadId) throw conflict("Chat has not been started yet");
    const thread = await this.#store.getThreadForOwner(threadId, claims.requestedBy);
    if (!thread) throw forbidden("Thread is unavailable to this user");
    assertTarget(caller, thread);

    const recent = await readAgentThreadRecent(this.#store.database, {
      threadId: thread.id,
      ownerId: caller.userId,
      runLimit: input.runLimit,
    });
    if (!recent) throw forbidden("Thread is unavailable to this user");
    const seen = new Set<string>();
    const references = recent.places.flatMap((event) => {
      if (!event.runId) return [];
      const key = `${event.runId}:${placeIdentityKey(event.data.place)}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ threadId: thread.id, runId: event.runId, ...event.data }];
    });
    const recentPlaces = (await this.#browser.readablePlaces(caller.userId, references))
      .slice(0, 10)
      .map(({ runId, place, title, site }) => ({ runId, place, title, site }));
    const context = {
      thread: ThreadDetailSchema.parse(thread),
      recentRuns: recent.runs.map(({ modelSelection, ...run }) => ({
        ...run,
        modelId: modelSelection.modelId,
      })),
      recentPlaces,
    };
    // An event's itemId can't name a message, so it needs no `view` to be read.
    if (
      input.view === "activity" ||
      (input.itemId && !MessageIdSchema.safeParse(input.itemId).success)
    )
      return { ...context, ...(await this.#activity(caller, thread.id, input)) };
    let page;
    try {
      page = await this.#store.threadMessagePageForOwner({
        threadId: thread.id,
        ownerId: caller.userId,
        maxItems: input.itemId ? 1 : input.limit,
        ...(input.query ? { query: input.query } : {}),
        ...(input.before ? { before: input.before } : {}),
        ...(input.itemId
          ? { aroundMessageId: MessageIdSchema.parse(input.itemId) }
          : input.aroundMessageId
            ? { aroundMessageId: input.aroundMessageId }
            : {}),
      });
    } catch (error) {
      if (input.itemId) throw forbidden("Item is unavailable in this Thread");
      throw error;
    }
    if (!page) throw forbidden("Thread is unavailable to this user");
    const messages = [...(await this.#readableMessages(caller, page.messages))].sort((a, b) =>
      compareSequence(b.sequence, a.sequence),
    );
    const items = boundedThreadItems(
      messages.map((m) => messageItem(m, input.maxCharsPerItem, input.textOffset)),
    );
    if (input.itemId && !items.length) throw forbidden("Item is unavailable in this Thread");
    const hasMore = items.length < messages.length || page.window.hasMore;
    return {
      ...context,
      items,
      hasMore,
      nextBefore:
        hasMore && items.length
          ? encodeThreadHistoryCursor(thread.id, messages[items.length - 1]!.sequence, input.query)
          : null,
    };
  }

  async #activity(
    caller: AgentCaller,
    threadId: Thread["id"],
    input: ToolCall<"thread_read">["input"],
  ) {
    const page = await readAgentThreadActivity(this.#store.database, {
      threadId,
      ownerId: caller.userId,
      limit: input.itemId ? 1 : input.limit,
      ...(input.before ? { before: input.before } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
    });
    if (!page) throw forbidden("Thread is unavailable to this user");
    const starts = new Map(page.starts.map((s) => [s.completionSequence, s.start]));
    const events = page.items.filter((item) => item.type !== "message");
    const startOf = (event: (typeof events)[number]) =>
      event.type === "tool.started"
        ? event
        : event.type === "tool.completed"
          ? starts.get(event.sequence)
          : undefined;
    const machineOf = (event: (typeof events)[number]) => {
      const integration = startOf(event)?.data.integration;
      return integration?.computerApp?.runnerId ?? integration?.phone?.runnerId;
    };
    const requestIds = events.flatMap((event) =>
      event.type === "request.resolved"
        ? [event.data.request.id]
        : event.type === "request.cancelled"
          ? [event.data.requestId]
          : [],
    );
    const [places, owners, requests, messages] = await Promise.all([
      this.#browser.readablePlaces(
        caller.userId,
        events.flatMap((event) =>
          event.type === "place.entered"
            ? [{ threadId, place: event.data.place, sequence: event.sequence }]
            : [],
        ),
      ),
      this.#store.effectiveMachineOwners(events.flatMap((event) => machineOf(event) ?? [])),
      Promise.all(requestIds.map((id) => this.#store.requests.get(id))),
      this.#readableMessages(
        caller,
        page.items.flatMap((item) => (item.type === "message" ? [item.message] : [])),
      ),
    ]);
    const readablePlaces = new Set(places.map((place) => place.sequence));
    const requestById = new Map(requests.flatMap((r) => (r ? [[r.id, r] as const] : [])));
    const readableMessages = new Map(messages.map((message) => [message.id, message]));
    const mapped = page.items.flatMap((item) => {
      if (item.type === "message")
        return [
          {
            sequence: item.sequence,
            item: messageItem(
              readableMessages.get(item.message.id)!,
              input.maxCharsPerItem,
              input.textOffset,
            ),
          },
        ];
      const machineId = machineOf(item);
      if (machineId && owners.get(machineId)?.effectiveOwner !== caller.userId) return [];
      if (item.type === "place.entered" && !readablePlaces.has(item.sequence)) return [];
      return [
        {
          sequence: item.sequence,
          item: activityItem(item, {
            start: startOf(item),
            request:
              item.type === "request.opened"
                ? item.data.request
                : item.type === "request.resolved"
                  ? requestById.get(item.data.request.id)
                  : item.type === "request.cancelled"
                    ? requestById.get(item.data.requestId)
                    : undefined,
            nodeTitle:
              item.type === "node.completed" ? page.nodeTitles.get(item.data.nodeId) : undefined,
            ownRun: !!item.runId && page.requesters.get(item.runId) === caller.userId,
            named: !!input.itemId,
            maxChars: input.maxCharsPerItem,
            offset: input.textOffset,
          }),
        },
      ];
    });
    const items = boundedThreadItems(mapped.map(({ item }) => item));
    if (input.itemId && !items.length) throw forbidden("Item is unavailable in this Thread");
    const trimmed = items.length < mapped.length;
    return {
      items,
      hasMore: trimmed || page.hasMore,
      nextBefore: trimmed ? mapped[items.length - 1]!.sequence : page.nextBefore,
    };
  }

  async thread_interrupt({ caller, input, operationKey }: ToolCall<"thread_interrupt">) {
    if (caller.kind === "connection" && !input.threadId)
      throw badRequest("Connected agents must name threadId");

    const threadId = input.threadId ?? callerThread(caller).id;
    await this.#threads.assertTarget(caller, threadId);
    const interruptKey = idempotencyKey(
      caller,
      operationId(caller, operationKey, "thread_interrupt"),
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
    return { interruptedRunId: active?.id ?? null };
  }

  async thread_update({ caller, input, operationKey }: ToolCall<"thread_update">) {
    if (caller.kind === "connection" && !input.threadId)
      throw badRequest("Connected agents must name threadId");
    if (caller.kind !== "run") {
      const threadId = input.threadId ?? callerThread(caller).id;
      const shared = {
        threadId,
        idempotencyKey: idempotencyKey(
          caller,
          operationId(caller, operationKey, "thread_update"),
          "thread.write",
        ),
      };
      const write =
        input.action === "rename"
          ? { ...shared, action: input.action, title: input.title! }
          : { ...shared, action: input.action };
      const result = await this.#threads.write(caller, write);
      return {
        title: result.thread.title,
        doneAt: result.thread.doneAt,
        doneWhenRunEnds: result.doneWhenRunEnds,
      };
    }
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "thread_update");

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
        admission: runAdmission(caller, "thread_update", input, requestId, [threadId]),
      });
      return {
        title: result.thread.title,
        doneAt: result.thread.doneAt,
        doneWhenRunEnds: result.doneWhenRunEnds,
      };
    }
    const result = await this.#commands.renameThread({
      ...command,
      admission: runAdmission(caller, "thread_update", input, requestId, [threadId]),
      title: write.title!,
    });
    return {
      title: result.thread.title,
      doneAt: result.thread.doneAt,
      doneWhenRunEnds: false,
    };
  }

  async assignmentTargets({ caller, input }: ToolCall<"task_cancel">) {
    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: input.assignmentId,
      ownerId: caller.userId,
    });
    if (!assignment) throw forbidden("Assignment is unavailable");
    return [assignment.workerThreadId];
  }
  async task_cancel({ caller, input, operationKey }: ToolCall<"task_cancel">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "task_cancel");

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
      admission: runAdmission(caller, "task_cancel", input, requestId, [assignment.workerThreadId]),
    });
    return this.#task(caller, cancelled.assignment);
  }

  async #task(caller: AgentCaller, summary: AssignmentSummary) {
    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: summary.id,
      ownerId: caller.userId,
    });
    if (!assignment) throw forbidden("Assignment is unavailable");
    return taskItem(summary, assignment.resultText);
  }
  async task_status({ caller, input }: ToolCall<"task_status">) {
    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: input.assignmentId,
      ownerId: caller.userId,
    });
    if (!assignment) throw forbidden("Assignment is unavailable");
    const worker = await this.#store.getThreadForOwner(assignment.workerThreadId, caller.userId);
    if (!worker) throw forbidden("Thread is unavailable");
    assertTarget(caller, worker);
    const row = await this.#store.database
      .selectFrom("delegations")
      .selectAll()
      .where("id", "=", input.assignmentId)
      .executeTakeFirstOrThrow();
    return taskItem(
      await assignmentSummaryInTransaction(this.#store.database, row),
      assignment.resultText,
    );
  }

  async request_list({ caller, input }: ToolCall<"request_list">) {
    if (caller.kind === "connection") {
      const page = await this.#store.requests.connectionPage({
        userId: caller.userId,
        limit: input.limit,
        ...(input.before ? { before: input.before } : {}),
        ...(caller.reach.kind === "workspace" ? { workspaceId: caller.reach.workspaceId } : {}),
      });
      return { ...page, requests: page.requests.map(agentRequest) };
    }
    const claims = callerContext(caller);

    const page = await this.#store.requests.visiblePage({
      ...(input.before ? { before: input.before } : {}),
      limit: input.limit,
      originatingThreadId: claims.threadId,
      targetWorkspaceId: claims.workspaceId,
    });
    return { requests: page.requests.map(agentRequest), window: page.window };
  }

  async request_withdraw({ caller, input }: ToolCall<"request_withdraw">) {
    const claims = requireRun(caller).claims;

    const withdrawn = await this.#store.requests.withdraw({
      requestId: input.requestId,
      threadId: claims.threadId,
      withdrawnBy: claims.requestedBy,
    });
    for (const event of withdrawn.events) this.#onWorkspaceEvent(event);
    return { request: agentRequest(withdrawn.request) };
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
      existingThread?.workspaceId ?? input.workspaceId ?? currentThread.workspaceId;
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
    if (!environment) throw badRequest(unknownEnvironment, chooseEnvironmentNext);
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
        next: "Call again with a new operationKey.",
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
      const thread = (await this.#store.getThreadForOwner(created.id, caller.userId))!;
      return {
        assignmentId: null,
        threadId: thread.id,
        runId: delivered.run?.id ?? null,
        runStatus: delivered.run?.status ?? null,
        status: "open" as const,
        title: thread.title,
        objective: null,
        result: null,
        pendingRequests: thread.pendingRequests,
        parentThreadId: null,
        workspaceId: thread.workspaceId,
        environmentId: thread.environmentId,
        createdAt: thread.createdAt,
        finishedAt: null,
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
          workspaceId: workspace.id,
        } as const;
        const replayed = await this.#store.findDelegatedThreadByIdempotency(delegateInput);
        if (replayed) {
          return this.#task(caller, replayed.assignment);
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
        if (!harness?.enabled)
          throw badRequest("Selected harness is disabled or unavailable", chooseEnvironmentNext);
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
        return this.#task(caller, delegated.assignment);
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
    return await this.#browserSources.agentUseCard({
      callId: operationId(caller, operationKey, "use_card"),
      ownerId: claims.requestedBy,
      reason: input.reason,
      runId: claims.runId,
      sessionId: input.sessionId,
      site: input.site,
      threadId: claims.threadId,
      workspaceId: claims.workspaceId,
    });
  }

  async sign_in({ caller, input, operationKey }: ToolCall<"sign_in">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "sign_in");

    const result = await this.#browserSources.agentSignIn({
      loginFill: this.#supportsLoginFill(claims),
      callId: requestId,
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
    const guidance = passwordsOfferGuidance(result);
    return guidance === null ? result : { ...result, guidance };
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
      if (!environment) throw badRequest(unknownEnvironment, chooseEnvironmentNext);
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
      messageId: delivered.message.id,
      runId: delivered.run?.id ?? null,
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
    if (!environmentId) throw badRequest("Choose an execution environment", chooseEnvironmentNext);
    if (specialist && !existing) {
      const environment = await this.#store.getEnvironment(environmentId);
      if (!environment) throw badRequest(unknownEnvironment, chooseEnvironmentNext);
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
    if (!harnessInstanceId)
      throw badRequest("Choose harnessInstanceId for the new task", chooseEnvironmentNext);
    const modelSelection =
      existing?.modelSelection ??
      input.model ??
      (preferred?.harnessInstanceId === harnessInstanceId ? preferred.modelSelection : undefined) ??
      automatic?.modelSelection ??
      catalogDefaultModelSelection(
        await this.#store.getHarnessCatalog(environmentId, harnessInstanceId),
      );
    if (!modelSelection) throw badRequest("Choose a model for the new task", chooseEnvironmentNext);
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
    const target = await this.#reachableThread(caller, input.threadId);
    const thread =
      input.harnessInstanceId || input.modelSelection
        ? (
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
          ).thread
        : target;
    return {
      providerSessionId: thread.providerSessionId,
      threadId: thread.id,
      environmentId: thread.environmentId,
      harnessInstanceId: thread.harnessInstanceId,
      modelSelection: thread.modelSelection,
    };
  }
  async thread_queue({ caller, input, operationKey }: ToolCall<"thread_queue">) {
    const target = await this.#reachableThread(caller, input.threadId);
    if (input.action === "list") return this.#queue(caller, target.id);
    await this.#threads.assertTarget(caller, target.id);
    const command = {
      threadId: target.id,
      idempotencyKey: idempotencyKey(
        caller,
        operationId(caller, operationKey, "thread_queue"),
        "queue",
      ),
    };
    switch (input.action) {
      case "cancel":
        await this.#threads.cancel(caller, {
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
        await this.#threads.steer(caller, {
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
    return this.#queue(caller, target.id);
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
          messageId: message.id,
          author: message.author,
          preview: text.slice(0, 500),
          truncated: text.length > 500,
          canCancel: item.canCancel,
          canMove: item.canMove,
          canSteer: item.canSteer,
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
    const result = await wait.wait({
      timeoutMs: input.timeoutMs,
      ...(call.signal ? { signal: call.signal } : {}),
    });
    // Oldest first, so the last item is where the next wait resumes.
    const items = boundedThreadItems(
      result.messages.map((message) => messageItem(message, 20_000)),
    );
    return {
      status: result.status,
      ...(result.run ? { run: result.run } : {}),
      ...(result.pendingRequest ? { pendingRequest: result.pendingRequest } : {}),
      items,
      hasMore: result.hasMore === true || items.length < result.messages.length,
    };
  }
  async #reachableThread(caller: AgentCaller, threadId?: Thread["id"]) {
    const thread = await this.#store.getThreadForOwner(
      this.#targetThreadId(caller, threadId),
      caller.userId,
    );
    if (!thread) throw forbidden("Thread is unavailable");
    assertTarget(caller, thread);
    return thread;
  }
  #targetThreadId(caller: AgentCaller, threadId?: Thread["id"]) {
    if (threadId) return threadId;
    if (caller.kind === "connection") throw badRequest("Connected agents must name threadId");
    return callerThread(caller).id;
  }
}
function placeOfPart(part: PlaceContentPart): PlaceIdentity {
  if (part.type === "browser-page")
    return { kind: "browser", sessionId: part.sessionId, surfaceId: part.tabId };
  if (part.type === "computer-app")
    return { kind: "app", machineId: part.machineId, appKey: computerAppIdentityKey(part.app) };
  return { kind: "phone", machineId: part.machineId, display: part.display };
}
function forbidden(message: string, next?: string): OpensteerError {
  return refused("forbidden", message, next);
}

function badRequest(message: string, next?: string): OpensteerError {
  return refused("bad_request", message, next);
}

function conflict(message: string, retryable = false): OpensteerError {
  return new OpensteerError({ code: "conflict", message, retryable });
}

function agentRequest(request: Request) {
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    title: requestTitleText(request.presentation),
    reason: "reason" in request.payload ? request.payload.reason : null,
    originatingThreadId: request.originatingThreadId,
    targetWorkspaceId: request.targetWorkspaceId,
    createdAt: request.createdAt,
    settlementProvenance: request.settlementProvenance
      ? { deviceLabel: request.settlementProvenance.deviceLabel }
      : request.settlementProvenance,
  };
}
