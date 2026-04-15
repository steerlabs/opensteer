import {
  type ActionBoundaryOutcome,
  createPoint,
  createBrowserCoreError,
  quadBounds,
  staleNodeRefError,
  type DomSnapshot,
  type DomSnapshotNode,
  type NodeLocator,
  type PageRef,
  type Quad,
  type SessionRef,
  type ViewportMetrics,
} from "@opensteer/browser-core";
import type {
  DomActionBridge,
  DomActionTargetInspection,
  DomPointerHitAssessment,
  ReplayElementPath,
} from "@opensteer/protocol";

import type { DocumentState, PageController, SessionState } from "./types.js";
import { clampAbpActionSettleTimeout, type AbpActionBoundaryOptions } from "./action-settle.js";
import { buildInputActionRequest } from "./rest-client.js";

interface AbpDomActionBridgeContext {
  resolveController(pageRef: PageRef): PageController;
  resolveSession(sessionRef: SessionRef): SessionState;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  settleActionBoundary(
    controller: PageController,
    options: AbpActionBoundaryOptions,
  ): Promise<ActionBoundaryOutcome>;
  syncExecutionPaused(controller: PageController): Promise<boolean>;
  setExecutionPaused(controller: PageController, paused: boolean): Promise<void>;
  isPageClosedError(error: unknown): boolean;
  locateBackendNode(document: DocumentState, backendNodeId: number): NodeLocator;
  requireLiveNode(locator: NodeLocator): {
    readonly document: DocumentState;
    readonly backendNodeId: number;
  };
  getDomSnapshot(documentRef: string): Promise<DomSnapshot>;
  getViewportMetrics(pageRef: PageRef): Promise<ViewportMetrics>;
}

const POINTER_ACTION_HELPERS = String.raw`
  function isElementNode(node) {
    return node != null && node.nodeType === 1;
  }

  function isShadowRoot(node) {
    return node != null && node.nodeType === 11 && "host" in node;
  }

  function isNodeLike(node) {
    return node != null && typeof node.nodeType === "number";
  }

  function parentInComposedTree(node) {
    if (!node) {
      return null;
    }
    const slot = "assignedSlot" in node ? node.assignedSlot : null;
    if (isElementNode(slot)) {
      return slot;
    }
    const parent = node.parentNode;
    if (isShadowRoot(parent)) {
      return parent.host;
    }
    return isElementNode(parent) ? parent : null;
  }

  function closestElementInComposedTree(node) {
    if (!node) {
      return null;
    }
    if (isElementNode(node)) {
      return node;
    }
    let current = parentInComposedTree(node);
    while (current) {
      if (isElementNode(current)) {
        return current;
      }
      current = parentInComposedTree(current);
    }
    return null;
  }

  function hasInteractiveRole(element) {
    const role = element.getAttribute("role");
    return (
      role === "button" ||
      role === "link" ||
      role === "menuitem" ||
      role === "tab" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "switch" ||
      role === "option"
    );
  }

  function isInteractiveElement(element) {
    const tagName = element.localName;
    if (
      tagName === "button" ||
      tagName === "select" ||
      tagName === "textarea" ||
      tagName === "summary"
    ) {
      return true;
    }
    if (tagName === "a") {
      return element.hasAttribute("href");
    }
    if (tagName === "input") {
      return element.getAttribute("type") !== "hidden";
    }
    if (element.isContentEditable || hasInteractiveRole(element)) {
      return true;
    }

    const tabIndex = element.getAttribute("tabindex");
    if (tabIndex !== null && tabIndex !== "-1") {
      return true;
    }

    return typeof element.onclick === "function";
  }

  function findPointerOwner(node) {
    const element = closestElementInComposedTree(node);
    if (!element) {
      return null;
    }

    let current = element;
    while (current) {
      if (current.localName === "label") {
        const control = "control" in current ? current.control : null;
        if (isElementNode(control)) {
          return control;
        }
      }
      if (isInteractiveElement(current)) {
        return current;
      }
      current = parentInComposedTree(current);
    }

    return element;
  }

  function composedContains(container, node) {
    if (!isNodeLike(container) || !isNodeLike(node)) {
      return false;
    }
    let current = node;
    while (current) {
      if (current === container) {
        return true;
      }
      current = parentInComposedTree(current);
    }
    return false;
  }

  function documentRectForElement(element) {
    const ownerWindow = element.ownerDocument?.defaultView;
    if (!ownerWindow) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left + ownerWindow.scrollX,
      top: rect.top + ownerWindow.scrollY,
      right: rect.right + ownerWindow.scrollX,
      bottom: rect.bottom + ownerWindow.scrollY,
    };
  }

  function pointInsideDocumentRect(point, rect) {
    return (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    );
  }

  function isVisiblyBlockingElement(element) {
    const ownerWindow = element.ownerDocument?.defaultView;
    if (!ownerWindow) {
      return false;
    }
    const style = ownerWindow.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
    if (Number.parseFloat(style.opacity || "1") <= 0) {
      return false;
    }
    if (style.pointerEvents === "none") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function describeBlockingElement(element) {
    if (!isElementNode(element)) return null;
    const tag = "<" + element.tagName.toLowerCase() + ">";
    const label = element.getAttribute("aria-label");
    if (label) return tag + ' "' + label.slice(0, 80) + '"';
    const text = (element.textContent || "").trim();
    if (text) return tag + ' "' + text.slice(0, 80) + '"';
    const role = element.getAttribute("role");
    if (role) return tag + " role=" + JSON.stringify(role);
    const id = element.getAttribute("id");
    if (id) return tag + " id=" + JSON.stringify(id);
    return tag;
  }
`;

