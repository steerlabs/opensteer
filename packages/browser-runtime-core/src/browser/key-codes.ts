/**
 * Windows virtual key codes for standard `KeyboardEvent.code` values.
 *
 * Chromium's input pipeline only performs non-text editing and navigation
 * actions (Backspace, Delete, arrows, Enter, Tab, …) when a dispatched key
 * event carries a virtual key code; `key`/`code` strings alone never reach
 * the editing commands. This is the same US-layout mapping Chromium itself
 * uses (ui/events/keycodes). Logical letters and digits preserve the viewer's
 * shortcut layout; keypad and other keys retain their physical identity.
 */
const virtualKeyByCode: Readonly<Record<string, number>> = {
  AltLeft: 18,
  AltRight: 18,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  ArrowUp: 38,
  Backquote: 192,
  Backslash: 220,
  Backspace: 8,
  BracketLeft: 219,
  BracketRight: 221,
  CapsLock: 20,
  Comma: 188,
  ContextMenu: 93,
  ControlLeft: 17,
  ControlRight: 17,
  Delete: 46,
  Digit0: 48,
  Digit1: 49,
  Digit2: 50,
  Digit3: 51,
  Digit4: 52,
  Digit5: 53,
  Digit6: 54,
  Digit7: 55,
  Digit8: 56,
  Digit9: 57,
  End: 35,
  Enter: 13,
  Equal: 187,
  Escape: 27,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
  Home: 36,
  Insert: 45,
  IntlBackslash: 226,
  KeyA: 65,
  KeyB: 66,
  KeyC: 67,
  KeyD: 68,
  KeyE: 69,
  KeyF: 70,
  KeyG: 71,
  KeyH: 72,
  KeyI: 73,
  KeyJ: 74,
  KeyK: 75,
  KeyL: 76,
  KeyM: 77,
  KeyN: 78,
  KeyO: 79,
  KeyP: 80,
  KeyQ: 81,
  KeyR: 82,
  KeyS: 83,
  KeyT: 84,
  KeyU: 85,
  KeyV: 86,
  KeyW: 87,
  KeyX: 88,
  KeyY: 89,
  KeyZ: 90,
  MetaLeft: 91,
  MetaRight: 92,
  Minus: 189,
  NumLock: 144,
  Numpad0: 96,
  Numpad1: 97,
  Numpad2: 98,
  Numpad3: 99,
  Numpad4: 100,
  Numpad5: 101,
  Numpad6: 102,
  Numpad7: 103,
  Numpad8: 104,
  Numpad9: 105,
  NumpadAdd: 107,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumpadEnter: 13,
  NumpadMultiply: 106,
  NumpadSubtract: 109,
  PageDown: 34,
  PageUp: 33,
  Pause: 19,
  Period: 190,
  PrintScreen: 44,
  Quote: 222,
  ScrollLock: 145,
  Semicolon: 186,
  ShiftLeft: 16,
  ShiftRight: 16,
  Slash: 191,
  Space: 32,
  Tab: 9,
};

const virtualKeyByKey: Readonly<Record<string, number>> = {
  "'": 222,
  ",": 188,
  "-": 189,
  ".": 190,
  "/": 191,
  ";": 186,
  "=": 187,
  "[": 219,
  "\\": 220,
  "]": 221,
  "`": 192,
  " ": 32,
};

interface KeyEventInput {
  readonly action: "down" | "up";
  readonly code: string;
  readonly key: string;
  readonly text?: string | undefined;
}

interface KeyEventParameters {
  readonly text?: string;
  readonly type: "keyDown" | "keyUp" | "rawKeyDown";
  readonly windowsVirtualKeyCode?: number;
}

/**
 * Resolves the CDP `Input.dispatchKeyEvent` shape for a client key event.
 * Key downs without generated text dispatch as `rawKeyDown` (Chromium's
 * convention for non-character keys), and Enter carries its carriage-return
 * text so focused editors receive both the action and the character.
 */
export function keyEventParameters(input: KeyEventInput): KeyEventParameters {
  const virtualKey = resolveVirtualKey(input.code, input.key);
  const text =
    input.action === "down"
      ? (input.text ?? (input.key === "Enter" ? "\r" : undefined))
      : undefined;
  const type = input.action === "up" ? "keyUp" : text === undefined ? "rawKeyDown" : "keyDown";
  return {
    ...(text === undefined ? {} : { text }),
    type,
    ...(virtualKey === undefined ? {} : { windowsVirtualKeyCode: virtualKey }),
  };
}

function resolveVirtualKey(code: string, key: string): number | undefined {
  // Shortcuts follow the logical layout (AZERTY/QWERTZ), while keypad and
  // non-alphanumeric keys retain their physical identity.
  if (!code.startsWith("Numpad") && /^[a-z0-9]$/iu.test(key))
    return key.toUpperCase().charCodeAt(0);
  const byCode = virtualKeyByCode[code];
  if (byCode !== undefined) return byCode;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= "A" && upper <= "Z") return upper.charCodeAt(0);
    if (upper >= "0" && upper <= "9") return upper.charCodeAt(0);
    return virtualKeyByKey[key];
  }
  return undefined;
}
