import { createUuidV7Mint } from "@muse-code/sdk";
import {
  attachmentImageMaxPixels,
  attachmentMaxBytes,
  attachmentNativeImageMediaTypes,
  HarnessIdSchema,
  OpensteerError,
  RequestFormAnswersSchema,
  createId,
  harnessCatalogEntry,
  harnessUsageLimitFailureCode,
  normalizeToolOutput,
  type HarnessInstanceId,
  type PendingRequest,
  type RequestId,
  type RequestResponse,
  type RunUsage,
  type ThreadAccessMode,
  type UserId,
} from "@opensteer/core";
import {
  Deferred,
  HarnessSessionRegistry,
  SubagentNodes,
  TurnPublisher,
  assertFreshProviderSessionContext,
  boundedDenialNote,
  collectStreamText,
  durableHistoryWindowNotice,
  initialContinuationContextPrompt,
  meetsMinimumVersion,
  profileHarnessProviderStoreScope,
  providerSecretFile,
  readVerifiedAttachmentBytes,
  renderHarnessSkillCatalog,
  resolvedInputParts,
  resolvedInputSequence,
  runEndedEvent,
  runFailedEvent,
  runStartedEvent,
  secretInputAuthentication,
  spawnSupervised,
  toHarnessError,
  withTitleDirectory,
  harnessTurnPreamble,
  type HarnessAdapter,
  type HarnessAuthenticationContext,
  type HarnessAuthenticationSelection,
  type HarnessAuthenticationStart,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessDriverCreateContext,
  type HarnessEvent,
  type HarnessInspectionContext,
  type HarnessInspectionResult,
  type HarnessLogoutSelection,
  type HarnessObservedUsage,
  type HarnessRunInput,
  type HarnessSession,
  type HarnessSessionContext,
  type HarnessSourceDescriptor,
  type HarnessSteerInput,
  type HarnessTitleInput,
  type ResolvedAttachment,
  type SupervisedProcess,
} from "@opensteer/harness";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { copyFile, mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MuseHarnessConfigSchema, type MuseHarnessConfig } from "./config.js";
import { museModelDescriptors, museSelectedEffort } from "./model-catalog.js";
import {
  MuseHost,
  MuseItemDeltaSchema,
  MuseItemEventSchema,
  MuseSessionTokenUsageSchema,
  isMuseMspError,
  parseMuseApprovalDecide,
  parseMuseApprovalRequest,
  parseMuseItem,
  parseMuseModelList,
  parseMuseSessionResume,
  parseMuseSessionStart,
  parseMuseSetApprovalMode,
  parseMuseSubscriptionUsage,
  parseMuseTurnCompleted,
  parseMuseTurnStart,
  parseMuseTurnSteer,
  parseMuseUserInputRequest,
  type ApprovalRequestParams,
  type Item,
  type SubscriptionUsage,
  type TurnInputPart,
  type UserInputRequestParams,
} from "./protocol.js";

const museSourceId = "meta";
const museDeviceMethodId = "muse-subscription";
const museApiKeyMethodId = "muse-api-key";
const museApiKeyFileName = ".opensteer-meta-api-key";
const mintUuid = createUuidV7Mint();
const nativeUserOnlyDetail = "Muse Code runs only on a computer you own.";

const museSources = [
  {
    detail: "Meta models through Muse Code, using a subscription or Meta API key.",
    fields: [],
    kind: "first-party",
    label: "Meta",
    modelSettings: true,
    quota: "windows",
    sourceId: museSourceId,
    stateKinds: ["ambient", "isolated"],
  },
] as const satisfies readonly HarnessSourceDescriptor[];

const museCapabilities: HarnessCapabilities = Object.freeze({
  approvals: true,
  attachments: true,
  messageAttachments: {
    nativeImages: {
      maxBytes: attachmentMaxBytes,
      maxPixels: attachmentImageMaxPixels,
      mediaTypes: attachmentNativeImageMediaTypes,
      steering: true,
    },
  },
  interruption: true,
  mcpImageContent: true,
  resume: true,
  steering: true,
  toolCalls: true,
  userInput: true,
});

const setupMethods = [
  {
    connectionSlot: "primary",
    detail: "Approve Muse Code's device code in a browser.",
    kind: "device-code",
    label: "Muse Code subscription",
    methodId: museDeviceMethodId,
  },
  {
    connectionSlot: "primary",
    detail: "Store a Meta API key in this profile's private Muse Code home.",
    inputLabel: "Meta API key",
    inputPlaceholder: "META_API_KEY",
    kind: "secret-input",
    label: "Meta API key",
    methodId: museApiKeyMethodId,
  },
] as const;

export interface MuseHarnessDependencies {
  readonly executable: string;
  /** Arguments before the Muse subcommand; fake protocol processes use this seam. */
  readonly arguments?: readonly string[];
}

export class MuseHarnessDriver implements HarnessDriver {
  readonly kind = HarnessIdSchema.parse("muse");
  readonly sources = museSources;
  readonly accessModes = [
    "approval-required",
    "full-access",
  ] as const satisfies readonly ThreadAccessMode[];
  readonly capabilities = museCapabilities;
  readonly configSchema = MuseHarnessConfigSchema;
  readonly environmentVariables = [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "MUSE_PROJECTS_HOME",
  ] as const;
  readonly providerStoreScope = profileHarnessProviderStoreScope;
  readonly #dependencies: MuseHarnessDependencies;