const RESOLVE_POINTER_OWNER_DECLARATION =
  String.raw`function() {
  ` +
  POINTER_ACTION_HELPERS +
  String.raw`
  return findPointerOwner(this);
}`;

const CLASSIFY_POINTER_HIT_DECLARATION =
  String.raw`function(hitNode, point) {
  ` +
  POINTER_ACTION_HELPERS +
  String.raw`
  const targetElement = closestElementInComposedTree(this);
  const hitElement = closestElementInComposedTree(hitNode);
  if (!targetElement || !hitElement) {
    return {
      relation: "unknown",
      blocking: false,
      ambiguous: true,
    };
  }

  const targetOwner = findPointerOwner(targetElement);
  const hitOwner = findPointerOwner(hitElement);
  let relation = "outside";
  if (targetElement === hitElement) {
    relation = "self";
  } else if (composedContains(targetElement, hitElement)) {
    relation = "descendant";
  } else if (composedContains(hitElement, targetElement)) {
    relation = "ancestor";
  } else if (targetOwner && hitOwner && targetOwner === hitOwner) {
    relation = "same-owner";
  }

  const targetRect = documentRectForElement(targetOwner || targetElement);
  const blockingCandidate = hitOwner || hitElement;
  const blocking =
    relation === "outside" &&
    blockingCandidate &&
    blockingCandidate !== targetOwner &&
    isVisiblyBlockingElement(blockingCandidate);
  const ambiguous =
    relation === "outside" && !blocking && targetRect
      ? pointInsideDocumentRect(point, targetRect)
      : false;

  const blockingDescription = blocking ? describeBlockingElement(blockingCandidate) : null;

  return {
    relation,
    blocking,
    ambiguous,
    ...(blockingDescription ? { blockingDescription } : {}),
  };
}`;

const LIVE_REPLAY_PATH_MATCH_ATTRIBUTE_PRIORITY = {
  stablePrimaryExact: 150,
  stablePrimaryPrefix: 130,
  attrExact: 100,
  attrPrefix: 80,
  tagOnly: 10,
} as const;

const LIVE_REPLAY_PATH_STABLE_PRIMARY_ATTR_KEYS = [
  "data-testid",
  "data-test",
  "data-qa",
  "data-cy",
  "name",
  "role",
  "type",
  "aria-label",
  "title",
  "placeholder",
] as const;

const LIVE_REPLAY_PATH_DEFERRED_MATCH_ATTR_KEYS = [
  "href",
  "src",
  "srcset",
  "imagesrcset",
  "ping",
  "value",
  "for",
  "aria-controls",
  "aria-labelledby",
  "aria-describedby",
] as const;

const LIVE_REPLAY_PATH_POLICY = {
  matchAttributePriority: LIVE_REPLAY_PATH_MATCH_ATTRIBUTE_PRIORITY,
  stablePrimaryAttrKeys: LIVE_REPLAY_PATH_STABLE_PRIMARY_ATTR_KEYS,
  deferredMatchAttrKeys: LIVE_REPLAY_PATH_DEFERRED_MATCH_ATTR_KEYS,
};

const BUILD_LIVE_REPLAY_PATH_DECLARATION = String.raw`function(policy, source) {
  const buildReplayPath = (0, eval)(source);
  return buildReplayPath(this, policy);
}`;

