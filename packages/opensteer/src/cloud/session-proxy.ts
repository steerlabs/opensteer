import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPENSTEER_RUNTIME_CORE_VERSION } from "@opensteer/runtime-core";

import type {
  OpensteerArtifactReadInput,
  OpensteerArtifactReadOutput,
  OpensteerAddInitScriptInput,
  OpensteerAddInitScriptOutput,
  OpensteerCaptchaSolveInput,
  OpensteerCaptchaSolveOutput,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerCaptureScriptsInput,
  OpensteerCaptureScriptsOutput,
  OpensteerDomClickInput,
  OpensteerDomExtractInput,
  OpensteerDomExtractOutput,
  OpensteerDomHoverInput,
  OpensteerDomInputInput,
  OpensteerDomScrollInput,
  OpensteerNetworkDetailInput,
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkDetailOutput,
  OpensteerInteractionCaptureInput,
  OpensteerInteractionCaptureOutput,
  OpensteerInteractionDiffInput,
  OpensteerInteractionDiffOutput,
  OpensteerInteractionGetInput,
  OpensteerInteractionGetOutput,
  OpensteerInteractionReplayInput,
  OpensteerInteractionReplayOutput,
  OpensteerOpenInput,
  OpensteerOpenOutput,
  OpensteerPageActivateInput,
  OpensteerPageActivateOutput,
  OpensteerPageCloseInput,
  OpensteerPageCloseOutput,
  OpensteerPageEvaluateInput,
  OpensteerPageEvaluateOutput,
  OpensteerPageGotoInput,
  OpensteerPageGotoOutput,
  OpensteerPageListInput,
  OpensteerPageListOutput,
  OpensteerPageNewInput,
  OpensteerPageNewOutput,
  OpensteerPageSnapshotInput,
  OpensteerPageSnapshotOutput,
  OpensteerSessionInfo,
  OpensteerSessionFetchInput,
  OpensteerSessionFetchOutput,
  OpensteerScriptBeautifyInput,
  OpensteerScriptBeautifyOutput,
  OpensteerScriptDeobfuscateInput,
  OpensteerScriptDeobfuscateOutput,
  OpensteerScriptSandboxInput,
  OpensteerScriptSandboxOutput,
  OpensteerSessionCloseOutput,
  OpensteerActionResult,
  OpensteerCookieQueryInput,
  OpensteerCookieQueryOutput,
  OpensteerSessionGrant,
  OpensteerSemanticOperationName,
  OpensteerStateQueryInput,
  OpensteerStateQueryOutput,
  OpensteerStorageQueryInput,
  OpensteerStorageQueryOutput,
  ObservabilityConfig,
} from "@opensteer/protocol";
import {
  OPENSTEER_PROTOCOL_VERSION,
  opensteerExposedSemanticOperationNames,
} from "@opensteer/protocol";
import type { CloudBrowserProfilePreference } from "@opensteer/protocol";
import {
  clearPersistedSessionRecord,
  readPersistedCloudSessionRecord,
  resolveCloudSessionRecordPath,
  writePersistedSessionRecord,
  type PersistedCloudSessionRecord,
} from "../live-session.js";
import {
  createFilesystemOpensteerWorkspace,
  resolveFilesystemWorkspacePath,
  type FilesystemOpensteerWorkspace,
} from "../root.js";
import {
  defaultPolicy,
  runWithPolicyTimeout,
  type OpensteerPolicy,
  type TimeoutExecutionContext,
} from "../policy/index.js";
import type {
  OpensteerInterceptScriptOptions,
  OpensteerRouteOptions,
  OpensteerRouteRegistration,
} from "../sdk/instrumentation.js";
import {
  OpensteerSemanticRestClient,
  OpensteerSemanticRestError,
} from "../sdk/semantic-rest-client.js";
import type { OpensteerDisconnectableRuntime } from "../sdk/semantic-runtime.js";
import { OpensteerCloudAutomationClient } from "./automation-client.js";
import type { OpensteerCloudSessionCreateInput } from "./client.js";
import { OpensteerCloudClient } from "./client.js";
import { syncLocalWorkspaceToCloud } from "./workspace-sync.js";

