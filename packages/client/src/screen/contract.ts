import type {
  PlaceContentPart,
  ScreenPresentationReceipt,
  ScreenShowTarget,
} from "@opensteer/core";
import type { ScreenShowMessage } from "@opensteer/protocol";

export interface ScreenPresentationEndpoint {
  readonly endpointRef: string;
  /** Setup-round-trip clock estimate; suspension retires the endpoint and its sample. */
  serverTimeUpperBound(): number;
}

export interface ScreenPresentationTransport {
  getEndpoint(): ScreenPresentationEndpoint | null;
  /** null announces a changed/ended endpoint; old operations cannot cross that boundary. */
  subscribe(listener: (message: ScreenShowMessage | null) => void): () => void;
  acknowledge(operationId: string, receipt: ScreenPresentationReceipt): void;
}

export interface CapturedPresentationView {
  readonly interactionRevision: number;
  readonly currentThreadId?: string;
  /** The closure resolves only the eligible identity captured by capture(), never a later view. */
  readonly places: () => Promise<readonly PlaceContentPart[]>;
}

export interface PresentationCommitGuard {
  readonly operationId: string;
  /** Checked synchronously immediately before the route changes. */
  check(): ScreenPresentationReceipt | null;
}

export interface PreparedPresentation {
  /** Preparation may read existing state, but this is the only step allowed to navigate. */
  commitIfCurrent(guard: PresentationCommitGuard): "committed" | ScreenPresentationReceipt;
  /** Confirms the exact committed route, not a first video frame or successful work. */
  readonly confirmation: Promise<ScreenPresentationReceipt>;
  dispose(): void;
}

export interface ScreenPresentationPort {
  capture(): CapturedPresentationView;
  /** Includes foreground, editing and blocking modal state; an idle view returns null. */
  blocked(): ScreenPresentationReceipt | null;
  prepare(target: ScreenShowTarget, signal: AbortSignal): Promise<PreparedPresentation>;
}
