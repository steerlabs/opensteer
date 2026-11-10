import { describe, expect, it } from "vitest";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { browserBasicInputAllows } from "@opensteer/protocol/browser";
import { createEditingState, reduceEditing, type EditingProxyEvent } from "../editing/index.js";
import { BrowserEditingStore } from "./browser-editing.js";
import type { BrowserCommand } from "./client.js";

const surfaceId = BrowserSurfaceIdSchema.parse("page");
const context = {
  contextId: "00000000-0000-4000-8000-000000000001",
  field: { kind: "text" as const, multiline: true, sensitive: false },
  caret: null,
};
const proxy = (value: string) => ({
  value,
  selectionStart: value.length,
  selectionEnd: value.length,
});

function setup() {
  const commands: BrowserCommand[] = [];
  const store = new BrowserEditingStore((_session, _surface, command) => commands.push(command));
  store.negotiate("session", undefined, surfaceId, false, 1);
  store.receive("session", { type: "browser.editing", surfaceId, context });
  return { store, target: store.target("session", surfaceId), commands };
}

describe("basic browser input", () => {
  it("leaves full-editing messages unchanged even when basic input is also advertised", async () => {
    const { store, target, commands } = setup();
    const operations = [
      {
        kind: "key",
        keystroke: {
          action: "down",
          key: "A",
          code: "KeyA",
          text: "A",
          modifiers: ["shift"],
          repeat: true,
        },
      },
      { kind: "command", command: "deleteWordBackward" },
      {
        kind: "edit",
        edit: { contextId: context.contextId, before: "teh", after: "", text: "the" },
      },
      {
        kind: "compose",
        composition: {
          contextId: context.contextId,
          before: "word",
          text: "語",
          selectionStart: 1,
          selectionEnd: 1,
        },
      },
    ] satisfies import("../editing/index.js").EditingOperation[];
    for (const basicInput of [undefined, 1] as const) {
      store.negotiate("session", 2, surfaceId, true, basicInput);
      expect(target.get().input).toBe("editing");
      for (const operation of operations) await target.send(operation);
    }
    expect(commands.slice(0, operations.length)).toEqual(commands.slice(operations.length));
    expect(commands.slice(0, operations.length).map((command) => command.type)).toEqual([
      "input.key",
      "input.command",
      "input.text",
      "input.compose",
    ]);
    store.dispose();
  });

  it("ignores autocorrection replacements and keeps subsequent plain typing and deletion", async () => {
    const { store, target, commands } = setup();
    let state = createEditingState("ios", target.get().abilities);
    for (const event of [
      { type: "context", context },
      { type: "input", inputType: "insertText", composing: false, proxy: proxy("teh") },
      { type: "beforeinput", inputType: "insertReplacementText", data: "the" },
      { type: "input", inputType: "insertReplacementText", composing: false, proxy: proxy("the") },
      { type: "input", inputType: "insertText", composing: false, proxy: proxy(" ") },
      { type: "beforeinput", inputType: "deleteContentBackward", data: null },
    ] satisfies EditingProxyEvent[]) {
      const step = reduceEditing(state, event);
      state = step.state;
      expect(step.refusal).toBeUndefined();
      for (const operation of step.operations) await target.send(operation);
    }
    expect(commands).toEqual([
      {
        type: "input.text",
        surfaceId,
        edit: { contextId: context.contextId, text: "teh", before: "", after: "" },
      },
      {
        type: "input.text",
        surfaceId,
        edit: { contextId: context.contextId, text: " ", before: "", after: "" },
      },
      { type: "input.command", surfaceId, command: "deleteBackward" },
    ]);
    store.dispose();
  });

  it("types shifted characters, maps select-all shortcuts, and extracts only plain paste", async () => {
    const { store, target, commands } = setup();
    let state = createEditingState("mac", target.get().abilities);
    const keystroke = {
      key: "A",
      code: "KeyA",
      alt: false,
      control: false,
      meta: false,
      shift: true,
      altGraph: false,
      location: 0 as const,
      repeat: false,
      composing: false,
    };
    for (const event of [
      { type: "context", context },
      { type: "keydown", ...keystroke },
      { type: "keyup", ...keystroke },
      { type: "keydown", ...keystroke, key: "a", shift: false, meta: true },
      { type: "cut" },
      {
        type: "paste",
        items: [
          { type: "text/html", bytes: new TextEncoder().encode("<b>plain</b>") },
          { type: "text/plain", bytes: new TextEncoder().encode("plain") },
        ],
      },
    ] satisfies EditingProxyEvent[]) {
      const step = reduceEditing(state, event);
      state = step.state;
      for (const operation of step.operations) {
        const pending = target.send(operation);
        const command = commands.at(-1);
        if (operation.kind === "paste" && command?.type === "clipboard.part") {
          store.receive("session", {
            type: "clipboard.result",
            surfaceId,
            operationId: command.part.operationId,
            outcome: "pasted",
          });
        }
        await pending;
      }
    }
    expect(commands.map((command) => command.type)).toEqual([
      "input.key",
      "input.command",
      "clipboard.paste-data",
      "clipboard.part",
    ]);
    expect(commands[0]).toMatchObject({ key: "A", text: "A", modifiers: [] });
    expect(commands[2]).toMatchObject({ items: [{ type: "text/plain", size: 5 }] });
    expect(commands.every(browserBasicInputAllows)).toBe(true);
    store.dispose();
  });

  it.each(["unsupported-operation", "target-suspended"] as const)(
    "settles clipboard quietly on %s",
    async (reason) => {
      const { store, target, commands } = setup();
      const copy = target.send({ kind: "copy" });
      expect(commands.at(-1)?.type).toBe("clipboard.copy");
      store.receive(
        "session",
        {
          type: "browser.error",
          error: {
            code: "conflict",
            reason,
            message: "Raw implementation detail",
            retryable: false,
          },
        },
        surfaceId,
      );
      expect(await copy).toEqual({ outcome: "empty", items: [] });
      expect(target.get().input).toBe("basic");
      store.dispose();
    },
  );

  it("negotiates basic independently of editing, and resets on disconnect", () => {
    const { store, target } = setup();
    expect(target.get()).toMatchObject({
      input: "basic",
      negotiated: true,
      context,
      abilities: { basicInput: true, composition: true, rangeEdits: false, clipboard: "text" },
    });
    store.disconnect("session", surfaceId);
    expect(target.get()).toMatchObject({ input: "none", negotiated: false, context: null });
    store.dispose();
  });

  it("encodes soft keyboard insertion, deletion, Enter and marked composition once", async () => {
    const { store, target, commands } = setup();
    let state = createEditingState("ios", target.get().abilities);
    const events: EditingProxyEvent[] = [
      { type: "context", context },
      { type: "input", inputType: "insertText", composing: false, proxy: proxy("a") },
      { type: "beforeinput", inputType: "deleteContentBackward", data: null },
      { type: "input", inputType: "deleteContentBackward", composing: false, proxy: proxy("") },
      { type: "beforeinput", inputType: "insertParagraph", data: null },
      { type: "input", inputType: "insertParagraph", composing: false, proxy: proxy("\n") },
      { type: "compositionstart", proxy: proxy("") },
      {
        type: "compositionupdate",
        data: "한",
        proxy: { ...proxy("한"), markedRange: { start: 0, end: 1 } },
      },
      { type: "compositionend", data: "한", proxy: proxy("한") },
    ];
    for (const event of events) {
      const step = reduceEditing(state, event);
      state = step.state;
      for (const operation of step.operations) await target.send(operation);
    }
    expect(commands.map((command) => command.type)).toEqual([
      "input.text",
      "input.command",
      "input.key",
      "input.key",
      "input.compose",
      "input.text",
    ]);
    expect(commands.every(browserBasicInputAllows)).toBe(true);
    expect(commands[0]).toEqual({
      type: "input.text",
      surfaceId,
      edit: { contextId: context.contextId, before: "", after: "", text: "a" },
    });
    store.dispose();
  });

  it("drops range replacement, cut, rich paste and unsupported commands before transport", async () => {
    const { store, target, commands } = setup();
    await target.send({
      kind: "edit",
      edit: { contextId: context.contextId, before: "a", after: "", text: "b" },
    });
    await target.send({ kind: "command", command: "deleteWordBackward" });
    await target.send({ kind: "cut" });
    await target.send({
      kind: "paste",
      items: [{ type: "text/html", bytes: new TextEncoder().encode("<b>x</b>") }],
    });
    expect(commands).toEqual([]);
    await target.send({ kind: "command", command: "selectAll" });
    expect(commands).toEqual([{ type: "input.command", surfaceId, command: "selectAll" }]);
    store.dispose();
  });
});
