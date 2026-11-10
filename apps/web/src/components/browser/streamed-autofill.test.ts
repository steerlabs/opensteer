import { describe, expect, it } from "vitest";
import { autofillPlacement } from "./streamed-autofill.js";

describe("autofillPlacement", () => {
  const view = { width: 1000, height: 600 };

  it("opens under the field, left-aligned, at the field's width within its bounds", () => {
    expect(autofillPlacement({ left: 100, top: 100, width: 300, height: 30 }, view, 120)).toEqual({
      left: 100,
      top: 134,
      width: 300,
      maxHeight: 458,
      side: "below",
    });
    expect(
      autofillPlacement({ left: 100, top: 100, width: 120, height: 30 }, view, 120).width,
    ).toBe(240);
    expect(
      autofillPlacement({ left: 100, top: 100, width: 800, height: 30 }, view, 120).width,
    ).toBe(360);
  });

  it("flips above a field near the bottom and stays inside the view", () => {
    expect(autofillPlacement({ left: 900, top: 520, width: 200, height: 30 }, view, 120)).toEqual({
      left: 752,
      top: 396,
      width: 240,
      maxHeight: 508,
      side: "above",
    });
  });

  it("takes the roomier side and scrolls when neither holds it all", () => {
    expect(
      autofillPlacement({ left: 8, top: 250, width: 200, height: 30 }, view, 400),
    ).toMatchObject({ side: "below", top: 284, maxHeight: 308 });
    expect(
      autofillPlacement({ left: 8, top: 330, width: 200, height: 30 }, view, 400),
    ).toMatchObject({ side: "above", top: 8, maxHeight: 318 });
  });

  it("narrows to a phone's view", () => {
    expect(
      autofillPlacement(
        { left: 20, top: 100, width: 300, height: 40 },
        { width: 300, height: 600 },
        90,
      ),
    ).toMatchObject({ left: 8, width: 284 });
  });
});
