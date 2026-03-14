import {
  createRect,
  nextDocumentEpoch,
  rectToQuad,
  staleNodeRefError,
  type DocumentRef,
  type DomSnapshot,
  type DomSnapshotNode,
  type NodeLocator,
  type NodeRef,
  type Rect,
} from "@opensteer/browser-core";
import type { CDPSession } from "playwright";
import type {
  CapturedDomSnapshot,
  DocumentState,
  DomSnapshotDocument,
  DomTreeNode,
  FrameState,
  ShadowBoundaryInfo,
} from "./types.js";
import {
  buildShadowBoundaryIndex,
  normalizeShadowRootType,
  parseStringTable,
  rareIntegerValue,
  rareStringValue,
} from "./normalize.js";

export async function capturePageDomSnapshot(
  cdp: CDPSession,
  options: {
    readonly includeLayout: boolean;
  },
): Promise<{
  readonly capturedAt: number;
  readonly documents: readonly DomSnapshotDocument[];
  readonly shadowBoundariesByBackendNodeId: ReadonlyMap<number, ShadowBoundaryInfo>;
  readonly strings: readonly string[];
}> {
  const capturedAt = Date.now();
  const [snapshotResult, domTreeResult] = await Promise.all([
    cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: options.includeLayout,
      includeDOMRects: options.includeLayout,
    }),
    cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    }),
  ]);
  return {
    capturedAt,
    documents: snapshotResult.documents as readonly DomSnapshotDocument[],
    shadowBoundariesByBackendNodeId: buildShadowBoundaryIndex(domTreeResult.root as DomTreeNode),
    strings: snapshotResult.strings,
  };
}

export function findCapturedDocument(
  captured: {
    readonly documents: readonly DomSnapshotDocument[];
    readonly strings: readonly string[];
  },
  cdpFrameId: string,
): DomSnapshotDocument | undefined {
  return captured.documents.find(
    (candidate) => parseStringTable(captured.strings, candidate.frameId) === cdpFrameId,
  );
}

export function updateDocumentTreeSignature(
  document: DocumentState,
  rawDocument: DomSnapshotDocument,
  retiredDocuments: ReadonlySet<DocumentRef>,
): void {
  const backendNodeIds = (rawDocument.nodes.backendNodeId ?? [])
    .filter((value): value is number => value !== undefined)
    .slice()
    .sort((left, right) => left - right);
  const signature = `${rawDocument.nodes.nodeType?.length ?? 0}:${backendNodeIds.join(",")}`;

  if (
    document.domTreeSignature !== undefined &&
    document.domTreeSignature !== signature &&
    !retiredDocuments.has(document.documentRef)
  ) {
    document.documentEpoch = nextDocumentEpoch(document.documentEpoch);
    document.nodeRefsByBackendNodeId.clear();
    document.backendNodeIdsByNodeRef.clear();
  }

  document.domTreeSignature = signature;
}

export function resolveCapturedContentDocumentRef(
  framesByCdpId: ReadonlyMap<string, FrameState>,
  captured: CapturedDomSnapshot,
  contentDocumentIndex: number,
): DocumentRef | undefined {
  const contentDocument = captured.documents[contentDocumentIndex];
  if (!contentDocument) {
    return undefined;
  }

  const cdpFrameId = parseStringTable(captured.strings, contentDocument.frameId);
  if (cdpFrameId.length === 0) {
    return undefined;
  }

  return framesByCdpId.get(cdpFrameId)?.currentDocument.documentRef;
}

export function findHtmlBackendNodeId(
  captured: CapturedDomSnapshot,
  document: DocumentState,
): number | undefined {
  const nodeNames = captured.rawDocument.nodes.nodeName ?? [];
  const backendNodeIds = captured.rawDocument.nodes.backendNodeId ?? [];
  for (let index = 0; index < nodeNames.length; index += 1) {
    const nodeName = parseStringTable(captured.strings, nodeNames[index]);
    if (nodeName === "HTML") {
      return backendNodeIds[index];
    }
  }
  return document.backendNodeIdsByNodeRef.values().next().value;
}

export function readTextContent(
  captured: CapturedDomSnapshot,
  input: NodeLocator,
  backendNodeId: number,
): string | null {
  const backendNodeIds = captured.rawDocument.nodes.backendNodeId ?? [];
  const nodeIndex = backendNodeIds.findIndex((value) => value === backendNodeId);
  if (nodeIndex === -1) {
    throw staleNodeRefError(input);
  }

  const parentIndexes = captured.rawDocument.nodes.parentIndex ?? [];
  const childIndexes = new Map<number, number[]>();
  for (let index = 0; index < parentIndexes.length; index += 1) {
    const parentIndex = parentIndexes[index];
    if (parentIndex === undefined || parentIndex < 0) {
      continue;
    }
    const children = childIndexes.get(parentIndex) ?? [];
    children.push(index);
    childIndexes.set(parentIndex, children);
  }

  const visit = (index: number): string | null => {
    const nodeType = captured.rawDocument.nodes.nodeType?.[index] ?? 0;
    if (nodeType === 9 || nodeType === 10) {
      return null;
    }
    if (nodeType === 3 || nodeType === 4 || nodeType === 7 || nodeType === 8) {
      return parseStringTable(captured.strings, captured.rawDocument.nodes.nodeValue?.[index]);
    }

    let text = "";
    for (const childIndex of childIndexes.get(index) ?? []) {
      const childText = visit(childIndex);
      if (childText !== null) {
        text += childText;
      }
    }
    return text;
  };

  return visit(nodeIndex);
}

