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

import type { StructuralElementAnchor } from "../../runtimes/dom/index.js";
import {
  buildLocalStructuralElementAnchor,
  createSnapshotIndex,
  sanitizeStructuralElementAnchor,
} from "../../runtimes/dom/path.js";
import { findIframeHostNode, type DomSnapshotIndex } from "../../runtimes/dom/selectors.js";
import { cleanForAction, cleanForExtraction } from "./cleaner.js";
import {
  OPENSTEER_BOUNDARY_ATTR,
  OPENSTEER_HIDDEN_ATTR,
  OPENSTEER_IFRAME_BOUNDARY_TAG,
  OPENSTEER_INTERACTIVE_ATTR,
  OPENSTEER_NODE_ID_ATTR,
  OPENSTEER_SCROLLABLE_ATTR,
  OPENSTEER_SELF_HIDDEN_ATTR,
  OPENSTEER_SHADOW_BOUNDARY_TAG,
  OPENSTEER_SPARSE_COUNTER_ATTR,
  OPENSTEER_UNAVAILABLE_ATTR,
  INTERACTIVE_ROLE_SET,
  NATIVE_INTERACTIVE_TAGS,
  hasNonNegativeTabIndex,
  isVoidHtmlTag,
} from "./constants.js";
import { markLiveSnapshotSemantics } from "./marking.js";

interface CompiledOpensteerSnapshotCounterRecord extends Omit<OpensteerSnapshotCounter, "nodeRef"> {
  readonly nodeRef: NodeRef;
  readonly locator: NodeLocator;
  readonly anchor: StructuralElementAnchor;
  readonly sparseCounter?: number;
  readonly liveCounterSyncEligible: boolean;
}

export interface CompiledOpensteerSnapshot {
  readonly url: string;
  readonly title: string;
  readonly mode: OpensteerSnapshotMode;
  readonly html: string;
  readonly counters: readonly OpensteerSnapshotCounter[];
}

interface RenderDepth {
  readonly iframeDepth: number;
  readonly shadowDepth: number;
}

interface RenderedNodeMetadata {
  readonly locator: NodeLocator;
  readonly anchor: StructuralElementAnchor;
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
  readonly liveCounterSyncEligible: boolean;
}

interface CompiledCounterHtml {
  readonly html: string;
  readonly counterRecords: ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>;
  readonly sparseToDirectMapping: ReadonlyMap<number, number>;
}

const INTERNAL_SNAPSHOT_ATTRIBUTE_NAMES = new Set([
  "c",
  OPENSTEER_BOUNDARY_ATTR,
  OPENSTEER_HIDDEN_ATTR,
  OPENSTEER_INTERACTIVE_ATTR,
  OPENSTEER_NODE_ID_ATTR,
  OPENSTEER_SCROLLABLE_ATTR,
  OPENSTEER_SELF_HIDDEN_ATTR,
  OPENSTEER_SPARSE_COUNTER_ATTR,
  OPENSTEER_UNAVAILABLE_ATTR,
]);

const MAX_LIVE_COUNTER_SYNC_ATTEMPTS = 4;

const CLEAR_LIVE_COUNTERS_SCRIPT = `(({ sparseCounterAttr }) => {
  const walk = (root) => {
    for (const child of root.children) {
      child.removeAttribute("c");
      child.removeAttribute(sparseCounterAttr);
      walk(child);
      if (child.shadowRoot) {
        walk(child.shadowRoot);
      }
    }
  };

  walk(document);
  return true;
})`;

const ASSIGN_SPARSE_COUNTERS_SCRIPT = `(({ sparseCounterAttr, startCounter }) => {
  let counter = startCounter;
  const walk = (root) => {
    for (const child of root.children) {
      child.setAttribute(sparseCounterAttr, String(counter++));
      walk(child);
      if (child.shadowRoot) {
        walk(child.shadowRoot);
      }
    }
  };

  walk(document);
  return counter;
})`;

