import {
  type ActionBoundaryOutcome,
  createPoint,
  createRect,
  quadBounds,
  staleNodeRefError,
  type FrameRef,
  type KeyModifier,
  type NodeLocator,
  type PageRef,
  type Quad,
  type Rect,
  type SessionRef,
} from "@opensteer/browser-core";
import type {
  DomActionBridge,
  DomPointerHitAssessment,
  DomActionTargetInspection,
  ReplayElementPath,
} from "@opensteer/protocol";
import type { ElementHandle, Frame } from "playwright";

import { rethrowNodeLookupError } from "./errors.js";
import type { PlaywrightActionBoundaryOptions } from "./action-settle.js";
import type { DocumentState, PageController } from "./types.js";
import { getViewportMetricsFromCdp } from "./viewport-screenshot.js";

interface PlaywrightDomActionBridgeContext {
  resolveController(pageRef: PageRef): PageController;
  flushPendingPageTasks(sessionRef: SessionRef): Promise<void>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  settleActionBoundary(
    controller: PageController,
    options: PlaywrightActionBoundaryOptions,
  ): Promise<ActionBoundaryOutcome>;
  locateBackendNode(document: DocumentState, backendNodeId: number): NodeLocator;
  requireFrame(frameRef: FrameRef): Frame;
  requireLiveNode(locator: NodeLocator): {
    readonly controller: PageController;
    readonly document: DocumentState;
    readonly backendNodeId: number;
  };
}

const READ_ACTION_TARGET_STATE_DECLARATION = String.raw`function() {
  const node = this;
  if (!(node instanceof Element)) {
    return {
      connected: false,
      cssVisible: false,
      enabled: false,
      editable: false,
      pointerEvents: "auto",
    };
  }

  const ownerWindow = node.ownerDocument?.defaultView;
  if (!ownerWindow) {
    return {
      connected: node.isConnected,
      cssVisible: false,
      enabled: false,
      editable: false,
      pointerEvents: "auto",
    };
  }

  const style = ownerWindow.getComputedStyle(node);

  const enabled =
    typeof node.matches === "function"
      ? !node.matches(":disabled") && node.getAttribute("aria-disabled") !== "true"
      : true;

  const editable =
    (node instanceof ownerWindow.HTMLInputElement ||
      node instanceof ownerWindow.HTMLTextAreaElement) &&
    !node.readOnly &&
    enabled
      ? true
      : node instanceof ownerWindow.HTMLSelectElement && enabled
        ? true
        : node.isContentEditable;

  return {
    connected: node.isConnected,
    cssVisible:
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.display !== "none",
    enabled,
    editable,
    pointerEvents: style.pointerEvents,
  };
}`;

const POINTER_ACTION_HELPERS = String.raw`
  function parentInComposedTree(node) {
    if (!node) {
      return null;
    }
    const slot = "assignedSlot" in node ? node.assignedSlot : null;
    if (slot instanceof Element) {
      return slot;
    }
    const parent = node.parentNode;
    if (parent instanceof ShadowRoot) {
      return parent.host;
    }
    return parent instanceof Element ? parent : null;
  }

  function closestElementInComposedTree(node) {
    if (!node) {
      return null;
    }
    if (node instanceof Element) {
      return node;
    }
    let current = parentInComposedTree(node);
    while (current) {
      if (current instanceof Element) {
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
        if (control instanceof Element) {
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
    if (!(container instanceof Node) || !(node instanceof Node)) {
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

  return {
    relation,
    blocking,
    ambiguous,
  };
}`;