const TEMPORARY_CLOUD_WORKSPACE_PREFIX = "opensteer-cloud-workspace-";

export interface CloudSessionProxyOptions {
  readonly rootDir?: string;
  readonly rootPath?: string;
  readonly workspace?: string;
  readonly policy?: OpensteerPolicy;
  readonly cleanupRootOnClose?: boolean;
  readonly observability?: Partial<ObservabilityConfig>;
}

interface CloudSessionInitInput {
  readonly browser?: OpensteerOpenInput["browser"];
  readonly launch?: OpensteerOpenInput["launch"];
  readonly context?: OpensteerOpenInput["context"];
  readonly browserProfile?: CloudBrowserProfilePreference;
}

export { readPersistedCloudSessionRecord, resolveCloudSessionRecordPath };
export type { PersistedCloudSessionRecord };

export class CloudSessionProxy implements OpensteerDisconnectableRuntime {
  readonly rootPath: string;
  readonly workspace: string | undefined;

  private readonly cleanupRootOnClose: boolean;
  private readonly cloud: OpensteerCloudClient;
  private readonly observability: Partial<ObservabilityConfig> | undefined;
  private readonly policy: OpensteerPolicy;
  private sessionId: string | undefined;
  private semanticGrant: OpensteerSessionGrant | undefined;
  private client: OpensteerSemanticRestClient | undefined;
  private automation: OpensteerCloudAutomationClient | undefined;
  private workspaceStore: FilesystemOpensteerWorkspace | undefined;
  private syncWorkspaceOnClose = false;

  constructor(cloud: OpensteerCloudClient, options: CloudSessionProxyOptions = {}) {
    this.cloud = cloud;
    this.workspace = options.workspace;
    this.policy = options.policy ?? defaultPolicy();
    this.observability = options.observability;
    this.rootPath =
      options.rootPath ??
      (this.workspace === undefined
        ? path.join(tmpdir(), `${TEMPORARY_CLOUD_WORKSPACE_PREFIX}${randomUUID()}`)
        : resolveFilesystemWorkspacePath({
            rootDir: path.resolve(options.rootDir ?? process.cwd()),
            workspace: this.workspace,
          }));
    this.cleanupRootOnClose = options.cleanupRootOnClose ?? this.workspace === undefined;
  }

  async open(input: OpensteerOpenInput = {}): Promise<OpensteerOpenOutput> {
    return this.invokeSemanticOperation(
      "session.open",
      {
      ...(input.url === undefined ? {} : { url: input.url }),
      },
      {
        ...(input.browser === undefined ? {} : { browser: input.browser }),
        ...(input.launch === undefined ? {} : { launch: input.launch }),
        ...(input.context === undefined ? {} : { context: input.context }),
      },
    );
  }

  async info(): Promise<OpensteerSessionInfo> {
    const persisted =
      this.client !== undefined || this.sessionId !== undefined
        ? undefined
        : await this.loadPersistedSession();

    if (
      this.client === undefined &&
      this.sessionId === undefined &&
      persisted !== undefined &&
      (await this.isReusableCloudSession(persisted.sessionId))
    ) {
      this.bindClient(persisted);
    }

    if (this.automation) {
      try {
        const sessionInfo = await this.automation.getSessionInfo();
        return {
          ...sessionInfo,
          ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
        };
      } catch {
        // Fall back to local proxy metadata when the automation channel is unavailable.
      }
    }

    return {
      provider: {
        mode: "cloud",
        ownership: "managed",
        engine: "playwright",
        baseUrl: this.cloud.getConfig().baseUrl,
      },
      ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
      ...(this.sessionId === undefined
        ? persisted?.sessionId === undefined
          ? {}
          : { sessionId: persisted.sessionId }
        : { sessionId: this.sessionId }),
      reconnectable:
        this.workspace !== undefined || this.sessionId !== undefined || persisted !== undefined,
      capabilities: {
        semanticOperations: opensteerExposedSemanticOperationNames,
        sessionGrants: ["semantic", "automation", "view", "cdp"],
        instrumentation: {
          route: true,
          interceptScript: true,
          networkStream: true,
        },
      },
      runtime: {
        protocolVersion: OPENSTEER_PROTOCOL_VERSION,
        runtimeCoreVersion: OPENSTEER_RUNTIME_CORE_VERSION,
      },
    };
  }

