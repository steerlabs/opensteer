import {
  createPoint,
  createBrowserCoreError,
  quadBounds,
  staleNodeRefError,
  type DomSnapshot,
  type DomSnapshotNode,
  type NodeLocator,
  type PageRef,
  type Quad,
  type SessionRef,
  type ViewportMetrics,
} from "@opensteer/browser-core";
import type { DomActionBridge, DomActionTargetInspection } from "@opensteer/protocol";

import type { DocumentState, PageController, SessionState } from "./types.js";

interface AbpDomActionBridgeContext {
  resolveController(pageRef: PageRef): PageController;
  resolveSession(sessionRef: SessionRef): SessionState;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  resettlePausedExecution(controller: PageController, timeoutMs: number): Promise<void>;
  requireLiveNode(locator: NodeLocator): {
    readonly document: DocumentState;
    readonly backendNodeId: number;
  };
  getDomSnapshot(documentRef: string): Promise<DomSnapshot>;
  getViewportMetrics(pageRef: PageRef): Promise<ViewportMetrics>;
}

const DEFAULT_ACTION_SETTLE_TIMEOUT_MS = 5_000;

export function createAbpDomActionBridge(context: AbpDomActionBridgeContext): DomActionBridge {
  return {
    async inspectActionTarget(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(context, locator);
      const snapshot = await context.getDomSnapshot(locator.documentRef);
      const node = findNode(snapshot, locator);
      if (!node) {
        return disconnectedInspection();
      }
      const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
      const metrics = await context.getViewportMetrics(document.pageRef);
      const contentQuads = await readContentQuads(controller, nodeId, metrics).catch(
        () => (node.layout?.quad === undefined ? [] : [node.layout.quad]),
      );
      const bounds = contentQuads.length === 0 ? undefined : quadBounds(contentQuads[0]!);

      const hiddenAttribute = hasAttribute(node, "hidden");
      const ariaHidden = readAttributeValue(node, "aria-hidden") === "true";
      const disabled = hasAttribute(node, "disabled");
      const ariaDisabled = readAttributeValue(node, "aria-disabled") === "true";
      const readOnly = hasAttribute(node, "readonly");
      const style = readAttributeValue(node, "style") ?? "";
      const pointerEvents = readInlineStyleValue(style, "pointer-events") ?? "auto";
      const editable =
        isEditableElement(node) &&
        !disabled &&
        !ariaDisabled &&
        !readOnly;

      return {
        connected: true,
        visible:
          !hiddenAttribute &&
          !ariaHidden &&
          bounds !== undefined &&
          bounds.width > 0 &&
          bounds.height > 0,
        enabled: !disabled && !ariaDisabled,
        editable,
        pointerEvents,
        ...(bounds === undefined ? {} : { bounds }),
        contentQuads,
      } satisfies DomActionTargetInspection;
    },

    async scrollNodeIntoView(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(context, locator);
      const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
      await controller.cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId });
      await context.resettlePausedExecution(controller, DEFAULT_ACTION_SETTLE_TIMEOUT_MS);
      await context.flushDomUpdateTask(controller);
    },

    async focusNode(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(context, locator);
      const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
      await controller.cdp.send("DOM.focus", { nodeId });
      await context.resettlePausedExecution(controller, DEFAULT_ACTION_SETTLE_TIMEOUT_MS);
      await context.flushDomUpdateTask(controller);
    },

    async settleAfterDomAction(pageRef, options) {
      const controller = context.resolveController(pageRef);
      const session = context.resolveSession(controller.sessionRef);
      const timeoutMs = options.remainingMs() ?? DEFAULT_ACTION_SETTLE_TIMEOUT_MS;
      await context.resettlePausedExecution(controller, timeoutMs);
      await context.flushDomUpdateTask(controller);
      if (session.closed) {
        throw createBrowserCoreError("page-closed", `page ${pageRef} is closed`, {
          details: { pageRef },
        });
      }
    },
  };
}

