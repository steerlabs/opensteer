// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, layoutTextSizes } from "../../test-support/layout-phones.js";
import { inside, layout, layoutWindow, textElement } from "../../test-support/yoga-frames.js";

/*
 * "Fit to screen" over a page, laid out by React Native's own layout engine. At the largest
 * text size the walk saw its words cut through inside a pill of fixed height. Here they are
 * whole and inside the chip, and the chip is a touch high, at every phone width and text size.
 */

vi.mock(
  "react-native",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReactNative,
);
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("../ui/glass.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    GlassSurface: (props: { children?: unknown; style?: unknown }) => (
      <View style={props.style}>{props.children as never}</View>
    ),
  };
});
vi.mock("../ui/symbol.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Symbol: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 17, width: props.size ?? 17 }} />
    ),
  };
});

const { FitToScreenChip } = await import("./fit-chip.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

describe("Fit to screen", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`reads whole in its chip on ${phone.name} at text size ${fontScale}`, async () => {
        Object.assign(layoutWindow, phone.window, { fontScale });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        // Centred in the band the page leaves, as the page places it.
        await act(async () =>
          root.render(
            <View style={{ ...phone.window, alignItems: "center", justifyContent: "center" }}>
              <FitToScreenChip onPress={() => undefined} words />
            </View>,
          ),
        );
        const frames = await layout(container, phone.window);
        const words = textElement(container, "Fit to screen");
        const chip = container.querySelector('[aria-label="Fit to screen"]')!;
        expect(frames.cut(words), "the words are cut").toBe(false);
        expect(
          inside(frames.frame(words), frames.frame(chip)),
          "the words run out of the chip",
        ).toBe(true);
        expect(
          frames.frame(chip).height,
          "the chip is smaller than a touch",
        ).toBeGreaterThanOrEqual(43.5);
        expect(inside(frames.frame(chip), { ...phone.window, x: 0, y: 0 })).toBe(true);
      });
});