export function buildDomSnapshot(
  document: DocumentState,
  captured: CapturedDomSnapshot,
  nodeRefResolver: (document: DocumentState, backendNodeId: number) => NodeRef,
  contentDocRefResolver: (contentDocumentIndex: number) => DocumentRef | undefined,
): DomSnapshot {
  const parentIndexes = captured.rawDocument.nodes.parentIndex ?? [];
  const childIndexes = new Map<number, number[]>();
  for (let index = 0; index < parentIndexes.length; index += 1) {
    const parentIndex = parentIndexes[index];
    if (parentIndex === undefined || parentIndex < 0) {
      continue;
    }
    const children = childIndexes.get(parentIndex) ?? [];
    children.push(index);
    childIndexes.set(parentIndex, children);
  }

  const layoutByNodeIndex = new Map<
    number,
    {
      readonly rect?: Rect;
      readonly paintOrder?: number;
    }
  >();
  for (let index = 0; index < captured.rawDocument.layout.nodeIndex.length; index += 1) {
    const nodeIndex = captured.rawDocument.layout.nodeIndex[index];
    if (nodeIndex === undefined) {
      continue;
    }
    const bounds = captured.rawDocument.layout.bounds[index];
    layoutByNodeIndex.set(nodeIndex, {
      ...(bounds === undefined
        ? {}
        : {
            rect: createRect(bounds[0] ?? 0, bounds[1] ?? 0, bounds[2] ?? 0, bounds[3] ?? 0),
          }),
      ...(captured.rawDocument.layout.paintOrders?.[index] === undefined
        ? {}
        : { paintOrder: captured.rawDocument.layout.paintOrders[index] }),
    });
  }

  const nodes: DomSnapshotNode[] = [];
  const nodeCount = captured.rawDocument.nodes.nodeType?.length ?? 0;
  for (let index = 0; index < nodeCount; index += 1) {
    const backendNodeId = captured.rawDocument.nodes.backendNodeId?.[index];
    const nodeRef =
      backendNodeId === undefined
        ? undefined
        : nodeRefResolver(document, backendNodeId);
    const rawAttributes = captured.rawDocument.nodes.attributes?.[index] ?? [];
    const attributes: { name: string; value: string }[] = [];
    for (let pairIndex = 0; pairIndex < rawAttributes.length; pairIndex += 2) {
      const nameIndex = rawAttributes[pairIndex];
      const valueIndex = rawAttributes[pairIndex + 1];
      if (nameIndex === undefined || valueIndex === undefined) {
        continue;
      }
      attributes.push({
        name: parseStringTable(captured.strings, nameIndex),
        value: parseStringTable(captured.strings, valueIndex),
      });
    }
    const layout = layoutByNodeIndex.get(index);
    const shadowRootType = rareStringValue(
      captured.strings,
      captured.rawDocument.nodes.shadowRootType,
      index,
    );
    const normalizedShadowRootType = normalizeShadowRootType(shadowRootType);
    const shadowBoundary =
      backendNodeId === undefined
        ? undefined
        : captured.shadowBoundariesByBackendNodeId.get(backendNodeId);
    const shadowHostNodeRef =
      shadowBoundary?.shadowHostBackendNodeId === undefined
        ? undefined
        : nodeRefResolver(document, shadowBoundary.shadowHostBackendNodeId);
    const contentDocumentIndex = rareIntegerValue(
      captured.rawDocument.nodes.contentDocumentIndex,
      index,
    );
    const contentDocumentRef =
      contentDocumentIndex === undefined
        ? undefined
        : contentDocRefResolver(contentDocumentIndex);
    const textContent =
      parseStringTable(captured.strings, captured.rawDocument.layout.text[index]) ||
      rareStringValue(captured.strings, captured.rawDocument.nodes.textValue, index) ||
      rareStringValue(captured.strings, captured.rawDocument.nodes.inputValue, index) ||
      (captured.rawDocument.nodes.nodeType?.[index] === 3
        ? parseStringTable(captured.strings, captured.rawDocument.nodes.nodeValue?.[index])
        : undefined);
    nodes.push({
      snapshotNodeId: index + 1,
      ...(nodeRef === undefined ? {} : { nodeRef }),
      ...(parentIndexes[index] === undefined || parentIndexes[index]! < 0
        ? {}
        : { parentSnapshotNodeId: parentIndexes[index]! + 1 }),
      childSnapshotNodeIds: (childIndexes.get(index) ?? []).map((childIndex) => childIndex + 1),
      ...(normalizedShadowRootType === undefined
        ? {}
        : { shadowRootType: normalizedShadowRootType }),
      ...(shadowHostNodeRef === undefined ? {} : { shadowHostNodeRef }),
      ...(contentDocumentRef === undefined ? {} : { contentDocumentRef }),
      nodeType: captured.rawDocument.nodes.nodeType?.[index] ?? 0,
      nodeName: parseStringTable(captured.strings, captured.rawDocument.nodes.nodeName?.[index]),
      nodeValue: parseStringTable(
        captured.strings,
        captured.rawDocument.nodes.nodeValue?.[index],
      ),
      ...(textContent === undefined || textContent.length === 0 ? {} : { textContent }),
      attributes,
      ...(layout?.rect === undefined
        ? {}
        : {
            layout: {
              rect: layout.rect,
              quad: rectToQuad(layout.rect),
              ...(layout.paintOrder === undefined ? {} : { paintOrder: layout.paintOrder }),
            },
          }),
    });
  }

  return {
    pageRef: document.pageRef,
    frameRef: document.frameRef,
    documentRef: document.documentRef,
    ...(document.parentDocumentRef === undefined
      ? {}
      : { parentDocumentRef: document.parentDocumentRef }),
    documentEpoch: document.documentEpoch,
    url: document.url,
    capturedAt: captured.capturedAt,
    rootSnapshotNodeId: 1,
    shadowDomMode: "preserved",
    geometryCoordinateSpace: "document-css",
    nodes,
  };
}
