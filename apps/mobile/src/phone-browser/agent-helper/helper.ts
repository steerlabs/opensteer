import type { BrowserAction, BrowserActionLocator } from "@opensteer/protocol/browser-actions";

const MAX_NODES = 10_000;
const MAX_DEPTH = 128;
const browserActionMaxBytes = 432 * 1_024;
type HelperAction = Extract<
  BrowserAction,
  {
    type: "dom.query" | "dom.snapshot" | "dom.act" | "pointer.tap" | "scroll";
  }
>;
interface WaitArguments {
  id: string;
  locator: BrowserActionLocator;
  state: "attached" | "detached" | "visible" | "hidden";
}
type ErrorCode =
  | "unsupported-operation"
  | "stale-document"
  | "not-found"
  | "ambiguous"
  | "not-actionable"
  | "too-large"
  | "timeout"
  | "outcome-unknown";

export class PhoneHelperError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "PhoneHelperError";
    this.code = code;
  }
}

function fail(code: ErrorCode, message: string): never {
  throw new PhoneHelperError(code, message);
}
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("unsupported-operation", "Expected a fixed argument object");
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("unsupported-operation", "Unknown helper argument");
  return value as Record<string, unknown>;
}
function string(value: unknown, min: number, max: number): asserts value is string {
  if (typeof value !== "string" || value.length < min || value.length > max)
    fail("unsupported-operation", `Expected a string of ${min} to ${max} characters`);
}
function oneOf(value: unknown, allowed: readonly unknown[]) {
  if (!allowed.includes(value)) fail("unsupported-operation", "Unsupported helper argument");
}
function number(value: unknown, min: number, max: number, integer = false) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    fail("unsupported-operation", "Number is outside the helper bounds");
}
function checkLocator(value: unknown, depth = 0): asserts value is BrowserActionLocator {
  if (depth >= 8) fail("unsupported-operation", "Locator scope exceeds eight levels");
  const target = fields(value, [
    "by",
    "value",
    "name",
    "exact",
    "scope",
    "position",
    "hasText",
    "hasNotText",
    "visible",
  ]);
  oneOf(target.by, ["css", "role", "text", "label"]);
  string(target.value, 1, 4096);
  for (const key of ["name", "hasText", "hasNotText"])
    if (target[key] !== undefined) string(target[key], 0, 4096);
  for (const key of ["exact", "visible"])
    if (target[key] !== undefined) oneOf(target[key], [true, false]);
  if (target.position !== undefined && target.position !== "first" && target.position !== "last")
    number(target.position, 0, 10_000, true);
  if (target.scope !== undefined) checkLocator(target.scope, depth + 1);
}
function checkAction(value: unknown): HelperAction {
  const action = fields(value, [
    "type",
    "locator",
    "scope",
    "frameId",
    "read",
    "attribute",
    "kind",
    "value",
    "values",
    "button",
    "clickCount",
    "selection",
    "x",
    "y",
    "count",
    "deltaX",
    "deltaY",
  ]);
  switch (action.type) {
    case "dom.query":
      fields(value, ["type", "locator", "read", "attribute"]);
      checkLocator(action.locator);
      oneOf(action.read, [
        "count",
        "textContent",
        "innerText",
        "allInnerTexts",
        "inputValue",
        "attribute",
        "visible",
        "checked",
        "enabled",
      ]);
      if (action.read === "attribute") string(action.attribute, 1, 255);
      else if (action.attribute !== undefined)
        fail("unsupported-operation", "Only attribute reads accept an attribute");
      break;
    case "dom.snapshot":
      fields(value, ["type", "scope", "frameId"]);
      if (action.scope !== undefined) checkLocator(action.scope);
      if (action.frameId !== undefined) string(action.frameId, 1, 255);
      break;
    case "dom.act":
      fields(value, [
        "type",
        "locator",
        "kind",
        "value",
        "values",
        "button",
        "clickCount",
        "selection",
      ]);
      checkLocator(action.locator);
      oneOf(action.kind, [
        "click",
        "focus",
        "fill",
        "clear",
        "check",
        "uncheck",
        "setChecked",
        "selectOption",
      ]);
      if (action.selection !== undefined) {
        if (action.kind !== "focus")
          fail("unsupported-operation", "Only focus accepts a selection");
        oneOf(action.selection, ["end"]);
      }
      if (action.kind === "fill") string(action.value, 0, 10_000);
      else if (action.kind === "setChecked") oneOf(action.value, [true, false]);
      else if (action.value !== undefined)
        fail("unsupported-operation", "This action does not accept a value");
      if (action.kind === "selectOption") {
        if (!Array.isArray(action.values) || action.values.length > 100)
          fail("unsupported-operation", "Select accepts at most 100 values");
        for (const option of action.values) string(option, 0, 10_000);
      } else if (action.values !== undefined)
        fail("unsupported-operation", "Only select accepts values");
      if (action.kind === "click") {
        if (action.button !== undefined) oneOf(action.button, ["left"]);
        if (action.clickCount !== undefined) oneOf(action.clickCount, [1, 2]);
      } else if (action.button !== undefined || action.clickCount !== undefined)
        fail("unsupported-operation", "Only clicks accept button and count");
      break;
    case "pointer.tap":
      fields(value, ["type", "x", "y", "count"]);
      number(action.x, 0, 32_768);
      number(action.y, 0, 32_768);
      oneOf(action.count, [1, 2]);
      break;
    case "scroll":
      fields(value, ["type", "locator", "x", "y", "deltaX", "deltaY"]);
      checkLocator(action.locator);
      number(action.deltaX, -100_000, 100_000);
      number(action.deltaY, -100_000, 100_000);
      for (const coordinate of ["x", "y"])
        if (action[coordinate] !== undefined) number(action[coordinate], 0, 32_768);
      break;
    default:
      fail("unsupported-operation", "Invalid fixed helper action");
  }
  return value as HelperAction;
}
const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/gu, " ").trim();
const matches = (value: string, pattern: string, exact = false) =>
  exact
    ? normalize(value) === normalize(pattern)
    : normalize(value).toLowerCase().includes(normalize(pattern).toLowerCase());
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const composedParent = (element: Element): Element | null =>
  element.parentElement ??
  (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
const contains = (ancestor: Element, element: Element): boolean => {
  for (let current: Element | null = element; current; current = composedParent(current))
    if (current === ancestor) return true;
  return false;
};

export function createAgentHelper(documentId: string) {
  const pending = new Map<string, (error?: PhoneHelperError) => void>();
  const operations = new Map<string, AbortController>();
  const textPlans = new Map<string, { element: Element; text: string; clear: boolean }>();
  let textPlanSequence = 0;
  const activations = new Map<
    string,
    {
      element: Element;
      x: number;
      y: number;
      count: number;
      kind: "file" | "click" | "tap";
      rect: DOMRect;
    }
  >();
  let activationSequence = 0;
  const planActivation = (
    element: Element,
    x: number,
    y: number,
    count: number,
    kind: "file" | "click" | "tap",
  ) => {
    activations.clear();
    const planId = String(++activationSequence);
    activations.set(planId, { element, x, y, count, kind, rect: element.getBoundingClientRect() });
    return { kind: "script-activation" as const, planId };
  };
  let disposed = false;

  const walk = (root: Document | ShadowRoot | Element, budget = { visited: 0 }): Element[] => {
    const result: Element[] = [];
    const visit = (node: Document | ShadowRoot | Element, depth: number) => {
      if (depth > MAX_DEPTH) fail("too-large", "DOM depth exceeds 128; narrow the scope");
      for (const child of node.children) {
        if (++budget.visited > MAX_NODES)
          fail("too-large", "DOM traversal exceeds 10000 nodes; narrow the scope");
        result.push(child);
        if (child.shadowRoot) visit(child.shadowRoot, depth + 1);
        visit(child, depth + 1);
      }
    };
    if (root instanceof Element && root.shadowRoot) visit(root.shadowRoot, 0);
    visit(root, 0);
    return result;
  };
  const hidden = (element: Element) => {
    for (let current: Element | null = element; current; current = composedParent(current)) {
      if (
        current.hasAttribute("hidden") ||
        current.hasAttribute("inert") ||
        current.getAttribute("aria-hidden") === "true" ||
        ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"].includes(current.tagName)
      )
        return true;
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.contentVisibility === "hidden"
      )
        return true;
    }
    return false;
  };
  const visible = (element: Element) =>
    element.isConnected &&
    !hidden(element) &&
    Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
  const enabled = (element: Element) => {
    if (element.matches(":disabled")) return false;
    for (let current: Element | null = element; current; current = composedParent(current))
      if (current.getAttribute("aria-disabled") === "true") return false;
    return true;
  };
  const renderedText = (node: Node, includeHidden = false): string => {
    let visited = 0;
    let length = 0;
    const visit = (current: Node, depth: number): string => {
      if (++visited > MAX_NODES || depth > MAX_DEPTH)
        fail("too-large", "Text traversal exceeds the page budget; narrow the scope");
      if (current.nodeType === Node.TEXT_NODE) {
        const value = current.nodeValue ?? "";
        length += value.length;
        if (length > browserActionMaxBytes)
          fail("too-large", "Text exceeds the page budget; narrow the scope");
        return value;
      }
      if (
        current instanceof Element &&
        (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"].includes(current.tagName) ||
          (!includeHidden && hidden(current)))
      )
        return "";
      return (
        Array.from(current.childNodes)
          .map((child) => visit(child, depth + 1))
          .join("") +
        (current instanceof Element && current.shadowRoot
          ? visit(current.shadowRoot, depth + 1)
          : "")
      );
    };
    return normalize(visit(node, 0));
  };
  const rawText = (element: Element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let size = 0;
    let count = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++count > MAX_NODES) fail("too-large", "Text traversal exceeds 10000 nodes");
      const value = node.nodeValue ?? "";
      size += value.length;
      if (size > browserActionMaxBytes - 128) fail("too-large", "Text exceeds the page budget");
      parts.push(value);
    }
    return parts.join("");
  };
  const labelNames = (element: Element): string[] => {
    const ids = element.getAttribute("aria-labelledby");
    if (ids) {
      const root = element.getRootNode() as Document | ShadowRoot;
      const names = ids
        .split(/\s+/u)
        .map((id) => root.getElementById(id))
        .filter((node): node is HTMLElement => node !== null)
        .map((node) => renderedText(node, true));
      if (names.length) return [names.join(" ")];
    }
    if (element.hasAttribute("aria-label")) return [element.getAttribute("aria-label") ?? ""];
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    )
      return Array.from(element.labels ?? []).map((label) => renderedText(label));
    return [];
  };
  const name = (element: Element) => {
    const labels = labelNames(element);
    if (labels.length) return normalize(labels.join(" "));
    if (
      ["IMG", "AREA"].includes(element.tagName) ||
      (element instanceof HTMLInputElement && element.type === "image")
    )
      return element.getAttribute("alt") ?? "";
    if (element instanceof HTMLInputElement && ["submit", "reset", "button"].includes(element.type))
      return (
        element.value ||
        (element.type === "submit" ? "Submit" : element.type === "reset" ? "Reset" : "")
      );
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    )
      return element.getAttribute("title") ?? "";
    return renderedText(element) || element.getAttribute("title") || "";
  };
  const role = (element: Element): string => {
    const explicit = element.getAttribute("role")?.trim().split(/\s+/u)[0];
    if (explicit) return explicit;
    if (element instanceof HTMLInputElement) {
      if (["hidden", "password"].includes(element.type))
        return element.type === "password" ? "textbox" : "";
      if (["submit", "reset", "button", "image"].includes(element.type)) return "button";
      return (
        (
          {
            checkbox: "checkbox",
            radio: "radio",
            number: "spinbutton",
            range: "slider",
            search: "searchbox",
          } as Record<string, string>
        )[element.type] ?? "textbox"
      );
    }
    if (element instanceof HTMLSelectElement)
      return element.multiple || element.size > 1 ? "listbox" : "combobox";
    if (/^H[1-6]$/u.test(element.tagName)) return "heading";
    if (["A", "AREA"].includes(element.tagName)) return element.hasAttribute("href") ? "link" : "";
    if (element.tagName === "IMG" && element.getAttribute("alt") === "") return "";
    if (element.tagName === "SECTION" || element.tagName === "FORM")
      return labelNames(element).length ? (element.tagName === "FORM" ? "form" : "region") : "";
    if (element.tagName === "TH")
      return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
    return (
      (
        {
          BUTTON: "button",
          TEXTAREA: "textbox",
          IMG: "img",
          NAV: "navigation",
          MAIN: "main",
          ASIDE: "complementary",
          HEADER: "banner",
          FOOTER: "contentinfo",
          DIALOG: "dialog",
          UL: "list",
          OL: "list",
          LI: "listitem",
          TABLE: "table",
          TR: "row",
          TD: "cell",
          THEAD: "rowgroup",
          TBODY: "rowgroup",
          TFOOT: "rowgroup",
          OPTION: "option",
          OPTGROUP: "group",
          FIELDSET: "group",
          SUMMARY: "button",
          DETAILS: "group",
          PROGRESS: "progressbar",
          METER: "meter",
          HR: "separator",
          OUTPUT: "status",
        } as Record<string, string>
      )[element.tagName] ?? ""
    );
  };
  const resolve = (description: BrowserActionLocator): Element[] => {
    const scopes = description.scope ? resolve(description.scope) : [document];
    const budget = { visited: 0 };
    const candidates = [...new Set(scopes.flatMap((scope) => walk(scope, budget)))].filter(
      (element) => !hidden(element),
    );
    let found = candidates.filter((element) => {
      switch (description.by) {
        case "css":
          try {
            return element.matches(description.value);
          } catch {
            return fail("unsupported-operation", "Invalid CSS locator");
          }
        case "role":
          return (
            role(element) === description.value &&
            (description.name === undefined ||
              matches(name(element), description.name, description.exact))
          );
        case "label":
          return labelNames(element).some((label) =>
            matches(label, description.value, description.exact),
          );
        case "text":
          return matches(renderedText(element), description.value, description.exact);
      }
    });
    if (description.by === "text") {
      const ancestors = new Set<Element>();
      const matched = new Set(found);
      for (const element of found)
        for (let current = composedParent(element); current; current = composedParent(current)) {
          if (ancestors.has(current)) break;
          if (matched.has(current)) ancestors.add(current);
        }
      found = found.filter((element) => !ancestors.has(element));
    }
    found = found.filter(
      (element) =>
        (description.visible === undefined || visible(element) === description.visible) &&
        (description.hasText === undefined ||
          matches(renderedText(element), description.hasText)) &&
        (description.hasNotText === undefined ||
          !matches(renderedText(element), description.hasNotText)),
    );
    if (description.position !== undefined) {
      const selected =
        found[
          description.position === "first"
            ? 0
            : description.position === "last"
              ? found.length - 1
              : description.position
        ];
      return selected ? [selected] : [];
    }
    return found;
  };
  const single = (description: BrowserActionLocator) => {
    const matches = resolve(description);
    if (!matches.length) return fail("not-found", "No element matches; inspect the page again");
    if (matches.length !== 1)
      return fail("ambiguous", `${matches.length} elements match; add a name, scope or position`);
    return matches[0]!;
  };
  const frame = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const aborted = () => {
        cancelAnimationFrame(animation);
        reject(new PhoneHelperError("timeout", "Native canceled input before submission"));
      };
      const animation = requestAnimationFrame(() => {
        signal.removeEventListener("abort", aborted);
        resolve();
      });
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  const hitAt = (x: number, y: number) => {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const deeper = hit.shadowRoot.elementFromPoint?.(x, y);
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    return hit;
  };
  const prepare = (description: BrowserActionLocator, signal: AbortSignal) =>
    new Promise<{ element: Element; x: number; y: number }>((resolveReady, reject) => {
      let previous: { element: Element; rect: DOMRect } | undefined;
      let scrolled: Element | undefined;
      let animation: number | undefined;
      let ended = false;
      let reason = "No element matches";
      const observer = new MutationObserver(() => check(false));
      const cleanup = () => {
        ended = true;
        observer.disconnect();
        if (animation !== undefined) cancelAnimationFrame(animation);
        signal.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        cleanup();
        reject(
          new PhoneHelperError("timeout", `${reason}; native canceled input before submission`),
        );
      };
      const check = (onFrame: boolean) => {
        if (ended) return;
        try {
          const element = single(description);
          if (scrolled !== element) {
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
            scrolled = element;
          }
          const rect = element.getBoundingClientRect();
          if (!visible(element) || !enabled(element))
            fail("not-actionable", "The element is hidden, inert or disabled");
          if (
            !onFrame ||
            previous?.element !== element ||
            Math.abs(previous.rect.x - rect.x) > 0.5 ||
            Math.abs(previous.rect.y - rect.y) > 0.5 ||
            Math.abs(previous.rect.width - rect.width) > 0.5 ||
            Math.abs(previous.rect.height - rect.height) > 0.5
          ) {
            previous = { element, rect };
            fail("not-actionable", "The element has not settled yet");
          }
          const x =
            Math.max(0, rect.left) +
            (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2;
          const y =
            Math.max(0, rect.top) +
            (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2;
          if (
            rect.right <= 0 ||
            rect.bottom <= 0 ||
            rect.left >= innerWidth ||
            rect.top >= innerHeight
          )
            fail("not-actionable", "The element is outside the viewport");
          const hit = hitAt(x, y);
          if (!hit || !contains(element, hit)) fail("not-actionable", "The element is covered");
          cleanup();
          resolveReady({ element, x, y });
          return;
        } catch (error) {
          if (
            !(error instanceof PhoneHelperError) ||
            !["not-found", "not-actionable"].includes(error.code)
          ) {
            cleanup();
            reject(error);
            return;
          }
          reason = error.message;
        }
        if (animation === undefined)
          animation = requestAnimationFrame(() => {
            animation = undefined;
            check(true);
          });
      };
      signal.addEventListener("abort", aborted, { once: true });
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      if (signal.aborted || disposed) aborted();
      else check(false);
    });
  const focus = (element: Element, editable = true) => {
    if (
      !(element instanceof HTMLElement) ||
      (editable &&
        !(element instanceof HTMLInputElement) &&
        !(element instanceof HTMLTextAreaElement) &&
        !element.isContentEditable)
    )
      fail("not-actionable", "Native text insertion requires an editable field");
    if (
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      editable &&
      element.readOnly
    )
      fail("not-actionable", "The field is read-only");
    element.focus({ preventScroll: true });
    if (
      document.activeElement !== element &&
      element.getRootNode() instanceof ShadowRoot &&
      (element.getRootNode() as ShadowRoot).activeElement !== element
    )
      fail("not-actionable", "The field could not be focused");
    if (element.getRootNode() === document && document.activeElement !== element)
      fail("not-actionable", "The field could not be focused");
  };
  const formEvents = (element: Element) => {
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const snapshot = (scope?: BrowserActionLocator) => {
    const roots = scope ? [single(scope)] : [document.documentElement];
    const lines: string[] = [];
    let size = 0;
    for (const root of roots)
      for (const element of [root, ...walk(root)]) {
        if (hidden(element)) continue;
        const semantic = role(element);
        const content = semantic
          ? name(element)
          : Array.from(element.childNodes)
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.nodeValue ?? "")
              .join(" ");
        if (!semantic && !normalize(content)) continue;
        let line = `- ${semantic || "text"} ${JSON.stringify(normalize(content))}`;
        if (
          element instanceof HTMLInputElement &&
          ["checkbox", "radio"].includes(element.type) &&
          element.checked
        )
          line += " [checked]";
        for (const state of ["checked", "expanded", "pressed", "selected"]) {
          const value = element.getAttribute(`aria-${state}`);
          if (
            value === "true" &&
            !(state === "checked" && element instanceof HTMLInputElement && element.checked)
          )
            line += ` [${state}]`;
          if (value === "mixed") line += ` [${state}=mixed]`;
        }
        if (semantic === "heading" && /^H[1-6]$/u.test(element.tagName))
          line += ` [level=${element.tagName.slice(1)}]`;
        if (!enabled(element)) line += " [disabled]";
        if (
          element instanceof HTMLInputElement &&
          element.type !== "password" &&
          ["text", "email", "search", "url", "tel"].includes(element.type)
        )
          line += `: ${JSON.stringify(element.value)}`;
        size += new TextEncoder().encode(line).length + 1;
        if (size > browserActionMaxBytes - 128)
          fail("too-large", "Snapshot exceeds 432 KiB; narrow the scope");
        lines.push(line);
      }
    return { type: "dom.snapshot" as const, text: lines.join("\n") };
  };
  const query = (action: Extract<BrowserAction, { type: "dom.query" }>) => {
    const found = resolve(action.locator);
    if (action.read === "count") return { type: "dom.query" as const, value: found.length };
    if (action.read === "allInnerTexts")
      return {
        type: "dom.query" as const,
        value: found.map((element) => {
          const value = renderedText(element);
          if (value.length > 10_000) fail("too-large", "A text item exceeds 10000 characters");
          return value;
        }),
      };
    if (action.read === "visible" && !found.length)
      return { type: "dom.query" as const, value: false };
    const element = single(action.locator);
    let value: string | boolean | null;
    switch (action.read) {
      case "textContent":
        value = rawText(element);
        break;
      case "innerText":
        value = renderedText(element);
        break;
      case "inputValue":
        if (!(
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ))
          return fail("not-actionable", "inputValue requires an input, textarea or select");
        value =
          element instanceof HTMLInputElement && element.type === "password" ? null : element.value;
        break;
      case "attribute":
        if (
          !action.attribute ||
          /^on/iu.test(action.attribute) ||
          action.attribute.toLowerCase() === "srcdoc"
        )
          return fail("unsupported-operation", "Executable attributes are unavailable");
        value =
          element instanceof HTMLInputElement &&
          element.type === "password" &&
          action.attribute.toLowerCase() === "value"
            ? null
            : element.getAttribute(action.attribute);
        break;
      case "visible":
        value = visible(element);
        break;
      case "enabled":
        value = enabled(element);
        break;
      case "checked":
        if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type))
          value = element.checked;
        else if (["checkbox", "radio", "switch"].includes(role(element)))
          value = element.getAttribute("aria-checked") === "true";
        else return fail("not-actionable", "isChecked requires a checkbox or radio");
        break;
    }
    return { type: "dom.query" as const, value };
  };
  const act = async (action: Extract<BrowserAction, { type: "dom.act" }>, signal: AbortSignal) => {
    const { element, x, y } = await prepare(action.locator, signal);
    if (signal.aborted || disposed) fail("timeout", "Native canceled input before submission");
    if (action.kind === "focus") {
      focus(element, action.selection === "end");
      if (action.selection === "end") {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          if (element.selectionStart === null)
            fail("not-actionable", "This input does not support positioning its caret for append");
          const end = element.value.length;
          element.setSelectionRange(end, end);
        } else {
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          const selection = getSelection();
          if (!selection) fail("not-actionable", "The field selection is unavailable");
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      return { type: "dom.act" as const, outcome: "acted" as const, trusted: false };
    }
    if (action.kind === "fill" || action.kind === "clear") {
      const value = action.kind === "clear" ? "" : String(action.value);
      if (
        element instanceof HTMLInputElement &&
        ["date", "datetime-local", "month", "time", "week", "color", "range"].includes(element.type)
      ) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          element,
          value,
        );
        formEvents(element);
        return {
          type: "dom.act" as const,
          outcome: action.kind === "clear" ? ("cleared" as const) : ("filled" as const),
          trusted: false,
        };
      }
      if (
        element instanceof HTMLInputElement &&
        !["text", "search", "email", "url", "tel", "password", "number"].includes(element.type)
      )
        fail("not-actionable", "Use check, selectOption or the native file chooser for this field");
      focus(element);
      textPlans.clear();
      const planId = String(++textPlanSequence);
      textPlans.set(planId, { element, text: value, clear: action.kind === "clear" });
      return { kind: "native-text" as const, clear: true, text: value, planId };
    }
    if (["check", "uncheck", "setChecked"].includes(action.kind)) {
      if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type))
        fail("not-actionable", "Fixed checking supports native checkbox and radio inputs only");
      const checked =
        action.kind === "setChecked" ? action.value === true : action.kind === "check";
      if (element.type === "radio" && !checked)
        fail("not-actionable", "A radio cannot be unchecked directly");
      if (element.checked !== checked) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!.set!.call(
          element,
          checked,
        );
        formEvents(element);
      }
      return {
        type: "dom.act" as const,
        outcome: checked ? ("checked" as const) : ("unchecked" as const),
        trusted: false,
      };
    }
    if (action.kind === "selectOption") {
      if (!(element instanceof HTMLSelectElement))
        fail("not-actionable", "selectOption requires a native select");
      const values = action.values ?? [];
      if (!element.multiple && values.length > 1)
        fail("not-actionable", "This select accepts at most one option value");
      const options = Array.from(element.options);
      for (const value of values)
        if (
          !options.some(
            (option) =>
              option.value === value &&
              !option.disabled &&
              !(
                option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled
              ),
          )
        )
          fail("not-found", "A requested enabled option does not exist");
      for (const option of options)
        Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, "selected")!.set!.call(
          option,
          values.includes(option.value),
        );
      if (!values.length)
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex")!.set!.call(
          element,
          -1,
        );
      formEvents(element);
      return {
        type: "dom.act" as const,
        outcome: "selected" as const,
        trusted: false,
        values: Array.from(element.selectedOptions).map((option) => option.value),
      };
    }
    return planActivation(element, x, y, action.clickCount ?? 1, "click");
  };
  const click = (element: Element, x: number, y: number, clickCount: number) => {
    let submitted = false;
    try {
      const dispatch = (type: string, count: number, buttons: number) => {
        submitted = true;
        if (disposed || !element.isConnected)
          fail("outcome-unknown", "The target disappeared during the tap; inspect the page");
        const parameters = {
          bubbles: !type.endsWith("enter"),
          cancelable: !type.endsWith("enter"),
          composed: !type.endsWith("enter"),
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
          detail: count,
        };
        return element.dispatchEvent(
          type.startsWith("pointer")
            ? new PointerEvent(type, {
                ...parameters,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
              })
            : new MouseEvent(type, parameters),
        );
      };
      for (const event of [
        "pointerover",
        "pointerenter",
        "mouseover",
        "mouseenter",
        "pointermove",
        "mousemove",
      ])
        dispatch(event, 0, 0);
      for (let count = 1; count <= clickCount; count++) {
        const pointer = dispatch("pointerdown", count, 1);
        const mouse = pointer && dispatch("mousedown", count, 1);
        if (
          mouse &&
          element instanceof HTMLElement &&
          (element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element.isContentEditable)
        )
          element.focus({ preventScroll: true });
        dispatch("pointerup", count, 0);
        if (pointer) dispatch("mouseup", count, 0);
        dispatch("click", count, 0);
      }
      if (clickCount === 2) dispatch("dblclick", 2, 0);
      return { type: "dom.act" as const, outcome: "acted" as const, trusted: false };
    } catch (error) {
      if (submitted)
        fail(
          "outcome-unknown",
          "Tap was submitted but completion is unknown; inspect, never resend automatically",
        );
      throw error;
    }
  };
  const tap = async (
    action: Extract<BrowserAction, { type: "pointer.tap" }>,
    signal: AbortSignal,
  ) => {
    const element = hitAt(action.x, action.y);
    if (!element || !visible(element) || !enabled(element))
      fail("not-actionable", "No enabled visible element at this point");
    const before = element.getBoundingClientRect();
    await frame(signal);
    await frame(signal);
    const rect = element.getBoundingClientRect();
    if (signal.aborted || disposed) fail("timeout", "Native canceled the tap before submission");
    if (
      element !== hitAt(action.x, action.y) ||
      !visible(element) ||
      !enabled(element) ||
      Math.abs(before.x - rect.x) > 0.5 ||
      Math.abs(before.y - rect.y) > 0.5 ||
      Math.abs(before.width - rect.width) > 0.5 ||
      Math.abs(before.height - rect.height) > 0.5
    )
      fail("not-actionable", "The point's target moved or changed; inspect again");
    return planActivation(element, action.x, action.y, action.count, "tap");
  };
  const wait = (args: WaitArguments) => {
    if (pending.size >= 32 || pending.has(args.id))
      fail("too-large", "Too many waits or duplicate wait ID");
    return new Promise<{ type: "dom.wait" }>((resolveWait, reject) => {
      let animation: number | undefined;
      const observed = new Set<ShadowRoot>();
      const observer = new MutationObserver(check);
      const finish = (error?: PhoneHelperError) => {
        observer.disconnect();
        if (animation !== undefined) cancelAnimationFrame(animation);
        document.removeEventListener("readystatechange", check);
        pending.delete(args.id);
        if (error) reject(error);
        else resolveWait({ type: "dom.wait" });
      };
      function check() {
        if (!pending.has(args.id)) return;
        try {
          for (const element of walk(document))
            if (element.shadowRoot && !observed.has(element.shadowRoot)) {
              observer.observe(element.shadowRoot, {
                subtree: true,
                childList: true,
                attributes: true,
                characterData: true,
              });
              observed.add(element.shadowRoot);
            }
          const found = resolve(args.locator);
          const shown = found.some(visible);
          const done =
            args.state === "attached"
              ? found.length > 0
              : args.state === "detached"
                ? found.length === 0
                : args.state === "visible"
                  ? shown
                  : !shown;
          if (done) {
            finish();
            return;
          }
          if (animation === undefined)
            animation = requestAnimationFrame(() => {
              animation = undefined;
              check();
            });
        } catch (error) {
          finish(
            error instanceof PhoneHelperError
              ? error
              : new PhoneHelperError("not-actionable", "Locator wait failed"),
          );
        }
      }
      pending.set(args.id, finish);
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      document.addEventListener("readystatechange", check);
      check();
    });
  };

  const invokeChecked = async (input: unknown): Promise<unknown> => {
    const request = fields(input, ["documentId", "operationId", "name", "args"]);
    string(request.documentId, 1, 255);
    string(request.name, 1, 32);
    oneOf(request.name, [
      "query",
      "snapshot",
      "act",
      "tap",
      "focus",
      "scroll",
      "wait",
      "cancel",
      "fileChoose",
      "textResult",
      "textFocus",
      "commit",
    ]);
    if (request.operationId !== undefined) string(request.operationId, 1, 255);
    if (disposed || request.documentId !== documentId)
      fail("stale-document", "The helper belongs to another document");
    const { name: functionName, args } = request;
    const controller = new AbortController();
    const operationId = request.operationId;
    const mutating = ["act", "focus", "tap", "fileChoose", "textFocus", "commit"].includes(
      functionName,
    );
    if (mutating) {
      if (!operationId)
        fail("unsupported-operation", "Async input requires a native operationId for cancellation");
      if (operations.size >= 32 || operations.has(operationId))
        fail("too-large", "Too many inputs or duplicate operationId");
      operations.set(operationId, controller);
    }
    try {
      let result: unknown;
      if (functionName === "commit") {
        const commit = fields(args, ["planId"]);
        string(commit.planId, 1, 255);
        const plan = activations.get(commit.planId);
        activations.delete(commit.planId);
        if (!plan || !plan.element.isConnected || !visible(plan.element) || !enabled(plan.element))
          fail("not-actionable", "The prepared target changed");
        const rect = plan.element.getBoundingClientRect();
        const hit = hitAt(plan.x, plan.y);
        if (
          Math.abs(rect.x - plan.rect.x) > 0.5 ||
          Math.abs(rect.y - plan.rect.y) > 0.5 ||
          Math.abs(rect.width - plan.rect.width) > 0.5 ||
          Math.abs(rect.height - plan.rect.height) > 0.5 ||
          !hit ||
          !contains(plan.element, hit)
        )
          fail("not-actionable", "The prepared target moved");
        if (plan.kind === "file") {
          if (!(plan.element instanceof HTMLInputElement) || plan.element.type !== "file")
            fail("not-actionable", "The prepared input changed");
          plan.element.click();
          result = { chosen: true };
        } else {
          result = click(plan.element, plan.x, plan.y, plan.count);
          if (plan.kind === "tap") result = { kind: "untrusted-tap", trusted: false };
        }
      } else if (functionName === "cancel") {
        const cancel = fields(args, ["id"]);
        string(cancel.id, 1, 255);
        if (bytes(input) > browserActionMaxBytes)
          fail("too-large", "Helper arguments exceed 432 KiB");
        pending.get(cancel.id)?.(
          new PhoneHelperError("timeout", "Native deadline or cancellation ended the wait"),
        );
        operations.get(cancel.id)?.abort();
        result = { canceled: true };
      } else if (functionName === "textResult" || functionName === "textFocus") {
        const verification = fields(args, ["planId"]);
        string(verification.planId, 1, 255);
        const plan = textPlans.get(verification.planId);
        if (functionName === "textResult") textPlans.delete(verification.planId);
        if (!plan || !plan.element.isConnected)
          fail("not-actionable", "The original text field is no longer available");
        if (functionName === "textFocus") {
          if (!visible(plan.element) || !enabled(plan.element))
            fail("not-actionable", "The original text field is not actionable");
          focus(plan.element);
          return { focused: true };
        }
        const value =
          plan.element instanceof HTMLInputElement || plan.element instanceof HTMLTextAreaElement
            ? plan.element.value
            : rawText(plan.element);
        if (value !== plan.text)
          fail("not-actionable", "The page did not accept the requested text");
        result = { type: "dom.act", outcome: plan.clear ? "cleared" : "filled", trusted: true };
      } else if (functionName === "wait") {
        const waiting = fields(args, ["id", "locator", "state"]);
        string(waiting.id, 1, 255);
        checkLocator(waiting.locator);
        oneOf(waiting.state, ["attached", "detached", "visible", "hidden"]);
        if (bytes(input) > browserActionMaxBytes)
          fail("too-large", "Helper arguments exceed 432 KiB");
        result = await wait(args as WaitArguments);
      } else if (functionName === "fileChoose") {
        const target = fields(args, ["locator", "point"]);
        if ((target.locator === undefined) === (target.point === undefined))
          fail("unsupported-operation", "Choose one file target");
        let element: Element;
        if (target.locator !== undefined) {
          checkLocator(target.locator);
          element = (await prepare(target.locator, controller.signal)).element;
        } else {
          const point = fields(target.point, ["x", "y"]);
          number(point.x, 0, 32768);
          number(point.y, 0, 32768);
          const found = document.elementFromPoint(point.x as number, point.y as number);
          if (!found) fail("not-actionable", "The file target is not visible");
          element = found;
        }
        if (bytes(input) > browserActionMaxBytes)
          fail("too-large", "Helper arguments exceed 432 KiB");
        if (controller.signal.aborted || disposed)
          fail("timeout", "Native canceled file selection");
        if (
          !(element instanceof HTMLInputElement) ||
          element.type !== "file" ||
          !visible(element) ||
          !enabled(element)
        )
          fail("not-actionable", "The target is not an actionable file input");
        const rect = element.getBoundingClientRect();
        const point = target.point as { x: number; y: number } | undefined;
        result = planActivation(
          element,
          point?.x ?? rect.x + rect.width / 2,
          point?.y ?? rect.y + rect.height / 2,
          1,
          "file",
        );
      } else if (functionName === "focus") {
        const focusing = fields(args, ["locator"]);
        checkLocator(focusing.locator);
        if (bytes(input) > browserActionMaxBytes)
          fail("too-large", "Helper arguments exceed 432 KiB");
        focus((await prepare(focusing.locator, controller.signal)).element);
        result = { focused: true };
      } else {
        const action = checkAction(args);
        if (bytes(input) > browserActionMaxBytes)
          fail("too-large", "Helper arguments exceed 432 KiB");
        if (functionName === "query" && action.type === "dom.query") result = query(action);
        else if (functionName === "snapshot" && action.type === "dom.snapshot") {
          if (action.frameId !== undefined)
            fail(
              "unsupported-operation",
              "Native must invoke the helper in the registered frame; locators never enter frames",
            );
          result = snapshot(action.scope);
        } else if (functionName === "act" && action.type === "dom.act")
          result = await act(action, controller.signal);
        else if (functionName === "tap" && action.type === "pointer.tap")
          result = await tap(action, controller.signal);
        else if (functionName === "scroll" && action.type === "scroll" && action.locator) {
          const element = single(action.locator);
          if (!visible(element)) fail("not-actionable", "Scroll target is hidden");
          element.scrollBy({
            left: action.deltaX,
            top: action.deltaY,
            behavior: "instant",
          });
          result = { type: "scroll", x: element.scrollLeft, y: element.scrollTop, source: "dom" };
        } else
          fail(
            "unsupported-operation",
            "Only query, snapshot, act, tap, focus, scroll, wait and cancel are exposed",
          );
      }
      if (bytes(result) > browserActionMaxBytes - 128)
        fail("too-large", "Helper result exceeds 432 KiB; narrow the scope");
      if (result && typeof result === "object" && "values" in result) {
        const values = result.values;
        if (
          !Array.isArray(values) ||
          values.length > 100 ||
          values.some((value) => typeof value !== "string" || value.length > 10_000)
        )
          fail("too-large", "Selected values exceed the result bounds");
      }
      if (
        result &&
        typeof result === "object" &&
        "type" in result &&
        result.type === "scroll" &&
        (!("x" in result) ||
          !("y" in result) ||
          !Number.isFinite(result.x) ||
          !Number.isFinite(result.y))
      )
        fail("not-actionable", "Scroll position is unavailable");
      return result;
    } finally {
      if (mutating && operationId) operations.delete(operationId);
    }
  };
  const invoke = async (input: unknown): Promise<unknown> => {
    try {
      return await invokeChecked(input);
    } catch (error) {
      if (error instanceof PhoneHelperError) throw error;
      throw new PhoneHelperError("not-actionable", "The fixed helper operation failed");
    }
  };
  const dispose = () => {
    disposed = true;
    textPlans.clear();
    activations.clear();
    for (const operation of operations.values()) operation.abort();
    for (const finish of pending.values())
      finish(new PhoneHelperError("stale-document", "Document was replaced"));
  };
  return Object.freeze({ invoke, dispose });
}