const BUILD_LIVE_REPLAY_PATH_SOURCE = String.raw`(target, policy) => {
  const MAX_ATTRIBUTE_VALUE_LENGTH = 300;

  function isElementNode(node) {
    return node != null && node.nodeType === 1;
  }

  function isShadowRoot(node) {
    return node != null && node.nodeType === 11 && "host" in node;
  }

  function isValidAttrKey(key) {
    const trimmed = String(key || "").trim();
    if (!trimmed) return false;
    if (/[\s"'<>/]/.test(trimmed)) return false;
    return /^[A-Za-z_][A-Za-z0-9_:\-.]*$/.test(trimmed);
  }

  function isMediaTag(tag) {
    return new Set(["img", "video", "source", "iframe"]).has(String(tag || "").toLowerCase());
  }

  function shouldKeepAttr(tag, key, value) {
    const normalized = String(key || "").trim().toLowerCase();
    if (!normalized || !String(value || "").trim()) return false;
    if (!isValidAttrKey(key)) return false;
    if (normalized === "c") return false;
    if (/^on[a-z]/i.test(normalized)) return false;
    if (new Set(["style", "nonce", "integrity", "crossorigin", "referrerpolicy", "autocomplete"]).has(normalized)) {
      return false;
    }
    if (normalized.startsWith("data-os-") || normalized.startsWith("data-opensteer-")) {
      return false;
    }
    if (
      isMediaTag(tag) &&
      new Set([
        "data-src",
        "data-lazy-src",
        "data-original",
        "data-lazy",
        "data-image",
        "data-url",
        "data-srcset",
        "data-lazy-srcset",
        "data-was-processed",
      ]).has(normalized)
    ) {
      return false;
    }
    return true;
  }

  function collectAttrs(node) {
    const tag = node.tagName.toLowerCase();
    const attrs = {};
    for (const attr of Array.from(node.attributes)) {
      if (!shouldKeepAttr(tag, attr.name, attr.value)) {
        continue;
      }
      const value = String(attr.value || "");
      if (!value.trim()) continue;
      if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) continue;
      attrs[attr.name] = value;
    }
    return attrs;
  }

  function getSiblings(node, root) {
    if (node.parentElement) return Array.from(node.parentElement.children);
    return Array.from(root.children || []);
  }

  function toPosition(node, root) {
    const siblings = getSiblings(node, root);
    const tag = node.tagName.toLowerCase();
    const sameTag = siblings.filter((candidate) => candidate.tagName.toLowerCase() === tag);
    return {
      nthChild: siblings.indexOf(node) + 1,
      nthOfType: sameTag.indexOf(node) + 1,
    };
  }

  function buildChain(node) {
    const chain = [];
    let current = node;
    while (current) {
      chain.push(current);
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      break;
    }
    chain.reverse();
    return chain;
  }

  function sortAttributeKeys(keys) {
    const priority = Array.isArray(policy?.matchAttributePriority)
      ? policy.matchAttributePriority.map((value) => String(value))
      : [];
    return [...keys].sort((left, right) => {
      const leftIndex = priority.indexOf(left);
      const rightIndex = priority.indexOf(right);
      const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
      const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.localeCompare(right);
    });
  }

  function tokenizeClassValue(value) {
    const seen = new Set();
    const out = [];
    for (const token of String(value || "").split(/\s+/)) {
      const normalized = token.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  function clauseKey(clause) {
    return JSON.stringify(clause);
  }

  function shouldDeferMatchAttribute(rawKey) {
    const key = String(rawKey || "").trim().toLowerCase();
    if (!key || key === "class") return false;
    if (key === "id" || /(?:^|[-_:])id$/.test(key)) return true;
    const deferred = new Set(
      Array.isArray(policy?.deferredMatchAttrKeys)
        ? policy.deferredMatchAttrKeys.map((value) => String(value))
        : [],
    );
    if (deferred.has(key)) return true;
    const stablePrimary = new Set(
      Array.isArray(policy?.stablePrimaryAttrKeys)
        ? policy.stablePrimaryAttrKeys.map((value) => String(value))
        : [],
    );
    if (key.startsWith("data-") && !stablePrimary.has(key)) return true;
    return !stablePrimary.has(key);
  }

  function buildSegmentSelector(data) {
    let selector = String(data.tag || "*").toLowerCase();
    for (const clause of data.match || []) {
      if (clause.kind === "text") continue;
      if (clause.kind === "position") {
        if (clause.axis === "nthOfType") {
          selector += ":nth-of-type(" + Math.max(1, Number(data.position?.nthOfType || 1)) + ")";
        } else {
          selector += ":nth-child(" + Math.max(1, Number(data.position?.nthChild || 1)) + ")";
        }
        continue;
      }

      const key = String(clause.key || "");
      const value = typeof clause.value === "string" ? clause.value : data.attrs?.[key];
      if (!key || !value) continue;
      if (key === "class" && (clause.op || "exact") === "exact") {
        for (const token of tokenizeClassValue(value)) {
          const escapedToken = String(token).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          selector += '[class~="' + escapedToken + '"]';
        }
        continue;
      }
      const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const op = clause.op || "exact";
      if (op === "startsWith") selector += "[" + key + '^="' + escaped + '"]';
      else if (op === "contains") selector += "[" + key + '*="' + escaped + '"]';
      else selector += "[" + key + '="' + escaped + '"]';
    }
    return selector;
  }

  function buildCandidates(nodes) {
    const parts = nodes.map((node) => buildSegmentSelector(node));
    const out = [];
    const seen = new Set();
    for (let start = 0; start < parts.length; start += 1) {
      const selector = parts.slice(start).join(" ");
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      out.push(selector);
    }
    return out;
  }

  function selectReplayCandidate(nodes, root) {
    const selectors = buildCandidates(nodes);
    const targetNode = nodes[nodes.length - 1];
    const textClauses = (targetNode?.match || []).filter((c) => c.kind === "text");
    let fallback = null;
    let fallbackSelector = null;
    let fallbackCount = 0;
    for (const selector of selectors) {
      let matches = [];
      try {
        matches = Array.from(root.querySelectorAll(selector));
      } catch {
        matches = [];
      }
      if (textClauses.length > 0 && matches.length > 1) {
        const filtered = matches.filter((el) => {
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          return textClauses.every((tc) => text.includes(tc.value));
        });
        if (filtered.length > 0) matches = filtered;
      }
      if (!matches.length) continue;
      if (matches.length === 1) {
        return {
          element: matches[0],
          selector,
          count: 1,
          mode: "unique",
        };
      }
      if (!fallback) {
        fallback = matches[0];
        fallbackSelector = selector;
        fallbackCount = matches.length;
      }
    }
    if (fallback && fallbackSelector) {
      return {
        element: fallback,
        selector: fallbackSelector,
        count: fallbackCount,
        mode: "fallback",
      };
    }
    return null;
  }

  function buildClausePool(data) {
    const attrs = data.attrs || {};
    const pool = [];
    const deferred = [];
    const used = new Set();

    const classValue = String(attrs.class || "").trim();
    if (classValue) {
      const clause = { kind: "attr", key: "class", op: "exact", value: classValue };
      used.add(clauseKey(clause));
      pool.push(clause);
    }

    for (const key of sortAttributeKeys(Object.keys(attrs))) {
      if (key === "class") continue;
      const value = attrs[key];
      if (!value || !String(value).trim()) continue;
      const clause = { kind: "attr", key, op: "exact" };
      const keyId = clauseKey(clause);
      if (used.has(keyId)) continue;
      used.add(keyId);
      if (shouldDeferMatchAttribute(key)) deferred.push(clause);
      else pool.push(clause);
    }

    if (data.textContent) {
      const clause = { kind: "text", value: data.textContent };
      const keyId = clauseKey(clause);
      if (!used.has(keyId)) {
        used.add(keyId);
        pool.push(clause);
      }
    }

    for (const clause of [
      { kind: "position", axis: "nthOfType" },
      { kind: "position", axis: "nthChild" },
    ]) {
      const keyId = clauseKey(clause);
      if (used.has(keyId)) continue;
      used.add(keyId);
      pool.push(clause);
    }

    if (!pool.some((clause) => clause.kind === "attr")) {
      pool.push(...deferred);
    }

    return pool;
  }

  function finalizePath(elements, root) {
    if (!elements.length) return null;
    const nodes = elements.map((element) => ({
      tag: element.tagName.toLowerCase(),
      attrs: collectAttrs(element),
      position: toPosition(element, root),
      textContent: policy.enableTextMatch
        ? (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)
        : "",
      match: [],
    }));

    const pools = nodes.map((node) => {
      node.match = [];
      return [...buildClausePool(node)];
    });

    for (let index = 0; index < pools.length; index += 1) {
      const classIndex = pools[index].findIndex(
        (clause) => clause.kind === "attr" && clause.key === "class",
      );
      if (classIndex < 0) continue;
      const classClause = pools[index][classIndex];
      if (!classClause) continue;
      nodes[index].match.push(classClause);
      pools[index].splice(classIndex, 1);
    }

    const expected = elements[elements.length - 1];
    const totalRemaining = pools.reduce((count, pool) => count + pool.length, 0);
    for (let iteration = 0; iteration <= totalRemaining; iteration += 1) {
      const chosen = selectReplayCandidate(nodes, root);
      if (chosen && chosen.mode === "unique" && chosen.element === expected) {
        return {
          nodes,
          selector: chosen.selector,
        };
      }

      let bestIndex = -1;
      let bestClause = null;
      let bestRank = Number.MAX_SAFE_INTEGER;
      for (let index = 0; index < pools.length; index += 1) {
        const clause = pools[index][0];
        if (!clause) continue;
        const rank =
          clause.kind === "attr"
            ? 0
            : clause.kind === "text"
              ? 1
              : clause.axis === "nthOfType"
                ? 2
                : 3;
        if (rank < bestRank) {
          bestRank = rank;
          bestIndex = index;
          bestClause = clause;
        }
      }

      if (bestIndex === -1 || !bestClause) {
        break;
      }

      nodes[bestIndex].match.push(bestClause);
      pools[bestIndex].shift();
    }

    const fallback = selectReplayCandidate(nodes, root);
    if (!fallback || fallback.element !== expected) {
      return {
        nodes,
      };
    }
    return {
      nodes,
      selector: fallback.selector,
    };
  }

  if (!isElementNode(target)) return null;

  const context = [];
  let currentRoot = isShadowRoot(target.getRootNode()) ? target.getRootNode() : document;
  const targetChain = buildChain(target);
  const finalizedTarget = finalizePath(targetChain, currentRoot);
  if (!finalizedTarget) return null;

  while (isShadowRoot(currentRoot)) {
    const host = currentRoot.host;
    const hostRoot = isShadowRoot(host.getRootNode()) ? host.getRootNode() : document;
    const hostChain = buildChain(host);
    const finalizedHost = finalizePath(hostChain, hostRoot);
    if (!finalizedHost) return null;
    context.unshift({
      kind: "shadow",
      host: finalizedHost.nodes,
    });
    currentRoot = hostRoot;
  }

  return {
    resolution: "deterministic",
    context,
    nodes: finalizedTarget.nodes,
  };
}`;

