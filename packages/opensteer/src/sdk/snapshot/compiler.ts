import * as cheerio from "cheerio";

import {
  createNodeLocator,
  type BrowserCoreEngine,
  type DocumentEpoch,
  type DocumentRef,
  type DomSnapshot,
  type DomSnapshotNode,
  type FrameRef,
  type NodeLocator,
  type NodeRef,
  type PageRef,
} from "@opensteer/browser-core";
import type { OpensteerSnapshotCounter, OpensteerSnapshotMode } from "@opensteer/protocol";

import type { ElementPath } from "../../runtimes/dom/index.js";
import {
  buildLocalElementPath,
  createSnapshotIndex,
  sanitizeElementPath,
} from "../../runtimes/dom/path.js";
import { findIframeHostNode, type DomSnapshotIndex } from "../../runtimes/dom/selectors.js";
import { cleanForAction, cleanForExtraction } from "./cleaner.js";
import {
  OPENSTEER_BOUNDARY_ATTR,
  OPENSTEER_HIDDEN_ATTR,
  OPENSTEER_IFRAME_BOUNDARY_TAG,
  OPENSTEER_INTERACTIVE_ATTR,
  OPENSTEER_NODE_ID_ATTR,
  OPENSTEER_SHADOW_BOUNDARY_TAG,
  OPENSTEER_UNAVAILABLE_ATTR,
  INTERACTIVE_ROLE_SET,
  NATIVE_INTERACTIVE_TAGS,
  hasNonNegativeTabIndex,
  isVoidHtmlTag,
} from "./constants.js";

export interface CompiledOpensteerSnapshotCounterRecord extends Omit<
  OpensteerSnapshotCounter,
  "nodeRef"
> {
  readonly nodeRef: NodeRef;
  readonly locator: NodeLocator;
  readonly path: ElementPath;
}

export interface CompiledOpensteerSnapshot {
  readonly url: string;
  readonly title: string;
  readonly mode: OpensteerSnapshotMode;
  readonly html: string;
  readonly counters: readonly OpensteerSnapshotCounter[];
  readonly counterRecords: ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>;
}

interface RenderDepth {
  readonly iframeDepth: number;
  readonly shadowDepth: number;
}

interface RenderedNodeMetadata {
  readonly locator: NodeLocator;
  readonly path: ElementPath;
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly nodeRef: NodeRef;
  readonly tagName: string;
  readonly pathHint: string;
  readonly text?: string;
  readonly attributes?: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly iframeDepth: number;
  readonly shadowDepth: number;
  readonly interactive: boolean;
}

interface CompiledCounterHtml {
  readonly html: string;
  readonly counterRecords: ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>;
}

export async function compileOpensteerSnapshot(options: {
  readonly engine: BrowserCoreEngine;
  readonly pageRef: PageRef;
  readonly mode: OpensteerSnapshotMode;
}): Promise<CompiledOpensteerSnapshot> {
  const pageInfo = await options.engine.getPageInfo({ pageRef: options.pageRef });
  const mainSnapshot = await getMainDocumentSnapshot(options.engine, options.pageRef);
  const snapshotsByDocumentRef = await collectDocumentSnapshots(options.engine, mainSnapshot);
  const snapshotIndices = new Map<DocumentRef, DomSnapshotIndex>();

  const renderedNodes = new Map<string, RenderedNodeMetadata>();
  const rawHtml = renderDocumentSnapshot(
    mainSnapshot.documentRef,
    snapshotsByDocumentRef,
    snapshotIndices,
    renderedNodes,
    {
      iframeDepth: 0,
      shadowDepth: 0,
    },
  );

  const compiledHtml = assignCounters(rawHtml, renderedNodes);
  const cleanedHtml =
    options.mode === "extraction"
      ? cleanForExtraction(compiledHtml.html)
      : cleanForAction(compiledHtml.html);
  const filtered = retainVisibleCounterRecords(cleanedHtml, compiledHtml.counterRecords);

  return {
    url: pageInfo.url,
    title: pageInfo.title,
    mode: options.mode,
    html: cleanedHtml,
    counters: [...filtered.values()].map(toPublicCounterRecord),
    counterRecords: filtered,
  };
}

async function getMainDocumentSnapshot(
  engine: BrowserCoreEngine,
  pageRef: PageRef,
): Promise<DomSnapshot> {
  const frames = await engine.listFrames({ pageRef });
  const mainFrame = frames.find((frame) => frame.isMainFrame);
  if (!mainFrame) {
    throw new Error(`page ${pageRef} does not expose a main frame`);
  }

  return engine.getDomSnapshot({ frameRef: mainFrame.frameRef });
}