const LIVE_REPLAY_PATH_MATCH_ATTRIBUTE_PRIORITY = [
  "class",
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
  "for",
  "aria-controls",
  "aria-labelledby",
  "aria-describedby",
  "id",
  "href",
  "value",
  "src",
  "srcset",
  "imagesrcset",
  "ping",
  "alt",
] as const;

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

      let added = false;
      for (let index = pools.length - 1; index >= 0; index -= 1) {
        const next = pools[index][0];
        if (!next) continue;
        nodes[index].match.push(next);
        pools[index].shift();
        added = true;
        break;
      }
      if (!added) break;
    }

    return null;
  }

  if (!(target instanceof Element)) return null;

  const context = [];
  let currentRoot = target.getRootNode() instanceof ShadowRoot ? target.getRootNode() : document;
  const targetChain = buildChain(target);
  const finalizedTarget = finalizePath(targetChain, currentRoot);
  if (!finalizedTarget) return null;

  while (currentRoot instanceof ShadowRoot) {
    const host = currentRoot.host;
    const hostRoot =
      host.getRootNode() instanceof ShadowRoot ? host.getRootNode() : document;
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

export function createPlaywrightDomActionBridge(
  context: PlaywrightDomActionBridgeContext,
): DomActionBridge {
  return {
    buildReplayPath(locator) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const localPath = await buildLiveReplayPathForLocator(
          controller,
          document,
          locator,
          backendNodeId,
        );
        return prefixIframeReplayPath(context, document.frameRef, localPath);
      });
    },

    inspectActionTarget(locator) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
        const [state, contentQuads] = await Promise.all([
          callNodeFunction(controller, document, locator, backendNodeId, {
            functionDeclaration: READ_ACTION_TARGET_STATE_DECLARATION,
            returnByValue: true,
          }),
          readContentQuads(controller, document, locator, nodeId),
        ]);

        return normalizeActionTargetInspection(state, contentQuads);
      });
    },

    canonicalizePointerTarget(locator) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        return (
          (await callNodeFunctionForLocator(context, controller, document, locator, backendNodeId, {
            functionDeclaration: RESOLVE_POINTER_OWNER_DECLARATION,
          })) ?? locator
        );
      });
    },

    async classifyPointerHit(input) {
      return withLiveNode(
        context,
        input.target,
        async ({ controller, document, backendNodeId }) => {
          const hitLiveNode = context.requireLiveNode(input.hit);
          await context.flushDomUpdateTask(hitLiveNode.controller);

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
            hitLiveNode.controller,
            hitLiveNode.document,
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
        },
      );
    },

    async scrollNodeIntoView(locator, _options) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
        await sendNodeIdCommand(controller, document, locator, "DOM.scrollIntoViewIfNeeded", {
          nodeId,
        });
        await context.flushDomUpdateTask(controller);
      });
    },

    async focusNode(locator) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
        await sendNodeIdCommand(controller, document, locator, "DOM.focus", { nodeId });
        await context.flushDomUpdateTask(controller);
      });
    },

    async pressKey(locator, input) {
      return withLiveNode(context, locator, async ({ controller, document, backendNodeId }) => {
        const nodeId = await resolveFrontendNodeId(controller, document, locator, backendNodeId);
        await sendNodeIdCommand(controller, document, locator, "DOM.focus", { nodeId });
        await context.flushDomUpdateTask(controller);
        await withKeyboardModifiers(controller, input.modifiers, async () => {
          await controller.page.keyboard.press(input.key);
        });
        await context.flushDomUpdateTask(controller);
      });
    },

    async finalizeDomAction(pageRef, options) {
      const controller = context.resolveController(pageRef);
      return context.settleActionBoundary(controller, {
        signal: options.signal,
        ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
        remainingMs: options.remainingMs,
        policySettle: options.policySettle,
      });
    },
  };
}

async function withLiveNode<T>(
  context: PlaywrightDomActionBridgeContext,
  locator: NodeLocator,
  callback: (input: {
    readonly controller: PageController;
    readonly document: DocumentState;
    readonly backendNodeId: number;
  }) => Promise<T>,
): Promise<T> {
  const liveNode = context.requireLiveNode(locator);
  await context.flushDomUpdateTask(liveNode.controller);
  return callback(liveNode);
}

async function withKeyboardModifiers(
  controller: PageController,
  modifiers: readonly KeyModifier[] | undefined,
  action: () => Promise<void>,
): Promise<void> {
  if (modifiers === undefined || modifiers.length === 0) {
    await action();
    return;
  }

  for (const modifier of modifiers) {
    await controller.page.keyboard.down(modifier);
  }

  try {
    await action();
  } finally {
    for (const modifier of [...modifiers].reverse()) {
      await controller.page.keyboard.up(modifier);
    }
  }
}

