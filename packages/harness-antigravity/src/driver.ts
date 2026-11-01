import {
  HarnessIdSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  OpensteerError,
  attachmentImageMaxPixels,
  attachmentMaxBytes,
  attachmentNativeImageMediaTypes,
  canonicalModelReference,
  harnessUsageLimitFailureCode,
  modelDisplayName,
  type ThreadAccessMode,
} from "@opensteer/core";
import {
  AcpHarnessAdapter,
  acpProtocolOutputBytes,
  createAcpProtocolClient,
  generateContainedAcpTitle,
  normalizeAcpUpdate,
  type AcpErrorContext,
  type AcpHeldAssistantContext,
  type AcpHeldAssistantDecision,
  type AcpInspectionSnapshot,
  type AcpNormalizedUpdate,
  type AcpPermissionRequest,
  type AcpProtocolClient,
  type AcpSessionPolicy,
  type AcpSessionConfigOption,
} from "@opensteer/harness-acp";
import {
  Deferred,
  profileHarnessProviderStoreScope,
  providerSecretFile,
  reasoningEffortLabel,
  secretInputAuthentication,
  spawnSupervised,
  type HarnessAdapter,
  type HarnessAuthenticationContext,
  type HarnessAuthenticationResult,
  type HarnessAuthenticationSelection,
  type HarnessAuthenticationStart,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessDriverCreateContext,
  type HarnessInspectionContext,
  type HarnessInspectionResult,
  type HarnessLogoutSelection,
  type HarnessModelDescriptor,
  type HarnessProcessLaunch,
  type HarnessProviderState,
  type HarnessSession,
  type HarnessSessionContext,
  type HarnessTitleInput,
} from "@opensteer/harness";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AntigravityHarnessConfigSchema,
  antigravitySource,
  antigravitySourceIds,
  antigravitySources,
  type AntigravityAuthMethod,
  type AntigravityHarnessConfig,
} from "./config.js";
import { prepareAntigravityLaunch, prepareAntigravityTitleLaunch } from "./environment.js";
import {
  forwardAntigravityCallback,
  parseAntigravityAuthorizationUrl,
  validateAntigravityCallbackUrl,
} from "./oauth.js";
import {
  authenticationRequired,
  consumeAntigravityStderr,
  isAntigravityAuthenticationRequired,
  transformAntigravityStdout,
} from "./output.js";
import { antigravityPlatform, antigravityReleaseManifest } from "./release.js";
import {
  prepareAntigravityRuntime,
  type AntigravityRuntimeIdentity,
  type PreparedAntigravityRuntime,
} from "./runtime.js";
import {
  isNativeAntigravitySessionId,
  removeTemporaryAntigravitySession,
} from "./session-files.js";
import { readAntigravityUsage } from "./usage.js";

const initializeDeadlineMs = 20_000;
const authenticationLifetimeMs = 5 * 60_000;
const primaryConnectionSlot = "primary";
const requiredAuthMethods = new Set<AntigravityAuthMethod>([
  "oauth-personal",
  "oauth-business",
  "gemini-api-key",
  "agent-platform",
]);

export const antigravityHarnessCapabilities: HarnessCapabilities = Object.freeze({
  approvals: true,
  attachments: true,
  messageAttachments: {
    nativeImages: {
      maxBytes: attachmentMaxBytes,
      maxPixels: attachmentImageMaxPixels,
      mediaTypes: attachmentNativeImageMediaTypes,
      steering: false,
    },
  },
  interruption: true,
  mcpImageContent: true,
  resume: true,
  steering: false,
  toolCalls: true,
  userInput: true,
  warmReuse: false,
});

export interface AntigravityHarnessDriverOptions {
  readonly nodeExecutable: string;
  readonly runtimeCacheDirectory: string;
}

interface OwnedProtocol {
  readonly client: AcpProtocolClient;
  readonly process: ReturnType<typeof spawnSupervised>;
  close(): Promise<void>;
  error(error: unknown): unknown;
}

function apiKeyFile(providerState: HarnessProviderState) {
  return providerSecretFile(providerState, ".opensteer-antigravity-api-key", {
    description: "Antigravity API key",
    maximumBytes: 16 * 1_024,
  });
}

function assertNativeUser(context: Pick<HarnessInspectionContext, "runtimeBoundary">): void {
  if (context.runtimeBoundary.kind !== "native-user") {
    throw new OpensteerError({
      code: "forbidden",
      message: "Antigravity runs only on a computer owned by one person",
    });
  }
}

