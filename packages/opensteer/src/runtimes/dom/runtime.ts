import {
  createNodeLocator,
  createPoint,
  rectContainsPoint,
  type BrowserCoreEngine,
  type DocumentRef,
  type DomSnapshot,
  type DomSnapshotNode,
  type FrameRef,
  type NodeRef,
  type PageRef,
  type Point,
} from "@opensteer/browser-core";

import type { FilesystemOpensteerRoot } from "../../root.js";
import { createDomDescriptorStore } from "./descriptors.js";
import { normalizeExtractedValue, resolveExtractedValueInContext } from "./extraction.js";
import { ElementPathError } from "./errors.js";
import {
  buildArrayFieldCandidates,
  buildLocalElementPath,
  buildPathSelectorHint,
  createExplicitSelectorScope,
  createPathScope,
  createSnapshotIndex,
  queryAllDomPathInScope,
  resolveDomPathInScope,
  resolveFirstWithinNodeBySelectors,
  sanitizeElementPath,
  throwContextHostNotUnique,
  throwTargetNotFound,
  throwTargetNotUnique,
} from "./path.js";
import {
  findIframeHostNode,
  findNodeByNodeRef,
  hasOpenShadowRoot,
  isSameNodeOrDescendant,
  normalizeToElementNode,
  querySelectorAllInScope,
  type DomQueryScope,
  type DomSnapshotIndex,
} from "./selectors.js";
import type {
  DomActionOutcome,
  DomArrayFieldSelector,
  DomBuildPathInput,
  DomClickInput,
  DomDescriptorRecord,
  DomExtractArrayRowsInput,
  DomExtractFieldSelector,
  DomHoverInput,
  DomInputInput,
  DomReadDescriptorInput,
  DomResolveTargetInput,
  DomRuntime,
  DomScrollInput,
  DomTargetRef,
  DomWriteDescriptorInput,
  ElementPath,
  ResolvedDomTarget,
} from "./types.js";

interface SnapshotTarget {
  readonly snapshot: DomSnapshot;
  readonly node: DomSnapshotNode;
}

class SnapshotSession {
  private readonly snapshotsByDocumentRef = new Map<string, Promise<DomSnapshot>>();
  private readonly snapshotsByFrameRef = new Map<string, Promise<DomSnapshot>>();
  private readonly mainSnapshotsByPageRef = new Map<string, Promise<DomSnapshot>>();

  constructor(private readonly engine: BrowserCoreEngine) {}

  getDocument(documentRef: DocumentRef): Promise<DomSnapshot> {
    const existing = this.snapshotsByDocumentRef.get(documentRef);
    if (existing) {
      return existing;
    }

    const promise = this.engine.getDomSnapshot({ documentRef }).then((snapshot) => {
      this.snapshotsByFrameRef.set(snapshot.frameRef, Promise.resolve(snapshot));
      return snapshot;
    });
    this.snapshotsByDocumentRef.set(documentRef, promise);
    return promise;
  }

  getFrame(frameRef: FrameRef): Promise<DomSnapshot> {
    const existing = this.snapshotsByFrameRef.get(frameRef);
    if (existing) {
      return existing;
    }

    const promise = this.engine.getDomSnapshot({ frameRef }).then((snapshot) => {
      this.snapshotsByDocumentRef.set(snapshot.documentRef, Promise.resolve(snapshot));
      return snapshot;
    });
    this.snapshotsByFrameRef.set(frameRef, promise);
    return promise;
  }

  getMainDocument(pageRef: PageRef): Promise<DomSnapshot> {
    const existing = this.mainSnapshotsByPageRef.get(pageRef);
    if (existing) {
      return existing;
    }

    const promise = this.engine.listFrames({ pageRef }).then(async (frames) => {
      const mainFrame = frames.find((frame) => frame.isMainFrame);
      if (!mainFrame) {
        throw new Error(`page ${pageRef} does not expose a main frame`);
      }
      const snapshot = await this.getFrame(mainFrame.frameRef);
      return snapshot;
    });
    this.mainSnapshotsByPageRef.set(pageRef, promise);
    return promise;
  }
}

class DefaultDomRuntime implements DomRuntime {
  readonly engine: BrowserCoreEngine;
  private readonly descriptors: ReturnType<typeof createDomDescriptorStore>;

