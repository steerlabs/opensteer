import type { BrowserClientMessage, BrowserPrivateEdit } from "@opensteer/protocol";
import { editingModifiers } from "./editing-commands.js";
import { keyEventParameters } from "./key-codes.js";

/** Explicit key equivalents only. Rich replacements/composition need a new native API. */
export function browserPrivateInput(
  message: BrowserClientMessage,
  platform: NodeJS.Platform,
): BrowserPrivateEdit[] | null {
  if (message.type === "clipboard.paste") return [{ type: "insertText", text: message.text }];
  if (message.type === "input.text")
    return message.edit.before || message.edit.after
      ? null
      : [{ type: "insertText", text: message.edit.text }];
  if (message.type === "input.key") {
    const modifiers = editingModifiers(message.modifiers, platform);
    const resolved = keyEventParameters(message);
    const keyCode = resolved.windowsVirtualKeyCode;
    if (
      !keyCode ||
      message.repeat ||
      (message.location !== undefined && message.location !== 0) ||
      keyCode === 93 ||
      (keyCode === 121 && (modifiers & 8) !== 0)
    )
      return null;
    // Copy/cut/paste chords cannot touch the computer's clipboard.
    if (modifiers & (platform === "darwin" ? 4 : 2) && [67, 88, 86].includes(keyCode)) return null;
    const text =
      message.action === "up" || modifiers & 7
        ? ""
        : (resolved.text ?? (message.key.length === 1 ? message.key : ""));
    if (text.length >= 4) return null;
    return [
      {
        type: message.action === "down" ? "keyDown" : "keyUp",
        key: message.key,
        code: message.code,
        keyCode,
        modifiers,
        text,
      },
    ];
  }
  if (message.type !== "input.command") return null;
  const primary = platform === "darwin" ? 4 : 2;
  const map: Partial<Record<typeof message.command, [string, string, number, number]>> = {
    deleteBackward: ["Backspace", "Backspace", 8, 0],
    deleteForward: ["Delete", "Delete", 46, 0],
    moveBackward: ["ArrowLeft", "ArrowLeft", 37, 0],
    moveForward: ["ArrowRight", "ArrowRight", 39, 0],
    moveUp: ["ArrowUp", "ArrowUp", 38, 0],
    moveDown: ["ArrowDown", "ArrowDown", 40, 0],
    selectAll: ["a", "KeyA", 65, primary],
    undo: ["z", "KeyZ", 90, primary],
    redo: ["z", "KeyZ", 90, primary | 8],
  };
  const key = map[message.command];
  if (!key) return null;
  return ["keyDown", "keyUp"].map((type) => ({
    type: type as "keyDown" | "keyUp",
    key: key[0],
    code: key[1],
    keyCode: key[2],
    modifiers: key[3],
    text: "",
  }));
}
