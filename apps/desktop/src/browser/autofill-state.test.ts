import { describe, expect, it } from "vitest";
import type { DesktopAutofillScene } from "@opensteer/protocol/desktop";
import { AutofillKeys, AutofillSceneState, autofillPlacement } from "./autofill-state.js";

const scene: DesktopAutofillScene = {
  sceneRevision: 1,
  accounts: [{ id: "00000000-0000-4000-8000-000000000001", username: "synthetic", label: null }],
  anchor: { x: 100, y: 100, width: 80, height: 20 },
  role: "username",
  highlighted: 0,
  reducedMotion: true,
};

describe("native autofill scene", () => {
  it("accepts current choices only and never resurrects a dismissed revision", () => {
    const state = new AutofillSceneState();
    expect(state.set(scene)).toBe(true);
    expect(state.acceptsChoice(1, scene.accounts[0]!.id)).toBe(true);
    expect(state.acceptsChoice(0, scene.accounts[0]!.id)).toBe(false);
    expect(state.acceptsChoice(1, "00000000-0000-4000-8000-000000000002")).toBe(false);
    expect(state.set({ ...scene, sceneRevision: 2 })).toBe(true);
    expect(state.set(scene)).toBe(false);
    expect(state.set({ ...scene, sceneRevision: 2 })).toBe(true);
    state.set(null);
    expect(state.acceptsChoice(2, scene.accounts[0]!.id)).toBe(false);
    expect(state.set({ ...scene, sceneRevision: 2 })).toBe(false);
    expect(state.set({ ...scene, sceneRevision: 3 })).toBe(true);
  });
  it("forwards each keyDown while shown and focused, consuming navigation keys only", () => {
    const keys = new AutofillKeys();
    for (const key of ["ArrowUp", "ArrowDown", "Enter", "Escape", "a", "Tab", "F6"])
      expect(keys.decide({ type: "keyDown", key, code: key }, true, true)).toEqual({
        forward: true,
        prevent: ["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(key),
      });
    const fresh = new AutofillKeys();
    // Modified arrows and Return stay the page's, as the viewer's own rule says.
    expect(
      fresh.decide(
        { type: "keyDown", key: "ArrowDown", code: "ArrowDown", shift: true },
        true,
        true,
      ),
    ).toEqual({ forward: true, prevent: false });
    expect(fresh.decide({ type: "keyDown", key: "Enter", code: "Enter" }, false, true)).toEqual({
      forward: false,
      prevent: false,
    });
    expect(fresh.decide({ type: "keyDown", key: "Enter", code: "Enter" }, true, false)).toEqual({
      forward: false,
      prevent: false,
    });
  });
  it("keeps a taken key's release from the page, even after the chooser closes", () => {
    const keys = new AutofillKeys();
    keys.decide({ type: "keyDown", key: "Enter", code: "NumpadEnter" }, true, true);
    keys.decide({ type: "keyDown", key: "a", code: "KeyA" }, true, true);
    const up = (code: string) => keys.decide({ type: "keyUp", key: "", code }, false, true);
    // A held key repeats after the chooser closed: the page still never sees any of it.
    expect(
      keys.decide({ type: "keyDown", key: "Enter", code: "NumpadEnter" }, false, true),
    ).toEqual({ forward: false, prevent: true });
    expect(up("KeyA")).toEqual({ forward: false, prevent: false });
    expect(up("NumpadEnter")).toEqual({ forward: false, prevent: true });
    expect(up("NumpadEnter")).toEqual({ forward: false, prevent: false });
    expect(
      keys.decide({ type: "keyDown", key: "Enter", code: "NumpadEnter" }, false, true),
    ).toEqual({ forward: false, prevent: false });
  });
  it("forgets taken keys whose release focus loss swallowed", () => {
    const keys = new AutofillKeys();
    keys.decide({ type: "keyDown", key: "Escape", code: "Escape" }, true, true);
    keys.reset();
    expect(keys.decide({ type: "keyDown", key: "Escape", code: "Escape" }, false, true)).toEqual({
      forward: false,
      prevent: false,
    });
  });
});

describe("native autofill placement", () => {
  const geometry = {
    page: { x: 50, y: 100, width: 800, height: 600 },
    stage: { x: 50, y: 100, width: 800, height: 600 },
    appZoom: 1,
    pageZoom: 1,
    panel: { width: 200, height: 100 },
  };
  it("puts the panel below the field, leaving shadow space around it", () => {
    expect(autofillPlacement({ ...geometry, anchor: scene.anchor })).toEqual({
      x: 134,
      y: 208,
      width: 232,
      height: 132,
    });
  });
  it("flips above and clamps horizontally inside the visible page", () => {
    expect(
      autofillPlacement({ ...geometry, anchor: { x: 760, y: 580, width: 30, height: 20 } }),
    ).toEqual({ x: 634, y: 560, width: 232, height: 132 });
    expect(
      autofillPlacement({ ...geometry, anchor: { x: -10, y: 10, width: 30, height: 20 } })?.x,
    ).toBe(34);
  });
  it("converts page coordinates and app panel sizes with their respective zoom factors", () => {
    expect(
      autofillPlacement({ ...geometry, appZoom: 1.5, pageZoom: 2, anchor: scene.anchor }),
    ).toEqual({ x: 226, y: 324, width: 348, height: 198 });
  });
  it("dismisses an anchor that leaves the cropped visible stage", () => {
    for (const anchor of [
      { x: 800, y: 10, width: 40, height: 20 },
      { x: 10, y: 600, width: 40, height: 20 },
      { x: -40, y: 10, width: 40, height: 20 },
      { x: 10, y: -20, width: 40, height: 20 },
    ])
      expect(autofillPlacement({ ...geometry, anchor })).toBeNull();
    expect(
      autofillPlacement({
        ...geometry,
        stage: { ...geometry.stage, height: 200 },
        anchor: { ...scene.anchor, y: 200 },
      }),
    ).toBeNull();
  });
});