const APPLY_DENSE_COUNTERS_SCRIPT = `(({ sparseCounterAttr, mapping }) => {
  const walk = (root) => {
    for (const child of root.children) {
      child.removeAttribute("c");
      const sparse = child.getAttribute(sparseCounterAttr);
      if (sparse !== null) {
        const dense = mapping[sparse];
        if (dense !== undefined) {
          child.setAttribute("c", String(dense));
        }
        child.removeAttribute(sparseCounterAttr);
      }
      walk(child);
      if (child.shadowRoot) {
        walk(child.shadowRoot);
      }
    }
  };

  walk(document);
  return true;
})`;

class LiveCounterSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCounterSyncError";
  }
}

function isLiveCounterSyncError(error: unknown): error is LiveCounterSyncError {
  return error instanceof LiveCounterSyncError;
}

function isDetachedFrameSyncError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("not attached to a live page") ||
    message.includes("frame has been detached") ||
    message.includes("frame was detached") ||
    message.includes("frame not found")
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function buildLiveCounterSyncError(
  action: string,
  failures: readonly string[],
): LiveCounterSyncError {
  const preview = failures.slice(0, 3).join(" ");
  const remaining = failures.length > 3 ? ` (+${String(failures.length - 3)} more)` : "";
  return new LiveCounterSyncError(
    `Failed to ${action} across frame snapshots: ${preview}${remaining}`,
  );
}

function ensureSparseCountersForAllRecords(
  counterRecords: ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>,
): void {
  const missingSparseCounters = [...counterRecords.values()].filter(
    (record) => record.liveCounterSyncEligible && record.sparseCounter === undefined,
  );
  if (missingSparseCounters.length === 0) {
    return;
  }

  throw buildLiveCounterSyncError(
    "bind dense counters to every snapshot record",
    missingSparseCounters.map(
      (record) =>
        `counter ${String(record.element)} (${record.pathHint}) was captured without a sparse live-DOM marker.`,
    ),
  );
}

async function clearLiveCounters(engine: BrowserCoreEngine, pageRef: PageRef): Promise<void> {
  const frames = await engine.listFrames({ pageRef });
  const failures: string[] = [];

  for (const frame of frames) {
    try {
      await engine.evaluateFrame({
        frameRef: frame.frameRef,
        script: CLEAR_LIVE_COUNTERS_SCRIPT,
        args: [{ sparseCounterAttr: OPENSTEER_SPARSE_COUNTER_ATTR }],
      });
    } catch (error) {
      if (isDetachedFrameSyncError(error)) {
        continue;
      }
      failures.push(`frame ${frame.frameRef} could not be cleared (${describeError(error)}).`);
    }
  }

  if (failures.length > 0) {
    throw buildLiveCounterSyncError("clear live counters", failures);
  }
}

async function assignSparseCountersToLiveDom(
  engine: BrowserCoreEngine,
  pageRef: PageRef,
): Promise<void> {
  const frames = await engine.listFrames({ pageRef });
  const failures: string[] = [];
  let nextCounter = 1;

  for (const frame of frames) {
    try {
      const evaluated = await engine.evaluateFrame({
        frameRef: frame.frameRef,
        script: ASSIGN_SPARSE_COUNTERS_SCRIPT,
        args: [
          {
            sparseCounterAttr: OPENSTEER_SPARSE_COUNTER_ATTR,
            startCounter: nextCounter,
          },
        ],
      });
      const returnedCounter = Number(evaluated.data);
      if (!Number.isSafeInteger(returnedCounter) || returnedCounter < nextCounter) {
        failures.push(`frame ${frame.frameRef} returned an invalid sparse counter boundary.`);
        continue;
      }
      nextCounter = returnedCounter;
    } catch (error) {
      if (isDetachedFrameSyncError(error)) {
        continue;
      }
      failures.push(
        `frame ${frame.frameRef} could not be assigned sparse counters (${describeError(error)}).`,
      );
    }
  }

  if (failures.length > 0) {
    throw buildLiveCounterSyncError("assign sparse counters", failures);
  }
}