function sourceConfigurationIssue(
  sourceId: string,
  config: AntigravityHarnessConfig,
  apiKey: string | undefined,
): string | undefined {
  if (sourceId === antigravitySourceIds.enterprise && (!config.gcpProject || !config.gcpLocation)) {
    return "Gemini Enterprise needs a Google Cloud project and location";
  }
  if (sourceId === antigravitySourceIds.geminiApiKey && !apiKey) {
    return "Enter a Gemini API key to use this account";
  }
  if (
    sourceId === antigravitySourceIds.agentPlatform &&
    !apiKey &&
    (!config.gcpProject || !config.gcpLocation)
  ) {
    return "Agent Platform needs an API key, or a Google Cloud project and location for Application Default Credentials";
  }
  return undefined;
}

function setupMethods(sourceId: string) {
  const source = antigravitySource(sourceId);
  if (source.authMethod === "oauth-personal" || source.authMethod === "oauth-business") {
    return [
      {
        connectionSlot: primaryConnectionSlot,
        detail: `Sign in to ${source.label} through Google's browser flow.`,
        kind: "browser-code" as const,
        label: source.label,
        methodId: source.authMethod,
      },
    ];
  }
  return [
    {
      connectionSlot: primaryConnectionSlot,
      detail: `Store the ${source.label} key in this account's private profile.`,
      inputLabel: source.authMethod === "gemini-api-key" ? "Gemini API key" : "API key",
      kind: "secret-input" as const,
      label: source.label,
      methodId: source.authMethod,
    },
  ];
}

async function startProtocol(input: {
  readonly launch: HarnessProcessLaunch;
  readonly onAuthorizationUrl?: (url: string) => Promise<void> | void;
  readonly protocolVersion: 1 | 2;
  readonly signal: AbortSignal;
}): Promise<OwnedProtocol> {
  const lifetime = new AbortController();
  const combined = AbortSignal.any([input.signal, lifetime.signal]);
  const process = spawnSupervised({
    ...input.launch,
    maxOutputBytes: acpProtocolOutputBytes,
    signal: combined,
  });
  let stderrError: unknown;
  const client = createAcpProtocolClient({
    handlers: {
      elicitation: async () => null,
      permission: async () => null,
      readTextFile: async () => {
        throw new OpensteerError({
          code: "forbidden",
          message: "ACP probe file reads are disabled",
        });
      },
      update: () => undefined,
    },
    process,
    stdout: transformAntigravityStdout(process.stdout, input.onAuthorizationUrl),
    version: input.protocolVersion,
  });
  const stderr = consumeAntigravityStderr(process.stderr, input.onAuthorizationUrl).catch(
    (error: unknown) => {
      stderrError = error;
      client.close(error);
      lifetime.abort(error);
    },
  );
  let closed = false;
  return {
    client,
    process,
    close: async () => {
      if (closed) return;
      closed = true;
      client.close();
      lifetime.abort(new Error("Antigravity ACP operation finished"));
      await process.terminate().catch(() => undefined);
      await process.exited.catch(() => undefined);
      await stderr;
    },
    error: (error) => stderrError ?? error,
  };
}

