import type {
  CookieRecord,
  OpensteerGetAuthRecipeInput,
  OpensteerActionResult,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerDomExtractOutput,
  OpensteerGetRequestPlanInput,
  OpensteerInferRequestPlanInput,
  OpensteerListAuthRecipesInput,
  OpensteerListAuthRecipesOutput,
  OpensteerNetworkClearInput,
  OpensteerNetworkClearOutput,
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkSaveInput,
  OpensteerNetworkSaveOutput,
  OpensteerPageGotoInput,
  OpensteerPageGotoOutput,
  OpensteerPageSnapshotOutput,
  OpensteerListRequestPlansInput,
  OpensteerListRequestPlansOutput,
  OpensteerRawRequestInput,
  OpensteerRawRequestOutput,
  OpensteerRequestExecuteInput,
  OpensteerRequestExecuteOutput,
  OpensteerRunAuthRecipeInput,
  OpensteerRunAuthRecipeOutput,
  OpensteerSessionCloseOutput,
  OpensteerSessionOpenInput,
  OpensteerSessionOpenOutput,
  OpensteerSnapshotMode,
  OpensteerTargetInput,
  OpensteerWriteAuthRecipeInput,
  OpensteerWriteRequestPlanInput,
  StorageSnapshot,
} from "@opensteer/protocol";

import type { AuthRecipeRecord, RequestPlanRecord } from "../registry.js";
import { LocalOpensteerSessionProxy } from "../session-service/local-session-proxy.js";
import type {
  OpensteerDisconnectableRuntime,
  OpensteerSemanticRuntime,
} from "./semantic-runtime.js";
import { type OpensteerRuntimeOptions } from "./runtime.js";
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

  async goto(input: string | OpensteerGotoOptions): Promise<OpensteerPageGotoOutput> {
    return this.runtime.goto(typeof input === "string" ? { url: input } : input);
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

  async saveNetwork(input: OpensteerNetworkSaveOptions): Promise<OpensteerNetworkSaveResult> {
    return this.runtime.saveNetwork(input);
  }

  async clearNetwork(
    input: OpensteerNetworkClearOptions = {},
  ): Promise<OpensteerNetworkClearResult> {
    return this.runtime.clearNetwork(input);
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

  async getAuthRecipe(input: OpensteerGetAuthRecipeInput): Promise<AuthRecipeRecord> {
    return this.runtime.getAuthRecipe(input);
  }

  async listAuthRecipes(
    input: OpensteerListAuthRecipesInput = {},
  ): Promise<OpensteerListAuthRecipesOutput> {
    return this.runtime.listAuthRecipes(input);
  }

  async runAuthRecipe(input: OpensteerRunAuthRecipeInput): Promise<OpensteerRunAuthRecipeOutput> {
    return this.runtime.runAuthRecipe(input);
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