async function syncDenseCountersToLiveDom(
  engine: BrowserCoreEngine,
  pageRef: PageRef,
  sparseToDirectMapping: ReadonlyMap<number, number>,
): Promise<void> {
  const frames = await engine.listFrames({ pageRef });
  const failures: string[] = [];
  const mappingObj = Object.fromEntries(
    [...sparseToDirectMapping.entries()].map(([sparseCounter, denseCounter]) => [
      String(sparseCounter),
      denseCounter,
    ]),
  );

  for (const frame of frames) {
    try {
      await engine.evaluateFrame({
        frameRef: frame.frameRef,
        script: APPLY_DENSE_COUNTERS_SCRIPT,
        args: [
          {
            sparseCounterAttr: OPENSTEER_SPARSE_COUNTER_ATTR,
            mapping: mappingObj,
          },
        ],
      });
    } catch (error) {
      if (isDetachedFrameSyncError(error)) {
        continue;
      }
      failures.push(`frame ${frame.frameRef} could not be synchronized (${describeError(error)}).`);
    }
  }

  if (failures.length > 0) {
    throw buildLiveCounterSyncError("synchronize dense counters", failures);
  }
}

export async function compileOpensteerSnapshot(options: {
  readonly engine: BrowserCoreEngine;
  readonly pageRef: PageRef;
  readonly mode: OpensteerSnapshotMode;
}): Promise<CompiledOpensteerSnapshot> {
  let lastCounterSyncError: LiveCounterSyncError | undefined;

  for (let attempt = 1; attempt <= MAX_LIVE_COUNTER_SYNC_ATTEMPTS; attempt += 1) {
    let cleanupLiveSemantics: () => Promise<void> = async () => {};

    try {
      cleanupLiveSemantics = await markLiveSnapshotSemantics({
        engine: options.engine,
        pageRef: options.pageRef,
      });

      await clearLiveCounters(options.engine, options.pageRef);
      await assignSparseCountersToLiveDom(options.engine, options.pageRef);

      const pageInfo = await options.engine.getPageInfo({ pageRef: options.pageRef });
      const mainSnapshot = await getMainDocumentSnapshot(options.engine, options.pageRef);
      const snapshotsByDocumentRef = await collectDocumentSnapshots(options.engine, mainSnapshot);

      await cleanupLiveSemantics();
      cleanupLiveSemantics = async () => {};

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

      const cleanedHtml =
        options.mode === "extraction" ? cleanForExtraction(rawHtml) : cleanForAction(rawHtml);
      const compiledHtml = assignCounters(cleanedHtml, renderedNodes);
      const finalHtml =
        options.mode === "extraction" ? unwrapExtractionHtml(compiledHtml.html) : compiledHtml.html;

      ensureSparseCountersForAllRecords(compiledHtml.counterRecords);
      await syncDenseCountersToLiveDom(
        options.engine,
        options.pageRef,
        compiledHtml.sparseToDirectMapping,
      );

      return {
        url: pageInfo.url,
        title: pageInfo.title,
        mode: options.mode,
        html: finalHtml,
        counters: [...compiledHtml.counterRecords.values()].map(toPublicCounterRecord),
      };
    } catch (error) {
      await clearLiveCounters(options.engine, options.pageRef).catch(() => undefined);
      if (attempt < MAX_LIVE_COUNTER_SYNC_ATTEMPTS && isLiveCounterSyncError(error)) {
        lastCounterSyncError = error;
        continue;
      }
      throw error;
    } finally {
      await cleanupLiveSemantics();
    }
  }

  throw (
    lastCounterSyncError ??
    new LiveCounterSyncError("Failed to prepare snapshot after retrying counter sync.")
  );
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

  // Flatten structural root tags (html, head, body) inside iframe/shadow boundaries.
  // HTML5 parsers merge duplicate <html> attributes into the first <html> element,
  // which can cause attributes like data-opensteer-hidden from an iframe's <html>
  // to pollute the main document's <html> element.
  if (
    (depth.iframeDepth > 0 || depth.shadowDepth > 0) &&
    (tagName === "html" || tagName === "head" || tagName === "body")
  ) {
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

  const snapshotAttributes = normalizeNodeAttributes(node.attributes);
  const authoredAttributes = stripInternalSnapshotAttributes(snapshotAttributes);
  const attributes = [...authoredAttributes];
  const subtreeHidden =
    hasAttribute(snapshotAttributes, OPENSTEER_HIDDEN_ATTR) || isLikelySubtreeHidden(node);
  const selfHidden =
    !subtreeHidden &&
    (hasAttribute(snapshotAttributes, OPENSTEER_SELF_HIDDEN_ATTR) ||
      isLikelySelfHidden(node, nodesById));
  const interactive =
    !subtreeHidden &&
    !selfHidden &&
    (hasAttribute(snapshotAttributes, OPENSTEER_INTERACTIVE_ATTR) ||
      isLikelyInteractive(tagName, node, authoredAttributes));

  if (interactive) {
    attributes.push({ name: OPENSTEER_INTERACTIVE_ATTR, value: "1" });
  }
  if (subtreeHidden) {
    attributes.push({ name: OPENSTEER_HIDDEN_ATTR, value: "1" });
  } else if (selfHidden) {
    attributes.push({ name: OPENSTEER_SELF_HIDDEN_ATTR, value: "1" });
  }
  const sparseCounter = findAttributeValue(snapshotAttributes, OPENSTEER_SPARSE_COUNTER_ATTR);
  if (sparseCounter !== undefined) {
    attributes.push({ name: OPENSTEER_SPARSE_COUNTER_ATTR, value: sparseCounter });
  }
  if (tagName === "iframe" && node.contentDocumentRef === undefined) {
    attributes.push({ name: OPENSTEER_UNAVAILABLE_ATTR, value: "iframe" });
  }

  if (node.nodeRef !== undefined) {
    const syntheticNodeId = buildSyntheticNodeId(snapshot, node);
    attributes.push({ name: OPENSTEER_NODE_ID_ATTR, value: syntheticNodeId });
    renderedNodes.set(syntheticNodeId, {
      locator: createNodeLocator(snapshot.documentRef, snapshot.documentEpoch, node.nodeRef),
      anchor: buildSnapshotElementAnchor(snapshot, node, snapshotsByDocumentRef, snapshotIndices),
      pageRef: snapshot.pageRef,
      frameRef: snapshot.frameRef,
      documentRef: snapshot.documentRef,
      documentEpoch: snapshot.documentEpoch,
      nodeRef: node.nodeRef,
      tagName: tagName.toUpperCase(),
      pathHint: buildPathHint(tagName, authoredAttributes),
      ...(buildTextSnippet(node.textContent) === undefined
        ? {}
        : { text: buildTextSnippet(node.textContent)! }),
      ...(authoredAttributes.length === 0 ? {} : { attributes: authoredAttributes }),
      iframeDepth: depth.iframeDepth,
      shadowDepth: depth.shadowDepth,
      interactive,
      liveCounterSyncEligible: isLiveCounterSyncEligible(node, nodesById),
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
  const regularChildren: DomSnapshotNode[] = [];
  const shadowChildren: DomSnapshotNode[] = [];

  for (const childSnapshotNodeId of node.childSnapshotNodeIds) {
    const child = nodesById.get(childSnapshotNodeId);
    if (!child) {
      continue;
    }

    if (node.nodeRef !== undefined && child.shadowHostNodeRef === node.nodeRef) {
      shadowChildren.push(child);
      continue;
    }

    regularChildren.push(child);
  }

  const chunks: string[] = [];
  if (shadowChildren.length > 0) {
    const shadowHtml = shadowChildren
      .map((child) =>
        renderNode(
          snapshot,
          child,
          nodesById,
          snapshotsByDocumentRef,
          snapshotIndices,
          renderedNodes,
          {
            iframeDepth: depth.iframeDepth,
            shadowDepth: depth.shadowDepth + 1,
          },
        ),
      )
      .join("");
    chunks.push(
      `<${OPENSTEER_SHADOW_BOUNDARY_TAG} ${OPENSTEER_BOUNDARY_ATTR}="shadow">${shadowHtml}</${OPENSTEER_SHADOW_BOUNDARY_TAG}>`,
    );
  }

  for (const child of regularChildren) {
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
  cleanedHtml: string,
  renderedNodes: ReadonlyMap<string, RenderedNodeMetadata>,
): CompiledCounterHtml {
  const $ = cheerio.load(cleanedHtml, { xmlMode: false });
  const counterRecords = new Map<number, CompiledOpensteerSnapshotCounterRecord>();
  const sparseToDirectMapping = new Map<number, number>();
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

    const rawSparseCounter = el.attr(OPENSTEER_SPARSE_COUNTER_ATTR);
    el.removeAttr(OPENSTEER_SPARSE_COUNTER_ATTR);
    const sparseCounter = rawSparseCounter ? Number.parseInt(rawSparseCounter, 10) : undefined;

    const counter = nextCounter++;
    el.attr("c", String(counter));
    if (sparseCounter !== undefined && Number.isFinite(sparseCounter)) {
      sparseToDirectMapping.set(sparseCounter, counter);
    }
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
      liveCounterSyncEligible: rendered.liveCounterSyncEligible,
      locator: rendered.locator,
      anchor: rendered.anchor,
      ...(sparseCounter !== undefined && Number.isFinite(sparseCounter) ? { sparseCounter } : {}),
    });
  });

  return {
    html: $.html(),
    counterRecords,
    sparseToDirectMapping,
  };
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

function stripInternalSnapshotAttributes(
  attributes: readonly { readonly name: string; readonly value: string }[],
): Array<{ name: string; value: string }> {
  return attributes.filter(
    (attribute) => !INTERNAL_SNAPSHOT_ATTRIBUTE_NAMES.has(attribute.name.toLowerCase()),
  );
}

function isLikelySubtreeHidden(node: DomSnapshotNode): boolean {
  const hiddenAttr = findAttributeValue(node.attributes, "hidden");
  if (hiddenAttr !== undefined) {
    return true;
  }

  if (
    normalizeTagName(node.nodeName) === "input" &&
    findAttributeValue(node.attributes, "type")?.toLowerCase() === "hidden"
  ) {
    return true;
  }

  const computedStyle = node.computedStyle;
  if (computedStyle?.display === "none") {
    return true;
  }
  if (parseOpacity(computedStyle?.opacity) <= 0) {
    return true;
  }
  return false;
}

function isLikelySelfHidden(
  node: DomSnapshotNode,
  nodesById: ReadonlyMap<number, DomSnapshotNode>,
): boolean {
  const computedStyle = node.computedStyle;
  if (computedStyle?.visibility === "hidden" || computedStyle?.visibility === "collapse") {
    return true;
  }
  if (computedStyle?.display === "contents") {
    return false;
  }

  const rect = node.layout?.rect;
  if (rect === undefined) {
    return false;
  }

  if (rect.width > 0 && rect.height > 0) {
    return false;
  }

  return !hasVisibleOutOfFlowChild(node, nodesById);
}

function isLikelyInteractive(
  tagName: string,
  node: DomSnapshotNode,
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

  if (findAttributeValue(attributes, "contenteditable")?.toLowerCase() === "true") {
    return true;
  }

  const role = findAttributeValue(attributes, "role")?.toLowerCase();
  return role !== undefined && INTERACTIVE_ROLE_SET.has(role);
}

function hasVisibleOutOfFlowChild(
  node: DomSnapshotNode,
  nodesById: ReadonlyMap<number, DomSnapshotNode>,
): boolean {
  for (const childSnapshotNodeId of node.childSnapshotNodeIds) {
    const child = nodesById.get(childSnapshotNodeId);
    if (!child || child.nodeType !== 1) {
      continue;
    }

    if (isVisibleOutOfFlowNode(child)) {
      return true;
    }
  }

  return false;
}

function isLiveCounterSyncEligible(
  node: DomSnapshotNode,
  nodesById: ReadonlyMap<number, DomSnapshotNode>,
): boolean {
  let current: DomSnapshotNode | undefined = node;
  while (current) {
    if (current.shadowRootType !== undefined && current.shadowRootType !== "open") {
      return false;
    }

    const parentSnapshotNodeId = current.parentSnapshotNodeId;
    if (parentSnapshotNodeId === undefined) {
      return true;
    }

    const parent = nodesById.get(parentSnapshotNodeId);
    if (!parent) {
      return true;
    }
    if (parent.shadowRootType !== undefined && parent.shadowRootType !== "open") {
      return false;
    }

    current = parent;
  }

  return true;
}

function isVisibleOutOfFlowNode(node: DomSnapshotNode): boolean {
  const position = node.computedStyle?.position;
  if (position !== "absolute" && position !== "fixed") {
    return false;
  }
  if (isExplicitlyHiddenByComputedStyle(node)) {
    return false;
  }

  const rect = node.layout?.rect;
  return rect !== undefined && rect.width > 0 && rect.height > 0;
}

function isExplicitlyHiddenByComputedStyle(node: DomSnapshotNode): boolean {
  if (node.computedStyle?.display === "none") {
    return true;
  }
  if (
    node.computedStyle?.visibility === "hidden" ||
    node.computedStyle?.visibility === "collapse"
  ) {
    return true;
  }
  return parseOpacity(node.computedStyle?.opacity) <= 0;
}

function parseOpacity(value: string | undefined): number {
  if (value === undefined) {
    return Number.NaN;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function hasAttribute(
  attributes: readonly { readonly name: string; readonly value: string }[],
  name: string,
): boolean {
  const normalizedName = name.toLowerCase();
  return attributes.some((attribute) => attribute.name.toLowerCase() === normalizedName);
}

function unwrapExtractionHtml(html: string): string {
  const $ = cheerio.load(html, { xmlMode: false });
  return $("body").html()?.trim() || html;
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

function buildSnapshotElementAnchor(
  snapshot: DomSnapshot,
  node: DomSnapshotNode,
  snapshotsByDocumentRef: ReadonlyMap<DocumentRef, DomSnapshot>,
  snapshotIndices: Map<DocumentRef, DomSnapshotIndex>,
): StructuralElementAnchor {
  const index = getSnapshotIndex(snapshot.documentRef, snapshotsByDocumentRef, snapshotIndices);
  const localAnchor = buildLocalStructuralElementAnchor(index, node);
  return prefixIframeContext(snapshot, localAnchor, snapshotsByDocumentRef, snapshotIndices);
}

function prefixIframeContext(
  snapshot: DomSnapshot,
  localPath: StructuralElementAnchor,
  snapshotsByDocumentRef: ReadonlyMap<DocumentRef, DomSnapshot>,
  snapshotIndices: Map<DocumentRef, DomSnapshotIndex>,
): StructuralElementAnchor {
  if (snapshot.parentDocumentRef === undefined) {
    return sanitizeStructuralElementAnchor(localPath);
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

  const hostPath = buildSnapshotElementAnchor(
    parentSnapshot,
    iframeHost,
    snapshotsByDocumentRef,
    snapshotIndices,
  );
  return sanitizeStructuralElementAnchor({
    resolution: "structural",
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
