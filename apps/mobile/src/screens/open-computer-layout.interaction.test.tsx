// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  layoutPhones,
  layoutTextSizes,
  type LayoutPhone,
} from "../../test-support/layout-phones.js";
import {
  layout,
  layoutWindow,
  reachable,
  readingColumn,
  textElement,
  textFaults,
} from "../../test-support/yoga-frames.js";

/*
 * "Open your computer", the other sheet over Home with a display title (F31): at the largest
 * text size its title broke inside "computer" and its answers stood below a screen nothing
 * scrolled. Laid out by React Native's own layout engine, with the most it holds.
 */

const geometry = vi.hoisted(() => ({
  insets: { bottom: 0, left: 0, right: 0, top: 0 },
  window: { height: 0, width: 0 },
}));

vi.mock("react-native", async () => {
  const native = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    ...native,
    // A sheet presented over the screen: drawn in place here, as the screen it covers.
    Modal: ({ children }: { readonly children?: unknown }) => children,
  };
});
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ ...geometry.window, x: 0, y: 0 }),
  useSafeAreaInsets: () => geometry.insets,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: async () => undefined,
  selectionAsync: async () => undefined,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/action-line.js", () => ({ ActionLine: () => null }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({
    account: { account: { available: true, detail: null } },
    pendingComputer: { status: "not-listed" },
  }),
}));

const { OpenComputer } = await import("./open-computer.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

async function draw(phone: LayoutPhone, fontScale: number) {
  geometry.insets = phone.insets;
  geometry.window = phone.window;
  Object.assign(layoutWindow, phone.window, { fontScale });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <View style={phone.window}>
        <OpenComputer />
      </View>,
    ),
  );
  const frames = await layout(container, phone.window);
  expect(frames.settled, "the layout never comes to rest").toBe(true);
  expect(textFaults(frames, { column: readingColumn(phone) })).toEqual([]);
  return { container, frames };
}

describe("the Open your computer sheet", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`can be answered on ${phone.name}, at text size ${fontScale}`, async () => {
        const { container, frames } = await draw(phone, fontScale);
        expect(frames.broken(textElement(container, "Open your computer"))).toEqual([]);
        for (const answer of ["Try again", "Use a different account", "Cancel"])
          expect(
            reachable(frames, textElement(container, answer), phone.window),
            `${answer} can't be reached`,
          ).toBe(true);
      });
});
