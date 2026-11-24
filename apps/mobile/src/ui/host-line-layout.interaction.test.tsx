// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layout, layoutWindow } from "../../test-support/yoga-frames.js";
import { layoutPhones } from "../../test-support/layout-phones.js";

/*
 * A host where there is one line (`HostLine`), laid out as the phone lays it out, at the largest
 * text size on the smallest phone: in a tab row's text column, and in the narrow chip a thread
 * draws a page's site in. It never cuts inside its registrable domain: the words around it go
 * first, entirely; then whole labels from its left behind an ellipsis; and when even the
 * registrable domain does not fit it takes another line, never cut, never crushed behind a scheme.
 * A scheme that is not https is never given up.
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
const { hostLineParts } = await import("./host-line-parts.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const smallest = layoutPhones[0]!;
/** A tab row's text column there: the gutters, its picture, the gap, its "…" menu. */
const tabColumn = smallest.window.width - 2 * 16 - 56 - 12 - 44;
/** A thread's page chip: its site at most 45% of the chip's row. */
const chip = Math.floor((smallest.window.width - 2 * 16) * 0.45);
const drawn = (text: string) => text.replace(/[\u2060\u200B]/gu, "");

/** What each of the line's drawn texts shows at `width`, in order, with where it was cut. */
async function shownTexts(line: ReactNode, width: number, fontScale = 3.571) {
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
  // What is drawn: not the unseen copies it measures itself by.
  return [...container.querySelectorAll('[data-rn="Text"]')]
    .filter(
      (text) =>
        text.closest('[data-testid="host-line-measure"], [data-testid="host-line-room"]') === null,
    )
    .map((text) => ({
      cut: frames.ellipsis(text),
      shown: drawn(frames.shown(text)),
      width: frames.frame(text).width,
    }));
}

/** The line as a person reads it: each text as shown, an ellipsis where one was cut. */
const read = (texts: readonly { shown: string; cut: "start" | "end" | null }[]) =>
  texts
    .map(({ cut, shown }) => (cut === "start" ? `…${shown}` : cut === "end" ? `${shown}…` : shown))
    .join("");

/** What the host's own texts may show: its whole registrable domain, behind whole labels. */
function expectHostKept(
  host: string,
  texts: readonly { shown: string; cut: unknown; width: number }[],
) {
  const parts = hostLineParts(host);
  const line = read(texts as never);
  // Nothing of the host is cut by an ellipsis, and nothing drawn is crushed to nothing.
  for (const text of texts) expect(text.width, line).toBeGreaterThan(0);
  expect(line.replace(/\s+/gu, "")).toContain(parts.kept);
  if (parts.scheme !== "") expect(line.startsWith(parts.scheme), line).toBe(true);
  // What stands before the registrable domain is whole labels, behind an ellipsis if any went.
  const before = line.replace(/\s+/gu, "").slice(parts.scheme.length).split(parts.kept)[0]!;
  const labels = parts.labels.join("");
  expect(
    before === labels ||
      (before.startsWith("…") &&
        labels.endsWith(before.slice(1)) &&
        (before.length === 1 ||
          parts.labels.some(
            (_l, index) => parts.labels.slice(index).join("") === before.slice(1),
          ))),
    line,
  ).toBe(true);
}

const hosts = [
  "evil-google.com",
  "accounts.google.com.evil.example",
  "xn--pypal-4ve.com",
  "http://192.168.1.20:8080",
  "http://evil.example",
  "shop.averyveryverylongcompanyname.co.uk",
];

