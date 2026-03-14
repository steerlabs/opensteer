import type {
  OpensteerActionResult,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerDomExtractOutput,
  OpensteerPageGotoOutput,
  OpensteerPageSnapshotOutput,
  OpensteerSessionCloseOutput,
  OpensteerSessionOpenOutput,
  OpensteerSnapshotMode,
  OpensteerTargetInput,
} from "@opensteer/protocol";

import { OpensteerSessionRuntime, type OpensteerRuntimeOptions } from "./runtime.js";

export interface OpensteerTargetOptions {
  readonly element?: number;
  readonly selector?: string;
  readonly description?: string;
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

export type OpensteerComputerExecuteOptions = OpensteerComputerExecuteInput;
export type OpensteerComputerExecuteResult = OpensteerComputerExecuteOutput;

export class Opensteer {
  private readonly runtime: OpensteerSessionRuntime;

  constructor(options: OpensteerRuntimeOptions = {}) {
    this.runtime = new OpensteerSessionRuntime(options);
  }

  async open(url?: string): Promise<OpensteerSessionOpenOutput> {
    return this.runtime.open(url === undefined ? {} : { url });
  }

  async goto(url: string): Promise<OpensteerPageGotoOutput> {
    return this.runtime.goto({ url });
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
    };
  }

  if (hasSelector) {
    return {
      target: {
        kind: "selector",
        selector: input.selector!,
      },
      ...(input.description === undefined ? {} : { persistAsDescription: input.description }),
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
  };
}
