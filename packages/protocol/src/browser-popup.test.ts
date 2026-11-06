import { RunnerBrowserModuleSchema } from "./runner.js";
import { describe, expect, it } from "vitest";
import {
  BrowserPopupStateSchema,
  BrowserPopupAnswerSchema,
  BrowserPopupRefSchema,
  projectNativePopupState,
  validatePopupAnswer,
} from "./browser-popup.js";
import { BrowserVideoClickResultSchema } from "./browser-video.js";
const item = {
  id: "opaque",
  kind: "option",
  label: "private-label",
  enabled: true,
  selected: false,
  rtl: false,
  directionOverride: false,
};
describe("browser popup boundary", () => {
  it("projects the native default color space to the wire's srgb", () => {
    const color = {
      kind: "color",
      rtl: false,
      items: [],
      value: "#112233",
      alpha: false,
      colorSpace: "limited-srgb",
    };
    expect(projectNativePopupState(color)).toMatchObject({ colorSpace: "srgb" });
    expect(projectNativePopupState({ ...color, colorSpace: "display-p3" })).toMatchObject({
      colorSpace: "display-p3",
    });
  });
  it("projects only displayed fields and rejects over-budget UTF-8 instead of truncating", () => {
    const state = projectNativePopupState({
      kind: "select",
      items: [item],
      multiple: false,
      rtl: false,
      value: "secret-action",
      fieldName: "secret-name",
    });
    expect(state).toEqual({ kind: "select", items: [item], multiple: false, rtl: false });
    expect(BrowserPopupStateSchema.safeParse({ ...state, value: "secret-action" }).success).toBe(
      false,
    );
    expect(() =>
      projectNativePopupState({ ...state, items: [{ ...item, label: "😀".repeat(17000) }] }),
    ).toThrow("Invalid browser popup state.");
  });
  it("keeps revisions above the JS safe-integer limit canonical", () => {
    const ref = {
      surfaceId: "surface",
      streamId: "dsp_00000000-0000-4000-8000-000000000000",
      documentGeneration: "d",
      authorityEpoch: "a",
      popupId: "p",
      revision: "18446744073709551615",
    };
    // Identity validation is independent of numeric conversion.
    expect(BrowserPopupRefSchema.shape.revision.parse(ref.revision)).toBe(ref.revision);
    for (const revision of ["0", "01", "18446744073709551616"])
      expect(BrowserPopupRefSchema.shape.revision.safeParse(revision).success).toBe(false);
  });
  it("validates actionable IDs and empty multiple selection", () => {
    const state = projectNativePopupState({
      kind: "select",
      multiple: true,
      rtl: false,
      items: [item, { ...item, id: "disabled", enabled: false }],
    });
    expect(validatePopupAnswer(state, { itemIds: [] })).toBe(true);
    expect(validatePopupAnswer(state, { itemIds: ["disabled"] })).toBe(false);
    expect(validatePopupAnswer(state, { itemIds: ["opaque", "opaque"] })).toBe(false);
    expect(BrowserPopupAnswerSchema.safeParse({ itemIds: ["opaque"], value: "x" }).success).toBe(
      false,
    );
  });
  it("never discloses the typed datalist value", () => {
    expect(
      projectNativePopupState({
        kind: "datalist",
        items: [{ ...item, kind: "suggestion" }],
        rtl: false,
        value: "secret-typed",
      }),
    ).not.toHaveProperty("value");
  });
  it("preserves only coarse refused click reasons", () => {
    const result = {
      type: "browser.guarded-click.result",
      surfaceId: "srf_00000000-0000-4000-8000-000000000000",
      streamId: "dsp_00000000-0000-4000-8000-000000000000",
      gestureId: "00000000-0000-4000-8000-000000000000",
      outcome: "refused",
      reason: "stale",
    };
    expect(BrowserVideoClickResultSchema.shape.reason.safeParse("stale").success).toBe(true);
    expect(BrowserVideoClickResultSchema.shape.reason.safeParse("private-label").success).toBe(
      false,
    );
    expect(result.outcome).toBe("refused");
  });
});

it("ignores unknown optional popup descriptor versions", () => {
  const base = { runtimeId: "runtime", wireVersion: 1 };
  expect(RunnerBrowserModuleSchema.parse({ ...base, popups: 1 }).popups).toBe(1);
  for (const popups of [0, 2, "1", null])
    expect(RunnerBrowserModuleSchema.parse({ ...base, popups }).popups).toBeUndefined();
});