  constructor(dependencies: MuseHarnessDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(context: HarnessInspectionContext): Promise<HarnessInspectionResult> {
    const config = MuseHarnessConfigSchema.parse(context.config);
    if (context.runtimeBoundary.kind !== "native-user") {
      return { detail: nativeUserOnlyDetail, status: "unavailable" };
    }
    if (context.sourceId !== museSourceId) {
      return {
        detail: `Muse Code does not offer the source ${context.sourceId}`,
        status: "unavailable",
      };
    }
    const runtime = harnessCatalogEntry("muse")?.runtime;
    if (!runtime || runtime.shape !== "installed")
      throw new Error("Muse Code catalog runtime is invalid");
    const environment = await museEnvironment(context.environment, context.providerState);
    let version: string;
    try {
      version = (await this.#run(context, environment, ["--version"], config.commandTimeoutMs))
        .stdout;
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT" || String(error).includes("not on the PATH")) {
        return {
          detail: `Muse Code is not installed. Install it from ${runtime.installUrl}`,
          status: "unavailable",
        };
      }
      throw error;
    }
    if (
      !meetsMinimumVersion(
        version.replace(/^Muse Code\s+/u, "").split(/\s+/u)[0] ?? "",
        runtime.minimumVersion,
      )
    ) {
      return {
        detail: `Muse Code ${version.trim() || "unknown"} is installed; Opensteer needs ${runtime.minimumVersion} or newer`,
        status: "unavailable",
      };
    }
    const key = await museApiKey(context.providerState);
    let usage: SubscriptionUsage | undefined;
    if (!key) {
      const checked = await this.#run(
        context,
        environment,
        ["usage", "--json"],
        config.commandTimeoutMs,
        true,
      );
      if (checked.exitCode !== 0) {
        if (/not logged in|not authenticated/iu.test(checked.stderr)) {
          return museAuthenticationRequired(context.providerState);
        }
        return { detail: "Muse Code could not check its sign-in", status: "unavailable" };
      }
      try {
        usage = parseMuseSubscriptionUsage(JSON.parse(checked.stdout) as unknown);
      } catch {
        return { detail: "Muse Code returned an invalid usage response", status: "unavailable" };
      }
    }
    let host: MuseHost | undefined;
    try {
      host = await MuseHost.open({
        args: [
          ...(this.#dependencies.arguments ?? []),
          "serve",
          "--disable-shell",
          "--disable-write",
          "--no-session-log",
        ],
        cwd: context.workingDirectory,
        environment,
        executable: this.#dependencies.executable,
        onNotification: () => undefined,
        onProtocolError: () => undefined,
        onServerRequest: async () => ({}),
        requestedCapabilities: [],
        signal: context.signal,
        startupTimeoutMs: config.startupTimeoutMs,
        wrapProcessLaunch: identityLaunch,
      });
      const models = museModelDescriptors(parseMuseModelList(await host.request("model/list", {})));
      if (models.length === 0) {
        return {
          detail: "Muse Code did not report any models available to this account",
          status: "unavailable",
        };
      }
      const observed = usage ? observedUsage(usage) : undefined;
      return {
        connections: [
          {
            authKind: key ? "api-key" : "subscription",
            connectionSlot: "primary",
            label: "Muse Code",
            logoutSupported: true,
            status: "connected",
            ...(observed ? { usage: observed } : {}),
            ...(usage?.tier ? { billingLabel: safeLabel(usage.tier) } : {}),
          },
        ],
        detail: "Muse Code is ready",
        models,
        setupMethods: museSetupMethods(context.providerState),
        status: "ready",
      };
    } finally {
      await host?.close();
    }
  }

  async authenticate(
    context: HarnessAuthenticationContext,
    selection: HarnessAuthenticationSelection,
  ): Promise<HarnessAuthenticationStart> {
    assertNativeUser(context.runtimeBoundary.kind);
    MuseHarnessConfigSchema.parse(context.config);
    assertSelection(selection.connectionSlot);
    if (selection.methodId === museApiKeyMethodId) {
      if (context.providerState.kind !== "isolated") {
        throw new OpensteerError({
          code: "bad_request",
          message: "Add a private Muse Code profile to store a Meta API key",
        });
      }
      return secretInputAuthentication({
        cancelledDetail: "The Meta API key was not entered",
        engineLabel: "Muse Code",
        inputLabel: "Meta API key",
        maximumLength: 16_384,
        requiredMessage: "Meta API key is required",
        signal: context.signal,
        store: (secret) => museApiKeyFile(context.providerState).write(secret),
        storeFailedDetail: "The Meta API key could not be stored",
      });
    }
    if (selection.methodId !== museDeviceMethodId) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown Muse Code setup method" });
    }
    return this.#deviceAuthentication(context);
  }

  async logout(
    context: HarnessAuthenticationContext,
    selection: HarnessLogoutSelection = {},
  ): Promise<void> {
    assertNativeUser(context.runtimeBoundary.kind);
    assertSelection(selection.connectionSlot);
    const key = await museApiKey(context.providerState);
    if (key && context.providerState.kind === "isolated") {
      await museApiKeyFile(context.providerState).remove();
      return;
    }
    const environment = await museEnvironment(context.environment, context.providerState);
    const result = await this.#run(context, environment, ["logout"], 30_000, true);
    if (result.exitCode !== 0)
      throw new OpensteerError({ code: "harness_error", message: "Muse Code could not sign out" });
  }

  async removeProfile(context: HarnessAuthenticationContext): Promise<void> {
    assertNativeUser(context.runtimeBoundary.kind);
    if (context.providerState.kind !== "isolated") return;
    await museApiKeyFile(context.providerState).remove();
    const home = context.providerState.providerHomeDirectory;
    if (home) await rm(join(home, "config", "muse", "auth.json"), { force: true });
  }

  async create(context: HarnessDriverCreateContext): Promise<HarnessAdapter> {
    if (context.sourceId !== museSourceId) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown Muse Code source" });
    }
    return new MuseHarnessAdapter(
      context.instanceId,
      MuseHarnessConfigSchema.parse(context.config),
      this.#dependencies,
    );
  }

  async #deviceAuthentication(
    context: HarnessAuthenticationContext,
  ): Promise<HarnessAuthenticationStart> {
    const environment = await museEnvironment(context.environment, context.providerState);
    const process = spawnSupervised({
      args: [...(this.#dependencies.arguments ?? []), "login"],
      cwd: context.workingDirectory,
      environment,
      executable: this.#dependencies.executable,
      maxOutputBytes: 64 * 1_024,
      signal: context.signal,
    });
    const challenge = await waitForDeviceCode(process, context.signal);
    const result = process.exited.then((exit) =>
      exit.code === 0
        ? ({ status: "ready" } as const)
        : ({ detail: "Muse Code sign-in was canceled or failed", status: "failed" } as const),
    );
    return {
      cancel: async () => process.terminate(0),
      challenge,
      result,
      status: "pending",
    };
  }

  async #run(
    context: HarnessInspectionContext,
    environment: Readonly<Record<string, string>>,
    args: readonly string[],
    timeoutMs: number,
    allowFailure = false,
  ): Promise<{
    readonly exitCode: number | null;
    readonly stderr: string;
    readonly stdout: string;
  }> {
    const lifetime = new AbortController();
    const process = spawnSupervised({
      args: [...(this.#dependencies.arguments ?? []), ...args],
      cwd: context.workingDirectory,
      environment,
      executable: this.#dependencies.executable,
      maxOutputBytes: 256 * 1_024,
      signal: AbortSignal.any([lifetime.signal, context.signal]),
    });
    const timer = setTimeout(() => lifetime.abort(), timeoutMs);
    timer.unref?.();
    const [stdout, stderr, exit] = await Promise.all([
      collectStreamText(process.stdout),
      collectStreamText(process.stderr),
      process.exited,
    ]).finally(() => clearTimeout(timer));
    if (!allowFailure && exit.code !== 0) {
      throw new OpensteerError({ code: "harness_error", message: "Muse Code command failed" });
    }
    return { exitCode: exit.code, stderr, stdout };
  }
}

class MuseHarnessAdapter implements HarnessAdapter {
  readonly capabilities = museCapabilities;
  readonly instanceId: HarnessInstanceId;
  readonly #config: MuseHarnessConfig;
  readonly #dependencies: MuseHarnessDependencies;
  readonly #sessions = new HarnessSessionRegistry<MuseHarnessSession>("Muse Code");

  constructor(
    instanceId: HarnessInstanceId,
    config: MuseHarnessConfig,
    dependencies: MuseHarnessDependencies,
  ) {
    this.instanceId = instanceId;
    this.#config = config;
    this.#dependencies = dependencies;
  }

  async startSession(context: HarnessSessionContext): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    assertNativeSession(context);
    assertFreshProviderSessionContext(context);
    const reference = mintUuid();
    return this.#sessions.open(reference, () => this.#open(reference, context, false));
  }

  async resumeSession(reference: string, context: HarnessSessionContext): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    assertNativeSession(context);
    if (!/^[0-9a-f-]{36}$/iu.test(reference)) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Invalid Muse Code session reference",
      });
    }
    return this.#sessions.open(reference, () => this.#open(reference, context, true));
  }

  close(): Promise<void> {
    return this.#sessions.close();
  }

  #open(
    reference: string,
    context: HarnessSessionContext,
    resume: boolean,
  ): Promise<MuseHarnessSession> {
    return MuseHarnessSession.open(
      this.#config,
      this.#dependencies,
      context,
      reference,
      resume,
      (session) => this.#sessions.release(session),
    );
  }
}

