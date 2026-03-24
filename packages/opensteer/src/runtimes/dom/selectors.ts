import type { DomSnapshot, DomSnapshotNode, NodeRef } from "@opensteer/browser-core";
import { selectAll } from "css-select";

export interface DomSnapshotIndex {
  readonly snapshot: DomSnapshot;
  readonly rootNode: DomSnapshotNode;
  readonly nodesBySnapshotNodeId: ReadonlyMap<number, DomSnapshotNode>;
  readonly nodesByNodeRef: ReadonlyMap<NodeRef, DomSnapshotNode>;
}

export interface DomQueryScope {
  readonly shadowHostNodeRef?: NodeRef;
  readonly pierceOpenShadow: boolean;
}

interface SelectorRootNode {
  readonly kind: "root";
  children: SelectorNode[];
}

interface SelectorElementNode {
  readonly kind: "element";
  readonly source: DomSnapshotNode;
  readonly parent: SelectorNode;
  children: SelectorNode[];
}

type SelectorNode = SelectorRootNode | SelectorElementNode;

const selectorAdapter = {
  isTag(node: SelectorNode): node is SelectorElementNode {
    return node.kind === "element" && node.source.nodeType === 1;
  },
  getAttributeValue(element: SelectorElementNode, name: string): string | undefined {
    const normalizedName = name.toLowerCase();
    return element.source.attributes.find(
      (attribute) => attribute.name.toLowerCase() === normalizedName,
    )?.value;
  },
  getChildren(node: SelectorNode): SelectorNode[] {
    return node.children;
  },
  getName(element: SelectorElementNode): string {
    return element.source.nodeName.toLowerCase();
  },
  getParent(node: SelectorElementNode): SelectorNode | null {
    return node.parent;
  },
  getSiblings(node: SelectorNode): SelectorNode[] {
    return node.kind === "root" ? [node] : node.parent.children;
  },
  prevElementSibling(node: SelectorNode): SelectorElementNode | null {
    if (node.kind === "root") {
      return null;
    }
    const siblings = node.parent.children;
    const index = siblings.indexOf(node);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const sibling = siblings[cursor];
      if (sibling?.kind === "element" && sibling.source.nodeType === 1) {
        return sibling;
      }
    }
    return null;
  },
  getText(node: SelectorNode): string {
    if (node.kind === "root") {
      return node.children.map((child) => selectorAdapter.getText(child)).join("");
    }
    if (node.source.textContent !== undefined) {
      return node.source.textContent;
    }
    return node.children.map((child) => selectorAdapter.getText(child)).join("");
  },
  hasAttrib(element: SelectorElementNode, name: string): boolean {
    const normalizedName = name.toLowerCase();
    return element.source.attributes.some(
      (attribute) => attribute.name.toLowerCase() === normalizedName,
    );
  },
  removeSubsets(nodes: SelectorNode[]): SelectorNode[] {
    const unique = Array.from(new Set<SelectorNode>(nodes));
    const uniqueSet = new Set(unique);
    return unique.filter((node) => {
      let current = node.kind === "element" ? node.parent : null;
      while (current) {
        if (uniqueSet.has(current)) {
          return false;
        }
        current = current.kind === "element" ? current.parent : null;
      }
      return true;
    });
  },
  equals(left: SelectorNode, right: SelectorNode): boolean {
    return left === right;
  },
};

export function createDomSnapshotIndex(snapshot: DomSnapshot): DomSnapshotIndex {
  const nodesBySnapshotNodeId = new Map<number, DomSnapshotNode>();
  const nodesByNodeRef = new Map<NodeRef, DomSnapshotNode>();
  for (const node of snapshot.nodes) {
    nodesBySnapshotNodeId.set(node.snapshotNodeId, node);
    if (node.nodeRef !== undefined) {
      nodesByNodeRef.set(node.nodeRef, node);
    }
  }

  const rootNode = nodesBySnapshotNodeId.get(snapshot.rootSnapshotNodeId);
  if (!rootNode) {
    throw new Error(
      `snapshot ${snapshot.documentRef} is missing root node ${String(snapshot.rootSnapshotNodeId)}`,
    );
  }

  return {
    snapshot,
    rootNode,
    nodesBySnapshotNodeId,
    nodesByNodeRef,
  };
}

