import type { DomSnapshot, DomSnapshotNode, NodeRef } from "@opensteer/browser-core";

import { ElementPathError } from "./errors.js";
import { buildArrayFieldPathCandidates } from "./extraction.js";
import { buildPathCandidates, buildSegmentSelector } from "./match-selectors.js";
import {
  DEFERRED_MATCH_ATTR_KEYS,
  MATCH_ATTRIBUTE_PRIORITY,
  STABLE_PRIMARY_ATTR_KEYS,
  buildLocalClausePool,
  isValidCssAttributeKey,
  shouldKeepAttributeForPath,
} from "./match-policy.js";
import {
  createDomSnapshotIndex,
  findContainingShadowHostNode,
  findNodeByNodeRef,
  findNodeBySnapshotNodeId,
  querySelectorAllInScope,
  querySelectorAllWithinNode,
  type DomQueryScope,
  type DomSnapshotIndex,
} from "./selectors.js";
import type {
  MatchClause,
  PathNode,
  PathNodePosition,
  ReplayElementPath,
  StructuralElementAnchor,
} from "./types.js";

const MAX_ATTRIBUTE_VALUE_LENGTH = 300;

interface ResolveMatch {
  readonly node: DomSnapshotNode;
  readonly selector: string;
  readonly mode: "unique" | "ambiguous";
  readonly count: number;
}

interface CandidateDiagnostic {
  readonly selector: string;
  readonly count: number;
}

export function cloneStructuralElementAnchor(
  anchor: StructuralElementAnchor,
): StructuralElementAnchor {
  return {
    resolution: "structural",
    context: cloneContext(anchor.context),
    nodes: anchor.nodes.map(clonePathNode),
  };
}

export function cloneReplayElementPath(path: ReplayElementPath): ReplayElementPath {
  return {
    resolution: "deterministic",
    context: cloneContext(path.context),
    nodes: path.nodes.map(clonePathNode),
  };
}

export function cloneElementPath(path: ReplayElementPath): ReplayElementPath {
  return cloneReplayElementPath(path);
}

export function buildPathSelectorHint(path: { readonly nodes: readonly PathNode[] } | null | undefined): string {
  const nodes = path?.nodes || [];
  const last = nodes[nodes.length - 1];
  if (!last) {
    return "*";
  }
  const tag = String(last.tag || "*").toLowerCase();
  const id = last.attrs?.id?.trim();
  if (id) {
    return `${tag}#${sanitizeHintToken(id)}`;
  }

  const testId = firstDefinedAttribute(last, ["data-testid", "data-test", "data-qa", "data-cy"]);
  if (testId) {
    return `${tag}[data-testid="${sanitizeHintToken(testId)}"]`;
  }

  const name = last.attrs?.name?.trim();
  if (name) {
    return `${tag}[name="${sanitizeHintToken(name)}"]`;
  }

  const role = last.attrs?.role?.trim();
  if (role) {
    return `${tag}[role="${sanitizeHintToken(role)}"]`;
  }

  const classToken = last.attrs?.class
    ?.split(/\s+/)
    .map((token) => token.trim())
    .find((token) => token.length > 0);
  if (classToken) {
    return `${tag}.${sanitizeHintToken(classToken)}`;
  }

  return buildSegmentSelector(last);
}

export function createPathScope(shadowHostNodeRef?: NodeRef): DomQueryScope {
  return {
    ...(shadowHostNodeRef === undefined ? {} : { shadowHostNodeRef }),
    pierceOpenShadow: false,
  };
}

export function createExplicitSelectorScope(): DomQueryScope {
  return {
    pierceOpenShadow: true,
  };
}

export function createSnapshotIndex(snapshot: DomSnapshot) {
  return createDomSnapshotIndex(snapshot);
}

export function sanitizeStructuralElementAnchor(
  anchor: StructuralElementAnchor,
): StructuralElementAnchor {
  return {
    resolution: "structural",
    context: sanitizeContext(anchor.context),
    nodes: sanitizeNodes(anchor.nodes),
  };
}

