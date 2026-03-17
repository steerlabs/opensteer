import type {
  OpensteerActionResult,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerDomExtractOutput,
  OpensteerGetRequestPlanInput,
  OpensteerInferRequestPlanInput,
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
  OpensteerSessionCloseOutput,
  OpensteerSessionOpenOutput,
  OpensteerSnapshotMode,
  OpensteerTargetInput,
  OpensteerWriteRequestPlanInput,
} from "@opensteer/protocol";

import type { RequestPlanRecord } from "../registry.js";
import type { OpensteerSemanticRuntime } from "../cli/dispatch.js";
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

export class Opensteer {
  private readonly runtime: OpensteerSemanticRuntime;

  constructor(options: OpensteerOptions = {}) {
    this.runtime = createOpensteerSemanticRuntime({
      runtimeOptions: options,
      ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
    });
  }

  async open(url?: string): Promise<OpensteerSessionOpenOutput> {
    return this.runtime.open(url === undefined ? {} : { url });
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
