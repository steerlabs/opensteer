import type {
  OpensteerArtifactReadInput,
  OpensteerArtifactReadOutput,
  CookieRecord,
  OpensteerAddInitScriptInput,
  OpensteerAddInitScriptOutput,
  OpensteerCaptchaSolveInput,
  OpensteerCaptchaSolveOutput,
  OpensteerCaptureScriptsInput,
  OpensteerCaptureScriptsOutput,
  OpensteerGetRecipeInput,
  OpensteerGetAuthRecipeInput,
  OpensteerActionResult,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerDomExtractOutput,
  OpensteerGetRequestPlanInput,
  OpensteerInferRequestPlanInput,
  OpensteerListRecipesInput,
  OpensteerListRecipesOutput,
  OpensteerListAuthRecipesInput,
  OpensteerListAuthRecipesOutput,
  OpensteerNetworkClearInput,
  OpensteerNetworkClearOutput,
  OpensteerNetworkDiffInput,
  OpensteerNetworkDiffOutput,
  OpensteerNetworkMinimizeInput,
  OpensteerNetworkMinimizeOutput,
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkTagInput,
  OpensteerNetworkTagOutput,
  OpensteerInteractionCaptureInput,
  OpensteerInteractionCaptureOutput,
  OpensteerInteractionDiffInput,
  OpensteerInteractionDiffOutput,
  OpensteerInteractionGetInput,
  OpensteerInteractionGetOutput,
  OpensteerInteractionReplayInput,
  OpensteerInteractionReplayOutput,
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
  OpensteerListRequestPlansInput,
  OpensteerListRequestPlansOutput,
  OpensteerRawRequestInput,
  OpensteerRawRequestOutput,
  OpensteerRequestExecuteInput,
  OpensteerRequestExecuteOutput,
  OpensteerRunRecipeInput,
  OpensteerRunRecipeOutput,
  OpensteerRunAuthRecipeInput,
  OpensteerRunAuthRecipeOutput,
  OpensteerSessionInfo,
  OpensteerScriptBeautifyInput,
  OpensteerScriptBeautifyOutput,
  OpensteerScriptDeobfuscateInput,
  OpensteerScriptDeobfuscateOutput,
  OpensteerScriptSandboxInput,
  OpensteerScriptSandboxOutput,
  OpensteerReverseExportInput,
  OpensteerReverseExportOutput,
  OpensteerReverseDiscoverInput,
  OpensteerReverseDiscoverOutput,
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
  OpensteerOpenInput,
  OpensteerOpenOutput,
  OpensteerSnapshotMode,
  OpensteerTargetInput,
  OpensteerTransportProbeInput,
  OpensteerTransportProbeOutput,
  OpensteerWriteRecipeInput,
  OpensteerWriteAuthRecipeInput,
  OpensteerWriteRequestPlanInput,
  StorageSnapshot,
} from "@opensteer/protocol";

import type { AuthRecipeRecord, RecipeRecord, RequestPlanRecord } from "../registry.js";
import {
  OpensteerBrowserManager,
  type OpensteerBrowserStatus,
  type WorkspaceBrowserManifest,
} from "../browser-manager.js";
import { resolveOpensteerEnvironment } from "../env.js";
import { OpensteerRuntime, type OpensteerRuntimeOptions } from "./runtime.js";
import {
  createOpensteerSemanticRuntime,
  resolveOpensteerRuntimeConfig,
} from "./runtime-resolution.js";
import type { OpensteerProviderOptions } from "../provider/config.js";
import type {
  OpensteerInterceptScriptOptions,
  OpensteerInstrumentableRuntime,
  OpensteerRouteOptions,
  OpensteerRouteRegistration,
} from "./instrumentation.js";
import type { OpensteerDisconnectableRuntime } from "./semantic-runtime.js";

export interface OpensteerTargetOptions {
  readonly element?: number;
  readonly selector?: string;
  readonly description?: string;
  readonly captureNetwork?: string;
}

export interface OpensteerInputOptions extends OpensteerTargetOptions {
  readonly text: string;
  readonly pressEnter?: boolean;
}

