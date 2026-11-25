import { runHasBrowserPages } from "./browser-capability.js";
import { promptCacheExpiresAt } from "@opensteer/core";
import {
  connectionIsWaiting,
  triggerAnchorStopIsHeld,
  triggerChatIsWaiting,
  dispatchNodeStop,
  grantedContent,
  NodeStopAuthoritySchema,
  senderUnlinkedFailure,
} from "@opensteer/database";
import { agentToolsPlanForRun } from "./agent-tools-plan.js";
import {
  ModelSelectionSchema,
  CommandIdSchema,
  OpensteerError,
  agentGrantAccess,
  agentGrantToolFamilies,
  type ContentPart,
  placeInputFailure,
  runnerAgentToolsFailure,
  RequestIdSchema,
  RequestResponseSchema,
  RunIdSchema,
  ExecutionNodeIdSchema,
  SequenceSchema,
  ThreadIdSchema,
  type EnvironmentId,
  type RunnerId,
  type ThreadId,
  type TriggerOccurrenceId,
  type RunId,
  type UserId,
} from "@opensteer/core";
import type {
  AttachmentStore,
  CommandRow,
  OpensteerStore,
  PendingCommandRow,
  TriggerStore,
} from "@opensteer/database";
import {
  initialContinuationContextFits,
  initialContinuationHistoryBudget,
  isRetryableHarnessCatalogStatus,
  selectInitialContinuationContext,
} from "@opensteer/harness";
import {
  CommandDispatchError,
  type DurableCommandDispatcher,
  type RunnerRegistry,
} from "@opensteer/orchestration";
import {
  attemptStopStateCapability,
  CorrelationIdSchema,
  ProtocolErrorSchema,
  HarnessInputSchema,
  RunInitialContextSchema,
  type HarnessInstanceCatalog,
  type MachineAccessRunContext,
  type RunnerCommand,
} from "@opensteer/protocol";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { BrowserService } from "../browser/browser-service.js";
import {
  openRequestResponse,
  type RequestResponseVault,
} from "../identity/request-response-vault.js";
import type { PluginPackagesTokenService } from "../local-servers/plugin-package-service.js";
import type { EgressService } from "../server/egress-service.js";
import { computeMachineAccess } from "../shell/machine-access-run-context.js";
import type { TriggerControlTokenService } from "../triggers/trigger-control-service.js";
import { automationScriptCompatibilityReason } from "../triggers/automation-script-compatibility.js";
import type { AutomationSecrets } from "../triggers/automation-secrets.js";
import { TRIGGER_SCRIPT_UPDATE_REASON } from "@opensteer/triggers";
import type { RunToolTokenService } from "./run-tool-tokens.js";
import {
  harnessInspectionDefinition,
  inspectAndRecordHarnessCatalogs,
  type HarnessCatalogRecorder,
} from "./harness-catalogs.js";
import {
  matchModelSelection,
  modelOptionUnavailableMessage,
  runModelSelection,
} from "./model-selection.js";
import type { RunCapabilityTokenService } from "./run-capability.js";
const ControlPayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("node.stop"),
      runId: RunIdSchema,
      threadId: ThreadIdSchema,
      nodeId: ExecutionNodeIdSchema,
      bindingGeneration: z.number().int().positive(),
      authority: NodeStopAuthoritySchema.optional(),
    })
    .passthrough(),
  z
    .object({
      runId: RunIdSchema,
      threadId: ThreadIdSchema,
      type: z.literal("run.interrupt"),
      expectedBindingGeneration: z.number().int().positive().nullable().optional(),
      stop: z.object({ id: CommandIdSchema, bootId: z.string() }).optional(),
    })
    .passthrough(),
  z
    .object({
      requestId: RequestIdSchema,
      response: RequestResponseSchema,
      runId: RunIdSchema,
      threadId: ThreadIdSchema,
      type: z.literal("request.respond"),
    })
    .passthrough(),
  z
    .object({
      runId: RunIdSchema,
      threadId: ThreadIdSchema,
      type: z.literal("run.steer"),
    })
    .passthrough(),
  z
    .object({
      bindingGeneration: z.number().int().positive(),
      runId: RunIdSchema,
      threadId: ThreadIdSchema,
      type: z.literal("run.restart"),
    })
    .passthrough(),
]);
const supportedCommandTypes = new Set([
  "request.respond",
  "node.stop",
  "run.interrupt",
  "run.execute",
  "run.restart",
  "run.steer",
  "trigger.execute",
]);
export class HostCommandDispatcher implements DurableCommandDispatcher {
  readonly #attachmentRunTokens: RunCapabilityTokenService<"opensteer-run-attachments">;
  readonly #attachments: Pick<AttachmentStore, "listForRun">;
  readonly #runToolTokens: RunToolTokenService;
  readonly #requestResponseVault: RequestResponseVault;
  readonly #agentToolsUrl: string;
  readonly #agentBrowserCdpUrl: string;
  readonly #pluginVersions: (
    ownerUserId: UserId,
  ) => Promise<import("@opensteer/protocol").RunPluginsPlan["versions"]>;
  readonly #pluginsTokens: PluginPackagesTokenService;
  readonly #pluginsUrl: string;
  readonly #skillPolicy: (
    ownerUserId: UserId,
  ) => Promise<import("@opensteer/protocol").RunPluginsPlan["skillPolicy"]>;
  readonly #browser: Pick<BrowserService, "hasBrowserProfiles">;
  readonly #browserCdpUrl: string;
  readonly #egress: EgressService;
  readonly #onTriggerChanged: () => void;
  readonly #runners: RunnerRegistry;
  readonly #runnerRegistrationPending: (environmentId: EnvironmentId) => boolean;
  readonly #onRunAdmitted: (threadId: ThreadId) => void;
  readonly #executionLeaseMs: number;
  readonly #executionNow: () => number;
  readonly #store: OpensteerStore;
  readonly #catalogs: HarnessCatalogRecorder;
  readonly #automationSecrets: Pick<AutomationSecrets, "values"> | undefined;
  readonly #triggerControlTokens: TriggerControlTokenService;
  readonly #triggers: TriggerStore;
  readonly #dispatchingTriggers = new Map<
    TriggerOccurrenceId,
    { readonly runnerBootId: string; readonly runnerId: RunnerId }
  >();
  inFlightTriggerOccurrenceIds(
    runnerId: RunnerId,
    runnerBootId: string,
  ): readonly TriggerOccurrenceId[] {
    const ids: TriggerOccurrenceId[] = [];
    for (const [occurrenceId, entry] of this.#dispatchingTriggers) {
      if (entry.runnerId === runnerId && entry.runnerBootId === runnerBootId) {
        ids.push(occurrenceId);
      }
    }
    return ids;
  }
  constructor(options: {
    readonly attachmentRunTokens: RunCapabilityTokenService<"opensteer-run-attachments">;
    readonly attachments: Pick<AttachmentStore, "listForRun">;
    readonly requestResponseVault: RequestResponseVault;
    readonly runToolTokens: RunToolTokenService;
    readonly browser: Pick<BrowserService, "hasBrowserProfiles">;
    readonly onTriggerChanged?: () => void;
    readonly pluginVersions: (
      ownerUserId: UserId,
    ) => Promise<import("@opensteer/protocol").RunPluginsPlan["versions"]>;
    /** Returns the current personal loose-skill overrides, including their revision.
     * The Settings domain owner supplies this adapter; undefined means no override exists. */
    readonly skillPolicy?: (
      ownerUserId: UserId,
    ) => Promise<import("@opensteer/protocol").RunPluginsPlan["skillPolicy"]>;
    readonly pluginsTokens: PluginPackagesTokenService;
    readonly egress: EgressService;
    readonly executionLeaseMs: number;
    readonly executionClock?: Pick<import("@opensteer/shared/clock").Clock, "now">;
    readonly publicUrl: URL;
    readonly runners: RunnerRegistry;
    readonly runnerRegistrationPending?: (environmentId: EnvironmentId) => boolean;
    readonly onRunAdmitted?: (threadId: ThreadId) => void;
    readonly store: OpensteerStore;
    readonly catalogs?: HarnessCatalogRecorder;
    readonly automationSecrets?: Pick<AutomationSecrets, "values">;
    readonly triggerControlTokens: TriggerControlTokenService;
    readonly triggers: TriggerStore;
  }) {
    this.#automationSecrets = options.automationSecrets;
    this.#attachmentRunTokens = options.attachmentRunTokens;
    this.#attachments = options.attachments;
    this.#requestResponseVault = options.requestResponseVault;
    this.#runToolTokens = options.runToolTokens;
    this.#agentToolsUrl = new URL("/internal/v1/mcp", options.publicUrl).toString();
    this.#agentBrowserCdpUrl = new URL("/internal/v1/browser-cdp", options.publicUrl).toString();
    this.#pluginVersions = options.pluginVersions;
    this.#skillPolicy = options.skillPolicy ?? (async () => undefined);
    this.#pluginsTokens = options.pluginsTokens;
    this.#pluginsUrl = new URL("/internal/v1/plugin-cache", options.publicUrl).toString();
    this.#browser = options.browser;
    this.#browserCdpUrl = new URL("/internal/v1/trigger-cdp", options.publicUrl).toString();
    this.#egress = options.egress;
    this.#onTriggerChanged = options.onTriggerChanged ?? (() => undefined);
    this.#runners = options.runners;
    this.#runnerRegistrationPending = options.runnerRegistrationPending ?? (() => false);
    this.#onRunAdmitted = options.onRunAdmitted ?? (() => undefined);
    this.#executionLeaseMs = options.executionLeaseMs;
    this.#executionNow = options.executionClock?.now ?? (() => Date.now());
    this.#store = options.store;
    this.#catalogs = options.catalogs ?? options.store;
    this.#triggerControlTokens = options.triggerControlTokens;
    this.#triggers = options.triggers;
  }
  isAvailable(command: PendingCommandRow, dispatchingRuns: number): boolean {
    if (!supportedCommandTypes.has(command.type) || command.environmentId === null) return false;
    // A Runner too old to attach never will; dispatching still tells new work
    // to update rather than leaving it queued.
    if (command.type === "run.execute" || command.type === "trigger.execute") {
      const identity = this.#runners.identityForEnvironment(command.environmentId);
      if (identity && !identity.capabilities.includes("execution-plane-v2")) return true;
    }
    // Work for a computer whose person stopped agents on it waits without
    // dispatch attempts; its Runner says when they resume.
    if (
      (command.type === "run.execute" || command.type === "trigger.execute") &&
      this.#runners.areAgentsStopped(command.environmentId)
    )
      return false;
    if (command.type !== "run.execute") return this.#runners.isAttached(command.environmentId);
    // Attachment can wake dispatch before this connection's first account inspection answers.
    if (this.#runnerRegistrationPending(command.environmentId)) return false;
    // An account still preparing waits without dispatch attempts; its Runner
    // says when preparation settles.
    if (
      command.runHarnessInstanceId &&
      this.#runners.isHarnessPreparing(command.environmentId, command.runHarnessInstanceId)
    ) {
      return false;
    }
    if (this.#runners.hasRunCapacity(command.environmentId, dispatchingRuns)) return true;
    // Its computer's Runner runs as many Runs as it may: the Run waits for one of them to end,
    // and says so. Decided from the row this pass read: written only when it has no hold, and
    // marked on that row until the next listing reads it again.
    if (
      command.runId &&
      command.runStartHoldReason === null &&
      this.#runners.isAttached(command.environmentId)
    ) {
      command.runStartHoldReason = "waiting-for-run";
      void this.#store.holdRunForAnotherRun(command.runId).catch(() => {
        // Shown on a later pass: a failed write only delays the words.
        command.runStartHoldReason = null;
      });
    }
    return false;
  }
  async dispatch(command: CommandRow, signal: AbortSignal): Promise<void> {
    if (!command.environmentId) {
      throw new CommandDispatchError("Unsupported durable Runner command", "failed");
    }
    if (command.type === "trigger.execute") {
      await this.#dispatchTrigger(command, signal);
      return;
    }
    if (command.type !== "run.execute") {
      await this.#dispatchControl(command, signal);
      return;
    }
    if (!command.runId) throw new CommandDispatchError("Run command is missing its run", "failed");
    const context = await this.#store.loadRunDispatchContext(command.id);
    this.#onRunAdmitted(context.thread.id);
    const assignment = context.run.assignmentId
      ? await this.#store.getAssignment(context.run.assignmentId)
      : null;
    if (context.run.assignmentId && (!assignment || assignment.status !== "open")) {
      throw new CommandDispatchError("This task assignment is no longer open.", "failed");
    }
    const harness = await this.#store.getHarnessInstance(context.run.harnessInstanceId);
    if (!harness?.enabled || harness.environmentId !== command.environmentId) {
      throw new CommandDispatchError("The selected AI engine is no longer available.", "failed");
    }
    // Read after the awaits above, so a Runner that left meanwhile is waited
    // for rather than taken for one that cannot run this engine.
    const identity = this.#runners.identityForEnvironment(command.environmentId);
    if (!identity) throw new CommandDispatchError("Runner is offline", "retry");
    if (context.run.maintenance && !identity.capabilities.includes("claude-compaction-v1"))
      throw new CommandDispatchError("Update this Runner to support Claude compaction.", "failed");
    if (context.voiceCall && !identity.capabilities.includes("voice-run-v1"))
      throw new OpensteerError({
        code: "conflict",
        reason: "voice-runner-unsupported",
        message: "Update this computer to run voice calls.",
      });
    if (!identity.capabilities.includes("native-session-continuation-v1")) {
      throw new CommandDispatchError(
        "Update this Runner to support durable conversation sessions.",
        "failed",
      );
    }
    if (!identity.capabilities.includes("assignments-v1")) {
      throw new CommandDispatchError(
        "Update this Runner to support durable task assignments.",
        "failed",
      );
    }
    if (!identity.capabilities.includes("thread-state-v1")) {
      throw new CommandDispatchError(
        "Update this Runner so agents can see how earlier Runs and tasks ended.",
        "failed",
      );
    }
    const toolsFailure = runnerAgentToolsFailure(identity.capabilities);
    if (toolsFailure) throw new CommandDispatchError(toolsFailure, "failed");
    if (!identity.capabilities.includes("execution-plane-v2")) {
      throw new CommandDispatchError(
        "Update this Runner to the current execution protocol.",
        "failed",
      );
    }
    // A conversation hands the person's messages to the reply under way, which
    // an older Runner's engine may accept and then leave unanswered.
    if (context.thread.purpose === "voice" && !identity.capabilities.includes("steer-answer-v1")) {
      throw new CommandDispatchError(
        "Update this Runner so messages sent while Opensteer replies are answered.",
        "failed",
      );
    }
    if (!this.#runners.canRunHarness(command.environmentId, harness.driverKind)) {
      throw new CommandDispatchError(
        `${harness.name} is not available on ${identity.name}. Choose another AI engine or reconnect that work location.`,
        "failed",
      );
    }
    let catalog: HarnessInstanceCatalog | undefined;
    try {
      [catalog] = await inspectAndRecordHarnessCatalogs({
        catalogs: this.#catalogs,
        environmentId: command.environmentId,
        harnesses: [harnessInspectionDefinition(harness)],
        runners: this.#runners,
        signal,
      });
    } catch (error) {
      throw new CommandDispatchError(
        `The selected AI engine could not establish its continuation identity: ${error instanceof Error ? error.message : "inspection failed"}`,
        "retry",
      );
    }
    // Inspection answers with nothing only once the Runner has gone.
    if (!catalog) throw new CommandDispatchError("Runner is offline", "retry");
    if (catalog.status !== "ready") {
      throw new CommandDispatchError(
        catalog.detail,
        isRetryableHarnessCatalogStatus(catalog.status) ? "retry" : "failed",
      );
    }
    // The selection was admitted against the catalog of whichever engine
    // release answered then; the one that runs it now decides again.
    const admitted = matchModelSelection(catalog.models, context.run.modelSelection, "carry");
    if (admitted.kind === "model-unavailable") {
      throw new CommandDispatchError(
        admitted.reason ?? "The selected model is no longer available in this AI engine.",
        "failed",
      );
    }
    if (admitted.kind === "option-unavailable") {
      throw new CommandDispatchError(modelOptionUnavailableMessage(admitted), "failed");
    }
    const modelSelection = runModelSelection(context.run.modelSelection, admitted.model);
    if (!ModelSelectionSchema.safeParse(modelSelection).success) {
      throw new CommandDispatchError(
        "The selected model has too many options to run with this saved configuration.",
        "failed",
      );
    }
    let initialContext = context.initialContext;
    if (initialContext) {
      const budget = initialContinuationHistoryBudget({
        inputs: context.inputs,
        model: admitted.model,
        reports: context.reports.messages,
      });
      if (!initialContext.finalized) {
        const candidate = RunInitialContextSchema.parse({
          messages: [...initialContext.messages],
          omittedCount: initialContext.omittedCount,
          throughSequence: initialContext.throughSequence,
        });
        const selected = selectInitialContinuationContext(candidate, budget);
        initialContext = await this.#store.finalizeRunInitialContext({
          commandId: command.id,
          messageIds: selected.messages.map((message) => message.id),
        });
        if (!initialContext) {
          throw new CommandDispatchError(
            "The Run's initial context changed before dispatch.",
            "failed",
          );
        }
      }
      const frozen = RunInitialContextSchema.parse({
        messages: [...initialContext.messages],
        omittedCount: initialContext.omittedCount,
        throughSequence: initialContext.throughSequence,
      });
      if (!initialContinuationContextFits(frozen, budget)) {
        throw new CommandDispatchError(
          "The selected AI model no longer has room for this Run's frozen conversation context.",
          "failed",
        );
      }
    }
    const inputContent = [...context.inputs, ...context.reports.messages].flatMap(
      (message) => message.content,
    );
    const placeFailure = placeInputFailure(
      [
        ...inputContent,
        ...context.history.flatMap((message) => message.content),
        ...(initialContext?.messages ?? []).flatMap((message) => message.content),
      ],
      identity.capabilities,
    );
    if (placeFailure) throw new CommandDispatchError(placeFailure, "failed");
    if (inputContent.some((part) => part.type === "artifact")) {
      const failure = this.#runners.attachmentInputFailure({
        content: inputContent,
        driverKind: harness.driverKind,
        environmentId: context.run.environmentId,
        harnessInstanceId: context.run.harnessInstanceId,
        modelSelection,
      });
      if (failure) throw new CommandDispatchError(failure, "failed");
    }
    const supportsAttachments = this.#runners.supportsMessageAttachments(
      context.run.environmentId,
      harness.driverKind,
    );
    if (
      !supportsAttachments &&
      (
        await this.#attachments.listForRun({
          after: null,
          limit: 1,
          runId: context.run.id,
          threadId: context.thread.id,
        })
      ).length > 0
    ) {
      throw new CommandDispatchError(
        "This Runner must be updated to use this conversation's attachments.",
        "failed",
      );
    }
    // The live connection check precedes every credential this Run is issued.
    // A native Run of the person is known from the rows just read and needs no other query; a
    // Run whose lineage and task disagree is never treated as the person's.
    const { runConnectionId, taskOriginConnectionId } = context.lineage;
    if (taskOriginConnectionId !== null && runConnectionId !== taskOriginConnectionId)
      throw new CommandDispatchError("This task's authority no longer matches.", "failed");
    const authority = await (
      runConnectionId === null
        ? Promise.resolve({ agentConnection: null, mode: context.run.accessMode } as const)
        : this.#store.admitExecution({
            ownerUserId: command.requestedBy,
            subject: { kind: "binding", bindingId: `run:${context.run.id}` },
          })
    ).catch((error: unknown) => {
      // A chat that is only paused holds its Run until it is back; only an end fails it. The
      // read that refused it said which.
      if (runConnectionId !== null && connectionIsWaiting(error)) throw chatRunHeld();
      throw new CommandDispatchError(
        error instanceof OpensteerError ? error.message : "This task's access ended.",
        "failed",
      );
    });
    const lineageGrant = authority.agentConnection?.grant;
    const selectedGrant = lineageGrant?.scope === "selected" ? lineageGrant : undefined;
    const grantFamilies = selectedGrant ? agentGrantToolFamilies(selectedGrant) : null;
    const runAccessMode = authority.agentConnection ? authority.mode : context.run.accessMode;
    // A selected lineage reads only the places its grant reaches, in every message it is sent.
    const scrub = async <Message extends { readonly content: readonly ContentPart[] }>(
      messages: readonly Message[],
    ): Promise<Message[]> =>
      selectedGrant
        ? Promise.all(
            messages.map(async (message) => ({
              ...message,
              content: (await grantedContent(
                this.#store.database,
                selectedGrant,
                message.content,
              )) as ContentPart[],
            })),
          )
        : [...messages];
    const sentHistory = await scrub(context.history);
    const sentInputs = await scrub(context.inputs);
    const sentReports = await scrub(context.reports.messages);
    const sentInitial = initialContext ? await scrub(initialContext.messages) : [];
    const planAccessMode = authority.agentConnection ? authority.mode : context.thread.accessMode;
    const binding = await this.#store
      .acquireExecutionBinding({
        personalContext: context.personalContext,
        personLineage: context.lineage.personLineage,
        bindingLeaseExpiresAt: new Date(this.#executionNow() + this.#executionLeaseMs),
        continuationIdentity: catalog.continuationIdentity,
        harnessInstanceId: context.run.harnessInstanceId,
        leaseTokenHash: createHash("sha256").update(randomBytes(32)).digest("base64url"),
        machineBootId: identity.machineBootId ?? null,
        runnerBootId: identity.bootId,
        runnerId: identity.runnerId,
        runId: context.run.id,
        threadId: context.thread.id,
      })
      .catch(async (error: unknown) => {
        if (error instanceof OpensteerError && error.reason === "earlier-boots-not-contained") {
          await this.#store.failCommand(
            command.id,
            error.message,
            "seed-input",
            "runner_restarted",
          );
          return undefined;
        }
        if (error instanceof OpensteerError && error.reason === "previous-stop-unconfirmed") {
          await this.#store.retryCommand(command.id, error);
          return undefined;
        }
        throw error;
      });
    if (!binding) return;
    const toolsToken = this.#runToolTokens.issue({
      bindingGeneration: binding.bindingGeneration,
      grantId: binding.grantId,
      environmentId: context.run.environmentId,
      requestedBy: command.requestedBy,
      runId: context.run.id,
      runnerBootId: identity.bootId,
      runnerId: identity.runnerId,
      threadId: context.thread.id,
    });
    const skillPolicy = await this.#skillPolicy(command.requestedBy);
    if (skillPolicy && !identity.capabilities.includes("settings-plugin-policy-v1")) {
      throw new CommandDispatchError("Update this Runner to enforce skill settings.", "failed");
    }
    const pinnedPlugins = (await this.#pluginVersions(command.requestedBy)).filter(
      (plugin) =>
        !selectedGrant ||
        agentGrantAccess(selectedGrant, {
          kind: "plugin",
          target: { kind: "installed", pluginId: plugin.pluginId },
        }) !== null,
    );
    const pluginsToken = this.#pluginsTokens.issue({
      pluginDigests: pinnedPlugins.map((plugin) => plugin.digest),
      bindingGeneration: binding.bindingGeneration,
      grantId: binding.grantId,
      environmentId: context.run.environmentId,
      requestedBy: command.requestedBy,
      runId: context.run.id,
      runnerBootId: identity.bootId,
      runnerId: identity.runnerId,
      threadId: context.thread.id,
    });
    const attachmentPlan = supportsAttachments
      ? {
          token: this.#attachmentRunTokens.issue({
            bindingGeneration: binding.bindingGeneration,
            grantId: binding.grantId,
            environmentId: context.run.environmentId,
            requestedBy: command.requestedBy,
            runId: context.run.id,
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
            threadId: context.thread.id,
          }),
        }
      : undefined;
    const threadState = await this.#store.loadRunThreadState({
      runId: context.run.id,
      viewerId: command.requestedBy,
    });
    const readsOrigin = identity.capabilities.includes("message-origin-v1");
    const settingsFile = context.personalContext
      ? (await this.#store.getAgentHomeSettings(context.run.requestedBy)).file
      : null;
    const browserGranted = !grantFamilies || grantFamilies.has("browser");
    const toolsPlan = agentToolsPlanForRun({
      capabilities: {
        tabs: context.personalContext && (browserGranted || grantFamilies!.has("tasks")),
        pages:
          context.personalContext &&
          browserGranted &&
          runHasBrowserPages(harness.driverKind, runAccessMode),
        computerUse:
          context.personalContext &&
          identity.modules.agents?.computerTool === 1 &&
          (!grantFamilies || grantFamilies.has("computer")),
        apps: context.personalContext && !selectedGrant,
      },
      ...(lineageGrant ? { grant: lineageGrant } : {}),
      settingsError: settingsFile?.error,
      voiceCall: Boolean(context.voiceCall),
      token: toolsToken,
      url: this.#agentToolsUrl,
      purpose: context.thread.purpose,
      personalContext: context.personalContext,
      accessMode: planAccessMode,
    });
    const maintenanceSnapshot = context.run.maintenance
      ? await this.#store.database
          .selectFrom("providerSessions")
          .select("contextSnapshot")
          .where("id", "=", context.run.maintenance.providerSessionId)
          .executeTakeFirst()
      : null;
    const maintenanceExpiresAt = maintenanceSnapshot?.contextSnapshot
      ? promptCacheExpiresAt(maintenanceSnapshot.contextSnapshot)
      : null;
    const runnerCommandFor = (machineAccess: MachineAccessRunContext): RunnerCommand => ({
      commandId: command.id,
      context: {
        ...(context.run.maintenance
          ? {
              maintenance: context.run.maintenance,
              ...(maintenanceExpiresAt === null ? {} : { maintenanceExpiresAt }),
            }
          : {}),
        ...(context.voiceCall
          ? {
              voiceCall: context.voiceCall,
            }
          : {}),
        accessMode: runAccessMode,
        taskPurpose: context.thread.purpose,
        personalContext: context.personalContext,
        // The person wrote their engine's settings for their own use; work a
        // connected agent or a chat started or wrote into never runs with them.
        // Decided where personal context is decided (`runContextLineage`).
        personLineage: context.lineage.personLineage,
        threadState,
        assignment: assignment
          ? {
              id: assignment.id,
              objective: assignment.objective,
              origin: assignment.origin,
              parentThreadId: assignment.parentThreadId,
            }
          : null,
        ...(attachmentPlan
          ? {
              attachments: attachmentPlan,
            }
          : {}),
        agentTools: toolsPlan,
        browserCdp: {
          url: this.#agentBrowserCdpUrl,
        },
        plugins: {
          ...(skillPolicy
            ? {
                skillPolicy,
              }
            : {}),
          versions: pinnedPlugins,
          token: pluginsToken,
          url: this.#pluginsUrl,
        },
        bindingGeneration: binding.bindingGeneration,
        // Half a token's life leaves the Runner room to retry before any expires.
        credentialRefreshAfterMs: (this.#runToolTokens.lifetimeSeconds * 1_000) / 2,
        executionLeaseMs: this.#executionLeaseMs,
        firstOrdinal: context.firstOrdinal,
        egress: this.#egress.issue({
          bindingGeneration: binding.bindingGeneration,
          grantId: binding.grantId,
          environmentId: context.run.environmentId,
          requestedBy: context.run.requestedBy,
          runId: context.run.id,
          runnerBootId: identity.bootId,
          runnerId: identity.runnerId,
          threadId: context.thread.id,
        }),
        environmentId: context.run.environmentId,
        harness: {
          config: harness.config,
          driverKind: harness.driverKind,
          name: harness.name,
          runtimeRevision: harness.runtimeRevision,
          sourceId: harness.sourceId,
          stateKind: harness.stateKind,
        },
        harnessInstanceId: context.run.harnessInstanceId,
        // Binding proves whether a native conversation exists. Unstarted
        // attempts remain in the UI, but are not a conversation to replay.
        history: binding.providerSessionReference && !initialContext ? sentHistory : [],
        historyWindow:
          binding.providerSessionReference && !initialContext
            ? context.historyWindow
            : {
                byteCount: 0,
                hasEarlier: false,
                itemCount: 0,
              },
        initialContext: initialContext
          ? {
              messages: sentInitial,
              omittedCount: initialContext.omittedCount,
              throughSequence:
                initialContext.throughSequence === null
                  ? null
                  : SequenceSchema.parse(initialContext.throughSequence),
            }
          : null,
        modelSelection,
        providerSessionId: binding.providerSessionId,
        providerSessionStateLayout: context.providerSessionStateLayout,
        providerSessionReference: binding.providerSessionReference,
        requestedBy: context.run.requestedBy,
        runId: context.run.id,
        threadId: context.thread.id,
        machineAccess,
      },
      correlationId: CorrelationIdSchema.parse(command.id),
      environmentId: context.run.environmentId,
      inputs: sentInputs.map((message) =>
        HarnessInputSchema.parse({
          author: message.author,
          content: message.content,
          createdAt: message.createdAt,
          kind: message.kind,
          messageId: message.id,
          ...(readsOrigin && context.inputOrigins.has(message.id)
            ? { origin: context.inputOrigins.get(message.id) }
            : {}),
          ...(message.quote
            ? {
                quote: message.quote,
              }
            : {}),
        }),
      ),
      reports: {
        messages: sentReports.map((message) =>
          HarnessInputSchema.parse({
            author: message.author,
            content: message.content,
            createdAt: message.createdAt,
            kind: message.kind,
            messageId: message.id,
          }),
        ),
        omittedCount: context.reports.omittedCount,
        throughSequence:
          context.reports.throughSequence === null
            ? null
            : SequenceSchema.parse(context.reports.throughSequence),
      },
      agentHome: context.agentHome,
      type: "run.execute",
    });
    // The reachable-computer list shares one size budget with the Thread
    // history this command already carries, so it is measured against the whole
    // command rather than against a constant of its own.
    const runnerCommand = runnerCommandFor(
      await computeMachineAccess({
        callerMachineName: identity.name,
        callerRunnerId: identity.runnerId,
        requestedBy: context.run.requestedBy,
        runners: this.#runners,
        serializedCommandBytes: (access) =>
          new TextEncoder().encode(JSON.stringify(runnerCommandFor(access))).byteLength,
        // Remote Devices have no selected resource kind, so a selected lineage reaches none.
        store: selectedGrant ? { listReachableMachines: async () => [] } : this.#store,
      }),
    );
    // The Runner measures the Run's first lease from when it receives the Run,
    // so the Host's starts now rather than when planning began; the first
    // heartbeat after admission replaces both with a grant both sides measure.
    await this.#store.renewActiveExecutionBindings({
      activeRunIds: [context.run.id],
      leaseExpiresAt: new Date(this.#executionNow() + this.#executionLeaseMs),
      runnerBootId: identity.bootId,
      runnerId: identity.runnerId,
    });
    if (signal.aborted)
      throw (
        signal.reason ??
        new OpensteerError({
          code: "internal",
          message: "Dispatch aborted",
        })
      );
    // The binding was established before capability planning.
    // Recheck it at the send itself, so a revocation that committed meanwhile,
    // a Stop included, cannot launch new work.
    const dispatch = {
      beforeSend: async () => {
        if (authority.agentConnection) {
          const connectionId = authority.agentConnection.agentConnectionId;
          try {
            await this.#assertPlannedAuthority(context.run, authority);
            await this.#store.recordConnectionRunHandoff({
              runId: context.run.id,
              bindingGeneration: binding.bindingGeneration,
              connectionId,
              grantRevision: authority.agentConnection.grantRevision,
              mode: authority.mode,
            });
          } catch (error) {
            // Paused while the Run was being prepared: held for the chat, as at the first check.
            if (connectionIsWaiting(error)) throw chatRunHeld();
            // Its message's sender stopped being "me" since the claim: it ends, and the chat
            // hears nothing (run-finalization reads this failure).
            if (error instanceof OpensteerError && error.message === senderUnlinkedFailure)
              throw new CommandDispatchError(senderUnlinkedFailure, "failed");
            throw error;
          }
        }
        await this.#store.assertActiveGrant({
          bindingGeneration: binding.bindingGeneration,
          grantId: binding.grantId,
          environmentId: context.run.environmentId,
          requestedBy: context.run.requestedBy,
          runId: context.run.id,
          runnerBootId: identity.bootId,
          runnerId: identity.runnerId,
          threadId: context.thread.id,
        });
      },
      ...(authority.agentConnection
        ? {
            onNotAdmitted: () =>
              this.#store.recordRunNotAdmitted(context.run.id, binding.bindingGeneration),
          }
        : {}),
      connectionGeneration: identity.connectionGeneration,
    };
    await this.#runners.dispatch(runnerCommand, signal, dispatch);
  }
  async #assertPlannedAuthority(
    run: { readonly id: RunId; readonly requestedBy: UserId },
    planned: Awaited<ReturnType<OpensteerStore["admitExecution"]>>,
  ): Promise<void> {
    const current = await this.#store.admitExecution({
      ownerUserId: run.requestedBy,
      subject: { kind: "binding", bindingId: `run:${run.id}` },
    });
    if (
      current.agentConnection?.grantRevision !== planned.agentConnection?.grantRevision ||
      current.mode !== planned.mode
    )
      throw new CommandDispatchError(
        "This connected agent's access changed while the Run was being prepared.",
        "retry",
      );
  }
  async #dispatchTrigger(command: CommandRow, signal: AbortSignal): Promise<void> {
    if (!command.environmentId) {
      throw new CommandDispatchError("Trigger command has no environment", "failed");
    }
    const identity = this.#runners.identityForEnvironment(command.environmentId);
    if (!identity) throw new CommandDispatchError("Runner is offline", "retry");
    // An automation of a paused chat or an anchor with an unconfirmed Stop is held, never failed:
    // only when the one read of its standing refused it for that, before anything is handed to the
    // Runner. A conflict, a missing row or a lineage without personal context fails as itself.
    // Once the send has passed, what happens is the Runner's, and an unknown end stays unknown.
    const heldIfWaiting = async <T>(step: () => Promise<T>): Promise<T> => {
      try {
        return await step();
      } catch (error) {
        if (triggerChatIsWaiting(error)) throw chatRunHeld();
        if (triggerAnchorStopIsHeld(error)) throw anchorStopHeld();
        throw error;
      }
    };
    const initial = await heldIfWaiting(() => this.#triggers.loadDispatchContext(command.id));
    if (!initial.script) {
      throw new CommandDispatchError(TRIGGER_SCRIPT_UPDATE_REASON, "failed");
    }
    const incompatibility = await automationScriptCompatibilityReason(
      this.#store,
      initial.anchorThread.environmentId,
    );
    if (incompatibility) throw new CommandDispatchError(incompatibility, "failed");
    const toolsFailure = runnerAgentToolsFailure(identity.capabilities);
    if (toolsFailure) throw new CommandDispatchError(toolsFailure, "failed");
    if (!identity.capabilities.includes("execution-plane-v2")) {
      throw new CommandDispatchError(
        "Update this Runner to the current execution protocol.",
        "failed",
      );
    }
    this.#dispatchingTriggers.set(initial.occurrence.id, {
      runnerBootId: identity.bootId,
      runnerId: identity.runnerId,
    });
    try {
      const { context, executionGeneration, connectionId } = await heldIfWaiting(() =>
        this.#triggers.startExecution({
          commandId: command.id,
          runnerBootId: identity.bootId,
          runnerId: identity.runnerId,
        }),
      );
      const notAdmitted = connectionId
        ? () =>
            this.#triggers.recordOccurrenceNotAdmitted(context.occurrence.id, executionGeneration)
        : undefined;
      this.#onTriggerChanged();
      const script = context.script;
      if (!script) {
        await notAdmitted?.();
        throw new CommandDispatchError(TRIGGER_SCRIPT_UPDATE_REASON, "failed");
      }
      const { capabilityToken, hasBrowser, secrets } = await (async () => {
        try {
          const capabilityToken = this.#triggerControlTokens.issue({
            environmentId: context.anchorThread.environmentId,
            executionGeneration,
            occurrenceId: context.occurrence.id,
            requestedBy: context.trigger.createdBy,
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
            threadId: context.anchorThread.id,
          });
          const [hasBrowser, secrets] = await Promise.all([
            this.#browser.hasBrowserProfiles(
              context.trigger.createdBy,
              `trigger:${context.occurrence.id}`,
            ),
            context.encryptedSecrets && this.#automationSecrets
              ? this.#automationSecrets.values(context.trigger.id, context.encryptedSecrets)
              : Promise.resolve<Readonly<Record<string, string>>>({}),
          ]);
          signal.throwIfAborted();
          return { capabilityToken, hasBrowser, secrets };
        } catch (error) {
          await notAdmitted?.();
          throw error;
        }
      })();
      const digest = createHash("sha256")
        .update(`trigger.execute:${command.id}:${executionGeneration}`)
        .digest("hex");
      const attemptCommandId = CommandIdSchema.parse(
        `cmd_${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
      );
      const runnerCommand: RunnerCommand = {
        commandId: attemptCommandId,
        context: {
          anchorThreadId: context.anchorThread.id,
          browserCdp: hasBrowser
            ? {
                token: capabilityToken,
                url: this.#browserCdpUrl,
              }
            : null,
          event: context.occurrence.event,
          executionGeneration,
          mcp: {
            token: capabilityToken,
            url: this.#agentToolsUrl,
          },
          occurrenceId: context.occurrence.id,
          revisionId: context.revision.id,
          script,
          ...(Object.keys(secrets).length > 0 ? { secrets: { ...secrets } } : {}),
          triggerId: context.trigger.id,
          ...(context.webhookBody
            ? { webhookBodyBase64: context.webhookBody.toString("base64") }
            : {}),
        },
        correlationId: CorrelationIdSchema.parse(attemptCommandId),
        environmentId: context.anchorThread.environmentId,
        agentHome: context.agentHome,
        type: "trigger.execute",
      };
      // Trigger setup can cross a stop transaction. Make the
      // running occurrence generation and its execution authority current at the
      // same boundary where the command leaves the Host.
      await this.#runners.dispatch(runnerCommand, signal, {
        connectionGeneration: identity.connectionGeneration,
        beforeAck: () =>
          this.#triggers.acceptExecution({
            commandId: command.id,
            executionGeneration,
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          }),
        // Held here, the Runner never had it: the registry records it not admitted, which undoes
        // the running stamp, and the coordinator returns it to pending.
        beforeSend: async () => {
          await heldIfWaiting(() =>
            this.#triggers.assertActiveExecutionBinding({
              environmentId: context.anchorThread.environmentId,
              executionGeneration,
              occurrenceId: context.occurrence.id,
              rejectHeldAnchor: true,
              requestedBy: context.trigger.createdBy,
              runnerBootId: identity.bootId,
              runnerId: identity.runnerId,
              threadId: context.anchorThread.id,
            }),
          );
        },
        // Z4: Stamp frame_sent_at at the point of no return inside RunnerRegistry.dispatch,
        // after every refusing check (offline, connection replaced, agents stopped, aborted).
        beforeWireSend: () => this.#store.markCommandFrameSent(command.id),
        ...(notAdmitted ? { onNotAdmitted: notAdmitted } : {}),
      });
    } finally {
      this.#dispatchingTriggers.delete(initial.occurrence.id);
    }
  }
  async #dispatchControl(command: CommandRow, signal: AbortSignal): Promise<void> {
    if (!command.environmentId)
      throw new CommandDispatchError("Control command has no environment", "failed");
    const payload = ControlPayloadSchema.safeParse(command.payload);
    if (!payload.success || payload.data.type !== command.type) {
      throw new CommandDispatchError("Stored control command is invalid", "failed");
    }
    const base = {
      commandId: command.id,
      correlationId: CorrelationIdSchema.parse(command.id),
      environmentId: command.environmentId,
    } as const;
    let runnerCommand: RunnerCommand;
    switch (payload.data.type) {
      case "node.stop": {
        const data = payload.data;
        await dispatchNodeStop(
          this.#store.database,
          {
            nodeId: data.nodeId,
            runId: data.runId,
            threadId: data.threadId,
            requestedBy: command.requestedBy,
            idempotencyKey: command.idempotencyKey,
            ...(data.authority
              ? {
                  authority: data.authority,
                }
              : {}),
          },
          data.bindingGeneration,
          command.id,
          (beforeAck) =>
            this.#runners.dispatch(
              {
                ...base,
                type: "node.stop",
                runId: data.runId,
                threadId: data.threadId,
                nodeId: data.nodeId,
                bindingGeneration: data.bindingGeneration,
              },
              signal,
              {
                beforeAck,
              },
            ),
        );
        return;
      }
      case "run.interrupt":
        runnerCommand = {
          ...base,
          ...(payload.data.stop &&
          this.#runners
            .identityForEnvironment(command.environmentId)
            ?.capabilities.includes(attemptStopStateCapability)
            ? { stop: payload.data.stop }
            : {}),
          ...(payload.data.expectedBindingGeneration
            ? { bindingGeneration: payload.data.expectedBindingGeneration }
            : {}),
          runId: payload.data.runId,
          threadId: payload.data.threadId,
          type: "run.interrupt",
        };
        break;
      // A restart first stops exactly the attempt it replaces; the Host
      // dispatches the next attempt once that one's end is committed.
      case "run.restart":
        runnerCommand = {
          ...base,
          bindingGeneration: payload.data.bindingGeneration,
          runId: payload.data.runId,
          threadId: payload.data.threadId,
          type: "run.interrupt",
        };
        break;
      case "request.respond":
        if (!command.encryptedRequestResponse || command.requestResponseKeyVersion === null) {
          throw new CommandDispatchError("Request response envelope is missing", "failed");
        }
        {
          const responsePayload = payload.data;
          const encryptedResponse = command.encryptedRequestResponse;
          await this.#store.dispatchRequestResponse(
            command.id,
            async (beforeAck, fenceRequestSend, bindingGeneration) => {
              const identity = this.#runners.identityForEnvironment(base.environmentId);
              if (!identity) throw new CommandDispatchError("Runner is offline", "retry");
              const runnerCommand: RunnerCommand = {
                ...base,
                bindingGeneration,
                requestId: responsePayload.requestId,
                response: await openRequestResponse(this.#requestResponseVault, encryptedResponse, {
                  requestId: responsePayload.requestId,
                  runId: responsePayload.runId,
                  threadId: responsePayload.threadId,
                }),
                runId: responsePayload.runId,
                type: "request.resolve",
              };
              await this.#runners.dispatch(runnerCommand, signal, {
                beforeAck,
                fenceRequestSend,
                connectionGeneration: identity.connectionGeneration,
              });
            },
          );
          return;
        }
      case "run.steer": {
        const steer = await this.#store.loadSteerDispatchInput(command.id);
        runnerCommand = {
          ...base,
          input: HarnessInputSchema.parse({
            author: steer.message.author,
            content: steer.message.content,
            createdAt: steer.message.createdAt,
            kind: steer.message.kind,
            messageId: steer.message.id,
            ...(steer.origin &&
            this.#runners
              .identityForEnvironment(steer.run.environmentId)
              ?.capabilities.includes("message-origin-v1")
              ? { origin: steer.origin }
              : {}),
            ...(steer.message.quote
              ? {
                  quote: steer.message.quote,
                }
              : {}),
          }),
          runId: steer.runId,
          threadId: steer.threadId,
          type: "run.steer",
        };
        await this.#dispatchSteer(
          command,
          runnerCommand,
          signal,
          async () => {
            if (!steer.message.content.some((part) => part.type !== "text")) return;
            const harness = await this.#store.getHarnessInstance(steer.run.harnessInstanceId);
            if (!harness?.enabled || harness.environmentId !== steer.run.environmentId) {
              throw new CommandDispatchError(
                "The active AI engine is no longer available.",
                "failed",
              );
            }
            const failure = this.#runners.attachmentInputFailure({
              content: steer.message.content,
              driverKind: harness.driverKind,
              environmentId: steer.run.environmentId,
              harnessInstanceId: steer.run.harnessInstanceId,
              modelSelection: steer.run.modelSelection,
              steering: true,
            });
            if (failure) throw new CommandDispatchError(failure, "failed");
          },
          steer.reauthorize,
        );
        return;
      }
    }
    await this.#runners.dispatch(runnerCommand, signal);
    await this.#store.succeedCommand(command.id);
  }

  /**
   * A proven refusal restores a promoted message's original queued intent;
   * strict steers are cancelled. Ambiguous delivery never schedules a replay.
   */
  async #dispatchSteer(
    command: CommandRow,
    runnerCommand: Extract<
      RunnerCommand,
      {
        readonly type: "run.steer";
      }
    >,
    signal: AbortSignal,
    validate: () => Promise<void>,
    reauthorize?: () => Promise<void>,
  ): Promise<void> {
    try {
      await validate();
      const beforeSend =
        reauthorize &&
        (async () => {
          try {
            await reauthorize();
          } catch (error) {
            if (!(error instanceof OpensteerError) || error.code !== "forbidden") throw error;
            throw new CommandDispatchError(error.message, "failed");
          }
        });
      await this.#runners.dispatch(runnerCommand, signal, beforeSend ? { beforeSend } : undefined);
    } catch (error) {
      if (!(error instanceof CommandDispatchError) || error.disposition !== "failed") throw error;
      await this.#store.refuseSteer(
        command.id,
        error.message,
        ProtocolErrorSchema.safeParse(error.cause).data?.reason,
      );
      return;
    }
    await this.#store.succeedCommand(command.id);
  }
}

/** A Run of a paused chat waits for the chat: no failure, no error, no timer; its resume wakes it. */
function chatRunHeld(): CommandDispatchError {
  return new CommandDispatchError("Its chat is paused; this waits until it is back.", "held");
}

/** An automation whose anchor has an unconfirmed Stop stays held until proof clears the hold. */
function anchorStopHeld(): CommandDispatchError {
  return new CommandDispatchError(
    "Stopping could not be confirmed. Automation is held while something from the previous Run may still be running on that device.",
    "held",
    { provenNotStarted: true },
  );
}
