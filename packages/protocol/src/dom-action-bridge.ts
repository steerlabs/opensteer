import type {
  BrowserCoreEngine,
  NodeLocator,
  PageRef,
  Quad,
  Rect,
} from "@opensteer/browser-core";

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

export interface DomActionSettleOptions {
  readonly signal: AbortSignal;
  remainingMs(): number | undefined;
}

export interface DomActionBridge {
  inspectActionTarget(locator: NodeLocator): Promise<DomActionTargetInspection>;
  scrollNodeIntoView(locator: NodeLocator, options?: DomActionScrollOptions): Promise<void>;
  focusNode(locator: NodeLocator): Promise<void>;
  settleAfterDomAction(pageRef: PageRef, options: DomActionSettleOptions): Promise<void>;
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