async function collectDocumentSnapshots(
  engine: BrowserCoreEngine,
  mainSnapshot: DomSnapshot,
): Promise<ReadonlyMap<DocumentRef, DomSnapshot>> {
  const snapshotsByDocumentRef = new Map<DocumentRef, DomSnapshot>([
    [mainSnapshot.documentRef, mainSnapshot],
  ]);
  const queue: DomSnapshot[] = [mainSnapshot];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const node of current.nodes) {
      if (
        node.contentDocumentRef === undefined ||
        snapshotsByDocumentRef.has(node.contentDocumentRef)
      ) {
        continue;
      }

      const childSnapshot = await engine.getDomSnapshot({ documentRef: node.contentDocumentRef });
      snapshotsByDocumentRef.set(childSnapshot.documentRef, childSnapshot);
      queue.push(childSnapshot);
    }
  }

  return snapshotsByDocumentRef;
}

function renderDocumentSnapshot(
  documentRef: DocumentRef,
  snapshotsByDocumentRef: ReadonlyMap<DocumentRef, DomSnapshot>,
  snapshotIndices: Map<DocumentRef, DomSnapshotIndex>,
  renderedNodes: Map<string, RenderedNodeMetadata>,
  depth: RenderDepth,
): string {
  const snapshot = snapshotsByDocumentRef.get(documentRef);
  if (!snapshot) {
    return "";
  }

  const nodesById = new Map(snapshot.nodes.map((node) => [node.snapshotNodeId, node]));
  const rootNode = nodesById.get(snapshot.rootSnapshotNodeId);
  if (!rootNode) {
    throw new Error(
      `snapshot ${snapshot.documentRef} is missing root node ${String(snapshot.rootSnapshotNodeId)}`,
    );
  }

  return renderNode(
    snapshot,
    rootNode,
    nodesById,
    snapshotsByDocumentRef,
    snapshotIndices,
    renderedNodes,
    depth,
  );
}

