import { describe, expect, it, vi } from "vitest";
import { autofillKey } from "./autofill.js";
import type { BrowserAutofillState } from "./browser-editing.js";

const autofill = {
  offer: { accounts: [{ id: "first" }, { id: "second" }] },
  open: true,
  highlighted: 1,
  pending: null,
  result: null,
} as unknown as BrowserAutofillState;
const press = (key: string, modifiers: { shift?: boolean; meta?: boolean } = {}) => {
  const target = { dismissAutofill: vi.fn(), fillAutofill: vi.fn(), moveAutofill: vi.fn() };
  const kept = autofillKey(target, autofill, {
    key,
    alt: false,
    ctrl: false,
    meta: modifiers.meta ?? false,
    shift: modifiers.shift ?? false,
  });
  return { kept, target };
};

describe("autofillKey", () => {
  it("keeps ↑, ↓, Return and Esc from the page", () => {
    expect(press("ArrowUp")).toMatchObject({ kept: true });
    expect(press("ArrowUp").target.moveAutofill).toHaveBeenCalledWith(-1);
    expect(press("ArrowDown").target.moveAutofill).toHaveBeenCalledWith(1);
    expect(press("Enter").target.fillAutofill).toHaveBeenCalledWith("second");
    const escape = press("Escape");
    expect(escape.kept).toBe(true);
    expect(escape.target.dismissAutofill).toHaveBeenCalled();
  });

  it("lets every other key close the chooser and reach the page", () => {
    for (const [key, modifiers] of [
      ["a", {}],
      ["Tab", {}],
      ["Enter", { shift: true }],
      ["ArrowDown", { meta: true }],
    ] as const) {
      const { kept, target } = press(key, modifiers);
      expect(kept).toBe(false);
      expect(target.dismissAutofill).toHaveBeenCalled();
      expect(target.fillAutofill).not.toHaveBeenCalled();
    }
    const shift = press("Shift");
    expect(shift.kept).toBe(false);
    expect(shift.target.dismissAutofill).not.toHaveBeenCalled();
  });
});
