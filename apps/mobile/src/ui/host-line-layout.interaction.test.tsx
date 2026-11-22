// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layout, layoutWindow } from "../../test-support/yoga-frames.js";
import { layoutPhones } from "../../test-support/layout-phones.js";
import { controlFontScaleLimit } from "../theme.js";

/*
 * A host where there is one line (`HostLine`), laid out as the phone lays it out, at the largest
 * text size on the narrowest phone. The line is for the host, so the host is cut alone, at its
 * start, keeping the end that says whose it is; the words after it are cut at their own end and
 * give way first; a scheme that is shown (one that is not https) is never cut.
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
vi.mock("./action-line.js", () => ({ ActionLine: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("./pane.js", () => ({ useContentInsets: () => ({ left: 0, right: 0 }) }));

const { HostLine } = await import("./address-text.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const smallest = layoutPhones[0]!;

/** What each of the line's texts shows at `width`, in order, with where it was cut. */
async function shownTexts(
  line: ReactNode,
  width: number,
  fontScale = 3.571,
): Promise<{ shown: string; cut: "start" | "end" | null }[]> {
  layoutWindow.fontScale = fontScale;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <View style={{ height: smallest.window.height, width: smallest.window.width }}>
        <View style={{ flexDirection: "row", width }}>{line}</View>
      </View>,
    ),
  );
  const frames = await layout(container, smallest.window);
  expect(frames.settled, "the layout never comes to rest").toBe(true);
  return [...container.querySelectorAll('[data-rn="Text"]')].map((text) => ({
    cut: frames.ellipsis(text),
    shown: frames.shown(text),
  }));
}

/** The line as a person reads it: each text as shown, an ellipsis where one was cut. */
const read = (texts: readonly { shown: string; cut: "start" | "end" | null }[]) =>
  texts
    .map(({ cut, shown }) => (cut === "start" ? `…${shown}` : cut === "end" ? `${shown}…` : shown))
    .join("");

describe("a host where there is one line, at the largest text size on the smallest phone", () => {
  // The tab list's row: the host, then what the tab is doing, in the row's text column.
  it("keeps the host's end in a tab's row, and cuts the words after it first", async () => {
    const host = "averylongsubdomain.example.com";
    const texts = await shownTexts(
      <HostLine after=" · Shared with Errand · Loading…" host={host} role="caption" tone="muted" />,
      smallest.window.width - 2 * 16 - 56 - 12 - 44,
    );
    const line = read(texts);
    // The host's own text, cut at its start: what it shows is the host's end.
    const hostText = texts.find(({ shown }) => shown.length > 0 && host.endsWith(shown));
    expect(hostText, line).toBeDefined();
    expect(line.startsWith("…") && line.includes("com"), line).toBe(true);
    expect(line).not.toContain("Loading");
  });

  // The address bar: a scheme that is not https is the warning, so it is never what gives way.
  it("keeps a scheme that is not https in the address bar, and the host's end", async () => {
    const texts = await shownTexts(
      <HostLine
        host="http://averylongsubdomain.example.com:8080"
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="secondaryMedium"
      />,
      smallest.window.width - 2 * 16 - 2 * 44,
    );
    const line = read(texts);
    expect(texts[0], line).toEqual({ cut: null, shown: "http://" });
    // The rest is the host's own text, cut at its start: its end, with the port.
    expect(texts[1]?.cut, line).toBe("start");
    expect("averylongsubdomain.example.com:8080".endsWith(texts[1]!.shown), line).toBe(true);
    expect(texts[1]!.shown.endsWith(":8080"), line).toBe(true);
  });

  it("is drawn whole where it fits", async () => {
    const texts = await shownTexts(
      <HostLine after=" says" host="github.com" role="caption" tone="muted" />,
      smallest.window.width - 2 * 16,
      1,
    );
    expect(texts).toEqual([
      { cut: null, shown: "github.com" },
      { cut: null, shown: "says" },
    ]);
  });
});
