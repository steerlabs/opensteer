import {
  buildCdpShadowBoundaryIndex,
  buildDomSnapshotFromCdpCapture,
  DOM_SNAPSHOT_COMPUTED_STYLE_NAMES,
  nextDocumentEpoch,
  parseCdpStringTable,
  staleNodeRefError,
  type DocumentRef,
  type DomSnapshot,
  type NodeLocator,
  type NodeRef,
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
      computedStyles: [...DOM_SNAPSHOT_COMPUTED_STYLE_NAMES],
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
    shadowBoundariesByBackendNodeId: buildCdpShadowBoundaryIndex(
      domTreeResult.root as DomTreeNode,
    ) as ReadonlyMap<number, ShadowBoundaryInfo>,
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
    (candidate) => parseCdpStringTable(captured.strings, candidate.frameId) === cdpFrameId,
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
  captured: Pick<CapturedDomSnapshot, "documents" | "strings">,
  contentDocumentIndex: number,
): DocumentRef | undefined {
  const contentDocument = captured.documents[contentDocumentIndex];
  if (!contentDocument) {
    return undefined;
  }

  const cdpFrameId = parseCdpStringTable(captured.strings, contentDocument.frameId);
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
    if (parseCdpStringTable(captured.strings, nodeNames[index]) === "HTML") {
      return backendNodeIds[index];
    }
  }
  return document.backendNodeIdsByNodeRef.values().next().value;
}

export function buildDomSnapshot(
  document: DocumentState,
  captured: CapturedDomSnapshot,
  nodeRefResolver: (document: DocumentState, backendNodeId: number) => NodeRef,
  contentDocRefResolver: (contentDocumentIndex: number) => DocumentRef | undefined,
): DomSnapshot {
  return buildDomSnapshotFromCdpCapture(
    document,
    captured,
    (backendNodeId) => nodeRefResolver(document, backendNodeId),
    contentDocRefResolver,
  );
}

export function readTextContent(snapshot: DomSnapshot, input: NodeLocator): string | null {
  const node = snapshot.nodes.find((candidate) => candidate.nodeRef === input.nodeRef);
  if (!node) {
    throw staleNodeRefError(input);
  }
  if (node.nodeType === 9 || node.nodeType === 10) {
    return null;
  }
  return node.textContent ?? "";
}