async function prepareLiveNodeContext(
  context: AbpDomActionBridgeContext,
  locator: NodeLocator,
): Promise<{
  readonly controller: PageController;
  readonly document: DocumentState;
  readonly backendNodeId: number;
}> {
  const liveNode = context.requireLiveNode(locator);
  const controller = context.resolveController(liveNode.document.pageRef);
  await context.resettlePausedExecution(controller, DEFAULT_ACTION_SETTLE_TIMEOUT_MS);
  await context.flushDomUpdateTask(controller);
  return {
    controller,
    document: liveNode.document,
    backendNodeId: liveNode.backendNodeId,
  };
}

async function resolveFrontendNodeId(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
): Promise<number> {
  try {
    await controller.cdp.send("DOM.getDocument", { depth: 0 });
    const frontend = await controller.cdp.send<{ readonly nodeIds: readonly number[] }>(
      "DOM.pushNodesByBackendIdsToFrontend",
      {
        backendNodeIds: [backendNodeId],
      },
    );
    const nodeId = frontend.nodeIds[0];
    if (nodeId === undefined) {
      throw staleNodeRefError(locator);
    }
    return nodeId;
  } catch (error) {
    if (
      error instanceof Error &&
      /No node with given id found|Could not find node with given id|Cannot find context/i.test(
        error.message,
      )
    ) {
      throw staleNodeRefError({
        documentRef: document.documentRef,
        documentEpoch: locator.documentEpoch,
        nodeRef: locator.nodeRef,
      });
    }
    throw error;
  }
}

function findNode(snapshot: DomSnapshot, locator: NodeLocator): DomSnapshotNode | undefined {
  return snapshot.nodes.find((node) => node.nodeRef === locator.nodeRef);
}

function disconnectedInspection(): DomActionTargetInspection {
  return {
    connected: false,
    visible: false,
    enabled: false,
    editable: false,
    pointerEvents: "auto",
    contentQuads: [],
  };
}

function hasAttribute(node: DomSnapshotNode, name: string): boolean {
  return node.attributes.some((attribute) => attribute.name === name);
}

function readAttributeValue(node: DomSnapshotNode, name: string): string | undefined {
  return node.attributes.find((attribute) => attribute.name === name)?.value;
}

function isEditableElement(node: DomSnapshotNode): boolean {
  const name = node.nodeName.toLowerCase();
  return (
    name === "input" ||
    name === "textarea" ||
    name === "select" ||
    readAttributeValue(node, "contenteditable") === "" ||
    readAttributeValue(node, "contenteditable") === "true"
  );
}

function readInlineStyleValue(style: string, property: string): string | undefined {
  for (const declaration of style.split(";")) {
    const separatorIndex = declaration.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const name = declaration.slice(0, separatorIndex).trim().toLowerCase();
    if (name !== property) {
      continue;
    }
    const value = declaration.slice(separatorIndex + 1).trim();
    if (value.length > 0) {
      return value;
    }
  }
  return undefined;
}

async function readContentQuads(
  controller: PageController,
  nodeId: number,
  metrics: ViewportMetrics,
): Promise<readonly Quad[]> {
  const result = await controller.cdp.send<{
    readonly quads: ReadonlyArray<readonly number[]>;
  }>("DOM.getContentQuads", { nodeId });

  return result.quads
    .filter((quad): quad is readonly number[] => quad.length === 8)
    .map((quad) => [
      createPoint(quad[0]! + metrics.scrollOffset.x, quad[1]! + metrics.scrollOffset.y),
      createPoint(quad[2]! + metrics.scrollOffset.x, quad[3]! + metrics.scrollOffset.y),
      createPoint(quad[4]! + metrics.scrollOffset.x, quad[5]! + metrics.scrollOffset.y),
      createPoint(quad[6]! + metrics.scrollOffset.x, quad[7]! + metrics.scrollOffset.y),
    ]);
}