async function callNodeFunctionForLocator(
  context: PlaywrightDomActionBridgeContext,
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
    const evaluated = (await controller.cdp.send("Runtime.callFunctionOn", {
      objectId: sourceObjectId,
      functionDeclaration: input.functionDeclaration,
      returnByValue: false,
      awaitPromise: true,
    })) as {
      readonly result?: {
        readonly objectId?: string;
        readonly subtype?: string;
      };
    };

    if (evaluated.result?.subtype === "null") {
      return undefined;
    }
    resultObjectId = evaluated.result?.objectId;
    if (resultObjectId === undefined) {
      return undefined;
    }

    const requested = (await controller.cdp.send("DOM.requestNode", {
      objectId: resultObjectId,
    })) as {
      readonly nodeId?: number;
    };
    if (requested.nodeId === undefined) {
      return undefined;
    }

    const described = (await controller.cdp.send("DOM.describeNode", {
      nodeId: requested.nodeId,
    })) as {
      readonly node?: {
        readonly backendNodeId?: number;
      };
    };
    if (described.node?.backendNodeId === undefined) {
      return undefined;
    }

    return context.locateBackendNode(document, described.node.backendNodeId);
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  } finally {
    await releaseObject(controller, resultObjectId);
    await releaseObject(controller, sourceObjectId);
  }
}

async function callNodeFunction(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
  input: {
    readonly functionDeclaration: string;
    readonly arguments?: { readonly value: unknown }[];
    readonly returnByValue: boolean;
  },
): Promise<unknown> {
  let objectId: string | undefined;

  try {
    const resolved = (await controller.cdp.send("DOM.resolveNode", {
      backendNodeId,
    })) as {
      readonly object?: {
        readonly objectId?: string;
      };
    };
    objectId = resolved.object?.objectId;
    if (objectId === undefined) {
      throw staleNodeRefError(locator);
    }

    const evaluated = (await controller.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: input.functionDeclaration,
      ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
      returnByValue: input.returnByValue,
      awaitPromise: true,
    })) as {
      readonly result?: {
        readonly value?: unknown;
      };
    };
    return evaluated.result?.value;
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  } finally {
    if (objectId !== undefined) {
      await controller.cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
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
    const evaluated = (await controller.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: input.functionDeclaration,
      arguments: [{ objectId: argumentObjectId }, ...(input.arguments ?? [])],
      returnByValue: true,
      awaitPromise: true,
    })) as {
      readonly result?: {
        readonly value?: unknown;
      };
    };
    return evaluated.result?.value;
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  } finally {
    await releaseObject(controller, argumentObjectId);
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
    const resolved = (await controller.cdp.send("DOM.resolveNode", {
      backendNodeId,
    })) as {
      readonly object?: {
        readonly objectId?: string;
      };
    };
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) {
      throw staleNodeRefError(locator);
    }
    return objectId;
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  }
}

async function resolveFrontendNodeId(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
): Promise<number> {
  try {
    await controller.cdp.send("DOM.getDocument", { depth: 0 });
    const frontend = (await controller.cdp.send("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [backendNodeId],
    })) as {
      readonly nodeIds: readonly number[];
    };
    const nodeId = frontend.nodeIds[0];
    if (nodeId === undefined) {
      throw staleNodeRefError(locator);
    }
    return nodeId;
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  }
}

async function sendNodeIdCommand<TResult>(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  method: Parameters<PageController["cdp"]["send"]>[0],
  params: Parameters<PageController["cdp"]["send"]>[1],
): Promise<TResult> {
  try {
    return (await controller.cdp.send(method, params)) as TResult;
  } catch (error) {
    rethrowNodeLookupError(error, document, locator);
  }
}

async function readContentQuads(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  nodeId: number,
): Promise<readonly Quad[]> {
  const metrics = await getViewportMetricsFromCdp(controller);
  const result = await sendNodeIdCommand<{
    readonly quads?: ReadonlyArray<readonly number[]>;
  }>(controller, document, locator, "DOM.getContentQuads", { nodeId });

  return (result.quads ?? [])
    .filter((quad): quad is readonly number[] => quad.length === 8)
    .map((quad) => [
      createPoint(quad[0]! + metrics.scrollOffset.x, quad[1]! + metrics.scrollOffset.y),
      createPoint(quad[2]! + metrics.scrollOffset.x, quad[3]! + metrics.scrollOffset.y),
      createPoint(quad[4]! + metrics.scrollOffset.x, quad[5]! + metrics.scrollOffset.y),
      createPoint(quad[6]! + metrics.scrollOffset.x, quad[7]! + metrics.scrollOffset.y),
    ]);
}

