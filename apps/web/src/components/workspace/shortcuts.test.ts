import { describe, expect, it } from "vitest";
import { workspaceTabKey } from "./shortcuts.js";

describe("workspace tab switch keys", () => {
  it.each([
    ["ArrowLeft", "ArrowLeft", true, false, "previous-tab"],
    ["ArrowRight", "ArrowRight", true, false, "next-tab"],
    ["{", "BracketLeft", false, true, "previous-tab"],
    ["}", "BracketRight", false, true, "next-tab"],
    ["[", "BracketLeft", false, true, "previous-tab"],
    ["]", "BracketRight", false, true, "next-tab"],
  ])("maps %s (%s), alt=%s shift=%s", (key, code, altKey, shiftKey, type) => {
    expect(
      workspaceTabKey({
        key,
        code,
        altKey,
        shiftKey,
        metaKey: true,
        ctrlKey: false,
      } as KeyboardEvent),
    ).toEqual({ type });
  });
  it("does not confuse history navigation or caret movement with tab switching", () => {
    for (const [key, code, metaKey, altKey, shiftKey] of [
      ["[", "BracketLeft", true, false, false],
      ["ArrowLeft", "ArrowLeft", false, true, false],
      ["ArrowRight", "ArrowRight", true, true, true],
    ] as const)
      expect(
        workspaceTabKey({ key, code, metaKey, altKey, shiftKey, ctrlKey: false } as KeyboardEvent),
      ).toBeNull();
  });
});