function renderNode(
  snapshot: DomSnapshot,
  node: DomSnapshotNode,
  nodesById: ReadonlyMap<number, DomSnapshotNode>,
  snapshotsByDocumentRef: ReadonlyMap<DocumentRef, DomSnapshot>,
  snapshotIndices: Map<DocumentRef, DomSnapshotIndex>,
  renderedNodes: Map<string, RenderedNodeMetadata>,
  depth: RenderDepth,
): string {
  if (node.nodeType === 3) {
    return escapeHtml(node.nodeValue || node.textContent || "");
  }

  if (node.nodeType === 8 || node.nodeType === 10) {
    return "";
  }

  if (node.shadowRootType !== undefined) {
    const children = renderChildren(
      snapshot,
      node,
      nodesById,
      snapshotsByDocumentRef,
      snapshotIndices,
      renderedNodes,
      {
        iframeDepth: depth.iframeDepth,
        shadowDepth: depth.shadowDepth + 1,
      },
    );

    return `<${OPENSTEER_SHADOW_BOUNDARY_TAG} ${OPENSTEER_BOUNDARY_ATTR}="shadow">${children}</${OPENSTEER_SHADOW_BOUNDARY_TAG}>`;
  }

  if (node.nodeType === 9 || node.nodeType === 11) {
    return renderChildren(
      snapshot,
      node,
      nodesById,
      snapshotsByDocumentRef,
      snapshotIndices,
      renderedNodes,
      depth,
    );
  }

  if (node.nodeType !== 1) {
    return renderChildren(
      snapshot,
      node,
      nodesById,
      snapshotsByDocumentRef,
      snapshotIndices,
      renderedNodes,
      depth,
    );
  }

  const tagName = normalizeTagName(node.nodeName);
  if (isPseudoElementTagName(tagName)) {
    return renderChildren(
      snapshot,
      node,
      nodesById,
      snapshotsByDocumentRef,
      snapshotIndices,
      renderedNodes,
      depth,
    );
  }

  const originalAttributes = normalizeNodeAttributes(node.attributes);
  const attributes = [...originalAttributes];
  const hidden = isLikelyHidden(node);
  const interactive = !hidden && isLikelyInteractive(tagName, originalAttributes);

  if (interactive) {
    attributes.push({ name: OPENSTEER_INTERACTIVE_ATTR, value: "1" });
  }
  if (hidden) {
    attributes.push({ name: OPENSTEER_HIDDEN_ATTR, value: "1" });
  }
  if (tagName === "iframe" && node.contentDocumentRef === undefined) {
    attributes.push({ name: OPENSTEER_UNAVAILABLE_ATTR, value: "iframe" });
  }

  if (node.nodeRef !== undefined) {
    const syntheticNodeId = buildSyntheticNodeId(snapshot, node);
    attributes.push({ name: OPENSTEER_NODE_ID_ATTR, value: syntheticNodeId });
    renderedNodes.set(syntheticNodeId, {
      locator: createNodeLocator(snapshot.documentRef, snapshot.documentEpoch, node.nodeRef),
      path: buildSnapshotElementPath(snapshot, node, snapshotsByDocumentRef, snapshotIndices),
      pageRef: snapshot.pageRef,
      frameRef: snapshot.frameRef,
      documentRef: snapshot.documentRef,
      documentEpoch: snapshot.documentEpoch,
      nodeRef: node.nodeRef,
      tagName: tagName.toUpperCase(),
      pathHint: buildPathHint(tagName, originalAttributes),
      ...(buildTextSnippet(node.textContent) === undefined
        ? {}
        : { text: buildTextSnippet(node.textContent)! }),
      ...(originalAttributes.length === 0 ? {} : { attributes: originalAttributes }),
      iframeDepth: depth.iframeDepth,
      shadowDepth: depth.shadowDepth,
      interactive,
    });
  }

  const attributeText = attributesToHtml(attributes);
  const children = renderChildren(
    snapshot,
    node,
    nodesById,
    snapshotsByDocumentRef,
    snapshotIndices,
    renderedNodes,
    depth,
  );

  const elementHtml = isVoidHtmlTag(tagName)
    ? `<${tagName}${attributeText}>`
    : `<${tagName}${attributeText}>${children}</${tagName}>`;
  if (node.contentDocumentRef === undefined) {
    return elementHtml;
  }

  const iframeHtml = renderDocumentSnapshot(
    node.contentDocumentRef,
    snapshotsByDocumentRef,
    snapshotIndices,
    renderedNodes,
    {
      iframeDepth: depth.iframeDepth + 1,
      shadowDepth: depth.shadowDepth,
    },
  );
  if (iframeHtml.length === 0) {
    return elementHtml;
  }

  return `${elementHtml}<${OPENSTEER_IFRAME_BOUNDARY_TAG} ${OPENSTEER_BOUNDARY_ATTR}="iframe">${iframeHtml}</${OPENSTEER_IFRAME_BOUNDARY_TAG}>`;
}

function renderChildren(
  snapshot: DomSnapshot,
  node: DomSnapshotNode,
  nodesById: ReadonlyMap<number, DomSnapshotNode>,
  snapshotsByDocumentRef: ReadonlyMap<DocumentRef, DomSnapshot>,
  snapshotIndices: Map<DocumentRef, DomSnapshotIndex>,
  renderedNodes: Map<string, RenderedNodeMetadata>,
  depth: RenderDepth,
): string {
  const chunks: string[] = [];
  for (const childSnapshotNodeId of node.childSnapshotNodeIds) {
    const child = nodesById.get(childSnapshotNodeId);
    if (!child) {
      continue;
    }

    chunks.push(
      renderNode(
        snapshot,
        child,
        nodesById,
        snapshotsByDocumentRef,
        snapshotIndices,
        renderedNodes,
        depth,
      ),
    );
  }
  return chunks.join("");
}

function assignCounters(
  rawHtml: string,
  renderedNodes: ReadonlyMap<string, RenderedNodeMetadata>,
): CompiledCounterHtml {
  const $ = cheerio.load(rawHtml, { xmlMode: false });
  const counterRecords = new Map<number, CompiledOpensteerSnapshotCounterRecord>();
  let nextCounter = 1;

  $("*").each(function assignElementCounter() {
    const el = $(this);
    const syntheticNodeId = el.attr(OPENSTEER_NODE_ID_ATTR);
    if (!syntheticNodeId) {
      return;
    }

    const rendered = renderedNodes.get(syntheticNodeId);
    el.removeAttr(OPENSTEER_NODE_ID_ATTR);
    if (!rendered) {
      return;
    }

    const counter = nextCounter++;
    el.attr("c", String(counter));
    counterRecords.set(counter, {
      element: counter,
      pageRef: rendered.pageRef,
      frameRef: rendered.frameRef,
      documentRef: rendered.documentRef,
      documentEpoch: rendered.documentEpoch,
      nodeRef: rendered.nodeRef,
      tagName: rendered.tagName,
      pathHint: rendered.pathHint,
      ...(rendered.text === undefined ? {} : { text: rendered.text }),
      ...(rendered.attributes === undefined ? {} : { attributes: rendered.attributes }),
      iframeDepth: rendered.iframeDepth,
      shadowDepth: rendered.shadowDepth,
      interactive: rendered.interactive,
      locator: rendered.locator,
      path: rendered.path,
    });
  });

  return {
    html: $.html(),
    counterRecords,
  };
}

