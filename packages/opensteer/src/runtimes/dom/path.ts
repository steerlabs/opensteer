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
  findNodeByNodeRef,
  findNodeBySnapshotNodeId,
  querySelectorAllInScope,
  querySelectorAllWithinNode,
  type DomQueryScope,
  type DomSnapshotIndex,
} from "./selectors.js";
import type { ElementPath, MatchClause, PathNode, PathNodePosition } from "./types.js";

const MAX_ATTRIBUTE_VALUE_LENGTH = 300;

interface ResolveMatch {
  readonly node: DomSnapshotNode;
  readonly selector: string;
  readonly mode: "unique" | "fallback";
  readonly count: number;
}

interface CandidateDiagnostic {
  readonly selector: string;
  readonly count: number;
}

export function cloneElementPath(path: ElementPath): ElementPath {
  return {
    context: path.context.map((hop) => ({
      kind: hop.kind,
      host: hop.host.map(clonePathNode),
    })),
    nodes: path.nodes.map(clonePathNode),
  };
}

export function buildPathSelectorHint(path: ElementPath): string {
  const nodes = path?.nodes || [];
  const last = nodes[nodes.length - 1];
  if (!last) {
    return "*";
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

export function sanitizeElementPath(path: ElementPath): ElementPath {
  const cleanNodes = (nodes: unknown[]): PathNode[] =>
    (Array.isArray(nodes) ? nodes : []).map((raw) => normalizePathNode(raw as Record<string, unknown>));

  const context = (Array.isArray(path?.context) ? path.context : [])
    .filter((hop) => hop && (hop.kind === "iframe" || hop.kind === "shadow"))
    .map((hop) => ({
      kind: hop.kind,
      host: cleanNodes((hop as { readonly host?: unknown[] }).host || []),
    }));

  return {
    context,
    nodes: cleanNodes((path?.nodes || []) as unknown[]),
  };
}

export function buildLocalElementPath(index: DomSnapshotIndex, rawTargetNode: DomSnapshotNode): ElementPath {
  const targetNode = requireElementNode(index, rawTargetNode);
  const nodes = finalizeScopedDomPath(index, targetNode);
  const shadowHostNodeRef = targetNode.shadowHostNodeRef;
  if (shadowHostNodeRef === undefined) {
    return sanitizeElementPath({
      context: [],
      nodes,
    });
  }

  const hostNode = findNodeByNodeRef(index, shadowHostNodeRef);
  if (!hostNode) {
    throw new Error(`shadow host ${shadowHostNodeRef} is missing from snapshot ${index.snapshot.documentRef}`);
  }

  const hostPath = buildLocalElementPath(index, hostNode);
  return sanitizeElementPath({
    context: [...hostPath.context, { kind: "shadow", host: cloneElementPath(hostPath).nodes }],
    nodes,
  });
}

export function resolveDomPathInScope(
  index: DomSnapshotIndex,
  domPath: ElementPath["nodes"],
  scope: DomQueryScope,
): ResolveMatch | null {
  const candidates = buildPathCandidates(domPath);
  if (!candidates.length) {
    return null;
  }

  let fallback: ResolveMatch | null = null;
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
    if (matches.length > 1 && fallback === null) {
      fallback = {
        node: matches[0]!,
        selector,
        mode: "fallback",
        count: matches.length,
      };
    }
  }

  return fallback;
}

export function queryAllDomPathInScope(
  index: DomSnapshotIndex,
  domPath: ElementPath["nodes"],
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
  domPath: ElementPath["nodes"],
  scope: DomQueryScope,
): CandidateDiagnostic[] {
  return buildPathCandidates(domPath).map((selector) => ({
    selector,
    count: querySelectorAllInScope(index, selector, scope).length,
  }));
}

export function buildTargetNotFoundMessage(
  domPath: ElementPath["nodes"],
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

export function buildArrayFieldCandidates(path: ElementPath): string[] {
  return buildArrayFieldPathCandidates(path);
}

export function throwTargetNotFound(
  index: DomSnapshotIndex,
  domPath: ElementPath["nodes"],
  scope: DomQueryScope,
): never {
  throw new ElementPathError(
    "ERR_PATH_TARGET_NOT_FOUND",
    buildTargetNotFoundMessage(domPath, collectCandidateDiagnostics(index, domPath, scope)),
  );
}

function normalizePathNode(raw: Record<string, unknown>): PathNode {
  const tag = String(raw?.tag || "*").toLowerCase();
  const attrsIn =
    raw?.attrs && typeof raw.attrs === "object"
      ? (raw.attrs as Record<string, unknown>)
      : {};
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
        const op =
          record.op === "startsWith" || record.op === "contains" ? record.op : "exact";
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

function requireElementNode(index: DomSnapshotIndex, rawTargetNode: DomSnapshotNode): DomSnapshotNode {
  const normalized = rawTargetNode.nodeType === 1 ? rawTargetNode : normalizeNonElementTarget(index, rawTargetNode);
  if (!normalized) {
    throw new Error(`target node ${String(rawTargetNode.snapshotNodeId)} is not attached to an element`);
  }
  return normalized;
}

function normalizeNonElementTarget(
  index: DomSnapshotIndex,
  rawTargetNode: DomSnapshotNode,
): DomSnapshotNode | undefined {
  let current: DomSnapshotNode | undefined = rawTargetNode;
  while (current) {
    if (current.nodeType === 1) {
      return current;
    }
    current =
      current.parentSnapshotNodeId === undefined
        ? undefined
        : findNodeBySnapshotNodeId(index, current.parentSnapshotNodeId);
  }
  return undefined;
}

function finalizeScopedDomPath(index: DomSnapshotIndex, targetNode: DomSnapshotNode): PathNode[] {
  const scopeHostNodeRef = targetNode.shadowHostNodeRef;
  const chain = buildScopedElementChain(index, targetNode, scopeHostNodeRef);
  if (!chain.length) {
    throw new Error(`target node ${String(targetNode.snapshotNodeId)} has no scoped ancestor chain`);
  }

  const nodes: Array<{
    tag: string;
    attrs: Record<string, string>;
    position: PathNodePosition;
    match: MatchClause[];
  }> = chain.map((element) => ({
    tag: element.nodeName.toLowerCase(),
    attrs: collectAttrs(element),
    position: toPosition(index, element, scopeHostNodeRef),
    match: [],
  }));

  const pools = nodes.map((node) => {
    const cloned = [...buildLocalClausePool(node)];
    node.match = [];
    return cloned;
  });

  for (let indexOfNode = 0; indexOfNode < pools.length; indexOfNode += 1) {
    const pool = pools[indexOfNode]!;
    const classIndex = pool.findIndex(
      (clause) => clause.kind === "attr" && clause.key === "class",
    );
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

    if (current.shadowHostNodeRef !== scopeHostNodeRef) {
      break;
    }

    chain.push(current);
    const parent =
      current.parentSnapshotNodeId === undefined
        ? undefined
        : findNodeBySnapshotNodeId(index, current.parentSnapshotNodeId);
    if (!parent || parent.nodeType !== 1 || parent.shadowHostNodeRef !== scopeHostNodeRef) {
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
  if (parent && parent.nodeType === 1 && parent.shadowHostNodeRef === scopeHostNodeRef) {
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
        !!child && child.nodeType === 1 && child.shadowHostNodeRef === scopeHostNodeRef,
    )
    .sort((left, right) => left.snapshotNodeId - right.snapshotNodeId);
}

export { DEFERRED_MATCH_ATTR_KEYS, MATCH_ATTRIBUTE_PRIORITY, STABLE_PRIMARY_ATTR_KEYS };