export function findNodeBySnapshotNodeId(
  index: DomSnapshotIndex,
  snapshotNodeId: number,
): DomSnapshotNode | undefined {
  return index.nodesBySnapshotNodeId.get(snapshotNodeId);
}

export function findNodeByNodeRef(
  index: DomSnapshotIndex,
  nodeRef: NodeRef,
): DomSnapshotNode | undefined {
  return index.nodesByNodeRef.get(nodeRef);
}

export function normalizeToElementNode(
  index: DomSnapshotIndex,
  node: DomSnapshotNode,
): DomSnapshotNode | undefined {
  let current: DomSnapshotNode | undefined = node;
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

export function findIframeHostNode(
  index: DomSnapshotIndex,
  contentDocumentRef: string,
): DomSnapshotNode | undefined {
  return index.snapshot.nodes.find(
    (node) => node.nodeType === 1 && node.contentDocumentRef === contentDocumentRef,
  );
}

export function hasShadowRoot(index: DomSnapshotIndex, hostNode: DomSnapshotNode): boolean {
  const hostRef = hostNode.nodeRef;
  if (hostRef === undefined) {
    return false;
  }
  return index.snapshot.nodes.some(
    (node) => findContainingShadowHostNode(index, node)?.nodeRef === hostRef,
  );
}

export function findContainingShadowHostNode(
  index: DomSnapshotIndex,
  node: DomSnapshotNode,
): DomSnapshotNode | undefined {
  if (node.shadowHostNodeRef !== undefined) {
    return findNodeByNodeRef(index, node.shadowHostNodeRef);
  }

  if (node.shadowRootType === undefined) {
    return undefined;
  }

  let current =
    node.parentSnapshotNodeId === undefined
      ? undefined
      : findNodeBySnapshotNodeId(index, node.parentSnapshotNodeId);
  while (current) {
    if (current.shadowRootType === undefined) {
      return normalizeToElementNode(index, current);
    }
    current =
      current.parentSnapshotNodeId === undefined
        ? undefined
        : findNodeBySnapshotNodeId(index, current.parentSnapshotNodeId);
  }

  return undefined;
}

export function isSameNodeOrDescendant(
  index: DomSnapshotIndex,
  nodeRef: NodeRef,
  ancestorNodeRef: NodeRef,
): boolean {
  if (nodeRef === ancestorNodeRef) {
    return true;
  }

  const start = findNodeByNodeRef(index, nodeRef);
  if (!start) {
    return false;
  }

  const stack: DomSnapshotNode[] = [start];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.nodeRef === ancestorNodeRef) {
      return true;
    }
    if (visited.has(current.snapshotNodeId)) {
      continue;
    }
    visited.add(current.snapshotNodeId);

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

  return false;
}

export function querySelectorAllInScope(
  index: DomSnapshotIndex,
  selector: string,
  scope: DomQueryScope,
): DomSnapshotNode[] {
  const root = buildScopeRoot(index, scope);
  const matches = selectAll<SelectorNode, SelectorElementNode>(selector, root, {
    adapter: selectorAdapter,
    cacheResults: false,
  });
  return matches.map((match) => match.source);
}

export function querySelectorAllWithinNode(
  index: DomSnapshotIndex,
  rootNode: DomSnapshotNode,
  selector: string,
  scope: DomQueryScope,
): DomSnapshotNode[] {
  const rootShadowHostNodeRef = findContainingShadowHostNode(index, rootNode)?.nodeRef;
  const wrapper = buildElementWrapper(index, rootNode, {
    pierceOpenShadow: scope.pierceOpenShadow,
    ...(rootShadowHostNodeRef === undefined
      ? {}
      : { currentShadowHostNodeRef: rootShadowHostNodeRef }),
  });
  const matches = selectAll<SelectorNode, SelectorElementNode>(selector, wrapper, {
    adapter: selectorAdapter,
    cacheResults: false,
  });
  return matches.map((match) => match.source);
}