function retainVisibleCounterRecords(
  cleanedHtml: string,
  counterRecords: ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>,
): ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord> {
  const $ = cheerio.load(cleanedHtml, { xmlMode: false });
  const orderedRecords = new Map<number, CompiledOpensteerSnapshotCounterRecord>();

  $("[c]").each(function collectVisibleCounter() {
    const rawCounter = $(this).attr("c");
    const counter = Number.parseInt(String(rawCounter || ""), 10);
    if (!Number.isFinite(counter)) {
      return;
    }

    const record = counterRecords.get(counter);
    if (!record) {
      return;
    }

    orderedRecords.set(counter, record);
  });

  return orderedRecords;
}

function toPublicCounterRecord(
  record: CompiledOpensteerSnapshotCounterRecord,
): OpensteerSnapshotCounter {
  return {
    element: record.element,
    pageRef: record.pageRef,
    frameRef: record.frameRef,
    documentRef: record.documentRef,
    documentEpoch: record.documentEpoch,
    nodeRef: record.nodeRef,
    tagName: record.tagName,
    pathHint: record.pathHint,
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.attributes === undefined ? {} : { attributes: record.attributes }),
    iframeDepth: record.iframeDepth,
    shadowDepth: record.shadowDepth,
    interactive: record.interactive,
  };
}

function normalizeTagName(value: string): string {
  const tagName = String(value || "")
    .trim()
    .toLowerCase();
  return tagName.length === 0 ? "div" : tagName;
}

function isPseudoElementTagName(tagName: string): boolean {
  return tagName.startsWith("::");
}

function normalizeNodeAttributes(
  attributes: readonly { readonly name: string; readonly value: string }[],
): Array<{ name: string; value: string }> {
  return attributes
    .map((attribute) => ({
      name: String(attribute.name || "").trim(),
      value: String(attribute.value || ""),
    }))
    .filter((attribute) => attribute.name.length > 0);
}

function isLikelyHidden(node: DomSnapshotNode): boolean {
  const hiddenAttr = findAttributeValue(node.attributes, "hidden");
  if (hiddenAttr !== undefined) {
    return true;
  }

  if (findAttributeValue(node.attributes, "aria-hidden") === "true") {
    return true;
  }

  if (
    normalizeTagName(node.nodeName) === "input" &&
    findAttributeValue(node.attributes, "type")?.toLowerCase() === "hidden"
  ) {
    return true;
  }

  const rect = node.layout?.rect;
  if (rect === undefined) {
    return false;
  }

  return rect.width <= 0 || rect.height <= 0;
}

function isLikelyInteractive(
  tagName: string,
  attributes: readonly { readonly name: string; readonly value: string }[],
): boolean {
  if (NATIVE_INTERACTIVE_TAGS.has(tagName)) {
    if (tagName === "input" && findAttributeValue(attributes, "type")?.toLowerCase() === "hidden") {
      return false;
    }

    if (tagName !== "a") {
      return true;
    }
  }

  if (tagName === "a" && findAttributeValue(attributes, "href") !== undefined) {
    return true;
  }

  if (
    findAttributeValue(attributes, "onclick") !== undefined ||
    findAttributeValue(attributes, "onmousedown") !== undefined ||
    findAttributeValue(attributes, "onmouseup") !== undefined ||
    findAttributeValue(attributes, "data-action") !== undefined ||
    findAttributeValue(attributes, "data-click") !== undefined ||
    findAttributeValue(attributes, "data-toggle") !== undefined
  ) {
    return true;
  }

  if (hasNonNegativeTabIndex(findAttributeValue(attributes, "tabindex"))) {
    return true;
  }

  const role = findAttributeValue(attributes, "role")?.toLowerCase();
  return role !== undefined && INTERACTIVE_ROLE_SET.has(role);
}

