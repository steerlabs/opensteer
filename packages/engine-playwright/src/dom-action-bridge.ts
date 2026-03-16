import {
  createPoint,
  createRect,
  quadBounds,
  staleNodeRefError,
  type NodeLocator,
  type PageRef,
  type Quad,
  type Rect,
  type SessionRef,
} from "@opensteer/browser-core";
import type {
  DomActionBridge,
  DomActionTargetInspection,
} from "@opensteer/protocol";

import { rethrowNodeLookupError } from "./errors.js";
import type { DocumentState, PageController } from "./types.js";
import { getViewportMetricsFromCdp } from "./viewport-screenshot.js";

interface PlaywrightDomActionBridgeContext {
  resolveController(pageRef: PageRef): PageController;
  flushPendingPageTasks(sessionRef: SessionRef): Promise<void>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  requireLiveNode(locator: NodeLocator): {
    readonly controller: PageController;
    readonly document: DocumentState;
    readonly backendNodeId: number;
  };
}

const READ_ACTION_TARGET_STATE_DECLARATION = String.raw`function() {
  const node = this;
  if (!(node instanceof Element)) {
    return {
      connected: false,
      cssVisible: false,
      enabled: false,
      editable: false,
      pointerEvents: "auto",
    };
  }

  const ownerWindow = node.ownerDocument?.defaultView;
  if (!ownerWindow) {
    return {
      connected: node.isConnected,
      cssVisible: false,
      enabled: false,
      editable: false,
      pointerEvents: "auto",
    };
  }

  const style = ownerWindow.getComputedStyle(node);

  const enabled =
    typeof node.matches === "function"
      ? !node.matches(":disabled") && node.getAttribute("aria-disabled") !== "true"
      : true;

  const editable =
    (node instanceof ownerWindow.HTMLInputElement ||
      node instanceof ownerWindow.HTMLTextAreaElement) &&
    !node.readOnly &&
    enabled
      ? true
      : node instanceof ownerWindow.HTMLSelectElement && enabled
        ? true
        : node.isContentEditable;

  return {
    connected: node.isConnected,
    cssVisible:
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.display !== "none",
    enabled,
    editable,
    pointerEvents: style.pointerEvents,
  };
}`;

export function createPlaywrightDomActionBridge(
  context: PlaywrightDomActionBridgeContext,
): DomActionBridge {
  return {
    inspectActionTarget(locator) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
        const [state, contentQuads] = await Promise.all([
          callNodeFunction(controller, document, locator, backendNodeId, {
            functionDeclaration: READ_ACTION_TARGET_STATE_DECLARATION,
            returnByValue: true,
          }),
          readContentQuads(controller, nodeId),
        ]);

        return normalizeActionTargetInspection(state, contentQuads);
      });
    },

    async scrollNodeIntoView(locator, _options) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
        await controller.cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId });
        await context.flushDomUpdateTask(controller);
      });
    },

    async focusNode(locator) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
        await controller.cdp.send("DOM.focus", { nodeId });
        await context.flushDomUpdateTask(controller);
      });
    },

    async settleAfterDomAction(pageRef) {
      const controller = context.resolveController(pageRef);
      await context.flushPendingPageTasks(controller.sessionRef);
      await context.flushDomUpdateTask(controller);
    },
  };
}

async function withLiveNode<T>(
  context: PlaywrightDomActionBridgeContext,
  locator: NodeLocator,
  callback: (input: {
    readonly controller: PageController;
    readonly document: DocumentState;
    readonly backendNodeId: number;
  }) => Promise<T>,
): Promise<T> {
  const liveNode = context.requireLiveNode(locator);
  await context.flushDomUpdateTask(liveNode.controller);
  return callback(liveNode);
}

async function callNodeFunction(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
  input: {
    readonly functionDeclaration: string;
    readonly arguments?: { readonly value: unknown }[];
    readonly returnByValue: boolean;
  },
): Promise<unknown> {
  let objectId: string | undefined;

  try {
    const resolved = (await controller.cdp.send("DOM.resolveNode", {
      backendNodeId,
    })) as {
      readonly object?: {
        readonly objectId?: string;
      };
    };
    objectId = resolved.object?.objectId;
    if (objectId === undefined) {
      throw staleNodeRefError(locator);
    }

    const evaluated = (await controller.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: input.functionDeclaration,
      ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
      returnByValue: input.returnByValue,
      awaitPromise: true,
    })) as {
      readonly result?: {
        readonly value?: unknown;
      };
    };
    return evaluated.result?.value;
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  } finally {
    if (objectId !== undefined) {
      await controller.cdp
        .send("Runtime.releaseObject", { objectId })
        .catch(() => undefined);
    }
  }
}

async function resolveFrontendNodeId(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
): Promise<number> {
  try {
    await controller.cdp.send("DOM.getDocument", { depth: 0 });
    const frontend = (await controller.cdp.send("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [backendNodeId],
    })) as {
      readonly nodeIds: readonly number[];
    };
    const nodeId = frontend.nodeIds[0];
    if (nodeId === undefined) {
      throw staleNodeRefError(locator);
    }
    return nodeId;
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  }
}

async function readContentQuads(
  controller: PageController,
  nodeId: number,
): Promise<readonly Quad[]> {
  const metrics = await getViewportMetricsFromCdp(controller);
  const result = (await controller.cdp.send("DOM.getContentQuads", { nodeId })) as {
    readonly quads?: ReadonlyArray<readonly number[]>;
  };

  return (result.quads ?? [])
    .filter((quad): quad is readonly number[] => quad.length === 8)
    .map((quad) => [
      createPoint(quad[0]! + metrics.scrollOffset.x, quad[1]! + metrics.scrollOffset.y),
      createPoint(quad[2]! + metrics.scrollOffset.x, quad[3]! + metrics.scrollOffset.y),
      createPoint(quad[4]! + metrics.scrollOffset.x, quad[5]! + metrics.scrollOffset.y),
      createPoint(quad[6]! + metrics.scrollOffset.x, quad[7]! + metrics.scrollOffset.y),
    ]);
}

function normalizeActionTargetInspection(
  value: unknown,
  contentQuads: readonly Quad[],
): DomActionTargetInspection {
  if (!value || typeof value !== "object") {
    throw new Error("DOM action bridge returned an invalid inspection payload");
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.connected !== "boolean" ||
    typeof candidate.cssVisible !== "boolean" ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.editable !== "boolean" ||
    typeof candidate.pointerEvents !== "string"
  ) {
    throw new Error("DOM action bridge returned an invalid inspection payload");
  }

  const bounds =
    contentQuads.length === 0 ? undefined : unionQuadBounds(contentQuads);

  return {
    connected: candidate.connected,
    visible: candidate.cssVisible && contentQuads.length > 0,
    enabled: candidate.enabled,
    editable: candidate.editable,
    pointerEvents: candidate.pointerEvents,
    ...(bounds === undefined ? {} : { bounds }),
    contentQuads,
  };
}

function unionQuadBounds(quads: readonly Quad[]): Rect {
  const bounds = quads.map((quad) => quadBounds(quad));
  const minX = Math.min(...bounds.map((rect) => rect.x));
  const minY = Math.min(...bounds.map((rect) => rect.y));
  const maxX = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...bounds.map((rect) => rect.y + rect.height));
  return createRect(minX, minY, maxX - minX, maxY - minY);
}
