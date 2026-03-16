import { createRect, rectToQuad, type Rect } from "./geometry.js";
import type { DocumentEpoch, DocumentRef, FrameRef, NodeRef, PageRef } from "./identity.js";
import type { DomSnapshot } from "./snapshots.js";

export const DOM_SNAPSHOT_COMPUTED_STYLE_NAMES = [
  "display",
  "visibility",
  "opacity",
  "position",
  "cursor",
  "overflow-x",
  "overflow-y",
] as const;

export interface CdpRareStringData {
  readonly index: readonly number[];
  readonly value: readonly number[];
}

export interface CdpRareIntegerData {
  readonly index: readonly number[];
  readonly value: readonly number[];
}

export interface CdpShadowBoundaryInfo {
  readonly shadowRootType?: "open" | "closed" | "user-agent";
  readonly shadowHostBackendNodeId?: number;
}

export interface CdpDomTreeNode {
  readonly backendNodeId?: number;
  readonly children?: readonly CdpDomTreeNode[];
  readonly shadowRoots?: readonly CdpDomTreeNode[];
  readonly contentDocument?: CdpDomTreeNode;
  readonly shadowRootType?: string;
}

export interface CdpDomSnapshotDocument {
  readonly frameId: number;
  readonly nodes: {
    readonly parentIndex?: readonly number[];
    readonly nodeType?: readonly number[];
    readonly shadowRootType?: CdpRareStringData;
    readonly nodeName?: readonly number[];
    readonly nodeValue?: readonly number[];
    readonly backendNodeId?: readonly number[];
    readonly attributes?: ReadonlyArray<readonly number[]>;
    readonly textValue?: CdpRareStringData;
    readonly inputValue?: CdpRareStringData;
    readonly contentDocumentIndex?: CdpRareIntegerData;
  };
  readonly layout: {
    readonly nodeIndex: readonly number[];
    readonly styles?: ReadonlyArray<readonly number[]>;
    readonly bounds: ReadonlyArray<readonly number[]>;
    readonly text: readonly number[];
    readonly paintOrders?: readonly number[];
  };
}

export interface CapturedCdpDomSnapshot {
  readonly capturedAt: number;
  readonly rawDocument: CdpDomSnapshotDocument;
  readonly shadowBoundariesByBackendNodeId: ReadonlyMap<number, CdpShadowBoundaryInfo>;
  readonly strings: readonly string[];
}

interface SnapshotDocumentIdentity {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly documentRef: DocumentRef;
  readonly parentDocumentRef: DocumentRef | undefined;
  readonly documentEpoch: DocumentEpoch;
  readonly url: string;
}

interface DecodedNodeLayout {
  readonly rect?: Rect;
  readonly paintOrder?: number;
  readonly computedStyle?: {
    readonly display?: string;
    readonly visibility?: string;
    readonly opacity?: string;
    readonly position?: string;
    readonly cursor?: string;
    readonly overflowX?: string;
    readonly overflowY?: string;
  };
}

export function parseCdpStringTable(strings: readonly string[], index: number | undefined): string {
  if (index === undefined || index < 0) {
    return "";
  }
  return strings[index] ?? "";
}

export function rareCdpStringValue(
  strings: readonly string[],
  data: CdpRareStringData | undefined,
  index: number,
): string | undefined {
  if (!data) {
    return undefined;
  }
  const matchIndex = data.index.findIndex((candidate) => candidate === index);
  if (matchIndex === -1) {
    return undefined;
  }
  return parseCdpStringTable(strings, data.value[matchIndex]);
}

export function rareCdpIntegerValue(
  data: CdpRareIntegerData | undefined,
  index: number,
): number | undefined {
  if (!data) {
    return undefined;
  }
  const matchIndex = data.index.findIndex((candidate) => candidate === index);
  if (matchIndex === -1) {
    return undefined;
  }
  return data.value[matchIndex];
}

export function normalizeCdpShadowRootType(
  value: string | undefined,
): "open" | "closed" | "user-agent" | undefined {
  switch (value) {
    case "open":
    case "closed":
      return value;
    case "user-agent":
    case "user_agent":
      return "user-agent";
    default:
      return undefined;
  }
}

