import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { OpensteerProtocolError } from "@opensteer/protocol";
import type {
  OpensteerArtifactReadInput,
  OpensteerArtifactReadOutput,
  CookieRecord,
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
  OpensteerGetRecipeInput,
  OpensteerGetAuthRecipeInput,
  OpensteerGetRequestPlanInput,
  OpensteerInferRequestPlanInput,
  OpensteerListRecipesInput,
  OpensteerListRecipesOutput,
  OpensteerListAuthRecipesInput,
  OpensteerListAuthRecipesOutput,
  OpensteerListRequestPlansInput,
  OpensteerListRequestPlansOutput,
  OpensteerNetworkClearInput,
  OpensteerNetworkClearOutput,
  OpensteerNetworkDiffInput,
  OpensteerNetworkDiffOutput,
  OpensteerNetworkMinimizeInput,
  OpensteerNetworkMinimizeOutput,
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkSaveInput,
  OpensteerNetworkSaveOutput,
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
  OpensteerRawRequestInput,
  OpensteerRawRequestOutput,
  OpensteerRequestExecuteInput,
  OpensteerRequestExecuteOutput,
  OpensteerRunRecipeInput,
  OpensteerRunRecipeOutput,
  OpensteerRunAuthRecipeInput,
  OpensteerRunAuthRecipeOutput,
  OpensteerScriptBeautifyInput,
  OpensteerScriptBeautifyOutput,
  OpensteerScriptDeobfuscateInput,
  OpensteerScriptDeobfuscateOutput,
  OpensteerScriptSandboxInput,
  OpensteerScriptSandboxOutput,
  OpensteerReverseDiscoverInput,
  OpensteerReverseDiscoverOutput,
  OpensteerReverseExportInput,
  OpensteerReverseExportOutput,
  OpensteerReverseQueryInput,
  OpensteerReverseQueryOutput,
  OpensteerReversePackageCreateInput,
  OpensteerReversePackageCreateOutput,
  OpensteerReversePackageGetInput,
  OpensteerReversePackageGetOutput,
  OpensteerReversePackageListInput,
  OpensteerReversePackageListOutput,
  OpensteerReversePackagePatchInput,
  OpensteerReversePackagePatchOutput,
  OpensteerReversePackageRunInput,
  OpensteerReversePackageRunOutput,
  OpensteerReverseReportInput,
  OpensteerReverseReportOutput,
  OpensteerSessionCloseOutput,
  OpensteerTransportProbeInput,
  OpensteerTransportProbeOutput,
  OpensteerWriteRecipeInput,
  OpensteerWriteAuthRecipeInput,
  OpensteerWriteRequestPlanInput,
  OpensteerActionResult,
  StorageSnapshot,
  OpensteerSemanticOperationName,
} from "@opensteer/protocol";
import type { CloudBrowserProfilePreference } from "@opensteer/cloud-contracts";

import type { AuthRecipeRecord, RecipeRecord, RequestPlanRecord } from "../registry.js";
import {
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
} from "../internal/filesystem.js";
import {
  createFilesystemOpensteerWorkspace,
  resolveFilesystemWorkspacePath,
  type FilesystemOpensteerWorkspace,
} from "../root.js";
import { OpensteerSemanticRestClient } from "../sdk/semantic-rest-client.js";
import type { OpensteerDisconnectableRuntime } from "../sdk/semantic-runtime.js";
import { OpensteerCloudClient } from "./client.js";

const CLOUD_SESSION_LAYOUT = "opensteer-cloud-session";
const CLOUD_SESSION_VERSION = 1;
const TEMPORARY_CLOUD_WORKSPACE_PREFIX = "opensteer-cloud-workspace-";
const SUPPORTED_CLOUD_OPERATIONS = new Set<OpensteerSemanticOperationName>([
  "session.open",
  "page.goto",
  "page.snapshot",
  "dom.click",
  "dom.hover",
  "dom.input",
  "dom.scroll",
  "dom.extract",
  "network.query",
  "network.save",
  "network.clear",
  "request.raw",
  "request-plan.infer",
  "request-plan.write",
  "request-plan.get",
  "request-plan.list",
  "request.execute",
  "computer.execute",
  "session.close",
]);