function buildSyntheticNodeId(snapshot: DomSnapshot, node: DomSnapshotNode): string {
  return `${snapshot.documentRef}:${String(snapshot.documentEpoch)}:${String(node.snapshotNodeId)}`;
}

function buildPathHint(
  tagName: string,
  attributes: readonly { readonly name: string; readonly value: string }[],
): string {
  const id = findAttributeValue(attributes, "id");
  if (id) {
    return `${tagName}#${sanitizeHintToken(id)}`;
  }

  const testId = findAttributeValue(attributes, "data-testid");
  if (testId) {
    return `${tagName}[data-testid="${sanitizeHintToken(testId)}"]`;
  }

  const name = findAttributeValue(attributes, "name");
  if (name) {
    return `${tagName}[name="${sanitizeHintToken(name)}"]`;
  }

  const role = findAttributeValue(attributes, "role");
  if (role) {
    return `${tagName}[role="${sanitizeHintToken(role)}"]`;
  }

  const className = findAttributeValue(attributes, "class");
  if (className) {
    const firstClass = className.split(/\s+/).find((token) => token.trim().length > 0);
    if (firstClass) {
      return `${tagName}.${sanitizeHintToken(firstClass)}`;
    }
  }

  return tagName;
}

function sanitizeHintToken(value: string): string {
  return value.replace(/"/g, '\\"').trim();
}

function buildTextSnippet(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

function findAttributeValue(
  attributes: readonly { readonly name: string; readonly value: string }[],
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  return attributes.find((attribute) => attribute.name.toLowerCase() === normalizedName)?.value;
}

function attributesToHtml(
  attributes: readonly { readonly name: string; readonly value: string }[],
): string {
  if (attributes.length === 0) {
    return "";
  }

  return attributes
    .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
    .join("");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSnapshotElementPath(
  snapshot: DomSnapshot,
  node: DomSnapshotNode,
  snapshotsByDocumentRef: ReadonlyMap<DocumentRef, DomSnapshot>,
  snapshotIndices: Map<DocumentRef, DomSnapshotIndex>,
): ElementPath {
  const index = getSnapshotIndex(snapshot.documentRef, snapshotsByDocumentRef, snapshotIndices);
  const localPath = buildLocalElementPath(index, node);
  return prefixIframeContext(snapshot, localPath, snapshotsByDocumentRef, snapshotIndices);
}

function prefixIframeContext(
  snapshot: DomSnapshot,
  localPath: ElementPath,
  snapshotsByDocumentRef: ReadonlyMap<DocumentRef, DomSnapshot>,
  snapshotIndices: Map<DocumentRef, DomSnapshotIndex>,
): ElementPath {
  if (snapshot.parentDocumentRef === undefined) {
    return sanitizeElementPath(localPath);
  }

  const parentSnapshot = snapshotsByDocumentRef.get(snapshot.parentDocumentRef);
  if (!parentSnapshot) {
    throw new Error(
      `document ${snapshot.documentRef} has parent ${snapshot.parentDocumentRef} but no parent snapshot`,
    );
  }

  const parentIndex = getSnapshotIndex(
    parentSnapshot.documentRef,
    snapshotsByDocumentRef,
    snapshotIndices,
  );
  const iframeHost = findIframeHostNode(parentIndex, snapshot.documentRef);
  if (!iframeHost) {
    throw new Error(
      `document ${snapshot.documentRef} has parent ${snapshot.parentDocumentRef} but no iframe host`,
    );
  }

  const hostPath = buildSnapshotElementPath(
    parentSnapshot,
    iframeHost,
    snapshotsByDocumentRef,
    snapshotIndices,
  );
  return sanitizeElementPath({
    context: [...hostPath.context, { kind: "iframe", host: hostPath.nodes }, ...localPath.context],
    nodes: localPath.nodes,
  });
}

function getSnapshotIndex(
  documentRef: DocumentRef,
  snapshotsByDocumentRef: ReadonlyMap<DocumentRef, DomSnapshot>,
  snapshotIndices: Map<DocumentRef, DomSnapshotIndex>,
): DomSnapshotIndex {
  const existing = snapshotIndices.get(documentRef);
  if (existing) {
    return existing;
  }

  const snapshot = snapshotsByDocumentRef.get(documentRef);
  if (!snapshot) {
    throw new Error(`missing DOM snapshot for ${documentRef}`);
  }

  const index = createSnapshotIndex(snapshot);
  snapshotIndices.set(documentRef, index);
  return index;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
