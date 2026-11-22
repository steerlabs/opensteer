// @vitest-environment happy-dom
import { pluginConsentLines } from "@opensteer/client/plugins";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones } from "../../test-support/layout-phones.js";
import { layout, layoutWindow } from "../../test-support/yoga-frames.js";

/*
 * Build 9's walk: the GitHub plugin's consent at the largest size drew "api.github.-" / "com and" /
 * "upload-" / "s.github.com.": its hosts were words of a sentence from the plugin's data. The
 * re-check after it: a plugin names itself and its provider, so a name holding a host beside the
 * real destination read as one, and a search of the sentence could take the name's host for it.
 * The card draws each line's words, then each site the credential may reach as an address of its
 * own, apart from every name. Laid out at 3.571 on the smallest phone.
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
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/pane.js", () => ({ useContentInsets: () => ({ left: 0, right: 0 }) }));

const { AppText } = await import("../ui/primitives.js");
const { AddressText } = await import("../ui/address-text.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const smallest = layoutPhones[0]!;
/** The consent's lines for a plugin that names its provider with a host it never reaches. */
const lines = pluginConsentLines({
  author: "agent",
  consent: {
    credential: "sealed",
    digest: "a".repeat(64),
    sites: ["https://api.github.com", "https://uploads.github.com"],
  },
  pluginName: "evil.example helper",
  providerName: "GitHub for evil.example",
});

/** What `line` draws, laid out at 3.571 in the card's column: each text's words and breaks. */
async function laidOut(line: ReactNode) {
  Object.assign(layoutWindow, smallest.window, { fontScale: 3.571 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <View style={{ paddingHorizontal: 16 + 13, width: smallest.window.width }}>{line}</View>,
    ),
  );
  const frames = await layout(container, smallest.window);
  expect(frames.settled).toBe(true);
  return [...container.querySelectorAll('[data-rn="Text"]')].map((text) => ({
    // An address is drawn with the characters that hold it whole; words are not.
    address: /[\u2060\u200B]/u.test(text.textContent ?? ""),
    broken: frames.broken(text).map(({ word }) => word.replace(/[\u2060\u200B]/gu, "")),
    words: (text.textContent ?? "").replace(/[\u2060\u200B]/gu, ""),
  }));
}

describe("a plugin's consent, at the largest text size on the smallest phone", () => {
  it("draws only the real destinations as addresses, and every name the plugin gives as words", async () => {
    const texts = await laidOut(
      <>
        {lines.map((line) => (
          <View key={line.key}>
            <AppText role="secondary">{line.text}</AppText>
            {line.sites.map((site) => (
              <AddressText key={site} role="secondary" value={site} />
            ))}
          </View>
        ))}
      </>,
    );
    expect(texts.filter(({ address }) => address).map(({ words }) => words)).toEqual([
      "api.github.com",
      "uploads.github.com",
    ]);
    // The name holding a host is words, and never beside a destination in one line.
    const named = texts.filter(({ words }) => words.includes("evil.example"));
    expect(named.every(({ address }) => !address)).toBe(true);
    expect(named.some(({ words }) => words.includes("github.com"))).toBe(false);
    // A host breaks only at its joints: no break inside a part that spans one.
    expect(
      texts.flatMap(({ broken }) => broken).filter((word) => /github\.com/u.test(word)),
    ).toEqual([]);
  });
});
