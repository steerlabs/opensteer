import type {
  CookieRecord,
  OpensteerAddInitScriptInput,
  OpensteerAddInitScriptOutput,
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
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkSaveInput,
  OpensteerNetworkSaveOutput,
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
  OpensteerSessionCloseOutput,
  OpensteerSessionOpenInput,
  OpensteerSessionOpenOutput,
  OpensteerSnapshotMode,
  OpensteerTargetInput,
  OpensteerWriteRecipeInput,
  OpensteerWriteAuthRecipeInput,
  OpensteerWriteRequestPlanInput,
  StorageSnapshot,
} from "@opensteer/protocol";

import type { AuthRecipeRecord, RecipeRecord, RequestPlanRecord } from "../registry.js";
import { LocalOpensteerSessionProxy } from "../session-service/local-session-proxy.js";
import type {
  OpensteerDisconnectableRuntime,
  OpensteerSemanticRuntime,
} from "./semantic-runtime.js";
import { OpensteerSessionRuntime, type OpensteerRuntimeOptions } from "./runtime.js";
import type {
  OpensteerInterceptScriptOptions,
  OpensteerRouteOptions,
  OpensteerRouteRegistration,
} from "./instrumentation.js";
import {
  createOpensteerSemanticRuntime,
  type OpensteerCloudOptions,
} from "./runtime-resolution.js";

export interface OpensteerTargetOptions {
  readonly element?: number;
  readonly selector?: string;
  readonly description?: string;
  readonly networkTag?: string;
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

export type OpensteerComputerExecuteOptions = OpensteerComputerExecuteInput;
export type OpensteerComputerExecuteResult = OpensteerComputerExecuteOutput;
export type OpensteerNetworkQueryOptions = OpensteerNetworkQueryInput;
export type OpensteerNetworkQueryResult = OpensteerNetworkQueryOutput;
export type OpensteerNetworkSaveOptions = OpensteerNetworkSaveInput;
export type OpensteerNetworkSaveResult = OpensteerNetworkSaveOutput;
export type OpensteerNetworkClearOptions = OpensteerNetworkClearInput;
export type OpensteerNetworkClearResult = OpensteerNetworkClearOutput;
export type OpensteerRawRequestOptions = OpensteerRawRequestInput;
export type OpensteerRawRequestResult = OpensteerRawRequestOutput;
export type OpensteerRequestOptions = Omit<OpensteerRequestExecuteInput, "key">;
export type OpensteerRequestResult = OpensteerRequestExecuteOutput;
export type OpensteerCaptureScriptsOptions = OpensteerCaptureScriptsInput;
export type OpensteerCaptureScriptsResult = OpensteerCaptureScriptsOutput;
export type OpensteerAddInitScriptOptions = OpensteerAddInitScriptInput;

export interface OpensteerOptions extends OpensteerRuntimeOptions {
  readonly cloud?: boolean | OpensteerCloudOptions;
}

export interface OpensteerAttachOptions {
  readonly name?: string;
  readonly rootDir?: string;
}

export class Opensteer {
  private runtime!: OpensteerSemanticRuntime;
  private ownership!: "owned" | "attached";

  constructor(options: OpensteerOptions = {}) {
    this.runtime = createOpensteerSemanticRuntime({
      runtimeOptions: options,
      ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
    });
    this.ownership = "owned";
  }

  static attach(options: OpensteerAttachOptions = {}): Opensteer {
    return Opensteer.fromRuntime(
      new LocalOpensteerSessionProxy({
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
      }),
      "attached",
    );
  }