export interface OpensteerScrollOptions extends OpensteerTargetOptions {
  readonly direction: "up" | "down" | "left" | "right";
  readonly amount: number;
}

export interface OpensteerExtractOptions {
  readonly description: string;
  readonly schema?: Record<string, unknown>;
}

export interface OpensteerWaitForNetworkOptions extends OpensteerNetworkQueryInput {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface OpensteerWaitForPageOptions {
  readonly openerPageRef?: string;
  readonly urlIncludes?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export type OpensteerGotoOptions = OpensteerPageGotoInput;
export type OpensteerSnapshotOptions = OpensteerSnapshotMode | OpensteerPageSnapshotInput;
export type OpensteerSnapshotResult = OpensteerPageSnapshotOutput;

export type OpensteerComputerExecuteOptions = OpensteerComputerExecuteInput;
export type OpensteerComputerExecuteResult = OpensteerComputerExecuteOutput;
export type OpensteerNetworkQueryOptions = OpensteerNetworkQueryInput;
export type OpensteerNetworkQueryResult = OpensteerNetworkQueryOutput;
export type OpensteerNetworkTagOptions = OpensteerNetworkTagInput;
export type OpensteerNetworkTagResult = OpensteerNetworkTagOutput;
export type OpensteerNetworkMinimizeOptions = OpensteerNetworkMinimizeInput;
export type OpensteerNetworkMinimizeResult = OpensteerNetworkMinimizeOutput;
export type OpensteerNetworkDiffOptions = OpensteerNetworkDiffInput;
export type OpensteerNetworkDiffResult = OpensteerNetworkDiffOutput;
export type OpensteerNetworkProbeOptions = OpensteerTransportProbeInput;
export type OpensteerNetworkProbeResult = OpensteerTransportProbeOutput;
export type OpensteerReverseDiscoverOptions = OpensteerReverseDiscoverInput;
export type OpensteerReverseDiscoverResult = OpensteerReverseDiscoverOutput;
export type OpensteerReverseQueryOptions = OpensteerReverseQueryInput;
export type OpensteerReverseQueryResult = OpensteerReverseQueryOutput;
export type OpensteerReversePackageCreateOptions = OpensteerReversePackageCreateInput;
export type OpensteerReversePackageCreateResult = OpensteerReversePackageCreateOutput;
export type OpensteerReversePackageRunOptions = OpensteerReversePackageRunInput;
export type OpensteerReversePackageRunResult = OpensteerReversePackageRunOutput;
export type OpensteerReverseExportOptions = OpensteerReverseExportInput;
export type OpensteerReverseExportResult = OpensteerReverseExportOutput;
export type OpensteerReverseReportOptions = OpensteerReverseReportInput;
export type OpensteerReverseReportResult = OpensteerReverseReportOutput;
export type OpensteerReversePackageGetOptions = OpensteerReversePackageGetInput;
export type OpensteerReversePackageGetResult = OpensteerReversePackageGetOutput;
export type OpensteerReversePackageListOptions = OpensteerReversePackageListInput;
export type OpensteerReversePackageListResult = OpensteerReversePackageListOutput;
export type OpensteerReversePackagePatchOptions = OpensteerReversePackagePatchInput;
export type OpensteerReversePackagePatchResult = OpensteerReversePackagePatchOutput;
export type OpensteerInteractionCaptureOptions = OpensteerInteractionCaptureInput;
export type OpensteerInteractionCaptureResult = OpensteerInteractionCaptureOutput;
export type OpensteerInteractionGetOptions = OpensteerInteractionGetInput;
export type OpensteerInteractionGetResult = OpensteerInteractionGetOutput;
export type OpensteerInteractionDiffOptions = OpensteerInteractionDiffInput;
export type OpensteerInteractionDiffResult = OpensteerInteractionDiffOutput;
export type OpensteerInteractionReplayOptions = OpensteerInteractionReplayInput;
export type OpensteerInteractionReplayResult = OpensteerInteractionReplayOutput;
export type OpensteerNetworkClearOptions = OpensteerNetworkClearInput;
export type OpensteerNetworkClearResult = OpensteerNetworkClearOutput;
export type OpensteerRawRequestOptions = OpensteerRawRequestInput;
export type OpensteerRawRequestResult = OpensteerRawRequestOutput;
export type OpensteerRequestOptions = Omit<OpensteerRequestExecuteInput, "key">;
export type OpensteerRequestResult = OpensteerRequestExecuteOutput;
export type OpensteerCaptureScriptsOptions = OpensteerCaptureScriptsInput;
export type OpensteerCaptureScriptsResult = OpensteerCaptureScriptsOutput;
export type OpensteerScriptBeautifyOptions = OpensteerScriptBeautifyInput;
export type OpensteerScriptBeautifyResult = OpensteerScriptBeautifyOutput;
export type OpensteerScriptDeobfuscateOptions = OpensteerScriptDeobfuscateInput;
export type OpensteerScriptDeobfuscateResult = OpensteerScriptDeobfuscateOutput;
export type OpensteerScriptSandboxOptions = OpensteerScriptSandboxInput;
export type OpensteerScriptSandboxResult = OpensteerScriptSandboxOutput;
export type OpensteerArtifactReadOptions = OpensteerArtifactReadInput;
export type OpensteerArtifactReadResult = OpensteerArtifactReadOutput;
export type OpensteerCaptchaSolveOptions = OpensteerCaptchaSolveInput;
export type OpensteerCaptchaSolveResult = OpensteerCaptchaSolveOutput;
export type OpensteerAddInitScriptOptions = OpensteerAddInitScriptInput;

export interface OpensteerOptions extends OpensteerRuntimeOptions {
  readonly provider?: OpensteerProviderOptions;
}

export interface OpensteerBrowserCloneOptions {
  readonly sourceUserDataDir: string;
  readonly sourceProfileDirectory?: string;
}

export interface OpensteerBrowserController {
  status(): Promise<OpensteerBrowserStatus>;
  clone(input: OpensteerBrowserCloneOptions): Promise<WorkspaceBrowserManifest>;
  reset(): Promise<void>;
  delete(): Promise<void>;
}

export class Opensteer {
  private readonly runtime: OpensteerDisconnectableRuntime;
  private readonly browserManager: OpensteerBrowserManager | undefined;
  readonly browser: OpensteerBrowserController;