export function createAbpDomActionBridge(context: AbpDomActionBridgeContext): DomActionBridge {
  return {
    async buildReplayPath(locator, options) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(
        context,
        locator,
      );
      return withTemporaryExecutionResume(context, controller, async () => {
        const policy = options?.enableTextMatch
          ? { ...LIVE_REPLAY_PATH_POLICY, enableTextMatch: true }
          : LIVE_REPLAY_PATH_POLICY;
        const raw = await callNodeValueFunction(controller, document, locator, backendNodeId, {
          functionDeclaration: BUILD_LIVE_REPLAY_PATH_DECLARATION,
          arguments: [{ value: policy }, { value: BUILD_LIVE_REPLAY_PATH_SOURCE }],
        });
        return requireReplayPath(raw, locator);
      });
    },

    async inspectActionTarget(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(
        context,
        locator,
      );
      const snapshot = await context.getDomSnapshot(locator.documentRef);
      const node = findNode(snapshot, locator);
      if (!node) {
        return disconnectedInspection();
      }
      const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
      const metrics = await context.getViewportMetrics(document.pageRef);
      const contentQuads = await readContentQuads(controller, nodeId, metrics).catch(() =>
        node.layout?.quad === undefined ? [] : [node.layout.quad],
      );
      const bounds = contentQuads.length === 0 ? undefined : quadBounds(contentQuads[0]!);

      const hiddenAttribute = hasAttribute(node, "hidden");
      const ariaHidden = readAttributeValue(node, "aria-hidden") === "true";
      const disabled = hasAttribute(node, "disabled");
      const ariaDisabled = readAttributeValue(node, "aria-disabled") === "true";
      const readOnly = hasAttribute(node, "readonly");
      const style = readAttributeValue(node, "style") ?? "";
      const pointerEvents = readInlineStyleValue(style, "pointer-events") ?? "auto";
      const editable = isEditableElement(node) && !disabled && !ariaDisabled && !readOnly;

      return {
        connected: true,
        visible:
          !hiddenAttribute &&
          !ariaHidden &&
          bounds !== undefined &&
          bounds.width > 0 &&
          bounds.height > 0,
        enabled: !disabled && !ariaDisabled,
        editable,
        pointerEvents,
        ...(bounds === undefined ? {} : { bounds }),
        contentQuads,
      } satisfies DomActionTargetInspection;
    },

    async canonicalizePointerTarget(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(
        context,
        locator,
      );
      return withTemporaryExecutionResume(context, controller, async () => {
        return (
          (await callNodeFunctionForLocator(context, controller, document, locator, backendNodeId, {
            functionDeclaration: RESOLVE_POINTER_OWNER_DECLARATION,
          })) ?? locator
        );
      });
    },

    async classifyPointerHit(input) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(
        context,
        input.target,
      );
      const hitLiveNode = context.requireLiveNode(input.hit);

      return withTemporaryExecutionResume(context, controller, async () => {
        const value = await callNodeFunctionWithNodeArgument(
          controller,
          document,
          input.target,
          backendNodeId,
          input.hit,
          hitLiveNode.backendNodeId,
          {
            functionDeclaration: CLASSIFY_POINTER_HIT_DECLARATION,
            arguments: [{ value: input.point }],
          },
        );

        const assessment = normalizePointerHitAssessment(value, input.target);
        if (!assessment.blocking || assessment.relation !== "outside") {
          return assessment;
        }

        const hitOwner = await callNodeFunctionForLocator(
          context,
          controller,
          document,
          input.hit,
          hitLiveNode.backendNodeId,
          {
            functionDeclaration: RESOLVE_POINTER_OWNER_DECLARATION,
          },
        );

        return {
          ...assessment,
          ...(hitOwner === undefined ? {} : { hitOwner }),
        };
      });
    },

    async scrollNodeIntoView(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(
        context,
        locator,
      );
      const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
      await withTemporaryExecutionResume(context, controller, async () => {
        await controller.cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId });
        await context.flushDomUpdateTask(controller);
      });
    },

    async focusNode(locator) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(
        context,
        locator,
      );
      const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
      await withTemporaryExecutionResume(context, controller, async () => {
        await controller.cdp.send("DOM.focus", { nodeId });
        await context.flushDomUpdateTask(controller);
      });
    },

    async pressKey(locator, input) {
      const { controller, document, backendNodeId } = await prepareLiveNodeContext(
        context,
        locator,
      );
      const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
      await withTemporaryExecutionResume(context, controller, async () => {
        await controller.cdp.send("DOM.focus", { nodeId });
        await context.flushDomUpdateTask(controller);
        const session = context.resolveSession(controller.sessionRef);
        await session.rest.keyPressTab(controller.tabId, {
          key: input.key,
          ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] }),
          ...buildInputActionRequest(),
        });
        await context.flushDomUpdateTask(controller);
      });
    },

    async finalizeDomAction(pageRef, options) {
      const controller = context.resolveController(pageRef);
      const boundary = await context.settleActionBoundary(controller, {
        timeoutMs: clampAbpActionSettleTimeout(options.remainingMs()),
        ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
        signal: options.signal,
        policySettle: options.policySettle,
      });
      const session = context.resolveSession(controller.sessionRef);
      if (session.closed) {
        throw createBrowserCoreError("page-closed", `page ${pageRef} is closed`, {
          details: { pageRef },
        });
      }
      return boundary;
    },
  };
}