  async listPages(input: OpensteerPageListInput = {}): Promise<OpensteerPageListOutput> {
    return this.invokeSemanticOperation("page.list", input);
  }

  async newPage(input: OpensteerPageNewInput = {}): Promise<OpensteerPageNewOutput> {
    return this.invokeAutomationOperation("page.new", (automation) =>
      automation.invoke("page.new", input),
    );
  }

  async activatePage(input: OpensteerPageActivateInput): Promise<OpensteerPageActivateOutput> {
    return this.invokeSemanticOperation("page.activate", input);
  }

  async closePage(input: OpensteerPageCloseInput = {}): Promise<OpensteerPageCloseOutput> {
    return this.invokeSemanticOperation("page.close", input);
  }

  async goto(input: OpensteerPageGotoInput): Promise<OpensteerPageGotoOutput> {
    return this.invokeSemanticOperation("page.goto", input);
  }

  async evaluate(input: OpensteerPageEvaluateInput): Promise<OpensteerPageEvaluateOutput> {
    return this.invokeAutomationOperation("page.evaluate", (automation) =>
      automation.invoke("page.evaluate", input),
    );
  }

  async addInitScript(input: OpensteerAddInitScriptInput): Promise<OpensteerAddInitScriptOutput> {
    return this.invokeSemanticOperation("page.add-init-script", input);
  }

  async snapshot(input: OpensteerPageSnapshotInput = {}): Promise<OpensteerPageSnapshotOutput> {
    return this.invokeSemanticOperation("page.snapshot", input);
  }

  async click(input: OpensteerDomClickInput): Promise<OpensteerActionResult> {
    return this.invokeSemanticOperation("dom.click", input);
  }

  async hover(input: OpensteerDomHoverInput): Promise<OpensteerActionResult> {
    return this.invokeSemanticOperation("dom.hover", input);
  }

  async input(input: OpensteerDomInputInput): Promise<OpensteerActionResult> {
    return this.invokeSemanticOperation("dom.input", input);
  }

  async scroll(input: OpensteerDomScrollInput): Promise<OpensteerActionResult> {
    return this.invokeSemanticOperation("dom.scroll", input);
  }

  async extract(input: OpensteerDomExtractInput): Promise<OpensteerDomExtractOutput> {
    return this.invokeSemanticOperation("dom.extract", input);
  }

  async queryNetwork(input: OpensteerNetworkQueryInput = {}): Promise<OpensteerNetworkQueryOutput> {
    return this.invokeSemanticOperation("network.query", input);
  }

  async getNetworkDetail(
    input: OpensteerNetworkDetailInput,
  ): Promise<OpensteerNetworkDetailOutput> {
    return this.invokeSemanticOperation("network.detail", input);
  }

  async captureInteraction(
    input: OpensteerInteractionCaptureInput,
  ): Promise<OpensteerInteractionCaptureOutput> {
    return this.invokeSemanticOperation("interaction.capture", input);
  }

  async getInteraction(
    input: OpensteerInteractionGetInput,
  ): Promise<OpensteerInteractionGetOutput> {
    return this.invokeSemanticOperation("interaction.get", input);
  }

  async diffInteraction(
    input: OpensteerInteractionDiffInput,
  ): Promise<OpensteerInteractionDiffOutput> {
    return this.invokeSemanticOperation("interaction.diff", input);
  }

  async replayInteraction(
    input: OpensteerInteractionReplayInput,
  ): Promise<OpensteerInteractionReplayOutput> {
    return this.invokeSemanticOperation("interaction.replay", input);
  }

  async captureScripts(
    input: OpensteerCaptureScriptsInput = {},
  ): Promise<OpensteerCaptureScriptsOutput> {
    return this.invokeSemanticOperation("scripts.capture", input);
  }

