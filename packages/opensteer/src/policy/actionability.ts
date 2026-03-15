import {
  createPoint,
  createRect,
  rectContainsPoint,
  type DocumentRef,
  type DomSnapshot,
  type DomSnapshotNode,
  type NodeRef,
  type Point,
  type Rect,
} from "@opensteer/browser-core";
import { OpensteerProtocolError } from "@opensteer/protocol";

import { createSnapshotIndex } from "../runtimes/dom/path.js";
import {
  type DomSnapshotIndex,
  findIframeHostNode,
  findNodeByNodeRef,
  findNodeBySnapshotNodeId,
  isSameNodeOrDescendant,
} from "../runtimes/dom/selectors.js";
import type {
  ActionabilityCheckInput,
  ActionabilityCheckResult,
  ActionabilityFailureDetails,
  ActionabilityPolicy,
  DomActionPolicyOperation,
} from "./types.js";

export const defaultActionabilityPolicy: ActionabilityPolicy = {
  check: checkActionability,
};
Object.freeze(defaultActionabilityPolicy);

export async function checkActionability(
  input: ActionabilityCheckInput,
): Promise<ActionabilityCheckResult> {
  const rect = input.resolved.node.layout?.rect;
  const hiddenAttribute = findAttribute(input.resolved.node, "hidden");
  if (hiddenAttribute !== undefined) {
    return failure("not-visible", `target ${input.resolved.nodeRef} is hidden`, {
      ...(rect === undefined ? {} : { rect }),
      attribute: hiddenAttribute.name,
    });
  }

  const ariaHidden = findAttributeValue(input.resolved.node, "aria-hidden");
  if (ariaHidden === "true") {
    return failure(
      "not-visible",
      `target ${input.resolved.nodeRef} is hidden from the accessibility tree`,
      {
        ...(rect === undefined ? {} : { rect }),
        attribute: "aria-hidden",
      },
    );
  }

  if (!rect) {
    return failure(
      "missing-geometry",
      `target ${input.resolved.nodeRef} does not expose DOM geometry`,
    );
  }

  if (rect.width <= 0 || rect.height <= 0) {
    return failure("not-visible", `target ${input.resolved.nodeRef} has zero-size geometry`, {
      rect,
    });
  }

  const disabledAttribute = findAttribute(input.resolved.node, "disabled");
  if (disabledAttribute !== undefined) {
    return failure("disabled", `target ${input.resolved.nodeRef} is disabled`, {
      rect,
      attribute: disabledAttribute.name,
    });
  }

  const ariaDisabled = findAttributeValue(input.resolved.node, "aria-disabled");
  if (ariaDisabled === "true") {
    return failure("disabled", `target ${input.resolved.nodeRef} is marked aria-disabled`, {
      rect,
      attribute: "aria-disabled",
    });
  }

  const localPoint =
    input.position === undefined
      ? createPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      : createPoint(rect.x + input.position.x, rect.y + input.position.y);
  const point = await resolvePagePointFromDocumentPoint(
    input.loadDocumentSnapshot,
    input.resolved.snapshot,
    localPoint,
  );
  const metrics = await input.engine.getViewportMetrics({ pageRef: input.resolved.pageRef });
  const viewportRect = createRect(
    metrics.visualViewport.origin.x,
    metrics.visualViewport.origin.y,
    metrics.visualViewport.size.width,
    metrics.visualViewport.size.height,
  );
  if (!rectContainsPoint(viewportRect, point)) {
    return failure(
      "not-in-viewport",
      `target point for ${input.resolved.nodeRef} is outside the visual viewport`,
      {
        rect,
        point,
        viewportRect,
      },
    );
  }

  const hit = await input.engine.hitTest({
    pageRef: input.resolved.pageRef,
    point,
    coordinateSpace: "document-css",
  });
  const hitDetails: ActionabilityFailureDetails = {
    rect,
    point,
    viewportRect,
    ...(hit.nodeRef === undefined ? {} : { hitNodeRef: hit.nodeRef }),
    hitDocumentRef: hit.documentRef,
    hitDocumentEpoch: hit.documentEpoch,
    hitObscured: hit.obscured,
    pointerEventsSkipped: hit.pointerEventsSkipped,
  };

  if (
    hit.documentRef !== input.resolved.documentRef ||
    hit.documentEpoch !== input.resolved.documentEpoch
  ) {
    return failure(
      "obscured",
      `hit test resolved outside ${input.resolved.documentRef}@${String(input.resolved.documentEpoch)}`,
      hitDetails,
    );
  }

  if (hit.nodeRef === undefined) {
    return failure(
      "obscured",
      `hit test did not resolve a live node for ${input.operation}`,
      hitDetails,
    );
  }

  const index = createSnapshotIndex(input.resolved.snapshot);
  if (!acceptsHitTarget(index, input.operation, hit.nodeRef, input.resolved.nodeRef)) {
    return failure(
      "obscured",
      `hit test resolved ${hit.nodeRef} outside the target subtree rooted at ${input.resolved.nodeRef}`,
      hitDetails,
    );
  }

  return {
    actionable: true,
    point,
  };
}

export function toActionabilityError(
  operation: ActionabilityCheckInput["operation"],
  result: Extract<ActionabilityCheckResult, { readonly actionable: false }>,
): OpensteerProtocolError {
  return new OpensteerProtocolError("operation-failed", result.message, {
    details: {
      policy: "actionability",
      operation,
      reason: result.reason,
      ...(result.details === undefined ? {} : result.details),
    },
  });
}

