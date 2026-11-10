(() => {
  const bridge = webkit.messageHandlers.phoneBrowser;
  const token = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16),
  ).join("-");
  if (!globalThis.__opensteerAgentHelper) {
    Object.defineProperty(globalThis, "__opensteerAgentHelper", {
      value: Object.freeze({
        version: 1,
        documentId: token,
        stub: true,
        invoke: (envelope) =>
          envelope.documentId !== token
            ? { error: { code: "stale-document", message: "Document changed" } }
            : envelope.name === "native.ping"
              ? { result: { ready: true } }
              : {
                  error: { code: "unsupported-operation", message: "Agent helper is not bundled" },
                },
      }),
    });
  }
  const path = (element) => {
    const parts = [];
    while (element && element !== document.documentElement) {
      const parent = element.parentElement;
      if (!parent) return null;
      parts.unshift(Array.prototype.indexOf.call(parent.children, element));
      element = parent;
    }
    return parts;
  };
  const elementAtPath = (parts) =>
    Array.isArray(parts)
      ? parts.reduce((element, index) => element?.children[index], document.documentElement)
      : null;
  const editable = () => {
    const element = document.activeElement;
    return {
      element,
      secure: element instanceof HTMLInputElement && element.type === "password",
      editable:
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element?.isContentEditable === true,
    };
  };
  const editing = () => {
    const context = editable();
    bridge.postMessage({
      kind: "editing",
      token,
      secure: context.secure,
      editable: context.editable,
      field: context.editable
        ? {
            kind: context.element?.isContentEditable ? "rich" : "text",
            multiline:
              context.element instanceof HTMLTextAreaElement ||
              context.element?.isContentEditable === true,
            sensitive: context.secure,
          }
        : null,
    });
  };
  const viewport = () => {
    const visual = window.visualViewport;
    bridge.postMessage({
      kind: "viewport",
      token,
      viewport: {
        width: visual?.width ?? innerWidth,
        height: visual?.height ?? innerHeight,
        scale: visual?.scale ?? 1,
        x: visual?.offsetLeft ?? 0,
        y: visual?.offsetTop ?? 0,
      },
    });
  };
  globalThis.phoneBrowserHelper = Object.freeze({
    token,
    ping: () => {
      const helper = globalThis.__opensteerAgentHelper;
      return helper.stub
        ? helper.invoke({ documentId: helper.documentId, name: "native.ping", args: {} }).result
        : { ready: true };
    },
    agent: (envelope) => {
      const helper = globalThis.__opensteerAgentHelper;
      if (!helper)
        return { error: { code: "unsupported-operation", message: "Agent helper is not bundled" } };
      return helper.invoke({ ...envelope, documentId: helper.documentId });
    },
    anchor: () => {
      const element = document.elementFromPoint(Math.min(innerWidth / 2, 100), 1);
      return {
        path: element ? path(element) : null,
        offset: element?.getBoundingClientRect().top ?? 0,
        x: scrollX,
        y: scrollY,
      };
    },
    restoreAnchor: async (anchor) => {
      await new Promise(requestAnimationFrame);
      const element = elementAtPath(anchor.path);
      const target = element
        ? scrollY + element.getBoundingClientRect().top - anchor.offset
        : anchor.y;
      scrollTo(
        anchor.x,
        Math.max(0, Math.min(target, document.documentElement.scrollHeight - innerHeight)),
      );
      await new Promise(requestAnimationFrame);
      viewport();
      return true;
    },
    focus: (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return false;
      element.focus({ preventScroll: true });
      return document.activeElement === element;
    },
    tap: (point) => {
      const element = point.selector
        ? document.querySelector(point.selector)
        : document.elementFromPoint(point.x, point.y);
      if (!(element instanceof HTMLElement)) return false;
      if (point.requireFile && (!(element instanceof HTMLInputElement) || element.type !== "file"))
        return false;
      element.click();
      return true;
    },
    selection: () => {
      const context = editable();
      if (context.secure) return "";
      if (
        context.element instanceof HTMLInputElement ||
        context.element instanceof HTMLTextAreaElement
      ) {
        return context.element.value
          .slice(context.element.selectionStart ?? 0, context.element.selectionEnd ?? 0)
          .slice(0, 65536);
      }
      return String(getSelection() ?? "").slice(0, 65536);
    },
  });
  document.addEventListener("focusin", editing, true);
  document.addEventListener("focusout", editing, true);
  addEventListener("resize", viewport);
  visualViewport?.addEventListener("resize", viewport);
  visualViewport?.addEventListener("scroll", viewport);
  addEventListener("pageshow", (event) => {
    if (event.persisted) {
      bridge.postMessage({ kind: "ready", token });
      viewport();
    }
  });
  bridge.postMessage({ kind: "ready", token });
  requestAnimationFrame(viewport);
})();
