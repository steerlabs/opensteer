// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, layoutTextSizes } from "../../test-support/layout-phones.js";
import { layout, layoutWindow } from "../../test-support/yoga-frames.js";

/*
 * Build 9's walk: a copyable address ran off the right edge (`…/callback/plug` at the default
 * size, `https://account.fix` at the largest). On iOS the menu that offers Copy is a SwiftUI host
 * that takes its content's own size (`@expo/ui/community/menu`: a `Host` and an `RNHostView`, both
 * `matchContents`), so the React Native content inside is laid out unconstrained, and a long
 * address stays on one line. The stand-in here is that: its children laid out with all the width
 * they want. A copyable address must still wrap in the width its own container gives it.
 */

vi.mock(
  "react-native",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReactNative,
);
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("./symbol.js", () => ({ Symbol: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("./pane.js", () => ({ useContentInsets: () => ({ left: 0, right: 0 }) }));
// The SwiftUI menu host: as wide as its content wants to be.
vi.mock("../thread/composer-menu.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    NativeMenu: (props: { children: ReactNode }) => (
      <View style={{ alignSelf: "flex-start", width: 100_000 }}>
        <View style={{ alignSelf: "flex-start" }}>{props.children}</View>
      </View>
    ),
  };
});

const { CopyableAddressText } = await import("./copyable-address-text.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const callback = "https://account.fixture.invalid/v1/oauth-broker/callback/plugin";

describe("a copyable address", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      for (const [where, row] of [
        ["a column", false],
        ["a row beside its Copy button", true],
      ] as const)
        it(`wraps inside the screen in ${where} on ${phone.name} at text size ${fontScale}`, async () => {
          Object.assign(layoutWindow, phone.window, { fontScale });
          const container = document.createElement("div");
          document.body.append(container);
          const root = createRoot(container);
          roots.push(root);
          const right = phone.window.width - phone.insets.right - 16;
          await act(async () =>
            root.render(
              <View
                style={{
                  paddingLeft: 16,
                  paddingRight: 16 + phone.insets.right,
                  width: phone.window.width,
                }}
              >
                {row ? (
                  <View style={{ flexDirection: "row", gap: 12 }}>
                    <CopyableAddressText
                      layoutStyle={{ flex: 1 }}
                      role="caption"
                      value={callback}
                    />
                    <View style={{ height: 44, width: 60 }} />
                  </View>
                ) : (
                  <CopyableAddressText role="caption" value={callback} />
                )}
              </View>,
            ),
          );
          const frames = await layout(container, phone.window);
          expect(frames.settled, "the layout never comes to rest").toBe(true);
          const text = [...container.querySelectorAll('[data-rn="Text"]')].find((element) =>
            (element.textContent ?? "").replace(/[⁠​]/gu, "").includes("oauth-broker"),
          )!;
          const frame = frames.frame(text);
          expect(frame.width, "never drawn").toBeGreaterThan(0);
          expect(frame.x + frame.width, "runs past the screen's edge").toBeLessThanOrEqual(
            (row ? right - 12 - 60 : right) + 0.5,
          );
          expect(frames.cut(text)).toBe(false);
        });
});
