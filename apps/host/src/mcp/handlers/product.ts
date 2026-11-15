import { LegacyPersonShowTargetSchema as PersonShowTargetSchema } from "@opensteer/core";
import { z } from "zod";
type DelegationCall = ToolCall<"opensteer_task_delegate"> & {
  input: ToolCall<"opensteer_task_delegate">["input"] & { create?: true };
};
import type { DeviceAccessService } from "../../administration/device-access-service.js";
import { threadWaitMaxMs } from "@opensteer/agent-tools/tools";
import { toolMessageAuthor, toolRequestAnswerer } from "@opensteer/agent-tools/outputs";
import {
  readAgentThreadRecent,
  readAgentThreadActivity,
  encodeThreadHistoryCursor,
  readAssignmentResult,
  beginAssignmentResultWait,
  endAssignmentResultWait,
  withoutDatabaseOperationSignal,
  withDatabaseOperationSignal,
  readAgentRequest,
  requestRevision,
  AgentRequestResponderSchema,
  reachableNode,
} from "@opensteer/database";
import {
  activityItem,
  messageItem,
  taskItem,
  boundedThreadItems,
  itemText,
} from "../thread-items.js";
import { sql } from "kysely";
import { stripRefs } from "@opensteer/shared/stripRefs";
import { isDeepStrictEqual } from "node:util";
import { ThreadService } from "../../threads/thread-service.js";
import { ThreadWaitService } from "../../threads/thread-wait.js";
import type { TaskQuestionNotices } from "../../threads/task-question-notices.js";
import { readThreadWaitSnapshot } from "@opensteer/database";
import { withDatabaseTransaction } from "@opensteer/database";
import { assertThreadCaller } from "@opensteer/database";
import type { RealtimeHub } from "@opensteer/orchestration";
import { SpecialistStore } from "@opensteer/database";
import type { LegacyPersonShowMessage as PersonShowMessage } from "@opensteer/protocol";
import {
  agentDelegationMaxDepth,
  causalChainMaxDelegations,
  causalChainMaxAutonomousRuns,
  catalogDefaultCandidate,
  catalogDefaultModelSelection,
  isPlaceContentPart,
  zeroSequence,
  OpensteerError,
  refused,
  placeContentLabel,
  provisionalThreadTitle,
  threadTitleMaxLength,
  requestTitleText,
  formatReferenceLink,
  RequestIdSchema,
  requestIsAgentAnswerable,
  type Request,
  type AssignmentSummary,
  compareSequence,
  placeIdentityKey,
  ThreadIdSchema,
  MessageIdSchema,
  type AgentEvent,
  AgentEventSchema,
  type PlaceContentPart,
  type PlaceIdentity,
  type DeploymentId,
  type EnvironmentId,
  type UserId,
  type HarnessId,
  type Message,
  type ThreadId,
  type Thread,
  type ThreadAccessMode,
  excludedBackgroundAccounts,
} from "@opensteer/core";
import type { BrowserUsageCredit, OpensteerStore } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import { computerAppIdentityKey } from "@opensteer/protocol";

import type { BrowserService } from "../../browser/browser-service.js";
import type { BrowserSourceService } from "../../browser/browser-source-service.js";
import type { SavedLoginService } from "../../browser/saved-logins.js";
import type { BrowserTabGroupService } from "../../browser/browser-tab-group-service.js";
import type { PlaceContextService } from "../../computer-use/place-context-service.js";
import type { ComputerUseService } from "../../computer-use/computer-use-service.js";

import type { MachineFullDiskAccessService } from "../../shell/machine-full-disk-access-service.js";
import {
  specialistPlacement,
  resolveDelegationSpecialist,
} from "../../agents/specialist-placement.js";
import { delegationPlacement } from "../../agents/delegation-placement.js";
import { aiAccountDiscovery } from "../ai-accounts.js";