export interface PersistedCloudSessionRecord {
  readonly layout: typeof CLOUD_SESSION_LAYOUT;
  readonly version: typeof CLOUD_SESSION_VERSION;
  readonly mode: "cloud";
  readonly workspace?: string;
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface CloudSessionProxyOptions {
  readonly rootDir?: string;
  readonly rootPath?: string;
  readonly workspace?: string;
  readonly cleanupRootOnClose?: boolean;
}

interface CloudSessionInitInput {
  readonly browser?: OpensteerOpenInput["browser"];
  readonly launch?: OpensteerOpenInput["launch"];
  readonly context?: OpensteerOpenInput["context"];
  readonly browserProfile?: CloudBrowserProfilePreference;
}

export function resolveCloudSessionRecordPath(rootPath: string): string {
  return path.join(rootPath, "live", "cloud-session.json");
}

export async function readPersistedCloudSessionRecord(
  rootPath: string,
): Promise<PersistedCloudSessionRecord | undefined> {
  const sessionPath = resolveCloudSessionRecordPath(rootPath);
  if (!(await pathExists(sessionPath))) {
    return undefined;
  }

  const parsed = await readJsonFile<Partial<PersistedCloudSessionRecord>>(sessionPath);
  if (
    parsed.layout !== CLOUD_SESSION_LAYOUT ||
    parsed.version !== CLOUD_SESSION_VERSION ||
    parsed.mode !== "cloud" ||
    typeof parsed.sessionId !== "string" ||
    parsed.sessionId.length === 0 ||
    typeof parsed.baseUrl !== "string" ||
    parsed.baseUrl.length === 0 ||
    typeof parsed.startedAt !== "number" ||
    !Number.isFinite(parsed.startedAt) ||
    typeof parsed.updatedAt !== "number" ||
    !Number.isFinite(parsed.updatedAt)
  ) {
    return undefined;
  }

  return {
    layout: CLOUD_SESSION_LAYOUT,
    version: CLOUD_SESSION_VERSION,
    mode: "cloud",
    ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
    sessionId: parsed.sessionId,
    baseUrl: parsed.baseUrl,
    startedAt: parsed.startedAt,
    updatedAt: parsed.updatedAt,
  };
}

export async function hasPersistedCloudSession(rootPath: string): Promise<boolean> {
  return (await readPersistedCloudSessionRecord(rootPath)) !== undefined;
}

export class CloudSessionProxy implements OpensteerDisconnectableRuntime {
  readonly rootPath: string;
  readonly workspace: string | undefined;

  private readonly cleanupRootOnClose: boolean;
  private readonly cloud: OpensteerCloudClient;
  private sessionId: string | undefined;
  private sessionBaseUrl: string | undefined;
  private client: OpensteerSemanticRestClient | undefined;
  private workspaceStore: FilesystemOpensteerWorkspace | undefined;

  constructor(cloud: OpensteerCloudClient, options: CloudSessionProxyOptions = {}) {
    this.cloud = cloud;
    this.workspace = options.workspace;
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

  async listPages(input: OpensteerPageListInput = {}): Promise<OpensteerPageListOutput> {
    throw unsupportedCloudOperation("page.list");
  }

  async newPage(input: OpensteerPageNewInput = {}): Promise<OpensteerPageNewOutput> {
    throw unsupportedCloudOperation("page.new");
  }

  async activatePage(input: OpensteerPageActivateInput): Promise<OpensteerPageActivateOutput> {
    throw unsupportedCloudOperation("page.activate");
  }

  async closePage(input: OpensteerPageCloseInput = {}): Promise<OpensteerPageCloseOutput> {
    throw unsupportedCloudOperation("page.close");
  }

  async goto(input: OpensteerPageGotoInput): Promise<OpensteerPageGotoOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("page.goto", input);
  }

  async evaluate(input: OpensteerPageEvaluateInput): Promise<OpensteerPageEvaluateOutput> {
    throw unsupportedCloudOperation("page.evaluate");
  }

  async addInitScript(input: OpensteerAddInitScriptInput): Promise<OpensteerAddInitScriptOutput> {
    throw unsupportedCloudOperation("page.add-init-script");
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

  async saveNetwork(input: OpensteerNetworkSaveInput): Promise<OpensteerNetworkSaveOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("network.save", input);
  }

  async minimizeNetwork(
    input: OpensteerNetworkMinimizeInput,
  ): Promise<OpensteerNetworkMinimizeOutput> {
    throw unsupportedCloudOperation("network.minimize");
  }

  async diffNetwork(input: OpensteerNetworkDiffInput): Promise<OpensteerNetworkDiffOutput> {
    throw unsupportedCloudOperation("network.diff");
  }

  async probeNetwork(input: OpensteerTransportProbeInput): Promise<OpensteerTransportProbeOutput> {
    throw unsupportedCloudOperation("network.probe");
  }

  async discoverReverse(
    input: OpensteerReverseDiscoverInput,
  ): Promise<OpensteerReverseDiscoverOutput> {
    throw unsupportedCloudOperation("reverse.discover");
  }

  async queryReverse(input: OpensteerReverseQueryInput): Promise<OpensteerReverseQueryOutput> {
    throw unsupportedCloudOperation("reverse.query");
  }

