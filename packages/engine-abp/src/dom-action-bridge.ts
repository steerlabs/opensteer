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
import type {
  DomActionBridge,
  DomActionTargetInspection,
  DomPointerHitAssessment,
} from "@opensteer/protocol";

import type { DocumentState, PageController, SessionState } from "./types.js";
import {
  clampAbpActionSettleTimeout,
  type AbpActionBoundaryOptions,
} from "./action-settle.js";

interface AbpDomActionBridgeContext {
  resolveController(pageRef: PageRef): PageController;
  resolveSession(sessionRef: SessionRef): SessionState;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  settleActionBoundary(
    controller: PageController,
    options: AbpActionBoundaryOptions,
  ): Promise<void>;
  syncExecutionPaused(controller: PageController): Promise<boolean>;
  setExecutionPaused(controller: PageController, paused: boolean): Promise<void>;
  isPageClosedError(error: unknown): boolean;
  locateBackendNode(document: DocumentState, backendNodeId: number): NodeLocator;
  requireLiveNode(locator: NodeLocator): {
    readonly document: DocumentState;
    readonly backendNodeId: number;
  };
  getDomSnapshot(documentRef: string): Promise<DomSnapshot>;
  getViewportMetrics(pageRef: PageRef): Promise<ViewportMetrics>;
}

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

    async canonicalizePointerTarget(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(context, locator);
      return withTemporaryExecutionResume(context, controller, async () => {
        return (
          (await callNodeFunctionForLocator(context, controller, document, locator, backendNodeId, {
            functionDeclaration: RESOLVE_POINTER_OWNER_DECLARATION,
          })) ?? locator
        );
      });
    },

    async classifyPointerHit(input) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(
        context,
        input.target,
      );
      const hitLiveNode = context.requireLiveNode(input.hit);

      return withTemporaryExecutionResume(context, controller, async () => {
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
          controller,
          document,
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
      });
    },

    async scrollNodeIntoView(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(context, locator);
      const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
      await withTemporaryExecutionResume(context, controller, async () => {
        await controller.cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId });
        await context.flushDomUpdateTask(controller);
      });
    },

    async focusNode(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(context, locator);
      const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
      await withTemporaryExecutionResume(context, controller, async () => {
        await controller.cdp.send("DOM.focus", { nodeId });
        await context.flushDomUpdateTask(controller);
      });
    },

    async finalizeDomAction(pageRef, options) {
      const controller = context.resolveController(pageRef);
      await context.settleActionBoundary(controller, {
        timeoutMs: clampAbpActionSettleTimeout(options.remainingMs()),
        signal: options.signal,
        policySettle: options.policySettle,
      });
      const session = context.resolveSession(controller.sessionRef);
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

async function callNodeFunctionForLocator(
  context: AbpDomActionBridgeContext,
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
    const evaluated = await controller.cdp.send<{
      readonly result?: {
        readonly objectId?: string;
        readonly subtype?: string;
      };
    }>("Runtime.callFunctionOn", {
      objectId: sourceObjectId,
      functionDeclaration: input.functionDeclaration,
      returnByValue: false,
      awaitPromise: true,
    });
    if (evaluated.result?.subtype === "null") {
      return undefined;
    }
    resultObjectId = evaluated.result?.objectId;
    if (resultObjectId === undefined) {
      return undefined;
    }

    const requested = await controller.cdp.send<{
      readonly nodeId?: number;
    }>("DOM.requestNode", { objectId: resultObjectId });
    if (requested.nodeId === undefined) {
      return undefined;
    }

    const described = await controller.cdp.send<{
      readonly node?: {
        readonly backendNodeId?: number;
      };
    }>("DOM.describeNode", { nodeId: requested.nodeId });
    if (described.node?.backendNodeId === undefined) {
      return undefined;
    }

    return context.locateBackendNode(document, described.node.backendNodeId);
  } catch (error) {
    rethrowNodeLookupError(document, locator, error);
  } finally {
    await releaseObject(controller, resultObjectId);
    await releaseObject(controller, sourceObjectId);
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

    const evaluated = await controller.cdp.send<{
      readonly result?: {
        readonly value?: unknown;
      };
    }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: input.functionDeclaration,
      arguments: [{ objectId: argumentObjectId }, ...(input.arguments ?? [])],
      returnByValue: true,
      awaitPromise: true,
    });
    return evaluated.result?.value;
  } catch (error) {
    rethrowNodeLookupError(document, locator, error);
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
    const resolved = await controller.cdp.send<{
      readonly object?: {
        readonly objectId?: string;
      };
    }>("DOM.resolveNode", {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) {
      throw staleNodeRefError(locator);
    }
    return objectId;
  } catch (error) {
    rethrowNodeLookupError(document, locator, error);
  }
}

async function withTemporaryExecutionResume<T>(
  context: AbpDomActionBridgeContext,
  controller: PageController,
  execute: () => Promise<T>,
): Promise<T> {
  const wasPaused = await context.syncExecutionPaused(controller);
  if (wasPaused) {
    await context.setExecutionPaused(controller, false);
  }
  try {
    return await execute();
  } finally {
    if (wasPaused && controller.lifecycleState !== "closed") {
      try {
        await context.setExecutionPaused(controller, true);
      } catch (error) {
        if (!context.isPageClosedError(error)) {
          throw error;
        }
      }
    }
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

function rethrowNodeLookupError(
  document: DocumentState,
  locator: NodeLocator,
  error: unknown,
): never {
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

async function releaseObject(
  controller: PageController,
  objectId: string | undefined,
): Promise<void> {
  if (objectId === undefined) {
    return;
  }
  await controller.cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
}