async function prepareLiveNodeContext(
  context: AbpDomActionBridgeContext,
  locator: NodeLocator,
): Promise<{
  readonly controller: PageController;
  readonly document: DocumentState;
  readonly backendNodeId: number;
}> {
  const liveNode = context.requireLiveNode(locator);
  const controller = context.resolveController(liveNode.document.pageRef);
  await context.flushDomUpdateTask(controller);
  return {
    controller,
    document: liveNode.document,
    backendNodeId: liveNode.backendNodeId,
  };
}

async function resolveFrontendNodeId(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
): Promise<number> {
  try {
    await controller.cdp.send("DOM.getDocument", { depth: 0 });
    const frontend = await controller.cdp.send<{ readonly nodeIds: readonly number[] }>(
      "DOM.pushNodesByBackendIdsToFrontend",
      {
        backendNodeIds: [backendNodeId],
      },
    );
    const nodeId = frontend.nodeIds[0];
    if (nodeId === undefined) {
      throw staleNodeRefError(locator);
    }
    return nodeId;
  } catch (error) {
    if (
      error instanceof Error &&
      /No node with given id found|Could not find node with given id|Cannot find context/i.test(
        error.message,
      )
    ) {
      throw staleNodeRefError({
        documentRef: document.documentRef,
        documentEpoch: locator.documentEpoch,
        nodeRef: locator.nodeRef,
      });
    }
    throw error;
  }
}