export function buildCdpShadowBoundaryIndex(
  root: CdpDomTreeNode,
): ReadonlyMap<number, CdpShadowBoundaryInfo> {
  const byBackendNodeId = new Map<number, CdpShadowBoundaryInfo>();

  const visit = (node: CdpDomTreeNode, boundary: CdpShadowBoundaryInfo): void => {
    if (node.backendNodeId !== undefined) {
      byBackendNodeId.set(node.backendNodeId, boundary);
    }

    for (const child of node.children ?? []) {
      visit(child, boundary);
    }

    for (const shadowRoot of node.shadowRoots ?? []) {
      const normalizedShadowRootType = normalizeCdpShadowRootType(shadowRoot.shadowRootType);
      const shadowBoundary: CdpShadowBoundaryInfo = {
        ...(node.backendNodeId === undefined
          ? {}
          : { shadowHostBackendNodeId: node.backendNodeId }),
        ...(normalizedShadowRootType === undefined
          ? {}
          : { shadowRootType: normalizedShadowRootType }),
      };

      if (shadowRoot.backendNodeId !== undefined) {
        byBackendNodeId.set(shadowRoot.backendNodeId, shadowBoundary);
      }

      for (const child of shadowRoot.children ?? []) {
        visit(child, shadowBoundary);
      }
    }

    if (node.contentDocument) {
      visit(node.contentDocument, {});
    }
  };

  visit(root, {});
  return byBackendNodeId;
}

export function buildDomSnapshotFromCdpCapture(
  document: SnapshotDocumentIdentity,
  captured: CapturedCdpDomSnapshot,
  nodeRefResolver: (backendNodeId: number) => NodeRef,
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

  const layoutByNodeIndex = decodeLayoutByNodeIndex(captured.rawDocument, captured.strings);
  const aggregatedTextByNodeIndex = buildAggregatedTextIndex(
    captured.rawDocument,
    captured.shadowBoundariesByBackendNodeId,
    captured.strings,
  );
  const rootNodeIndex = findRootNodeIndex(parentIndexes);

  const nodes = [];
  const nodeCount = captured.rawDocument.nodes.nodeType?.length ?? 0;
  for (let index = 0; index < nodeCount; index += 1) {
    const backendNodeId = captured.rawDocument.nodes.backendNodeId?.[index];
    const nodeRef = backendNodeId === undefined ? undefined : nodeRefResolver(backendNodeId);
    const rawAttributes = captured.rawDocument.nodes.attributes?.[index] ?? [];
    const attributes: { name: string; value: string }[] = [];
    for (let pairIndex = 0; pairIndex < rawAttributes.length; pairIndex += 2) {
      const nameIndex = rawAttributes[pairIndex];
      const valueIndex = rawAttributes[pairIndex + 1];
      if (nameIndex === undefined || valueIndex === undefined) {
        continue;
      }
      attributes.push({
        name: parseCdpStringTable(captured.strings, nameIndex),
        value: parseCdpStringTable(captured.strings, valueIndex),
      });
    }

    const directShadowRootType = rareCdpStringValue(
      captured.strings,
      captured.rawDocument.nodes.shadowRootType,
      index,
    );
    const normalizedShadowRootType = normalizeCdpShadowRootType(directShadowRootType);
    const shadowBoundary =
      backendNodeId === undefined
        ? undefined
        : captured.shadowBoundariesByBackendNodeId.get(backendNodeId);
    const shadowHostNodeRef =
      shadowBoundary?.shadowHostBackendNodeId === undefined
        ? undefined
        : nodeRefResolver(shadowBoundary.shadowHostBackendNodeId);
    const contentDocumentIndex = rareCdpIntegerValue(
      captured.rawDocument.nodes.contentDocumentIndex,
      index,
    );
    const contentDocumentRef =
      contentDocumentIndex === undefined ? undefined : contentDocRefResolver(contentDocumentIndex);
    const layout = layoutByNodeIndex.get(index);
    const textContent = aggregatedTextByNodeIndex.get(index);
    const computedStyle = layout?.computedStyle ?? decodeInlineComputedStyle(attributes);

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
      nodeName: parseCdpStringTable(captured.strings, captured.rawDocument.nodes.nodeName?.[index]),
      nodeValue: parseCdpStringTable(
        captured.strings,
        captured.rawDocument.nodes.nodeValue?.[index],
      ),
      ...(textContent === undefined || textContent.length === 0 ? {} : { textContent }),
      ...(computedStyle === undefined ? {} : { computedStyle }),
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
    rootSnapshotNodeId: rootNodeIndex + 1,
    shadowDomMode: "preserved",
    geometryCoordinateSpace: "document-css",
    nodes,
  };
}