export function sanitizeReplayElementPath(path: ReplayElementPath): ReplayElementPath {
  return {
    resolution: "deterministic",
    context: sanitizeContext(path.context),
    nodes: sanitizeNodes(path.nodes),
  };
}

export function sanitizeElementPath(path: ReplayElementPath): ReplayElementPath {
  return sanitizeReplayElementPath(path);
}

export function buildLocalStructuralElementAnchor(
  index: DomSnapshotIndex,
  rawTargetNode: DomSnapshotNode,
): StructuralElementAnchor {
  const targetNode = requireElementNode(index, rawTargetNode);
  const nodes = captureScopedStructuralNodes(index, targetNode);
  const shadowHost = findContainingShadowHostNode(index, targetNode);
  if (!shadowHost) {
    return sanitizeStructuralElementAnchor({
      resolution: "structural",
      context: [],
      nodes,
    });
  }

  const hostAnchor = buildLocalStructuralElementAnchor(index, shadowHost);
  return sanitizeStructuralElementAnchor({
    resolution: "structural",
    context: [
      ...hostAnchor.context,
      { kind: "shadow", host: cloneStructuralElementAnchor(hostAnchor).nodes },
    ],
    nodes,
  });
}

export function buildLocalReplayElementPath(
  index: DomSnapshotIndex,
  rawTargetNode: DomSnapshotNode,
): ReplayElementPath {
  const targetNode = requireElementNode(index, rawTargetNode);
  const localAnchor = captureLocalScopedStructuralAnchor(index, targetNode);
  const nodes = finalizeScopedReplayNodes(index, targetNode, localAnchor.nodes);
  const shadowHost = findContainingShadowHostNode(index, targetNode);
  if (!shadowHost) {
    return sanitizeReplayElementPath({
      resolution: "deterministic",
      context: [],
      nodes,
    });
  }

  const hostPath = buildLocalReplayElementPath(index, shadowHost);
  return sanitizeReplayElementPath({
    resolution: "deterministic",
    context: [...hostPath.context, { kind: "shadow", host: cloneReplayElementPath(hostPath).nodes }],
    nodes,
  });
}

export function resolveDomPathInScope(
  index: DomSnapshotIndex,
  domPath: ReplayElementPath["nodes"],
  scope: DomQueryScope,
): ResolveMatch | null {
  const candidates = buildPathCandidates(domPath);
  if (!candidates.length) {
    return null;
  }

  let ambiguous: ResolveMatch | null = null;
  for (const selector of candidates) {
    const matches = querySelectorAllInScope(index, selector, scope);
    if (matches.length === 1) {
      return {
        node: matches[0]!,
        selector,
        mode: "unique",
        count: 1,
      };
    }
    if (matches.length > 1 && ambiguous === null) {
      ambiguous = {
        node: matches[0]!,
        selector,
        mode: "ambiguous",
        count: matches.length,
      };
    }
  }

  return ambiguous;
}

export function queryAllDomPathInScope(
  index: DomSnapshotIndex,
  domPath: ReplayElementPath["nodes"],
  scope: DomQueryScope,
): DomSnapshotNode[] {
  const selectors = buildPathCandidates(domPath);
  for (const selector of selectors) {
    const matches = querySelectorAllInScope(index, selector, scope);
    if (matches.length > 0) {
      return matches;
    }
  }
  return [];
}

export function resolveFirstWithinNodeBySelectors(
  index: DomSnapshotIndex,
  rootNode: DomSnapshotNode,
  selectors: readonly string[],
): DomSnapshotNode | null {
  if (!selectors.length) {
    return null;
  }

  let fallback: DomSnapshotNode | null = null;
  for (const selector of selectors) {
    const matches = querySelectorAllWithinNode(index, rootNode, selector, createPathScope());
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length > 1 && fallback === null) {
      fallback = matches[0]!;
    }
  }

  return fallback;
}