import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import type { MemoryPassService } from "../../agents/memory-pass-service.js";
import { callerThread, type AgentCaller } from "../agent-caller.js";
import type { ToolCall } from "./types.js";
import {
  sealRequestResponse,
  type RequestResponseVault,
} from "../../identity/request-response-vault.js";
import {
  assertMutableTarget,
  messageSource,
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

export interface AgentExecution {
  environmentFor(ownerId: UserId): Promise<EnvironmentId>;
  canExecute(environmentId: EnvironmentId): boolean;
}

/** A task started on its own: no parent and no Assignment, so nothing returns. */
interface StandaloneTask {
  readonly thread: Thread;
  readonly expectedHarnessRevision?: number;
}

const assignedRunRefusal = "A task reaches the person through the task that assigned it";
const assignedRunNext = "Send it to the parent task with opensteer_task_send.";
const unknownEnvironment = "Selected execution environment does not exist";
const chooseExecutionNext = "See the current choices with opensteer_ai_account_list.";

export class ProductToolHandlers {
  readonly #deploymentId: DeploymentId;
  readonly #threads: ThreadService;
  readonly #realtime: Pick<RealtimeHub, "observe" | "sendToUsers">;
  readonly #computerUse:
    Pick<ComputerUseService, "sessionsForRunner" | "authorizeDisplay"> | undefined;
  readonly #personShow:
    | ((userId: RunToolScope["requestedBy"], message: PersonShowMessage) => Promise<number>)
    | undefined;
  readonly #supportsLoginFill: (scope: RunToolScope) => boolean;
  readonly #browserSources: Pick<BrowserSourceService, "agentCopyChromeCookies">;
  readonly #savedLogins: Pick<SavedLoginService, "useSavedLogin" | "useCard">;
  readonly #deviceAccess: Pick<DeviceAccessService, "request">;
  readonly #machineFullDiskAccess: Pick<MachineFullDiskAccessService, "request">;
  readonly #browser: Pick<
    BrowserService,
    | "createProfile"
    | "readablePlaces"
    | "drainRunPlaces"
    | "closeAgentSession"
    | "listAgentSessions"
    | "listAgentProfiles"
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
  readonly #requestResponseVault: RequestResponseVault | undefined;
  readonly #questionNotices: Pick<TaskQuestionNotices, "wait"> | undefined;
  readonly #execution: AgentExecution;
  readonly #isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
  readonly #onEvent: (event: AgentEvent) => void;
  readonly #store: OpensteerStore;
  readonly #onBrowserUsage: ((credits: readonly BrowserUsageCredit[]) => void) | undefined;
  readonly #placeContext: Pick<PlaceContextService, "assertDelegated"> | undefined;
  readonly #memoryPasses: Pick<MemoryPassService, "admissionSelection"> | undefined;

  constructor(options: {
    readonly deploymentId: DeploymentId;
    readonly threads: ThreadService;
    readonly realtime: Pick<RealtimeHub, "observe" | "sendToUsers">;
    readonly computerUse?: Pick<ComputerUseService, "sessionsForRunner" | "authorizeDisplay">;
    readonly personShow?: (
      userId: RunToolScope["requestedBy"],
      message: PersonShowMessage,
    ) => Promise<number>;
    readonly supportsLoginFill?: (scope: RunToolScope) => boolean;
    readonly browserSources: Pick<BrowserSourceService, "agentCopyChromeCookies">;
    readonly savedLogins: Pick<SavedLoginService, "useSavedLogin" | "useCard">;
    readonly deviceAccess: Pick<DeviceAccessService, "request">;
    readonly machineFullDiskAccess: Pick<MachineFullDiskAccessService, "request">;
    readonly browser: Pick<
      BrowserService,
      | "createProfile"
      | "readablePlaces"
      | "drainRunPlaces"
      | "closeAgentSession"
      | "listAgentSessions"
      | "listAgentProfiles"
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
    readonly requestResponseVault?: RequestResponseVault;
    readonly questionNotices?: Pick<TaskQuestionNotices, "wait">;
    readonly execution: AgentExecution;
    readonly isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
    readonly memoryPasses?: Pick<MemoryPassService, "admissionSelection">;
    readonly onEvent: (event: AgentEvent) => void;
    readonly store: OpensteerStore;
    readonly onBrowserUsage?: (credits: readonly BrowserUsageCredit[]) => void;
    readonly placeContext?: Pick<PlaceContextService, "assertDelegated">;
  }) {
    this.#deploymentId = options.deploymentId;
    this.#threads = options.threads;
    this.#memoryPasses = options.memoryPasses;
    this.#realtime = options.realtime;
    this.#computerUse = options.computerUse;
    this.#personShow = options.personShow;
    this.#supportsLoginFill = options.supportsLoginFill ?? (() => false);
    this.#browserSources = options.browserSources;
    this.#savedLogins = options.savedLogins;
    this.#deviceAccess = options.deviceAccess;
    this.#machineFullDiskAccess = options.machineFullDiskAccess;
    this.#browser = options.browser;
    this.#browserTabs = options.browserTabs;
    this.#canRunHarness = options.canRunHarness;
    this.#harnessAccessModes = options.harnessAccessModes;
    this.#commands = options.commands;
    this.#requestResponseVault = options.requestResponseVault;
    this.#questionNotices = options.questionNotices;
    this.#execution = options.execution;
    this.#isEnvironmentConnected = options.isEnvironmentConnected;
    this.#onEvent = options.onEvent;
    this.#store = options.store;
    this.#placeContext = options.placeContext;
    this.#onBrowserUsage = options.onBrowserUsage;
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
    const legacyInput = z
      .strictObject({
        target: z.union([PersonShowTargetSchema, z.strictObject({ taskId: ThreadIdSchema })]),
      })
      .parse(input);
    const claims = requireRun(caller).claims;
    if (await this.#store.runAssignment(claims.runId))
      throw forbidden(assignedRunRefusal, assignedRunNext);

    if (!this.#personShow) throw badRequest("Showing places is unavailable on this Host.");
    let target: PersonShowMessage["target"];
    if ("current" in legacyInput.target || "runId" in legacyInput.target) {
      const targetRunId = "runId" in legacyInput.target ? legacyInput.target.runId : claims.runId;
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
      }
      await this.#browser.drainRunPlaces(targetRunId);
      const current = await this.#store.latestRunPlace(targetRunId);
      if (!current)
        throw badRequest(
          "This Run has not worked in a place yet.",
          "current" in legacyInput.target
            ? "Pass target.tabId from Browser Harness listTabs()."
            : "Read recentPlaces with opensteer_task_read.",
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
    } else
      target =
        "taskId" in legacyInput.target
          ? { threadId: legacyInput.target.taskId }
          : legacyInput.target;
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
          threadId: claims.threadId,
          agentBindingId: `run:${claims.runId}`,
        },
        tabId,
      );
    } else if ("threadId" in target) {
      const targetThread = await this.#store.getThreadForOwner(target.threadId, claims.requestedBy);
      if (!targetThread) throw forbidden("task is unavailable to this user");
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

  async person_notify({ caller, input, operationKey }: ToolCall<"person_notify">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "person_notify");
    if (await this.#store.runAssignment(claims.runId))
      throw forbidden(assignedRunRefusal, assignedRunNext);

    const result = await this.#commands.publishPersonMessage({
      admission: runAdmission(caller, "person_notify", input, requestId),
      message: input.message,
    });
    return {
      messageId: result.message.id,
      link: formatReferenceLink(result.message.id, "Message"),
    };
  }

  async opensteer_ai_account_list({ caller, input }: ToolCall<"opensteer_ai_account_list">) {
    const currentThread = caller.kind === "connection" ? undefined : callerThread(caller);
    const environmentId = await this.#execution.environmentFor(caller.userId);
    const result = await aiAccountDiscovery({
      store: this.#store,
      userId: caller.userId,
      ...(currentThread ? { parent: currentThread } : {}),
      input,
      connected: this.#isEnvironmentConnected,
      canRun: this.#canRunHarness,
      ...(environmentId ? { environmentId } : {}),
    });
    const source =
      caller.kind === "run"
        ? await this.#store.database
            .selectFrom("runs")
            .select("causalChainId")
            .where("id", "=", caller.claims.runId)
            .executeTakeFirst()
        : caller.kind === "program" && caller.program.kind === "trigger"
          ? await this.#store.database
              .selectFrom("triggerOccurrences")
              .select("causalChainId")
              .where("id", "=", caller.program.occurrenceId)
              .executeTakeFirst()
          : undefined;
    const chain = source?.causalChainId
      ? await this.#store.database
          .selectFrom("causalChains")
          .selectAll()
          .where("id", "=", source.causalChainId)
          .executeTakeFirst()
      : undefined;
    let depth = 0;
    let ancestor = currentThread;
    const visited = new Set<string>();
    while (ancestor) {
      if (visited.has(ancestor.id)) throw conflict("task lineage contains a cycle");
      visited.add(ancestor.id);
      if (!ancestor.parentThreadId) break;
      depth++;
      ancestor =
        (await this.#store.getThreadForOwner(ancestor.parentThreadId, caller.userId)) ?? undefined;
    }
    return {
      ...result,
      accessCeiling: caller.accessMode,
      limits: {
        maxDepth: caller.kind === "connection" ? null : agentDelegationMaxDepth,
        remainingDepth: currentThread ? Math.max(0, agentDelegationMaxDepth - depth) : null,
        maxTasks:
          caller.kind === "connection"
            ? null
            : (chain?.maxDelegations ?? causalChainMaxDelegations),
        remainingTasks: chain ? Math.max(0, chain.maxDelegations - chain.usedDelegations) : null,
        maxAutonomousRuns: chain?.maxAutonomousRuns ?? causalChainMaxAutonomousRuns,
        remainingAutonomousRuns: chain
          ? Math.max(0, chain.maxAutonomousRuns - chain.usedAutonomousRuns)
          : null,
        maxWaitMs: threadWaitMaxMs,
        taskDeadlineAt: null,
      },
    };
  }

  async opensteer_task_list({ caller, input }: ToolCall<"opensteer_task_list">) {
    const claims = { requestedBy: caller.userId };

    const scope = callerListScope(caller);
    const parentThreadId = input.parentTaskId;
    if (parentThreadId) {
      const parent = await this.#store.getThreadForOwner(parentThreadId, caller.userId);
      if (!parent) throw forbidden("Parent task is unavailable");
    }
    const page = await this.#store.agentThreadPageForOwner({
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(input.cursor ? { before: input.cursor } : {}),
      // Reserve escaped link bytes before the database chooses the page's cursor.
      maxBytes: 128 * 1_024 - input.limit * (6 * threadTitleMaxLength + 128),
      maxItems: input.limit,
      ownerId: claims.requestedBy,
      ...(input.query ? { query: input.query } : {}),
      scope,
      scopeId: caller.kind === "connection" ? caller.key : callerThread(caller).id,
    });
    const response = {
      threads: page.threads.map((summary) => ({
        assignmentId: summary.assignmentId,
        taskStatus: summary.taskStatus,
        environmentConnected: this.#isEnvironmentConnected(summary.environmentId),
        environmentId: summary.environmentId,
        id: summary.id,
        link: formatReferenceLink(summary.id, summary.title ?? "Task"),
        parentThreadId: summary.parentThreadId,
        pendingRequests: summary.pendingRequests,
        status: summary.status,
        doneAt: summary.doneAt,
        title: summary.title,
        updatedAt: summary.updatedAt,
      })),
      hasMore: page.window.hasMore,
      nextBefore: page.window.nextBefore,
    };

    return response;
  }

  async opensteer_task_read({
    caller,
    input,
  }: Omit<ToolCall<"opensteer_task_read">, "input"> & {
    input: ToolCall<"opensteer_task_read">["input"] & {
      subagentId?: import("@opensteer/core").ExecutionNodeId | undefined;
    };
  }) {
    if (input.subagentId) return this.#readSubagent(caller, input);
    const claims = { requestedBy: caller.userId };
    const threadId = !input.taskId ? this.#targetThreadId(caller) : input.taskId;
    const thread = await this.#store.getThreadForOwner(threadId, claims.requestedBy);
    if (!thread) throw forbidden("task is unavailable to this user");

    const recent = await readAgentThreadRecent(this.#store.database, {
      threadId: thread.id,
      ownerId: caller.userId,
      runLimit: input.runLimit,
    });
    if (!recent) throw forbidden("task is unavailable to this user");
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
      thread: { ...thread, link: formatReferenceLink(thread.id, thread.title) },
      recentRuns: recent.runs.map(({ modelSelection, ...run }) => ({
        ...run,
        link: formatReferenceLink(run.runId, `Run · ${thread.title}`),
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
        ...(input.cursor ? { before: input.cursor } : {}),
        ...(input.itemId
          ? { aroundMessageId: MessageIdSchema.parse(input.itemId) }
          : input.aroundMessageId
            ? { aroundMessageId: input.aroundMessageId }
            : {}),
      });
    } catch (error) {
      if (input.itemId) throw forbidden("Item is unavailable in this task");
      throw error;
    }
    if (!page) throw forbidden("task is unavailable to this user");
    const messages = [...(await this.#readableMessages(caller, page.messages))].sort((a, b) =>
      compareSequence(b.sequence, a.sequence),
    );
    const items = boundedThreadItems(
      messages.map((m) => messageItem(m, input.maxCharsPerItem, input.textOffset)),
    );
    if (input.itemId && !items.length) throw forbidden("Item is unavailable in this task");
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

  async #readSubagent(
    caller: AgentCaller,
    input: ToolCall<"opensteer_task_read">["input"] & {
      subagentId?: import("@opensteer/core").ExecutionNodeId | undefined;
    },
  ) {
    const missing = () => forbidden("Subagent is unavailable");
    const node = await reachableNode(this.#store.database, input.subagentId!, caller.userId);
    if (!node) throw missing();
    const thread = await this.#store.getThreadForOwner(node.threadId, caller.userId);
    if (!thread) throw missing();
    try {
    } catch {
      throw missing();
    }
    const page = await this.#store.nodeEventPageForOwner({
      ownerId: caller.userId,
      threadId: thread.id,
      nodeId: node.id,
      maxItems: input.itemId ? 1 : input.limit,
      types:
        input.view === "activity" || input.itemId
          ? ["node.message", "tool.started", "tool.completed"]
          : ["node.message"],
      ...(input.cursor ? { before: input.cursor } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
    });
    if (!page) throw missing();
    const calls = page.events.flatMap((event) =>
      event.type === "tool.completed" ? [event.data.callId] : [],
    );
    const starts = calls.length
      ? await this.#store.database
          .selectFrom("deploymentEvents")
          .selectAll()
          .where("nodeDetailId", "=", node.id)
          .where("type", "=", "tool.started")
          .where(sql<string>`data->>'callId'`, "in", calls)
          .execute()
      : [];
    const started = new Map(
      starts
        .map((row) => {
          const event = AgentEventSchema.parse({
            ...row,
            createdAt: row.createdAt.toISOString(),
            sequence: String(row.sequence),
          });
          return event.type === "tool.started" ? ([event.data.callId, event] as const) : null;
        })
        .filter((entry) => entry !== null),
    );
    const mapped = [...page.events].reverse().flatMap((event) => {
      if (event.type === "node.message")
        return [
          {
            itemId: event.sequence,
            type: "node.message",
            status: "published",
            runId: event.runId,
            title: null,
            ...itemText(event.data.text, input.maxCharsPerItem, input.textOffset),
            createdAt: event.createdAt,
          },
        ];
      if (event.type !== "tool.started" && event.type !== "tool.completed") return [];
      return [
        activityItem(event, {
          start: event.type === "tool.started" ? event : started.get(event.data.callId),
          ownRun: node.requestedBy === caller.userId,
          named: !!input.itemId,
          maxChars: input.maxCharsPerItem,
          offset: input.textOffset,
        }),
      ];
    });
    const items = boundedThreadItems(mapped);
    if (input.itemId && !items.length) throw forbidden("Item is unavailable in this subagent");
    const hasMore = items.length < mapped.length || page.window.hasMore;
    return {
      thread: { ...thread, link: formatReferenceLink(thread.id, thread.title) },
      subagent: page.node,
      recentRuns: [],
      recentPlaces: [],
      items,
      hasMore,
      nextBefore: hasMore ? (items.at(-1)?.itemId ?? page.window.nextBefore) : null,
    };
  }

  async #activity(
    caller: AgentCaller,
    threadId: Thread["id"],
    input: ToolCall<"opensteer_task_read">["input"] & {
      subagentId?: import("@opensteer/core").ExecutionNodeId | undefined;
    },
  ) {
    const page = await readAgentThreadActivity(this.#store.database, {
      threadId,
      ownerId: caller.userId,
      limit: input.itemId ? 1 : input.limit,
      ...(input.cursor ? { before: input.cursor } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
    });
    if (!page) throw forbidden("task is unavailable to this user");
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
    if (input.itemId && !items.length) throw forbidden("Item is unavailable in this task");
    const trimmed = items.length < mapped.length;
    return {
      items,
      hasMore: trimmed || page.hasMore,
      nextBefore: trimmed ? mapped[items.length - 1]!.sequence : page.nextBefore,
    };
  }

  async opensteer_task_interrupt({
    caller,
    input,
    operationKey,
  }: ToolCall<"opensteer_task_interrupt">) {
    if (caller.kind === "connection" && !input.taskId)
      throw badRequest("Connected agents must name taskId");

    const threadId = input.taskId ?? callerThread(caller).id;
    const thread = await this.#threads.assertTarget(caller, threadId);
    const interruptKey = idempotencyKey(
      caller,
      operationId(caller, operationKey, "opensteer_task_interrupt"),
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
    return {
      interruptedRunId: active?.id ?? null,
      link: formatReferenceLink(threadId, thread.title),
    };
  }

  async opensteer_task_update({ caller, input, operationKey }: ToolCall<"opensteer_task_update">) {
    if (input.title !== undefined && input.done !== undefined) {
      await this.opensteer_task_update({
        caller,
        input: { taskId: input.taskId, title: input.title },
        operationKey: operationKey + ":title",
      });
    }
    const action: "rename" | "done" | "reopen" =
      input.done === undefined ? "rename" : input.done ? "done" : "reopen";
    if (caller.kind === "connection" && !input.taskId)
      throw badRequest("Connected agents must name taskId");
    if (caller.kind !== "run") {
      const threadId = input.taskId ?? callerThread(caller).id;
      const shared = {
        threadId,
        idempotencyKey: idempotencyKey(
          caller,
          operationId(caller, operationKey, "opensteer_task_update"),
          "thread.write",
        ),
      };
      const write =
        action === "rename"
          ? { ...shared, action: "rename" as const, title: input.title! }
          : { ...shared, action: action };
      const result = await this.#threads.write(caller, write);
      return {
        title: result.thread.title,
        link: formatReferenceLink(result.thread.id, result.thread.title),
        doneAt: result.thread.doneAt,
        doneWhenRunEnds: result.doneWhenRunEnds,
      };
    }
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "opensteer_task_update");

    const write = { ...input, action };
    const threadId = write.taskId ?? claims.threadId;
    const target = await this.#store.getThreadForOwner(threadId, caller.userId);
    if (!target) throw forbidden("task is unavailable");
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
        admission: runAdmission(caller, "opensteer_task_update", input, requestId, [threadId]),
      });
      return {
        title: result.thread.title,
        link: formatReferenceLink(result.thread.id, result.thread.title),
        doneAt: result.thread.doneAt,
        doneWhenRunEnds: result.doneWhenRunEnds,
      };
    }
    const result = await this.#commands.renameThread({
      ...command,
      admission: runAdmission(caller, "opensteer_task_update", input, requestId, [threadId]),
      title: write.title!,
    });
    return {
      title: result.thread.title,
      link: formatReferenceLink(result.thread.id, result.thread.title),
      doneAt: result.thread.doneAt,
      doneWhenRunEnds: false,
    };
  }

  async assignmentTargets({
    caller,
    input,
  }: Omit<ToolCall<"opensteer_delegation_cancel">, "input"> & {
    input: {
      delegationId?: import("@opensteer/core").AssignmentId | undefined;
      subagentId?: import("@opensteer/core").ExecutionNodeId | undefined;
    };
  }) {
    if (input.subagentId) {
      const node = await reachableNode(this.#store.database, input.subagentId, caller.userId);
      if (!node) throw forbidden("Subagent is unavailable");
      return [node.threadId];
    }
    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: input.delegationId!,
      ownerId: caller.userId,
    });
    if (!assignment) throw forbidden("delegation is unavailable");
    return [assignment.workerThreadId];
  }
  async opensteer_delegation_cancel({
    caller,
    input,
    operationKey,
  }: Omit<ToolCall<"opensteer_delegation_cancel">, "input"> & {
    input: {
      delegationId?: import("@opensteer/core").AssignmentId | undefined;
      subagentId?: import("@opensteer/core").ExecutionNodeId | undefined;
    };
  }) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "opensteer_delegation_cancel");
    if (input.subagentId) {
      const node = await reachableNode(this.#store.database, input.subagentId, caller.userId);
      if (!node) throw forbidden("Subagent is unavailable");
      if (node.runId !== claims.runId)
        throw forbidden("Only this Run's agent may stop its subagents");
      await this.#commands.stopNode({
        nodeId: node.id,
        runId: node.runId,
        threadId: node.threadId,
        requestedBy: caller.userId,
        authority: threadCallerAuthority(caller),
        idempotencyKey: idempotencyKey(caller, requestId, "node.stop"),
      });
      return { subagentId: node.id, status: "stopping" as const };
    }

    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: input.delegationId!,
      ownerId: caller.userId,
    });
    if (!assignment) throw forbidden("delegation is unavailable");
    const target = await this.#store.getThreadForOwner(assignment.workerThreadId, caller.userId);
    if (!target) throw forbidden("task is unavailable");
    assertMutableTarget(caller, target);
    const cancelled = await this.#commands.cancelAssignment({
      assignmentId: input.delegationId!,
      requestedBy: claims.requestedBy,
      actorRunId: claims.runId,
      idempotencyKey: idempotencyKey(caller, requestId, "assignment.cancel"),
      admission: runAdmission(caller, "opensteer_delegation_cancel", input, requestId, [
        assignment.workerThreadId,
      ]),
    });
    return this.#task(caller, cancelled.assignment);
  }

  async #task(caller: AgentCaller, summary: AssignmentSummary) {
    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: summary.id,
      ownerId: caller.userId,
    });
    if (!assignment) throw forbidden("delegation is unavailable");
    return taskItem(summary, assignment.resultText);
  }
  async opensteer_delegation_status({ caller, input }: ToolCall<"opensteer_delegation_status">) {
    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: input.delegationId,
      ownerId: caller.userId,
    });
    if (!assignment) throw forbidden("delegation is unavailable");
    const worker = await this.#store.getThreadForOwner(assignment.workerThreadId, caller.userId);
    if (!worker) throw forbidden("task is unavailable");

    const read = await readAssignmentResult(this.#store.database, {
      assignmentId: input.delegationId,
      authority: threadCallerAuthority(caller),
    });
    for (const event of read.events) this.#onEvent(event);
    return taskItem(read.assignment, read.result);
  }

  async opensteer_request_answer({
    caller,
    input,
    operationKey,
  }: Omit<ToolCall<"opensteer_request_answer">, "input"> & {
    input: {
      action: "list" | "read" | "respond";
      requestId?: import("@opensteer/core").RequestId;
      response?: import("@opensteer/core").RequestResponse;
      expectedRevision?: string;
      cursor?: string | undefined;
      limit: number;
    };
  }) {
    if (input.action === "respond") {
      const run = requireRun(caller);
      const request = await readAgentRequest(
        this.#store.database,
        threadCallerAuthority(run),
        input.requestId!,
      );
      if (!requestIsAgentAnswerable(request))
        throw forbidden("This Request needs the person to answer");
      if (!this.#requestResponseVault)
        throw conflict("Request answers are unavailable on this Host");
      if (!request.originatingRunId) throw conflict("This Request has no waiting Run");
      const agentResponder = AgentRequestResponderSchema.parse({
        authority: threadCallerAuthority(run),
        expectedRevision: input.expectedRevision,
      });
      const response = input.response!;
      const sealedResponse = await sealRequestResponse(this.#requestResponseVault, response, {
        requestId: request.id,
        runId: request.originatingRunId,
        threadId: request.originatingThreadId,
      });
      await this.#commands.sendControl({
        type: "request.respond",
        requestId: request.id,
        response,
        sealedResponse,
        requestedBy: caller.userId,
        runId: request.originatingRunId,
        threadId: request.originatingThreadId,
        idempotencyKey: idempotencyKey(
          caller,
          operationId(caller, operationKey, "opensteer_request_answer"),
          "respond",
        ),
        agentResponder,
      });
      return { request: agentRequest((await this.#store.requests.get(request.id))!) };
    }
    if (input.action === "read") {
      const request = await readAgentRequest(
        this.#store.database,
        threadCallerAuthority(caller),
        input.requestId!,
      );
      return {
        request: {
          ...agentRequest(request),
          ...(requestIsAgentAnswerable(request) ? { presentation: request.presentation } : {}),
        },
      };
    }
    if (caller.kind === "connection") {
      const page = await this.#store.requests.connectionPage({
        userId: caller.userId,
        limit: input.limit,
        ...(input.cursor ? { before: input.cursor } : {}),
      });
      return { ...page, requests: page.requests.map(agentRequest) };
    }
    const claims = callerContext(caller);

    const page = await this.#store.requests.visiblePage({
      ...(input.cursor ? { before: input.cursor } : {}),
      limit: input.limit,
      originatingThreadId: claims.threadId,
    });
    return { requests: page.requests.map(agentRequest), window: page.window };
  }

  async opensteer_request_withdraw({ caller, input }: ToolCall<"opensteer_request_withdraw">) {
    const claims = requireRun(caller).claims;

    const withdrawn = await this.#store.requests.withdraw({
      requestId: input.requestId,
      threadId: claims.threadId,
      withdrawnBy: claims.requestedBy,
    });
    for (const event of withdrawn.events) this.#onEvent(event);
    return { request: agentRequest(withdrawn.request) };
  }

  async prepareDelegation({ caller, input }: DelegationCall) {
    const currentThread = callerThread(caller);
    const claims = callerContext(caller);
    const existingThread = input.taskId
      ? await this.#store.getThreadForOwner(input.taskId, claims.requestedBy)
      : null;
    if (input.taskId && !existingThread) throw forbidden("Target task is unavailable");
    if (existingThread) {
      assertMutableTarget(caller, existingThread);
      if (existingThread.purpose !== "task" || existingThread.id === currentThread.id) {
        throw badRequest("Choose another task for this delegation");
      }
    }
    const environmentId = await this.#execution.environmentFor(claims.requestedBy);
    const specialist = await resolveDelegationSpecialist(
      this.#store,
      claims.requestedBy,
      input.specialist,
      existingThread,
    );
    if (specialist && (input.model || input.aiAccountId))
      throw badRequest("Specialist execution is selected by its registration");
    const environment = await this.#store.getEnvironment(environmentId);
    if (!environment) throw badRequest(unknownEnvironment, chooseExecutionNext);
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
            harnessInstanceId: input.aiAccountId,
            model: input.model,
            parent: currentThread,
          });

    return { existingThread, specialist, environment, placement };
  }
  async authorizeDelegation(call: DelegationCall) {
    if (call.caller.kind !== "connection" && !call.input.create) await this.prepareDelegation(call);
    else if (!(await this.#priorStandaloneTask(call.caller, call.input, call.operationKey)))
      await (call.caller.kind === "connection"
        ? this.#prepareConnectionDelegation(call.caller, call.input)
        : this.prepareDelegation(call));
  }
  /**
   * The task an earlier call under this operationKey already created. Its
   * placement came from the person's defaults at that time, so a retry returns
   * it rather than resolving today's defaults; only what the caller itself
   * specified must still match.
   */
  async #priorStandaloneTask(
    caller: AgentCaller,
    input: DelegationCall["input"],
    operationKey: string,
  ): Promise<StandaloneTask | null> {
    if (input.taskId) return null;
    const requestId = operationId(
      caller,
      operationKey,
      input.create ? "opensteer_task_create" : "opensteer_task_delegate",
    );
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
      ...(input.aiAccountId === undefined ? {} : { harnessInstanceId: input.aiAccountId }),
      ...(input.model === undefined ? {} : { modelSelection: input.model }),
      ...(input.title === undefined ? {} : { title: input.title }),
    };
    const specialist = input.specialist
      ? await resolveDelegationSpecialist(this.#store, caller.userId, input.specialist, null)
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
    input: DelegationCall["input"],
    requestId: string,
  ): Promise<StandaloneTask> {
    const {
      existing,
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
        environmentId,
        harnessInstanceId,
        modelSelection,
        accessMode: caller.accessMode,
        title: input.title ?? provisionalThreadTitle(input.message),
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
  /** A Run or program's standalone task, placed as its own delegation would be. */
  async #createRunStandaloneTask(call: DelegationCall, requestId: string): Promise<StandaloneTask> {
    const { caller, input } = call;
    const { specialist, environment, placement } = await this.prepareDelegation(call);
    const expected =
      placement.harnessRevision === undefined
        ? {}
        : { expectedHarnessRevision: placement.harnessRevision };
    const specialistId = specialist?.id ?? callerThread(caller).specialistId;
    const { thread } = await this.#threads.create(
      caller,
      {
        type: "thread.create",
        environmentId: environment.id,
        harnessInstanceId: placement.harnessInstanceId,
        modelSelection: placement.modelSelection,
        accessMode: caller.accessMode,
        title: input.title ?? provisionalThreadTitle(input.message),
        ...(!input.title ? { generateTitle: true } : {}),
        idempotencyKey: idempotencyKey(caller, requestId, "create"),
      },
      { ...(specialistId ? { specialistId } : {}), ...expected, placed: true },
    );
    return { thread, ...expected };
  }
  async opensteer_task_delegate(call: DelegationCall) {
    const task = await this.#delegate(call);
    if (call.input.mode !== "wait") return task;
    const wait = await this.opensteer_task_wait({
      ...call,
      input: {
        ...(task.assignmentId ? { delegationId: task.assignmentId } : { taskId: task.threadId }),
        timeoutMs: call.input.timeoutMs,
      },
    });
    return { ...(wait.task ?? task), wait };
  }
  async #delegate(call: DelegationCall) {
    const { caller, operationKey } = call;
    let { input } = call;
    // A connection's task always stands alone; a Run or program asks for one.
    if (caller.kind === "connection" || input.create) {
      const requestId = operationId(
        caller,
        operationKey,
        input.create ? "opensteer_task_create" : "opensteer_task_delegate",
      );
      // The receipt first: a retry keeps the task and placement it already has.
      const { thread: created, expectedHarnessRevision } =
        (await this.#priorStandaloneTask(caller, input, operationKey)) ??
        (caller.kind === "connection"
          ? await this.#createConnectionTask(caller, input, requestId)
          : await this.#createRunStandaloneTask(call, requestId));
      const delivered = await this.#threads.sendInput(
        caller,
        {
          ...(expectedHarnessRevision === undefined ? {} : { expectedHarnessRevision }),
          threadId: created.id,
          requestedBy: caller.userId,
          content: [{ type: "text", text: input.message }],
          policy: "queue",
          requireUnassigned: true,
          source: messageSource(caller, input.observationId ?? requestId),
          idempotencyKey: idempotencyKey(caller, requestId, "message"),
        },
        caller.kind === "connection"
          ? undefined
          : mutationAdmission(caller, "opensteer_task_send", input, requestId, [created.id]),
      );
      const thread = (await this.#store.getThreadForOwner(created.id, caller.userId))!;
      return {
        assignmentId: null,
        link: formatReferenceLink(thread.id, thread.title),
        threadId: thread.id,
        runId: delivered.run?.id ?? null,
        runStatus: delivered.run?.status ?? null,
        status: "open" as const,
        title: thread.title,
        objective: null,
        result: null,
        pendingRequests: thread.pendingRequests,
        parentThreadId: null,
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
    const requestId = operationId(
      caller,
      operationKey,
      input.create ? "opensteer_task_create" : "opensteer_task_delegate",
    );

    if (caller.kind !== "run" && input.places?.length)
      throw badRequest("Program delegation cannot forward place references");

    return this.#commands.withInputAdmission(
      claims.requestedBy,
      idempotencyKey(caller, requestId, "delegate"),
      async () => {
        const { existingThread, specialist, environment, placement } = await this.prepareDelegation(
          { caller, input, operationKey },
        );
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
          task: [{ text: input.message, type: "text" }, ...(input.places ?? [])],
          title: input.title ?? provisionalThreadTitle(input.message),
          titleSource: input.title === undefined ? "provisional" : "chosen",
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
          });
        }
        if (!this.#isEnvironmentConnected(environment.id))
          throw conflict("Selected computer is not connected", true);
        const harness = await this.#store.getHarnessInstance(delegateInput.harnessInstanceId);
        if (!harness?.enabled)
          throw badRequest("Selected AI account is disabled or unavailable", chooseExecutionNext);
        if (
          this.#isEnvironmentConnected(environment.id) &&
          !this.#canRunHarness(environment.id, harness.driverKind)
        ) {
          throw badRequest(`Selected computer cannot run ${harness.driverKind} AI accounts`);
        }
        const delegated = await this.#commands.delegateAdmittedThread({
          admission: mutationAdmission(
            caller,
            "opensteer_task_delegate",
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

  async card_request({ caller, input, operationKey }: ToolCall<"card_request">) {
    const claims = requireRun(caller).claims;
    const result = await this.#savedLogins.useCard({
      deploymentId: this.#deploymentId,
      callId: operationId(caller, operationKey, "card_request"),
      ownerId: claims.requestedBy,
      reason: input.reason,
      runId: claims.runId,
      tabId: input.tabId,
      site: input.site,
      threadId: claims.threadId,
    });
    return result.status === "pending" ? requestResult(result, "Card access") : result;
  }

  async saved_login_request({ caller, input, operationKey }: ToolCall<"saved_login_request">) {
    const claims = requireRun(caller).claims;
    const result = await this.#savedLogins.useSavedLogin({
      deploymentId: this.#deploymentId,
      loginFill: this.#supportsLoginFill(claims),
      callId: operationId(caller, operationKey, "saved_login_request"),
      ownerId: claims.requestedBy,
      reason: input.reason,
      runId: claims.runId,
      ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
      site: input.site,
      threadId: claims.threadId,
    });
    return result.status === "pending" || result.status === "declined"
      ? requestResult(result, "Saved login")
      : result;
  }

  async chrome_cookies_request({
    caller,
    input,
    operationKey,
  }: ToolCall<"chrome_cookies_request">) {
    const claims = requireRun(caller).claims;
    const result = await this.#browserSources.agentCopyChromeCookies({
      deploymentId: this.#deploymentId,
      callId: operationId(caller, operationKey, "chrome_cookies_request"),
      ownerId: claims.requestedBy,
      reason: input.reason,
      runId: claims.runId,
      tabId: input.tabId,
      site: input.site,
      threadId: claims.threadId,
    });
    return result.status === "pending" || result.status === "declined"
      ? requestResult(result, "Browser sign-in")
      : result;
  }

  async computer_access_request({
    caller,
    input,
    operationKey,
  }: ToolCall<"computer_access_request">) {
    const claims = requireRun(caller).claims;
    const callId = operationId(caller, operationKey, "computer_access_request");
    if (input.access === "full_disk_access") {
      const result = await this.#machineFullDiskAccess.request({
        callId,
        computerId: input.computerId,
        reason: input.reason,
        claims,
      });
      return requestResult(result, "Full Disk Access");
    }
    await this.#store.admitRunToolCall(
      runAdmission(caller, "computer_access_request", input, callId),
    );
    const result = await this.#deviceAccess.request({
      callId,
      machineId: input.computerId,
      access: input.access,
      reason: input.reason,
      claims,
    });
    return requestResult(result, "Computer access");
  }

  async browser_profile_request({
    caller,
    input,
    operationKey,
  }: ToolCall<"browser_profile_request">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "browser_profile_request");

    const result = await this.#browser.requestAccess({
      callId: requestId,
      ownerId: claims.requestedBy,
      reason: input.reason,
      runId: claims.runId,
      suggestion: input.suggestion,
      threadId: claims.threadId,
    });
    return requestResult(result, "Browser profile");
  }

  async opensteer_task_send({ caller, input, operationKey }: ToolCall<"opensteer_task_send">) {
    const anchor = caller.kind === "connection" ? null : callerThread(caller);
    const requestId = operationId(caller, operationKey, "opensteer_task_send");
    const observationId = input.observationId ?? requestId;
    const destination = ThreadIdSchema.parse(input.taskId);
    if (destination === anchor?.id && caller.kind === "run")
      throw badRequest("An agent cannot message its own active task");
    const thread = await this.#store.getThreadForOwner(destination, caller.userId);
    if (!thread) throw forbidden("task is unavailable to this user");
    assertMutableTarget(caller, thread);
    if (thread.specialistId && input.delivery !== "report")
      await new SpecialistStore(this.#store.database).assertRunnable(
        thread.specialistId,
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
        ...(input.freshContext !== undefined ? { freshContext: input.freshContext } : {}),
        requestedBy: caller.userId,
        source: messageSource(caller, observationId),
        threadId: thread.id,
        ...(memoryPass ? { memoryPass } : {}),
      },
      caller.kind === "connection"
        ? undefined
        : mutationAdmission(caller, "opensteer_task_send", input, requestId, [thread.id]),
    );
    return {
      assignmentId: delivered.input.assignmentId,
      link: formatReferenceLink(delivered.message.id, `Message · ${thread.title}`),
      disposition: delivered.disposition,
      messageId: delivered.message.id,
      runId: delivered.run?.id ?? null,
    };
  }
  async #prepareConnectionDelegation(
    caller: Extract<AgentCaller, { kind: "connection" }>,
    input: DelegationCall["input"],
  ) {
    if (input.places?.length) throw badRequest("Connected agents cannot forward place references");
    const existing = input.taskId ? await this.#threads.assertTarget(caller, input.taskId) : null;
    if (existing && existing.purpose !== "task") throw badRequest("Choose a work task");
    const environmentId = await this.#execution.environmentFor(caller.userId);
    const specialist = await resolveDelegationSpecialist(
      this.#store,
      caller.userId,
      input.specialist,
      existing,
    );
    if (specialist && (input.model || input.aiAccountId))
      throw badRequest("Specialist execution is selected by its registration");
    if (existing) {
      const assignment = await this.#store.database
        .selectFrom("delegations")
        .select("id")
        .where("childThreadId", "=", existing.id)
        .where("status", "=", "open")
        .executeTakeFirst();
      if (assignment) throw conflict("task already has an open delegation");
    }
    const preferences = await this.#store.getExecutionPreferences(caller.userId);
    if (specialist && !existing) {
      const environment = await this.#store.getEnvironment(environmentId);
      if (!environment) throw badRequest(unknownEnvironment, chooseExecutionNext);
      const placement = await this.#specialistPlacement({
        userId: caller.userId,
        environmentId: environment.id,
        accessMode: caller.accessMode,
        specialist,
      });
      return { existing, environmentId, ...placement, specialist };
    }
    const preferred = preferences.history.find((entry) => entry.environmentId === environmentId);
    const named = existing?.harnessInstanceId ?? input.aiAccountId ?? preferred?.harnessInstanceId;
    const automatic = named ? null : await this.#automaticDefault(caller.userId, environmentId);
    const harnessInstanceId = named ?? automatic?.harnessInstanceId;
    if (!harnessInstanceId)
      throw badRequest("Choose aiAccountId for the new task", chooseExecutionNext);
    const modelSelection =
      existing?.modelSelection ??
      input.model ??
      (preferred?.harnessInstanceId === harnessInstanceId ? preferred.modelSelection : undefined) ??
      automatic?.modelSelection ??
      catalogDefaultModelSelection(
        await this.#store.getHarnessCatalog(environmentId, harnessInstanceId),
      );
    if (!modelSelection) throw badRequest("Choose a model for the new task", chooseExecutionNext);
    return {
      existing,
      environmentId,
      harnessInstanceId,
      harnessRevision: undefined,
      modelSelection,
      specialist,
    };
  }
  async #automaticDefault(userId: UserId, environmentId: EnvironmentId) {
    const [{ settings }, harnesses, catalogs] = await Promise.all([
      this.#store.getAgentHomeSettings(userId),
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
      excludedAccounts: excludedBackgroundAccounts(settings),
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
  async opensteer_task_configure({
    caller,
    input,
    operationKey,
  }: ToolCall<"opensteer_task_configure">) {
    const target = await this.#reachableThread(caller, input.taskId);
    const thread =
      input.aiAccountId || input.modelSelection
        ? (
            await this.#threads.configure(caller, {
              type: "thread.execution.update",
              threadId: target.id,
              harnessInstanceId: input.aiAccountId ?? target.harnessInstanceId,
              modelSelection: input.modelSelection ?? target.modelSelection,
              ...(input.continuation ? { continuation: input.continuation } : {}),
              idempotencyKey: idempotencyKey(
                caller,
                operationId(caller, operationKey, "opensteer_task_configure"),
                "configure",
              ),
            })
          ).thread
        : target;
    return {
      providerSessionId: thread.providerSessionId,
      link: formatReferenceLink(thread.id, thread.title),
      threadId: thread.id,
      environmentId: thread.environmentId,
      harnessInstanceId: thread.harnessInstanceId,
      modelSelection: thread.modelSelection,
    };
  }
  async opensteer_task_queue({
    caller,
    input,
    operationKey,
  }: Omit<ToolCall<"opensteer_task_queue">, "input"> & {
    input: Omit<ToolCall<"opensteer_task_queue">["input"], "action"> & {
      action: "list" | "cancel" | "move" | "steer" | "resume";
    };
  }) {
    const target = await this.#reachableThread(caller, input.taskId);
    if (input.action === "list") return this.#queue(caller, target);
    await this.#threads.assertTarget(caller, target.id);
    const command = {
      threadId: target.id,
      idempotencyKey: idempotencyKey(
        caller,
        operationId(caller, operationKey, "opensteer_task_queue"),
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
    return this.#queue(caller, target);
  }
  async #queue(caller: AgentCaller, thread: Thread) {
    const queue = await this.#store.getThreadInputQueue({
      threadId: thread.id,
      requestedBy: caller.userId,
      authority: threadCallerAuthority(caller),
    });
    const messages = await this.#readableMessages(
      caller,
      queue.items.map(({ message }) => message),
    );
    return {
      link: formatReferenceLink(thread.id, thread.title),
      paused: queue.paused,
      items: queue.items.map((item, index) => {
        const message = messages[index]!;
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
          .join("\n");
        const preview = stripRefs(text);
        return {
          messageId: message.id,
          link: formatReferenceLink(message.id, `Message · ${thread.title}`),
          author: toolMessageAuthor(message.author),
          preview: preview.slice(0, 500),
          truncated: preview.length > 500,
          canCancel: item.canCancel,
          canMove: item.canMove,
          canSteer: item.canSteer,
        };
      }),
    };
  }
  async opensteer_task_wait(
    call: Omit<ToolCall<"opensteer_task_wait">, "input"> & {
      input: {
        taskId?: ThreadId | undefined;
        delegationId?: import("@opensteer/core").AssignmentId | undefined;
        afterMessageId?: import("@opensteer/core").MessageId | undefined;
        timeoutMs: number;
      };
    },
  ) {
    const { caller, input } = call;
    // A caller waiting on the conversation of a task it assigned is waiting on that task: the
    // result it is handed must not also return to it by itself.
    const own = input.taskId ? await this.#assignedTask(caller, input.taskId) : undefined;
    const assignmentId = input.delegationId ?? (input.afterMessageId ? undefined : own);
    const assignment = assignmentId
      ? await this.#store.getAssignmentForOwner({ assignmentId, ownerId: caller.userId })
      : null;
    if (assignmentId && !assignment) throw forbidden("delegation is unavailable");
    const threadId = assignment?.workerThreadId ?? input.taskId!;
    await this.#assertWaitTarget(caller, threadId);
    // Watching its own task's messages holds that task's return too: it reads the result at the end.
    const held = assignment?.id ?? own;
    const waitId = held
      ? await beginAssignmentResultWait(this.#store.database, {
          assignmentId: held,
          authority: threadCallerAuthority(caller),
          timeoutMs: input.timeoutMs,
          ...(call.signal ? { signal: call.signal } : {}),
        })
      : null;
    try {
      let runId: import("@opensteer/core").RunId | undefined;
      let afterSequence: import("@opensteer/core").Sequence | undefined;
      const wait = new ThreadWaitService({
        subscribe: (wake) => {
          const anchorId = caller.kind === "connection" ? undefined : callerThread(caller).id;
          const detach = this.#realtime.observe((change) => {
            if (
              // Revocation ends a connection's whole session, so the service owns that wake.
              ("threadId" in change &&
                (change.threadId === threadId || change.threadId === anchorId)) ||
              change.type === "host.machines.changed" ||
              (caller.kind === "program" && change.type === "host.triggers-changed")
            )
              wake();
          });
          return detach;
        },
        read: ({ signal, expiresAt }) =>
          withDatabaseOperationSignal(signal, expiresAt, async () => {
            await call.checkLive?.();
            const thread = await this.#store.getThreadForOwner(threadId, caller.userId);
            if (!thread) throw forbidden("task is unavailable");

            await this.#assertWaitTarget(caller, threadId);
            await withDatabaseTransaction(this.#store.database, (tx) =>
              assertThreadCaller(tx, threadCallerAuthority(caller)),
            );
            const snapshot = await readThreadWaitSnapshot(this.#store.database, {
              threadId: thread.id,
              userId: caller.userId,
              ...(!assignment && runId ? { runId } : {}),
              ...(assignment ? { assignmentId: assignment.id } : {}),
              ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
              ...(!assignment && afterSequence ? { afterSequence } : {}),
            });
            runId ??= snapshot.run?.id;
            afterSequence ??= snapshot.lastSequence ?? zeroSequence;
            const task = assignment
              ? await this.#store.getAssignmentForOwner({
                  assignmentId: assignment.id,
                  ownerId: caller.userId,
                })
              : null;
            if (assignment && !task) throw forbidden("delegation is unavailable");
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
              ...(task ? { settled: task.status !== "open", messages: [] } : {}),
              ...(connection ? { authorityExpiresAt: connection.expiresAt.getTime() } : {}),
              connected: this.#isEnvironmentConnected(thread.environmentId),
              messages: assignment ? [] : await this.#readableMessages(caller, snapshot.messages),
            };
          }),
      });
      const finishWait =
        caller.kind === "run" ? this.#questionNotices?.wait(caller.thread.id, threadId) : undefined;
      const result = await wait
        .wait({
          timeoutMs: input.timeoutMs,
          ...(call.signal ? { signal: call.signal } : {}),
        })
        .then(
          (result) => {
            finishWait?.(result.pendingRequest?.id);
            return result;
          },
          (error: unknown) => {
            finishWait?.();
            throw error;
          },
        );
      await call.checkLive?.();
      const target = await this.#store.getThreadForOwner(threadId, caller.userId);
      if (!target) throw forbidden("task is unavailable");

      await withDatabaseTransaction(this.#store.database, (tx) =>
        assertThreadCaller(tx, threadCallerAuthority(caller), { threadId, readOnly: true }),
      );
      // Watching its own task's messages hands the caller the final reply too, once it has settled.
      const settled = assignment?.id ?? (result.status === "settled" ? own : undefined);
      const task =
        settled && result.status === "settled"
          ? await readAssignmentResult(this.#store.database, {
              assignmentId: settled,
              authority: threadCallerAuthority(caller),
              ...(call.signal ? { signal: call.signal } : {}),
            })
          : undefined;
      if (task) for (const event of task.events) this.#onEvent(event);
      // Oldest first, so the last item is where the next wait resumes.
      const items = boundedThreadItems(
        result.messages.map((message) => messageItem(message, 20_000)),
      );
      return {
        status: result.status,
        ...(task ? { task: taskItem(task.assignment, task.result) } : {}),
        ...(result.run
          ? {
              run: {
                ...result.run,
                link: formatReferenceLink(result.run.id, `Run · ${target.title}`),
              },
            }
          : {}),
        ...(result.pendingRequest
          ? {
              pendingRequest: {
                ...result.pendingRequest,
                link: formatReferenceLink(
                  RequestIdSchema.parse(result.pendingRequest.id),
                  "Request",
                ),
              },
            }
          : {}),
        items,
        hasMore: result.hasMore === true || items.length < result.messages.length,
      };
    } finally {
      if (held && waitId) {
        const events = await withoutDatabaseOperationSignal(() =>
          endAssignmentResultWait(this.#store.database, { assignmentId: held, waitId }),
        );
        for (const event of events) this.#onEvent(event);
      }
    }
  }
  /** The newest task on `threadId` that this very caller assigned, if it assigned one. */
  async #assignedTask(caller: AgentCaller, threadId: Thread["id"]) {
    if (caller.kind === "connection") return undefined;
    const authority = threadCallerAuthority(caller);
    if (authority.kind === "connection") return undefined;
    const row = await this.#store.database
      .selectFrom("delegations")
      .select("id")
      .where("childThreadId", "=", threadId)
      .where(
        authority.kind === "run"
          ? "parentRunId"
          : authority.kind === "trigger"
            ? "parentOccurrenceId"
            : "parentWatchActivationId",
        "=",
        authority.kind === "run"
          ? authority.scope.runId
          : authority.kind === "trigger"
            ? authority.scope.occurrenceId
            : authority.scope.activationId,
      )
      .orderBy("createdAt", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.id;
  }
  async #assertWaitTarget(caller: AgentCaller, threadId: Thread["id"]) {
    if (caller.kind === "connection") return;
    let current: Thread["id"] | null = callerThread(caller).id;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      if (current === threadId)
        throw badRequest("Cannot wait on yourself or a task you are working for");
      visited.add(current);
      const assigned = await this.#store.database
        .selectFrom("delegations")
        .select("parentThreadId")
        .where("childThreadId", "=", current)
        .where("status", "=", "open")
        .executeTakeFirst();
      current = assigned?.parentThreadId ?? null;
    }
  }
  async #reachableThread(caller: AgentCaller, threadId?: Thread["id"]) {
    const thread = await this.#store.getThreadForOwner(
      this.#targetThreadId(caller, threadId),
      caller.userId,
    );
    if (!thread) throw forbidden("task is unavailable");

    return thread;
  }
  #targetThreadId(caller: AgentCaller, threadId?: Thread["id"]) {
    if (threadId) return threadId;
    if (caller.kind === "connection") throw badRequest("Connected agents must name taskId");
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
    link: formatReferenceLink(request.id, requestTitleText(request.presentation)),
    kind: request.kind,
    status: request.status,
    title: requestTitleText(request.presentation),
    reason: "reason" in request.payload ? request.payload.reason : null,
    originatingThreadId: request.originatingThreadId,
    createdAt: request.createdAt,
    revision: requestRevision(request),
    settlementProvenance: request.settlementProvenance
      ? toolRequestAnswerer(
          "kind" in request.settlementProvenance
            ? request.settlementProvenance
            : { deviceLabel: request.settlementProvenance.deviceLabel },
        )
      : request.settlementProvenance,
  };
}

function requestResult<T extends { readonly requestId: string | null }>(result: T, title: string) {
  const id = RequestIdSchema.safeParse(result.requestId);
  return id.success ? { ...result, link: formatReferenceLink(id.data, title) } : result;
}
