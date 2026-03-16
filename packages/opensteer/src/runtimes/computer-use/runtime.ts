import type {
  BodyPayload as BrowserCoreBodyPayload,
  BrowserCoreEngine,
  PageRef,
  ScreenshotArtifact as BrowserCoreScreenshotArtifact,
} from "@opensteer/browser-core";
import {
  OpensteerProtocolError,
  createBodyPayload,
  type OpensteerComputerExecuteInput,
  type OpensteerComputerExecuteOutput,
  type ScreenshotArtifact as ProtocolScreenshotArtifact,
} from "@opensteer/protocol";

import {
  settleWithPolicy,
  type OpensteerPolicy,
  type TimeoutExecutionContext,
} from "../../policy/index.js";
import type { DomRuntime } from "../dom/index.js";
import {
  resolveComputerUseBridge,
  type ComputerUseBridge,
  type NormalizedComputerScreenshotOptions,
} from "./bridge.js";
import { enrichComputerUseTrace } from "./trace-enrichment.js";

export interface ComputerUseRuntime {
  execute(input: {
    readonly pageRef: PageRef;
    readonly input: OpensteerComputerExecuteInput;
    readonly timeout: TimeoutExecutionContext;
  }): Promise<OpensteerComputerExecuteOutput>;
}

export function createComputerUseRuntime(options: {
  readonly engine: BrowserCoreEngine;
  readonly dom: DomRuntime;
  readonly policy: OpensteerPolicy;
}): ComputerUseRuntime {
  return new DefaultComputerUseRuntime(options);
}

class DefaultComputerUseRuntime implements ComputerUseRuntime {
  private readonly bridge: ComputerUseBridge | undefined;

  constructor(
    private readonly options: {
      readonly engine: BrowserCoreEngine;
      readonly dom: DomRuntime;
      readonly policy: OpensteerPolicy;
    },
  ) {
    this.bridge = resolveComputerUseBridge(options.engine);
  }

  async execute(input: {
    readonly pageRef: PageRef;
    readonly input: OpensteerComputerExecuteInput;
    readonly timeout: TimeoutExecutionContext;
  }): Promise<OpensteerComputerExecuteOutput> {
    const bridge = this.requireBridge();
    const screenshot = normalizeScreenshotOptions(input.input.screenshot);

    const executed = await input.timeout.runStep(() =>
      bridge.execute({
        pageRef: input.pageRef,
        action: input.input.action,
        screenshot,
        signal: input.timeout.signal,
        remainingMs: () => input.timeout.remainingMs(),
        policySettle: async (pageRef) =>
          settleWithPolicy(this.options.policy.settle, {
            operation: "computer.execute",
            trigger: "dom-action",
            engine: this.options.engine,
            pageRef,
            signal: input.timeout.signal,
          }),
      }),
    );

    let trace = undefined;
    if (!input.timeout.signal.aborted) {
      try {
        trace = await input.timeout.runStep(() =>
          enrichComputerUseTrace({
            action: input.input.action,
            pageRef: input.pageRef,
            engine: this.options.engine,
            dom: this.options.dom,
          }),
        );
      } catch {
        trace = undefined;
      }
    }

    return {
      action: input.input.action,
      pageRef: executed.pageRef,
      screenshot: normalizeScreenshotArtifact(executed.screenshot),
      viewport: executed.viewport,
      events: executed.events,
      timing: executed.timing,
      ...(trace === undefined ? {} : { trace }),
    };
  }

  private requireBridge(): ComputerUseBridge {
    if (this.bridge !== undefined) {
      return this.bridge;
    }

    throw new OpensteerProtocolError(
      "unsupported-capability",
      "current engine does not expose a computer-use bridge",
      {
        details: {
          operation: "computer.execute",
        },
      },
    );
  }
}

function normalizeScreenshotArtifact(
  screenshot: BrowserCoreScreenshotArtifact | ProtocolScreenshotArtifact,
): ProtocolScreenshotArtifact {
  const payload = screenshot.payload as
    | BrowserCoreBodyPayload
    | ProtocolScreenshotArtifact["payload"];
  if ("data" in payload && typeof payload.data === "string") {
    return screenshot as ProtocolScreenshotArtifact;
  }
  if ("bytes" in payload && payload.bytes instanceof Uint8Array) {
    return {
      ...screenshot,
      payload: createBodyPayload(Buffer.from(payload.bytes).toString("base64"), {
        encoding: payload.encoding,
        ...(payload.mimeType === undefined ? {} : { mimeType: payload.mimeType }),
        ...(payload.charset === undefined ? {} : { charset: payload.charset }),
        truncated: payload.truncated,
        ...(payload.originalByteLength === undefined
          ? {}
          : { originalByteLength: payload.originalByteLength }),
      }),
    };
  }

  throw new OpensteerProtocolError(
    "internal",
    "computer-use bridge returned an unsupported screenshot payload shape",
    {
      details: {
        operation: "computer.execute",
      },
    },
  );
}

function normalizeScreenshotOptions(
  input: OpensteerComputerExecuteInput["screenshot"] | undefined,
): NormalizedComputerScreenshotOptions {
  return {
    format: input?.format ?? "png",
    includeCursor: input?.includeCursor ?? false,
    annotations: [...(input?.annotations ?? [])],
  };
}