export function collectCandidateDiagnostics(
  index: DomSnapshotIndex,
  domPath: ReplayElementPath["nodes"],
  scope: DomQueryScope,
): CandidateDiagnostic[] {
  return buildPathCandidates(domPath).map((selector) => ({
    selector,
    count: querySelectorAllInScope(index, selector, scope).length,
  }));
}

export function resolveStructuralAnchorInScope(
  index: DomSnapshotIndex,
  anchorNodes: StructuralElementAnchor["nodes"],
  scope: DomQueryScope,
): ResolveMatch | null {
  const matches = queryAllStructuralAnchorInScope(index, anchorNodes, scope);
  if (matches.length === 0) {
    return null;
  }

  return {
    node: matches[0]!,
    selector: buildPathSelectorHint({ nodes: anchorNodes }),
    mode: matches.length === 1 ? "unique" : "ambiguous",
    count: matches.length,
  };
}

export function queryAllStructuralAnchorInScope(
  index: DomSnapshotIndex,
  anchorNodes: StructuralElementAnchor["nodes"],
  scope: DomQueryScope,
): DomSnapshotNode[] {
  if (!anchorNodes.length) {
    return [];
  }

  const scopeHostNodeRef = scope.shadowHostNodeRef;
  const scopeRoot =
    scopeHostNodeRef === undefined ? index.rootNode : findNodeByNodeRef(index, scopeHostNodeRef);
  if (!scopeRoot) {
    return [];
  }

  let matches = collectChildrenInScope(index, scopeRoot, scopeHostNodeRef).filter((node) =>
    matchesStructuralAnchorNode(index, node, anchorNodes[0]!, scopeHostNodeRef),
  );
  for (let depth = 1; depth < anchorNodes.length && matches.length > 0; depth += 1) {
    const nextAnchorNode = anchorNodes[depth]!;
    matches = matches.flatMap((parent) =>
      collectChildrenInScope(index, parent, scopeHostNodeRef).filter((child) =>
        matchesStructuralAnchorNode(index, child, nextAnchorNode, scopeHostNodeRef),
      ),
    );
  }

  return matches;
}

export function buildTargetNotFoundMessage(
  domPath: ReplayElementPath["nodes"],
  diagnostics: readonly CandidateDiagnostic[],
): string {
  const depth = Array.isArray(domPath) ? domPath.length : 0;
  const sample = diagnostics
    .slice(0, 4)
    .map((item) => `"${item.selector}" => ${String(item.count)}`)
    .join(", ");
  const base =
    "Element path resolution failed (ERR_PATH_TARGET_NOT_FOUND): no selector candidate matched the current DOM.";
  if (!sample) {
    return `${base} Tried ${String(Math.max(diagnostics.length, 0))} candidates.`;
  }
  return `${base} Target depth ${String(depth)}. Candidate counts: ${sample}.`;
}

export function buildTargetNotUniqueMessage(
  domPath: ReplayElementPath["nodes"],
  diagnostics: readonly CandidateDiagnostic[],
): string {
  const depth = Array.isArray(domPath) ? domPath.length : 0;
  const ambiguous = diagnostics
    .filter((item) => item.count > 1)
    .slice(0, 4)
    .map((item) => `"${item.selector}" => ${String(item.count)}`)
    .join(", ");
  const base =
    "Element path resolution failed (ERR_PATH_TARGET_NOT_UNIQUE): selector candidates matched multiple elements.";
  if (!ambiguous) {
    return `${base} Target depth ${String(depth)}.`;
  }
  return `${base} Target depth ${String(depth)}. Candidate counts: ${ambiguous}.`;
}

export function buildContextHostNotUniqueMessage(
  domPath: ReplayElementPath["nodes"],
  diagnostics: readonly CandidateDiagnostic[],
): string {
  const depth = Array.isArray(domPath) ? domPath.length : 0;
  const sample = diagnostics
    .filter((item) => item.count > 1)
    .slice(0, 4)
    .map((item) => `"${item.selector}" => ${String(item.count)}`)
    .join(", ");
  const base =
    "Context host resolution failed (ERR_PATH_CONTEXT_HOST_NOT_UNIQUE): stored selectors matched multiple context hosts.";
  if (!sample) {
    return `${base} Host depth ${String(depth)}.`;
  }
  return `${base} Host depth ${String(depth)}. Candidate counts: ${sample}.`;
}