interface ActiveTurn {
  readonly completion: Deferred<void>;
  readonly joinedTurns: Set<string>;
  readonly nodes: SubagentNodes;
  /** Items opened but not yet completed, so `item/delta` can be routed by kind. */
  readonly openItems: Map<string, OpenItem>;
  readonly requestedBy: UserId;
  readonly runId: HarnessRunInput["runId"];
  readonly workflows: Set<string>;
  interruptRequested: boolean;
  rootCompleted: boolean;
  started: boolean;
  terminal: boolean;
  turnId?: string;
  usage?: RunUsage;
}

interface OpenItem {
  readonly callId: string;
  readonly kind: string;
  summaryPart?: number;
}

type MusePending =
  | { readonly kind: "approval"; readonly request: ApprovalRequestParams }
  | { readonly kind: "input"; readonly request: UserInputRequestParams };

class MuseHarnessSession implements HarnessSession {
  readonly providerSessionReference: string;
  readonly events: AsyncIterable<HarnessEvent>;
  readonly #config: MuseHarnessConfig;
  readonly #dependencies: MuseHarnessDependencies;
  readonly #context: HarnessSessionContext;
  readonly #onClose: (session: MuseHarnessSession) => void;
  readonly #publisher: TurnPublisher;
  readonly #pending = new Map<RequestId, MusePending>();
  #host: MuseHost | undefined;
  #active: ActiveTurn | undefined;
  #closed = false;
  #compacting = false;
  #skillCatalog: string | undefined;
  #latestUsage: SubscriptionUsage | undefined;
  #stopPromise: Promise<void> | undefined;