  constructor(options: {
    readonly engine: BrowserCoreEngine;
    readonly root?: FilesystemOpensteerRoot;
    readonly namespace?: string;
  }) {
    this.engine = options.engine;
    this.descriptors = createDomDescriptorStore({
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    });
  }

  async buildPath(input: DomBuildPathInput): Promise<ElementPath> {
    return this.withSnapshotSession(async (session) => {
      const snapshot = await session.getDocument(input.locator.documentRef);
      if (snapshot.documentEpoch !== input.locator.documentEpoch) {
        throw new Error(
          `node locator ${input.locator.nodeRef} is stale for ${input.locator.documentRef}`,
        );
      }
      const index = createSnapshotIndex(snapshot);
      const node = findNodeByNodeRef(index, input.locator.nodeRef);
      if (!node) {
        throw new Error(
          `node ${input.locator.nodeRef} was not found in ${input.locator.documentRef}`,
        );
      }
      return this.buildPathFromSnapshotNode(session, snapshot, node);
    });
  }

  async resolveTarget(input: DomResolveTargetInput): Promise<ResolvedDomTarget> {
    return this.withSnapshotSession((session) => this.resolveTargetWithSession(session, input));
  }

  async writeDescriptor(input: DomWriteDescriptorInput): Promise<DomDescriptorRecord> {
    return this.descriptors.write({
      ...input,
      path: sanitizeElementPath(input.path),
    });
  }

  async readDescriptor(input: DomReadDescriptorInput): Promise<DomDescriptorRecord | undefined> {
    return this.descriptors.read(input);
  }