describe("a host where there is one line, at the largest text size on the smallest phone", () => {
  for (const host of hosts)
    for (const [where, width] of [
      ["a tab row's text column", tabColumn],
      ["the narrow chip", chip],
    ] as const)
      it(`keeps ${host} whole to its registrable domain in ${where}`, async () => {
        const texts = await shownTexts(<HostLine host={host} role="caption" tone="muted" />, width);
        expectHostKept(host, texts);
      });

  it("keeps http://evil.example whole at three characters' width, on lines of its own", async () => {
    const texts = await shownTexts(<HostLine host="http://evil.example" role="caption" />, 3 * 26);
    expect(texts.every(({ cut }) => cut === null)).toBe(true);
    expect(read(texts)).toBe("http://evil.example");
    expect(texts[0]!.width).toBeGreaterThan(0);
  });

  it("gives up the words after the host entirely once the host loses a label", async () => {
    const texts = await shownTexts(
      <HostLine
        after=" · Shared with Errand · Loading…"
        host="accounts.google.com.evil.example"
        role="caption"
        tone="muted"
      />,
      tabColumn,
    );
    expect(read(texts)).not.toContain("Shared");
    expectHostKept("accounts.google.com.evil.example", texts);
  });

  it("keeps a stump of the words after it while the host is whole", async () => {
    const texts = await shownTexts(
      <HostLine after=" · Shared with Errand · Loading…" host="github.com" role="caption" />,
      tabColumn + 60,
      1.35,
    );
    expect(texts.map(({ shown }) => shown)[0]).toBe("github.com");
    expect(texts.at(-1)?.cut).toBe("end");
  });

  // Where some of it fits on one line: whole labels go from its left, behind an ellipsis.
  it("gives up whole labels from the left where the rest fits one line", async () => {
    const texts = await shownTexts(
      <HostLine host="accounts.google.com.evil.example" role="caption" />,
      tabColumn,
      1.35,
    );
    const line = read(texts);
    expect(["…google.com.evil.example", "…com.evil.example", "…evil.example"]).toContain(line);
    expect(texts.every(({ cut }) => cut === null)).toBe(true);
  });

  it("is drawn whole where it fits", async () => {
    const texts = await shownTexts(
      <HostLine after=" says" host="github.com" role="caption" tone="muted" />,
      smallest.window.width - 2 * 16,
      1,
    );
    expect(texts).toMatchObject([
      { cut: null, shown: "github.com" },
      { cut: null, shown: "says" },
    ]);
  });
});

// The re-check of 5d197dfbc..e7080ea31: the widths it measured were kept by slot, so on the render
// after its host changed it planned the new host by the old one's widths, and drew evil-google.com
// on one line, overflowing, until it was measured again.
describe("a host where there is one line, when what it draws changes", () => {
  it("draws nothing by the widths of what it drew before", async () => {
    layoutWindow.fontScale = 1;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const frame = (host: string) => (
      <View style={{ height: smallest.window.height, width: smallest.window.width }}>
        <View style={{ flexDirection: "row", width: 120 }}>
          <HostLine host={host} role="caption" />
        </View>
      </View>
    );
    await act(async () => root.render(frame("github.com")));
    await layout(container, smallest.window);
    // The render right after the change, before anything has been measured again: the same
    // slots as before (its registrable domain alone), with other words in them.
    await act(async () => root.render(frame("evil-google.com")));
    const drawnNow = [...container.querySelectorAll('[data-rn="Text"]')]
      .filter(
        (text) =>
          text.closest('[data-testid="host-line-measure"], [data-testid="host-line-room"]') ===
          null,
      )
      .map((text) => drawn(text.textContent ?? ""));
    expect(drawnNow.some((words) => words.includes("evil-google"))).toBe(false);
    // Once measured, it is drawn by its own widths: whole, on lines of its own.
    const frames = await layout(container, smallest.window);
    const shown = [...container.querySelectorAll('[data-rn="Text"]')]
      .filter(
        (text) =>
          text.closest('[data-testid="host-line-measure"], [data-testid="host-line-room"]') ===
          null,
      )
      .map((text) => ({ cut: frames.cut(text), words: drawn(text.textContent ?? "") }));
    expect(shown).toEqual([{ cut: false, words: "evil-google.com" }]);
  });

  // React Native lays a view out again only when its frame changes: a new host of the same width
  // as the old one still reaches the screen, measured as its own.
  it("draws a new host of the same width as the old one", async () => {
    layoutWindow.fontScale = 1;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const frame = (host: string) => (
      <View style={{ height: smallest.window.height, width: smallest.window.width }}>
        <View style={{ flexDirection: "row", width: 200 }}>
          <HostLine host={host} role="caption" />
        </View>
      </View>
    );
    await act(async () => root.render(frame("github.com")));
    await layout(container, smallest.window);
    await act(async () => root.render(frame("gitlab.com")));
    const frames = await layout(container, smallest.window);
    const shown = [...container.querySelectorAll('[data-rn="Text"]')]
      .filter(
        (text) =>
          text.closest('[data-testid="host-line-measure"], [data-testid="host-line-room"]') ===
          null,
      )
      .map((text) => ({ cut: frames.cut(text), words: drawn(text.textContent ?? "") }));
    expect(shown).toEqual([{ cut: false, words: "gitlab.com" }]);
  });
});