export function assertValidActionPosition(
  target: {
    readonly nodeRef: string;
    readonly node: {
      readonly layout?: {
        readonly rect?: Rect;
      };
    };
  },
  position: Point,
): void {
  const rect = target.node.layout?.rect;
  if (!rect) {
    return;
  }

  const localPoint = createPoint(rect.x + position.x, rect.y + position.y);
  if (!rectContainsPoint(rect, localPoint)) {
    throw new OpensteerProtocolError(
      "invalid-argument",
      `target point for ${target.nodeRef} falls outside the resolved DOM box`,
      {
        details: {
          position,
          rect,
        },
      },
    );
  }
}

async function resolvePagePointFromDocumentPoint(
  loadDocumentSnapshot: (documentRef: DocumentRef) => Promise<DomSnapshot>,
  snapshot: DomSnapshot,
  point: Point,
): Promise<Point> {
  let currentSnapshot = snapshot;
  let currentPoint = point;

  while (currentSnapshot.parentDocumentRef !== undefined) {
    const parentSnapshot = await loadDocumentSnapshot(currentSnapshot.parentDocumentRef);
    const parentIndex = createSnapshotIndex(parentSnapshot);
    const iframeHost = findIframeHostNode(parentIndex, currentSnapshot.documentRef);
    if (!iframeHost?.layout?.rect) {
      throw new Error(
        `iframe host for ${currentSnapshot.documentRef} does not expose DOM geometry`,
      );
    }

    currentPoint = createPoint(
      iframeHost.layout.rect.x + currentPoint.x,
      iframeHost.layout.rect.y + currentPoint.y,
    );
    currentSnapshot = parentSnapshot;
  }

  return currentPoint;
}

function failure(
  reason: Extract<ActionabilityCheckResult, { readonly actionable: false }>["reason"],
  message: string,
  details?: ActionabilityFailureDetails,
): Extract<ActionabilityCheckResult, { readonly actionable: false }> {
  return {
    actionable: false,
    reason,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function findAttribute(node: DomSnapshotNode, name: string) {
  return node.attributes.find((attribute) => attribute.name.toLowerCase() === name);
}

function findAttributeValue(node: DomSnapshotNode, name: string): string | undefined {
  return findAttribute(node, name)?.value.trim().toLowerCase();
}

function findAttributeText(node: DomSnapshotNode, name: string): string | undefined {
  return findAttribute(node, name)?.value.trim();
}

function acceptsHitTarget(
  index: DomSnapshotIndex,
  operation: DomActionPolicyOperation,
  hitNodeRef: NodeRef,
  targetNodeRef: NodeRef,
): boolean {
  if (isSameNodeOrDescendant(index, hitNodeRef, targetNodeRef)) {
    return true;
  }
  if (!isActivationOperation(operation)) {
    return false;
  }
  return isAssociatedLabelHit(index, hitNodeRef, targetNodeRef);
}

function isActivationOperation(operation: DomActionPolicyOperation): boolean {
  return operation === "dom.click" || operation === "dom.input";
}

function isAssociatedLabelHit(
  index: DomSnapshotIndex,
  hitNodeRef: NodeRef,
  targetNodeRef: NodeRef,
): boolean {
  const targetNode = findNodeByNodeRef(index, targetNodeRef);
  if (!targetNode) {
    return false;
  }
  const targetId = findAttributeText(targetNode, "id");
  const labelNode = findAssociatedLabelAncestor(index, hitNodeRef, targetNodeRef, targetId);
  return labelNode !== undefined;
}

function isAssociatedLabelNode(
  index: DomSnapshotIndex,
  candidate: DomSnapshotNode,
  targetNodeRef: NodeRef,
  targetId: string | undefined,
): boolean {
  if (candidate.nodeType !== 1 || candidate.nodeName.toLowerCase() !== "label") {
    return false;
  }
  if (candidate.nodeRef && isSameNodeOrDescendant(index, targetNodeRef, candidate.nodeRef)) {
    return true;
  }
  const htmlFor = findAttributeText(candidate, "for");
  return targetId !== undefined && htmlFor === targetId;
}

function findAssociatedLabelAncestor(
  index: DomSnapshotIndex,
  startNodeRef: NodeRef,
  targetNodeRef: NodeRef,
  targetId: string | undefined,
): DomSnapshotNode | undefined {
  const startNode = findNodeByNodeRef(index, startNodeRef);
  if (!startNode) {
    return undefined;
  }

  const stack: DomSnapshotNode[] = [startNode];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.snapshotNodeId)) {
      continue;
    }
    visited.add(current.snapshotNodeId);

    if (isAssociatedLabelNode(index, current, targetNodeRef, targetId)) {
      return current;
    }

    if (current.parentSnapshotNodeId !== undefined) {
      const parent = findNodeBySnapshotNodeId(index, current.parentSnapshotNodeId);
      if (parent) {
        stack.push(parent);
      }
    }

    if (current.shadowHostNodeRef !== undefined) {
      const host = findNodeByNodeRef(index, current.shadowHostNodeRef);
      if (host) {
        stack.push(host);
      }
    }
  }

  return undefined;
}