  constructor(options: OpensteerOptions = {}) {
    const environment = resolveOpensteerEnvironment(options.rootDir);
    const { provider, engineName, ...runtimeOptions } = options;
    const runtimeConfig = resolveOpensteerRuntimeConfig({
      ...(provider === undefined ? {} : { provider }),
      environment,
    });

    if (runtimeConfig.provider.mode === "cloud") {
      this.browserManager = undefined;
      this.runtime = createOpensteerSemanticRuntime({
        ...(provider === undefined ? {} : { provider }),
        ...(engineName === undefined ? {} : { engine: engineName }),
        environment,
        runtimeOptions: {
          ...runtimeOptions,
        },
      });
      this.browser = createUnsupportedBrowserController();
      return;
    }

    this.browserManager = new OpensteerBrowserManager({
      ...(runtimeOptions.rootDir === undefined ? {} : { rootDir: runtimeOptions.rootDir }),
      ...(runtimeOptions.rootPath === undefined ? {} : { rootPath: runtimeOptions.rootPath }),
      ...(runtimeOptions.workspace === undefined ? {} : { workspace: runtimeOptions.workspace }),
      ...(engineName === undefined ? {} : { engineName }),
      ...(runtimeOptions.browser === undefined ? {} : { browser: runtimeOptions.browser }),
      ...(runtimeOptions.launch === undefined ? {} : { launch: runtimeOptions.launch }),
      ...(runtimeOptions.context === undefined ? {} : { context: runtimeOptions.context }),
    });
    this.runtime = createOpensteerSemanticRuntime({
      ...(provider === undefined ? {} : { provider }),
      ...(engineName === undefined ? {} : { engine: engineName }),
      environment,
      runtimeOptions: {
        ...runtimeOptions,
        rootPath: this.browserManager.rootPath,
        cleanupRootOnClose: this.browserManager.cleanupRootOnDisconnect,
      },
    });
    this.browser = {
      status: () => this.browserManager!.status(),
      clone: (input) => this.browserManager!.clonePersistentBrowser(input),
      reset: () => this.browserManager!.reset(),
      delete: () => this.browserManager!.delete(),
    };
  }

