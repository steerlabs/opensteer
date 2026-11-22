// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, layoutTextSizes } from "../../test-support/layout-phones.js";
import { layout, layoutWindow, readingColumn, textFaults } from "../../test-support/yoga-frames.js";

/*
 * A page's own alert, confirm or prompt names the site that asks. It is a decision with no way to
 * see more, so the site is drawn whole, its origin wrapping at its joints, at every size: never cut
 * at its start, where `evil-google.com` would read as `…google.com`.
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
vi.mock("../ui/symbol.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Symbol: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 17, width: props.size ?? 17 }} />
    ),
  };
});
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: async () => undefined,
  selectionAsync: async () => undefined,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

const { PageDialog } = await import("./page-dialog.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const drawn = (text: string) => text.replace(/[⁠​]/gu, "");

describe("a page's dialog, naming the site that asks", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`draws http://evil-google.com:8080 whole on ${phone.name} at text size ${fontScale}`, async () => {
        Object.assign(layoutWindow, phone.window, { fontScale });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        await act(async () =>
          root.render(
            <PageDialog
              channelReady
              dialog={{ id: "dialog-1", message: "Delete this listing?", type: "confirm" } as never}
              onAnswer={() => undefined}
              onPrompt={() => undefined}
              promptText=""
              site="http://evil-google.com:8080"
            />,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        const says = [...container.querySelectorAll('[data-rn="Text"]')].find((text) =>
          drawn(text.textContent ?? "").includes("says"),
        );
        if (!says) throw new Error(`No site line in ${container.textContent ?? ""}`);
        expect(frames.cut(says), "the site is cut").toBe(false);
        expect(drawn(frames.shown(says))).toBe("http://evil-google.com:8080 says");
        // The dialog is an alert's width (320 at most, less its padding and the globe): a part of
        // the address wider than that line may break inside itself, and only then.
        const line = Math.min(readingColumn(phone), 320 - 2 * 18 - 12 - 6);
        expect(
          textFaults(frames, { column: line }).filter((fault) => fault.includes("evil")),
        ).toEqual([]);
      });
});
