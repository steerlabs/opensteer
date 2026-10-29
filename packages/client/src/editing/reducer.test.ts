import { describe, expect, it, vi } from "vitest";
import type { EditingContext } from "@opensteer/protocol/editing";
import type {
  EditingKeyState,
  EditingOperation,
  EditingProxyEvent,
  EditingTargetAbilities,
  EditingViewerPlatform,
} from "./types.js";
import { createEditingState, reduceEditing } from "./reducer.js";
const context: EditingContext = {
  contextId: "00000000-0000-4000-8000-000000000001",
  field: { kind: "text", multiline: true, sensitive: false },
  caret: { x: 0.5, y: 0.5, height: 0.02 },
};
const abilities: EditingTargetAbilities = {
  composition: true,
  rangeEdits: true,
  commands: true,
  clipboard: "full",
};
const proxy = (value: string, selectionStart = value.length, selectionEnd = selectionStart) => ({
  value,
  selectionStart,
  selectionEnd,
});
const key = (
  key: string,
  changes: Partial<EditingKeyState> = {},
): EditingKeyState & { readonly type: "keydown" } => ({
  type: "keydown",
  key,
  code: key.length === 1 ? "Key" + key.toUpperCase() : key,
  alt: false,
  control: false,
  meta: false,
  shift: false,
  altGraph: false,
  location: 0,
  repeat: false,
  composing: false,
  ...changes,
});
function replay(
  events: EditingProxyEvent[],
  platform: EditingViewerPlatform = "mac",
  target = abilities,
) {
  let state = createEditingState(platform, target);
  const operations: EditingOperation[] = [];
  for (const event of [{ type: "context", context } as const, ...events]) {
    const step = reduceEditing(state, event);
    state = step.state;
    operations.push(...step.operations);
  }
  return { state, operations };
}
const input = (value: string, inputType = "insertText", composing = false): EditingProxyEvent => ({
  type: "input",
  inputType,
  composing,
  proxy: proxy(value),
});
describe("editing reducer: scripted ordering regressions (native fixtures are separate)", () => {
  it.each(["insertLineBreak", "insertParagraph"])(
    "sends soft %s as one Enter and keeps pasted newlines literal",
    (inputType) => {
      const result = replay([
        { type: "beforeinput", inputType, data: "\n" },
        input("\n", inputType),
      ]);
      expect(result.operations).toEqual([
        { kind: "key", keystroke: { action: "down", key: "Enter", code: "Enter", modifiers: [] } },
        { kind: "key", keystroke: { action: "up", key: "Enter", code: "Enter", modifiers: [] } },
      ]);
      expect(replay([input("\n", inputType)]).operations).toEqual(result.operations);
      expect(
        replay([
          key("Enter"),
          { ...key("Enter"), type: "keyup" },
          { type: "beforeinput", inputType, data: "\n" },
        ]).operations,
      ).toHaveLength(4);
      expect(
        replay([
          { type: "beforeinput", inputType, data: "\n" },
          { type: "beforeinput", inputType, data: "\n" },
        ]).operations,
      ).toHaveLength(4);
      expect(
        replay([
          key("Enter"),
          { type: "beforeinput", inputType, data: "\n" },
          input("\n", inputType),
        ]).operations,
      ).toHaveLength(1);
      expect(replay([input("a\nb", "insertFromPaste")]).operations).toMatchObject([
        { kind: "edit", edit: { text: "a\nb" } },
      ]);
    },
  );
  it("binds the following native insertText to its key and retains the mirror", () => {
    const { state, operations } = replay([
      key("a"),
      { type: "beforeinput", inputType: "insertText", data: "a" },
      input("a"),
      key("a", { repeat: true }),
      input("aa"),
    ]);
    expect(operations.map((o) => o.kind)).toEqual(["key", "key"]);
    expect(operations[0]).toMatchObject({ keystroke: { text: "a" } });
    expect(operations[1]).toMatchObject({ keystroke: { text: "a", repeat: true } });
    expect(state.proxy.value).toBe("aa");
  });
  it("verifies a native replacement even when it preserves the same word", () => {
    const result = replay([
      input("word "),
      { type: "beforeinput", inputType: "insertReplacementText", data: "word" },
      input("word ", "insertReplacementText"),
    ]);
    expect(result.operations).toEqual([
      {
        kind: "edit",
        edit: { contextId: context.contextId, text: "word ", before: "", after: "" },
      },
      {
        kind: "edit",
        edit: { contextId: context.contextId, text: "word ", before: "word ", after: "" },
      },
    ]);
  });
  it("refuses a replacement hint that cannot describe the native snapshot", () => {
    let state = replay([input("asde ")]).state;
    state = reduceEditing(state, {
      type: "beforeinput",
      inputType: "insertReplacementText",
      data: "elsewhere",
    }).state;
    const result = reduceEditing(state, input("aside ", "insertReplacementText"));
    expect(result.refusal).toBe("range-edits");
    expect(result.operations).toEqual([]);
    expect(result.state.proxy.value).toBe("");
  });
  it("keeps genuine repeated characters as separate keystroke producers", () => {
    const result = replay([
      key("a"),
      input("a"),
      key("a", { repeat: true }),
      { type: "beforeinput", inputType: "insertText", data: "a" },
      input("aa"),
      { ...key("a"), type: "keyup" },
    ]);
    expect(result.operations).toEqual([
      {
        kind: "key",
        keystroke: {
          action: "down",
          key: "a",
          code: "KeyA",
          modifiers: [],
          location: 0,
          repeat: false,
          text: "a",
        },
      },
      {
        kind: "key",
        keystroke: {
          action: "down",
          key: "a",
          code: "KeyA",
          modifiers: [],
          location: 0,
          repeat: true,
          text: "a",
        },
      },
      {
        kind: "key",
        keystroke: {
          action: "up",
          key: "a",
          code: "KeyA",
          modifiers: [],
          location: 0,
          repeat: false,
        },
      },
    ]);
    expect(result.state.down).toEqual([]);
  });
  it("keeps non-macOS repeated key delivery immediate", () => {
    const state = replay([], "windows").state;
    const result = reduceEditing(state, key("a", { repeat: true }));
    expect(result.operations).toEqual([
      {
        kind: "key",
        keystroke: {
          action: "down",
          key: "a",
          code: "KeyA",
          modifiers: [],
          location: 0,
          repeat: true,
          text: "a",
        },
      },
    ]);
  });
  it("cancels a consumed local repeat without forwarding Escape or stranding the next key", () => {
    const result = replay([
      key("e"),
      input("e"),
      key("e", { repeat: true }),
      { ...key("e"), type: "keyup" },
      key("Escape"),
      { ...key("Escape"), type: "keyup" },
      key("x"),
      input("ex"),
      { ...key("x"), type: "keyup" },
    ]);
    expect(
      result.operations
        .filter((operation) => operation.kind === "key")
        .map((operation) => [operation.keystroke.action, operation.keystroke.key]),
    ).toEqual([
      ["down", "e"],
      ["up", "e"],
      ["down", "x"],
      ["up", "x"],
    ]);
    expect(result.operations.filter((operation) => operation.kind !== "key")).toEqual([]);
    expect(result.state.down).toEqual([]);
    expect(result.state.proxy.value).toBe("ex");
  });
  it("commits repeated identical compositions once per transaction", () => {
    const events: EditingProxyEvent[] = [];
    for (const value of ["한", "한한"]) {
      events.push(
        { type: "compositionstart", proxy: proxy(value === "한" ? "" : "한") },
        { type: "compositionupdate", data: "한", proxy: proxy(value === "한" ? "" : "한") },
        input(value, "insertCompositionText", true),
        { type: "compositionend", data: "한", proxy: proxy(value) },
      );
    }
    const { operations } = replay(events);
    expect(operations.filter((o) => o.kind === "edit")).toEqual([
      { kind: "edit", edit: { contextId: context.contextId, text: "한", before: "", after: "" } },
      { kind: "edit", edit: { contextId: context.contextId, text: "한", before: "", after: "" } },
    ]);
  });
  it("consumes an insertFromComposition tail by event role, including empty cancel", () => {
    const { operations } = replay([
      { type: "compositionstart", proxy: proxy("") },
      input("に", "insertCompositionText", true),
      { type: "compositionend", data: "日本", proxy: proxy("日本") },
      input("日本", "insertFromComposition"),
      { type: "compositionstart", proxy: proxy("日本") },
      input("日本あ", "insertCompositionText", true),
      { type: "compositionend", data: "", proxy: proxy("日本") },
    ]);
    expect(operations.filter((o) => o.kind === "edit")).toHaveLength(1);
    expect(operations.at(-1)).toMatchObject({ kind: "compose", composition: { text: "" } });
  });
  it("commits at the old context on pointer/context interruption and ignores late end", () => {
    const changed = { ...context, contextId: "00000000-0000-4000-8000-000000000002" };
    const { operations } = replay([
      { type: "compositionstart", proxy: proxy("") },
      input("한", "insertCompositionText", true),
      { type: "pointerdown" },
      { type: "context", context: changed },
      { type: "compositionend", data: "한", proxy: proxy("한") },
      input("한", "insertFromComposition"),
    ]);
    expect(operations.filter((o) => o.kind === "edit")).toEqual([
      { kind: "edit", edit: { contextId: context.contextId, text: "한", before: "", after: "" } },
    ]);
  });
  it("sends exact before and after for replacements and re-composition", () => {
    const replaced = replay([key("e"), input("e"), input("é", "insertReplacementText")]);
    expect(replaced.operations.at(-1)).toEqual({
      kind: "edit",
      edit: { contextId: context.contextId, text: "é", before: "e", after: "" },
    });
    const recomposed = replay([
      input("word"),
      { type: "compositionstart", proxy: proxy("word", 0, 4) },
      input("words", "insertCompositionText", true),
      { type: "compositionend", data: "words", proxy: proxy("words") },
    ]);
    expect(recomposed.operations.find((o) => o.kind === "compose")).toMatchObject({
      composition: { before: "word", after: "", text: "words" },
    });
  });
  it("uses deletion commands with no mirror and collapsed caret moves with context", () => {
    const { operations } = replay([
      { type: "beforeinput", inputType: "deleteWordBackward", data: null },
      input("ab"),
      { type: "selection", proxy: proxy("ab", 0) },
    ]);
    expect(operations[0]).toEqual({ kind: "command", command: "deleteWordBackward" });
    expect(operations.slice(-2)).toEqual([
      { kind: "command", command: "moveBackward" },
      { kind: "command", command: "moveBackward" },
    ]);
  });
  it.each([
    ["mac", "a", { meta: true }, "selectAll"],
    ["mac", "ArrowLeft", { meta: true, shift: true }, "moveToLeftEndOfLineAndModifySelection"],
    ["mac", "Backspace", { alt: true }, "deleteWordBackward"],
    ["mac", "k", { control: true }, "deleteToEndOfParagraph"],
    ["ios", "e", { control: true }, "moveToEndOfLine"],
    ["windows", "ArrowLeft", { control: true }, "moveWordLeft"],
    ["windows", "y", { control: true }, "redo"],
    [
      "linux",
      "Home",
      { control: true, shift: true },
      "moveToBeginningOfDocumentAndModifySelection",
    ],
    ["chromeos", "Backspace", { control: true }, "deleteWordBackward"],
  ] as const)("resolves %s %s by viewer meaning", (platform, letter, modifiers, command) => {
    expect(replay([key(letter, modifiers)], platform).operations).toEqual([
      { kind: "command", command },
    ]);
  });
  it("uses logical keys for layout chords, keeps AltGraph text and distinguishes Mac Control", () => {
    expect(replay([key("a", { code: "KeyQ", control: true })], "windows").operations).toEqual([
      { kind: "command", command: "selectAll" },
    ]);
    expect(
      replay([key("@", { control: true, alt: true, altGraph: true })], "windows").operations[0],
    ).toMatchObject({ keystroke: { text: "@", modifiers: [] } });
    expect(replay([key("s", { control: true })]).operations[0]).toMatchObject({
      keystroke: { modifiers: ["control"] },
    });
  });
  it("routes clipboard chords as operations and lets the paste event supply bytes", () => {
    const copied = replay([key("c", { meta: true }), { type: "copy" }]);
    expect(copied.operations).toEqual([{ kind: "copy" }]);
    expect(
      replay([
        key("v", { meta: true }),
        { type: "paste", items: [{ type: "text/plain", bytes: new TextEncoder().encode("abc") }] },
      ]).operations.map((o) => o.kind),
    ).toEqual(["paste"]);
  });
  it("gates target abilities and keeps preedit local without live composition", () => {
    const target = {
      ...abilities,
      composition: false,
      rangeEdits: false,
      commands: false,
      clipboard: "none" as const,
    };
    const { operations } = replay(
      [
        { type: "compositionstart", proxy: proxy("") },
        input("한", "insertCompositionText", true),
        { type: "compositionend", data: "한", proxy: proxy("한") },
        { type: "copy" },
      ],
      "mac",
      target,
    );
    expect(operations.map((o) => o.kind)).toEqual(["edit"]);
  });
  it("uses the native marked range when a keyboard recomposes unchanged text", () => {
    const { operations } = replay([
      input("word"),
      { type: "compositionstart", proxy: { ...proxy("word"), markedRange: { start: 0, end: 4 } } },
      {
        type: "input",
        inputType: "insertCompositionText",
        composing: true,
        proxy: { ...proxy("word"), markedRange: { start: 0, end: 4 } },
      },
      { type: "compositionend", data: "word", proxy: proxy("word") },
    ]);
    expect(operations.find((operation) => operation.kind === "compose")).toEqual({
      kind: "compose",
      composition: {
        contextId: context.contextId,
        text: "word",
        selectionStart: 4,
        selectionEnd: 4,
        before: "word",
        after: "",
      },
    });
  });
  it("publishes native marked updates without requiring a DOM input event", () => {
    const { operations } = replay([
      { type: "compositionstart", proxy: proxy("") },
      {
        type: "compositionupdate",
        data: "한",
        proxy: { ...proxy("한"), markedRange: { start: 0, end: 1 } },
      },
      { type: "compositionend", data: "한", proxy: proxy("한") },
    ]);
    expect(operations.map((operation) => operation.kind)).toEqual(["compose", "edit"]);
  });
  it("preserves unchanged mirrored text around a native preedit on commit", () => {
    const { operations } = replay([
      input("abc"),
      { type: "compositionstart", proxy: proxy("abc", 1) },
      {
        type: "compositionupdate",
        data: "aX",
        proxy: { ...proxy("aXbc", 2), markedRange: { start: 0, end: 2 } },
      },
      {
        type: "input",
        inputType: "insertCompositionText",
        composing: true,
        proxy: { ...proxy("aXbc", 2), markedRange: { start: 0, end: 2 } },
      },
      { type: "compositionend", data: "aX", proxy: proxy("aXbc", 2) },
    ]);
    const edits = operations.filter((operation) => operation.kind === "edit");
    expect(edits.at(-1)).toEqual({
      kind: "edit",
      edit: { contextId: context.contextId, text: "aXbc", before: "", after: "" },
    });
    expect(operations.slice(-2)).toEqual([
      { kind: "command", command: "moveBackward" },
      { kind: "command", command: "moveBackward" },
    ]);
    expect(operations.filter((operation) => operation.kind === "compose")).toHaveLength(1);
  });
  it("loads without Intl.Segmenter and recognizes a ZWJ grapheme", async () => {
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    vi.resetModules();
    try {
      const core = await import("./reducer.js");
      const step = core.reduceEditing(
        core.createEditingState("android", abilities),
        key("👨‍👩‍👧‍👦", { code: "Digit1" }),
      );
      expect(step.operations).toMatchObject([{ kind: "key", keystroke: { text: "👨‍👩‍👧‍👦" } }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("refuses a composition over the wire text limit before marking it sent", () => {
    let state = createEditingState("mac", abilities);
    for (const event of [
      { type: "context", context },
      { type: "compositionstart", proxy: proxy("") },
    ] satisfies EditingProxyEvent[])
      state = reduceEditing(state, event).state;
    const update = reduceEditing(state, input("x".repeat(10001), "insertCompositionText", true));
    expect(update.operations).toEqual([]);
    expect(update.refusal).toBe("too-large");
    const end = reduceEditing(update.state, {
      type: "compositionend",
      data: "x".repeat(10001),
      proxy: proxy("x".repeat(10001)),
    });
    expect(end.operations).toEqual([]);
  });
  it("releases admitted physical keys once on blur, including IME takeover", () => {
    const { operations } = replay([
      key("Enter"),
      key("Shift", { code: "ShiftLeft", shift: true }),
      { type: "compositionstart", proxy: proxy("") },
      { type: "blur" },
      { type: "blur" },
    ]);
    expect(operations).toEqual([
      {
        kind: "key",
        keystroke: {
          action: "down",
          key: "Enter",
          code: "Enter",
          modifiers: [],
          location: 0,
          repeat: false,
        },
      },
      {
        kind: "key",
        keystroke: {
          action: "up",
          key: "Enter",
          code: "Enter",
          modifiers: [],
          location: 0,
          repeat: false,
        },
      },
    ]);
  });
  it("never resets the proxy while composition is still active", () => {
    let state = createEditingState("mac", abilities);
    for (const event of [
      { type: "context", context },
      { type: "compositionstart", proxy: proxy("") },
      input("한", "insertCompositionText", true),
      { type: "context", context: { ...context, contextId: crypto.randomUUID() } },
    ] satisfies EditingProxyEvent[]) {
      const step = reduceEditing(state, event);
      state = step.state;
      if (event.type !== "context" || state.composition)
        expect(step.instruction.set).toBeUndefined();
    }
  });
});