export function buildArrayFieldCandidates(path: ReplayElementPath): string[] {
  return buildArrayFieldPathCandidates(path);
}

function firstDefinedAttribute(node: PathNode, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = node.attrs?.[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function cloneContext(
  context: readonly StructuralElementAnchor["context"][number][],
): StructuralElementAnchor["context"] {
  return context.map((hop) => ({
    kind: hop.kind,
    host: hop.host.map(clonePathNode),
  }));
}

function sanitizeContext(
  context: unknown,
): StructuralElementAnchor["context"] {
  const hops = Array.isArray(context) ? context : [];
  return hops
    .filter((hop): hop is { readonly kind: "iframe" | "shadow"; readonly host?: unknown[] } =>
      !!hop && (hop.kind === "iframe" || hop.kind === "shadow"),
    )
    .map((hop) => ({
      kind: hop.kind,
      host: sanitizeNodes(hop.host),
    }));
}

function sanitizeNodes(nodes: unknown): PathNode[] {
  return (Array.isArray(nodes) ? nodes : []).map((raw) =>
    normalizePathNode(raw as Record<string, unknown>),
  );
}

function sanitizeHintToken(value: string): string {
  return value.replace(/"/g, '\\"').trim();
}

export function throwTargetNotFound(
  index: DomSnapshotIndex,
  domPath: ReplayElementPath["nodes"],
  scope: DomQueryScope,
): never {
  throw new ElementPathError(
    "ERR_PATH_TARGET_NOT_FOUND",
    buildTargetNotFoundMessage(domPath, collectCandidateDiagnostics(index, domPath, scope)),
  );
}

export function throwTargetNotUnique(
  index: DomSnapshotIndex,
  domPath: ReplayElementPath["nodes"],
  scope: DomQueryScope,
): never {
  throw new ElementPathError(
    "ERR_PATH_TARGET_NOT_UNIQUE",
    buildTargetNotUniqueMessage(domPath, collectCandidateDiagnostics(index, domPath, scope)),
  );
}

export function throwContextHostNotUnique(
  index: DomSnapshotIndex,
  domPath: ReplayElementPath["nodes"],
  scope: DomQueryScope,
): never {
  throw new ElementPathError(
    "ERR_PATH_CONTEXT_HOST_NOT_UNIQUE",
    buildContextHostNotUniqueMessage(domPath, collectCandidateDiagnostics(index, domPath, scope)),
  );
}

function normalizePathNode(raw: Record<string, unknown>): PathNode {
  const tag = String(raw?.tag || "*").toLowerCase();
  const attrsIn =
    raw?.attrs && typeof raw.attrs === "object" ? (raw.attrs as Record<string, unknown>) : {};
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrsIn)) {
    const normalizedKey = String(key);
    const normalizedValue = String(value ?? "");
    if (!normalizedValue.trim()) {
      continue;
    }
    if (normalizedValue.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      continue;
    }
    if (!shouldKeepAttributeForPath(normalizedKey, normalizedValue, { tag })) {
      continue;
    }
    attrs[normalizedKey] = normalizedValue;
  }

  const positionRaw =
    raw?.position && typeof raw.position === "object"
      ? (raw.position as Record<string, unknown>)
      : {};

  const position: PathNodePosition = {
    nthChild: Math.max(1, Number(positionRaw.nthChild || 1)),
    nthOfType: Math.max(1, Number(positionRaw.nthOfType || 1)),
  };

  return {
    tag,
    attrs,
    position,
    match: normalizeMatch(raw?.match, attrs, position, tag),
  };
}

function clonePathNode(node: PathNode): PathNode {
  return {
    tag: node.tag,
    attrs: { ...node.attrs },
    position: {
      nthChild: node.position.nthChild,
      nthOfType: node.position.nthOfType,
    },
    match: node.match.map(cloneMatchClause),
  };
}

function cloneMatchClause(clause: MatchClause): MatchClause {
  return clause.kind === "position"
    ? { kind: "position", axis: clause.axis }
    : {
        kind: "attr",
        key: clause.key,
        ...(clause.op === undefined ? {} : { op: clause.op }),
        ...(clause.value === undefined ? {} : { value: clause.value }),
      };
}

function normalizeMatch(
  rawMatch: unknown,
  attrs: Record<string, string>,
  position: PathNodePosition,
  tag: string,
): MatchClause[] {
  const out: MatchClause[] = [];
  const seen = new Set<string>();
  const hasExplicitMatchArray = Array.isArray(rawMatch);
  let normalizedLegacyClassClause = false;

  const push = (clause: MatchClause): void => {
    const key = JSON.stringify(clause);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(clause);
  };

  if (Array.isArray(rawMatch)) {
    for (const clause of rawMatch) {
      if (!clause || typeof clause !== "object") {
        continue;
      }
      const record = clause as Record<string, unknown>;
      if (record.kind === "position") {
        if (record.axis === "nthOfType" || record.axis === "nthChild") {
          push({ kind: "position", axis: record.axis });
        }
        continue;
      }
      if (record.kind === "attr") {
        const key = String(record.key || "").trim();
        if (!isValidCssAttributeKey(key)) {
          continue;
        }
        const op = record.op === "startsWith" || record.op === "contains" ? record.op : "exact";
        const value = typeof record.value === "string" ? record.value : undefined;
        if (key === "class" && op === "exact" && attrs.class && !normalizedLegacyClassClause) {
          push({
            kind: "attr",
            key: "class",
            op: "exact",
            value: attrs.class,
          });
          normalizedLegacyClassClause = true;
          continue;
        }
        push({
          kind: "attr",
          key,
          op,
          ...(value === undefined ? {} : { value }),
        });
      }
    }
  }

  if (!out.length && !hasExplicitMatchArray) {
    const seeded: PathNode = {
      tag,
      attrs,
      position,
      match: [],
    };
    for (const clause of buildLocalClausePool(seeded)) {
      push(clause);
    }
  }

  return out;
}

function requireElementNode(
  index: DomSnapshotIndex,
  rawTargetNode: DomSnapshotNode,
): DomSnapshotNode {
  const normalized =
    rawTargetNode.nodeType === 1 && !isPseudoElementNodeName(rawTargetNode.nodeName)
      ? rawTargetNode
      : normalizeNonElementTarget(index, rawTargetNode);
  if (!normalized) {
    throw new Error(
      `target node ${String(rawTargetNode.snapshotNodeId)} is not attached to an element`,
    );
  }
  return normalized;
}

function normalizeNonElementTarget(
  index: DomSnapshotIndex,
  rawTargetNode: DomSnapshotNode,
): DomSnapshotNode | undefined {
  let current: DomSnapshotNode | undefined = rawTargetNode;
  while (current) {
    if (current.nodeType === 1 && !isPseudoElementNodeName(current.nodeName)) {
      return current;
    }
    current =
      current.parentSnapshotNodeId === undefined
        ? undefined
        : findNodeBySnapshotNodeId(index, current.parentSnapshotNodeId);
  }
  return undefined;
}

function isPseudoElementNodeName(nodeName: string): boolean {
  return String(nodeName || "").startsWith("::");
}

function captureLocalScopedStructuralAnchor(
  index: DomSnapshotIndex,
  targetNode: DomSnapshotNode,
): StructuralElementAnchor {
  return {
    resolution: "structural",
    context: [],
    nodes: captureScopedStructuralNodes(index, targetNode),
  };
}

function captureScopedStructuralNodes(
  index: DomSnapshotIndex,
  targetNode: DomSnapshotNode,
): PathNode[] {
  const scopeHostNodeRef = getShadowScopeNodeRef(index, targetNode);
  const chain = buildScopedElementChain(index, targetNode, scopeHostNodeRef);
  if (!chain.length) {
    throw new Error(
      `target node ${String(targetNode.snapshotNodeId)} has no scoped ancestor chain`,
    );
  }

  return chain.map((element) =>
    normalizePathNode({
      tag: element.nodeName.toLowerCase(),
      attrs: collectAttrs(element),
      position: toPosition(index, element, scopeHostNodeRef),
      match: [],
    }),
  );
}

function finalizeScopedReplayNodes(
  index: DomSnapshotIndex,
  targetNode: DomSnapshotNode,
  structuralNodes: readonly PathNode[],
): PathNode[] {
  const scopeHostNodeRef = getShadowScopeNodeRef(index, targetNode);
  const chain = buildScopedElementChain(index, targetNode, scopeHostNodeRef);
  if (!chain.length) {
    throw new Error(
      `target node ${String(targetNode.snapshotNodeId)} has no scoped ancestor chain`,
    );
  }

  const nodes: Array<{
    tag: string;
    attrs: Record<string, string>;
    position: PathNodePosition;
    match: MatchClause[];
  }> = structuralNodes.map((node) => ({
    tag: node.tag,
    attrs: { ...node.attrs },
    position: {
      nthChild: node.position.nthChild,
      nthOfType: node.position.nthOfType,
    },
    match: [],
  }));

  const pools = nodes.map((node) => {
    const cloned = [...buildLocalClausePool(node)];
    node.match = [];
    return cloned;
  });

  for (let indexOfNode = 0; indexOfNode < pools.length; indexOfNode += 1) {
    const pool = pools[indexOfNode]!;
    const classIndex = pool.findIndex((clause) => clause.kind === "attr" && clause.key === "class");
    if (classIndex < 0) {
      continue;
    }
    const classClause = pool[classIndex];
    if (!classClause) {
      continue;
    }
    nodes[indexOfNode]!.match = [...nodes[indexOfNode]!.match, classClause];
    pool.splice(classIndex, 1);
  }

  const totalRemaining = pools.reduce((sum, pool) => sum + pool.length, 0);
  const expectedTarget = chain[chain.length - 1]!;
  const scope = createPathScope(scopeHostNodeRef);

  for (let iteration = 0; iteration <= totalRemaining; iteration += 1) {
    const selected = resolveDomPathInScope(index, nodes, scope);
    if (selected && selected.mode === "unique" && selected.node === expectedTarget) {
      return nodes;
    }

    let added = false;
    for (let poolIndex = pools.length - 1; poolIndex >= 0; poolIndex -= 1) {
      const pool = pools[poolIndex]!;
      const nextClause = pool[0];
      if (!nextClause) {
        continue;
      }
      nodes[poolIndex]!.match = [...nodes[poolIndex]!.match, nextClause];
      pool.shift();
      added = true;
      break;
    }
    if (!added) {
      break;
    }
  }

  throw new Error(
    `failed to finalize element path for node ${String(expectedTarget.snapshotNodeId)} in ${index.snapshot.documentRef}`,
  );
}

function matchesStructuralAnchorNode(
  index: DomSnapshotIndex,
  candidate: DomSnapshotNode,
  anchorNode: PathNode,
  scopeHostNodeRef: NodeRef | undefined,
): boolean {
  if (candidate.nodeType !== 1 || getShadowScopeNodeRef(index, candidate) !== scopeHostNodeRef) {
    return false;
  }
  if (candidate.nodeName.toLowerCase() !== anchorNode.tag.toLowerCase()) {
    return false;
  }

  const attrs = collectAttrs(candidate);
  for (const [key, value] of Object.entries(anchorNode.attrs)) {
    if (attrs[key] !== value) {
      return false;
    }
  }

  const position = toPosition(index, candidate, scopeHostNodeRef);
  return (
    position.nthChild === anchorNode.position.nthChild &&
    position.nthOfType === anchorNode.position.nthOfType
  );
}

function buildScopedElementChain(
  index: DomSnapshotIndex,
  targetNode: DomSnapshotNode,
  scopeHostNodeRef: NodeRef | undefined,
): DomSnapshotNode[] {
  const chain: DomSnapshotNode[] = [];
  let current: DomSnapshotNode | undefined = targetNode;

  while (current) {
    if (current.nodeType !== 1) {
      current =
        current.parentSnapshotNodeId === undefined
          ? undefined
          : findNodeBySnapshotNodeId(index, current.parentSnapshotNodeId);
      continue;
    }

    if (getShadowScopeNodeRef(index, current) !== scopeHostNodeRef) {
      break;
    }

    chain.push(current);
    const parent =
      current.parentSnapshotNodeId === undefined
        ? undefined
        : findNodeBySnapshotNodeId(index, current.parentSnapshotNodeId);
    if (
      !parent ||
      parent.nodeType !== 1 ||
      getShadowScopeNodeRef(index, parent) !== scopeHostNodeRef
    ) {
      break;
    }
    current = parent;
  }

  chain.reverse();
  return chain;
}

function collectAttrs(node: DomSnapshotNode): Record<string, string> {
  const tag = node.nodeName.toLowerCase();
  const attrs: Record<string, string> = {};

  for (const attribute of node.attributes) {
    if (!shouldKeepAttributeForPath(attribute.name, attribute.value, { tag })) {
      continue;
    }
    const value = String(attribute.value || "");
    if (!value.trim()) {
      continue;
    }
    if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      continue;
    }
    attrs[attribute.name] = value;
  }

  return attrs;
}