  async readArtifact(input: OpensteerArtifactReadInput): Promise<OpensteerArtifactReadOutput> {
    return this.invokeSemanticOperation("artifact.read", input);
  }

  async beautifyScript(
    input: OpensteerScriptBeautifyInput,
  ): Promise<OpensteerScriptBeautifyOutput> {
    return this.invokeSemanticOperation("scripts.beautify", input);
  }

  async deobfuscateScript(
    input: OpensteerScriptDeobfuscateInput,
  ): Promise<OpensteerScriptDeobfuscateOutput> {
    return this.invokeSemanticOperation("scripts.deobfuscate", input);
  }

  async sandboxScript(input: OpensteerScriptSandboxInput): Promise<OpensteerScriptSandboxOutput> {
    return this.invokeSemanticOperation("scripts.sandbox", input);
  }

  async solveCaptcha(input: OpensteerCaptchaSolveInput): Promise<OpensteerCaptchaSolveOutput> {
    return this.invokeSemanticOperation("captcha.solve", input);
  }

  async getCookies(input: OpensteerCookieQueryInput = {}): Promise<OpensteerCookieQueryOutput> {
    return this.invokeSemanticOperation("session.cookies", input);
  }

  async route(input: OpensteerRouteOptions): Promise<OpensteerRouteRegistration> {
    await this.ensureSession();
    return this.requireAutomation().route(input);
  }

  async interceptScript(
    input: OpensteerInterceptScriptOptions,
  ): Promise<OpensteerRouteRegistration> {
    await this.ensureSession();
    return this.requireAutomation().interceptScript(input);
  }

  async getStorageSnapshot(
    input: OpensteerStorageQueryInput = {},
  ): Promise<OpensteerStorageQueryOutput> {
    return this.invokeSemanticOperation("session.storage", input);
  }

  async getBrowserState(input: OpensteerStateQueryInput = {}): Promise<OpensteerStateQueryOutput> {
    return this.invokeSemanticOperation("session.state", input);
  }

  async fetch(input: OpensteerSessionFetchInput): Promise<OpensteerSessionFetchOutput> {
    return this.invokeSemanticOperation("session.fetch", input);
  }

  async computerExecute(
    input: OpensteerComputerExecuteInput,
  ): Promise<OpensteerComputerExecuteOutput> {
    return this.invokeSemanticOperation("computer.execute", input);
  }