async function callNodeFunctionForLocator(
  context: AbpDomActionBridgeContext,
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
  input: {
    readonly functionDeclaration: string;
  },
): Promise<NodeLocator | undefined> {
  let sourceObjectId: string | undefined;
  let resultObjectId: string | undefined;

  try {
    sourceObjectId = await resolveNodeObjectId(controller, document, locator, backendNodeId);
    const evaluated = await controller.cdp.send<{
      readonly result?: {
        readonly objectId?: string;
        readonly subtype?: string;
      };
    }>("Runtime.callFunctionOn", {
      objectId: sourceObjectId,
      functionDeclaration: input.functionDeclaration,
      returnByValue: false,
      awaitPromise: true,
    });
    if (evaluated.result?.subtype === "null") {
      return undefined;
    }
    resultObjectId = evaluated.result?.objectId;
    if (resultObjectId === undefined) {
      return undefined;
    }

    const requested = await controller.cdp.send<{
      readonly nodeId?: number;
    }>("DOM.requestNode", { objectId: resultObjectId });
    if (requested.nodeId === undefined) {
      return undefined;
    }

    const described = await controller.cdp.send<{
      readonly node?: {
        readonly backendNodeId?: number;
      };
    }>("DOM.describeNode", { nodeId: requested.nodeId });
    if (described.node?.backendNodeId === undefined) {
      return undefined;
    }

    return context.locateBackendNode(document, described.node.backendNodeId);
  } catch (error) {
    rethrowNodeLookupError(document, locator, error);
  } finally {
    await releaseObject(controller, resultObjectId);
    await releaseObject(controller, sourceObjectId);
  }
}