  async createReversePackage(
    input: OpensteerReversePackageCreateInput,
  ): Promise<OpensteerReversePackageCreateOutput> {
    throw unsupportedCloudOperation("reverse.package.create");
  }

  async runReversePackage(
    input: OpensteerReversePackageRunInput,
  ): Promise<OpensteerReversePackageRunOutput> {
    throw unsupportedCloudOperation("reverse.package.run");
  }

  async exportReverse(input: OpensteerReverseExportInput): Promise<OpensteerReverseExportOutput> {
    throw unsupportedCloudOperation("reverse.export");
  }

  async getReverseReport(
    input: OpensteerReverseReportInput,
  ): Promise<OpensteerReverseReportOutput> {
    throw unsupportedCloudOperation("reverse.report");
  }

  async getReversePackage(
    input: OpensteerReversePackageGetInput,
  ): Promise<OpensteerReversePackageGetOutput> {
    throw unsupportedCloudOperation("reverse.package.get");
  }

  async listReversePackages(
    input: OpensteerReversePackageListInput = {},
  ): Promise<OpensteerReversePackageListOutput> {
    throw unsupportedCloudOperation("reverse.package.list");
  }

  async patchReversePackage(
    input: OpensteerReversePackagePatchInput,
  ): Promise<OpensteerReversePackagePatchOutput> {
    throw unsupportedCloudOperation("reverse.package.patch");
  }

  async captureInteraction(
    input: OpensteerInteractionCaptureInput,
  ): Promise<OpensteerInteractionCaptureOutput> {
    throw unsupportedCloudOperation("interaction.capture");
  }

  async getInteraction(
    input: OpensteerInteractionGetInput,
  ): Promise<OpensteerInteractionGetOutput> {
    throw unsupportedCloudOperation("interaction.get");
  }

  async diffInteraction(
    input: OpensteerInteractionDiffInput,
  ): Promise<OpensteerInteractionDiffOutput> {
    throw unsupportedCloudOperation("interaction.diff");
  }

  async replayInteraction(
    input: OpensteerInteractionReplayInput,
  ): Promise<OpensteerInteractionReplayOutput> {
    throw unsupportedCloudOperation("interaction.replay");
  }

  async clearNetwork(input: OpensteerNetworkClearInput = {}): Promise<OpensteerNetworkClearOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("network.clear", input);
  }

  async captureScripts(
    input: OpensteerCaptureScriptsInput = {},
  ): Promise<OpensteerCaptureScriptsOutput> {
    throw unsupportedCloudOperation("scripts.capture");
  }

  async readArtifact(input: OpensteerArtifactReadInput): Promise<OpensteerArtifactReadOutput> {
    throw unsupportedCloudOperation("artifact.read");
  }

  async beautifyScript(
    input: OpensteerScriptBeautifyInput,
  ): Promise<OpensteerScriptBeautifyOutput> {
    throw unsupportedCloudOperation("scripts.beautify");
  }

  async deobfuscateScript(
    input: OpensteerScriptDeobfuscateInput,
  ): Promise<OpensteerScriptDeobfuscateOutput> {
    throw unsupportedCloudOperation("scripts.deobfuscate");
  }

  async sandboxScript(input: OpensteerScriptSandboxInput): Promise<OpensteerScriptSandboxOutput> {
    throw unsupportedCloudOperation("scripts.sandbox");
  }

  async solveCaptcha(input: OpensteerCaptchaSolveInput): Promise<OpensteerCaptchaSolveOutput> {
    throw unsupportedCloudOperation("captcha.solve");
  }

  async getCookies(
    input: { readonly urls?: readonly string[] } = {},
  ): Promise<readonly CookieRecord[]> {
    throw unsupportedCloudOperation("inspect.cookies");
  }

  async getStorageSnapshot(
    input: {
      readonly includeSessionStorage?: boolean;
      readonly includeIndexedDb?: boolean;
    } = {},
  ): Promise<StorageSnapshot> {
    throw unsupportedCloudOperation("inspect.storage");
  }