async function initializeProtocol(
  owned: OwnedProtocol,
  protocolVersion: 1 | 2,
  signal: AbortSignal,
): Promise<AcpInspectionSnapshot> {
  try {
    const inspection = await owned.client.initialize({
      capabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
      deadlineMs: initializeDeadlineMs,
      info: { name: "zed", version: "0.0.0" },
      signal,
    });
    if (inspection.protocolVersion !== protocolVersion) {
      throw new OpensteerError({
        code: "harness_error",
        message: `Antigravity negotiated ACP ${inspection.protocolVersion}, expected ${protocolVersion}`,
      });
    }
    return inspection;
  } catch (error) {
    throw owned.error(error);
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function assertRuntimeIdentity(
  inspection: AcpInspectionSnapshot,
  expectedVersion: string,
): AntigravityRuntimeIdentity {
  if (
    inspection.agentInfo?.name !== "antigravity-acp" ||
    inspection.agentInfo.version !== expectedVersion ||
    (inspection.protocolVersion !== 1 && inspection.protocolVersion !== 2)
  ) {
    throw new Error("The downloaded runtime did not identify as the pinned Antigravity release");
  }
  const capabilities = inspection.agentCapabilities;
  const session = record(capabilities.sessionCapabilities);
  const auth = record(capabilities.auth);
  if (!record(session?.resume) || !record(auth?.logout)) {
    throw new Error("The downloaded Antigravity runtime lacks resume or logout support");
  }
  const methods = new Set(inspection.authMethods.map((method) => method.id));
  if ([...requiredAuthMethods].some((method) => !methods.has(method))) {
    throw new Error("The downloaded Antigravity runtime lacks a required authentication method");
  }
  return { protocolVersion: inspection.protocolVersion };
}

function permissionChoices(request: AcpPermissionRequest) {
  return request.options.map((option) => {
    const kind = option.kind.toLowerCase();
    return {
      hint: kind.includes("allow")
        ? ("allow-once" as const)
        : kind.includes("cancel")
          ? ("cancel" as const)
          : ("reject-once" as const),
      label: option.label,
      optionId: option.id,
    };
  });
}

function classifyError(error: unknown): OpensteerError {
  if (error instanceof OpensteerError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/quota|rate.?limit|resource.?exhausted/i.test(message)) {
    return new OpensteerError({
      code: harnessUsageLimitFailureCode,
      message: "This Google account has reached its Antigravity usage limit",
    });
  }
  if (/sign.?in|authenticat|subscription_required|-32000/i.test(message)) {
    return authenticationRequired();
  }
  return new OpensteerError({ code: "harness_error", message: "Antigravity could not continue" });
}

export function normalizeAntigravityUpdate(update: unknown): readonly AcpNormalizedUpdate[] {
  const normalized = normalizeAcpUpdate(update);
  return normalized.length > 0 ? normalized : [{ kind: "ignore" }];
}

export function classifyAntigravityAcpError(
  error: unknown,
  context: AcpErrorContext,
): OpensteerError {
  if (context.operation === "prompt") {
    const turnFailure = antigravityErrorBlocks(context.stderrTail).findLast(
      (block) => block.sessionId === context.providerSessionReference,
    );
    if (turnFailure) return classifyAntigravityTurnFailure(turnFailure);
  }
  return classifyError(error);
}

interface AntigravityTurnFailure {
  readonly grpcStatus?: string;
  readonly httpStatus?: number;
  readonly message?: string;
  readonly sessionId: string;
}

function antigravityTurnFailure(
  sessionId: string,
  diagnostics: readonly string[],
): AntigravityTurnFailure {
  const stderr = diagnostics.join("\n");
  const providerFailures = [
    ...stderr.matchAll(
      /Error\s+(\d{3}),\s*Message:\s*([^\r\n]*?),\s*Status:\s*([A-Z_]+),\s*Details:/gu,
    ),
  ];
  const provider = providerFailures.at(-1);
  const system = [...stderr.matchAll(/System step error \(HTTP (\d{3})\)/gu)].at(-1);
  const statuses = [...stderr.matchAll(/\bStatus:\s*([A-Z_]+)/gu)];
  const systemMessages = [...stderr.matchAll(/System step error \(HTTP \d{3}\):\s*([^\r\n]+)/gu)];
  const grpcStatus = provider?.[3] ?? statuses.at(-1)?.[1];
  const httpStatus = provider?.[1] ?? system?.[1];
  const message = (provider?.[2] ?? systemMessages.at(-1)?.[1])?.trim();
  return {
    ...(grpcStatus ? { grpcStatus } : {}),
    ...(httpStatus ? { httpStatus: Number(httpStatus) } : {}),
    ...(message ? { message } : {}),
    sessionId,
  };
}

function antigravityErrorDiagnostics(stderr: string): {
  readonly blocks: readonly AntigravityTurnFailure[];
  readonly pending: boolean;
} {
  const blocks: AntigravityTurnFailure[] = [];
  let pending: string[] = [];
  for (const line of stderr.split(/\r?\n/gu)) {
    if (
      /received model response error|Agent run failed|System step error \(HTTP \d{3}\)/u.test(line)
    ) {
      pending.push(line);
    }
    const marker = line.match(
      /Antigravity SDK error processing prompt for session\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/iu,
    );
    if (!marker) continue;
    if (pending.length > 0) blocks.push(antigravityTurnFailure(marker[1]!, pending));
    pending = [];
  }
  return { blocks, pending: pending.length > 0 };
}

function antigravityErrorBlocks(stderr: string): readonly AntigravityTurnFailure[] {
  return antigravityErrorDiagnostics(stderr).blocks;
}

export function settleAntigravityHeldAssistant(
  context: AcpHeldAssistantContext,
): AcpHeldAssistantDecision {
  const diagnostics = antigravityErrorDiagnostics(context.stderrTail);
  const blocks = diagnostics.blocks.filter(
    (block) => block.sessionId === context.providerSessionReference,
  );
  const failure = blocks.at(-1);
  if (!failure) return diagnostics.pending ? { status: "pending" } : { status: "succeeded" };
  return {
    discardAssistant:
      context.assistantText.trim().length > 0 &&
      failure.message?.trim() === context.assistantText.trim(),
    error: classifyAntigravityTurnFailure(failure),
    status: "failed",
  };
}

function classifyAntigravityTurnFailure(failure: AntigravityTurnFailure): OpensteerError {
  const status = failure.grpcStatus;
  if (failure.httpStatus === 402 || failure.httpStatus === 429 || status === "RESOURCE_EXHAUSTED") {
    const detail = failure.message ? `: ${sanitizeAntigravityFailure(failure.message)}` : "";
    return new OpensteerError({
      code: harnessUsageLimitFailureCode,
      message: `Antigravity usage limit reached${detail}`,
    });
  }
  if (
    failure.httpStatus === 401 ||
    failure.httpStatus === 403 ||
    status === "UNAUTHENTICATED" ||
    status === "PERMISSION_DENIED"
  ) {
    return authenticationRequired();
  }
  return new OpensteerError({
    code: "harness_error",
    message: failure.message
      ? sanitizeAntigravityFailure(failure.message)
      : "Antigravity could not continue",
  });
}

function sanitizeAntigravityFailure(message: string): string {
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "[REDACTED]")
    .replace(
      /\b(api[ _-]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^,\s]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/[\r\n\0]+/gu, " ")
    .trim()
    .slice(0, 2_000);
}

export function antigravityModelDescriptors(
  options: readonly AcpSessionConfigOption[],
  configurations: ReadonlyMap<string, readonly AcpSessionConfigOption[]>,
): readonly HarnessModelDescriptor[] {
  const model = options.find((option) => option.category === "model" || option.id === "model");
  if (model?.type !== "select" || !model.options?.length) return [];
  const descriptors = model.options.flatMap((choice) => {
    const configured = configurations.get(choice.value) ?? options;
    const effort = configured.find((option) => option.category === "thought_level");
    const effortValues =
      effort?.type === "select"
        ? (effort.options ?? []).map((candidate) => ({
            ...(candidate.description ? { description: candidate.description } : {}),
            label: reasoningEffortLabel(candidate.value),
            value: candidate.value,
          }))
        : [];
    const reference = canonicalModelReference(choice.value, "google");
    const modelId = ModelIdSchema.safeParse(reference.modelId);
    const providerId = ModelProviderIdSchema.safeParse(reference.providerId);
    if (!modelId.success || !providerId.success) return [];
    return [
      {
        acceptsImages: true,
        ...(choice.description ? { description: choice.description } : {}),
        displayName: choice.label.trim() || modelDisplayName(reference.modelId),
        isDefault: choice.value === model.currentValue,
        modelId: modelId.data,
        nativeModelId: choice.value,
        options:
          effortValues.length > 0
            ? [
                {
                  ...(typeof effort?.currentValue === "string"
                    ? { defaultValue: effort.currentValue }
                    : {}),
                  id: "effort",
                  label: "Thinking",
                  type: "select" as const,
                  values: effortValues,
                },
              ]
            : [],
        providerId: providerId.data,
      },
    ];
  });
  if (descriptors.some((descriptor) => descriptor.isDefault)) return descriptors;
  const [first, ...rest] = descriptors;
  return first ? [{ ...first, isDefault: true }, ...rest] : [];
}

export function antigravitySessionPolicy(protocolVersion: 1 | 2): AcpSessionPolicy {
  return {
    accessModeIds: {
      "approval-required": "default",
      "auto-accept-edits": "auto_edit",
      auto: "default",
      "full-access": "yolo",
    },
    cancel: { behavior: "wait-for-prompt" },
    clientCapabilities: { elicitation: true, fileSystem: "read-only", terminal: false },
    clientInfo: { name: "zed", version: "0.0.0" },
    eagerAuthentication: true,
    initializeDeadlineMs,
    model: {
      effortCategory: "thought_level",
      effortOptionId: "effort",
      legacyModelSuffixes: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      modelCategory: "model",
      type: "config-options",
    },
    protocolVersion,
    resume: { method: "resume", suppressReplay: false },
  };
}

export class AntigravityHarnessDriver implements HarnessDriver {
  readonly kind = HarnessIdSchema.parse("antigravity");
  readonly sources = antigravitySources;
  readonly accessModes = [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ] as const satisfies readonly ThreadAccessMode[];
  readonly capabilities = antigravityHarnessCapabilities;
  readonly configSchema = AntigravityHarnessConfigSchema;
  readonly providerStoreScope = profileHarnessProviderStoreScope;
  readonly #options: AntigravityHarnessDriverOptions;
  #runtime: PreparedAntigravityRuntime | undefined;

  constructor(options: AntigravityHarnessDriverOptions) {
    this.#options = options;
  }

  preparationKey(): string {
    const platform = antigravityPlatform();
    return platform
      ? `antigravity:${antigravityReleaseManifest.platforms[platform].archive.sha256}`
      : `antigravity:unsupported:${process.platform}-${process.arch}`;
  }

  async prepare(context: HarnessInspectionContext): Promise<void> {
    assertNativeUser(context);
    const config = AntigravityHarnessConfigSchema.parse(context.config);
    const source = antigravitySource(context.sourceId);
    this.#runtime = await prepareAntigravityRuntime({
      cacheDirectory: this.#options.runtimeCacheDirectory,
      signal: context.signal,
      validate: async (runtime, signal) => {
        const launch = await prepareAntigravityLaunch({
          authMethod: source.authMethod,
          baseEnvironment: context.environment,
          config,
          nodeExecutable: this.#options.nodeExecutable,
          providerState: context.providerState,
          runtime,
        });
        let failure: unknown;
        for (const protocolVersion of [1, 2] as const) {
          const owned = await startProtocol({
            launch: { ...launch, cwd: context.workingDirectory },
            protocolVersion,
            signal,
          });
          try {
            return assertRuntimeIdentity(
              await initializeProtocol(owned, protocolVersion, signal),
              antigravityReleaseManifest.version,
            );
          } catch (error) {
            failure = owned.error(error);
          } finally {
            await owned.close();
          }
        }
        throw failure ?? new Error("Antigravity did not support ACP protocol 1 or 2");
      },
    });
  }

  async inspect(context: HarnessInspectionContext): Promise<HarnessInspectionResult> {
    if (context.runtimeBoundary.kind !== "native-user") {
      return {
        detail: "Antigravity runs only on a computer owned by one person",
        status: "unavailable",
      };
    }
    const runtime = this.#requireRuntime();
    const config = AntigravityHarnessConfigSchema.parse(context.config);
    const source = antigravitySource(context.sourceId);
    const apiKey = await apiKeyFile(context.providerState).read();
    const issue = sourceConfigurationIssue(context.sourceId, config, apiKey);
    if (issue) return this.#authenticationRequired(source, issue);

    const scratch = await this.#scratchDirectory(context.providerState, "probe");
    let sessionId: string | undefined;
    let owned: OwnedProtocol | undefined;
    try {
      const launch = await prepareAntigravityLaunch({
        ...(apiKey ? { apiKey } : {}),
        authMethod: source.authMethod,
        baseEnvironment: context.environment,
        config,
        nodeExecutable: this.#options.nodeExecutable,
        providerState: context.providerState,
        runtime,
      });
      owned = await startProtocol({
        launch: { ...launch, cwd: scratch },
        protocolVersion: runtime.protocolVersion,
        signal: context.signal,
      });
      const initialized = await initializeProtocol(owned, runtime.protocolVersion, context.signal);
      assertRuntimeIdentity(initialized, runtime.version);
      await owned.client.authenticate(source.authMethod, context.signal);
      const session = await owned.client.newSession(
        { additionalDirectories: [], cwd: scratch, mcpServers: [] },
        context.signal,
      );
      sessionId = session.sessionId;
      if (!isNativeAntigravitySessionId(sessionId)) {
        throw new OpensteerError({
          code: "harness_error",
          message: "Antigravity returned an invalid session reference",
        });
      }
      const modelOption = session.configOptions.find(
        (option) => option.category === "model" || option.id === "model",
      );
      const configurations = new Map<string, readonly AcpSessionConfigOption[]>();
      if (modelOption?.type === "select") {
        for (const choice of modelOption.options ?? []) {
          configurations.set(
            choice.value,
            choice.value === modelOption.currentValue
              ? session.configOptions
              : await owned.client.setConfigOption(
                  session.sessionId,
                  { id: modelOption.id, type: "select", value: choice.value },
                  context.signal,
                ),
          );
        }
        if (typeof modelOption.currentValue === "string") {
          await owned.client.setConfigOption(
            session.sessionId,
            { id: modelOption.id, type: "select", value: modelOption.currentValue },
            context.signal,
          );
        }
      }
      const models = antigravityModelDescriptors(session.configOptions, configurations);
      await owned.client.closeSession(session.sessionId);
      const usage = await readAntigravityUsage({
        authMethod: source.authMethod,
        signal: context.signal,
        tokenPath: launch.profile.tokenPath,
      }).catch(() => undefined);
      return {
        connections: [
          {
            authKind: source.authKind,
            connectionSlot: primaryConnectionSlot,
            label: source.label,
            logoutSupported: source.authMethod === "agent-platform" ? apiKey !== undefined : true,
            status: "connected",
            ...(usage ? { usage } : {}),
          },
        ],
        models,
        setupMethods: setupMethods(context.sourceId),
        status: "ready",
      };
    } catch (error) {
      const failure = owned?.error(error) ?? error;
      if (isAntigravityAuthenticationRequired(failure) || looksLikeAuthenticationFailure(failure)) {
        return this.#authenticationRequired(source, `Sign in to ${source.label} to continue`);
      }
      throw classifyError(failure);
    } finally {
      await owned?.close();
      await removeTemporaryAntigravitySession({
        cwd: scratch,
        profileDirectory: context.providerState.providerHomeDirectory!,
        sessionId,
      });
      await rm(scratch, { force: true, recursive: true });
    }
  }

  async authenticate(
    context: HarnessAuthenticationContext,
    selection: HarnessAuthenticationSelection,
  ): Promise<HarnessAuthenticationStart> {
    assertNativeUser(context);
    if (selection.connectionSlot && selection.connectionSlot !== primaryConnectionSlot) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown Antigravity connection" });
    }
    const source = antigravitySource(context.sourceId);
    if (selection.methodId !== source.authMethod) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Unknown Antigravity setup method",
      });
    }
    if (source.authMethod === "oauth-personal" || source.authMethod === "oauth-business") {
      return this.#browserAuthentication(context, source.authMethod);
    }
    return secretInputAuthentication({
      cancelledDetail: "The API key was not entered",
      engineLabel: "Antigravity",
      inputLabel: source.authMethod === "gemini-api-key" ? "Gemini API key" : "API key",
      maximumLength: 16 * 1_024,
      requiredMessage: "API key is required",
      signal: context.signal,
      store: (value) => apiKeyFile(context.providerState).write(value),
      storeFailedDetail: "The API key could not be stored",
    });
  }

  async logout(
    context: HarnessAuthenticationContext,
    selection: HarnessLogoutSelection = {},
  ): Promise<void> {
    assertNativeUser(context);
    if (selection.connectionSlot && selection.connectionSlot !== primaryConnectionSlot) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown Antigravity connection" });
    }
    const source = antigravitySource(context.sourceId);
    if (source.authMethod === "gemini-api-key" || source.authMethod === "agent-platform") {
      await apiKeyFile(context.providerState).remove();
      return;
    }
    const runtime = this.#requireRuntime();
    const config = AntigravityHarnessConfigSchema.parse(context.config);
    const launch = await prepareAntigravityLaunch({
      authMethod: source.authMethod,
      baseEnvironment: context.environment,
      config,
      nodeExecutable: this.#options.nodeExecutable,
      providerState: context.providerState,
      runtime,
    });
    const owned = await startProtocol({
      launch: { ...launch, cwd: context.workingDirectory },
      protocolVersion: runtime.protocolVersion,
      signal: context.signal,
    });
    try {
      await initializeProtocol(owned, runtime.protocolVersion, context.signal);
      await owned.client.logout(context.signal);
    } catch (error) {
      throw classifyError(owned.error(error));
    } finally {
      await owned.close();
    }
  }

  async removeProfile(context: HarnessAuthenticationContext): Promise<void> {
    assertNativeUser(context);
    await this.logout(context);
    await apiKeyFile(context.providerState).remove();
  }

  async create(context: HarnessDriverCreateContext): Promise<HarnessAdapter> {
    return new AntigravityAdapter(
      context.instanceId,
      AntigravityHarnessConfigSchema.parse(context.config),
      antigravitySource(context.sourceId).authMethod,
      this.#options,
      this.#requireRuntime(),
    );
  }

  #authenticationRequired(
    source: ReturnType<typeof antigravitySource>,
    detail: string,
  ): HarnessInspectionResult {
    return {
      connections: [
        {
          authKind: source.authKind,
          connectionSlot: primaryConnectionSlot,
          label: source.label,
          logoutSupported: true,
          status: "authentication-required",
        },
      ],
      detail,
      setupMethods: setupMethods(source.sourceId),
      status: "authentication-required",
    };
  }

  async #browserAuthentication(
    context: HarnessAuthenticationContext,
    authMethod: "oauth-business" | "oauth-personal",
  ): Promise<HarnessAuthenticationStart> {
    const runtime = this.#requireRuntime();
    const config = AntigravityHarnessConfigSchema.parse(context.config);
    const launch = await prepareAntigravityLaunch({
      authMethod,
      baseEnvironment: context.environment,
      config,
      nodeExecutable: this.#options.nodeExecutable,
      providerState: context.providerState,
      runtime,
    });
    const lifetime = new AbortController();
    const signal = AbortSignal.any([
      context.signal,
      lifetime.signal,
      AbortSignal.timeout(authenticationLifetimeMs),
    ]);
    const authorization = new Deferred<string>();
    let firstAuthorization: string | undefined;
    const acceptAuthorization = (value: string) => {
      const parsed = parseAntigravityAuthorizationUrl(value);
      if (firstAuthorization && firstAuthorization !== parsed.authorizationUrl) {
        lifetime.abort(new Error("Antigravity started more than one Google sign-in request"));
        return;
      }
      firstAuthorization = parsed.authorizationUrl;
      authorization.resolve(parsed.authorizationUrl);
    };
    const owned = await startProtocol({
      launch: { ...launch, cwd: context.workingDirectory },
      onAuthorizationUrl: acceptAuthorization,
      protocolVersion: runtime.protocolVersion,
      signal,
    });
    let submitted = false;
    let settled = false;
    let resolveResult!: (result: HarnessAuthenticationResult) => void;
    const result = new Promise<HarnessAuthenticationResult>((resolve) => {
      resolveResult = resolve;
    });
    const finish = async (outcome: HarnessAuthenticationResult) => {
      if (settled) return;
      settled = true;
      lifetime.abort(new Error("Antigravity sign-in finished"));
      await owned.close();
      resolveResult(outcome);
    };
    const authentication = (async () => {
      try {
        await initializeProtocol(owned, runtime.protocolVersion, signal);
        await owned.client.authenticate(authMethod, signal);
        await finish({ status: "ready" });
      } catch {
        await finish({ detail: "Google sign-in failed or was canceled", status: "failed" });
      }
    })();
    const authorizationUrl = await Promise.race([
      authorization.promise,
      authentication.then(() => undefined),
    ]);
    if (!authorizationUrl) {
      await authentication;
      const outcome = await result;
      if (outcome.status === "ready") return { status: "ready" };
      throw new OpensteerError({ code: "harness_error", message: outcome.detail });
    }
    const pending = parseAntigravityAuthorizationUrl(authorizationUrl);
    return {
      cancel: async () => finish({ detail: "Google sign-in was canceled", status: "failed" }),
      challenge: {
        authorizationUrl: pending.authorizationUrl,
        inputPrompt: "Paste the complete address from the browser after Google redirects",
        kind: "browser-code",
      },
      result,
      status: "pending",
      submit: async (value) => {
        if (settled || submitted) {
          throw new OpensteerError({
            code: "conflict",
            message: "This sign-in is no longer pending",
          });
        }
        const callback = validateAntigravityCallbackUrl(pending, value);
        submitted = true;
        try {
          await forwardAntigravityCallback(callback, signal);
        } catch {
          await finish({ detail: "Could not deliver the sign-in response", status: "failed" });
        }
      },
    };
  }

  #requireRuntime(): PreparedAntigravityRuntime {
    if (!this.#runtime) throw new Error("Antigravity runtime has not been prepared");
    return this.#runtime;
  }

  async #scratchDirectory(providerState: HarnessProviderState, purpose: string): Promise<string> {
    await mkdir(providerState.privateStateRoot, { mode: 0o700, recursive: true });
    return mkdtemp(join(providerState.privateStateRoot, `antigravity-${purpose}-`));
  }
}

function looksLikeAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /sign.?in|authenticat|subscription_required|-32000/i.test(message);
}

class AntigravityAdapter implements HarnessAdapter {
  readonly capabilities = antigravityHarnessCapabilities;
  readonly instanceId: HarnessDriverCreateContext["instanceId"];
  readonly #adapter: AcpHarnessAdapter;
  readonly #authMethod: AntigravityAuthMethod;
  readonly #config: AntigravityHarnessConfig;
  readonly #options: AntigravityHarnessDriverOptions;
  readonly #runtime: PreparedAntigravityRuntime;

  constructor(
    instanceId: HarnessDriverCreateContext["instanceId"],
    config: AntigravityHarnessConfig,
    authMethod: AntigravityAuthMethod,
    options: AntigravityHarnessDriverOptions,
    runtime: PreparedAntigravityRuntime,
  ) {
    this.instanceId = instanceId;
    this.#authMethod = authMethod;
    this.#config = config;
    this.#options = options;
    this.#runtime = runtime;
    this.#adapter = new AcpHarnessAdapter(instanceId, {
      capabilities: antigravityHarnessCapabilities,
      engineLabel: "Antigravity",
      hooks: {
        authenticationMethod: () => this.#authMethod,
        classifyError: classifyAntigravityAcpError,
        generateTitle: (context, input) => this.#generateTitle(context, input),
        holdAssistant: {
          deadlineMs: 500,
          maxCharacters: 2_048,
          settle: settleAntigravityHeldAssistant,
        },
        normalizeUpdate: normalizeAntigravityUpdate,
        permissionChoices,
        transformStdout: (stdout) => transformAntigravityStdout(stdout),
      },
      launch: ({ context }) => this.#launch(context),
      maxEventBytes: 32 * 1_024 * 1_024,
      maxEventItems: 20_000,
      policy: antigravitySessionPolicy(runtime.protocolVersion),
    });
  }

  async startSession(context: HarnessSessionContext): Promise<HarnessSession> {
    assertNativeUser(context);
    const session = await this.#adapter.startSession(context);
    this.#assertSessionReference(session.providerSessionReference);
    return session;
  }

  async resumeSession(
    providerSessionReference: string,
    context: HarnessSessionContext,
  ): Promise<HarnessSession> {
    assertNativeUser(context);
    this.#assertSessionReference(providerSessionReference);
    const session = await this.#adapter.resumeSession(providerSessionReference, context);
    this.#assertSessionReference(session.providerSessionReference);
    return session;
  }

  close(): Promise<void> {
    return this.#adapter.close();
  }

  async #launch(context: HarnessSessionContext): Promise<HarnessProcessLaunch> {
    assertNativeUser(context);
    const apiKey = await apiKeyFile(context.providerState).read();
    const launch = await prepareAntigravityLaunch({
      ...(apiKey ? { apiKey } : {}),
      authMethod: this.#authMethod,
      baseEnvironment: context.environment,
      config: this.#config,
      nodeExecutable: this.#options.nodeExecutable,
      providerState: context.providerState,
      runtime: this.#runtime,
    });
    return { ...launch, cwd: context.workspacePath };
  }

  #assertSessionReference(value: string): void {
    if (!isNativeAntigravitySessionId(value)) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Invalid Antigravity session reference",
      });
    }
  }

  async #generateTitle(context: HarnessSessionContext, input: HarnessTitleInput): Promise<string> {
    await mkdir(context.providerState.privateStateRoot, { mode: 0o700, recursive: true });
    const scratch = await mkdtemp(
      join(context.providerState.privateStateRoot, "antigravity-title-"),
    );
    try {
      const workspace = join(scratch, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      const apiKey = await apiKeyFile(context.providerState).read();
      const base = await prepareAntigravityTitleLaunch({
        ...(apiKey ? { apiKey } : {}),
        authMethod: this.#authMethod,
        baseEnvironment: context.environment,
        config: this.#config,
        directory: scratch,
        nodeExecutable: this.#options.nodeExecutable,
        providerState: context.providerState,
        runtime: this.#runtime,
      });
      const launch: HarnessProcessLaunch = context.wrapProcessLaunch({ ...base, cwd: workspace });
      const generated = await generateContainedAcpTitle({
        authenticationMethod: this.#authMethod,
        clientInfo: { name: "zed", version: "0.0.0" },
        initializeDeadlineMs,
        launch,
        modeId: "default",
        onSessionId: (value) => {
          this.#assertSessionReference(value);
        },
        prompt: [
          "Name this Thread from only the input below.",
          "Return only a short title.",
          "",
          input.prompt,
        ].join("\n"),
        protocolVersion: this.#runtime.protocolVersion,
        sessionMetadata: { antigravity: { enabledTools: [] } },
        signal: input.signal,
        transformStdout: (stdout) => transformAntigravityStdout(stdout),
      });
      if ((await readdir(workspace)).length > 0) {
        throw new Error("Antigravity wrote workspace files while naming the Thread");
      }
      return generated.text;
    } finally {
      await rm(scratch, { force: true, recursive: true });
    }
  }
}
