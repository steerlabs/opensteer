import { describe, expect, it } from "vitest";
import {
  createEditingState,
  reduceEditing,
  type EditingProxyEvent,
  type EditingViewerPlatform,
} from "@opensteer/client/editing";
function createEditingCore(platform: EditingViewerPlatform) {
  let state = createEditingState(platform, {
    composition: true,
    rangeEdits: true,
    commands: true,
    clipboard: "full",
  });
  return {
    step(event: EditingProxyEvent) {
      const result = reduceEditing(state, event);
      state = result.state;
      return result;
    },
  };
}
const context = {
  contextId: "00000000-0000-4000-8000-000000000001",
  field: { kind: "text", multiline: true, sensitive: false },
  caret: null,
} as const;
const proxy = (value: string) => ({
  value,
  selectionStart: value.length,
  selectionEnd: value.length,
});
describe("Expo shared reducer acceptance", () => {
  it("sends a middle autocorrection as one verified replacement", () => {
    const core = createEditingCore("ios");
    core.step({ type: "context", context });
    core.step({ type: "input", inputType: "insertText", composing: false, proxy: proxy("teh ") });
    expect(
      core.step({
        type: "input",
        inputType: "insertReplacementText",
        composing: false,
        proxy: proxy("the "),
      }).operations,
    ).toEqual([
      {
        kind: "edit",
        edit: { contextId: context.contextId, text: "he ", before: "eh ", after: "" },
      },
    ]);
  });
  it("commits one composition at the old context and ignores its late end", () => {
    const core = createEditingCore("ios");
    core.step({ type: "context", context });
    core.step({ type: "compositionstart", proxy: proxy("") });
    core.step({ type: "compositionupdate", data: "한", proxy: proxy("한") });
    const moved = core.step({
      type: "context",
      context: { ...context, contextId: "00000000-0000-4000-8000-000000000002" },
    });
    expect(moved.operations).toEqual([
      { kind: "edit", edit: { contextId: context.contextId, text: "한", before: "", after: "" } },
    ]);
    expect(
      core.step({ type: "compositionend", data: "한", proxy: proxy("한") }).operations,
    ).toEqual([]);
  });
  it("turns empty soft delete into an editing command", () => {
    const core = createEditingCore("android");
    core.step({ type: "context", context });
    expect(
      core.step({ type: "beforeinput", inputType: "deleteContentBackward", data: null }).operations,
    ).toEqual([{ kind: "command", command: "deleteBackward" }]);
  });
});

it("uses the shared Cocoa command table and releases held hardware keys on blur", () => {
  const core = createEditingCore("ios");
  core.step({ type: "context", context });
  const key = {
    key: "ArrowLeft",
    code: "ArrowLeft",
    alt: false,
    control: false,
    meta: true,
    shift: true,
    altGraph: false,
    location: 0 as const,
    repeat: false,
    composing: false,
  };
  expect(core.step({ type: "keydown", ...key }).operations).toEqual([
    { kind: "command", command: "moveToLeftEndOfLineAndModifySelection" },
  ]);
  core.step({ type: "keydown", ...key, key: "a", code: "KeyA", meta: false, shift: false });
  expect(core.step({ type: "blur" }).operations).toContainEqual({
    kind: "key",
    keystroke: { action: "up", key: "a", code: "KeyA", modifiers: [], location: 0, repeat: false },
  });
});