  async rawRequest(input: OpensteerRawRequestInput): Promise<OpensteerRawRequestOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("request.raw", input);
  }

  async inferRequestPlan(input: OpensteerInferRequestPlanInput): Promise<RequestPlanRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("request-plan.infer", input);
  }

  async writeRequestPlan(input: OpensteerWriteRequestPlanInput): Promise<RequestPlanRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("request-plan.write", input);
  }

  async getRequestPlan(input: OpensteerGetRequestPlanInput): Promise<RequestPlanRecord> {
    await this.ensureSession();
    return this.requireClient().invoke("request-plan.get", input);
  }

  async listRequestPlans(
    input: OpensteerListRequestPlansInput = {},
  ): Promise<OpensteerListRequestPlansOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("request-plan.list", input);
  }

  async writeAuthRecipe(input: OpensteerWriteAuthRecipeInput): Promise<AuthRecipeRecord> {
    throw unsupportedCloudOperation("auth-recipe.write");
  }

  async writeRecipe(input: OpensteerWriteRecipeInput): Promise<RecipeRecord> {
    throw unsupportedCloudOperation("recipe.write");
  }

  async getAuthRecipe(input: OpensteerGetAuthRecipeInput): Promise<AuthRecipeRecord> {
    throw unsupportedCloudOperation("auth-recipe.get");
  }

  async getRecipe(input: OpensteerGetRecipeInput): Promise<RecipeRecord> {
    throw unsupportedCloudOperation("recipe.get");
  }

  async listAuthRecipes(
    input: OpensteerListAuthRecipesInput = {},
  ): Promise<OpensteerListAuthRecipesOutput> {
    throw unsupportedCloudOperation("auth-recipe.list");
  }

  async listRecipes(input: OpensteerListRecipesInput = {}): Promise<OpensteerListRecipesOutput> {
    throw unsupportedCloudOperation("recipe.list");
  }

  async runAuthRecipe(input: OpensteerRunAuthRecipeInput): Promise<OpensteerRunAuthRecipeOutput> {
    throw unsupportedCloudOperation("auth-recipe.run");
  }

  async runRecipe(input: OpensteerRunRecipeInput): Promise<OpensteerRunRecipeOutput> {
    throw unsupportedCloudOperation("recipe.run");
  }

  async request(input: OpensteerRequestExecuteInput): Promise<OpensteerRequestExecuteOutput> {
    await this.ensureSession();
    return this.requireClient().invoke("request.execute", input);
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
      (this.sessionId === undefined || this.sessionBaseUrl === undefined
        ? undefined
        : {
            layout: CLOUD_SESSION_LAYOUT,
            version: CLOUD_SESSION_VERSION,
            mode: "cloud" as const,
            ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
            sessionId: this.sessionId,
            baseUrl: this.sessionBaseUrl,
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
      await this.clearPersistedSession();
      this.client = undefined;
      this.sessionId = undefined;
      this.sessionBaseUrl = undefined;
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
    this.sessionId = undefined;
    this.sessionBaseUrl = undefined;
  }

  private async ensureSession(input: CloudSessionInitInput = {}): Promise<void> {
    if (this.client) {
      return;
    }

    assertSupportedCloudBrowserMode(input.browser);

    const persisted = await this.loadPersistedSession();
    if (persisted !== undefined && (await this.isReusableCloudSession(persisted.sessionId))) {
      this.bindClient(persisted);
      return;
    }

    const session = await this.cloud.createSession({
      ...(this.workspace === undefined ? {} : { name: this.workspace }),
      ...(input.launch === undefined ? {} : { browser: input.launch }),
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(resolveCloudBrowserProfile(this.cloud, input) === undefined
        ? {}
        : { browserProfile: resolveCloudBrowserProfile(this.cloud, input)! }),
    });
    const record: PersistedCloudSessionRecord = {
      layout: CLOUD_SESSION_LAYOUT,
      version: CLOUD_SESSION_VERSION,
      mode: "cloud",
      ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
      sessionId: session.sessionId,
      baseUrl: session.baseUrl,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.writePersistedSession(record);
    this.bindClient(record);
  }

  private bindClient(record: Pick<PersistedCloudSessionRecord, "sessionId" | "baseUrl">): void {
    this.sessionId = record.sessionId;
    this.sessionBaseUrl = record.baseUrl;
    this.client = new OpensteerSemanticRestClient({
      baseUrl: record.baseUrl,
      getAuthorizationHeader: async () => this.cloud.buildAuthorizationHeader(),
    });
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
    await writeJsonFileAtomic(resolveCloudSessionRecordPath(workspace.rootPath), record);
  }

  private async clearPersistedSession(): Promise<void> {
    await rm(resolveCloudSessionRecordPath(this.rootPath), { force: true }).catch(() => undefined);
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
  return (
    error instanceof Error &&
    /\b404\b/.test(error.message)
  );
}

function unsupportedCloudOperation(operation: OpensteerSemanticOperationName): OpensteerProtocolError {
  return new OpensteerProtocolError(
    "unsupported-operation",
    `Cloud mode does not currently support ${operation}.`,
    {
      details: {
        mode: "cloud",
        operation,
        supportedOperations: [...SUPPORTED_CLOUD_OPERATIONS],
      },
    },
  );
}
