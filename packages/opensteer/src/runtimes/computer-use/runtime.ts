import type {
  BrowserCoreEngine,
  PageRef,
  ScreenshotArtifact as BrowserCoreScreenshotArtifact,
} from "@opensteer/browser-core";
import {
  OpensteerProtocolError,
  type OpensteerComputerExecuteInput,
  type OpensteerComputerExecuteOutput,
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
import {
  OPENSTEER_COMPUTER_DISPLAY_PROFILE,
  createComputerDisplayTransform,
  normalizeComputerScreenshot,
  resolveComputerAnnotations,
  toDisplayComputerTrace,
  toDisplayViewportMetrics,
  toNativeComputerAction,
} from "./display.js";
import { enrichComputerUseTrace } from "./trace-enrichment.js";

export interface ComputerUseRuntime {
  execute(input: {
    readonly pageRef: PageRef;
    readonly input: OpensteerComputerExecuteInput;
    readonly timeout: TimeoutExecutionContext;
  }): Promise<ComputerUseRuntimeOutput>;
}

export interface ComputerUseRuntimeOutput extends Omit<OpensteerComputerExecuteOutput, "screenshot"> {
  readonly screenshot: BrowserCoreScreenshotArtifact;
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
  }): Promise<ComputerUseRuntimeOutput> {
    const bridge = this.requireBridge();
    const preActionNativeViewport = await input.timeout.runStep(() =>
      this.options.engine.getViewportMetrics({
        pageRef: input.pageRef,
      }),
    );
    const preActionDisplay = createComputerDisplayTransform(preActionNativeViewport);
    const nativeAction = toNativeComputerAction(input.input.action, preActionDisplay);
    const screenshot = normalizeScreenshotOptions(input.input.screenshot);

    const executed = await input.timeout.runStep(() =>
      bridge.execute({
        pageRef: input.pageRef,
        action: nativeAction,
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
            action: nativeAction,
            pageRef: input.pageRef,
            engine: this.options.engine,
            dom: this.options.dom,
          }),
        );
      } catch {
        trace = undefined;
      }
    }

    const postActionDisplay = createComputerDisplayTransform(executed.viewport);
    const screenshotArtifact = await input.timeout.runStep(() =>
      normalizeComputerScreenshot({
        screenshot: executed.screenshot,
        transform: postActionDisplay,
      }),
    );
    const displayTrace = toDisplayComputerTrace(trace, preActionDisplay);

    return {
      action: input.input.action,
      pageRef: executed.pageRef,
      screenshot: screenshotArtifact,
      displayViewport: toDisplayViewportMetrics(executed.viewport, postActionDisplay),
      nativeViewport: executed.viewport,
      displayScale: postActionDisplay.nativeToDisplay,
      events: executed.events,
      timing: executed.timing,
      ...(displayTrace === undefined ? {} : { trace: displayTrace }),
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

function normalizeScreenshotOptions(
  input: OpensteerComputerExecuteInput["screenshot"] | undefined,
): NormalizedComputerScreenshotOptions {
  return {
    format: input?.format ?? OPENSTEER_COMPUTER_DISPLAY_PROFILE.defaultScreenshotFormat,
    includeCursor: input?.includeCursor ?? OPENSTEER_COMPUTER_DISPLAY_PROFILE.defaultIncludeCursor,
    annotations: [...resolveComputerAnnotations(input?.disableAnnotations)],
  };
}
