import {
  EditingCommandSchema,
  type EditingCommand,
  type EditingModifier,
} from "@opensteer/protocol/editing";
import { keyEventParameters } from "./key-codes.js";

type Chord = readonly [key: string, code: string, ...modifiers: EditingModifier[]];

export function editingModifiers(
  modifiers: readonly EditingModifier[],
  platform: NodeJS.Platform,
  legacy = false,
): number {
  let mask = 0;
  for (let modifier of modifiers) {
    if (modifier === "primary" || (legacy && modifier === "meta" && platform !== "darwin"))
      modifier = platform === "darwin" ? "meta" : "control";
    mask |=
      modifier === "alt"
        ? 1
        : modifier === "control"
          ? 2
          : modifier === "meta"
            ? 4
            : modifier === "shift"
              ? 8
              : 0;
  }
  return mask;
}

/** The chord is observable and cancelable by the page; Blink applies the meaning on that same event. */
export function editingCommandParameters(
  command: EditingCommand | "copy" | "cut" | "paste",
  platform: NodeJS.Platform,
) {
  const mac = platform === "darwin";
  const primary: EditingModifier = mac ? "meta" : "control";
  const word: EditingModifier = mac ? "alt" : "control";
  const common: Record<string, Chord> = {
    selectAll: ["a", "KeyA", primary],
    undo: ["z", "KeyZ", primary],
    redo: platform === "win32" ? ["y", "KeyY", primary] : ["Z", "KeyZ", primary, "shift"],
    copy: ["c", "KeyC", primary],
    cut: ["x", "KeyX", primary],
    paste: ["v", "KeyV", primary],
    moveBackward: ["ArrowLeft", "ArrowLeft"],
    moveForward: ["ArrowRight", "ArrowRight"],
    moveUp: ["ArrowUp", "ArrowUp"],
    moveDown: ["ArrowDown", "ArrowDown"],
    moveWordLeft: ["ArrowLeft", "ArrowLeft", word],
    moveWordRight: ["ArrowRight", "ArrowRight", word],
    moveToLeftEndOfLine: mac ? ["ArrowLeft", "ArrowLeft", "meta"] : ["Home", "Home"],
    moveToRightEndOfLine: mac ? ["ArrowRight", "ArrowRight", "meta"] : ["End", "End"],
    moveToBeginningOfLine: mac ? ["a", "KeyA", "control"] : ["Home", "Home"],
    moveToEndOfLine: mac ? ["e", "KeyE", "control"] : ["End", "End"],
    moveToBeginningOfParagraph: ["ArrowUp", "ArrowUp", word],
    moveToEndOfParagraph: ["ArrowDown", "ArrowDown", word],
    moveToBeginningOfDocument: mac ? ["ArrowUp", "ArrowUp", "meta"] : ["Home", "Home", "control"],
    moveToEndOfDocument: mac ? ["ArrowDown", "ArrowDown", "meta"] : ["End", "End", "control"],
    deleteBackward: ["Backspace", "Backspace"],
    deleteForward: ["Delete", "Delete"],
    deleteWordBackward: ["Backspace", "Backspace", word],
    deleteWordForward: ["Delete", "Delete", word],
    deleteToBeginningOfLine: mac
      ? ["Backspace", "Backspace", "meta"]
      : ["Backspace", "Backspace", "control", "shift"],
    deleteToEndOfLine: mac
      ? ["Delete", "Delete", "meta"]
      : ["Delete", "Delete", "control", "shift"],
    deleteToEndOfParagraph: ["k", "KeyK", "control"],
    transpose: ["t", "KeyT", "control"],
    yank: ["y", "KeyY", "control"],
  };
  const selection = command.endsWith("AndModifySelection");
  const base = selection ? command.slice(0, -"AndModifySelection".length) : command;
  const chord = common[base];
  if (!chord) throw new Error("No platform chord for the editing command.");
  const [key, code, ...modifiers] = chord;
  if (selection) modifiers.push("shift");
  return {
    ...keyEventParameters({ action: "down", key, code }),
    key,
    code,
    modifiers: editingModifiers(modifiers, platform),
    commands: [command],
  };
}

const cocoaCommands = [...EditingCommandSchema.options, "copy", "cut", "paste"] as const;
const cocoaAlternatives = [
  ["b", ["control"], "moveBackward"],
  ["f", ["control"], "moveForward"],
  ["p", ["control"], "moveUp"],
  ["n", ["control"], "moveDown"],
  ["h", ["control"], "deleteBackward"],
  ["d", ["control"], "deleteForward"],
  ["ArrowLeft", [], "moveBackward"],
  ["ArrowRight", [], "moveForward"],
  ["ArrowUp", [], "moveUp"],
  ["ArrowDown", [], "moveDown"],
  ["Home", [], "moveToBeginningOfDocument"],
  ["End", [], "moveToEndOfDocument"],
] as const satisfies readonly (readonly [string, readonly EditingModifier[], EditingCommand])[];
const cocoaBindings = [
  ...cocoaCommands.map((command) => {
    const parameters = editingCommandParameters(command, "darwin");
    return { command, key: parameters.key.toLowerCase(), modifiers: parameters.modifiers };
  }),
  ...cocoaAlternatives.flatMap(([key, modifiers, command]) => {
    const mask = editingModifiers(modifiers, "darwin");
    return [
      { command, key: key.toLowerCase(), modifiers: mask },
      ...(command.startsWith("move")
        ? [{ command: command + "AndModifySelection", key: key.toLowerCase(), modifiers: mask | 8 }]
        : []),
    ];
  }),
];

/** CDP bypasses Cocoa's key binding interpreter, so Blink needs its command on that event. */
export function cocoaKeyCommands(key: string, modifiers: number): readonly string[] | undefined {
  const binding = cocoaBindings.find(
    (binding) => binding.key === key.toLowerCase() && binding.modifiers === modifiers,
  );
  return binding ? [binding.command] : undefined;
}
