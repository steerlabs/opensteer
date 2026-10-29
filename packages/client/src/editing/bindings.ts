import type { EditingCommand, EditingModifier } from "@opensteer/protocol/editing";
import type { EditingKeyState, EditingViewerPlatform } from "./types.js";

export function appleEditingPlatform(platform: EditingViewerPlatform): boolean {
  return platform === "mac" || platform === "ios";
}
export function editingModifiers(
  key: EditingKeyState,
  platform: EditingViewerPlatform,
): EditingModifier[] {
  const modifiers: EditingModifier[] = [];
  if (key.alt && !key.altGraph) modifiers.push("alt");
  if (key.control && !key.altGraph)
    modifiers.push(appleEditingPlatform(platform) ? "control" : "primary");
  if (key.meta) modifiers.push(appleEditingPlatform(platform) ? "primary" : "meta");
  if (key.shift) modifiers.push("shift");
  return modifiers;
}
type Binding =
  | { readonly kind: "command"; readonly command: EditingCommand }
  | { readonly kind: "copy" }
  | { readonly kind: "cut" }
  | { readonly kind: "paste" };
const selection: Partial<Record<EditingCommand, EditingCommand>> = {
  moveWordLeft: "moveWordLeftAndModifySelection",
  moveWordRight: "moveWordRightAndModifySelection",
  moveToLeftEndOfLine: "moveToLeftEndOfLineAndModifySelection",
  moveToRightEndOfLine: "moveToRightEndOfLineAndModifySelection",
  moveToBeginningOfLine: "moveToBeginningOfLineAndModifySelection",
  moveToEndOfLine: "moveToEndOfLineAndModifySelection",
  moveToBeginningOfParagraph: "moveToBeginningOfParagraphAndModifySelection",
  moveToEndOfParagraph: "moveToEndOfParagraphAndModifySelection",
  moveToBeginningOfDocument: "moveToBeginningOfDocumentAndModifySelection",
  moveToEndOfDocument: "moveToEndOfDocumentAndModifySelection",
};
const cocoaPrimary: Readonly<Record<string, EditingCommand>> = {
  a: "selectAll",
  z: "undo",
  arrowleft: "moveToLeftEndOfLine",
  arrowright: "moveToRightEndOfLine",
  arrowup: "moveToBeginningOfDocument",
  arrowdown: "moveToEndOfDocument",
  backspace: "deleteToBeginningOfLine",
  delete: "deleteToEndOfLine",
};
const cocoaOption: Readonly<Record<string, EditingCommand>> = {
  arrowleft: "moveWordLeft",
  arrowright: "moveWordRight",
  arrowup: "moveToBeginningOfParagraph",
  arrowdown: "moveToEndOfParagraph",
  backspace: "deleteWordBackward",
  delete: "deleteWordForward",
};
const cocoaControl: Readonly<Record<string, EditingCommand>> = {
  a: "moveToBeginningOfLine",
  e: "moveToEndOfLine",
  b: "moveBackward",
  f: "moveForward",
  p: "moveUp",
  n: "moveDown",
  h: "deleteBackward",
  d: "deleteForward",
  k: "deleteToEndOfParagraph",
  t: "transpose",
  y: "yank",
};
const pcControl: Readonly<Record<string, EditingCommand>> = {
  a: "selectAll",
  z: "undo",
  y: "redo",
  arrowleft: "moveWordLeft",
  arrowright: "moveWordRight",
  arrowup: "moveToBeginningOfParagraph",
  arrowdown: "moveToEndOfParagraph",
  home: "moveToBeginningOfDocument",
  end: "moveToEndOfDocument",
  backspace: "deleteWordBackward",
  delete: "deleteWordForward",
};
const unmodified: Readonly<Record<string, EditingCommand>> = {
  arrowleft: "moveBackward",
  arrowright: "moveForward",
  arrowup: "moveUp",
  arrowdown: "moveDown",
  backspace: "deleteBackward",
  delete: "deleteForward",
  home: "moveToBeginningOfLine",
  end: "moveToEndOfLine",
};

/** Bind by the logical key: AZERTY Ctrl+A is not the physical KeyA. */
export function resolveEditingBinding(
  key: EditingKeyState,
  platform: EditingViewerPlatform,
): Binding | null {
  if (key.altGraph || key.composing) return null;
  const name = key.key.toLowerCase();
  const apple = appleEditingPlatform(platform);
  const primary = apple ? key.meta && !key.control : key.control && !key.meta;
  if (primary && !key.alt && !key.shift && ["c", "x", "v"].includes(name))
    return { kind: name === "c" ? "copy" : name === "x" ? "cut" : "paste" };
  if (!key.meta && !key.alt && name === "insert") {
    if (key.control && !key.shift) return { kind: "copy" };
    if (key.shift && !key.control) return { kind: "paste" };
  }
  if (!key.meta && !key.alt && !key.control && key.shift && name === "delete")
    return { kind: "cut" };
  let command: EditingCommand | undefined;
  if (apple) {
    if (primary && !key.alt) command = cocoaPrimary[name];
    else if (key.alt && !key.meta && !key.control) command = cocoaOption[name];
    else if (key.control && !key.meta && !key.alt) command = cocoaControl[name];
    else if (!key.control && !key.alt && !key.meta)
      command =
        name === "home"
          ? "moveToBeginningOfDocument"
          : name === "end"
            ? "moveToEndOfDocument"
            : unmodified[name];
  } else {
    if (primary && !key.alt) command = pcControl[name];
    else if (!key.meta && !key.control && !key.alt) command = unmodified[name];
    else if (platform === "windows" && key.alt && !key.control && !key.meta && name === "backspace")
      command = key.shift ? "redo" : "undo";
  }
  if (!command) return null;
  if (key.shift) {
    if (command === "undo") command = "redo";
    else if (selection[command]) command = selection[command]!;
    else if (!["selectAll", "redo"].includes(command)) return null;
  }
  return { kind: "command", command };
}

export function deletionEditingCommand(inputType: string): EditingCommand | null {
  const commands: Readonly<Record<string, EditingCommand>> = {
    deleteContentBackward: "deleteBackward",
    deleteContentForward: "deleteForward",
    deleteWordBackward: "deleteWordBackward",
    deleteWordForward: "deleteWordForward",
    deleteSoftLineBackward: "deleteToBeginningOfLine",
    deleteSoftLineForward: "deleteToEndOfLine",
    deleteHardLineBackward: "deleteToBeginningOfLine",
    deleteHardLineForward: "deleteToEndOfParagraph",
  };
  return commands[inputType] ?? null;
}