  async open(input: string | OpensteerOpenInput = {}): Promise<OpensteerOpenOutput> {
    return this.runtime.open(typeof input === "string" ? { url: input } : input);
  }

  async info(): Promise<OpensteerSessionInfo> {
    return this.runtime.info();
  }

  async listPages(input: OpensteerPageListInput = {}): Promise<OpensteerPageListOutput> {
    return this.runtime.listPages(input);
  }

  async newPage(input: OpensteerPageNewInput = {}): Promise<OpensteerPageNewOutput> {
    return this.runtime.newPage(input);
  }

  async activatePage(input: OpensteerPageActivateInput): Promise<OpensteerPageActivateOutput> {
    return this.runtime.activatePage(input);
  }

  async closePage(input: OpensteerPageCloseInput = {}): Promise<OpensteerPageCloseOutput> {
    return this.runtime.closePage(input);
  }

  async goto(input: string | OpensteerGotoOptions): Promise<OpensteerPageGotoOutput> {
    return this.runtime.goto(typeof input === "string" ? { url: input } : input);
  }

  async evaluate(
    input: string | OpensteerPageEvaluateInput,
  ): Promise<OpensteerPageEvaluateOutput["value"]> {
    const normalized =
      typeof input === "string"
        ? {
            script: input,
          }
        : input;
    const result = await this.runtime.evaluate(normalized);
    return result.value;
  }

  async evaluateJson(
    input: string | OpensteerPageEvaluateInput,
  ): Promise<OpensteerPageEvaluateOutput["value"]> {
    return this.evaluate(input);
  }

  async addInitScript(
    input: string | OpensteerAddInitScriptInput,
  ): Promise<OpensteerAddInitScriptOutput> {
    const normalized =
      typeof input === "string"
        ? {
            script: input,
          }
        : input;
    return this.runtime.addInitScript(normalized);
  }

  async click(input: OpensteerTargetOptions): Promise<OpensteerActionResult> {
    const normalized = normalizeTargetOptions(input);
    return this.runtime.click(normalized);
  }

  async hover(input: OpensteerTargetOptions): Promise<OpensteerActionResult> {
    const normalized = normalizeTargetOptions(input);
    return this.runtime.hover(normalized);
  }

  async input(input: OpensteerInputOptions): Promise<OpensteerActionResult> {
    const normalized = normalizeTargetOptions(input);
    return this.runtime.input({
      ...normalized,
      text: input.text,
      ...(input.pressEnter === undefined ? {} : { pressEnter: input.pressEnter }),
    });
  }

  async scroll(input: OpensteerScrollOptions): Promise<OpensteerActionResult> {
    const normalized = normalizeTargetOptions(input);
    return this.runtime.scroll({
      ...normalized,
      direction: input.direction,
      amount: input.amount,
    });
  }

  async extract(input: OpensteerExtractOptions): Promise<OpensteerDomExtractOutput["data"]> {
    const result = await this.runtime.extract(input);
    return result.data;
  }

  async queryNetwork(
    input: OpensteerNetworkQueryOptions = {},
  ): Promise<OpensteerNetworkQueryResult> {
    return this.runtime.queryNetwork(input);
  }

  async waitForNetwork(
    input: OpensteerWaitForNetworkOptions,
  ): Promise<OpensteerNetworkQueryResult["records"][number]> {
    const { timeoutMs, pollIntervalMs, ...query } = input;
    const timeoutAt = Date.now() + (timeoutMs ?? 30_000);
    const pollInterval = pollIntervalMs ?? 100;
    const baseline = new Set(
      (
        await this.runtime.queryNetwork({
          ...query,
          limit: 200,
        })
      ).records.map((record) => record.recordId),
    );

    while (true) {
      const { records } = await this.runtime.queryNetwork({
        ...query,
        limit: 200,
      });
      const next = records.find((record) => !baseline.has(record.recordId));
      if (next !== undefined) {
        return next;
      }
      if (Date.now() >= timeoutAt) {
        throw new Error("waitForNetwork timed out");
      }
      await delay(pollInterval);
    }
  }