function toPosition(
  index: DomSnapshotIndex,
  node: DomSnapshotNode,
  scopeHostNodeRef: NodeRef | undefined,
): PathNodePosition {
  const siblings = getSiblingsInScope(index, node, scopeHostNodeRef);
  const tag = node.nodeName.toLowerCase();
  const sameTag = siblings.filter((sibling) => sibling.nodeName.toLowerCase() === tag);

  return {
    nthChild: siblings.findIndex((sibling) => sibling.snapshotNodeId === node.snapshotNodeId) + 1,
    nthOfType: sameTag.findIndex((sibling) => sibling.snapshotNodeId === node.snapshotNodeId) + 1,
  };
}

function getSiblingsInScope(
  index: DomSnapshotIndex,
  node: DomSnapshotNode,
  scopeHostNodeRef: NodeRef | undefined,
): DomSnapshotNode[] {
  const parent =
    node.parentSnapshotNodeId === undefined
      ? undefined
      : findNodeBySnapshotNodeId(index, node.parentSnapshotNodeId);
  if (parent && parent.nodeType === 1 && getShadowScopeNodeRef(index, parent) === scopeHostNodeRef) {
    return collectChildrenInScope(index, parent, scopeHostNodeRef);
  }

  if (scopeHostNodeRef === undefined) {
    return collectChildrenInScope(index, index.rootNode, scopeHostNodeRef);
  }

  const hostNode = findNodeByNodeRef(index, scopeHostNodeRef);
  if (!hostNode) {
    return [];
  }
  return collectChildrenInScope(index, hostNode, scopeHostNodeRef);
}

function collectChildrenInScope(
  index: DomSnapshotIndex,
  node: DomSnapshotNode,
  scopeHostNodeRef: NodeRef | undefined,
): DomSnapshotNode[] {
  return node.childSnapshotNodeIds
    .map((snapshotNodeId) => findNodeBySnapshotNodeId(index, snapshotNodeId))
    .filter(
      (child): child is DomSnapshotNode =>
        !!child && child.nodeType === 1 && getShadowScopeNodeRef(index, child) === scopeHostNodeRef,
    )
    .sort((left, right) => left.snapshotNodeId - right.snapshotNodeId);
}

function getShadowScopeNodeRef(
  index: DomSnapshotIndex,
  node: DomSnapshotNode,
): NodeRef | undefined {
  return findContainingShadowHostNode(index, node)?.nodeRef;
}

export { DEFERRED_MATCH_ATTR_KEYS, MATCH_ATTRIBUTE_PRIORITY, STABLE_PRIMARY_ATTR_KEYS };
