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
  // Found by the mobile typing test's random sequences (seed 32): a Backspace on an empty field
  // is prevented and sent as a command, and a native adapter that honours preventDefault sends
  // no input for it. The suppression waiting for that input must not swallow a later deletion's.
  it("does not swallow a later deletion after a prevented Backspace on an empty field", () => {
    const result = replay(
      [
        { type: "beforeinput", inputType: "deleteContentBackward", data: null },
        { type: "beforeinput", inputType: "insertText", data: "a" },
        input("a"),
        { type: "beforeinput", inputType: "deleteContentBackward", data: null },
        input("", "deleteContentBackward"),
      ],
      "ios",
    );
    expect(result.operations).toEqual([
      { kind: "command", command: "deleteBackward" },
      { kind: "edit", edit: { contextId: context.contextId, text: "a", before: "", after: "" } },
      { kind: "edit", edit: { contextId: context.contextId, text: "", before: "a", after: "" } },
    ]);
  });
  // Found by the same random sequences (seed 4363): a selection typed over through the delegate
  // ends next to the same character, so the plain diff places the change one character later
  // than the replacement. The replacement that matches the text around it exactly is verified.
  it("verifies a replacement whose neighbour repeats its last character", () => {
    const result = replay(
      [
        { type: "beforeinput", inputType: "insertText", data: "x" },
        input("xabb"),
        { type: "selection", proxy: proxy("xabb", 1, 3) },
        { type: "beforeinput", inputType: "insertReplacementText", data: "a" },
        {
          type: "input",
          inputType: "insertReplacementText",
          composing: false,
          proxy: proxy("xab", 2),
        },
      ],
      "ios",
    );
    // The replacement, restated back to the far caret after "xabb", then the caret to the "a".
    expect(result.operations.slice(-2)).toEqual([
      {
        kind: "edit",
        edit: { contextId: context.contextId, text: "ab", before: "abb", after: "" },
      },
      { kind: "command", command: "moveBackward" },
    ]);
  });
  // Found by the mobile random sequences (second generator, seed 9944): a composition started
  // over a selection carries the text between the selection and the far caret, restated; when it
  // is cancelled that text stays, as it does in the native field.
  it("keeps the restated text when a composition over a selection is cancelled", () => {
    const marked = (value: string, start: number, end: number) => ({
      ...proxy(value, end),
      markedRange: { start, end },
    });
    const result = replay(
      [
        { type: "beforeinput", inputType: "insertText", data: "abx" },
        input("abx"),
        { type: "selection", proxy: proxy("abx", 0, 2) },
        { type: "beforeinput", inputType: "insertCompositionText", data: "に" },
        { type: "compositionstart", proxy: proxy("abx", 0, 2) },
        { type: "compositionupdate", data: "に", proxy: marked("にx", 0, 1) },
        {
          type: "input",
          inputType: "insertCompositionText",
          composing: true,
          proxy: marked("にx", 0, 1),
        },
        { type: "beforeinput", inputType: "insertCompositionText", data: "" },
        { type: "compositionend", data: "", proxy: proxy("x", 0) },
        {
          type: "input",
          inputType: "insertCompositionText",
          composing: false,
          proxy: proxy("x", 0),
        },
      ],
      "ios",
    );
    // The restated "x" back in the composition's place, then the far caret to the native one.
    expect(result.operations.slice(-2)).toEqual([
      { kind: "edit", edit: { contextId: context.contextId, text: "x", before: "", after: "" } },
      { kind: "command", command: "moveBackward" },
    ]);
  });
  // CR2: after a cancelled composition's restated text, the far caret is after it. A target
  // without commands cannot move it to the native caret, so the mirror is reset; a native
  // selection that is not a caret leaves the far caret recorded where the restated text ended.
  const cancelOverSelection = (value: string, rest: string, after = proxy(rest, 0)) => {
    const marked = (text: string, start: number, end: number) => ({
      ...proxy(text, end),
      markedRange: { start, end },
    });
    return [
      { type: "beforeinput", inputType: "insertText", data: value },
      input(value),
      { type: "selection", proxy: proxy(value, 0, 2) },
      { type: "beforeinput", inputType: "insertCompositionText", data: "に" },
      { type: "compositionstart", proxy: proxy(value, 0, 2) },
      { type: "compositionupdate", data: "に", proxy: marked("に" + rest, 0, 1) },
      {
        type: "input",
        inputType: "insertCompositionText",
        composing: true,
        proxy: marked("に" + rest, 0, 1),
      },
      { type: "beforeinput", inputType: "insertCompositionText", data: "" },
      { type: "compositionend", data: "", proxy: after },
    ] satisfies EditingProxyEvent[];
  };
  it("resets the mirror when a cancel's restated text leaves the far caret where no command can move it", () => {
    const result = replay(cancelOverSelection("abx", "x"), "ios", {
      ...abilities,
      commands: false,
    });
    expect(result.operations.at(-1)).toEqual({
      kind: "edit",
      edit: { contextId: context.contextId, text: "x", before: "", after: "" },
    });
    expect(result.state.proxy).toEqual(proxy(""));
    expect(result.state.caret).toBe(0);
  });
  it("records the far caret after a cancel's restated text when the native selection is a range", () => {
    const result = replay(cancelOverSelection("abxy", "xy", proxy("xy", 0, 1)), "ios");
    expect(result.operations.at(-1)).toEqual({
      kind: "edit",
      edit: { contextId: context.contextId, text: "xy", before: "", after: "" },
    });
    expect(result.state.caret).toBe(2);
  });
  // CR1: a real browser has no marked range, and its cancel sends compositionupdate("") and an
  // input while composing before compositionend(""). Over "ab" selected in "aba", the text after
  // the selection begins with the selection's own first character: the cancel's input must keep
  // the composition's range, so the restated "a" stays.
  it("keeps the restated text when a browser cancels a composition over a selection", () => {
    const at = (value: string, start: number, end = start) => proxy(value, start, end);
    const result = replay([
      { type: "beforeinput", inputType: "insertText", data: "aba" },
      input("aba"),
      { type: "selection", proxy: at("aba", 0, 2) },
      { type: "compositionstart", proxy: at("aba", 0, 2) },
      { type: "compositionupdate", data: "に", proxy: at("aba", 0, 2) },
      { type: "beforeinput", inputType: "insertCompositionText", data: "に" },
      { type: "input", inputType: "insertCompositionText", composing: true, proxy: at("にa", 1) },
      { type: "compositionupdate", data: "", proxy: at("にa", 0, 1) },
      { type: "beforeinput", inputType: "insertCompositionText", data: "" },
      { type: "input", inputType: "insertCompositionText", composing: true, proxy: at("a", 0) },
      { type: "compositionend", data: "", proxy: at("a", 0) },
    ]);
    expect(result.operations.slice(-2)).toEqual([
      { kind: "edit", edit: { contextId: context.contextId, text: "a", before: "", after: "" } },
      { kind: "command", command: "moveBackward" },
    ]);
  });
  // The suppression's purpose: on a target without range edits a Backspace is sent as a command
  // and the mirror reset, and a deletion the adapter could not prevent still arrives as input.
  // That input is the deletion already sent, never a second edit.
  it("swallows the input of a deletion it could not prevent", () => {
    const result = replay(
      [
        { type: "beforeinput", inputType: "insertText", data: "ab" },
        input("ab"),
        { type: "beforeinput", inputType: "deleteContentBackward", data: null },
        input("a", "deleteContentBackward"),
      ],
      "android",
      { ...abilities, rangeEdits: false },
    );
    expect(result.operations).toEqual([
      { kind: "edit", edit: { contextId: context.contextId, text: "ab", before: "", after: "" } },
      { kind: "command", command: "deleteBackward" },
    ]);
  });
  // An input that is not the suppressed one means the suppressed input is not coming (Android's
  // text watcher reports an edit with no beforeinput): a later deletion's input is its own.
  it("ends the suppression at an input that is not the suppressed one", () => {
    const result = replay(
      [
        { type: "beforeinput", inputType: "deleteContentBackward", data: null },
        input("a", "insertReplacementText"),
        input("", "deleteContentBackward"),
      ],
      "android",
    );
    expect(result.operations).toEqual([
      { kind: "command", command: "deleteBackward" },
      { kind: "edit", edit: { contextId: context.contextId, text: "a", before: "", after: "" } },
      { kind: "edit", edit: { contextId: context.contextId, text: "", before: "a", after: "" } },
    ]);
  });
  // Found by the person oracle (third generator, seed 697): a paste over a selection replaces it,
  // as typing over it does; the far field has no selection, so the selection is deleted first.
  it("pastes over a selection by deleting it first", () => {
    const bytes = new TextEncoder().encode("pasted");
    const result = replay([
      { type: "beforeinput", inputType: "insertText", data: "abc" },
      input("abc"),
      { type: "selection", proxy: proxy("abc", 0, 2) },
      { type: "paste", items: [{ type: "text/plain", bytes }] },
    ]);
    expect(result.operations.slice(1)).toEqual([
      { kind: "edit", edit: { contextId: context.contextId, text: "c", before: "abc", after: "" } },
      { kind: "command", command: "moveBackward" },
      { kind: "paste", items: [{ type: "text/plain", bytes }] },
    ]);
  });
  // CS4: the hidden field's undo and redo arrive as the far page's own chords (iOS's undo manager,
  // Android's menu or input method): each is the page's command, the mirror reset from the far
  // side, nothing applied in the hidden field.
  it.each([
    ["ios", { meta: true }],
    ["android", { control: true }],
  ] as const)(
    "sends the hidden field's undo and redo on %s as the page's own",
    (platform, modifier) => {
      let state = createEditingState(platform, abilities);
      state = reduceEditing(state, { type: "context", context }).state;
      state = reduceEditing(state, {
        type: "beforeinput",
        inputType: "insertText",
        data: "ab",
      }).state;
      state = reduceEditing(state, input("ab")).state;
      const results = [
        key("z", modifier),
        { ...key("z", modifier), type: "keyup" } as const,
        key("Z", { ...modifier, shift: true }),
        { ...key("Z", { ...modifier, shift: true }), type: "keyup" } as const,
      ].map((event) => {
        const step = reduceEditing(state, event);
        state = step.state;
        return step;
      });
      expect(results.flatMap((step) => step.operations)).toEqual([
        { kind: "command", command: "undo" },
        { kind: "command", command: "redo" },
      ]);
      expect(results[0]!.instruction).toEqual({
        preventDefault: true,
        set: { value: "", selectionStart: 0, selectionEnd: 0 },
      });
    },
  );
  // CS2: a paste does not reset the mirror. The phone knows the text it pastes: the mirror takes it
  // where it went, and what is typed next is verified around it like typed text.
  it("keeps the mirror through a paste, with the pasted text in it", () => {
    const bytes = new TextEncoder().encode("cd");
    let state = createEditingState("ios", abilities);
    const run = (event: EditingProxyEvent) => {
      const step = reduceEditing(state, event);
      state = step.state;
      return step;
    };
    run({ type: "context", context });
    run({ type: "beforeinput", inputType: "insertText", data: "ab" });
    run(input("ab"));
    const pasted = run({ type: "paste", items: [{ type: "text/plain", bytes }] });
    expect(pasted.operations).toEqual([{ kind: "paste", items: [{ type: "text/plain", bytes }] }]);
    expect(pasted.instruction).toEqual({ preventDefault: true, set: proxy("abcd") });
    run({ type: "beforeinput", inputType: "insertText", data: "x" });
    expect(run(input("abcdx")).operations).toEqual([
      { kind: "edit", edit: { contextId: context.contextId, text: "x", before: "", after: "" } },
    ]);
  });
  // CR6: an input that arrives alone ends Enter's suppression too. No recorded trace puts an
  // input that is not a composition's between an Enter key and its own line break (the inputs
  // there are IME commits, which never reach the suppression), so a later line break that
  // arrives alone is its own Enter.
  it("sends a later line break after an unrelated input ended Enter's suppression", () => {
    const enter = (action: "down" | "up") => ({
      kind: "key",
      keystroke: { action, key: "Enter", code: "Enter", modifiers: [] },
    });
    const result = replay(
      [
        key("Enter"),
        { ...key("Enter"), type: "keyup" },
        input("a", "insertReplacementText"),
        input("a\n", "insertLineBreak"),
      ],
      "android",
    );
    // The hardware Enter, then the edit, then the line break's own Enter.
    const hardware = (action: "down" | "up") => {
      const sent = enter(action);
      return { ...sent, keystroke: { ...sent.keystroke, location: 0, repeat: false } };
    };
    expect(result.operations).toEqual([
      hardware("down"),
      hardware("up"),
      { kind: "edit", edit: { contextId: context.contextId, text: "a", before: "", after: "" } },
      enter("down"),
      enter("up"),
    ]);
  });
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
  it("pastes a text target the plain text of a rich copy and refuses one without any", () => {
    const bytes = (value: string) => new TextEncoder().encode(value);
    const plain = { type: "text/plain", bytes: bytes("hi") };
    const html = { type: "text/html", bytes: bytes("<b>hi</b>") };
    const image = { type: "image/png", bytes: bytes("png") };
    const file = { type: "text/plain", name: "notes.txt", bytes: bytes("file") };
    const paste = (target: EditingTargetAbilities, items: (typeof plain)[]) => {
      const state = reduceEditing(createEditingState("mac", target), { type: "context", context });
      const step = reduceEditing(state.state, { type: "paste", items });
      return { operations: step.operations, refusal: step.refusal };
    };
    const text = { ...abilities, clipboard: "text" } as const;
    const basic = { ...text, basicInput: true, rangeEdits: false };
    expect(paste(abilities, [plain, html, image])).toEqual({
      operations: [{ kind: "paste", items: [plain, html, image] }],
      refusal: undefined,
    });
    for (const target of [text, basic])
      expect(paste(target, [html, file, plain, image])).toEqual({
        operations: [{ kind: "paste", items: [plain] }],
        refusal: undefined,
      });
    expect(paste(text, [image, file])).toEqual({ operations: [], refusal: "clipboard" });
    expect(paste({ ...abilities, clipboard: "none" }, [plain])).toEqual({
      operations: [],
      refusal: "clipboard",
    });
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

it.each(["ios", "android"] as const)(
  "keeps %s page navigation keys as held keys outside editable fields",
  (platform) => {
    const names = [
      "Tab",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "PageUp",
      "PageDown",
      " ",
      "Escape",
      "Enter",
    ];
    const events = names.flatMap((name) => {
      const down = key(name, { code: name === " " ? "Space" : name });
      return [down, { ...down, type: "keyup" as const }];
    });
    const { operations } = replay(
      [{ type: "context", context: { ...context, field: null, caret: null } }, ...events],
      platform,
    );
    expect(operations.every((operation) => operation.kind === "key")).toBe(true);
    expect(
      operations
        .filter((operation) => operation.kind === "key")
        .map((operation) => [operation.keystroke.action, operation.keystroke.key]),
    ).toEqual(
      names.flatMap((name) => [
        ["down", name],
        ["up", name],
      ]),
    );
  },
);