  async click(input: DomClickInput): Promise<DomActionOutcome> {
    return this.withSnapshotSession(async (session) => {
      const resolved = await this.resolveTargetWithSession(session, {
        pageRef: input.pageRef,
        method: "click",
        target: input.target,
      });
      const point = await this.resolveActionPoint(session, resolved, input.position);
      await this.assertHitTarget(resolved, point);
      await this.engine.mouseMove({
        pageRef: resolved.pageRef,
        point,
        coordinateSpace: "document-css",
      });
      await this.engine.mouseClick({
        pageRef: resolved.pageRef,
        point,
        coordinateSpace: "document-css",
        ...(input.button === undefined ? {} : { button: input.button }),
        ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount }),
        ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
      });
      return {
        resolved,
        point,
      };
    });
  }

  async hover(input: DomHoverInput): Promise<DomActionOutcome> {
    return this.withSnapshotSession(async (session) => {
      const resolved = await this.resolveTargetWithSession(session, {
        pageRef: input.pageRef,
        method: "hover",
        target: input.target,
      });
      const point = await this.resolveActionPoint(session, resolved, input.position);
      await this.assertHitTarget(resolved, point);
      await this.engine.mouseMove({
        pageRef: resolved.pageRef,
        point,
        coordinateSpace: "document-css",
      });
      return {
        resolved,
        point,
      };
    });
  }

  async input(input: DomInputInput): Promise<ResolvedDomTarget> {
    return this.withSnapshotSession(async (session) => {
      const resolved = await this.resolveTargetWithSession(session, {
        pageRef: input.pageRef,
        method: "input",
        target: input.target,
      });
      const point = await this.resolveActionPoint(session, resolved);
      await this.assertHitTarget(resolved, point);
      await this.engine.mouseMove({
        pageRef: resolved.pageRef,
        point,
        coordinateSpace: "document-css",
      });
      await this.engine.mouseClick({
        pageRef: resolved.pageRef,
        point,
        coordinateSpace: "document-css",
      });
      await this.engine.textInput({
        pageRef: resolved.pageRef,
        text: input.text,
      });
      if (input.pressEnter) {
        await this.engine.keyPress({
          pageRef: resolved.pageRef,
          key: "Enter",
        });
      }
      return resolved;
    });
  }

  async scroll(input: DomScrollInput): Promise<DomActionOutcome> {
    return this.withSnapshotSession(async (session) => {
      const resolved = await this.resolveTargetWithSession(session, {
        pageRef: input.pageRef,
        method: "scroll",
        target: input.target,
      });
      const point = await this.resolveActionPoint(session, resolved, input.position);
      await this.assertHitTarget(resolved, point);
      await this.engine.mouseMove({
        pageRef: resolved.pageRef,
        point,
        coordinateSpace: "document-css",
      });
      await this.engine.mouseScroll({
        pageRef: resolved.pageRef,
        point,
        coordinateSpace: "document-css",
        delta: input.delta,
      });
      return {
        resolved,
        point,
      };
    });
  }

  async extractFields(input: {
    readonly pageRef: PageRef;
    readonly fields: readonly DomExtractFieldSelector[];
  }): Promise<Readonly<Record<string, string | null>>> {
    return this.withSnapshotSession(async (session) => {
      const result: Record<string, string | null> = {};
      const mainSnapshot = await session.getMainDocument(input.pageRef);

      for (const field of input.fields) {
        if (field.source === "current_url") {
          result[field.key] = mainSnapshot.url;
          continue;
        }
        if (!field.target) {
          result[field.key] = null;
          continue;
        }

        try {
          const resolved = await this.resolveTargetWithSession(session, {
            pageRef: input.pageRef,
            method: "extract",
            target: field.target,
          });
          result[field.key] = await this.readExtractedValue(
            resolved.snapshot,
            resolved.node,
            field.attribute,
          );
        } catch {
          result[field.key] = null;
        }
      }

      return result;
    });
  }

  async extractArrayRows(input: DomExtractArrayRowsInput) {
    return this.withSnapshotSession(async (session) => {
      const normalizedArray = {
        itemParentPath: sanitizeElementPath(input.array.itemParentPath),
        fields: input.array.fields.map((field) => ({
          key: field.key,
          ...(field.path === undefined ? {} : { path: sanitizeElementPath(field.path) }),
          ...(field.attribute === undefined ? {} : { attribute: field.attribute }),
          ...(field.source === undefined ? {} : { source: field.source }),
        })),
      };

      const items = await this.queryAllByElementPath(
        session,
        input.pageRef,
        normalizedArray.itemParentPath,
      );
      if (!items.length) {
        return [];
      }

      const rows: Array<{
        readonly values: Readonly<Record<string, string | null>>;
        readonly meta: {
          readonly key: string;
          readonly order: number;
        };
      }> = [];

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        const values: Record<string, string | null> = {};

        for (const field of normalizedArray.fields) {
          if (field.source === "current_url") {
            values[field.key] = item.snapshot.url;
            continue;
          }

          const targetNode = await this.resolveArrayFieldTarget(item, field);
          values[field.key] =
            targetNode === null
              ? null
              : await this.readExtractedValue(item.snapshot, targetNode, field.attribute);
        }

        rows.push({
          values,
          meta: {
            key: `${item.snapshot.documentRef}:${item.node.nodeRef ?? `snapshot:${String(item.node.snapshotNodeId)}`}`,
            order: index,
          },
        });
      }

      return rows;
    });
  }

  private async withSnapshotSession<T>(
    callback: (session: SnapshotSession) => Promise<T>,
  ): Promise<T> {
    return callback(new SnapshotSession(this.engine));
  }

  private async resolveTargetWithSession(
    session: SnapshotSession,
    input: DomResolveTargetInput,
  ): Promise<ResolvedDomTarget> {
    let resolved: ResolvedDomTarget;
    switch (input.target.kind) {
      case "descriptor":
        resolved = await this.resolveDescriptorTarget(session, input.pageRef, input.target);
        break;
      case "live":
        resolved = await this.resolveLiveTarget(session, input.target);
        break;
      case "path":
        resolved = await this.resolvePathTarget(
          session,
          input.pageRef,
          sanitizeElementPath(input.target.path),
          "path",
          input.target.description,
        );
        break;
      case "selector":
        resolved = await this.resolveSelectorTarget(
          session,
          input.pageRef,
          input.method,
          input.target,
        );
        break;
    }

    this.assertTargetPageOwnership(input.pageRef, resolved);
    return resolved;
  }

  private async resolveDescriptorTarget(
    session: SnapshotSession,
    pageRef: PageRef,
    target: Extract<DomTargetRef, { readonly kind: "descriptor" }>,
  ): Promise<ResolvedDomTarget> {
    const descriptor = await this.descriptors.read({ description: target.description });
    if (!descriptor) {
      throw new Error(`no stored DOM descriptor found for "${target.description}"`);
    }
    return this.resolveStoredDescriptorTarget(session, pageRef, descriptor);
  }

  private async resolveStoredDescriptorTarget(
    session: SnapshotSession,
    pageRef: PageRef,
    descriptor: DomDescriptorRecord,
  ): Promise<ResolvedDomTarget> {
    return this.resolvePathTarget(
      session,
      pageRef,
      descriptor.payload.path,
      "descriptor",
      descriptor.payload.description,
      descriptor,
    );
  }

  private async resolveLiveTarget(
    session: SnapshotSession,
    target: Extract<DomTargetRef, { readonly kind: "live" }>,
  ): Promise<ResolvedDomTarget> {
    const snapshot = await session.getDocument(target.locator.documentRef);
    if (snapshot.documentEpoch !== target.locator.documentEpoch) {
      throw new Error(
        `node locator ${target.locator.nodeRef} is stale for ${target.locator.documentRef}`,
      );
    }
    const index = createSnapshotIndex(snapshot);
    const node = findNodeByNodeRef(index, target.locator.nodeRef);
    if (!node) {
      throw new Error(
        `node ${target.locator.nodeRef} was not found in ${target.locator.documentRef}`,
      );
    }
    const elementNode = normalizeToElementNode(index, node);
    if (!elementNode || elementNode.nodeRef === undefined) {
      throw new Error(`node ${target.locator.nodeRef} is not attached to a live element`);
    }
    const path = await this.tryBuildPathFromSnapshotNode(session, snapshot, elementNode);
    return this.createResolvedTarget("live", snapshot, elementNode, path, {
      ...(target.description === undefined ? {} : { description: target.description }),
    });
  }

  private async resolveSelectorTarget(
    session: SnapshotSession,
    pageRef: PageRef,
    method: string,
    target: Extract<DomTargetRef, { readonly kind: "selector" }>,
  ): Promise<ResolvedDomTarget> {
    const resolved = await this.resolveSelectorMatch(session, pageRef, target);
    const { snapshot, node } = resolved;
    const path = await this.tryBuildPathFromSnapshotNode(session, snapshot, node);
    const descriptor =
      target.description === undefined || path.nodes.length === 0
        ? undefined
        : await this.descriptors.write({
            method,
            description: target.description,
            path,
            sourceUrl: snapshot.url,
          });
    return this.createResolvedTarget("selector", snapshot, node, path, {
      ...(target.description === undefined ? {} : { description: target.description }),
      selectorUsed: target.selector,
      ...(descriptor === undefined ? {} : { descriptor }),
    });
  }

  private async resolveSelectorMatch(
    session: SnapshotSession,
    pageRef: PageRef,
    target: Extract<DomTargetRef, { readonly kind: "selector" }>,
  ): Promise<{
    readonly snapshot: DomSnapshot;
    readonly node: DomSnapshotNode & { readonly nodeRef: NodeRef };
  }> {
    if (target.documentRef !== undefined) {
      return this.resolveSelectorMatchWithinSnapshots(
        [await session.getDocument(target.documentRef)],
        target.selector,
      );
    }

    if (target.frameRef !== undefined) {
      return this.resolveSelectorMatchWithinSnapshots(
        [await session.getFrame(target.frameRef)],
        target.selector,
      );
    }

    const mainSnapshot = await session.getMainDocument(pageRef);
    const mainMatch = await this.findSelectorMatchWithinSnapshots(
      [mainSnapshot],
      target.selector,
    );
    if (mainMatch !== undefined) {
      return mainMatch;
    }

    const frameSnapshots = await this.listSelectorSearchSnapshots(session, pageRef);
    return this.resolveSelectorMatchWithinSnapshots(
      frameSnapshots.filter((snapshot) => snapshot.documentRef !== mainSnapshot.documentRef),
      target.selector,
    );
  }

  private async listSelectorSearchSnapshots(
    session: SnapshotSession,
    pageRef: PageRef,
  ): Promise<readonly DomSnapshot[]> {
    const frames = await this.engine.listFrames({ pageRef });
    return Promise.all(
      [...frames]
        .sort((left, right) => Number(right.isMainFrame) - Number(left.isMainFrame))
        .map((frame) => session.getFrame(frame.frameRef)),
    );
  }

  private async resolveSelectorMatchWithinSnapshots(
    snapshots: readonly DomSnapshot[],
    selector: string,
  ): Promise<{
    readonly snapshot: DomSnapshot;
    readonly node: DomSnapshotNode & { readonly nodeRef: NodeRef };
  }> {
    const match = await this.findSelectorMatchWithinSnapshots(snapshots, selector);
    if (!match) {
      throw new Error(`selector "${selector}" did not match any elements`);
    }

    return match;
  }

  private async findSelectorMatchWithinSnapshots(
    snapshots: readonly DomSnapshot[],
    selector: string,
  ): Promise<
    | {
        readonly snapshot: DomSnapshot;
        readonly node: DomSnapshotNode & { readonly nodeRef: NodeRef };
      }
    | undefined
  > {
    let match:
      | {
          readonly snapshot: DomSnapshot;
          readonly node: DomSnapshotNode & { readonly nodeRef: NodeRef };
        }
      | undefined;

    for (const snapshot of snapshots) {
      const index = createSnapshotIndex(snapshot);
      const matches = querySelectorAllInScope(index, selector, createExplicitSelectorScope());
      for (const candidate of matches) {
        const node = toLiveElementNode(index, candidate);
        if (!node) {
          continue;
        }

        if (match !== undefined) {
          throw new Error(`selector "${selector}" matched multiple elements`);
        }

        match = {
          snapshot,
          node,
        };
      }
    }

    return match;
  }

  private async resolvePathTarget(
    session: SnapshotSession,
    pageRef: PageRef,
    rawPath: ElementPath,
    source: ResolvedDomTarget["source"],
    description?: string,
    descriptor?: DomDescriptorRecord,
  ): Promise<ResolvedDomTarget> {
    const path = sanitizeElementPath(rawPath);
    const context = await this.resolvePathContext(session, pageRef, path.context);
    const target = resolveDomPathInScope(context.index, path.nodes, context.scope);
    if (!target) {
      throwTargetNotFound(context.index, path.nodes, context.scope);
    }
    if (target.mode === "ambiguous") {
      throwTargetNotUnique(context.index, path.nodes, context.scope);
    }
    if (target.node.nodeRef === undefined) {
      throw new Error(
        `resolved path "${buildPathSelectorHint(path)}" does not point to a live element`,
      );
    }

    return this.createResolvedTarget(source, context.snapshot, target.node, path, {
      ...(description === undefined ? {} : { description }),
      ...(source === "path" || source === "descriptor" ? { selectorUsed: target.selector } : {}),
      ...(descriptor === undefined ? {} : { descriptor }),
    });
  }

  private async queryAllByElementPath(
    session: SnapshotSession,
    pageRef: PageRef,
    rawPath: ElementPath,
  ): Promise<readonly SnapshotTarget[]> {
    const path = sanitizeElementPath(rawPath);
    const context = await this.resolvePathContext(session, pageRef, path.context);
    return queryAllDomPathInScope(context.index, path.nodes, context.scope)
      .filter(
        (node): node is DomSnapshotNode & { readonly nodeRef: NodeRef } =>
          node.nodeRef !== undefined,
      )
      .map((node) => this.createSnapshotTarget(context.snapshot, node));
  }

  private async resolvePathContext(
    session: SnapshotSession,
    pageRef: PageRef,
    contextPath: readonly ElementPath["context"][number][],
  ): Promise<{
    readonly snapshot: DomSnapshot;
    readonly index: DomSnapshotIndex;
    readonly scope: DomQueryScope;
  }> {
    let snapshot = await session.getMainDocument(pageRef);
    let index = createSnapshotIndex(snapshot);
    let scope = createPathScope();

    for (const hop of contextPath) {
      const host = resolveDomPathInScope(index, hop.host, scope);
      if (!host) {
        throw new ElementPathError(
          "ERR_PATH_CONTEXT_HOST_NOT_FOUND",
          "Unable to resolve context host from stored match selectors.",
        );
      }
      if (host.mode === "ambiguous") {
        throwContextHostNotUnique(index, hop.host, scope);
      }

      if (hop.kind === "iframe") {
        const nextDocumentRef = host.node.contentDocumentRef;
        if (!nextDocumentRef) {
          throw new ElementPathError(
            "ERR_PATH_IFRAME_UNAVAILABLE",
            "Iframe is unavailable or inaccessible for this path.",
          );
        }

        snapshot = await session.getDocument(nextDocumentRef);
        index = createSnapshotIndex(snapshot);
        scope = createPathScope();
        continue;
      }

      const hostRef = host.node.nodeRef;
      if (hostRef === undefined || !hasOpenShadowRoot(index, host.node)) {
        throw new ElementPathError(
          "ERR_PATH_SHADOW_ROOT_UNAVAILABLE",
          "Shadow root is unavailable for this path.",
        );
      }

      scope = createPathScope(hostRef);
    }

    return {
      snapshot,
      index,
      scope,
    };
  }

  private async buildPathFromSnapshotNode(
    session: SnapshotSession,
    snapshot: DomSnapshot,
    node: DomSnapshotNode,
  ): Promise<ElementPath> {
    const index = createSnapshotIndex(snapshot);
    const localPath = buildLocalElementPath(index, node);
    return this.prefixIframeContext(session, snapshot, localPath);
  }

  private async tryBuildPathFromSnapshotNode(
    session: SnapshotSession,
    snapshot: DomSnapshot,
    node: DomSnapshotNode,
  ): Promise<ElementPath> {
    try {
      return await this.buildPathFromSnapshotNode(session, snapshot, node);
    } catch {
      return sanitizeElementPath({
        context: [],
        nodes: [],
      });
    }
  }

  private async prefixIframeContext(
    session: SnapshotSession,
    snapshot: DomSnapshot,
    localPath: ElementPath,
  ): Promise<ElementPath> {
    if (snapshot.parentDocumentRef === undefined) {
      return sanitizeElementPath(localPath);
    }

    const parentSnapshot = await session.getDocument(snapshot.parentDocumentRef);
    const parentIndex = createSnapshotIndex(parentSnapshot);
    const iframeHost = findIframeHostNode(parentIndex, snapshot.documentRef);
    if (!iframeHost) {
      throw new Error(
        `document ${snapshot.documentRef} has parent ${snapshot.parentDocumentRef} but no iframe host`,
      );
    }

    const hostPath = await this.buildPathFromSnapshotNode(session, parentSnapshot, iframeHost);
    return sanitizeElementPath({
      context: [
        ...hostPath.context,
        { kind: "iframe", host: hostPath.nodes },
        ...localPath.context,
      ],
      nodes: localPath.nodes,
    });
  }

  private createResolvedTarget(
    source: ResolvedDomTarget["source"],
    snapshot: DomSnapshot,
    node: DomSnapshotNode,
    path: ElementPath,
    options: {
      readonly description?: string;
      readonly selectorUsed?: string;
      readonly descriptor?: DomDescriptorRecord;
    } = {},
  ): ResolvedDomTarget {
    if (node.nodeRef === undefined) {
      throw new Error(
        `snapshot node ${String(node.snapshotNodeId)} does not expose a live node reference`,
      );
    }
    const locator = createNodeLocator(snapshot.documentRef, snapshot.documentEpoch, node.nodeRef);
    return {
      source,
      pageRef: snapshot.pageRef,
      frameRef: snapshot.frameRef,
      documentRef: snapshot.documentRef,
      documentEpoch: snapshot.documentEpoch,
      nodeRef: node.nodeRef,
      locator,
      snapshot,
      node,
      path: sanitizeElementPath(path),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.selectorUsed === undefined ? {} : { selectorUsed: options.selectorUsed }),
      ...(options.descriptor === undefined ? {} : { descriptor: options.descriptor }),
    };
  }

  private createSnapshotTarget(snapshot: DomSnapshot, node: DomSnapshotNode): SnapshotTarget {
    if (node.nodeRef === undefined) {
      throw new Error(
        `snapshot node ${String(node.snapshotNodeId)} does not expose a live node reference`,
      );
    }
    return {
      snapshot,
      node,
    };
  }

  private async resolveArrayFieldTarget(
    item: SnapshotTarget,
    field: DomArrayFieldSelector,
  ): Promise<DomSnapshotNode | null> {
    if (!field.path) {
      return item.node;
    }

    const normalizedPath = sanitizeElementPath(field.path);
    const selectors = buildArrayFieldCandidates(normalizedPath);
    if (!selectors.length) {
      return item.node;
    }

    const index = createSnapshotIndex(item.snapshot);
    return resolveFirstWithinNodeBySelectors(index, item.node, selectors);
  }

  private async readExtractedValue(
    snapshot: DomSnapshot,
    node: DomSnapshotNode,
    attribute: string | undefined,
  ): Promise<string | null> {
    if (node.nodeRef === undefined) {
      return null;
    }

    const locator = createNodeLocator(snapshot.documentRef, snapshot.documentEpoch, node.nodeRef);
    let raw: string | null;
    if (attribute === undefined) {
      raw = await this.engine.readText(locator);
    } else {
      const attributes = await this.engine.readAttributes(locator);
      raw = attributes.find((entry) => entry.name === attribute)?.value ?? null;
    }

    const normalized = normalizeExtractedValue(raw, attribute);
    return resolveExtractedValueInContext(normalized, {
      ...(attribute === undefined ? {} : { attribute }),
      baseURI: snapshot.url,
      insideIframe: snapshot.parentDocumentRef !== undefined,
    });
  }

  private async resolveActionPoint(
    session: SnapshotSession,
    resolved: ResolvedDomTarget,
    position?: Point,
  ): Promise<Point> {
    const rect = resolved.node.layout?.rect;
    if (!rect) {
      throw new Error(`target ${resolved.nodeRef} does not expose DOM geometry`);
    }

    const localPoint =
      position === undefined
        ? createPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        : createPoint(rect.x + position.x, rect.y + position.y);

    if (!rectContainsPoint(rect, localPoint)) {
      throw new Error(`target point for ${resolved.nodeRef} falls outside the resolved DOM box`);
    }

    const point = await this.resolvePagePointFromDocumentPoint(
      session,
      resolved.snapshot,
      localPoint,
    );

    const metrics = await this.engine.getViewportMetrics({ pageRef: resolved.pageRef });
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x > metrics.contentSize.width ||
      point.y > metrics.contentSize.height
    ) {
      throw new Error(
        `target point for ${resolved.nodeRef} falls outside the document content bounds`,
      );
    }

    return point;
  }

  private async resolvePagePointFromDocumentPoint(
    session: SnapshotSession,
    snapshot: DomSnapshot,
    point: Point,
  ): Promise<Point> {
    let currentSnapshot = snapshot;
    let currentPoint = point;

    while (currentSnapshot.parentDocumentRef !== undefined) {
      const parentSnapshot = await session.getDocument(currentSnapshot.parentDocumentRef);
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

  private async assertHitTarget(resolved: ResolvedDomTarget, point: Point): Promise<void> {
    const hit = await this.engine.hitTest({
      pageRef: resolved.pageRef,
      point,
      coordinateSpace: "document-css",
    });

    if (hit.documentRef !== resolved.documentRef || hit.documentEpoch !== resolved.documentEpoch) {
      throw new Error(
        `hit test resolved ${hit.nodeRef ?? "no-node"} outside ${resolved.documentRef}@${String(resolved.documentEpoch)}`,
      );
    }

    if (hit.nodeRef === undefined) {
      throw new Error(`hit test did not resolve a live node for ${resolved.source}`);
    }

    const index = createSnapshotIndex(resolved.snapshot);
    if (!isSameNodeOrDescendant(index, hit.nodeRef, resolved.nodeRef)) {
      throw new Error(
        `hit test resolved ${hit.nodeRef} outside the target subtree rooted at ${resolved.nodeRef} for ${resolved.source}`,
      );
    }
  }

  private assertTargetPageOwnership(pageRef: PageRef, resolved: ResolvedDomTarget): void {
    if (resolved.pageRef !== pageRef) {
      throw new Error(
        `DOM target resolved on page ${resolved.pageRef} instead of requested page ${pageRef}`,
      );
    }
  }
}

export function createDomRuntime(options: {
  readonly engine: BrowserCoreEngine;
  readonly root?: FilesystemOpensteerRoot;
  readonly namespace?: string;
}): DomRuntime {
  return new DefaultDomRuntime(options);
}

function toLiveElementNode(
  index: DomSnapshotIndex,
  node: DomSnapshotNode,
): (DomSnapshotNode & { readonly nodeRef: NodeRef }) | undefined {
  const normalized = normalizeToElementNode(index, node);
  if (!normalized || !hasNodeRef(normalized)) {
    return undefined;
  }
  return normalized;
}

function hasNodeRef(node: DomSnapshotNode): node is DomSnapshotNode & { readonly nodeRef: NodeRef } {
  return node.nodeRef !== undefined;
}
