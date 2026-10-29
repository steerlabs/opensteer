import { desktopBridge } from "./desktop-bridge.js";
let focused = false;
let observing = false;
const listeners = new Set<() => void>();
function initialize() {
  const bridge = desktopBridge()?.browserPresentation;
  if (!bridge || observing) return;
  observing = true;
  let observed = false;
  const update = (value: boolean) => {
    focused = value;
    for (const listener of listeners) listener();
  };
  bridge.onEvent((event) => {
    if (event.type !== "window-focus") return;
    observed = true;
    update(event.focused);
  });
  void bridge
    .windowFocused()
    .then((value) => {
      if (!observed) update(value);
    })
    .catch(() => update(false));
}
export function appWindowFocused(): boolean {
  if (!desktopBridge()?.browserPresentation) return document.hasFocus();
  initialize();
  return focused;
}
export function observeAppWindowFocus(listener: () => void) {
  initialize();
  listeners.add(listener);
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
  };
}