function findRootNodeIndex(parentIndexes: readonly number[]): number {
  const explicitRootIndex = parentIndexes.findIndex(
    (parentIndex) => parentIndex === undefined || parentIndex < 0,
  );
  return explicitRootIndex >= 0 ? explicitRootIndex : 0;
}

function decodeLayoutByNodeIndex(
  document: CdpDomSnapshotDocument,
  strings: readonly string[],
): ReadonlyMap<number, DecodedNodeLayout> {
  const byNodeIndex = new Map<number, DecodedNodeLayout>();
  for (let layoutIndex = 0; layoutIndex < document.layout.nodeIndex.length; layoutIndex += 1) {
    const nodeIndex = document.layout.nodeIndex[layoutIndex];
    if (nodeIndex === undefined) {
      continue;
    }

    const bounds = document.layout.bounds[layoutIndex];
    const styleIndexes = document.layout.styles?.[layoutIndex];
    byNodeIndex.set(nodeIndex, {
      ...(bounds === undefined
        ? {}
        : {
            rect: createRect(bounds[0] ?? 0, bounds[1] ?? 0, bounds[2] ?? 0, bounds[3] ?? 0),
          }),
      ...(document.layout.paintOrders?.[layoutIndex] === undefined
        ? {}
        : { paintOrder: document.layout.paintOrders[layoutIndex] }),
      ...(styleIndexes === undefined
        ? {}
        : { computedStyle: decodeComputedStyle(styleIndexes, strings) }),
    });
  }
  return byNodeIndex;
}

function decodeComputedStyle(
  styleIndexes: readonly number[],
  strings: readonly string[],
): NonNullable<DecodedNodeLayout["computedStyle"]> {
  const styleEntries = DOM_SNAPSHOT_COMPUTED_STYLE_NAMES.reduce<Record<string, string>>(
    (out, propertyName, propertyIndex) => {
      const value = parseCdpStringTable(strings, styleIndexes[propertyIndex]);
      if (value.length > 0) {
        out[propertyName] = value;
      }
      return out;
    },
    {},
  );

  return {
    ...(styleEntries.display === undefined ? {} : { display: styleEntries.display }),
    ...(styleEntries.visibility === undefined ? {} : { visibility: styleEntries.visibility }),
    ...(styleEntries.opacity === undefined ? {} : { opacity: styleEntries.opacity }),
    ...(styleEntries.position === undefined ? {} : { position: styleEntries.position }),
    ...(styleEntries.cursor === undefined ? {} : { cursor: styleEntries.cursor }),
    ...(styleEntries["overflow-x"] === undefined ? {} : { overflowX: styleEntries["overflow-x"] }),
    ...(styleEntries["overflow-y"] === undefined ? {} : { overflowY: styleEntries["overflow-y"] }),
  };
}

