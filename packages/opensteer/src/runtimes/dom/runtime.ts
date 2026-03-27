import {
  createNodeLocator,
  type BrowserCoreEngine,
  type DocumentRef,
  type DomSnapshot,
  type DomSnapshotNode,
  type FrameRef,
  type NodeRef,
  type PageRef,
  type Point,
} from "@opensteer/browser-core";
import { OpensteerProtocolError } from "@opensteer/protocol";

import { defaultPolicy, type OpensteerPolicy } from "../../policy/index.js";
import type { FilesystemOpensteerWorkspace } from "../../root.js";
import type { DomActionBridge } from "./bridge.js";
import { resolveDomActionBridge } from "./bridge.js";
import { createDomDescriptorStore } from "./descriptors.js";
import { DomActionExecutor } from "./executor.js";
import { normalizeExtractedValue, resolveExtractedValueInContext } from "./extraction.js";
import { ElementPathError } from "./errors.js";
import {
  buildArrayFieldCandidates,
  buildLocalStructuralElementAnchor,
  buildPathSelectorHint,
  createExplicitSelectorScope,
  createPathScope,
  createSnapshotIndex,
  queryAllDomPathInScope,
  resolveStructuralAnchorInScope,
  resolveDomPathInScope,
  resolveFirstWithinNodeBySelectors,
  sanitizeElementPath,
  sanitizeReplayElementPath,
  sanitizeStructuralElementAnchor,
  throwTargetNotFound,
} from "./path.js";
import {
  findIframeHostNode,
  findNodeByNodeRef,
  hasShadowRoot,
  normalizeToElementNode,
  querySelectorAllInScope,
  querySelectorAllWithinNode,
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
  ReplayElementPath,
  ResolvedDomTarget,
  StructuralElementAnchor,
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
  private readonly policy: OpensteerPolicy;
  private readonly executor: DomActionExecutor;
  private readonly bridge: DomActionBridge | undefined;

  constructor(options: {
    readonly engine: BrowserCoreEngine;
    readonly root?: FilesystemOpensteerWorkspace;
    readonly namespace?: string;
    readonly policy?: OpensteerPolicy;
  }) {
    this.engine = options.engine;
    this.descriptors = createDomDescriptorStore({
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    });
    this.policy = options.policy ?? defaultPolicy();
    this.bridge = resolveDomActionBridge(this.engine);
    this.executor = new DomActionExecutor({
      engine: this.engine,
      policy: this.policy,
      createResolutionSession: () => new SnapshotSession(this.engine),
      resolveTarget: (session, input) =>
        this.resolveTargetWithSession(session as SnapshotSession, input),
      writeDescriptor: (input) => this.descriptors.write(input),
    });
  }

  async buildAnchor(input: DomBuildPathInput): Promise<StructuralElementAnchor> {
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
      return this.buildAnchorFromSnapshotNode(session, snapshot, node);
    });
  }

  async buildPath(input: DomBuildPathInput): Promise<ReplayElementPath> {
    return sanitizeReplayElementPath(await this.requireBridge().buildReplayPath(input.locator));
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
    return this.executor.click(input);
  }

  async hover(input: DomHoverInput): Promise<DomActionOutcome> {
    return this.executor.hover(input);
  }

  async input(input: DomInputInput): Promise<ResolvedDomTarget> {
    return this.executor.input(input);
  }

  async scroll(input: DomScrollInput): Promise<DomActionOutcome> {
    return this.executor.scroll(input);
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

  async validateArrayFieldPositionStripping(input: {
    readonly pageRef: PageRef;
    readonly itemParentPath: ReplayElementPath;
    readonly fields: readonly {
      readonly key: string;
      readonly originalPath: ReplayElementPath;
      readonly strippedPath: ReplayElementPath;
    }[];
  }): Promise<Readonly<Record<string, boolean>>> {
    return this.withSnapshotSession(async (session) => {
      const fieldsByKey = new Map(input.fields.map((field) => [field.key, true]));
      if (!fieldsByKey.size) {
        return {};
      }

      const items = await this.queryAllByElementPath(session, input.pageRef, input.itemParentPath);
      if (!items.length) {
        return Object.fromEntries([...fieldsByKey.keys()].map((key) => [key, false]));
      }

      for (const item of items) {
        const index = createSnapshotIndex(item.snapshot);
        for (const field of input.fields) {
          if (!fieldsByKey.get(field.key)) {
            continue;
          }

          const original = this.resolveFirstArrayFieldTargetInNode(
            index,
            item.node,
            field.originalPath,
          );
          if (!original) {
            fieldsByKey.set(field.key, false);
            continue;
          }

          const strippedUnique = this.resolveUniqueArrayFieldTargetInNode(
            index,
            item.node,
            field.strippedPath,
          );
          fieldsByKey.set(field.key, sameSnapshotNode(original, strippedUnique));
        }

        if ([...fieldsByKey.values()].every((value) => !value)) {
          break;
        }
      }

      return Object.fromEntries(fieldsByKey);
    });
  }

  private async withSnapshotSession<T>(
    callback: (session: SnapshotSession) => Promise<T>,
  ): Promise<T> {
    return callback(new SnapshotSession(this.engine));
  }

  private async resolveTargetWithSession(
    session: SnapshotSession,
    input: DomResolveTargetInput & {
      readonly descriptorWriter?: (input: DomWriteDescriptorInput) => Promise<DomDescriptorRecord>;
    },
  ): Promise<ResolvedDomTarget> {
    let resolved: ResolvedDomTarget;
    switch (input.target.kind) {
      case "descriptor":
        resolved = await this.resolveDescriptorTarget(
          session,
          input.pageRef,
          input.method,
          input.target,
        );
        break;
      case "live":
        resolved = await this.resolveLiveTarget(session, input.pageRef, input.target);
        break;
      case "anchor":
        resolved = await this.resolveAnchorTarget(
          session,
          input.pageRef,
          input.target.anchor,
          "anchor",
          input.target.description,
        );
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
          input.descriptorWriter,
        );
        break;
    }

    this.assertTargetPageOwnership(input.pageRef, resolved);
    return resolved;
  }

  private async resolveDescriptorTarget(
    session: SnapshotSession,
    pageRef: PageRef,
    method: string,
    target: Extract<DomTargetRef, { readonly kind: "descriptor" }>,
  ): Promise<ResolvedDomTarget> {
    const descriptor = await this.descriptors.read({
      method,
      description: target.description,
    });
    if (!descriptor) {
      throw new OpensteerProtocolError(
        "not-found",
        `no stored DOM descriptor found for "${target.description}"`,
        {
          details: {
            description: target.description,
            kind: "dom-descriptor",
          },
        },
      );
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
    pageRef: PageRef,
    target: Extract<DomTargetRef, { readonly kind: "live" }>,
  ): Promise<ResolvedDomTarget> {
    const resolvedByLocator = await this.tryResolveLiveTargetByLocator(session, target);
    if (resolvedByLocator) {
      const { snapshot, node } = resolvedByLocator;
      const anchor = await this.buildAnchorFromSnapshotNode(session, snapshot, node);
      const replayPath = await this.tryBuildPathFromNode(snapshot, node);
      return this.createResolvedTarget("live", snapshot, node, anchor, {
        ...(target.description === undefined ? {} : { description: target.description }),
        ...(replayPath === undefined ? {} : { replayPath }),
      });
    }

    if (target.anchor) {
      return this.resolveAnchorTarget(session, pageRef, target.anchor, "live", target.description);
    }

    throw new Error(
      `node locator ${target.locator.nodeRef} is stale for ${target.locator.documentRef}`,
    );
  }

  private async resolveSelectorTarget(
    session: SnapshotSession,
    pageRef: PageRef,
    method: string,
    target: Extract<DomTargetRef, { readonly kind: "selector" }>,
    descriptorWriter:
      | ((input: DomWriteDescriptorInput) => Promise<DomDescriptorRecord>)
      | undefined,
  ): Promise<ResolvedDomTarget> {
    const resolved = await this.resolveSelectorMatch(session, pageRef, target);
    const { snapshot, node } = resolved;
    const anchor = await this.buildAnchorFromSnapshotNode(session, snapshot, node);
    const writeDescriptor =
      descriptorWriter ?? ((input: DomWriteDescriptorInput) => this.descriptors.write(input));
    const replayPath = await this.tryBuildPathFromNode(snapshot, node);
    const descriptor =
      target.description === undefined
        ? undefined
        : await writeDescriptor({
            method,
            description: target.description,
            path: replayPath ?? (await this.buildPathForNode(snapshot, node)),
            sourceUrl: snapshot.url,
          });
    return this.createResolvedTarget("selector", snapshot, node, anchor, {
      ...(target.description === undefined ? {} : { description: target.description }),
      selectorUsed: target.selector,
      ...(replayPath === undefined ? {} : { replayPath }),
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
    const mainMatch = await this.findSelectorMatchWithinSnapshots([mainSnapshot], target.selector);
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
    const snapshots = await Promise.allSettled(
      [...frames]
        .sort((left, right) => Number(right.isMainFrame) - Number(left.isMainFrame))
        .map((frame) => session.getFrame(frame.frameRef)),
    );
    return snapshots.flatMap((snapshot) =>
      snapshot.status === "fulfilled" ? [snapshot.value] : [],
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
    rawPath: ReplayElementPath,
    source: ResolvedDomTarget["source"],
    description?: string,
    descriptor?: DomDescriptorRecord,
  ): Promise<ResolvedDomTarget> {
    const path = sanitizeReplayElementPath(rawPath);
    const context = await this.resolvePathContext(session, pageRef, path.context);
    const target = resolveDomPathInScope(context.index, path.nodes, context.scope);
    if (!target) {
      throwTargetNotFound(context.index, path.nodes, context.scope);
    }
    if (target.node.nodeRef === undefined) {
      throw new Error(
        `resolved path "${buildPathSelectorHint(path)}" does not point to a live element`,
      );
    }

    const anchor = await this.buildAnchorFromSnapshotNode(session, context.snapshot, target.node);
    return this.createResolvedTarget(source, context.snapshot, target.node, anchor, {
      ...(description === undefined ? {} : { description }),
      replayPath: path,
      ...(source === "path" || source === "descriptor" ? { selectorUsed: target.selector } : {}),
      ...(descriptor === undefined ? {} : { descriptor }),
    });
  }

  private async resolveAnchorTarget(
    session: SnapshotSession,
    pageRef: PageRef,
    rawAnchor: StructuralElementAnchor,
    source: Extract<ResolvedDomTarget["source"], "anchor" | "live">,
    description?: string,
  ): Promise<ResolvedDomTarget> {
    const anchor = sanitizeStructuralElementAnchor(rawAnchor);
    const context = await this.resolveAnchorContext(session, pageRef, anchor.context);
    const target = resolveStructuralAnchorInScope(context.index, anchor.nodes, context.scope);
    if (!target || target.node.nodeRef === undefined) {
      throw new Error(
        `Unable to resolve structural anchor "${buildPathSelectorHint(anchor)}" in the current session`,
      );
    }

    const replayPath = await this.tryBuildPathFromNode(context.snapshot, target.node);
    return this.createResolvedTarget(source, context.snapshot, target.node, anchor, {
      ...(description === undefined ? {} : { description }),
      ...(replayPath === undefined ? {} : { replayPath }),
    });
  }

  private async queryAllByElementPath(
    session: SnapshotSession,
    pageRef: PageRef,
    rawPath: ReplayElementPath,
  ): Promise<readonly SnapshotTarget[]> {
    const path = sanitizeReplayElementPath(rawPath);
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
    contextPath: readonly ReplayElementPath["context"][number][],
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
      if (hostRef === undefined || !hasShadowRoot(index, host.node)) {
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

  private async resolveAnchorContext(
    session: SnapshotSession,
    pageRef: PageRef,
    contextPath: readonly StructuralElementAnchor["context"][number][],
  ): Promise<{
    readonly snapshot: DomSnapshot;
    readonly index: DomSnapshotIndex;
    readonly scope: DomQueryScope;
  }> {
    let snapshot = await session.getMainDocument(pageRef);
    let index = createSnapshotIndex(snapshot);
    let scope = createPathScope();

    for (const hop of contextPath) {
      const host = resolveStructuralAnchorInScope(index, hop.host, scope);
      if (!host) {
        throw new Error("Unable to resolve structural context host in the current session.");
      }

      if (hop.kind === "iframe") {
        const nextDocumentRef = host.node.contentDocumentRef;
        if (!nextDocumentRef) {
          throw new Error("Iframe is unavailable or inaccessible for this structural anchor.");
        }

        snapshot = await session.getDocument(nextDocumentRef);
        index = createSnapshotIndex(snapshot);
        scope = createPathScope();
        continue;
      }

      const hostRef = host.node.nodeRef;
      if (hostRef === undefined || !hasShadowRoot(index, host.node)) {
        throw new Error("Shadow root is unavailable for this structural anchor.");
      }

      scope = createPathScope(hostRef);
    }

    return {
      snapshot,
      index,
      scope,
    };
  }

  private async buildAnchorFromSnapshotNode(
    session: SnapshotSession,
    snapshot: DomSnapshot,
    node: DomSnapshotNode,
  ): Promise<StructuralElementAnchor> {
    const index = createSnapshotIndex(snapshot);
    const localAnchor = buildLocalStructuralElementAnchor(index, node);
    return this.prefixIframeContext(session, snapshot, localAnchor);
  }

  private async prefixIframeContext(
    session: SnapshotSession,
    snapshot: DomSnapshot,
    localPath: StructuralElementAnchor,
  ): Promise<StructuralElementAnchor>;
  private async prefixIframeContext(
    session: SnapshotSession,
    snapshot: DomSnapshot,
    localPath: StructuralElementAnchor,
  ): Promise<StructuralElementAnchor> {
    if (snapshot.parentDocumentRef === undefined) {
      return sanitizeStructuralElementAnchor(localPath);
    }

    const parentSnapshot = await session.getDocument(snapshot.parentDocumentRef);
    const parentIndex = createSnapshotIndex(parentSnapshot);
    const iframeHost = findIframeHostNode(parentIndex, snapshot.documentRef);
    if (!iframeHost) {
      throw new Error(
        `document ${snapshot.documentRef} has parent ${snapshot.parentDocumentRef} but no iframe host`,
      );
    }

    const hostPath = await this.buildAnchorFromSnapshotNode(session, parentSnapshot, iframeHost);
    return sanitizeStructuralElementAnchor({
      resolution: "structural",
      context: [
        ...hostPath.context,
        { kind: "iframe", host: hostPath.nodes },
        ...localPath.context,
      ],
      nodes: localPath.nodes,
    });
  }

  private async tryResolveLiveTargetByLocator(
    session: SnapshotSession,
    target: Extract<DomTargetRef, { readonly kind: "live" }>,
  ): Promise<
    | {
        readonly snapshot: DomSnapshot;
        readonly node: DomSnapshotNode & { readonly nodeRef: NodeRef };
      }
    | undefined
  > {
    const snapshot = await session.getDocument(target.locator.documentRef);
    if (snapshot.documentEpoch !== target.locator.documentEpoch) {
      return undefined;
    }

    const index = createSnapshotIndex(snapshot);
    const node = findNodeByNodeRef(index, target.locator.nodeRef);
    if (!node) {
      return undefined;
    }

    const elementNode = normalizeToElementNode(index, node);
    if (!elementNode || elementNode.nodeRef === undefined) {
      throw new Error(`node ${target.locator.nodeRef} is not attached to a live element`);
    }

    return {
      snapshot,
      node: elementNode as DomSnapshotNode & { readonly nodeRef: NodeRef },
    };
  }

  private createResolvedTarget(
    source: ResolvedDomTarget["source"],
    snapshot: DomSnapshot,
    node: DomSnapshotNode,
    anchor: StructuralElementAnchor,
    options: {
      readonly description?: string;
      readonly replayPath?: ReplayElementPath;
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
      anchor: sanitizeStructuralElementAnchor(anchor),
      ...(options.replayPath === undefined
        ? {}
        : { replayPath: sanitizeReplayElementPath(options.replayPath) }),
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

  private requireBridge(): DomActionBridge {
    if (!this.bridge) {
      throw new Error("DOM live bridge is unavailable for this engine");
    }
    return this.bridge;
  }

  private async buildPathForNode(
    snapshot: DomSnapshot,
    node: DomSnapshotNode,
  ): Promise<ReplayElementPath> {
    if (node.nodeRef === undefined) {
      throw new Error(
        `snapshot node ${String(node.snapshotNodeId)} does not expose a live node reference`,
      );
    }

    return this.buildPath({
      locator: createNodeLocator(snapshot.documentRef, snapshot.documentEpoch, node.nodeRef),
    });
  }

  private async tryBuildPathFromNode(
    snapshot: DomSnapshot,
    node: DomSnapshotNode,
  ): Promise<ReplayElementPath | undefined> {
    try {
      return await this.buildPathForNode(snapshot, node);
    } catch {
      return undefined;
    }
  }

  private async resolveArrayFieldTarget(
    item: SnapshotTarget,
    field: DomArrayFieldSelector,
  ): Promise<DomSnapshotNode | null> {
    if (!field.path) {
      return item.node;
    }

    const index = createSnapshotIndex(item.snapshot);
    return this.resolveFirstArrayFieldTargetInNode(index, item.node, field.path);
  }

  private resolveFirstArrayFieldTargetInNode(
    index: DomSnapshotIndex,
    rootNode: DomSnapshotNode,
    path: ReplayElementPath,
  ): DomSnapshotNode | null {
    const normalizedPath = sanitizeElementPath(path);
    const selectors = buildArrayFieldCandidates(normalizedPath);
    if (!selectors.length) {
      return rootNode;
    }

    return resolveFirstWithinNodeBySelectors(index, rootNode, selectors);
  }

  private resolveUniqueArrayFieldTargetInNode(
    index: DomSnapshotIndex,
    rootNode: DomSnapshotNode,
    path: ReplayElementPath,
  ): DomSnapshotNode | null {
    const normalizedPath = sanitizeElementPath(path);
    const selectors = buildArrayFieldCandidates(normalizedPath);
    if (!selectors.length) {
      return rootNode;
    }

    for (const selector of selectors) {
      const matches = querySelectorAllWithinNode(index, rootNode, selector, createPathScope());
      if (matches.length === 1) {
        return matches[0]!;
      }
    }

    return null;
  }

  private async readExtractedValue(
    snapshot: DomSnapshot,
    node: DomSnapshotNode,
    attribute: string | undefined,
  ): Promise<string | null> {
    let raw: string | null;
    if (attribute === undefined) {
      raw = node.textContent ?? node.nodeValue ?? null;
    } else {
      raw = node.attributes.find((entry) => entry.name === attribute)?.value ?? null;
    }

    const normalized = normalizeExtractedValue(raw, attribute);
    return resolveExtractedValueInContext(normalized, {
      ...(attribute === undefined ? {} : { attribute }),
      baseURI: snapshot.url,
      insideIframe: snapshot.parentDocumentRef !== undefined,
    });
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
  readonly root?: FilesystemOpensteerWorkspace;
  readonly namespace?: string;
  readonly policy?: OpensteerPolicy;
}): DomRuntime {
  return new DefaultDomRuntime(options);
}

function sameSnapshotNode(
  left: DomSnapshotNode | null | undefined,
  right: DomSnapshotNode | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  if (left.nodeRef !== undefined && right.nodeRef !== undefined) {
    return left.nodeRef === right.nodeRef;
  }
  return left.snapshotNodeId === right.snapshotNodeId;
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

function hasNodeRef(
  node: DomSnapshotNode,
): node is DomSnapshotNode & { readonly nodeRef: NodeRef } {
  return node.nodeRef !== undefined;
}
