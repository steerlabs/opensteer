// This function is serialized into the page; all its helpers must stay inside it.
export function pageFunction(command, data = {}, ...nodes) {
  const parent = (node) => node.parentNode ?? node.getRootNode()?.host;
  const contains = (scope, node) => {
    for (let current = node; current; current = parent(current)) {
      if (current === scope) return true;
    }
    return false;
  };
  const normalize = (value) =>
    String(value ?? "")
      .replace(/\s+/gu, " ")
      .trim();
  const matches = (value, pattern, exact = false) => {
    value = normalize(value);
    if (pattern?.regex !== undefined) return new RegExp(pattern.regex, pattern.flags).test(value);
    return exact
      ? normalize(value) === normalize(pattern)
      : normalize(value).toLowerCase().includes(normalize(pattern).toLowerCase());
  };
  const walk = (scope) => {
    const result = [];
    const visit = (root) => {
      for (const child of root.children ?? []) {
        result.push(child);
        if (child.shadowRoot) visit(child.shadowRoot);
        visit(child);
      }
    };
    if (scope.shadowRoot) visit(scope.shadowRoot);
    visit(scope);
    return result;
  };
  const hiddenText = ["SCRIPT", "STYLE", "NOSCRIPT", "HEAD", "TEMPLATE"];
  const text = (node) => {
    if (hiddenText.includes(node.nodeName)) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node instanceof HTMLInputElement && ["button", "submit"].includes(node.type))
      return node.value;
    return [...node.childNodes].map(text).join("") + (node.shadowRoot ? text(node.shadowRoot) : "");
  };
  const labels = (element) => {
    const ids = element.getAttribute("aria-labelledby");
    if (ids) {
      const root = element.getRootNode();
      const referenced = ids
        .split(/\s+/u)
        .map((id) => root.getElementById?.(id))
        .filter(Boolean);
      if (referenced.length) return [referenced.map(text).join(" ")];
    }
    if (element.hasAttribute("aria-label")) return [element.getAttribute("aria-label")];
    return Array.from(element.labels ?? []).map(text);
  };
  const visible = (element) => {
    if (!element.isConnected || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (element.checkVisibility && !element.checkVisibility()) return false;
    return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
  };
  const inherited = (element, attribute) => {
    for (let node = element; node; node = parent(node)) {
      if (node instanceof Element && node.getAttribute(attribute) === "true") return true;
    }
    return false;
  };
  const enabled = (element) =>
    !element.matches(":disabled") && !inherited(element, "aria-disabled");
  const checked = (element) => {
    if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type))
      return element.checked;
    const state = element.getAttribute("aria-checked");
    if (state !== null) return state === "true";
    throw new Error("Element is not a checkbox or radio (use check() on a checkable control)");
  };
  const describe = (element) => {
    const attributes = ["id", "class", "type", "role"].flatMap((name) => {
      const value = element.getAttribute(name);
      return value ? [`${name}=${JSON.stringify(value.slice(0, 100))}`] : [];
    });
    if (!element.hasAttribute("role")) {
      const role =
        element instanceof HTMLInputElement
          ? ({ checkbox: "checkbox", radio: "radio", number: "spinbutton", range: "slider" }[
              element.type
            ] ?? "textbox")
          : { BUTTON: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox", IMG: "image" }[
              element.tagName
            ];
      if (role) attributes.push(`role=${JSON.stringify(role)}`);
    }
    const name = normalize(labels(element).join(" ") || text(element)).slice(0, 100);
    return `<${element.localName}${attributes.length ? " " + attributes.join(" ") : ""}>${name ? " " + JSON.stringify(name) : ""}`;
  };
  const active = () => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  };
  const editingHost = (element) => {
    let host = element;
    while (parent(host)?.isContentEditable) host = parent(host);
    return host;
  };
  const fillKind = (element, value) => {
    if (element instanceof HTMLInputElement) {
      if (
        ["date", "time", "datetime-local", "month", "week", "color", "range"].includes(element.type)
      )
        return { special: true };
      if (!["text", "search", "email", "url", "tel", "password", "number"].includes(element.type))
        throw new Error(
          element.type === "file"
            ? "Use setInputFiles() for file inputs"
            : "Unsupported input type; use check() for checkboxes and radios",
        );
      if (
        element.type === "number" &&
        value !== "" &&
        (!/^-?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/u.test(value) || !Number.isFinite(Number(value)))
      )
        throw new Error(`Malformed value for number input: ${JSON.stringify(value)}`);
    } else if (!(element instanceof HTMLTextAreaElement) && !element.isContentEditable)
      throw new Error("fill() requires an input, textarea or contenteditable editing host");
    return {};
  };
  const sort = (elements) => {
    const order = new Map(walk(document).map((element, index) => [element, index]));
    return [...new Set(elements)].sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1));
  };

  if (command === "resolve") {
    const found = [];
    for (const scope of nodes) {
      const candidates = walk(scope);
      if (data.kind === "css") {
        const roots = [
          scope,
          ...(scope.shadowRoot ? [scope.shadowRoot] : []),
          ...candidates.flatMap((element) => (element.shadowRoot ? [element.shadowRoot] : [])),
        ];
        for (const root of roots) found.push(...root.querySelectorAll(data.selector));
      } else if (data.kind === "text") {
        const matching = candidates.filter(
          (element) =>
            !hiddenText.includes(element.nodeName) &&
            !document.head?.contains(element) &&
            matches(text(element), data.text, data.exact),
        );
        // Every ancestor of a match also matches; keep only the innermost ones in one upward pass.
        const matched = new Set(matching);
        const enclosing = new Set();
        for (const element of matching) {
          for (let node = parent(element); node && node !== scope; node = parent(node)) {
            if (enclosing.has(node)) break;
            if (matched.has(node)) enclosing.add(node);
          }
        }
        found.push(...matching.filter((element) => !enclosing.has(element)));
      } else if (data.kind === "label") {
        found.push(
          ...candidates.filter((element) =>
            labels(element).some((label) => matches(label, data.text, data.exact)),
          ),
        );
      }
    }
    return sort(found);
  }
  if (command === "validate") {
    const scopes = nodes.slice(0, data.scopes);
    return sort(
      nodes
        .slice(data.scopes)
        .filter(
          (element) =>
            element instanceof Element &&
            element.isConnected &&
            scopes.some((scope) => scope !== element && contains(scope, element)),
        ),
    );
  }
  if (command === "filter") {
    return nodes.filter(
      (element) =>
        (data.visible === undefined || visible(element) === data.visible) &&
        (data.hasText === undefined || matches(text(element), data.hasText)) &&
        (data.hasNotText === undefined || !matches(text(element), data.hasNotText)),
    );
  }
  if (command === "describe") return nodes.slice(0, 5).map(describe);
  if (command === "fillKind") return fillKind(this, data.value);
  if (command === "read") {
    const element = this;
    if (data.kind === "connected") return element.isConnected;
    if (data.kind === "isVisible") return visible(element);
    if (!element.isConnected) return { retry: "element was detached" };
    if (data.kind === "textContent") return element.textContent;
    if (data.kind === "innerText") return element.innerText;
    if (data.kind === "inputValue") {
      if (!["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName))
        throw new Error("inputValue() requires an input, textarea or select");
      return element.value;
    }
    if (data.kind === "getAttribute") return element.getAttribute(data.name);
    if (data.kind === "isChecked") return checked(element);
    if (data.kind === "isEnabled") return enabled(element);
  }
  if (command === "geometry") {
    const element = this;
    if (!element.isConnected) return { retry: "element was detached" };
    if (!enabled(element)) return { retry: "element is disabled" };
    if (data.editable && (element.readOnly || inherited(element, "aria-readonly")))
      return { retry: "element is readonly" };
    let pointer = element;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const clipped =
      (style.clip !== "auto" &&
        /rect\(0(?:px)?[, ]+0(?:px)?[, ]+0(?:px)?[, ]+0(?:px)?\)/u.test(style.clip)) ||
      style.clipPath === "inset(50%)";
    if (
      data.pointer &&
      element.labels &&
      (!visible(element) || box.width < 2 || box.height < 2 || clipped)
    )
      pointer = Array.from(element.labels).find(visible) ?? element;
    if (!visible(pointer)) return { retry: "element is not visible" };
    let rects = Array.from(pointer.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    const viewport = { width: innerWidth, height: innerHeight };
    const pointFor = (rect) =>
      data.position
        ? {
            x: pointer.getBoundingClientRect().left + data.position.x,
            y: pointer.getBoundingClientRect().top + data.position.y,
          }
        : {
            x: (Math.max(0, rect.left) + Math.min(viewport.width, rect.right)) / 2,
            y: (Math.max(0, rect.top) + Math.min(viewport.height, rect.bottom)) / 2,
          };
    const inViewport = (rect) =>
      rect.bottom > 0 && rect.right > 0 && rect.top < viewport.height && rect.left < viewport.width;
    let rect = rects.find(inViewport);
    if (!rect || data.scroll) {
      const alignment = ["center", "start", "end"][data.attempt % 3];
      pointer.scrollIntoView({ block: alignment, inline: alignment, behavior: "instant" });
      rects = Array.from(pointer.getClientRects()).filter(
        (candidate) => candidate.width > 0 && candidate.height > 0,
      );
      rect = rects.find(inViewport);
    }
    if (!rect) return { retry: "element is outside the viewport" };
    const point = data.point ?? pointFor(rect);
    if (point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight)
      return { retry: "click point is outside the viewport" };
    if (data.pointer) {
      let hit = document.elementFromPoint(point.x, point.y);
      while (hit?.shadowRoot) {
        const deeper = hit.shadowRoot.elementFromPoint(point.x, point.y);
        if (!deeper || deeper === hit) break;
        hit = deeper;
      }
      let accepted = hit && contains(pointer, hit);
      for (let ancestor = hit; ancestor instanceof Element; ancestor = parent(ancestor)) {
        if (ancestor instanceof HTMLLabelElement && ancestor.control === element) {
          const interactive = hit.closest(
            "a[href],button,input,select,textarea,[role=button],[role=link],[contenteditable=true]",
          );
          if (!interactive || interactive === element || !contains(ancestor, interactive))
            accepted = true;
          else accepted = false;
          break;
        }
      }
      if (!accepted)
        return { retry: `${hit ? describe(hit) : "No element"} intercepts pointer events` };
    }
    const bounds = pointer.getBoundingClientRect();
    return {
      point,
      box: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      visibilityState: document.visibilityState,
    };
  }
  if (command === "focus") {
    const element = this;
    if (!element.isConnected) return { retry: "element was detached" };
    const target = element.isContentEditable ? editingHost(element) : element;
    target.focus();
    if (!element.isConnected || active() !== target)
      return { retry: "element changed or lost focus after focus()" };
    if (!data.fill) return {};
    const kind = fillKind(element, data.value);
    if (kind.special) return kind;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.select();
      if (data.append) {
        if (element.type === "number" || element.type === "email") return { collapseEnd: true };
        element.setSelectionRange(element.value.length, element.value.length);
      }
    } else if (element.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(target);
      if (data.append) range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return {};
  }
  if (command === "focused") {
    return this.isConnected && active() === (this.isContentEditable ? editingHost(this) : this);
  }
  if (command === "specialFill") {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(this, data.value);
    if (this.value !== data.value)
      throw new Error(
        `Malformed value for ${this.type} input: ${JSON.stringify(data.value)} (browser normalized it to ${JSON.stringify(this.value)})`,
      );
    this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return {};
  }
  if (command === "select") {
    if (!(this instanceof HTMLSelectElement)) throw new Error("selectOption() requires a <select>");
    const options = Array.from(this.options);
    const selected = data.values.map((value) => {
      const option =
        typeof value === "string"
          ? (options.find((candidate) => candidate.value === value) ??
            options.find((candidate) => candidate.label === value))
          : options.find((candidate) =>
              value.value !== undefined
                ? candidate.value === value.value
                : candidate.label === value.label,
            );
      if (!option)
        throw new Error(
          `Unknown option ${JSON.stringify(value)}; available options: ${options.map((candidate) => `${JSON.stringify(candidate.value)} (${candidate.label})`).join(", ")}`,
        );
      if (option.disabled || option.parentElement?.matches("optgroup:disabled"))
        throw new Error(`Option ${JSON.stringify(option.value)} is disabled`);
      return option;
    });
    if (!this.multiple && selected.length > 1)
      throw new Error("Select does not accept multiple options");
    if (!selected.length) this.selectedIndex = -1;
    for (const option of options) option.selected = selected.includes(option);
    this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return Array.from(this.selectedOptions).map((option) => option.value);
  }
  throw new TypeError(`Unknown page operation: ${command}`);
}
