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
 * request card draws each consent line as the plugin's words with its addresses as addresses
 * (`sentenceWith`), so a host breaks only at its joints. Laid out here at 3.571 on the smallest
 * phone, the line drawn as the card draws it, and the same line drawn raw, as it was.
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

const { AddressSentence } = await import("../ui/address-text.js");
const { AppText } = await import("../ui/primitives.js");
const { sentenceWith } = await import("../ui/sentence-addresses.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const smallest = layoutPhones[0]!;
const [sites] = pluginConsentLines({
  author: "catalog",
  consent: {
    credential: "sealed",
    digest: "a".repeat(64),
    sites: ["https://api.github.com", "https://uploads.github.com"],
  },
  pluginName: "GitHub",
  providerName: "GitHub",
});

/** The words broken inside themselves in what `line` draws, at 3.571 in the card's column. */
async function brokenIn(line: ReactNode): Promise<string[]> {
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
  return [...container.querySelectorAll('[data-rn="Text"]')].flatMap((text) =>
    frames.broken(text).map(({ word }) => word.replace(/[⁠​]/gu, "")),
  );
}

describe("the GitHub plugin's consent line, at the largest text size on the smallest phone", () => {
  it("breaks its hosts only at their joints, drawn as the card draws it", async () => {
    expect(sites!.addresses).toEqual(["api.github.com", "uploads.github.com"]);
    const broken = await brokenIn(
      <AddressSentence parts={sentenceWith(sites!.text, sites!.addresses)} role="secondary" />,
    );
    expect(broken.filter((word) => /github/u.test(word))).toEqual([]);
  });

  it("broke its hosts inside themselves drawn raw, as it was", async () => {
    const broken = await brokenIn(<AppText role="secondary">{sites!.text}</AppText>);
    expect(broken.some((word) => /github\.com/u.test(word))).toBe(true);
  });
});
