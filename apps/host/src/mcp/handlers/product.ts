import { sql } from "kysely";
import { agentGrantAccess, RunnerIdSchema, utf8Prefix } from "@opensteer/core";
import { requestResult } from "../request-result.js";
import { requestPendingGuidance } from "@opensteer/shared/requestGuidance";
import {
  savedLoginAgentResult,
  cardAgentResult,
  chromeCookiesAgentResult,
} from "../../browser/agent-request-results.js";
import type { TabServicePort } from "../../tabs/ports.js";
import { PersonShowTargetSchema } from "@opensteer/core";
type DelegationCall = ToolCall<"opensteer_task_delegate"> & {
  input: ToolCall<"opensteer_task_delegate">["input"] & { create?: true };
};
import type { DeviceAccessService } from "../../administration/device-access-service.js";
import { threadWaitMaxMs } from "@opensteer/agent-tools/tools";
import { toolRequestAnswerer } from "@opensteer/agent-tools/outputs";
import {
  readAgentThreadRecent,
  readAgentThreadActivity,
  encodeThreadHistoryCursor,
  isThreadHistoryCursor,
  readAssignmentResult,
  readConnectionChildResult,
  countPendingConnectionRequests,
  beginAssignmentResultWait,
  endAssignmentResultWait,
  withoutDatabaseOperationSignal,
  withDatabaseOperationSignal,
  readAgentRequest,
  AgentRequestResponderSchema,
  reachableNode,
} from "@opensteer/database";
import { activityItem, messageItem, taskItem, boundedThreadItems } from "../thread-items.js";
import { productToolOutput } from "../tool-output.js";
import { stripRefs } from "@opensteer/shared/stripRefs";
import { isDeepStrictEqual } from "node:util";
import { ThreadService } from "../../threads/thread-service.js";
import { ThreadWaitService } from "../../threads/thread-wait.js";
import type { TaskQuestionNotices } from "../../threads/task-question-notices.js";
import { readThreadWaitSnapshot } from "@opensteer/database";
import { withDatabaseTransaction } from "@opensteer/database";
import { assertThreadCaller } from "@opensteer/database";
import type { RealtimeHub } from "@opensteer/orchestration";
import type { PersonShowMessage } from "@opensteer/protocol";
import {
  answeredQuestionPreviewBytes,
  agentDelegationMaxDepth,
  causalChainMaxDelegations,
  causalChainMaxAutonomousRuns,
  catalogDefaultCandidate,
  catalogDefaultModelSelection,
  isPlaceContentPart,
  personQuestionRecord,
  personQuestionRecordWithin,
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
  ThreadIdSchema,
  MessageIdSchema,
  type PlaceContentPart,
  type PlaceIdentity,
  type DeploymentId,
  type EnvironmentId,
  type UserId,
  type HarnessId,
  type Message,
  type ThreadId,
  type Thread,
  excludedBackgroundAccounts,
} from "@opensteer/core";
import type {
  BrowserUsageCredit,
  OpensteerStore,
  ThreadCallerAuthority,
} from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import { computerAppIdentityKey } from "@opensteer/protocol";

import type { BrowserService } from "../../browser/browser-service.js";
import type { BrowserSourceService } from "../../browser/browser-source-service.js";
import type { SavedLoginService } from "../../browser/saved-logins.js";
import type { PlaceContextService } from "../../computer-use/place-context-service.js";
import type { ComputerUseService } from "../../computer-use/computer-use-service.js";

import type { MachineFullDiskAccessService } from "../../shell/machine-full-disk-access-service.js";
import { delegationPlacement } from "../../agents/delegation-placement.js";
import { aiAccountDiscovery } from "../ai-accounts.js";