  private constructor(
    config: MuseHarnessConfig,
    dependencies: MuseHarnessDependencies,
    context: HarnessSessionContext,
    reference: string,
    onClose: (session: MuseHarnessSession) => void,
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
    this.#context = context;
    this.providerSessionReference = reference;
    this.#onClose = onClose;
    this.#publisher = new TurnPublisher({
      maxBytes: config.maxEventBytes,
      maxItems: config.maxEventItems,
    });
    this.events = this.#publisher.events;
    context.signal.addEventListener("abort", () => void this.stop(), { once: true });
  }

  static async open(
    config: MuseHarnessConfig,
    dependencies: MuseHarnessDependencies,
    context: HarnessSessionContext,
    reference: string,
    resume: boolean,
    onClose: (session: MuseHarnessSession) => void,
  ): Promise<MuseHarnessSession> {
    assertNativeSession(context);
    const session = new MuseHarnessSession(config, dependencies, context, reference, onClose);
    try {
      session.#skillCatalog = await renderHarnessSkillCatalog(context.skills);
      await session.#launch(resume);
      return session;
    } catch (error) {
      await session.#stop(false);
      throw normalizeResumeError(error, resume);
    }
  }

  async execute(run: HarnessRunInput): Promise<void> {
    this.#assertUsable();
    if (this.#active)
      throw new OpensteerError({
        code: "conflict",
        message: "Muse Code already has an active turn",
      });
    if (!this.#host) await this.#launch(true);
    const active: ActiveTurn = {
      completion: new Deferred<void>(),
      interruptRequested: run.signal.aborted,
      joinedTurns: new Set(),
      nodes: new SubagentNodes((event) => this.#publish(event)),
      openItems: new Map(),
      requestedBy: run.requestedBy,
      rootCompleted: false,
      runId: run.runId,
      started: false,
      terminal: false,
      workflows: new Set(),
    };
    this.#active = active;
    const abort = () => {
      active.interruptRequested = true;
      void this.interrupt();
    };
    if (!run.signal.aborted) run.signal.addEventListener("abort", abort, { once: true });
    try {
      if (run.signal.aborted) {
        this.#terminal(active, "interrupted");
        return;
      }
      const host = this.#requireHost();
      await host.command("session/setModel", {
        model: {
          modelId: nativeModel(this.#context),
          providerId: "meta",
        },
        sessionId: this.providerSessionReference,
      });
      await this.#applyApprovalMode(host);
      const workspace = await realpath(this.#context.workspacePath);
      const roots = await Promise.all(
        [workspace, ...this.#context.writableRoots].map((path) => realpath(path)),
      );
      const input = await museTurnInput(run.inputs, run.attachments, this.#turnNotices(run));
      const result = parseMuseTurnStart(
        await host.startTurn({
          displayText: run.inputs
            .flatMap((input) => resolvedInputParts(input, run.attachments).body)
            .join("\n"),
          ifBusy: "reject",
          input,
          ...(museSelectedEffort(this.#context.modelSelection.options)
            ? { reasoningEffort: museSelectedEffort(this.#context.modelSelection.options) }
            : {}),
          sessionId: this.providerSessionReference,
          workspaceRoots: [...new Set(roots)],
        }),
      );
      active.turnId = result.turnId;
      active.joinedTurns.add(result.turnId);
      this.#start(active);
      await active.completion.promise;
    } catch (error) {
      if (!active.terminal)
        this.#failure(
          active,
          classifyMuseFailure(error, nativeModel(this.#context), this.#latestUsage),
        );
    } finally {
      run.signal.removeEventListener("abort", abort);
      this.#cancelPending("run-ended");
      if (this.#active === active) this.#active = undefined;
    }
  }

  async steer(input: HarnessSteerInput): Promise<void> {
    this.#assertUsable();
    const active = this.#active;
    if (!active?.turnId || active.terminal) {
      throw new OpensteerError({ code: "conflict", message: "Muse Code has no steerable turn" });
    }
    const result = parseMuseTurnSteer(
      await this.#requireHost().command("turn/steer", {
        expectedTurnId: active.turnId,
        input: await museTurnInput([input.input], input.attachments),
        ...(museSelectedEffort(this.#context.modelSelection.options)
          ? { reasoningEffort: museSelectedEffort(this.#context.modelSelection.options) }
          : {}),
        sessionId: this.providerSessionReference,
      }),
    );
    if (result.turnId !== active.turnId) throw new Error("Muse Code steered a different turn");
  }

  async interrupt(): Promise<void> {
    const active = this.#active;
    if (!active || active.terminal) return;
    active.interruptRequested = true;
    if (this.#compacting) {
      await this.#host?.close();
      return;
    }
    const host = this.#host;
    if (!host) return;
    const commands: Promise<unknown>[] = [];
    for (const turnId of active.joinedTurns) {
      commands.push(
        host.command("turn/interrupt", { sessionId: this.providerSessionReference, turnId }),
      );
    }
    for (const key of active.nodes.liveKeys()) {
      commands.push(
        host.command("subagent/stop", {
          reason: "Opensteer Run stopped",
          sessionId: this.providerSessionReference,
          subagentId: key,
        }),
      );
    }
    for (const workflowRunId of active.workflows) {
      commands.push(
        host.command("workflow/cancel", {
          sessionId: this.providerSessionReference,
          workflowRunId,
        }),
      );
    }
    await Promise.allSettled(commands);
  }

  async resolveRequest(requestId: RequestId, response: RequestResponse): Promise<void> {
    this.#assertUsable();
    const pending = this.#pending.get(requestId);
    if (!pending)
      throw new OpensteerError({ code: "not_found", message: "Muse Code Request not found" });
    if (pending.kind === "approval") {
      if (response.kind !== "choice") throw invalidResponse();
      const choice = pending.request.availableChoices.find(
        (candidate) => candidate.choiceId === response.optionId,
      );
      if (!choice) throw invalidResponse();
      const feedback = response.text
        ? boundedDenialNote(response.text, { maximumBytes: 20_000, tooLong: invalidResponse })
        : undefined;
      parseMuseApprovalDecide(
        await this.#requireHost().command("approval/decide", {
          approvalId: pending.request.approvalId,
          choiceId: choice.choiceId,
          ...(feedback && choice.acceptsFeedback ? { feedback } : {}),
          requirementId: pending.request.currentRequirementId,
          sessionId: this.providerSessionReference,
        }),
      );
      this.#pending.delete(requestId);
      return;
    }
    if (response.kind !== "form") throw invalidResponse();
    const answers = RequestFormAnswersSchema.parse(response.answers);
    const wireAnswers = pending.request.questions.map((question) => {
      const values = answers[question.id] ?? [];
      if (question.selection.mode === "multiple") {
        return { questionId: question.id, ...(values.length ? { selectedLabels: values } : {}) };
      }
      const selected = values[0];
      const offered = question.options.some((option) => option.label === selected);
      return offered
        ? { questionId: question.id, selectedLabel: selected }
        : { freeText: selected ?? "", questionId: question.id };
    });
    await this.#requireHost().command("userInput/answer", {
      answers: wireAnswers,
      sessionId: this.providerSessionReference,
      userInputId: pending.request.userInputId,
    });
    this.#pending.delete(requestId);
  }

  async generateTitle({ prompt, signal }: HarnessTitleInput): Promise<string> {
    return withTitleDirectory(this.#context, async (directory) => {
      signal.throwIfAborted();
      const workspace = join(directory, "workspace");
      const config = join(directory, "config");
      const data = join(directory, "data");
      const projects = join(directory, "projects");
      await Promise.all(
        [workspace, config, data, projects].map((path) =>
          mkdir(path, { recursive: true, mode: 0o700 }),
        ),
      );
      await copyMuseAuthentication(this.#context, config);
      const environment = await museEnvironment(
        this.#context.environment,
        this.#context.providerState,
        {
          XDG_CONFIG_HOME: config,
          XDG_DATA_HOME: data,
          MUSE_PROJECTS_HOME: projects,
          HOME: directory,
        },
      );
      let host: MuseHost | undefined;
      let text = "";
      const done = new Deferred<void>();
      const sessionId = mintUuid();
      try {
        host = await MuseHost.open({
          args: [
            ...(this.#dependencies.arguments ?? []),
            "serve",
            "--disable-shell",
            "--disable-write",
            "--no-session-log",
          ],
          cwd: workspace,
          environment,
          executable: this.#dependencies.executable,
          onNotification: (method, params) => {
            if (method === "item/completed") {
              const parsed = MuseItemEventSchema.safeParse(params);
              if (parsed.success) {
                const item = parseMuseItem(parsed.data.item);
                if (item.kind === "agentMessage" && item.text) text += item.text;
              }
            }
            if (method === "turn/completed") done.resolve();
          },
          onProtocolError: () => done.resolve(),
          onServerRequest: async () => ({}),
          requestedCapabilities: [],
          signal,
          startupTimeoutMs: this.#config.startupTimeoutMs,
          wrapProcessLaunch: this.#context.wrapProcessLaunch,
        });
        parseMuseSessionStart(
          await host.command("session/start", {
            approvalMode: "denyUnmatched",
            config: { mcpServers: {} },
            modelId: nativeModel(this.#context),
            permissionProfile: ":ask-me",
            providerId: "meta",
            sessionId,
            workspaceRoot: workspace,
            workspaceRoots: [workspace],
          }),
        );
        parseMuseTurnStart(
          await host.startTurn({
            displayText: prompt,
            ifBusy: "reject",
            input: [{ text: prompt, type: "text" }],
            sessionId,
            workspaceRoots: [workspace],
          }),
        );
        const abort = () => void host?.close().then(() => done.resolve());
        signal.addEventListener("abort", abort, { once: true });
        try {
          await done.promise;
          signal.throwIfAborted();
          if (!text.trim()) throw new Error("Muse Code did not return a title");
          return text.trim();
        } finally {
          signal.removeEventListener("abort", abort);
        }
      } finally {
        await host?.close();
      }
    });
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop(true);
    return this.#stopPromise;
  }

  async #launch(resume: boolean): Promise<void> {
    if (this.#closed) throw new Error("Muse Code session is closed");
    const environment = await museEnvironment(
      this.#context.environment,
      this.#context.providerState,
    );
    const workspace = await realpath(this.#context.workspacePath);
    const host = await MuseHost.open({
      args: [
        ...(this.#dependencies.arguments ?? []),
        "serve",
        "--trust-workspace",
        ...(this.#context.accessMode === "full-access" ? ["--disable-sandbox"] : []),
      ],
      cwd: workspace,
      environment,
      executable: this.#dependencies.executable,
      onNotification: (method, params) => this.#notification(method, params),
      onProtocolError: (error) =>
        this.#hostFailure(toHarnessError(error, "Muse Code protocol failed")),
      onServerRequest: (method, params) => this.#serverRequest(method, params),
      signal: this.#context.signal,
      startupTimeoutMs: this.#config.startupTimeoutMs,
      wrapProcessLaunch: this.#context.wrapProcessLaunch,
    });
    if (!host.initializeResult.grantedCapabilities.includes("sessionMcp")) {
      await host.close();
      throw new OpensteerError({
        code: "harness_error",
        message: "Muse Code did not grant required session MCP support",
      });
    }
    this.#host = host;
    void host.exited.then((exit) => {
      if (this.#host !== host || this.#closed) return;
      this.#host = undefined;
      const active = this.#active;
      if (active && !active.terminal) {
        if (active.interruptRequested) this.#terminal(active, "interrupted");
        else
          this.#failure(active, {
            code: "muse_harness_error",
            message: `Muse Code exited during the turn${exit.code === null ? "" : ` (${exit.code})`}`,
            retryable: false,
          });
      }
    });
    const common = {
      config: museSessionConfig(this.#context),
      modelId: nativeModel(this.#context),
      permissionProfile: permissionProfile(this.#context.accessMode),
      sessionId: this.providerSessionReference,
    };
    if (resume) {
      const result = parseMuseSessionResume(
        await host.command("session/resume", { ...common, excludeItems: true }),
      );
      if (result.session.sessionId !== this.providerSessionReference)
        throw new Error("Muse Code resumed the wrong session");
      await this.#applyApprovalMode(host);
      await host.command("session/setModel", {
        model: { modelId: nativeModel(this.#context), providerId: "meta" },
        sessionId: this.providerSessionReference,
      });
    } else {
      const result = parseMuseSessionStart(
        await host.command("session/start", {
          ...common,
          approvalMode: approvalMode(this.#context.accessMode),
          providerId: "meta",
          workspaceRoot: workspace,
          workspaceRoots: [workspace],
        }),
      );
      if (result.session.sessionId !== this.providerSessionReference)
        throw new Error("Muse Code started the wrong session");
    }
  }

  async #applyApprovalMode(host: MuseHost): Promise<void> {
    const result = parseMuseSetApprovalMode(
      await host.command("session/setApprovalMode", {
        mode: approvalMode(this.#context.accessMode),
        sessionId: this.providerSessionReference,
      }),
    );
    if (result.effectiveMode.mode !== approvalMode(this.#context.accessMode)) {
      throw new Error("Muse Code did not apply the requested approval mode");
    }
  }

  #notification(method: string, params: unknown): void {
    const active = this.#active;
    if (method === "usage/changed") {
      const parsed = parseMuseSubscriptionUsage(params);
      this.#latestUsage = parsed;
      return;
    }
    if (!active || active.terminal) return;
    if (method === "turn/started") {
      const turnId = recordString(params, "turnId");
      if (turnId) active.joinedTurns.add(turnId);
      this.#start(active);
      return;
    }
    if (method === "session/tokenUsage") {
      const parsed = MuseSessionTokenUsageSchema.safeParse(params);
      if (parsed.success && active.joinedTurns.has(parsed.data.turnId)) {
        active.usage = tokenUsage(parsed.data.usage);
      }
      return;
    }
    if (method === "item/delta") {
      const parsed = MuseItemDeltaSchema.safeParse(params);
      if (parsed.success) this.#delta(active, parsed.data);
      return;
    }
    if (method === "item/started" || method === "item/updated" || method === "item/completed") {
      const parsed = MuseItemEventSchema.safeParse(params);
      if (parsed.success) this.#item(active, parseMuseItem(parsed.data.item), method);
      return;
    }
    if (method === "turn/completed") {
      const completed = parseMuseTurnCompleted(params);
      if (!active.joinedTurns.has(completed.turnId)) return;
      if (completed.usage) active.usage = tokenUsage(completed.usage);
      if (completed.terminal === "completed") {
        void this.#finishAfterChildren(active);
      } else if (active.interruptRequested || completed.terminal === "cancelled") {
        this.#terminal(active, "interrupted");
      } else {
        this.#failure(
          active,
          classifyMuseFailure(
            completed.error ?? completed.reason,
            nativeModel(this.#context),
            this.#latestUsage,
          ),
        );
      }
      return;
    }
    if (method === "session/compactionStarted") this.#compacting = true;
    if (method === "session/compactionCompleted") this.#compacting = false;
  }

  /**
   * Routes one streamed append by the open item's kind and field path: the
   * contract streams `agentMessage.text` (an absent field means `text`),
   * `reasoning.summary[n]` as `summary.n`, and `toolCall`/`userShell` output
   * as `output`. Anything else is left to the item's `item/completed`.
   */
  #delta(
    active: ActiveTurn,
    params: {
      readonly delta: string;
      readonly field?: string | undefined;
      readonly itemId: string;
    },
  ): void {
    const item = active.openItems.get(params.itemId);
    if (!item || !params.delta) return;
    const field = params.field ?? "text";
    if (item.kind === "agentMessage" && field === "text") {
      this.#publish({ data: { text: params.delta }, type: "assistant.delta" });
      return;
    }
    if (item.kind === "reasoning") {
      const part = /^summary\.(\d+)$/.exec(field)?.[1];
      if (part === undefined) return;
      const index = Number(part);
      const previous = item.summaryPart;
      item.summaryPart = previous === undefined ? index : Math.max(previous, index);
      // Matches the `\n\n` join `reasoning.completed` uses for the parts.
      const text =
        previous !== undefined && index > previous ? `\n\n${params.delta}` : params.delta;
      this.#publish({ data: { blockId: params.itemId, text }, type: "reasoning.delta" });
      return;
    }
    if ((item.kind === "toolCall" || item.kind === "userShell") && field === "output") {
      this.#publish({
        data: { callId: item.callId, text: normalizeToolOutput(params.delta).text },
        type: "tool.delta",
      });
    }
  }

  #item(active: ActiveTurn, item: Item, method: string): void {
    const complete = method === "item/completed";
    if (complete) active.openItems.delete(item.itemId);
    else if (!active.openItems.has(item.itemId))
      active.openItems.set(item.itemId, { callId: item.callId ?? item.itemId, kind: item.kind });
    if (item.kind === "compaction") {
      this.#compacting = !complete;
      return;
    }
    if (item.kind === "agentMessage") {
      if (complete && item.text) {
        this.#publish({
          data: { content: [{ text: item.text, type: "text" }], messageId: createId("message") },
          type: "assistant.message",
        });
      }
      return;
    }
    if (item.kind === "reasoning") {
      // The summary is what streamed; raw `text` never streams, so it stands
      // in only when the item has no summary.
      const text = item.summary?.filter(Boolean).join("\n\n") || item.text;
      if (complete && text)
        this.#publish({ data: { blockId: item.itemId, text }, type: "reasoning.completed" });
      return;
    }
    if (item.kind === "subagent") {
      const key = item.subagentId ?? item.childSessionId ?? item.itemId;
      if (!complete && !active.nodes.nodeId(key)) {
        active.nodes.ensure(key, {
          nativeRef: key,
          originCallId: item.callId ?? null,
          prompt: item.objective ?? null,
          sessionRef: item.childSessionId ?? null,
          title: item.summary?.[0] ?? item.objective ?? "Muse Code subagent",
        });
      }
      const result = item.result?.text ?? item.result?.summary ?? item.finalSummary;
      if (result) active.nodes.noteResult(key, result);
      if (complete || item.controlStatus === "closed") {
        active.nodes.complete(
          key,
          item.failureReason ? "failed" : "completed",
          result !== undefined ? { result } : {},
        );
        this.#settleBackground(active);
      }
      return;
    }
    if (item.kind === "workflow") {
      const workflowRunId = item.callId ?? item.itemId;
      const children = item.children ?? [];
      if (complete) active.workflows.delete(workflowRunId);
      else active.workflows.add(workflowRunId);
      for (const child of children) {
        const key = `${workflowRunId}:${child.childId}:${child.attempt}`;
        const terminal = child.terminal ?? (child.status === "completed" ? "completed" : undefined);
        if (!terminal && !active.nodes.nodeId(key)) {
          active.nodes.ensure(key, {
            nativeRef: child.childId,
            title: child.label ?? "Muse Code workflow child",
          });
        }
        if (terminal)
          active.nodes.complete(
            key,
            child.failureKind ? "failed" : terminal === "completed" ? "completed" : "interrupted",
            { result: child.failureReason ?? null },
          );
      }
      this.#settleBackground(active);
      return;
    }
    const callId = item.callId ?? item.itemId;
    if (method === "item/started") {
      this.#publish({
        data: {
          arguments: item.args ?? item.commandText ?? "",
          callId,
          tool: { name: item.tool ?? item.kind, namespace: "muse" },
        },
        type: "tool.started",
      });
    }
    if (complete) {
      this.#publish({
        data: {
          callId,
          isError:
            Boolean(item.failureReason) || (item.exitCode !== undefined && item.exitCode !== 0),
          output: normalizeToolOutput(
            item.visibleOutput ??
              item.result?.text ??
              item.result?.summary ??
              item.failureReason ??
              "",
          ),
        },
        type: "tool.completed",
      });
    }
  }

  async #serverRequest(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (method === "approval/request") {
      const request = parseMuseApprovalRequest(params);
      if (this.#context.accessMode === "full-access" && request.subagentOrigin) {
        // The server request receives its presentation receipt first. Its
        // decision is a separate MSP command; awaiting it here can make that
        // command wait behind the unanswered server request.
        void this.#approveFullAccessChild(request).catch((error: unknown) =>
          this.#hostFailure(toHarnessError(error, "Muse Code child approval failed")),
        );
        return {};
      }
      this.#openApproval(request);
      return {};
    }
    if (method === "userInput/request") {
      this.#openInput(parseMuseUserInputRequest(params));
      return {};
    }
    throw new OpensteerError({
      code: "harness_error",
      message: `Muse Code requested unsupported method ${method}`,
    });
  }

  async #approveFullAccessChild(request: ApprovalRequestParams): Promise<void> {
    const choice =
      request.availableChoices.find(
        (candidate) => candidate.decision === "approved" && candidate.scope === "once",
      ) ?? request.availableChoices.find((candidate) => candidate.decision === "approved");
    if (!choice) throw new Error("Muse Code offered no approval choice for its workflow child");
    parseMuseApprovalDecide(
      await this.#requireHost().command("approval/decide", {
        approvalId: request.approvalId,
        choiceId: choice.choiceId,
        requirementId: request.currentRequirementId,
        sessionId: this.providerSessionReference,
      }),
    );
  }

  #openApproval(request: ApprovalRequestParams): void {
    const active = this.#active;
    if (!active || active.terminal) throw new Error("Muse Code requested approval outside a Run");
    const id = createId("request");
    this.#pending.set(id, { kind: "approval", request });
    const nodeId = request.subagentOrigin
      ? active.nodes.ensure(request.subagentOrigin.subagentId, {
          nativeRef: request.subagentOrigin.subagentId,
          sessionRef: request.subagentOrigin.childSessionId,
          title: "Muse Code subagent",
        })
      : undefined;
    this.#publish({
      data: {
        request: this.#pendingRequest(
          active,
          id,
          request.toolCallId,
          "harness.approval",
          {
            detail: approvalDetail(request),
            kind: "choice",
            options: request.availableChoices.map((choice) => ({
              hint: choice.decision === "approved" ? "allow-once" : "reject-once",
              id: choice.choiceId,
              label: choice.label,
            })),
            risk: "medium",
            title: `Approve ${request.toolName}`,
          },
          nodeId,
        ),
      },
      type: "request.opened",
    });
  }

  #openInput(request: UserInputRequestParams): void {
    const active = this.#active;
    if (!active || active.terminal) throw new Error("Muse Code requested input outside a Run");
    const id = createId("request");
    this.#pending.set(id, { kind: "input", request });
    this.#publish({
      data: {
        request: this.#pendingRequest(active, id, request.toolCallId, "harness.input", {
          fields: request.questions.map((question) => ({
            choices: question.options.map((option) => ({
              ...(option.description ? { description: option.description } : {}),
              label: option.label,
              value: option.label,
            })),
            id: question.id,
            multiSelect: question.selection.mode === "multiple",
            prompt: question.question,
            secret: false,
          })),
          kind: "form",
          title: "More information needed",
        }),
      },
      type: "request.opened",
    });
  }

  #pendingRequest(
    active: ActiveTurn,
    id: RequestId,
    callId: string,
    kind: "harness.approval" | "harness.input",
    presentation: PendingRequest["presentation"],
    nodeId?: PendingRequest["originatingNodeId"],
  ): PendingRequest {
    return {
      callId,
      cancellationReason: null,
      createdAt: new Date().toISOString(),
      id,
      kind,
      mode: "live",
      ...(nodeId ? { originatingNodeId: nodeId } : {}),
      originatingOccurrenceId: null,
      originatingRunId: active.runId,
      originatingThreadId: this.#context.threadId,
      originatingWorkspaceId: this.#context.workspaceId,
      payload: { kind },
      presentation,
      requestedBy: active.requestedBy,
      requiredActor: "requester",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
      targetWorkspaceId: this.#context.workspaceId,
    };
  }

  #turnNotices(run: HarnessRunInput): readonly string[] {
    return [
      this.#context.platformGuide,
      this.#context.instructions,
      this.#skillCatalog,
      this.#context.machineAccessNotice,
      durableHistoryWindowNotice(this.#context),
      initialContinuationContextPrompt(this.#context),
      harnessTurnPreamble(run, (input) => resolvedInputParts(input, run.attachments).body),
    ].filter((value): value is string => Boolean(value?.trim()));
  }

  async #finishAfterChildren(active: ActiveTurn): Promise<void> {
    active.rootCompleted = true;
    if (active.nodes.liveKeys().length > 0 || active.workflows.size > 0) {
      this.#publish({ data: { phase: "background" }, type: "run.phase" });
      return;
    }
    this.#terminal(active, "completed");
  }

  #settleBackground(active: ActiveTurn): void {
    if (
      active.rootCompleted &&
      !active.terminal &&
      active.nodes.liveKeys().length === 0 &&
      active.workflows.size === 0
    ) {
      this.#terminal(active, active.interruptRequested ? "interrupted" : "completed");
    }
  }

  #start(active: ActiveTurn): void {
    if (active.started) return;
    active.started = true;
    this.#publish(runStartedEvent());
  }

  #terminal(active: ActiveTurn, status: "completed" | "interrupted"): void {
    if (active.terminal) return;
    if (active.usage) this.#publish({ data: active.usage, type: "run.usage" });
    active.nodes.endAll(status === "completed" ? "completed" : "interrupted");
    active.terminal = true;
    this.#publish(runEndedEvent(status));
    active.completion.resolve();
  }

  #failure(
    active: ActiveTurn,
    failure: { code: string; message: string; retryable: boolean },
  ): void {
    if (active.terminal) return;
    if (active.usage) this.#publish({ data: active.usage, type: "run.usage" });
    active.nodes.endAll("failed");
    active.terminal = true;
    this.#publish(runFailedEvent(failure));
    active.completion.resolve();
  }

  #hostFailure(error: OpensteerError): void {
    const active = this.#active;
    if (active?.interruptRequested && !active.terminal) {
      this.#terminal(active, "interrupted");
    } else if (active && !active.terminal)
      this.#failure(active, {
        code: "muse_harness_error",
        message: error.message,
        retryable: false,
      });
  }

  #cancelPending(reason: "run-ended" | "source-closed"): void {
    for (const requestId of this.#pending.keys()) {
      this.#publish({ data: { reason, requestId }, type: "request.cancelled" });
    }
    this.#pending.clear();
  }

  #publish(event: HarnessEvent): void {
    if (this.#publisher.streamClosed) return;
    this.#publisher.publish(event);
  }

  #requireHost(): MuseHost {
    if (!this.#host)
      throw new OpensteerError({ code: "harness_error", message: "Muse Code host is not running" });
    return this.#host;
  }

  #assertUsable(): void {
    if (this.#closed)
      throw new OpensteerError({ code: "harness_error", message: "Muse Code session is closed" });
    if (this.#publisher.unusable) throw this.#publisher.unusable;
  }

  async #stop(notify: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.interrupt().catch(() => undefined);
    this.#cancelPending("source-closed");
    const active = this.#active;
    if (active && !active.terminal) this.#terminal(active, "interrupted");
    await this.#host?.close();
    this.#host = undefined;
    this.#publisher.closeStream();
    if (notify) this.#onClose(this);
  }
}

