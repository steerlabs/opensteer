import type {
  BrowserCoreEngine,
  PageRef,
  ScreenshotArtifact as BrowserCoreScreenshotArtifact,
} from "@opensteer/browser-core";
import type {
  OpensteerComputerAction,
  OpensteerComputerAnnotation,
  OpensteerComputerExecuteTiming,
  OpensteerEvent,
  ScreenshotArtifact as ProtocolScreenshotArtifact,
  ScreenshotFormat,
  ViewportMetrics,
} from "@opensteer/protocol";

export const OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL = Symbol.for("@opensteer/computer-use-bridge");

export interface NormalizedComputerScreenshotOptions {
  readonly format: ScreenshotFormat;
  readonly includeCursor: boolean;
  readonly annotations: readonly OpensteerComputerAnnotation[];
}

export interface ComputerUseBridgeInput {
  readonly pageRef: PageRef;
  readonly action: OpensteerComputerAction;
  readonly screenshot: NormalizedComputerScreenshotOptions;
  readonly signal: AbortSignal;
  remainingMs(): number | undefined;
  settle(pageRef: PageRef): Promise<void>;
}

export interface ComputerUseBridgeOutput {
  readonly pageRef: PageRef;
  readonly screenshot: BrowserCoreScreenshotArtifact | ProtocolScreenshotArtifact;
  readonly viewport: ViewportMetrics;
  readonly events: readonly OpensteerEvent[];
  readonly timing: OpensteerComputerExecuteTiming;
}

export interface ComputerUseBridge {
  execute(input: ComputerUseBridgeInput): Promise<ComputerUseBridgeOutput>;
}

type ComputerUseBridgeFactory = () => ComputerUseBridge;

function isComputerUseBridgeFactory(value: unknown): value is ComputerUseBridgeFactory {
  return typeof value === "function";
}

export function resolveComputerUseBridge(
  engine: BrowserCoreEngine,
): ComputerUseBridge | undefined {
  const candidate = Reflect.get(engine, OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL);
  return isComputerUseBridgeFactory(candidate) ? candidate.call(engine) : undefined;
}