  async close(): Promise<OpensteerSessionCloseOutput> {
    const session =
      (await this.loadPersistedSession()) ??
      (this.sessionId === undefined
        ? undefined
        : {
            layout: "opensteer-session" as const,
            version: 1 as const,
            provider: "cloud" as const,
            ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
            sessionId: this.sessionId,
            startedAt: Date.now(),
            updatedAt: Date.now(),
          });

    let syncError: unknown;
    if (this.syncWorkspaceOnClose) {
      try {
        await this.syncWorkspaceToCloud();
      } catch (error) {
        syncError = error;
      }
    }

    try {
      if (session !== undefined) {
        await this.cloud.closeSession(session.sessionId).catch((error) => {
          if (isMissingCloudSessionError(error)) {
            return;
          }
          throw error;
        });
      }
    } finally {
      await this.automation?.close().catch(() => undefined);
      await this.clearPersistedSession();
      this.automation = undefined;
      this.client = undefined;
      this.sessionId = undefined;
      this.semanticGrant = undefined;
      if (this.cleanupRootOnClose) {
        await rm(this.rootPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    if (syncError !== undefined) {
      throw syncError;
    }

    return { closed: true };
  }

  async disconnect(): Promise<void> {
    if (this.cleanupRootOnClose) {
      await this.close();
      return;
    }

    let syncError: unknown;
    if (this.syncWorkspaceOnClose) {
      try {
        await this.syncWorkspaceToCloud();
      } catch (error) {
        syncError = error;
      }
    }

    this.client = undefined;
    await this.automation?.close().catch(() => undefined);
    this.automation = undefined;
    this.sessionId = undefined;
    this.semanticGrant = undefined;

    if (syncError !== undefined) {
      throw syncError;
    }
  }

  private async ensureSession(
    input: CloudSessionInitInput = {},
    timeout?: TimeoutExecutionContext,
  ): Promise<void> {
    if (this.client) {
      return;
    }

    assertSupportedCloudBrowserMode(input.browser);
    const localCloud = this.shouldUseLocalCloudTransport();
    this.syncWorkspaceOnClose = localCloud && this.workspace !== undefined;
    const browserProfile = resolveCloudBrowserProfile(this.cloud, input);

    const persisted = await this.loadPersistedSession();
    if (
      persisted !== undefined &&
      (await this.isReusableCloudSession(persisted.sessionId, timeout))
    ) {
      await this.syncWorkspaceToCloud();
      this.bindClient(persisted);
      return;
    }

    await this.syncWorkspaceToCloud();

    const baseCreateInput: OpensteerCloudSessionCreateInput = {
      ...(this.workspace === undefined ? {} : { name: this.workspace }),
      ...(input.launch === undefined ? {} : { browser: input.launch }),
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(this.observability === undefined ? {} : { observability: this.observability }),
      ...(browserProfile === undefined ? {} : { browserProfile }),
    };
    const createInput: OpensteerCloudSessionCreateInput =
      localCloud && this.workspace !== undefined
        ? {
            ...baseCreateInput,
            sourceType: "local-cloud",
            sourceRef: this.workspace,
            localWorkspaceRootPath: this.rootPath,
          }
        : baseCreateInput;
    const session = await this.cloud.createSession(createInput, {
      signal: timeout?.signal,
      timeoutMs: timeout?.remainingMs(),
    });
    const record: PersistedCloudSessionRecord = {
      layout: "opensteer-session",
      version: 1,
      provider: "cloud",
      ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
      sessionId: session.sessionId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.writePersistedSession(record);
    this.bindClient(record, session.initialGrants?.semantic);
  }

  private async syncWorkspaceToCloud(): Promise<void> {
    if (this.workspace === undefined) {
      return;
    }

    const workspaceStore = await this.ensureWorkspaceStore();
    await syncLocalWorkspaceToCloud(this.cloud, this.workspace, workspaceStore);
  }

  private bindClient(
    record: Pick<PersistedCloudSessionRecord, "sessionId">,
    initialSemanticGrant?: OpensteerSessionGrant,
  ): void {
    this.sessionId = record.sessionId;
    this.semanticGrant =
      initialSemanticGrant?.kind === "semantic" ? initialSemanticGrant : undefined;
    this.client = new OpensteerSemanticRestClient({
      getBaseUrl: async () => (await this.ensureSemanticGrant()).url,
      getAuthorizationHeader: async () => `Bearer ${(await this.ensureSemanticGrant()).token}`,
      handleError: (error) => this.handleSemanticClientError(error),
    });
    this.automation = new OpensteerCloudAutomationClient(this.cloud, record.sessionId);
  }

  private async ensureWorkspaceStore(): Promise<FilesystemOpensteerWorkspace> {
    if (this.workspaceStore !== undefined) {
      return this.workspaceStore;
    }

    this.workspaceStore = await createFilesystemOpensteerWorkspace({
      rootPath: this.rootPath,
      ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
      scope: this.workspace === undefined ? "temporary" : "workspace",
    });
    return this.workspaceStore;
  }

  private async loadPersistedSession(): Promise<PersistedCloudSessionRecord | undefined> {
    const workspace = await this.ensureWorkspaceStore();
    return readPersistedCloudSessionRecord(workspace.rootPath);
  }

  private async writePersistedSession(record: PersistedCloudSessionRecord): Promise<void> {
    const workspace = await this.ensureWorkspaceStore();
    await writePersistedSessionRecord(workspace.rootPath, record);
  }

  private async clearPersistedSession(): Promise<void> {
    await clearPersistedSessionRecord(this.rootPath, "cloud").catch(() => undefined);
  }

  private async isReusableCloudSession(
    sessionId: string,
    timeout?: TimeoutExecutionContext,
  ): Promise<boolean> {
    try {
      const session = await this.cloud.getSession(sessionId, {
        signal: timeout?.signal,
        timeoutMs: timeout?.remainingMs(),
      });
      return session.status !== "closed" && session.status !== "failed";
    } catch (error) {
      if (isMissingCloudSessionError(error)) {
        return false;
      }
      throw error;
    }
  }

  private requireClient(): OpensteerSemanticRestClient {
    if (!this.client) {
      throw new Error("Cloud session has not been initialized.");
    }
    return this.client;
  }

  private requireAutomation(): OpensteerCloudAutomationClient {
    if (!this.automation) {
      throw new Error("Cloud automation session has not been initialized.");
    }
    return this.automation;
  }

  private async ensureSemanticGrant(
    forceRefresh = false,
    timeout?: TimeoutExecutionContext,
  ): Promise<OpensteerSessionGrant> {
    if (
      !forceRefresh &&
      this.semanticGrant?.kind === "semantic" &&
      this.semanticGrant.expiresAt > Date.now() + 10_000
    ) {
      return this.semanticGrant;
    }

    if (!this.sessionId) {
      throw new Error("Cloud session has not been initialized.");
    }

    const issued = await this.cloud.issueAccess(this.sessionId, ["semantic"], {
      signal: timeout?.signal,
      timeoutMs: timeout?.remainingMs(),
    });
    const grant = issued.grants.semantic;
    if (!grant || grant.transport !== "http") {
      throw new Error("cloud did not issue a valid semantic grant");
    }

    this.semanticGrant = grant;
    return grant;
  }

  private async handleSemanticClientError(error: unknown): Promise<boolean> {
    if (!(error instanceof OpensteerSemanticRestError)) {
      return false;
    }

    if (error.statusCode !== 401 && error.statusCode !== 404) {
      return false;
    }

    this.semanticGrant = undefined;
    try {
      await this.ensureSemanticGrant(true);
      return true;
    } catch {
      return false;
    }
  }

  private async invokeSemanticOperation<TInput, TOutput>(
    operation: OpensteerSemanticOperationName,
    input: TInput,
    sessionInit: CloudSessionInitInput = {},
  ): Promise<TOutput> {
    return this.runOperationWithPolicy(operation, async (timeout) => {
      await this.ensureSession(sessionInit, timeout);
      await this.ensureSemanticGrant(false, timeout);
      return this.requireClient().invoke(operation, input, {
        signal: timeout.signal,
        timeoutMs: timeout.remainingMs(),
      });
    });
  }

  private async invokeAutomationOperation<TOutput>(
    operation: OpensteerSemanticOperationName,
    invoke: (automation: OpensteerCloudAutomationClient) => Promise<TOutput>,
    sessionInit: CloudSessionInitInput = {},
  ): Promise<TOutput> {
    return this.runOperationWithPolicy(operation, async (timeout) => {
      await this.ensureSession(sessionInit, timeout);
      return invoke(this.requireAutomation());
    });
  }

  private async runOperationWithPolicy<T>(
    operation: OpensteerSemanticOperationName,
    invoke: (timeout: TimeoutExecutionContext) => Promise<T>,
  ): Promise<T> {
    return runWithPolicyTimeout(this.policy.timeout, { operation }, invoke);
  }

  private shouldUseLocalCloudTransport(): boolean {
    if (this.workspace === undefined) {
      return false;
    }

    const config = this.cloud.getConfig();
    return isLoopbackBaseUrl(config.baseUrl);
  }
}

function resolveCloudBrowserProfile(
  cloud: OpensteerCloudClient,
  input: CloudSessionInitInput,
): CloudBrowserProfilePreference | undefined {
  return input.browserProfile ?? cloud.getConfig().browserProfile;
}

function assertSupportedCloudBrowserMode(browser: OpensteerOpenInput["browser"] | undefined): void {
  if (browser === undefined || browser === "temporary" || browser === "persistent") {
    return;
  }

  if (typeof browser === "object" && browser.mode === "attach") {
    throw new Error('Cloud mode does not support browser.mode="attach".');
  }
}

function isMissingCloudSessionError(error: unknown): boolean {
  return error instanceof Error && /\b404\b/.test(error.message);
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }

  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  );
}
