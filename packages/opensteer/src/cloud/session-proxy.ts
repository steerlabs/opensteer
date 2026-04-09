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
import { syncLocalRegistryToCloud } from "./registry-sync.js";

const TEMPORARY_CLOUD_WORKSPACE_PREFIX = "opensteer-cloud-workspace-";

export interface CloudSessionProxyOptions {
  readonly rootDir?: string;
  readonly rootPath?: string;
  readonly workspace?: string;
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
  private sessionId: string | undefined;
  private semanticGrant: OpensteerSessionGrant | undefined;
  private client: OpensteerSemanticRestClient | undefined;
  private automation: OpensteerCloudAutomationClient | undefined;
  private workspaceStore: FilesystemOpensteerWorkspace | undefined;

  constructor(cloud: OpensteerCloudClient, options: CloudSessionProxyOptions = {}) {
    this.cloud = cloud;
    this.workspace = options.workspace;
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
    await this.ensureSession({
      ...(input.browser === undefined ? {} : { browser: input.browser }),
      ...(input.launch === undefined ? {} : { launch: input.launch }),
      ...(input.context === undefined ? {} : { context: input.context }),
    });
    return this.requireClient().invoke("session.open", {
      ...(input.url === undefined ? {} : { url: input.url }),
    });
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
    await this.ensureSession();
    return this.requireClient().invoke("page.list", input);
  }

  async newPage(input: OpensteerPageNewInput = {}): Promise<OpensteerPageNewOutput> {
    await this.ensureSession();
    return this.requireAutomation().invoke("page.new", input);
  }

  async activatePage(input: OpensteerPageActivateInput): Promise<OpensteerPageActivateOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.activate", input);
  }

  async closePage(input: OpensteerPageCloseInput = {}): Promise<OpensteerPageCloseOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.close", input);
  }

  async goto(input: OpensteerPageGotoInput): Promise<OpensteerPageGotoOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.goto", input);
  }

  async evaluate(input: OpensteerPageEvaluateInput): Promise<OpensteerPageEvaluateOutput> {
    await this.ensureSession();
    return this.requireAutomation().invoke("page.evaluate", input);
  }

  async addInitScript(input: OpensteerAddInitScriptInput): Promise<OpensteerAddInitScriptOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.add-init-script", input);
  }

  async snapshot(input: OpensteerPageSnapshotInput = {}): Promise<OpensteerPageSnapshotOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.snapshot", input);
  }

  async click(input: OpensteerDomClickInput): Promise<OpensteerActionResult> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.click", input);
  }

  async hover(input: OpensteerDomHoverInput): Promise<OpensteerActionResult> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.hover", input);
  }

  async input(input: OpensteerDomInputInput): Promise<OpensteerActionResult> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.input", input);
  }

  async scroll(input: OpensteerDomScrollInput): Promise<OpensteerActionResult> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.scroll", input);
  }

  async extract(input: OpensteerDomExtractInput): Promise<OpensteerDomExtractOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("dom.extract", input);
  }

  async queryNetwork(input: OpensteerNetworkQueryInput = {}): Promise<OpensteerNetworkQueryOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("network.query", input);
  }

  async getNetworkDetail(input: {
    readonly recordId: string;
    readonly probe?: boolean;
  }): Promise<OpensteerNetworkDetailOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("network.detail", input);
  }

  async captureInteraction(
    input: OpensteerInteractionCaptureInput,
  ): Promise<OpensteerInteractionCaptureOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("interaction.capture", input);
  }

  async getInteraction(
    input: OpensteerInteractionGetInput,
  ): Promise<OpensteerInteractionGetOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("interaction.get", input);
  }

  async diffInteraction(
    input: OpensteerInteractionDiffInput,
  ): Promise<OpensteerInteractionDiffOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("interaction.diff", input);
  }

  async replayInteraction(
    input: OpensteerInteractionReplayInput,
  ): Promise<OpensteerInteractionReplayOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("interaction.replay", input);
  }

  async captureScripts(
    input: OpensteerCaptureScriptsInput = {},
  ): Promise<OpensteerCaptureScriptsOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("scripts.capture", input);
  }

  async readArtifact(input: OpensteerArtifactReadInput): Promise<OpensteerArtifactReadOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("artifact.read", input);
  }

  async beautifyScript(
    input: OpensteerScriptBeautifyInput,
  ): Promise<OpensteerScriptBeautifyOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("scripts.beautify", input);
  }

  async deobfuscateScript(
    input: OpensteerScriptDeobfuscateInput,
  ): Promise<OpensteerScriptDeobfuscateOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("scripts.deobfuscate", input);
  }

  async sandboxScript(input: OpensteerScriptSandboxInput): Promise<OpensteerScriptSandboxOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("scripts.sandbox", input);
  }

  async solveCaptcha(input: OpensteerCaptchaSolveInput): Promise<OpensteerCaptchaSolveOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("captcha.solve", input);
  }

  async getCookies(input: OpensteerCookieQueryInput = {}): Promise<OpensteerCookieQueryOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("session.cookies", input);
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
    await this.ensureSession();
    return this.requireClient().invoke("session.storage", input);
  }

  async getBrowserState(input: OpensteerStateQueryInput = {}): Promise<OpensteerStateQueryOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("session.state", input);
  }

  async fetch(input: OpensteerSessionFetchInput): Promise<OpensteerSessionFetchOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("session.fetch", input);
  }

  async computerExecute(
    input: OpensteerComputerExecuteInput,
  ): Promise<OpensteerComputerExecuteOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("computer.execute", input);
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

    return { closed: true };
  }

  async disconnect(): Promise<void> {
    if (this.cleanupRootOnClose) {
      await this.close();
      return;
    }

    this.client = undefined;
    await this.automation?.close().catch(() => undefined);
    this.automation = undefined;
    this.sessionId = undefined;
    this.semanticGrant = undefined;
  }

  private async ensureSession(input: CloudSessionInitInput = {}): Promise<void> {
    if (this.client) {
      return;
    }

    assertSupportedCloudBrowserMode(input.browser);
    const localCloud = this.shouldUseLocalCloudTransport();
    const browserProfile = resolveCloudBrowserProfile(this.cloud, input);

    const persisted = await this.loadPersistedSession();
    if (persisted !== undefined && (await this.isReusableCloudSession(persisted.sessionId))) {
      if (localCloud) {
        void this.syncRegistryToCloud();
      } else {
        await this.syncRegistryToCloud();
      }
      this.bindClient(persisted);
      return;
    }

    if (localCloud) {
      void this.syncRegistryToCloud();
    } else {
      await this.syncRegistryToCloud();
    }

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
            locality: "auto",
          }
        : baseCreateInput;
    const session = await this.cloud.createSession(createInput);
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

  private async syncRegistryToCloud(): Promise<void> {
    if (this.workspace === undefined) {
      return;
    }

    try {
      const workspaceStore = await this.ensureWorkspaceStore();
      await syncLocalRegistryToCloud(this.cloud, this.workspace, workspaceStore);
    } catch {}
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

  private async isReusableCloudSession(sessionId: string): Promise<boolean> {
    try {
      const session = await this.cloud.getSession(sessionId);
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

  private async ensureSemanticGrant(forceRefresh = false): Promise<OpensteerSessionGrant> {
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

    const issued = await this.cloud.issueAccess(this.sessionId, ["semantic"]);
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