async function callNodeFunctionWithNodeArgument(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
  argumentLocator: NodeLocator,
  argumentBackendNodeId: number,
  input: {
    readonly functionDeclaration: string;
    readonly arguments?: { readonly value: unknown }[];
  },
): Promise<unknown> {
  let objectId: string | undefined;
  let argumentObjectId: string | undefined;

  try {
    objectId = await resolveNodeObjectId(controller, document, locator, backendNodeId);
    argumentObjectId = await resolveNodeObjectId(
      controller,
      document,
      argumentLocator,
      argumentBackendNodeId,
    );

    const evaluated = await controller.cdp.send<{
      readonly result?: {
        readonly value?: unknown;
      };
    }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: input.functionDeclaration,
      arguments: [{ objectId: argumentObjectId }, ...(input.arguments ?? [])],
      returnByValue: true,
      awaitPromise: true,
    });
    return evaluated.result?.value;
  } catch (error) {
    rethrowNodeLookupError(document, locator, error);
  } finally {
    await releaseObject(controller, argumentObjectId);
    await releaseObject(controller, objectId);
  }
}

async function callNodeValueFunction(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
  input: {
    readonly functionDeclaration: string;
    readonly arguments?: readonly { readonly value: unknown }[];
  },
): Promise<unknown> {
  let objectId: string | undefined;

  try {
    objectId = await resolveNodeObjectId(controller, document, locator, backendNodeId);
    const evaluated = await controller.cdp.send<{
      readonly result?: {
        readonly value?: unknown;
      };
    }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: input.functionDeclaration,
      ...(input.arguments === undefined ? {} : { arguments: [...input.arguments] }),
      returnByValue: true,
      awaitPromise: true,
    });
    return evaluated.result?.value;
  } catch (error) {
    rethrowNodeLookupError(document, locator, error);
  } finally {
    await releaseObject(controller, objectId);
  }
}

