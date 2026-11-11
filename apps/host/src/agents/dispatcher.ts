import { hydrateTeamTaskInput } from "@opensteer/database";
import type { FolderAdmissionService } from "../threads/folder-admission-service.js";
import { dispatchNodeStop, NodeStopAuthoritySchema } from "@opensteer/database";
import { agentToolsPlanForRun } from "./agent-tools-plan.js";
import { SpecialistStore } from "@opensteer/database";
import {
  ModelSelectionSchema,
  OpensteerError,
  placeInputFailure,
  runnerAgentToolsFailure,
  RequestIdSchema,
  RequestResponseSchema,
  RunIdSchema,
  ExecutionNodeIdSchema,
  SequenceSchema,
  ThreadIdSchema,
  type AgentEvent,
  type EnvironmentId,
  type ThreadId,
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
import type { PluginPackagesTokenService } from "../integrations/plugin-package-service.js";
import type { EgressService } from "../server/egress-service.js";
import { computeMachineAccess } from "../shell/machine-access-run-context.js";
import type { TriggerControlTokenService } from "../triggers/trigger-control-service.js";
import { triggerProgramCompatibilityReason } from "../triggers/trigger-program-compatibility.js";
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
export type TeamRequestContextLoader = (
  input: {
    readonly runId: import("@opensteer/core").RunId;
    readonly requestId: import("@opensteer/core").TeamAgentRequestId;
  },
  signal: AbortSignal,
) => Promise<{
  readonly ownerDisplayName: string;
  readonly instructionsMarkdown: string;
  readonly source: import("@opensteer/core").TeamSource;
  readonly content: readonly import("@opensteer/core").ContentPart[];
}>;
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
  readonly #onDeploymentEvent: (event: AgentEvent) => void;
  readonly #onTriggerChanged: () => void;
  readonly #runners: RunnerRegistry;
  readonly #runnerRegistrationPending: (environmentId: EnvironmentId) => boolean;
  readonly #onRunAdmitted: (threadId: ThreadId) => void;
  readonly #executionLeaseMs: number;
  readonly #executionNow: () => number;
  readonly #store: OpensteerStore;
  readonly #catalogs: HarnessCatalogRecorder;
  readonly #triggerControlTokens: TriggerControlTokenService;
  readonly #triggers: TriggerStore;
  readonly #teamRequestContext: TeamRequestContextLoader;
  readonly #folders: Pick<FolderAdmissionService, "assertAvailable">;
  constructor(options: {
    readonly attachmentRunTokens: RunCapabilityTokenService<"opensteer-run-attachments">;
    readonly attachments: Pick<AttachmentStore, "listForRun">;
    readonly requestResponseVault: RequestResponseVault;
    readonly runToolTokens: RunToolTokenService;
    readonly browser: Pick<BrowserService, "hasBrowserProfiles">;
    readonly onDeploymentEvent: (event: AgentEvent) => void;
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
    readonly triggerControlTokens: TriggerControlTokenService;
    readonly triggers: TriggerStore;
    readonly teamRequestContext: TeamRequestContextLoader;
    readonly folders: Pick<FolderAdmissionService, "assertAvailable">;
  }) {
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
    this.#onDeploymentEvent = options.onDeploymentEvent;
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
    this.#folders = options.folders;
    this.#teamRequestContext = options.teamRequestContext;
  }
  isAvailable(command: PendingCommandRow, dispatchingRuns: number): boolean {
    if (!supportedCommandTypes.has(command.type) || command.environmentId === null) return false;
    // A Runner too old to attach never will; dispatching still tells new work
    // to update rather than leaving it queued.
    if (command.type === "run.execute" || command.type === "trigger.execute") {
      const identity = this.#runners.identityForEnvironment(command.environmentId);
      if (identity && !identity.capabilities.includes("execution-plane-v2")) return true;
    }
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
    return this.#runners.hasRunCapacity(command.environmentId, dispatchingRuns);
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
    let context = await this.#store.loadRunDispatchContext(command.id);
    let teamContext: Awaited<ReturnType<TeamRequestContextLoader>> | undefined;
    if (context.run.teamRequestId) {
      const input = { runId: context.run.id, requestId: context.run.teamRequestId };
      teamContext = await this.#teamRequestContext(input, signal);
      const hydrated = await hydrateTeamTaskInput(this.#store.database, {
        ...input,
        ...teamContext,
      });
      for (const event of hydrated.events) this.#onDeploymentEvent(event);
      context = await this.#store.loadRunDispatchContext(command.id);
    }
    this.#onRunAdmitted(context.thread.id);
    if (context.thread.specialistId) {
      try {
        await new SpecialistStore(this.#store.database).assertRunnable(
          context.thread.specialistId,
          context.run.requestedBy,
        );
      } catch (error) {
        throw new CommandDispatchError(
          error instanceof Error ? error.message : "Specialist is unavailable",
          "failed",
        );
      }
    }
    const assignment = context.run.assignmentId
      ? await this.#store.getAssignment(context.run.assignmentId)
      : null;
    if (context.run.assignmentId && (!assignment || assignment.status !== "open")) {
      throw new CommandDispatchError("This task assignment is no longer open.", "failed");
    }
    await this.#folders.assertAvailable(context.location.folder);
    const harness = await this.#store.getHarnessInstance(context.run.harnessInstanceId);
    if (!harness?.enabled || harness.environmentId !== command.environmentId) {
      throw new CommandDispatchError("The selected AI engine is no longer available.", "failed");
    }
    // Read after the awaits above, so a Runner that left meanwhile is waited
    // for rather than taken for one that cannot run this engine.
    const identity = this.#runners.identityForEnvironment(command.environmentId);
    if (!identity) throw new CommandDispatchError("Runner is offline", "retry");
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
    if (!identity.capabilities.includes("requester-time-zone-v1")) {
      throw new CommandDispatchError(
        "Update this Runner so agents know the person's time zone.",
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
    const binding = await this.#store
      .acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(this.#executionNow() + this.#executionLeaseMs),
        continuationIdentity: catalog.continuationIdentity,
        harnessInstanceId: context.run.harnessInstanceId,
        leaseTokenHash: createHash("sha256").update(randomBytes(32)).digest("base64url"),
        runnerBootId: identity.bootId,
        runnerId: identity.runnerId,
        runId: context.run.id,
        threadId: context.thread.id,
      })
      .catch(async (error: unknown) => {
        if (!(error instanceof OpensteerError) || error.reason !== "earlier-boots-not-contained")
          throw error;
        for (const event of await this.#store.failCommand(
          command.id,
          error.message,
          "seed-input",
          "runner_restarted",
        ))
          this.#onDeploymentEvent(event);
        return undefined;
      });
    if (!binding) return;
    if (binding.continuationEvent) this.#onDeploymentEvent(binding.continuationEvent);
    const toolsToken = this.#runToolTokens.issue({
      bindingGeneration: binding.bindingGeneration,
      grantId: binding.grantId,
      ...(context.thread.specialistId
        ? {
            specialistId: context.thread.specialistId,
          }
        : {}),
      environmentId: context.run.environmentId,
      requestedBy: command.requestedBy,
      runId: context.run.id,
      runnerBootId: identity.bootId,
      runnerId: identity.runnerId,
      threadId: context.thread.id,
    });
    const specialist = context.thread.specialistId
      ? await this.#store.database
          .selectFrom("specialists")
          .innerJoin("pluginVersions", "pluginVersions.id", "specialists.pluginVersionId")
          .innerJoin("plugins", "plugins.id", "specialists.pluginId")
          .select(["plugins.id as pluginId", "plugins.name", "pluginVersions.digest"])
          .where("specialists.removedAt", "is", null)
          .where("specialists.id", "=", context.thread.specialistId)
          .executeTakeFirst()
      : null;
    if (context.thread.specialistId && !specialist)
      throw new Error("Specialist registration was removed");
    const skillPolicy = await this.#skillPolicy(command.requestedBy);
    if (skillPolicy && !identity.capabilities.includes("settings-plugin-policy-v1")) {
      throw new CommandDispatchError("Update this Runner to enforce skill settings.", "failed");
    }
    const pinnedPlugins = specialist
      ? [specialist]
      : await this.#pluginVersions(command.requestedBy);
    const pluginsToken = this.#pluginsTokens.issue({
      pluginDigests: pinnedPlugins.map((plugin) => plugin.digest),
      bindingGeneration: binding.bindingGeneration,
      grantId: binding.grantId,
      ...(context.thread.specialistId
        ? {
            specialistId: context.thread.specialistId,
          }
        : {}),
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
            ...(context.thread.specialistId
              ? {
                  specialistId: context.thread.specialistId,
                }
              : {}),
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
    const requesterTimeZone = await this.#store.notificationState.timeZoneFor(
      context.run.requestedBy,
    );
    const runnerCommandFor = (machineAccess: MachineAccessRunContext): RunnerCommand => ({
      commandId: command.id,
      context: {
        ...(context.voiceCall
          ? {
              voiceCall: context.voiceCall,
            }
          : {}),
        accessMode: context.run.accessMode,
        taskPurpose: context.thread.purpose,
        personalContext: context.personalContext,
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
        agentTools: agentToolsPlanForRun({
          voiceCall: Boolean(context.voiceCall),
          token: toolsToken,
          url: this.#agentToolsUrl,
          purpose: context.thread.purpose,
          teamBound: context.thread.teamOrigin !== null,
          ...(teamContext ? { teamContext } : {}),
          accessMode: context.thread.accessMode,
        }),
        browserCdp: {
          url: this.#agentBrowserCdpUrl,
        },
        ...(context.thread.specialistId
          ? {
              specialistId: context.thread.specialistId,
            }
          : {}),
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
        history: binding.providerSessionReference && !initialContext ? [...context.history] : [],
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
              messages: [...initialContext.messages],
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
        requesterTimeZone,
        runId: context.run.id,
        threadId: context.thread.id,
        machineAccess,
      },
      correlationId: CorrelationIdSchema.parse(command.id),
      environmentId: context.run.environmentId,
      inputs: context.inputs.map((message) =>
        HarnessInputSchema.parse({
          author: message.author,
          content: message.content,
          createdAt: message.createdAt,
          kind: message.kind,
          messageId: message.id,
          ...(message.quote
            ? {
                quote: message.quote,
              }
            : {}),
        }),
      ),
      reports: {
        messages: context.reports.messages.map((message) =>
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
      location: context.location,
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
        store: this.#store,
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
      beforeSend: () =>
        this.#store.assertActiveGrant({
          bindingGeneration: binding.bindingGeneration,
          grantId: binding.grantId,
          environmentId: context.run.environmentId,
          requestedBy: context.run.requestedBy,
          runId: context.run.id,
          runnerBootId: identity.bootId,
          runnerId: identity.runnerId,
          threadId: context.thread.id,
        }),
      connectionGeneration: identity.connectionGeneration,
    };
    if (command.authoritySource.kind === "channel-ingress") {
      for (const event of await this.#store.dispatchChannelCommand(
        command.id,
        async (beforeAck) => {
          await this.#runners.dispatch(runnerCommand, signal, {
            ...dispatch,
            beforeAck,
          });
        },
      )) {
        this.#onDeploymentEvent(event);
      }
    } else {
      await this.#runners.dispatch(runnerCommand, signal, dispatch);
    }
  }
  async #dispatchTrigger(command: CommandRow, signal: AbortSignal): Promise<void> {
    if (!command.environmentId) {
      throw new CommandDispatchError("Trigger command has no environment", "failed");
    }
    const identity = this.#runners.identityForEnvironment(command.environmentId);
    if (!identity) throw new CommandDispatchError("Runner is offline", "retry");
    const initial = await this.#triggers.loadDispatchContext(command.id);
    const incompatibility = await triggerProgramCompatibilityReason(
      this.#store,
      initial.anchorThread.environmentId,
      initial.revision.program.toolContractVersion,
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
    await this.#folders.assertAvailable(initial.location.folder);
    const { context, executionGeneration } = await this.#triggers.startExecution({
      commandId: command.id,
      runnerBootId: identity.bootId,
      runnerId: identity.runnerId,
    });
    this.#onTriggerChanged();
    const capabilityToken = this.#triggerControlTokens.issue({
      environmentId: context.anchorThread.environmentId,
      executionGeneration,
      occurrenceId: context.occurrence.id,
      requestedBy: context.trigger.createdBy,
      runnerBootId: identity.bootId,
      runnerId: identity.runnerId,
      threadId: context.anchorThread.id,
      toolContractVersion: context.revision.program.toolContractVersion,
    });
    const hasBrowser = await this.#browser.hasBrowserProfiles(context.trigger.createdBy);
    const runnerCommand: RunnerCommand = {
      commandId: command.id,
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
        program: context.revision.program,
        revisionId: context.revision.id,
        triggerId: context.trigger.id,
      },
      correlationId: CorrelationIdSchema.parse(command.id),
      environmentId: context.anchorThread.environmentId,
      location: context.location,
      type: "trigger.execute",
    };
    // Trigger setup can cross a stop transaction. Make the
    // running occurrence generation and its execution authority current at the
    // same boundary where the command leaves the Host.
    await this.#triggers.assertActiveExecutionBinding({
      environmentId: context.anchorThread.environmentId,
      executionGeneration,
      occurrenceId: context.occurrence.id,
      requestedBy: context.trigger.createdBy,
      runnerBootId: identity.bootId,
      runnerId: identity.runnerId,
      threadId: context.anchorThread.id,
    });
    if (signal.aborted) {
      throw (
        signal.reason ??
        new OpensteerError({
          code: "internal",
          message: "Dispatch aborted",
        })
      );
    }
    await this.#runners.dispatch(runnerCommand, signal);
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
          for (const event of await this.#store.dispatchRequestResponse(
            command.id,
            async (beforeAck) => {
              const runnerCommand: RunnerCommand = {
                ...base,
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
              });
            },
          )) {
            this.#onDeploymentEvent(event);
          }
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
        await this.#dispatchSteer(command, runnerCommand, signal, async () => {
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
        });
        return;
      }
    }
    await this.#runners.dispatch(runnerCommand, signal);
    for (const event of await this.#store.succeedCommand(command.id)) {
      this.#onDeploymentEvent(event);
    }
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
  ): Promise<void> {
    try {
      await validate();
      if (command.authoritySource.kind === "channel-ingress") {
        for (const event of await this.#store.dispatchChannelCommand(
          command.id,
          async (beforeAck) => {
            await this.#runners.dispatch(runnerCommand, signal, {
              beforeAck,
            });
          },
        )) {
          this.#onDeploymentEvent(event);
        }
        return;
      }
      await this.#runners.dispatch(runnerCommand, signal);
    } catch (error) {
      if (!(error instanceof CommandDispatchError) || error.disposition !== "failed") throw error;
      for (const event of await this.#store.refuseSteer(
        command.id,
        error.message,
        ProtocolErrorSchema.safeParse(error.cause).data?.reason,
      )) {
        this.#onDeploymentEvent(event);
      }
      return;
    }
    for (const event of await this.#store.succeedCommand(command.id)) {
      this.#onDeploymentEvent(event);
    }
  }
}
