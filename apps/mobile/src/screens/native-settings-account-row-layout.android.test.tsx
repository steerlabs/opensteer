// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeFrames, intersects } from "../../test-support/compose-frames.js";
import { layoutPhones } from "../../test-support/layout-phones.js";

/*
 * The phone walk of 963f808d0: on Android at the largest sizes the Settings account row drew its
 * initial over its email address. The initial and the address were two children of the row's
 * headline slot, which Material lays out as a Box: one over the other. Laid out here by Compose's
 * rules (`compose-frames.tsx`), at the default size and the largest, on the narrowest phone.
 */

vi.mock(
  "@expo/ui/jetpack-compose",
  async () => (await import("../../test-support/compose-frames.js")).composeLayout,
);
vi.mock(
  "@expo/ui/jetpack-compose/modifiers",
  async () => (await import("../../test-support/compose-frames.js")).composeLayoutModifiers,
);
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }));
vi.mock("../ui/integration-icon.js", () => ({ RowMarkIcon: () => null }));
vi.mock("../theme.js", async (original) => ({
  ...(await original<typeof import("../theme.js")>()),
  color: new Proxy({}, { get: () => "#000000" }),
}));
const fontScale = vi.hoisted(() => ({ value: 1 }));
vi.mock("react-native", () => ({
  Platform: {
    OS: "android",
    select: (choices: Record<string, unknown>) => choices.android ?? choices.default,
  },
  useWindowDimensions: () => ({ fontScale: fontScale.value, height: 640, scale: 2, width: 320 }),
}));

const { NativeSettingsPage } = await import("./native-settings-page.android.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  fontScale.value = 1;
});

const narrowest = Math.min(...layoutPhones.map((phone) => phone.window.width));
const email = "first.last+travel@studio-mac-mini.fixture.invalid";

describe("the Android Settings account row, on the narrowest phone", () => {
  for (const [size, scale] of [
    ["the default size", 1],
    ["the largest size", 2],
  ] as const)
    it(`draws its initial apart from its address at ${size}`, async () => {
      fontScale.value = scale;
      const element = document.createElement("div");
      const root = createRoot(element);
      await act(async () =>
        root.render(
          <NativeSettingsPage
            sections={[
              {
                key: "account",
                title: "Account",
                rows: [
                  {
                    addressIn: "label",
                    detail: "Opensteer account",
                    initial: "F",
                    key: "email",
                    kind: "text",
                    label: email,
                  },
                ],
              },
            ]}
          />,
        ),
      );
      try {
        const frames = composeFrames(element, { fontScale: scale, width: narrowest });
        const texts = [...element.querySelectorAll('[data-compose="Text"]')];
        const drawn = (text: Element) => (text.textContent ?? "").replace(/[⁠​]/gu, "");
        const initial = texts.find((text) => drawn(text) === "F")!;
        const address = texts.find((text) => drawn(text) === email)!;
        expect(initial).toBeDefined();
        expect(address).toBeDefined();
        const mark = initial.closest('[data-size="40,40"]')!;
        expect(frames.get(mark)).toBeDefined();
        expect(
          intersects(frames.get(mark)!, frames.get(address)!),
          JSON.stringify({
            address: frames.get(address),
            mark: frames.get(mark),
          }),
        ).toBe(false);
      } finally {
        act(() => root.unmount());
      }
    });
});
