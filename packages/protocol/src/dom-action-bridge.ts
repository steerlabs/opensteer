import type {
  ActionBoundaryOutcome,
  ActionBoundarySettleTrigger,
  ActionBoundarySnapshot,
  BrowserCoreEngine,
  KeyModifier,
  NodeLocator,
  PageRef,
  Point,
  Quad,
  Rect,
} from "@opensteer/browser-core";
import type { ReplayElementPath } from "./dom-path-types.js";

export const OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL = Symbol.for("@opensteer/dom-action-bridge");

export type DomActionScrollAlignment = "start" | "center" | "end" | "nearest";

export interface DomActionTargetInspection {
  readonly connected: boolean;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly pointerEvents: string;
  readonly bounds?: Rect;
  readonly contentQuads: readonly Quad[];
}

export interface DomActionScrollOptions {
  readonly block?: DomActionScrollAlignment;
  readonly inline?: DomActionScrollAlignment;
}

export interface DomActionKeyPressInput {
  readonly key: string;
  readonly modifiers?: readonly KeyModifier[];
}

export interface DomActionSettleOptions {
  readonly operation: "dom.click" | "dom.hover" | "dom.input" | "dom.scroll";
  readonly snapshot?: ActionBoundarySnapshot;
  readonly signal: AbortSignal;
  remainingMs(): number | undefined;
  policySettle(pageRef: PageRef, trigger: ActionBoundarySettleTrigger): Promise<void>;
}

export type DomPointerHitRelation =
  | "self"
  | "descendant"
  | "ancestor"
  | "same-owner"
  | "outside"
  | "unknown";

export interface DomPointerHitAssessment {
  readonly relation: DomPointerHitRelation;
  readonly blocking: boolean;
  readonly ambiguous?: boolean;
  readonly canonicalTarget?: NodeLocator;
  readonly hitOwner?: NodeLocator;
}

export interface DomActionBridge {
  buildReplayPath(locator: NodeLocator): Promise<ReplayElementPath>;
  inspectActionTarget(locator: NodeLocator): Promise<DomActionTargetInspection>;
  canonicalizePointerTarget(locator: NodeLocator): Promise<NodeLocator>;
  classifyPointerHit(input: {
    readonly target: NodeLocator;
    readonly hit: NodeLocator;
    readonly point: Point;
  }): Promise<DomPointerHitAssessment>;
  scrollNodeIntoView(locator: NodeLocator, options?: DomActionScrollOptions): Promise<void>;
  focusNode(locator: NodeLocator): Promise<void>;
  pressKey(locator: NodeLocator, input: DomActionKeyPressInput): Promise<void>;
  finalizeDomAction(
    pageRef: PageRef,
    options: DomActionSettleOptions,
  ): Promise<ActionBoundaryOutcome>;
}

export interface DomActionBridgeProvider {
  [OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL](): DomActionBridge;
}

type DomActionBridgeFactory = DomActionBridgeProvider[typeof OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL];

function isDomActionBridgeFactory(value: unknown): value is DomActionBridgeFactory {
  return typeof value === "function";
}

export function resolveDomActionBridge(
  engine: BrowserCoreEngine | DomActionBridgeProvider,
): DomActionBridge | undefined {
  const candidate = Reflect.get(engine, OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL);
  return isDomActionBridgeFactory(candidate) ? candidate.call(engine) : undefined;
}