function buildScopeRoot(index: DomSnapshotIndex, scope: DomQueryScope): SelectorRootNode {
  const root: SelectorRootNode = {
    kind: "root",
    children: [],
  };
  const childSources = collectScopeEntryNodes(index, scope.shadowHostNodeRef);
  root.children = childSources.map((child) =>
    buildElementWrapper(index, child, {
      pierceOpenShadow: scope.pierceOpenShadow,
      parent: root,
      ...(scope.shadowHostNodeRef === undefined
        ? {}
        : { currentShadowHostNodeRef: scope.shadowHostNodeRef }),
    }),
  );
  return root;
}

function buildElementWrapper(
  index: DomSnapshotIndex,
  source: DomSnapshotNode,
  options: {
    readonly currentShadowHostNodeRef?: NodeRef;
    readonly pierceOpenShadow: boolean;
    readonly parent?: SelectorNode;
  },
): SelectorElementNode {
  const parent = options.parent ?? createSelectorRootNode();

  const wrapper: SelectorElementNode = {
    kind: "element",
    source,
    parent,
    children: [],
  };

  const childSources = collectChildNodes(
    index,
    source,
    options.currentShadowHostNodeRef,
    options.pierceOpenShadow,
  );
  wrapper.children = childSources.map((child) => {
    const currentShadowHostNodeRef = resolveCurrentShadowHostNodeRef(
      index,
      child,
      options.currentShadowHostNodeRef,
    );

    if (currentShadowHostNodeRef === undefined) {
      return buildElementWrapper(index, child, {
        pierceOpenShadow: options.pierceOpenShadow,
        parent: wrapper,
      });
    }

    return buildElementWrapper(index, child, {
      pierceOpenShadow: options.pierceOpenShadow,
      parent: wrapper,
      currentShadowHostNodeRef,
    });
  });

  return wrapper;
}

function createSelectorRootNode(): SelectorRootNode {
  return {
    kind: "root",
    children: [],
  };
}

function collectScopeEntryNodes(
  index: DomSnapshotIndex,
  shadowHostNodeRef: NodeRef | undefined,
): DomSnapshotNode[] {
  if (shadowHostNodeRef === undefined) {
    return collectDirectChildren(index, index.rootNode, shadowHostNodeRef);
  }

  const hostNode = findNodeByNodeRef(index, shadowHostNodeRef);
  if (!hostNode) {
    return [];
  }

  return collectDirectChildren(index, hostNode, shadowHostNodeRef);
}

function collectChildNodes(
  index: DomSnapshotIndex,
  source: DomSnapshotNode,
  currentShadowHostNodeRef: NodeRef | undefined,
  pierceOpenShadow: boolean,
): DomSnapshotNode[] {
  const children = collectDirectChildren(index, source, currentShadowHostNodeRef);
  if (!pierceOpenShadow || source.nodeRef === undefined) {
    return children;
  }

  const openShadowChildren = source.childSnapshotNodeIds
    .map((snapshotNodeId) => findNodeBySnapshotNodeId(index, snapshotNodeId))
    .filter((node): node is DomSnapshotNode => {
      if (!node || node.nodeType !== 1) {
        return false;
      }
      return (
        node.shadowRootType === "open" &&
        findContainingShadowHostNode(index, node)?.nodeRef === source.nodeRef
      );
    });

  return sortNodes([...children, ...openShadowChildren]);
}

function collectDirectChildren(
  index: DomSnapshotIndex,
  source: DomSnapshotNode,
  expectedShadowHostNodeRef: NodeRef | undefined,
): DomSnapshotNode[] {
  return sortNodes(
    source.childSnapshotNodeIds
      .map((snapshotNodeId) => findNodeBySnapshotNodeId(index, snapshotNodeId))
      .filter(
        (node): node is DomSnapshotNode =>
          !!node &&
          node.nodeType === 1 &&
          findContainingShadowHostNode(index, node)?.nodeRef === expectedShadowHostNodeRef,
      ),
  );
}

function resolveCurrentShadowHostNodeRef(
  index: DomSnapshotIndex,
  node: DomSnapshotNode,
  fallback: NodeRef | undefined,
): NodeRef | undefined {
  const shadowHostNodeRef = findContainingShadowHostNode(index, node)?.nodeRef;
  return shadowHostNodeRef ?? fallback;
}

function sortNodes(nodes: readonly DomSnapshotNode[]): DomSnapshotNode[] {
  return [...nodes].sort((left, right) => left.snapshotNodeId - right.snapshotNodeId);
}
