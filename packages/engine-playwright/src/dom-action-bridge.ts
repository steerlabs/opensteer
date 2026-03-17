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
  DomPointerHitAssessment,
  DomActionTargetInspection,
} from "@opensteer/protocol";

import { rethrowNodeLookupError } from "./errors.js";
import type { DocumentState, PageController } from "./types.js";
import { getViewportMetricsFromCdp } from "./viewport-screenshot.js";

interface PlaywrightDomActionBridgeContext {
  resolveController(pageRef: PageRef): PageController;
  flushPendingPageTasks(sessionRef: SessionRef): Promise<void>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  locateBackendNode(document: DocumentState, backendNodeId: number): NodeLocator;
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

const POINTER_ACTION_HELPERS = String.raw`
  function parentInComposedTree(node) {
    if (!node) {
      return null;
    }
    const slot = "assignedSlot" in node ? node.assignedSlot : null;
    if (slot instanceof Element) {
      return slot;
    }
    const parent = node.parentNode;
    if (parent instanceof ShadowRoot) {
      return parent.host;
    }
    return parent instanceof Element ? parent : null;
  }

  function closestElementInComposedTree(node) {
    if (!node) {
      return null;
    }
    if (node instanceof Element) {
      return node;
    }
    let current = parentInComposedTree(node);
    while (current) {
      if (current instanceof Element) {
        return current;
      }
      current = parentInComposedTree(current);
    }
    return null;
  }

  function hasInteractiveRole(element) {
    const role = element.getAttribute("role");
    return (
      role === "button" ||
      role === "link" ||
      role === "menuitem" ||
      role === "tab" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "switch" ||
      role === "option"
    );
  }

  function isInteractiveElement(element) {
    const tagName = element.localName;
    if (
      tagName === "button" ||
      tagName === "select" ||
      tagName === "textarea" ||
      tagName === "summary"
    ) {
      return true;
    }
    if (tagName === "a") {
      return element.hasAttribute("href");
    }
    if (tagName === "input") {
      return element.getAttribute("type") !== "hidden";
    }
    if (element.isContentEditable || hasInteractiveRole(element)) {
      return true;
    }

    const tabIndex = element.getAttribute("tabindex");
    if (tabIndex !== null && tabIndex !== "-1") {
      return true;
    }

    return typeof element.onclick === "function";
  }

  function findPointerOwner(node) {
    const element = closestElementInComposedTree(node);
    if (!element) {
      return null;
    }

    let current = element;
    while (current) {
      if (current.localName === "label") {
        const control = "control" in current ? current.control : null;
        if (control instanceof Element) {
          return control;
        }
      }
      if (isInteractiveElement(current)) {
        return current;
      }
      current = parentInComposedTree(current);
    }

    return element;
  }

  function composedContains(container, node) {
    if (!(container instanceof Node) || !(node instanceof Node)) {
      return false;
    }
    let current = node;
    while (current) {
      if (current === container) {
        return true;
      }
      current = parentInComposedTree(current);
    }
    return false;
  }

  function documentRectForElement(element) {
    const ownerWindow = element.ownerDocument?.defaultView;
    if (!ownerWindow) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left + ownerWindow.scrollX,
      top: rect.top + ownerWindow.scrollY,
      right: rect.right + ownerWindow.scrollX,
      bottom: rect.bottom + ownerWindow.scrollY,
    };
  }

  function pointInsideDocumentRect(point, rect) {
    return (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    );
  }

  function isVisiblyBlockingElement(element) {
    const ownerWindow = element.ownerDocument?.defaultView;
    if (!ownerWindow) {
      return false;
    }
    const style = ownerWindow.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
    if (Number.parseFloat(style.opacity || "1") <= 0) {
      return false;
    }
    if (style.pointerEvents === "none") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
`;

const RESOLVE_POINTER_OWNER_DECLARATION = String.raw`function() {
  ` + POINTER_ACTION_HELPERS + String.raw`
  return findPointerOwner(this);
}`;

const CLASSIFY_POINTER_HIT_DECLARATION = String.raw`function(hitNode, point) {
  ` + POINTER_ACTION_HELPERS + String.raw`
  const targetElement = closestElementInComposedTree(this);
  const hitElement = closestElementInComposedTree(hitNode);
  if (!targetElement || !hitElement) {
    return {
      relation: "unknown",
      blocking: false,
      ambiguous: true,
    };
  }

  const targetOwner = findPointerOwner(targetElement);
  const hitOwner = findPointerOwner(hitElement);
  let relation = "outside";
  if (targetElement === hitElement) {
    relation = "self";
  } else if (composedContains(targetElement, hitElement)) {
    relation = "descendant";
  } else if (composedContains(hitElement, targetElement)) {
    relation = "ancestor";
  } else if (targetOwner && hitOwner && targetOwner === hitOwner) {
    relation = "same-owner";
  }

  const targetRect = documentRectForElement(targetOwner || targetElement);
  const blockingCandidate = hitOwner || hitElement;
  const blocking =
    relation === "outside" &&
    blockingCandidate &&
    blockingCandidate !== targetOwner &&
    isVisiblyBlockingElement(blockingCandidate);
  const ambiguous =
    relation === "outside" && !blocking && targetRect
      ? pointInsideDocumentRect(point, targetRect)
      : false;

  return {
    relation,
    blocking,
    ambiguous,
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
          readContentQuads(controller, document, locator, nodeId),
        ]);

        return normalizeActionTargetInspection(state, contentQuads);
      });
    },

    canonicalizePointerTarget(locator) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        return (
          (await callNodeFunctionForLocator(context, controller, document, locator, backendNodeId, {
            functionDeclaration: RESOLVE_POINTER_OWNER_DECLARATION,
          })) ?? locator
        );
      });
    },

    async classifyPointerHit(input) {
      return withLiveNode(
        context,
        input.target,
        async ({ controller, document, backendNodeId }) => {
          const hitLiveNode = context.requireLiveNode(input.hit);
          await context.flushDomUpdateTask(hitLiveNode.controller);

          const value = await callNodeFunctionWithNodeArgument(
            controller,
            document,
            input.target,
            backendNodeId,
            input.hit,
            hitLiveNode.backendNodeId,
            {
              functionDeclaration: CLASSIFY_POINTER_HIT_DECLARATION,
              arguments: [{ value: input.point }],
            },
          );

          const assessment = normalizePointerHitAssessment(value, input.target);
          if (!assessment.blocking || assessment.relation !== "outside") {
            return assessment;
          }

          const hitOwner = await callNodeFunctionForLocator(
            context,
            hitLiveNode.controller,
            hitLiveNode.document,
            input.hit,
            hitLiveNode.backendNodeId,
            {
              functionDeclaration: RESOLVE_POINTER_OWNER_DECLARATION,
            },
          );

          return {
            ...assessment,
            ...(hitOwner === undefined ? {} : { hitOwner }),
          };
        },
      );
    },

    async scrollNodeIntoView(locator, _options) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
        await sendNodeIdCommand(controller, document, locator, "DOM.scrollIntoViewIfNeeded", {
          nodeId,
        });
        await context.flushDomUpdateTask(controller);
      });
    },

    async focusNode(locator) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
        await sendNodeIdCommand(controller, document, locator, "DOM.focus", { nodeId });
        await context.flushDomUpdateTask(controller);
      });
    },

    async finalizeDomAction(pageRef, options) {
      const controller = context.resolveController(pageRef);
      await context.flushPendingPageTasks(controller.sessionRef);
      await options.policySettle(pageRef);
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

async function callNodeFunctionForLocator(
  context: PlaywrightDomActionBridgeContext,
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
  input: {
    readonly functionDeclaration: string;
  },
): Promise<NodeLocator | undefined> {
  let sourceObjectId: string | undefined;
  let resultObjectId: string | undefined;

  try {
    sourceObjectId = await resolveNodeObjectId(controller, document, locator, backendNodeId);
    const evaluated = (await controller.cdp.send("Runtime.callFunctionOn", {
      objectId: sourceObjectId,
      functionDeclaration: input.functionDeclaration,
      returnByValue: false,
      awaitPromise: true,
    })) as {
      readonly result?: {
        readonly objectId?: string;
        readonly subtype?: string;
      };
    };

    if (evaluated.result?.subtype === "null") {
      return undefined;
    }
    resultObjectId = evaluated.result?.objectId;
    if (resultObjectId === undefined) {
      return undefined;
    }

    const requested = (await controller.cdp.send("DOM.requestNode", {
      objectId: resultObjectId,
    })) as {
      readonly nodeId?: number;
    };
    if (requested.nodeId === undefined) {
      return undefined;
    }

    const described = (await controller.cdp.send("DOM.describeNode", {
      nodeId: requested.nodeId,
    })) as {
      readonly node?: {
        readonly backendNodeId?: number;
      };
    };
    if (described.node?.backendNodeId === undefined) {
      return undefined;
    }

    return context.locateBackendNode(document, described.node.backendNodeId);
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  } finally {
    await releaseObject(controller, resultObjectId);
    await releaseObject(controller, sourceObjectId);
  }
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

async function callNodeFunctionWithNodeArgument(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
  argumentLocator: NodeLocator,
  argumentBackendNodeId: number,
  input: {
    readonly functionDeclaration: string;
    readonly arguments?: { readonly value: unknown }[];
  },
): Promise<unknown> {
  let objectId: string | undefined;
  let argumentObjectId: string | undefined;

  try {
    objectId = await resolveNodeObjectId(controller, document, locator, backendNodeId);
    argumentObjectId = await resolveNodeObjectId(
      controller,
      document,
      argumentLocator,
      argumentBackendNodeId,
    );
    const evaluated = (await controller.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: input.functionDeclaration,
      arguments: [{ objectId: argumentObjectId }, ...(input.arguments ?? [])],
      returnByValue: true,
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
    await releaseObject(controller, argumentObjectId);
    await releaseObject(controller, objectId);
  }
}

async function resolveNodeObjectId(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
): Promise<string> {
  try {
    const resolved = (await controller.cdp.send("DOM.resolveNode", {
      backendNodeId,
    })) as {
      readonly object?: {
        readonly objectId?: string;
      };
    };
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) {
      throw staleNodeRefError(locator);
    }
    return objectId;
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
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

async function sendNodeIdCommand<TResult>(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  method: Parameters<PageController["cdp"]["send"]>[0],
  params: Parameters<PageController["cdp"]["send"]>[1],
): Promise<TResult> {
  try {
    return (await controller.cdp.send(method, params)) as TResult;
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  }
}

async function readContentQuads(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  nodeId: number,
): Promise<readonly Quad[]> {
  const metrics = await getViewportMetricsFromCdp(controller);
  const result = await sendNodeIdCommand<{
    readonly quads?: ReadonlyArray<readonly number[]>;
  }>(controller, document, locator, "DOM.getContentQuads", { nodeId });

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

function normalizePointerHitAssessment(
  value: unknown,
  canonicalTarget: NodeLocator,
): DomPointerHitAssessment {
  if (!value || typeof value !== "object") {
    throw new Error("DOM action bridge returned an invalid pointer hit payload");
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.relation !== "self" &&
    candidate.relation !== "descendant" &&
    candidate.relation !== "ancestor" &&
    candidate.relation !== "same-owner" &&
    candidate.relation !== "outside" &&
    candidate.relation !== "unknown"
  ) {
    throw new Error("DOM action bridge returned an invalid pointer hit relation");
  }
  if (typeof candidate.blocking !== "boolean") {
    throw new Error("DOM action bridge returned an invalid pointer hit payload");
  }
  if (candidate.ambiguous !== undefined && typeof candidate.ambiguous !== "boolean") {
    throw new Error("DOM action bridge returned an invalid pointer hit payload");
  }

  return {
    relation: candidate.relation,
    blocking: candidate.blocking,
    ...(candidate.ambiguous === undefined ? {} : { ambiguous: candidate.ambiguous }),
    canonicalTarget,
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

async function releaseObject(
  controller: PageController,
  objectId: string | undefined,
): Promise<void> {
  if (objectId === undefined) {
    return;
  }
  await controller.cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
}