function decodeInlineComputedStyle(
  attributes: readonly {
    readonly name: string;
    readonly value: string;
  }[],
): DecodedNodeLayout["computedStyle"] | undefined {
  const styleAttribute = attributes.find((attribute) => attribute.name === "style")?.value;
  if (styleAttribute === undefined || styleAttribute.trim().length === 0) {
    return undefined;
  }

  const styleEntries = new Map<string, string>();
  for (const declaration of styleAttribute.split(";")) {
    const separatorIndex = declaration.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const propertyName = declaration.slice(0, separatorIndex).trim().toLowerCase();
    const propertyValue = declaration.slice(separatorIndex + 1).trim();
    if (propertyName.length === 0 || propertyValue.length === 0) {
      continue;
    }

    styleEntries.set(propertyName, propertyValue);
  }

  const display = styleEntries.get("display");
  const visibility = styleEntries.get("visibility");
  const opacity = styleEntries.get("opacity");
  const position = styleEntries.get("position");
  const cursor = styleEntries.get("cursor");
  const overflow = styleEntries.get("overflow");
  const overflowX = styleEntries.get("overflow-x") ?? overflow;
  const overflowY = styleEntries.get("overflow-y") ?? overflow;

  const computedStyle: NonNullable<DecodedNodeLayout["computedStyle"]> = {
    ...(display === undefined ? {} : { display }),
    ...(visibility === undefined ? {} : { visibility }),
    ...(opacity === undefined ? {} : { opacity }),
    ...(position === undefined ? {} : { position }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(overflowX === undefined ? {} : { overflowX }),
    ...(overflowY === undefined ? {} : { overflowY }),
  };

  return Object.keys(computedStyle).length === 0 ? undefined : computedStyle;
}

function buildAggregatedTextIndex(
  document: CdpDomSnapshotDocument,
  shadowBoundariesByBackendNodeId: ReadonlyMap<number, CdpShadowBoundaryInfo>,
  strings: readonly string[],
): ReadonlyMap<number, string> {
  const parentIndexes = document.nodes.parentIndex ?? [];
  const backendNodeIds = document.nodes.backendNodeId ?? [];
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

  const layoutTextByNodeIndex = new Map<number, string>();
  for (let layoutIndex = 0; layoutIndex < document.layout.nodeIndex.length; layoutIndex += 1) {
    const nodeIndex = document.layout.nodeIndex[layoutIndex];
    if (nodeIndex === undefined) {
      continue;
    }
    const text = parseCdpStringTable(strings, document.layout.text[layoutIndex]);
    if (text.length > 0) {
      layoutTextByNodeIndex.set(nodeIndex, text);
    }
  }

  const shadowHostBackendNodeIdByNodeIndex = new Map<number, number | null>();
  const resolveShadowHostBackendNodeId = (index: number): number | null => {
    const existing = shadowHostBackendNodeIdByNodeIndex.get(index);
    if (existing !== undefined) {
      return existing;
    }

    const backendNodeId = backendNodeIds[index];
    const directShadowHostBackendNodeId =
      backendNodeId === undefined
        ? undefined
        : shadowBoundariesByBackendNodeId.get(backendNodeId)?.shadowHostBackendNodeId;
    if (directShadowHostBackendNodeId !== undefined) {
      shadowHostBackendNodeIdByNodeIndex.set(index, directShadowHostBackendNodeId);
      return directShadowHostBackendNodeId;
    }

    const parentIndex = parentIndexes[index];
    if (parentIndex === undefined || parentIndex < 0) {
      shadowHostBackendNodeIdByNodeIndex.set(index, null);
      return null;
    }

    const inheritedShadowHostBackendNodeId = resolveShadowHostBackendNodeId(parentIndex);
    shadowHostBackendNodeIdByNodeIndex.set(index, inheritedShadowHostBackendNodeId);
    return inheritedShadowHostBackendNodeId;
  };

  const memo = new Map<number, string>();
  const visit = (index: number): string => {
    const existing = memo.get(index);
    if (existing !== undefined) {
      return existing;
    }

    const nodeType = document.nodes.nodeType?.[index] ?? 0;
    const ownText = readOwnNodeText(document, strings, layoutTextByNodeIndex, index);
    if (nodeType === 3 || nodeType === 4) {
      memo.set(index, ownText);
      return ownText;
    }

    if (nodeType === 8 || nodeType === 10) {
      memo.set(index, "");
      return "";
    }

    let text = ownText;
    const currentShadowHostBackendNodeId = resolveShadowHostBackendNodeId(index);
    for (const childIndex of childIndexes.get(index) ?? []) {
      if (resolveShadowHostBackendNodeId(childIndex) !== currentShadowHostBackendNodeId) {
        continue;
      }
      text += visit(childIndex);
    }
    memo.set(index, text);
    return text;
  };

  const aggregated = new Map<number, string>();
  const nodeCount = document.nodes.nodeType?.length ?? 0;
  for (let index = 0; index < nodeCount; index += 1) {
    const text = visit(index);
    if (text.length > 0) {
      aggregated.set(index, text);
    }
  }
  return aggregated;
}

function readOwnNodeText(
  document: CdpDomSnapshotDocument,
  strings: readonly string[],
  layoutTextByNodeIndex: ReadonlyMap<number, string>,
  index: number,
): string {
  return (
    rareCdpStringValue(strings, document.nodes.textValue, index) ||
    rareCdpStringValue(strings, document.nodes.inputValue, index) ||
    (document.nodes.nodeType?.[index] === 3 || document.nodes.nodeType?.[index] === 4
      ? parseCdpStringTable(strings, document.nodes.nodeValue?.[index]) ||
        layoutTextByNodeIndex.get(index) ||
        ""
      : "")
  );
}