import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import type { MemoryPassService } from "../../agents/memory-pass-service.js";
import { callerLineage, callerReader, callerThread, type AgentCaller } from "../agent-caller.js";
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
  async #readableTabPlaces<T extends { tabId: import("@opensteer/core").TabId }>(
    caller: AgentCaller,
    rows: readonly T[],
  ): Promise<T[]> {
    const owner = caller.userId;
    // A selected grant reads only places in tabs its own lineage's tasks opened.
    const lineageId = selectedLineageId(caller);
    if (lineageId && rows.length) {
      const tabs = await this.#store.database
        .selectFrom("personalTabs")
        .leftJoin("threads", (join) =>
          join.on(sql<boolean>`threads.id = personal_tabs.opened_by->>'taskId'`),
        )
        .select(["personalTabs.id", "threads.originConnectionId"])
        .where("personalTabs.ownerId", "=", owner)
        .where(
          "personalTabs.id",
          "in",
          rows.map((row) => row.tabId),
        )
        .execute();
      const own = new Set(
        tabs.filter((tab) => tab.originConnectionId === lineageId).map((tab) => tab.id),
      );
      rows = rows.filter((row) => own.has(row.tabId));
    }
    // And only a place the grant reaches now: a page in a profile it still names.
    const grant = callerLineage(caller)?.grant;
    const selected = grant?.scope === "selected" ? grant : null;
    const visible = await Promise.all(
      rows.map(
        async (row) =>
          await this.#tabs?.get?.(owner, row.tabId).then(
            (tab) =>
              !selected ||
              (tab.kind === "page" &&
                !!tab.profile &&
                agentGrantAccess(selected, {
                  kind: "browser-profile",
                  profileId: tab.profile.profileId,
                }) !== null),
            () => false,
          ),
      ),
    );
    return rows.filter((_, i) => visible[i]);
  }

  readonly #deploymentId: DeploymentId;
  readonly #threads: ThreadService;
  readonly #realtime: Pick<RealtimeHub, "observe" | "observeScopes" | "sendToUsers">;
  readonly #tabs: Pick<TabServicePort, "authorizeShow" | "get"> | undefined;
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
  readonly #canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
  readonly #commands: CommandService;
  readonly #requestResponseVault: RequestResponseVault | undefined;
  readonly #questionNotices: Pick<TaskQuestionNotices, "wait"> | undefined;
  readonly #execution: AgentExecution;
  readonly #isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
  /** Every task it reads, it reads as its caller (`readTask`), never as the person. */
  readonly #store: AgentToolStore;
  readonly #onBrowserUsage: ((credits: readonly BrowserUsageCredit[]) => void) | undefined;
  readonly #placeContext: Pick<PlaceContextService, "assertDelegated"> | undefined;
  readonly #memoryPasses: Pick<MemoryPassService, "admissionSelection"> | undefined;

  constructor(options: {
    readonly deploymentId: DeploymentId;
    readonly threads: ThreadService;
    readonly realtime: Pick<RealtimeHub, "observe" | "observeScopes" | "sendToUsers">;
    readonly computerUse?: Pick<ComputerUseService, "sessionsForRunner" | "authorizeDisplay">;
    readonly personShow?: (userId: UserId, message: PersonShowMessage) => Promise<number>;
    readonly tabs?: Pick<TabServicePort, "authorizeShow" | "get">;
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
    readonly canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
    readonly commands: CommandService;
    readonly requestResponseVault?: RequestResponseVault;
    readonly questionNotices?: Pick<TaskQuestionNotices, "wait">;
    readonly execution: AgentExecution;
    readonly isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
    readonly memoryPasses?: Pick<MemoryPassService, "admissionSelection">;
    readonly store: OpensteerStore;
    readonly onBrowserUsage?: (credits: readonly BrowserUsageCredit[]) => void;
    readonly placeContext?: Pick<PlaceContextService, "assertDelegated">;
  }) {
    this.#deploymentId = options.deploymentId;
    this.#threads = options.threads;
    this.#memoryPasses = options.memoryPasses;
    this.#realtime = options.realtime;
    this.#tabs = options.tabs;
    this.#personShow = options.personShow;
    this.#supportsLoginFill = options.supportsLoginFill ?? (() => false);
    this.#browserSources = options.browserSources;
    this.#savedLogins = options.savedLogins;
    this.#deviceAccess = options.deviceAccess;
    this.#machineFullDiskAccess = options.machineFullDiskAccess;
    this.#browser = options.browser;
    this.#canRunHarness = options.canRunHarness;
    this.#commands = options.commands;
    this.#requestResponseVault = options.requestResponseVault;
    this.#questionNotices = options.questionNotices;
    this.#execution = options.execution;
    this.#isEnvironmentConnected = options.isEnvironmentConnected;
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
  async preparePersonShow({ caller, input }: ToolCall<"show_to_person">) {
    const target = PersonShowTargetSchema.parse(input.target);
    const claims = requireRun(caller).claims;
    if (await this.#store.runAssignment(claims.runId))
      throw forbidden(assignedRunRefusal, assignedRunNext);
    if (!this.#personShow) throw badRequest("Showing tabs is unavailable on this Host.");
    if ("tabId" in target) {
      if (!this.#tabs) throw badRequest("Tabs are unavailable on this Host.");
      await this.#tabs.authorizeShow(claims, target.tabId);
    } else if (
      !(await this.#store.readTask(callerReader(caller), target.taskId, claims.requestedBy))
    )
      throw new OpensteerError({ code: "not_found", message: "Task not found." });
    return target;
  }

  async show_to_person(call: ToolCall<"show_to_person">) {
    const { caller, input, operationKey } = call;
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "show_to_person");
    const target = await this.preparePersonShow(call);
    if (!this.#personShow) throw badRequest("Showing places is unavailable on this Host.");
    const admission = await this.#store.admitRunToolCall(
      runAdmission(caller, "show_to_person", input, requestId),
    );
    if (!admission.wasDuplicate && "tabId" in target)
      await this.#tabs!.authorizeShow(claims, target.tabId);
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

  async send_to_person({ caller, input, operationKey }: ToolCall<"send_to_person">) {
    const claims = requireRun(caller).claims;
    const requestId = operationId(caller, operationKey, "send_to_person");
    if (await this.#store.runAssignment(claims.runId))
      throw forbidden(assignedRunRefusal, assignedRunNext);

    const result = await this.#commands.publishPersonMessage({
      admission: runAdmission(caller, "send_to_person", input, requestId),
      message: input.message,
    });
    return {
      messageId: result.message.id,
      link: formatReferenceLink(result.message.id, "Message"),
    };
  }

  async ask_person({ caller, input, operationKey }: ToolCall<"ask_person">) {
    const claims = requireRun(caller).claims;
    if (await this.#store.runAssignment(claims.runId))
      throw forbidden(assignedRunRefusal, "Ask the parent task with opensteer_task_send.");
    const created = await this.#store.requests.create({
      callId: operationId(caller, operationKey, "ask_person"),
      kind: "person.question",
      mode: "durable",
      originatingRunId: claims.runId,
      originatingThreadId: claims.threadId,
      payload: { kind: "person.question" },
      presentation: {
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        fields: input.questions.map((question, index) => ({
          ...(question.options === undefined
            ? {}
            : {
                choices: question.options.map(({ description, label }) => ({
                  ...(description === undefined ? {} : { description }),
                  label,
                  value: label,
                })),
              }),
          custom: true,
          id: `question_${index + 1}`,
          multiSelect: question.multiSelect === true,
          prompt: question.question,
          secret: false,
        })),
        kind: "form",
        title: input.title,
      },
      requestedBy: claims.requestedBy,
      requiredActor: "requester",
    });
    return requestResult(
      created.request,
      created.request.status === "pending"
        ? requestPendingGuidance
        : "The question is closed; continue using the delivered answer.",
      created.replayed,
    );
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
        (await this.#store.readTask(
          callerReader(caller),
          ancestor.parentThreadId,
          caller.userId,
        )) ?? undefined;
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
      const parent = await this.#store.readTask(
        callerReader(caller),
        parentThreadId,
        caller.userId,
      );
      const lineageId = selectedLineageId(caller);
      // A foreign parent and an unknown one look the same to a selected grant.
      if (
        !parent ||
        (lineageId && (await this.#store.threadOrigins([parent.id])).get(parent.id) !== lineageId)
      )
        throw forbidden("Parent task is unavailable");
    }
    const connectionAuthority = connectionAuthorityForLineage(caller);
    const page = await this.#store.agentThreadPageForOwner({
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(input.cursor ? { before: input.cursor } : {}),
      // Reserve escaped link bytes before the database chooses the page's cursor.
      maxBytes: 128 * 1_024 - input.limit * (6 * threadTitleMaxLength + 128),
      maxItems: input.limit,
      ownerId: claims.requestedBy,
      ...(input.query ? { query: input.query } : {}),
      ...(input.changedSince ? { changedSince: new Date(input.changedSince) } : {}),
      ...(input.done === undefined ? {} : { done: input.done }),
      ...(input.hasPendingRequests === undefined
        ? {}
        : { hasPendingRequests: input.hasPendingRequests }),
      ...(connectionAuthority ? { connectionAuthority } : {}),
      ...(caller.kind === "connection" ? { omitPendingRequests: true } : {}),
      scope,
      ...(caller.kind === "connection" ? { nativeOnly: true } : {}),
      reader: callerReader(caller),
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
        doneBy: summary.doneBy,
        lastVisitedAt: summary.lastVisitedAt,
        title: summary.title,
        updatedAt: summary.updatedAt,
        ...(summary.newMessages === undefined
          ? {}
          : { newMessages: summary.newMessages, firstNewAt: summary.firstNewAt }),
        ...(summary.questionsAnswered === undefined
          ? {}
          : { questionsAnswered: summary.questionsAnswered }),
        ...(summary.questionsDismissed === undefined
          ? {}
          : { questionsDismissed: summary.questionsDismissed }),
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
    const thread =
      caller.kind === "connection"
        ? await this.#store.readTask(callerReader(caller), threadId, claims.requestedBy, {
            ...lineageOption(caller),
            nativeOnly: true,
          })
        : await this.#store.readTask(
            callerReader(caller),
            threadId,
            claims.requestedBy,
            lineageOption(caller),
          );
    if (!thread) throw forbidden("task is unavailable to this user");

    const connectionAuthority = connectionAuthorityForLineage(caller);
    const recent = await readAgentThreadRecent(this.#store.database, {
      threadId: thread.id,
      ownerId: caller.userId,
      runLimit: input.runLimit,
      ...(connectionAuthority ? { connectionAuthority } : {}),
    });
    if (!recent) throw forbidden("task is unavailable to this user");
    const seen = new Set<string>();
    const references = recent.places.flatMap((place) => {
      const key = `${place.runId}:${place.tabId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ threadId: thread.id, ...place }];
    });
    const recentPlaces = (await this.#readableTabPlaces(caller, references))
      .slice(0, 10)
      .map(({ runId, tabId, title, site }) => ({ runId, tabId, title, site }));
    const pendingRequests = boundedThreadItems(
      (recent.pendingRequests ?? []).map((request) => agentRequest(request, "list")),
      64 * 1024,
    );
    const context = {
      thread: {
        ...thread,
        ...(connectionAuthority && recent.pendingRequestCount !== undefined
          ? { pendingRequests: recent.pendingRequestCount }
          : {}),
        link: formatReferenceLink(thread.id, thread.title),
      },
      recentRuns: recent.runs.map(({ modelSelection, ...run }) => ({
        ...run,
        link: formatReferenceLink(run.runId, `Run · ${thread.title}`),
        modelId: modelSelection.modelId,
      })),
      recentPlaces,
      ...(pendingRequests.length ? { pendingRequests } : {}),
    };
    if (input.itemId ? !MessageIdSchema.safeParse(input.itemId).success : input.view === "activity")
      return { ...context, ...(await this.#activity(caller, thread.id, input)) };
    if (
      !input.query &&
      !input.aroundMessageId &&
      !input.itemId &&
      !(input.cursor && isThreadHistoryCursor(input.cursor))
    )
      return { ...context, ...(await this.#activity(caller, thread.id, input, undefined, true)) };
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
    const node = await reachableNode(
      this.#store.database,
      input.subagentId!,
      caller.userId,
      selectedLineageId(caller),
    );
    if (!node) throw missing();
    const thread = await this.#store.readTask(callerReader(caller), node.threadId, caller.userId);
    if (!thread) throw missing();
    const { node: subagent, ...activity } = await this.#activity(caller, thread.id, input, node.id);
    const pendingRequests = await this.#scopedPendingRequests(
      caller,
      thread.id,
      thread.pendingRequests,
    );
    return {
      thread: {
        ...thread,
        pendingRequests,
        link: formatReferenceLink(thread.id, thread.title),
      },
      subagent,
      recentRuns: [],
      recentPlaces: [],
      ...activity,
    };
  }

  async #scopedPendingRequests(caller: AgentCaller, threadId: ThreadId, fallback: number) {
    if (caller.kind === "connection") return fallback;
    const connectionAuthority = connectionAuthorityForLineage(caller);
    if (!connectionAuthority) return fallback;
    return countPendingConnectionRequests(this.#store.database, connectionAuthority, threadId);
  }

  async #activity(
    caller: AgentCaller,
    threadId: Thread["id"],
    input: ToolCall<"opensteer_task_read">["input"],
    nodeId?: import("@opensteer/core").ExecutionNodeId,
    messagesOnly?: boolean,
  ) {
    const connectionAuthority = connectionAuthorityForLineage(caller);
    const page = await readAgentThreadActivity(this.#store.database, {
      threadId,
      ownerId: caller.userId,
      limit: input.itemId ? 1 : input.limit,
      ...(connectionAuthority ? { connectionAuthority } : {}),
      ...(nodeId
        ? { nodeId, messagesOnly: input.view !== "activity" && !input.itemId }
        : messagesOnly
          ? { messagesOnly: true }
          : {}),
      ...(input.cursor ? { before: input.cursor } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
    });
    if (!page)
      throw forbidden(nodeId ? "Subagent is unavailable" : "task is unavailable to this user");
    if (input.itemId && !page.items.some(({ id }) => id === input.itemId))
      throw forbidden(
        nodeId ? "Item is unavailable in this subagent" : "Item is unavailable in this task",
      );
    const machineOf = (item: (typeof page.items)[number]) =>
      item.type === "tool.started" || item.type === "tool.completed"
        ? (item.integration?.computerApp?.runnerId ?? item.integration?.phone?.runnerId)
        : undefined;
    const machineIds = page.items.flatMap((item) => machineOf(item) ?? []);
    const [places, owners, messages] = await Promise.all([
      this.#readableTabPlaces(
        caller,
        page.items.flatMap((item) =>
          item.type === "place.entered" ? [{ id: item.id, tabId: item.place.tabId }] : [],
        ),
      ),
      machineIds.length
        ? this.#store.effectiveDeviceOwners(machineIds)
        : Promise.resolve(new Map()),
      this.#readableMessages(
        caller,
        page.items.flatMap((item) => (item.type === "message" ? [item.message] : [])),
      ),
    ]);
    const readablePlaces = new Set(places.map((place) => place.id));
    const readableMessages = new Map(messages.map((message) => [message.id, message]));
    const mapped = page.items.flatMap<{
      item: (typeof page.items)[number];
      view: ReturnType<typeof activityItem>;
    }>((item) => {
      if (item.type === "message") {
        const message = readableMessages.get(item.message.id);
        return message
          ? [
              {
                item,
                view: messageItem(message, input.maxCharsPerItem, input.textOffset),
              },
            ]
          : [];
      }
      const machineId = machineOf(item);
      if (machineId && owners.get(machineId)?.effectiveOwner !== caller.userId) return [];
      if (item.type === "place.entered" && !readablePlaces.has(item.id)) return [];
      return [
        {
          item,
          view: activityItem(item, {
            named: !!input.itemId,
            maxChars: input.maxCharsPerItem,
            offset: input.textOffset,
          }),
        },
      ];
    });
    const items = boundedThreadItems(mapped.map(({ view }) => view));
    if (input.itemId && !items.length)
      throw forbidden(
        nodeId ? "Item is unavailable in this subagent" : "Item is unavailable in this task",
      );
    const trimmed = items.length < mapped.length;
    const last = mapped[items.length - 1]?.item;
    return {
      ...(nodeId ? { node: page.node } : {}),
      items,
      hasMore: trimmed || page.hasMore,
      nextBefore:
        trimmed && last
          ? page.encodeCursor({ beforeId: last.id, beforePosition: last.position })
          : page.nextBefore,
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
    const target = await this.#store.readTask(callerReader(caller), threadId, caller.userId);
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
      const node = await reachableNode(
        this.#store.database,
        input.subagentId,
        caller.userId,
        selectedLineageId(caller),
      );
      if (!node) throw forbidden("Subagent is unavailable");
      return [node.threadId];
    }
    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: input.delegationId!,
      ownerId: caller.userId,
      reader: callerReader(caller),
    });
    // The same refusal as a delegation whose task lies outside the caller's lineage.
    if (!assignment) throw forbidden("Task is unavailable");
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
      const node = await reachableNode(
        this.#store.database,
        input.subagentId,
        caller.userId,
        selectedLineageId(caller),
      );
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
      reader: callerReader(caller),
    });
    if (!assignment) throw forbidden("delegation is unavailable");
    const target = await this.#store.readTask(
      callerReader(caller),
      assignment.workerThreadId,
      caller.userId,
    );
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
      reader: callerReader(caller),
    });
    if (!assignment) throw forbidden("delegation is unavailable");
    const pendingRequests = await this.#scopedPendingRequests(
      caller,
      summary.workerThread.id,
      summary.workerThread.pendingRequests,
    );
    return taskItem(
      { ...summary, workerThread: { ...summary.workerThread, pendingRequests } },
      assignment.resultText,
    );
  }
  async opensteer_delegation_status({ caller, input }: ToolCall<"opensteer_delegation_status">) {
    const assignment = await this.#store.getAssignmentForOwner({
      assignmentId: input.delegationId,
      ownerId: caller.userId,
      reader: callerReader(caller),
    });
    // One refusal for a missing delegation and one outside the caller's lineage.
    if (!assignment) throw forbidden("Task is unavailable");
    const worker = await this.#store.readTask(
      callerReader(caller),
      assignment.workerThreadId,
      caller.userId,
    );
    if (!worker) throw forbidden("Task is unavailable");

    const read = await readAssignmentResult(this.#store.database, {
      assignmentId: input.delegationId,
      authority: threadCallerAuthority(caller),
    });
    const pendingRequests = await this.#scopedPendingRequests(
      caller,
      read.assignment.workerThread.id,
      read.assignment.workerThread.pendingRequests,
    );
    return taskItem(
      {
        ...read.assignment,
        workerThread: { ...read.assignment.workerThread, pendingRequests },
      },
      read.result,
    );
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
      status?: "pending" | "all";
      taskId?: ThreadId | undefined;
    };
  }) {
    if (input.action === "respond") {
      const run = requireRun(caller);
      const { request } = await readAgentRequest(
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
        expectedRevision: agentResponder.expectedRevision,
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
      return { request: agentRequest((await this.#store.requests.get(request.id))!, "full") };
    }
    if (input.action === "read") {
      const { request, revision } = await readAgentRequest(
        this.#store.database,
        threadCallerAuthority(caller),
        input.requestId!,
      );
      return {
        request: {
          ...agentRequest(request, "full"),
          revision,
          ...(requestIsAgentAnswerable(request) ? { presentation: request.presentation } : {}),
        },
      };
    }
    const scope = callerListScope(caller);
    const connectionAuthority = connectionAuthorityForLineage(caller);
    const reader = callerReader(caller);
    if (input.taskId) {
      const target = await this.#store.readTask(reader, input.taskId, caller.userId, {
        ...lineageOption(caller),
        ...(caller.kind === "connection" ? { nativeOnly: true } : {}),
      });
      if (!target) throw forbidden("Task is unavailable");
    }
    const page = await this.#store.requests.agentPage({
      ownerId: caller.userId,
      scope,
      scopeId: caller.kind === "connection" ? caller.key : callerThread(caller).id,
      ...(connectionAuthority ? { connectionAuthority } : {}),
      ...(input.taskId ? { originatingThreadId: input.taskId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.cursor ? { before: input.cursor } : {}),
      limit: input.limit,
    });
    const projected = page.requests.map((request) => agentRequest(request, "list"));
    return {
      requests: projected,
      window: {
        ...page.window,
        byteCount: Buffer.byteLength(JSON.stringify(productToolOutput(projected)), "utf8"),
      },
    };
  }

  async opensteer_request_withdraw({ caller, input }: ToolCall<"opensteer_request_withdraw">) {
    const claims = requireRun(caller).claims;

    const withdrawn = await this.#store.requests.withdraw({
      requestId: input.requestId,
      threadId: claims.threadId,
      withdrawnBy: claims.requestedBy,
    });
    return { request: agentRequest(withdrawn.request, "full") };
  }

  async prepareDelegation({ caller, input }: DelegationCall) {
    const currentThread = callerThread(caller);
    const claims = callerContext(caller);
    const existingThread = input.taskId
      ? await this.#store.readTask(callerReader(caller), input.taskId, claims.requestedBy)
      : null;
    if (input.taskId && !existingThread) throw forbidden("Target task is unavailable");
    if (existingThread) {
      assertMutableTarget(caller, existingThread);
      if (existingThread.purpose !== "task" || existingThread.id === currentThread.id) {
        throw badRequest("Choose another task for this delegation");
      }
    }
    const environmentId = await this.#execution.environmentFor(claims.requestedBy);
    const environment = await this.#store.getEnvironment(environmentId);
    if (!environment) throw badRequest(unknownEnvironment, chooseExecutionNext);
    const placement = await delegationPlacement(this.#store, {
      environment,
      existingThread,
      harnessInstanceId: input.aiAccountId,
      model: input.model,
      parent: currentThread,
    });
    return { existingThread, environment, placement };
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
    if (
      prior.type !== "thread.create" ||
      !prior.threadId ||
      Object.entries(asked).some(([field, value]) => !isDeepStrictEqual(requested[field], value))
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
    const { existing, environmentId, harnessInstanceId, harnessRevision, modelSelection } =
      await this.#prepareConnectionDelegation(caller, input);
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
      expected,
    );
    return { thread, ...expected };
  }
  /** A Run or program's standalone task, placed as its own delegation would be. */
  async #createRunStandaloneTask(call: DelegationCall, requestId: string): Promise<StandaloneTask> {
    const { caller, input } = call;
    const { environment, placement } = await this.prepareDelegation(call);
    const expected =
      placement.harnessRevision === undefined
        ? {}
        : { expectedHarnessRevision: placement.harnessRevision };
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
      { ...expected, placed: true },
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
      const thread = (await this.#store.readTask(callerReader(caller), created.id, caller.userId))!;
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
        pendingRequests: await this.#scopedPendingRequests(
          caller,
          thread.id,
          thread.pendingRequests,
        ),
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
        const { existingThread, environment, placement } = await this.prepareDelegation({
          caller,
          input,
          operationKey,
        });
        const delegateInput = {
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
    const request =
      "requestId" in result && result.requestId
        ? await this.#store.requests.get(result.requestId)
        : await this.#store.requests.findByCallIdentity({
            callId: operationId(caller, operationKey, "card_request"),
            originatingRunId: claims.runId,
          });
    return cardAgentResult(result, request);
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
    const request =
      "requestId" in result && result.requestId
        ? await this.#store.requests.get(result.requestId)
        : await this.#store.requests.findByCallIdentity({
            callId: operationId(caller, operationKey, "saved_login_request"),
            originatingRunId: claims.runId,
          });
    return savedLoginAgentResult(result, request);
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
    const request =
      "requestId" in result && result.requestId
        ? await this.#store.requests.get(result.requestId)
        : await this.#store.requests.findByCallIdentity({
            callId: operationId(caller, operationKey, "chrome_cookies_request"),
            originatingRunId: claims.runId,
          });
    return chromeCookiesAgentResult(result, request);
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
        computerId: RunnerIdSchema.parse(input.computerId),
        reason: input.reason,
        claims,
      });
      return {
        ...result,
        link: result.requestId
          ? formatReferenceLink(result.requestId, "Full Disk Access")
          : undefined,
        next:
          result.status === "pending"
            ? requestPendingGuidance
            : result.status === "fulfilled"
              ? "Check computer access and continue the task."
              : "The request is closed. Continue without this access.",
      };
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
    return {
      ...result,
      link: result.requestId ? formatReferenceLink(result.requestId, "Computer access") : undefined,
      next:
        result.status === "pending"
          ? requestPendingGuidance
          : result.status === "fulfilled"
            ? "Check computer access and continue the task."
            : "The request is closed. Continue without this access.",
    };
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
    return {
      ...result,
      link: result.requestId ? formatReferenceLink(result.requestId, "Browser profile") : undefined,
      next:
        result.status === "pending"
          ? requestPendingGuidance
          : result.status === "fulfilled"
            ? "Use tab_open with the approved profile."
            : "The request is closed. Continue without this profile.",
    };
  }

  async opensteer_task_send({ caller, input, operationKey }: ToolCall<"opensteer_task_send">) {
    const anchor = caller.kind === "connection" ? null : callerThread(caller);
    const requestId = operationId(caller, operationKey, "opensteer_task_send");
    const observationId = input.observationId ?? requestId;
    const destination = ThreadIdSchema.parse(input.taskId);
    if (destination === anchor?.id && caller.kind === "run")
      throw badRequest("An agent cannot message its own active task");
    const thread = await this.#store.readTask(callerReader(caller), destination, caller.userId);
    if (!thread) throw forbidden("task is unavailable to this user");
    if (caller.kind !== "connection" || input.delivery !== "queue")
      assertMutableTarget(caller, thread);
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
    const preferred = preferences.history.find((entry) => entry.environmentId === environmentId);
    const named = existing?.harnessInstanceId ?? input.aiAccountId ?? preferred?.harnessInstanceId;
    const automatic = named ? null : await this.#automaticDefault(caller.userId, environmentId);
    const harnessInstanceId = named ?? automatic?.harnessInstanceId;
    if (!harnessInstanceId)
      throw badRequest(
        "No default AI account is available for a new task. Ask the person to choose one.",
      );
    const modelSelection =
      existing?.modelSelection ??
      input.model ??
      (preferred?.harnessInstanceId === harnessInstanceId ? preferred.modelSelection : undefined) ??
      automatic?.modelSelection ??
      catalogDefaultModelSelection(
        await this.#store.getHarnessCatalog(environmentId, harnessInstanceId),
      );
    if (!modelSelection)
      throw badRequest(
        "No default model is available for a new task. Ask the person to choose one.",
      );
    return {
      existing,
      environmentId,
      harnessInstanceId,
      harnessRevision: undefined,
      modelSelection,
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
    return {
      link: formatReferenceLink(thread.id, thread.title),
      paused: queue.paused,
      items: queue.items.map(({ message, canCancel, canMove, canSteer }) => {
        const plain = stripRefs(message.preview);
        const preview = utf8Prefix(plain, 500);
        return {
          messageId: message.id,
          link: formatReferenceLink(message.id, `Message · ${thread.title}`),
          author: message.author,
          preview,
          truncated: message.truncated || preview !== plain,
          canCancel,
          canMove,
          canSteer,
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
    const authority = caller.kind === "connection" ? threadCallerAuthority(caller) : undefined;
    const connectionAuthority = connectionAuthorityForLineage(caller);
    const assignmentId = input.delegationId ?? (input.afterMessageId ? undefined : own);
    const assignment = assignmentId
      ? await this.#store.getAssignmentForOwner({
          assignmentId,
          ownerId: caller.userId,
          reader: callerReader(caller),
        })
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
          const unobserve = this.#realtime.observeScopes(
            [`thread:${threadId}`, ...(anchorId ? [`thread:${anchorId}`] : [])],
            wake,
          );
          const unobserveNotices = this.#realtime.observe((change) => {
            if (caller.kind === "program" && change.type === "host.triggers-changed") wake();
          });
          return () => {
            unobserve();
            unobserveNotices();
          };
        },
        read: ({ signal, expiresAt }) =>
          withDatabaseOperationSignal(signal, expiresAt, async () => {
            await call.checkLive?.();
            const thread = await this.#store.readTask(
              callerReader(caller),
              threadId,
              caller.userId,
            );
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
              ...(connectionAuthority ? { connection: connectionAuthority } : {}),
              ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
              ...(!assignment && afterSequence ? { afterSequence } : {}),
            });
            runId ??= snapshot.run?.id;
            afterSequence ??= snapshot.lastSequence ?? zeroSequence;
            const task = assignment
              ? await this.#store.getAssignmentForOwner({
                  assignmentId: assignment.id,
                  ownerId: caller.userId,
                  reader: callerReader(caller),
                })
              : null;
            if (assignment && !task) throw forbidden("delegation is unavailable");
            const connection =
              caller.kind === "connection"
                ? await this.#store.database
                    .selectFrom("agentConnections")
                    .select("expiresAt")
                    .where("id", "=", caller.connectionId)
                    // A bridge has no expiry to report.
                    .where("bridgeAccountId", "is", null)
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
      const target = await this.#store.readTask(callerReader(caller), threadId, caller.userId);
      if (!target) throw forbidden("task is unavailable");

      await withDatabaseTransaction(this.#store.database, (tx) =>
        assertThreadCaller(tx, threadCallerAuthority(caller), { threadId, readOnly: true }),
      );
      // Watching its own task's messages hands the caller the final reply too, once it has settled.
      const settled = assignment?.id ?? (result.status === "settled" ? own : undefined);
      const connectedTask =
        authority?.kind === "connection" && !assignment
          ? await readConnectionChildResult(this.#store.database, {
              authority,
              childThreadId: threadId,
            })
          : undefined;
      const task =
        settled && result.status === "settled"
          ? await readAssignmentResult(this.#store.database, {
              assignmentId: settled,
              authority: threadCallerAuthority(caller),
              ...(call.signal ? { signal: call.signal } : {}),
            })
          : connectedTask;
      // Oldest first, so the last item is where the next wait resumes.
      const items = boundedThreadItems(
        result.messages.map((message) => messageItem(message, 20_000)),
      );
      const scopedTask = task
        ? {
            ...task,
            assignment: {
              ...task.assignment,
              workerThread: {
                ...task.assignment.workerThread,
                pendingRequests: await this.#scopedPendingRequests(
                  caller,
                  task.assignment.workerThread.id,
                  task.assignment.workerThread.pendingRequests,
                ),
              },
            },
          }
        : undefined;
      return {
        status: result.status,
        ...(scopedTask ? { task: taskItem(scopedTask.assignment, scopedTask.result) } : {}),
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
        await withoutDatabaseOperationSignal(() =>
          endAssignmentResultWait(this.#store.database, { assignmentId: held, waitId }),
        );
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
    const thread = await this.#store.readTask(
      callerReader(caller),
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

const requestQuestionFullBytes = 16 * 1024;

function agentRequest(request: Request, detail: "full" | "list" = "full") {
  const rawQuestion = personQuestionRecord(request);
  const question = rawQuestion
    ? personQuestionRecordWithin(
        rawQuestion,
        detail === "full" ? requestQuestionFullBytes : answeredQuestionPreviewBytes,
      )
    : null;
  return {
    id: request.id,
    link: formatReferenceLink(request.id, requestTitleText(request.presentation)),
    kind: request.kind,
    status: request.status,
    title: requestTitleText(request.presentation),
    reason: "reason" in request.payload ? request.payload.reason : null,
    originatingThreadId: request.originatingThreadId,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
    ...(question ? { question } : {}),
    settlementProvenance: request.settlementProvenance
      ? toolRequestAnswerer(
          "kind" in request.settlementProvenance
            ? request.settlementProvenance
            : { deviceLabel: request.settlementProvenance.deviceLabel },
        )
      : request.settlementProvenance,
  };
}

/** The connection whose lineage alone a selected grant may reach; undefined otherwise. */
function selectedLineageId(caller: AgentCaller): string | undefined {
  const lineage = callerLineage(caller);
  return lineage?.grant.scope === "selected" ? lineage.agentConnectionId : undefined;
}
function lineageOption(caller: AgentCaller): { readonly lineageConnectionId?: string } {
  const lineageConnectionId = selectedLineageId(caller);
  return lineageConnectionId === undefined ? {} : { lineageConnectionId };
}
/**
 * The store as agent tools hold it: without the person's own read of a task, so a tool reads a
 * task only as its caller.
 */
export type AgentToolStore = Omit<OpensteerStore, "getThreadForOwner">;

/** Connection authority for any caller in a connected agent's lineage; undefined for native work. */
function connectionAuthorityForLineage(
  caller: AgentCaller,
): Extract<ThreadCallerAuthority, { kind: "connection" }> | undefined {
  const lineage = callerLineage(caller);
  if (!lineage) return undefined;
  return {
    kind: "connection",
    userId: caller.userId,
    connectionId: lineage.agentConnectionId,
    accessMode: caller.accessMode,
  };
}