function museAuthenticationRequired(
  state: HarnessInspectionContext["providerState"],
): HarnessInspectionResult {
  return {
    connections: [
      {
        authKind: "subscription",
        connectionSlot: "primary",
        label: "Muse Code",
        logoutSupported: true,
        status: "authentication-required",
      },
    ],
    detail: "Sign in to Muse Code or add a Meta API key",
    setupMethods: museSetupMethods(state),
    status: "authentication-required",
  };
}

function museSetupMethods(state: HarnessInspectionContext["providerState"]) {
  return state.kind === "isolated" ? setupMethods : [setupMethods[0]];
}

async function museEnvironment(
  supplied: Readonly<Record<string, string>>,
  state: HarnessInspectionContext["providerState"],
  overrides: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> {
  const environment = { ...supplied };
  for (const key of Object.keys(environment))
    if (key.toUpperCase() === "META_API_KEY") delete environment[key];
  environment.MUSE_NO_AUTO_UPDATE = "1";
  if (state.kind === "isolated") {
    const home = state.providerHomeDirectory;
    if (!home) throw new Error("Muse Code isolated profile has no provider home");
    const paths = {
      config: join(home, "config"),
      data: join(home, "data"),
      projects: join(home, "projects"),
    };
    await Promise.all(
      Object.values(paths).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
    );
    environment.XDG_CONFIG_HOME = paths.config;
    environment.XDG_DATA_HOME = paths.data;
    environment.MUSE_PROJECTS_HOME = paths.projects;
  }
  Object.assign(environment, overrides);
  const key = await museApiKey(state);
  if (key) environment.META_API_KEY = key;
  return environment;
}

function museApiKeyFile(state: HarnessInspectionContext["providerState"]) {
  return providerSecretFile(state, museApiKeyFileName, {
    description: "Meta API key",
    maximumBytes: 32 * 1_024,
  });
}

async function museApiKey(
  state: HarnessInspectionContext["providerState"],
): Promise<string | undefined> {
  return state.kind === "isolated" ? museApiKeyFile(state).read() : undefined;
}

function assertNativeUser(kind: HarnessInspectionContext["runtimeBoundary"]["kind"]): void {
  if (kind !== "native-user")
    throw new OpensteerError({ code: "forbidden", message: nativeUserOnlyDetail });
}

function assertNativeSession(context: HarnessSessionContext): void {
  assertNativeUser(context.runtimeBoundary.kind);
  context.signal.throwIfAborted();
}

function assertSelection(slot: string | undefined): void {
  if (slot && slot !== "primary")
    throw new OpensteerError({ code: "bad_request", message: "Unknown Muse Code connection" });
}

function approvalMode(mode: ThreadAccessMode): "allowAll" | "promptUnmatched" {
  return mode === "full-access" ? "allowAll" : "promptUnmatched";
}

function permissionProfile(mode: ThreadAccessMode): ":ask-me" | ":unrestricted" {
  return mode === "full-access" ? ":unrestricted" : ":ask-me";
}

function nativeModel(context: HarnessSessionContext): string {
  return context.modelSelection.nativeModelId ?? context.modelSelection.modelId;
}

function museSessionConfig(context: HarnessSessionContext): Record<string, unknown> {
  return {
    mcpServers: {
      opensteer: {
        headers: { Authorization: `Bearer ${context.agentTools.token}` },
        mode: "required",
        transport: "streamableHttp",
        url: context.agentTools.url,
      },
      opensteer_integrations: {
        headers: { Authorization: `Bearer ${context.integrationTools.token}` },
        mode: "required",
        transport: "streamableHttp",
        url: context.integrationTools.url,
      },
    },
  };
}

async function museTurnInput(
  inputs: readonly HarnessRunInput["inputs"][number][],
  attachments: ReadonlyMap<string, ResolvedAttachment> | undefined,
  prefix: readonly string[] = [],
): Promise<TurnInputPart[]> {
  const parts: TurnInputPart[] = prefix.map((text) => ({ text, type: "text" }));
  for (const input of inputs) {
    for (const part of resolvedInputSequence(input, attachments)) {
      if (part.type === "text") parts.push({ text: part.text, type: "text" });
      else {
        parts.push({
          base64Data: (await readVerifiedAttachmentBytes(part.attachment)).toString("base64"),
          mediaType: part.attachment.attachment.mediaType,
          type: "image",
        });
      }
    }
  }
  if (parts.length === 0)
    throw new OpensteerError({ code: "bad_request", message: "Muse Code turn input is empty" });
  return parts;
}

function tokenUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  cachedTokens: number;
}): RunUsage {
  const cachedInputTokens = Math.max(usage.cacheReadTokens ?? usage.cachedTokens, 0);
  return {
    cachedInputTokens,
    inputTokens: Math.max(usage.inputTokens - cachedInputTokens - (usage.cacheWriteTokens ?? 0), 0),
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}

function observedUsage(usage: SubscriptionUsage): HarnessObservedUsage {
  const windows = [
    {
      label: `${Math.round(usage.window.windowDurationMins / 60)}h`,
      resetsAt: validDate(usage.window.resetsAtMs),
      usedPercent: clampPercent(usage.window.usedPercent),
    },
    {
      label: "weekly",
      resetsAt: validDate(usage.weekly.resetsAtMs),
      usedPercent: clampPercent(usage.weekly.usedPercent),
    },
  ];
  return {
    limitReached: windows.some((window) => window.usedPercent >= 100),
    observedAt: validDate(usage.observedAtMs) ?? new Date().toISOString(),
    windows,
  };
}

function validDate(ms: number): string | null {
  const date = new Date(ms);
  return Number.isFinite(ms) && !Number.isNaN(date.valueOf()) && ms > 0 ? date.toISOString() : null;
}

function clampPercent(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

function safeLabel(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ")
    .trim()
    .slice(0, 120);
}

function classifyMuseFailure(
  error: unknown,
  model: string,
  usage: SubscriptionUsage | undefined,
): { code: string; message: string; retryable: boolean } {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (recordString(error, "message") ?? "Muse Code turn failed");
  const status = recordNumber(error, "status") ?? recordNumber(error, "httpStatus");
  if (/does not exist|lack access|not entitled/iu.test(message)) {
    return {
      code: "muse_model_unavailable",
      message: `Muse Code model ${model} does not exist or this account lacks access`,
      retryable: false,
    };
  }
  if (
    (status === 429 || /quota|usage.?limit|rate.?limit/iu.test(message)) &&
    /quota|usage.?limit|rate.?limit/iu.test(message)
  ) {
    const resets = [
      recordNumber(recordValue(error, "quota"), "resetsAtMs"),
      usage?.window.resetsAtMs,
      usage?.weekly.resetsAtMs,
    ].filter((value): value is number => typeof value === "number" && validDate(value) !== null);
    const reset = resets.sort((a, b) => b - a)[0];
    return {
      code: harnessUsageLimitFailureCode,
      message: reset
        ? `Muse Code usage limit reached; latest reset is ${validDate(reset)}`
        : "Muse Code usage limit reached",
      retryable: false,
    };
  }
  return {
    code: "muse_harness_error",
    message: sanitizeFailure(message),
    retryable: isMuseMspError(error) && error.code === -32000,
  };
}

function sanitizeFailure(message: string): string {
  return message.replace(/[\r\n]+/gu, " ").slice(0, 2_000) || "Muse Code turn failed";
}

function normalizeResumeError(error: unknown, resume: boolean): unknown {
  if (!resume) return error;
  const wrongIdentity = error instanceof Error && /resumed the wrong session/iu.test(error.message);
  if (!wrongIdentity && (!isMuseMspError(error) || error.code !== -32011)) return error;
  return new OpensteerError({
    code: "not_found",
    message:
      "Muse Code could not resume the native session; its stored state is missing or belongs to another profile",
    ...(error instanceof Error ? { cause: error } : {}),
  });
}

function approvalDetail(request: ApprovalRequestParams): string {
  return [
    request.subject.command,
    request.subject.path,
    request.subject.host,
    request.subject.target,
    request.rawArgs,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, 20_000);
}

function invalidResponse(): OpensteerError {
  return new OpensteerError({ code: "bad_request", message: "Invalid Muse Code Request response" });
}

function identityLaunch<T>(launch: T): T {
  return launch;
}

function recordValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function recordString(value: unknown, key: string): string | undefined {
  const found = recordValue(value, key);
  return typeof found === "string" ? found : undefined;
}

function recordNumber(value: unknown, key: string): number | undefined {
  const found = recordValue(value, key);
  return typeof found === "number" ? found : undefined;
}

async function copyMuseAuthentication(
  context: HarnessSessionContext,
  targetConfig: string,
): Promise<void> {
  const sourceConfig =
    context.providerState.kind === "isolated"
      ? join(context.providerState.providerHomeDirectory ?? "", "config")
      : (context.environment.XDG_CONFIG_HOME ??
        join(context.environment.HOME ?? homedir(), ".config"));
  const target = join(targetConfig, "muse");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await copyFile(join(sourceConfig, "muse", "auth.json"), join(target, "auth.json")).catch(
    (error: unknown) => {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
    },
  );
}

async function waitForDeviceCode(
  process: SupervisedProcess,
  signal: AbortSignal,
): Promise<{
  readonly kind: "device-code";
  readonly userCode: string;
  readonly verificationUrl: string;
}> {
  const found = new Deferred<{
    readonly kind: "device-code";
    readonly userCode: string;
    readonly verificationUrl: string;
  }>();
  let text = "";
  const consume = async (stream: AsyncIterable<Buffer>) => {
    for await (const chunk of stream) {
      text = `${text}${chunk.toString("utf8")}`.slice(-64 * 1_024);
      const url = text.match(/https:\/\/[^\s]+/u)?.[0];
      const code =
        text.match(/(?:code=|matches:\s*)([A-Z0-9-]{4,})/iu)?.[1] ??
        (url ? (new URL(url).searchParams.get("code") ?? undefined) : undefined);
      if (!url || !code) continue;
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") continue;
      found.resolve({ kind: "device-code", userCode: code, verificationUrl: url });
    }
  };
  void consume(process.stdout);
  void consume(process.stderr);
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Muse Code did not present a device code")),
      20_000,
    );
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
  try {
    return await Promise.race([
      found.promise,
      process.exited.then(() => {
        throw new Error("Muse Code sign-in exited before presenting a device code");
      }),
      timeout,
    ]);
  } catch (error) {
    await process.terminate(0);
    throw new OpensteerError({
      code: "harness_error",
      message: "Muse Code did not present a valid device code",
      cause: error,
    });
  }
}
