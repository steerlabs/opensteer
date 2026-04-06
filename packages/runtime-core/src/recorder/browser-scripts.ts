import {
  ATTRIBUTE_DENY_KEYS,
  LAZY_LOADING_MEDIA_TAGS,
  MATCH_ATTRIBUTE_PRIORITY,
  STABLE_PRIMARY_ATTR_KEYS,
  VOLATILE_CLASS_TOKENS,
  VOLATILE_LAZY_CLASS_TOKENS,
  VOLATILE_LAZY_LOADING_ATTRS,
} from "../runtimes/dom/match-policy.js";

const SINGLE_ATTRIBUTE_PRIORITY = Array.from(
  new Set(["data-testid", "data-test", "data-qa", "data-cy", "id", ...STABLE_PRIMARY_ATTR_KEYS]),
);

export interface FlowRecorderInstallScriptOptions {
  readonly showStopButton?: boolean;
}

export function createFlowRecorderInstallScript(
  options: FlowRecorderInstallScriptOptions = {},
): string {
  const normalizedOptions = {
    showStopButton: options.showStopButton ?? true,
  } as const;

  return String.raw`(() => {
  const TOP_LEVEL_ONLY = (() => {
    try {
      return window.top === window.self;
    } catch {
      return false;
    }
  })();
  if (!TOP_LEVEL_ONLY) {
    return;
  }

  const globalScope = globalThis;
  const recorderKey = "__opensteerFlowRecorder";
  const historyStateKey = "__opensteerFlowRecorderHistory";
  const recorderUiAttribute = "data-opensteer-recorder-ui";
  const queueLimit = 1000;
  const singleAttributePriority = ${JSON.stringify(SINGLE_ATTRIBUTE_PRIORITY)};
  const stablePrimaryAttrKeys = new Set(${JSON.stringify([...STABLE_PRIMARY_ATTR_KEYS])});
  const matchAttributePriority = ${JSON.stringify([...MATCH_ATTRIBUTE_PRIORITY])};
  const attributeDenyKeys = new Set(${JSON.stringify([...ATTRIBUTE_DENY_KEYS])});
  const lazyLoadingMediaTags = new Set(${JSON.stringify([...LAZY_LOADING_MEDIA_TAGS])});
  const volatileLazyLoadingAttrs = new Set(${JSON.stringify([...VOLATILE_LAZY_LOADING_ATTRS])});
  const volatileClassTokens = new Set(${JSON.stringify([...VOLATILE_CLASS_TOKENS])});
  const volatileLazyClassTokens = new Set(${JSON.stringify([...VOLATILE_LAZY_CLASS_TOKENS])});
  const options = ${JSON.stringify(normalizedOptions)};

  const previous = globalScope[recorderKey];
  if (previous && typeof previous.dispose === "function") {
    previous.dispose();
  }

  const queue = [];
  const cleanup = [];
  const inputFlushTimers = new Map();
  const pendingInputs = new Map();
  let historyStateCache = undefined;
  let stopRequested = false;
  let pendingWheel = undefined;

  const actionTargetTags = new Set([
    "a",
    "button",
    "input",
    "label",
    "option",
    "select",
    "summary",
    "textarea",
  ]);

  function now() {
    return Date.now();
  }

  function enqueue(entry) {
    queue.push({
      ...entry,
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : now(),
    });
    if (queue.length > queueLimit) {
      queue.splice(0, queue.length - queueLimit);
    }
  }

  function isRecorderUiNode(node) {
    let current = node instanceof Node ? node : null;
    while (current) {
      if (current instanceof Element && current.hasAttribute(recorderUiAttribute)) {
        return true;
      }
      const root = typeof current.getRootNode === "function" ? current.getRootNode() : null;
      if (root instanceof ShadowRoot) {
        current = root.host;
        continue;
      }
      current = current instanceof Element ? current.parentElement : null;
    }
    return false;
  }

  function isValidAttributeName(name) {
    if (typeof name !== "string") {
      return false;
    }
    const normalized = name.trim();
    if (normalized.length === 0) {
      return false;
    }
    if (/[\s"'<>/]/.test(normalized)) {
      return false;
    }
    return /^[A-Za-z_][A-Za-z0-9_:\-.]*$/.test(normalized);
  }

  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function escapeIdentifier(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return String(value).replace(/[^A-Za-z0-9_-]/g, (character) => {
      const codePoint = character.codePointAt(0);
      return "\\" + (codePoint == null ? "" : codePoint.toString(16)) + " ";
    });
  }

  function normalizeClassValue(element, rawValue) {
    const tag = element.tagName.toLowerCase();
    const tokens = String(rawValue)
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => !volatileClassTokens.has(token))
      .filter((token) => !(lazyLoadingMediaTags.has(tag) && volatileLazyClassTokens.has(token)));
    return tokens.join(" ");
  }

  function shouldKeepAttribute(element, name, value) {
    const key = String(name || "")
      .trim()
      .toLowerCase();
    if (!key || !String(value || "").trim()) {
      return false;
    }
    if (!isValidAttributeName(key)) {
      return false;
    }
    if (key === "c") {
      return false;
    }
    if (/^on[a-z]/i.test(key)) {
      return false;
    }
    if (attributeDenyKeys.has(key)) {
      return false;
    }
    if (key.startsWith("data-os-") || key.startsWith("data-opensteer-")) {
      return false;
    }
    if (lazyLoadingMediaTags.has(element.tagName.toLowerCase()) && volatileLazyLoadingAttrs.has(key)) {
      return false;
    }
    return true;
  }

  function readAttributeValue(element, key) {
    if (key === "class") {
      const normalized = normalizeClassValue(element, element.getAttribute("class") || "");
      return normalized.length === 0 ? undefined : normalized;
    }
    const value = element.getAttribute(key);
    if (!shouldKeepAttribute(element, key, value || "")) {
      return undefined;
    }
    return value || undefined;
  }

  function buildSingleAttributeSelector(element, key, value) {
    if (!value) {
      return undefined;
    }
    const tag = element.tagName.toLowerCase();
    if (key === "id") {
      const idSelector = "#" + escapeIdentifier(value);
      return element.matches(idSelector)
        ? idSelector
        : tag + '[id="' + escapeAttributeValue(value) + '"]';
    }
    return tag + "[" + key + '="' + escapeAttributeValue(value) + '"]';
  }

  function isUniqueSelector(selector, element) {
    if (!selector) {
      return false;
    }
    let matches;
    try {
      matches = document.querySelectorAll(selector);
    } catch {
      return false;
    }
    return matches.length === 1 && matches[0] === element;
  }

  function nearestRecordTarget(node) {
    if (isRecorderUiNode(node)) {
      return null;
    }
    let current = node instanceof Element ? node : null;
    while (current) {
      if (current.hasAttribute(recorderUiAttribute)) {
        return null;
      }
      const tag = current.tagName.toLowerCase();
      if (
        actionTargetTags.has(tag) ||
        current.hasAttribute("data-testid") ||
        current.hasAttribute("data-test") ||
        current.hasAttribute("data-qa") ||
        current.hasAttribute("data-cy") ||
        current.hasAttribute("role") ||
        current.hasAttribute("aria-label") ||
        current.hasAttribute("name")
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return node instanceof Element ? node : null;
  }

  function buildSegmentSelector(element) {
    const tag = element.tagName.toLowerCase();
    for (const key of matchAttributePriority) {
      const value = readAttributeValue(element, key);
      if (!value) {
        continue;
      }
      if (key === "class") {
        const tokens = value
          .split(/\s+/u)
          .map((token) => token.trim())
          .filter(Boolean)
          .slice(0, 2);
        if (tokens.length === 0) {
          continue;
        }
        return tag + tokens.map((token) => "." + escapeIdentifier(token)).join("");
      }
      return key === "id"
        ? tag + '[id="' + escapeAttributeValue(value) + '"]'
        : tag + "[" + key + '="' + escapeAttributeValue(value) + '"]';
    }
    return tag;
  }

  function nthOfTypeSegment(element, baseSelector) {
    const parent = element.parentElement;
    if (!parent) {
      return baseSelector;
    }
    const sameType = Array.from(parent.children).filter(
      (child) => child.tagName === element.tagName,
    );
    if (sameType.length <= 1) {
      return baseSelector;
    }
    const index = sameType.indexOf(element) + 1;
    return baseSelector + ":nth-of-type(" + String(index) + ")";
  }

  function buildSelector(node) {
    const element = nearestRecordTarget(node);
    if (!(element instanceof Element)) {
      return undefined;
    }

    for (const key of singleAttributePriority) {
      const value = readAttributeValue(element, key);
      const selector = buildSingleAttributeSelector(element, key, value);
      if (selector && isUniqueSelector(selector, element)) {
        return selector;
      }
      if (value && !stablePrimaryAttrKeys.has(key) && key !== "id") {
        const tagQualified =
          element.tagName.toLowerCase() + "[" + key + '="' + escapeAttributeValue(value) + '"]';
        if (isUniqueSelector(tagQualified, element)) {
          return tagQualified;
        }
      }
    }

    const segments = [];
    let current = element;
    let depth = 0;
    while (current && depth < 6) {
      const segment = nthOfTypeSegment(current, buildSegmentSelector(current));
      segments.unshift(segment);
      const selector = segments.join(" > ");
      if (isUniqueSelector(selector, element)) {
        return selector;
      }
      current = current.parentElement;
      depth += 1;
    }

    const fallback = segments.join(" > ");
    return fallback.length > 0 ? fallback : element.tagName.toLowerCase();
  }

  function readTargetValue(target) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return target.value;
    }
    if (target instanceof HTMLSelectElement) {
      return target.value;
    }
    if (target instanceof HTMLElement && target.isContentEditable) {
      return target.textContent || "";
    }
    return undefined;
  }

  function flushPendingInput(selector) {
    const pending = pendingInputs.get(selector);
    if (!pending) {
      return;
    }
    pendingInputs.delete(selector);
    const timer = inputFlushTimers.get(selector);
    if (timer !== undefined) {
      clearTimeout(timer);
      inputFlushTimers.delete(selector);
    }
    enqueue({
      kind: "type",
      selector,
      text: pending.text,
      timestamp: pending.timestamp,
    });
  }

  function flushAllInputs() {
    for (const selector of Array.from(pendingInputs.keys())) {
      flushPendingInput(selector);
    }
  }

  function flushPendingWheel() {
    if (!pendingWheel) {
      return;
    }
    clearTimeout(pendingWheel.timerId);
    enqueue({
      kind: "scroll",
      selector: pendingWheel.selector,
      deltaX: pendingWheel.deltaX,
      deltaY: pendingWheel.deltaY,
      timestamp: pendingWheel.timestamp,
    });
    pendingWheel = undefined;
  }

  function scheduleInputFlush(selector) {
    const existing = inputFlushTimers.get(selector);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timerId = setTimeout(() => {
      flushPendingInput(selector);
    }, 400);
    inputFlushTimers.set(selector, timerId);
  }

  function createDefaultHistoryState(currentUrl) {
    return {
      entries: [currentUrl],
      index: 0,
    };
  }

  function normalizeHistoryState(state) {
    if (
      !state ||
      !Array.isArray(state.entries) ||
      !state.entries.every((entry) => typeof entry === "string") ||
      !Number.isInteger(state.index)
    ) {
      return undefined;
    }
    const entries = state.entries.slice();
    if (entries.length === 0) {
      return createDefaultHistoryState(location.href);
    }
    return {
      entries,
      index: Math.min(entries.length - 1, Math.max(0, state.index)),
    };
  }

  function writeHistoryState(state) {
    const normalized = normalizeHistoryState(state) ?? createDefaultHistoryState(location.href);
    historyStateCache = normalized;
    try {
      sessionStorage.setItem(historyStateKey, JSON.stringify(normalized));
    } catch {}
    return normalized;
  }

  function applyHistoryState(state, mode, nextUrl) {
    const current = normalizeHistoryState(state) ?? createDefaultHistoryState(location.href);
    const nextState = {
      entries: current.entries.slice(),
      index: current.index,
    };
    if (mode === "replace") {
      nextState.entries[nextState.index] = nextUrl;
    } else if (mode === "push") {
      nextState.entries = nextState.entries.slice(0, nextState.index + 1);
      nextState.entries.push(nextUrl);
      nextState.index = nextState.entries.length - 1;
    } else if (mode === "back") {
      nextState.index = Math.max(0, nextState.index - 1);
    } else if (mode === "forward") {
      nextState.index = Math.min(nextState.entries.length - 1, nextState.index + 1);
    }
    return nextState;
  }

  function updateHistoryState(mode, nextUrl) {
    return writeHistoryState(applyHistoryState(readHistoryState(), mode, nextUrl));
  }

  function readHistoryState() {
    const cached = normalizeHistoryState(historyStateCache);
    if (cached) {
      historyStateCache = cached;
      return cached;
    }
    try {
      const raw = sessionStorage.getItem(historyStateKey);
      const parsed = normalizeHistoryState(raw ? JSON.parse(raw) : undefined);
      if (parsed) {
        historyStateCache = parsed;
        return parsed;
      }
    } catch {}
    return undefined;
  }

  function classifyHistoryTraversal(currentUrl) {
    const state = readHistoryState();
    if (!state) {
      return undefined;
    }
    if (state.entries[state.index] === currentUrl) {
      return undefined;
    }
    if (state.entries[state.index - 1] === currentUrl) {
      writeHistoryState({
        entries: state.entries,
        index: state.index - 1,
      });
      return "go-back";
    }
    if (state.entries[state.index + 1] === currentUrl) {
      writeHistoryState({
        entries: state.entries,
        index: state.index + 1,
      });
      return "go-forward";
    }
    const existingIndex = state.entries.lastIndexOf(currentUrl);
    if (existingIndex !== -1 && existingIndex !== state.index) {
      writeHistoryState({
        entries: state.entries,
        index: existingIndex,
      });
      return existingIndex < state.index ? "go-back" : "go-forward";
    }
    return undefined;
  }

  function onInstall() {
    const currentUrl = location.href;
    const navigationEntry =
      typeof performance.getEntriesByType === "function"
        ? performance.getEntriesByType("navigation")[0]
        : undefined;
    const navigationType =
      navigationEntry && typeof navigationEntry.type === "string" ? navigationEntry.type : undefined;
    const existingState = readHistoryState();

    if (!existingState) {
      updateHistoryState("replace", currentUrl);
      return;
    }

    if (navigationType === "reload") {
      updateHistoryState("replace", currentUrl);
      enqueue({
        kind: "reload",
        url: currentUrl,
      });
      return;
    }

    if (navigationType === "back_forward") {
      const traversal = classifyHistoryTraversal(currentUrl);
      if (traversal === "go-back" || traversal === "go-forward") {
        enqueue({
          kind: traversal,
          url: currentUrl,
        });
        return;
      }
    }

    if (existingState.entries[existingState.index] !== currentUrl) {
      updateHistoryState("push", currentUrl);
      enqueue({
        kind: "navigate",
        url: currentUrl,
        source: "full-navigation",
      });
    }
  }

  function modifierKeys(event) {
    const modifiers = [];
    if (event.altKey) {
      modifiers.push("Alt");
    }
    if (event.ctrlKey) {
      modifiers.push("Control");
    }
    if (event.metaKey) {
      modifiers.push("Meta");
    }
    if (event.shiftKey) {
      modifiers.push("Shift");
    }
    return modifiers;
  }

  function addListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    cleanup.push(() => {
      target.removeEventListener(type, listener, options);
    });
  }

  function requestStop() {
    stopRequested = true;
  }

  function mountStopButton() {
    if (document.querySelector("[" + recorderUiAttribute + "]")) {
      return true;
    }
    if (stopRequested) {
      return true;
    }
    const parent = document.body || document.documentElement;
    if (!(parent instanceof HTMLElement)) {
      return false;
    }

    const host = document.createElement("div");
    host.setAttribute(recorderUiAttribute, "true");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = [
      ":host {",
      "  all: initial;",
      "  display: block;",
      "  position: fixed;",
      "  top: 16px;",
      "  right: 16px;",
      "  z-index: 2147483647;",
      "  pointer-events: auto;",
      "  color-scheme: only light;",
      "  contain: content;",
      "  isolation: isolate;",
      "}",
      "button {",
      "  appearance: none;",
      "  border: 1px solid rgba(15, 23, 42, 0.2);",
      "  border-radius: 999px;",
      "  background: rgba(15, 23, 42, 0.92);",
      "  color: #ffffff;",
      "  color-scheme: only light;",
      "  cursor: pointer;",
      "  font: 600 12px/1.2 ui-sans-serif, system-ui, sans-serif;",
      "  letter-spacing: 0.01em;",
      "  padding: 10px 14px;",
      "  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.22);",
      "}",
      "button:hover {",
      "  background: rgba(15, 23, 42, 0.98);",
      "}",
      "button:focus-visible {",
      "  outline: 2px solid #2563eb;",
      "  outline-offset: 2px;",
      "}",
    ].join("\n");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Stop recording";
    button.setAttribute("aria-label", "Stop recording");
    const consumePointerEvent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      button.addEventListener(type, consumePointerEvent);
    }
    button.addEventListener("click", () => {
      requestStop();
      host.remove();
    });
    shadowRoot.append(style, button);
    parent.appendChild(host);
    cleanup.push(() => {
      host.remove();
    });
    return true;
  }

  function ensureStopButtonMounted() {
    if (mountStopButton()) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (!mountStopButton()) {
        return;
      }
      observer.disconnect();
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
    });
    cleanup.push(() => {
      observer.disconnect();
    });
  }

  addListener(document, "click", (event) => {
    if (!event.isTrusted) {
      return;
    }
    const target = nearestRecordTarget(event.target);
    if (!(target instanceof Element)) {
      return;
    }
    const tag = target.tagName.toLowerCase();
    if (tag === "select" || tag === "option") {
      return;
    }
    const selector = buildSelector(target);
    if (!selector) {
      return;
    }
    enqueue({
      kind: "click",
      selector,
      button: event.button,
      modifiers: modifierKeys(event),
    });
  }, true);

  addListener(document, "dblclick", (event) => {
    if (!event.isTrusted) {
      return;
    }
    const target = nearestRecordTarget(event.target);
    if (!(target instanceof Element)) {
      return;
    }
    const selector = buildSelector(target);
    if (!selector) {
      return;
    }
    enqueue({
      kind: "dblclick",
      selector,
    });
  }, true);

  addListener(document, "input", (event) => {
    if (!event.isTrusted) {
      return;
    }
    const target = nearestRecordTarget(event.target);
    if (!(target instanceof Element)) {
      return;
    }
    const selector = buildSelector(target);
    const text = readTargetValue(target);
    if (!selector || typeof text !== "string") {
      return;
    }
    pendingInputs.set(selector, {
      selector,
      text,
      timestamp: now(),
    });
    scheduleInputFlush(selector);
  }, true);

  addListener(document, "change", (event) => {
    if (!event.isTrusted) {
      return;
    }
    const target = nearestRecordTarget(event.target);
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }
    const selector = buildSelector(target);
    if (!selector) {
      return;
    }
    const selectedOption = target.selectedOptions && target.selectedOptions.length > 0
      ? target.selectedOptions[0]
      : undefined;
    enqueue({
      kind: "select-option",
      selector,
      value: target.value,
      ...(selectedOption === undefined ? {} : { label: selectedOption.label || selectedOption.textContent || "" }),
    });
  }, true);

  addListener(document, "keydown", (event) => {
    if (!event.isTrusted) {
      return;
    }
    const allowedKeys = new Set([
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "Backspace",
      "Delete",
      "Enter",
      "Escape",
      "Tab",
    ]);
    if (!allowedKeys.has(event.key)) {
      return;
    }
    const target = nearestRecordTarget(event.target);
    const selector = target instanceof Element ? buildSelector(target) : undefined;
    if (event.key === "Enter" && selector) {
      flushPendingInput(selector);
    }
    enqueue({
      kind: "keypress",
      key: event.key,
      modifiers: modifierKeys(event),
      ...(selector === undefined ? {} : { selector }),
    });
  }, true);

  addListener(document, "wheel", (event) => {
    if (!event.isTrusted) {
      return;
    }
    const target = nearestRecordTarget(event.target);
    const selector = target instanceof Element ? buildSelector(target) : undefined;
    if (pendingWheel && pendingWheel.selector === selector) {
      pendingWheel.deltaX += event.deltaX;
      pendingWheel.deltaY += event.deltaY;
      clearTimeout(pendingWheel.timerId);
      pendingWheel.timerId = setTimeout(flushPendingWheel, 250);
      return;
    }
    flushPendingWheel();
    pendingWheel = {
      selector,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      timestamp: now(),
      timerId: setTimeout(flushPendingWheel, 250),
    };
  }, true);

  const originalPushState = history.pushState.bind(history);
  history.pushState = function pushState(state, unused, url) {
    const beforeUrl = location.href;
    const output = originalPushState.apply(this, arguments);
    const nextUrl = location.href;
    if (nextUrl !== beforeUrl) {
      updateHistoryState("push", nextUrl);
      enqueue({
        kind: "navigate",
        url: nextUrl,
        source: "push-state",
      });
    }
    return output;
  };
  cleanup.push(() => {
    history.pushState = originalPushState;
  });

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function replaceState(state, unused, url) {
    const beforeUrl = location.href;
    const output = originalReplaceState.apply(this, arguments);
    const nextUrl = location.href;
    if (nextUrl !== beforeUrl) {
      updateHistoryState("replace", nextUrl);
      enqueue({
        kind: "navigate",
        url: nextUrl,
        source: "replace-state",
      });
    }
    return output;
  };
  cleanup.push(() => {
    history.replaceState = originalReplaceState;
  });

  addListener(globalScope, "popstate", () => {
    const currentUrl = location.href;
    const traversal = classifyHistoryTraversal(currentUrl);
    if (traversal === "go-back" || traversal === "go-forward") {
      enqueue({
        kind: traversal,
        url: currentUrl,
      });
      return;
    }
    const state = readHistoryState();
    if (state?.entries[state.index] !== currentUrl) {
      updateHistoryState("push", currentUrl);
      enqueue({
        kind: "navigate",
        url: currentUrl,
        source: "history-traversal",
      });
    }
  });

  addListener(globalScope, "hashchange", () => {
    const currentUrl = location.href;
    updateHistoryState("replace", currentUrl);
    enqueue({
      kind: "navigate",
      url: currentUrl,
      source: "hashchange",
    });
  });

  function drain() {
    flushAllInputs();
    flushPendingWheel();
    return {
      url: location.href,
      focused: document.hasFocus(),
      visibilityState: document.visibilityState,
      stopRequested,
      events: queue.splice(0, queue.length),
    };
  }

  globalScope[recorderKey] = {
    installed: true,
    debugSelector(target) {
      return buildSelector(target);
    },
    drain,
    requestStop,
    dispose() {
      flushAllInputs();
      flushPendingWheel();
      for (const dispose of cleanup.splice(0, cleanup.length)) {
        dispose();
      }
      for (const timerId of inputFlushTimers.values()) {
        clearTimeout(timerId);
      }
      inputFlushTimers.clear();
      pendingInputs.clear();
      delete globalScope[recorderKey];
    },
  };

  if (options.showStopButton) {
    ensureStopButtonMounted();
  }
  onInstall();
})();`;
}

export const FLOW_RECORDER_INSTALL_SCRIPT = createFlowRecorderInstallScript();

export const FLOW_RECORDER_DRAIN_SCRIPT = String.raw`(() => {
  const recorder = globalThis.__opensteerFlowRecorder;
  if (!recorder || typeof recorder.drain !== "function") {
    return {
      url: location.href,
      focused: document.hasFocus(),
      visibilityState: document.visibilityState,
      stopRequested: false,
      events: [],
    };
  }
  return recorder.drain();
})();`;