function normalizeActionTargetInspection(
  value: unknown,
  contentQuads: readonly Quad[],
): DomActionTargetInspection {
  if (!value || typeof value !== "object") {
    throw new Error("DOM action bridge returned an invalid inspection payload");
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.connected !== "boolean" ||
    typeof candidate.cssVisible !== "boolean" ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.editable !== "boolean" ||
    typeof candidate.pointerEvents !== "string"
  ) {
    throw new Error("DOM action bridge returned an invalid inspection payload");
  }

  const bounds = contentQuads.length === 0 ? undefined : unionQuadBounds(contentQuads);

  return {
    connected: candidate.connected,
    visible: candidate.cssVisible && contentQuads.length > 0,
    enabled: candidate.enabled,
    editable: candidate.editable,
    pointerEvents: candidate.pointerEvents,
    ...(bounds === undefined ? {} : { bounds }),
    contentQuads,
  };
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

  return {
    relation: candidate.relation,
    blocking: candidate.blocking,
    ...(candidate.ambiguous === undefined ? {} : { ambiguous: candidate.ambiguous }),
    canonicalTarget,
  };
}

async function buildLiveReplayPathForLocator(
  controller: PageController,
  document: DocumentState,
  locator: NodeLocator,
  backendNodeId: number,
): Promise<ReplayElementPath> {
  const raw = await callNodeFunction(controller, document, locator, backendNodeId, {
    functionDeclaration: BUILD_LIVE_REPLAY_PATH_DECLARATION,
    arguments: [{ value: LIVE_REPLAY_PATH_POLICY }, { value: BUILD_LIVE_REPLAY_PATH_SOURCE }],
    returnByValue: true,
  });
  return requireReplayPath(raw, locator);
}

async function prefixIframeReplayPath(
  context: PlaywrightDomActionBridgeContext,
  frameRef: FrameRef,
  localPath: ReplayElementPath,
): Promise<ReplayElementPath> {
  let currentPath = localPath;
  let currentFrame = context.requireFrame(frameRef);

  while (currentFrame.parentFrame() !== null) {
    const frameElement = await currentFrame.frameElement();
    try {
      const hostPath = await buildLiveReplayPathForHandle(frameElement);
      currentPath = {
        resolution: "deterministic",
        context: [
          ...hostPath.context,
          { kind: "iframe", host: hostPath.nodes },
          ...currentPath.context,
        ],
        nodes: currentPath.nodes,
      };
    } finally {
      await frameElement.dispose().catch(() => undefined);
    }

    currentFrame = currentFrame.parentFrame()!;
  }

  return currentPath;
}

async function buildLiveReplayPathForHandle(handle: ElementHandle): Promise<ReplayElementPath> {
  const raw = await handle.evaluate(
    (element, input) => {
      const buildReplayPath = (0, eval)(input.source);
      return buildReplayPath(element, input.policy);
    },
    {
      policy: LIVE_REPLAY_PATH_POLICY,
      source: BUILD_LIVE_REPLAY_PATH_SOURCE,
    },
  );
  return requireReplayPath(raw);
}

function requireReplayPath(value: unknown, locator?: NodeLocator): ReplayElementPath {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { readonly resolution?: unknown }).resolution !== "deterministic"
  ) {
    throw new Error(
      locator === undefined
        ? "live DOM replay path builder returned an invalid result"
        : `live DOM replay path builder returned an invalid result for ${locator.nodeRef}`,
    );
  }

  return value as ReplayElementPath;
}

function unionQuadBounds(quads: readonly Quad[]): Rect {
  const bounds = quads.map((quad) => quadBounds(quad));
  const minX = Math.min(...bounds.map((rect) => rect.x));
  const minY = Math.min(...bounds.map((rect) => rect.y));
  const maxX = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...bounds.map((rect) => rect.y + rect.height));
  return createRect(minX, minY, maxX - minX, maxY - minY);
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
