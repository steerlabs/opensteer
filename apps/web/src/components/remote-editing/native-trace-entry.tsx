import { createRoot } from "react-dom/client";
import { ProxyField } from "./proxy-field.js";
import { editingProxyAttributes } from "./proxy-attributes.js";

const policy = new URLSearchParams(location.search).get("policy") ?? "corrected";
const attributes =
  policy === "baseline"
    ? {
        autoComplete: "off",
        autoCapitalize: "off",
        autoCorrect: "on",
        spellCheck: false,
        inputMode: "text" as const,
      }
    : editingProxyAttributes(
        { composition: true, rangeEdits: policy !== "legacy", commands: true, clipboard: "full" },
        {
          contextId: "00000000-0000-4000-8000-000000000001",
          field: {
            kind: "text",
            multiline: policy !== "sensitive",
            sensitive: policy === "sensitive",
            autocapitalize: "off",
            ...(policy === "sensitive" ? {} : { inputMode: "text" as const }),
          },
          caret: null,
        },
      );

const events: Record<string, unknown>[] = [];
let composing = false;
Reflect.set(window, "nativeProxyTrace", events);
const proxy = () =>
  document.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea,input");
const snapshot = () => {
  const target = proxy();
  return {
    value: target?.value ?? "",
    selectionStart: target?.selectionStart ?? 0,
    selectionEnd: target?.selectionEnd ?? 0,
  };
};
for (const type of [
  "keydown",
  "keypress",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "keyup",
  "selectionchange",
  "pointerdown",
  "blur",
  "focus",
]) {
  document.addEventListener(
    type,
    (event) => {
      const target = proxy();
      if (!target) return;
      if (type === "selectionchange") {
        if (document.activeElement !== target) return;
      } else if (type === "pointerdown") {
        if (!(event.target instanceof HTMLElement) || event.target.id !== "commit") return;
      } else if (event.target !== target) return;
      if (type === "compositionstart") composing = true;
      if (type === "compositionend") composing = false;
      events.push({
        type: type === "selectionchange" ? "selection" : type,
        time: performance.now(),
        trusted: event.isTrusted,
        key: Reflect.get(event, "key"),
        code: Reflect.get(event, "code"),
        keyCode: Reflect.get(event, "keyCode"),
        location: Reflect.get(event, "location"),
        data: Reflect.get(event, "data"),
        inputType: Reflect.get(event, "inputType"),
        composing: Reflect.get(event, "isComposing"),
        repeat: Reflect.get(event, "repeat"),
        alt: Reflect.get(event, "altKey"),
        altGraph: event instanceof KeyboardEvent ? event.getModifierState("AltGraph") : undefined,
        control: Reflect.get(event, "ctrlKey"),
        meta: Reflect.get(event, "metaKey"),
        shift: Reflect.get(event, "shiftKey"),
        ...snapshot(),
      });
    },
    true,
  );
}
const reset = () => {
  const target = proxy();
  if (!target) throw new Error("Proxy has not mounted");
  target.blur();
  if (composing) throw new Error("Native composition must end before recorder reset");
  target.value = "";
  target.focus();
  target.setSelectionRange(0, 0);
  events.length = 0;
};
const inspect = () => ({
  policy,
  events,
  composing,
  ...snapshot(),
  userAgent: navigator.userAgent,
  focused: document.activeElement === proxy(),
  viewport: {
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
    screenX,
    screenY,
    topInset: outerHeight - innerHeight,
  },
  commit: document.getElementById("commit")?.getBoundingClientRect().toJSON(),
});
Reflect.set(window, "nativeTraceControl", { reset, inspect });
const fieldStyle = { display: "block", marginTop: 12, width: "90%", height: 120, fontSize: 20 };
createRoot(document.getElementById("root")!).render(
  <main style={{ fontFamily: "system-ui", padding: 12 }}>
    <h1 style={{ fontSize: 20 }}>Native proxy event recorder</h1>
    <button id="focus" style={{ padding: 16 }} onClick={() => proxy()?.focus()}>
      Focus proxy
    </button>
    {policy === "native-password" ? (
      <input
        type="password"
        aria-label="Plain native password comparison"
        autoFocus
        style={fieldStyle}
      />
    ) : (
      <ProxyField
        sensitive={policy === "sensitive"}
        aria-label="Native trace proxy"
        autoFocus
        {...attributes}
        style={fieldStyle}
      />
    )}
    <button id="commit" style={{ marginTop: 12, padding: 16 }}>
      Commit by click
    </button>
  </main>,
);

// External browsers use HTTP only to reset and read. All typing is native OS input.
if (location.protocol.startsWith("http")) {
  const poll = async () => {
    try {
      const response = await fetch("/control");
      const command: unknown = await response.json();
      if (command === "reset") reset();
      await fetch("/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inspect()),
      });
    } finally {
      setTimeout(() => {
        void poll().catch(() => {});
      }, 200);
    }
  };
  void poll().catch(() => {});
}