  async waitForResponse(
    input: OpensteerWaitForNetworkOptions,
  ): Promise<OpensteerNetworkQueryResult["records"][number]> {
    return this.waitForNetwork(input);
  }

  async waitForPage(
    input: OpensteerWaitForPageOptions = {},
  ): Promise<OpensteerPageListOutput["pages"][number]> {
    const baseline = new Set((await this.runtime.listPages()).pages.map((page) => page.pageRef));
    const timeoutAt = Date.now() + (input.timeoutMs ?? 30_000);
    const pollIntervalMs = input.pollIntervalMs ?? 100;

    while (true) {
      const { pages } = await this.runtime.listPages();
      const match = pages.find((page) => {
        if (baseline.has(page.pageRef)) {
          return false;
        }
        if (input.openerPageRef !== undefined && page.openerPageRef !== input.openerPageRef) {
          return false;
        }
        if (input.urlIncludes !== undefined && !page.url.includes(input.urlIncludes)) {
          return false;
        }
        return true;
      });
      if (match !== undefined) {
        return match;
      }
      if (Date.now() >= timeoutAt) {
        throw new Error("waitForPage timed out");
      }
      await delay(pollIntervalMs);
    }
  }

  async snapshot(input: OpensteerSnapshotOptions = {}): Promise<OpensteerSnapshotResult> {
    return this.runtime.snapshot(typeof input === "string" ? { mode: input } : input);
  }

  async tagNetwork(input: OpensteerNetworkTagOptions): Promise<OpensteerNetworkTagResult> {
    return this.runtime.tagNetwork(input);
  }

  async minimizeNetwork(
    input: OpensteerNetworkMinimizeOptions,
  ): Promise<OpensteerNetworkMinimizeResult> {
    return this.runtime.minimizeNetwork(input);
  }

  async diffNetwork(input: OpensteerNetworkDiffOptions): Promise<OpensteerNetworkDiffResult> {
    return this.runtime.diffNetwork(input);
  }

  async probeNetwork(input: OpensteerNetworkProbeOptions): Promise<OpensteerNetworkProbeResult> {
    return this.runtime.probeNetwork(input);
  }

  async reverseDiscover(
    input: OpensteerReverseDiscoverOptions = {},
  ): Promise<OpensteerReverseDiscoverResult> {
    return this.runtime.discoverReverse(input);
  }

  async reverseQuery(input: OpensteerReverseQueryOptions): Promise<OpensteerReverseQueryResult> {
    return this.runtime.queryReverse(input);
  }

  async createReversePackage(
    input: OpensteerReversePackageCreateOptions,
  ): Promise<OpensteerReversePackageCreateResult> {
    return this.runtime.createReversePackage(input);
  }

  async runReversePackage(
    input: OpensteerReversePackageRunOptions,
  ): Promise<OpensteerReversePackageRunResult> {
    return this.runtime.runReversePackage(input);
  }

  async reverseExport(input: OpensteerReverseExportOptions): Promise<OpensteerReverseExportResult> {
    return this.runtime.exportReverse(input);
  }

  async reverseReport(input: OpensteerReverseReportOptions): Promise<OpensteerReverseReportResult> {
    return this.runtime.getReverseReport(input);
  }

  async getReversePackage(
    input: OpensteerReversePackageGetOptions,
  ): Promise<OpensteerReversePackageGetResult> {
    return this.runtime.getReversePackage(input);
  }

  async listReversePackages(
    input: OpensteerReversePackageListOptions = {},
  ): Promise<OpensteerReversePackageListResult> {
    return this.runtime.listReversePackages(input);
  }

  async patchReversePackage(
    input: OpensteerReversePackagePatchOptions,
  ): Promise<OpensteerReversePackagePatchResult> {
    return this.runtime.patchReversePackage(input);
  }