  async open(input: string | OpensteerSessionOpenInput = {}): Promise<OpensteerSessionOpenOutput> {
    const normalized = typeof input === "string" ? { url: input } : input;
    if (this.ownership === "attached") {
      assertAttachedOpenInputAllowed(normalized);
    }

    return this.runtime.open(normalized);
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

  async evaluate(input: string | OpensteerPageEvaluateInput): Promise<OpensteerPageEvaluateOutput["value"]> {
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

  async snapshot(
    input: OpensteerSnapshotMode | { readonly mode?: OpensteerSnapshotMode } = {},
  ): Promise<OpensteerPageSnapshotOutput> {
    const mode = typeof input === "string" ? input : input.mode;
    return this.runtime.snapshot(mode === undefined ? {} : { mode });
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

  async waitForNetwork(input: OpensteerWaitForNetworkOptions): Promise<OpensteerNetworkQueryResult["records"][number]> {
    const { timeoutMs, pollIntervalMs, ...query } = input;
    const timeoutAt = Date.now() + (timeoutMs ?? 30_000);
    const pollInterval = pollIntervalMs ?? 100;

    while (true) {
      const { records } = await this.runtime.queryNetwork({
        ...query,
        limit: 1,
      });
      if (records[0] !== undefined) {
        return records[0];
      }
      if (Date.now() >= timeoutAt) {
        throw new Error("waitForNetwork timed out");
      }
      await delay(pollInterval);
    }
  }

  async waitForResponse(input: OpensteerWaitForNetworkOptions): Promise<OpensteerNetworkQueryResult["records"][number]> {
    return this.waitForNetwork(input);
  }

  async waitForPage(input: OpensteerWaitForPageOptions = {}): Promise<OpensteerPageListOutput["pages"][number]> {
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

  async saveNetwork(input: OpensteerNetworkSaveOptions): Promise<OpensteerNetworkSaveResult> {
    return this.runtime.saveNetwork(input);
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

  async getCookies(input: { readonly urls?: readonly string[] } = {}): Promise<readonly CookieRecord[]> {
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

  async interceptScript(input: OpensteerInterceptScriptOptions): Promise<OpensteerRouteRegistration> {
    return this.requireOwnedInstrumentationRuntime("interceptScript").interceptScript(input);
  }

  async computerExecute(
    input: OpensteerComputerExecuteOptions,
  ): Promise<OpensteerComputerExecuteResult> {
    return this.runtime.computerExecute(input);
  }

  async close(): Promise<OpensteerSessionCloseOutput> {
    return this.runtime.close();
  }

  async disconnect(): Promise<void> {
    if (this.ownership === "owned") {
      await this.close();
      return;
    }

    if (isDisconnectableRuntime(this.runtime)) {
      await this.runtime.disconnect();
    }
  }

  private static fromRuntime(
    runtime: OpensteerSemanticRuntime,
    ownership: "owned" | "attached",
  ): Opensteer {
    const instance = Object.create(Opensteer.prototype) as Opensteer;
    instance.runtime = runtime;
    instance.ownership = ownership;
    return instance;
  }

  private requireOwnedInstrumentationRuntime(
    method: "route" | "interceptScript",
  ): OpensteerSessionRuntime {
    if (this.runtime instanceof OpensteerSessionRuntime) {
      return this.runtime;
    }
    throw new Error(`${method}() is only available on owned local SDK sessions.`);
  }
}

function assertAttachedOpenInputAllowed(input: OpensteerSessionOpenInput): void {
  if (input.browser !== undefined || input.context !== undefined || input.name !== undefined) {
    throw new Error(
      "Opensteer.attach(...) reuses an existing session. open() may only receive url when attached.",
    );
  }
}

function isDisconnectableRuntime(
  runtime: OpensteerSemanticRuntime,
): runtime is OpensteerDisconnectableRuntime {
  return "disconnect" in runtime;
}

function normalizeTargetOptions(input: OpensteerTargetOptions): {
  readonly target: OpensteerTargetInput;
  readonly persistAsDescription?: string;
  readonly networkTag?: string;
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
      ...(input.networkTag === undefined ? {} : { networkTag: input.networkTag }),
    };
  }

  if (hasSelector) {
    return {
      target: {
        kind: "selector",
        selector: input.selector!,
      },
      ...(input.description === undefined ? {} : { persistAsDescription: input.description }),
      ...(input.networkTag === undefined ? {} : { networkTag: input.networkTag }),
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
    ...(input.networkTag === undefined ? {} : { networkTag: input.networkTag }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