async function resolveNodeObjectId(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
): Promise<string> {
  try {
    const resolved = await controller.cdp.send<{
      readonly object?: {
        readonly objectId?: string;
      };
    }>("DOM.resolveNode", {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) {
      throw staleNodeRefError(locator);
    }
    return objectId;
  } catch (error) {
    rethrowNodeLookupError(document, locator, error);
  }
}

async function withTemporaryExecutionResume<T>(
  context: AbpDomActionBridgeContext,
  controller: PageController,
  execute: () => Promise<T>,
): Promise<T> {
  const wasPaused = await context.syncExecutionPaused(controller);
  if (wasPaused) {
    await context.setExecutionPaused(controller, false);
  }
  try {
    return await execute();
  } finally {
    if (wasPaused && controller.lifecycleState !== "closed") {
      try {
        await context.setExecutionPaused(controller, true);
      } catch (error) {
        if (!context.isPageClosedError(error)) {
          throw error;
        }
      }
    }
  }
}

function findNode(snapshot: DomSnapshot, locator: NodeLocator): DomSnapshotNode | undefined {
  return snapshot.nodes.find((node) => node.nodeRef === locator.nodeRef);
}

function disconnectedInspection(): DomActionTargetInspection {
  return {
    connected: false,
    visible: false,
    enabled: false,
    editable: false,
    pointerEvents: "auto",
    contentQuads: [],
  };
}

function hasAttribute(node: DomSnapshotNode, name: string): boolean {
  return node.attributes.some((attribute) => attribute.name === name);
}

function readAttributeValue(node: DomSnapshotNode, name: string): string | undefined {
  return node.attributes.find((attribute) => attribute.name === name)?.value;
}

function isEditableElement(node: DomSnapshotNode): boolean {
  const name = node.nodeName.toLowerCase();
  return (
    name === "input" ||
    name === "textarea" ||
    name === "select" ||
    readAttributeValue(node, "contenteditable") === "" ||
    readAttributeValue(node, "contenteditable") === "true"
  );
}

function readInlineStyleValue(style: string, property: string): string | undefined {
  for (const declaration of style.split(";")) {
    const separatorIndex = declaration.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const name = declaration.slice(0, separatorIndex).trim().toLowerCase();
    if (name !== property) {
      continue;
    }
    const value = declaration.slice(separatorIndex + 1).trim();
    if (value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizePointerHitAssessment(
  value: unknown,
  canonicalTarget: NodeLocator,
): DomPointerHitAssessment {
  if (!value || typeof value !== "object") {
    throw new Error("DOM action bridge returned an invalid pointer hit payload");
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.relation !== "self" &&
    candidate.relation !== "descendant" &&
    candidate.relation !== "ancestor" &&
    candidate.relation !== "same-owner" &&
    candidate.relation !== "outside" &&
    candidate.relation !== "unknown"
  ) {
    throw new Error("DOM action bridge returned an invalid pointer hit relation");
  }
  if (typeof candidate.blocking !== "boolean") {
    throw new Error("DOM action bridge returned an invalid pointer hit payload");
  }
  if (candidate.ambiguous !== undefined && typeof candidate.ambiguous !== "boolean") {
    throw new Error("DOM action bridge returned an invalid pointer hit payload");
  }
  if (
    candidate.blockingDescription !== undefined &&
    typeof candidate.blockingDescription !== "string"
  ) {
    throw new Error("DOM action bridge returned an invalid pointer hit payload");
  }

  return {
    relation: candidate.relation,
    blocking: candidate.blocking,
    ...(candidate.ambiguous === undefined ? {} : { ambiguous: candidate.ambiguous }),
    ...(candidate.blockingDescription === undefined
      ? {}
      : { blockingDescription: candidate.blockingDescription }),
    canonicalTarget,
  };
}

function requireReplayPath(value: unknown, locator: NodeLocator): ReplayElementPath {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { readonly resolution?: unknown }).resolution !== "deterministic"
  ) {
    throw new Error(
      `live DOM replay path builder returned an invalid result for ${locator.nodeRef}`,
    );
  }

  return value as ReplayElementPath;
}

function rethrowNodeLookupError(
  document: DocumentState,
  locator: NodeLocator,
  error: unknown,
): never {
  if (
    error instanceof Error &&
    /No node with given id found|Could not find node with given id|Cannot find context/i.test(
      error.message,
    )
  ) {
    throw staleNodeRefError({
      documentRef: document.documentRef,
      documentEpoch: locator.documentEpoch,
      nodeRef: locator.nodeRef,
    });
  }
  throw error;
}

async function readContentQuads(
  controller: PageController,
  nodeId: number,
  metrics: ViewportMetrics,
): Promise<readonly Quad[]> {
  const result = await controller.cdp.send<{
    readonly quads: ReadonlyArray<readonly number[]>;
  }>("DOM.getContentQuads", { nodeId });

  return result.quads
    .filter((quad): quad is readonly number[] => quad.length === 8)
    .map((quad) => [
      createPoint(quad[0]! + metrics.scrollOffset.x, quad[1]! + metrics.scrollOffset.y),
      createPoint(quad[2]! + metrics.scrollOffset.x, quad[3]! + metrics.scrollOffset.y),
      createPoint(quad[4]! + metrics.scrollOffset.x, quad[5]! + metrics.scrollOffset.y),
      createPoint(quad[6]! + metrics.scrollOffset.x, quad[7]! + metrics.scrollOffset.y),
    ]);
}

async function releaseObject(
  controller: PageController,
  objectId: string | undefined,
): Promise<void> {
  if (objectId === undefined) {
    return;
  }
  await controller.cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
}