  async interactionCapture(
    input: OpensteerInteractionCaptureOptions,
  ): Promise<OpensteerInteractionCaptureResult> {
    return this.runtime.captureInteraction(input);
  }

  async getInteraction(
    input: OpensteerInteractionGetOptions,
  ): Promise<OpensteerInteractionGetResult> {
    return this.runtime.getInteraction(input);
  }

  async interactionDiff(
    input: OpensteerInteractionDiffOptions,
  ): Promise<OpensteerInteractionDiffResult> {
    return this.runtime.diffInteraction(input);
  }

  async interactionReplay(
    input: OpensteerInteractionReplayOptions,
  ): Promise<OpensteerInteractionReplayResult> {
    return this.runtime.replayInteraction(input);
  }

  async clearNetwork(
    input: OpensteerNetworkClearOptions = {},
  ): Promise<OpensteerNetworkClearResult> {
    return this.runtime.clearNetwork(input);
  }

  async captureScripts(
    input: OpensteerCaptureScriptsOptions = {},
  ): Promise<OpensteerCaptureScriptsResult> {
    return this.runtime.captureScripts(input);
  }

  async readArtifact(input: OpensteerArtifactReadOptions): Promise<OpensteerArtifactReadResult> {
    return this.runtime.readArtifact(input);
  }

  async beautifyScript(
    input: OpensteerScriptBeautifyOptions,
  ): Promise<OpensteerScriptBeautifyResult> {
    return this.runtime.beautifyScript(input);
  }

  async deobfuscateScript(
    input: OpensteerScriptDeobfuscateOptions,
  ): Promise<OpensteerScriptDeobfuscateResult> {
    return this.runtime.deobfuscateScript(input);
  }

  async sandboxScript(input: OpensteerScriptSandboxOptions): Promise<OpensteerScriptSandboxResult> {
    return this.runtime.sandboxScript(input);
  }

  async solveCaptcha(input: OpensteerCaptchaSolveOptions): Promise<OpensteerCaptchaSolveResult> {
    return this.runtime.solveCaptcha(input);
  }

  async getCookies(
    input: { readonly urls?: readonly string[] } = {},
  ): Promise<readonly CookieRecord[]> {
    return this.runtime.getCookies(input);
  }

  async getStorageSnapshot(
    input: {
      readonly includeSessionStorage?: boolean;
      readonly includeIndexedDb?: boolean;
    } = {},
  ): Promise<StorageSnapshot> {
    return this.runtime.getStorageSnapshot(input);
  }

  async writeRequestPlan(input: OpensteerWriteRequestPlanInput): Promise<RequestPlanRecord> {
    return this.runtime.writeRequestPlan(input);
  }

  async inferRequestPlan(input: OpensteerInferRequestPlanInput): Promise<RequestPlanRecord> {
    return this.runtime.inferRequestPlan(input);
  }

  async getRequestPlan(input: OpensteerGetRequestPlanInput): Promise<RequestPlanRecord> {
    return this.runtime.getRequestPlan(input);
  }

  async listRequestPlans(
    input: OpensteerListRequestPlansInput = {},
  ): Promise<OpensteerListRequestPlansOutput> {
    return this.runtime.listRequestPlans(input);
  }

  async writeAuthRecipe(input: OpensteerWriteAuthRecipeInput): Promise<AuthRecipeRecord> {
    return this.runtime.writeAuthRecipe(input);
  }

  async writeRecipe(input: OpensteerWriteRecipeInput): Promise<RecipeRecord> {
    return this.runtime.writeRecipe(input);
  }

  async getAuthRecipe(input: OpensteerGetAuthRecipeInput): Promise<AuthRecipeRecord> {
    return this.runtime.getAuthRecipe(input);
  }

  async getRecipe(input: OpensteerGetRecipeInput): Promise<RecipeRecord> {
    return this.runtime.getRecipe(input);
  }

  async listAuthRecipes(
    input: OpensteerListAuthRecipesInput = {},
  ): Promise<OpensteerListAuthRecipesOutput> {
    return this.runtime.listAuthRecipes(input);
  }

  async listRecipes(input: OpensteerListRecipesInput = {}): Promise<OpensteerListRecipesOutput> {
    return this.runtime.listRecipes(input);
  }

  async runAuthRecipe(input: OpensteerRunAuthRecipeInput): Promise<OpensteerRunAuthRecipeOutput> {
    return this.runtime.runAuthRecipe(input);
  }

  async runRecipe(input: OpensteerRunRecipeInput): Promise<OpensteerRunRecipeOutput> {
    return this.runtime.runRecipe(input);
  }

  async request(key: string, input: OpensteerRequestOptions = {}): Promise<OpensteerRequestResult> {
    return this.runtime.request({
      key,
      ...input,
    });
  }

  async rawRequest(input: OpensteerRawRequestOptions): Promise<OpensteerRawRequestResult> {
    return this.runtime.rawRequest(input);
  }

  async route(input: OpensteerRouteOptions): Promise<OpensteerRouteRegistration> {
    return this.requireOwnedInstrumentationRuntime("route").route(input);
  }

  async interceptScript(
    input: OpensteerInterceptScriptOptions,
  ): Promise<OpensteerRouteRegistration> {
    return this.requireOwnedInstrumentationRuntime("interceptScript").interceptScript(input);
  }

  async computerExecute(
    input: OpensteerComputerExecuteOptions,
  ): Promise<OpensteerComputerExecuteResult> {
    return this.runtime.computerExecute(input);
  }

  async close(): Promise<OpensteerSessionCloseOutput> {
    if (this.browserManager === undefined || this.browserManager.mode === "temporary") {
      return this.runtime.close();
    }

    const output = await this.runtime.close();
    await this.browserManager.close();
    return output;
  }

  async disconnect(): Promise<void> {
    await this.runtime.disconnect();
  }

  private requireOwnedInstrumentationRuntime(
    method: "route" | "interceptScript",
  ): OpensteerInstrumentableRuntime {
    if (isInstrumentableRuntime(this.runtime)) {
      return this.runtime;
    }
    throw new Error(`${method}() is not available for this session runtime.`);
  }
}

function isInstrumentableRuntime(
  runtime: OpensteerDisconnectableRuntime,
): runtime is OpensteerDisconnectableRuntime & OpensteerInstrumentableRuntime {
  return (
    typeof (runtime as Partial<OpensteerInstrumentableRuntime>).route === "function" &&
    typeof (runtime as Partial<OpensteerInstrumentableRuntime>).interceptScript === "function"
  );
}

function createUnsupportedBrowserController(): OpensteerBrowserController {
  const fail = async (): Promise<never> => {
    throw new Error("browser.* helpers are only available in local mode.");
  };

  return {
    status: fail,
    clone: fail,
    reset: fail,
    delete: fail,
  };
}

function normalizeTargetOptions(input: OpensteerTargetOptions): {
  readonly target: OpensteerTargetInput;
  readonly persistAsDescription?: string;
  readonly captureNetwork?: string;
} {
  const hasElement = input.element !== undefined;
  const hasSelector = input.selector !== undefined;
  if (hasElement && hasSelector) {
    throw new Error("Specify exactly one of element, selector, or description.");
  }

  if (hasElement) {
    return {
      target: {
        kind: "element",
        element: input.element!,
      },
      ...(input.description === undefined ? {} : { persistAsDescription: input.description }),
      ...(input.captureNetwork === undefined ? {} : { captureNetwork: input.captureNetwork }),
    };
  }

  if (hasSelector) {
    return {
      target: {
        kind: "selector",
        selector: input.selector!,
      },
      ...(input.description === undefined ? {} : { persistAsDescription: input.description }),
      ...(input.captureNetwork === undefined ? {} : { captureNetwork: input.captureNetwork }),
    };
  }

  if (input.description === undefined) {
    throw new Error("Specify exactly one of element, selector, or description.");
  }

  return {
    target: {
      kind: "description",
      description: input.description,
    },
    ...(input.captureNetwork === undefined ? {} : { captureNetwork: input.captureNetwork }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
