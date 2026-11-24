// @vitest-environment happy-dom
import { browserSignInProblemCopy } from "@opensteer/client/host";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones } from "../../test-support/layout-phones.js";
import { layout, layoutWindow } from "../../test-support/yoga-frames.js";

/*
 * Signing in to a site and saving a password for it are decisions about the site (F14): at the
 * largest text size on the smallest phone the site is drawn whole, as an address inside its
 * sentence, never cut and never broken inside a part that would fit its line.
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
vi.mock("../ui/pane.js", () => ({ useContentInsets: () => ({ left: 0, right: 0 }) }));

const { PasswordSaveBanner } = await import("./password-save-banner.js");
const { AddressSentence } = await import("../ui/address-text.js");
const { AppText } = await import("../ui/primitives.js");
const { sentenceOf } = await import("../ui/sentence-addresses.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const smallest = layoutPhones[0]!;
// Its parts ("mail.", "fixture.", "example") each fit a line at 3.571, so none may break inside.
const site = "https://mail.fixture.example";
const host = "mail.fixture.example";
const drawn = (text: string) => text.replace(/[⁠​]/gu, "");

/** What is laid out at 3.571 on the smallest phone: each text, shown, cut and broken words. */
async function laidOut(node: ReactNode) {
  Object.assign(layoutWindow, smallest.window, { fontScale: 3.571 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <View style={{ height: smallest.window.height, width: smallest.window.width }}>{node}</View>,
    ),
  );
  const frames = await layout(container, smallest.window);
  expect(frames.settled).toBe(true);
  return [...container.querySelectorAll('[data-rn="Text"]')].map((text) => ({
    broken: frames.broken(text).map(({ word }) => drawn(word)),
    cut: frames.cut(text),
    shown: drawn(frames.shown(text)),
    words: drawn(text.textContent ?? ""),
  }));
}

/**
 * Words of the host broken across its joints: drawn raw it is one word, broken anywhere. Drawn
 * as an address it breaks at its joints, and a part breaks inside only when it alone is wider
 * than its line (every word the layout reports broken is), never across a joint.
 */
const brokenInHost = (texts: Awaited<ReturnType<typeof laidOut>>) =>
  texts
    .flatMap(({ broken }) => broken)
    .filter((word) => host.includes(word.replace(/[?.]$/u, "")) && /\.(?=.)/u.test(word));

describe("the words of a sign-in and a saved password, at 3.571 on the smallest phone", () => {
  it("ask to save a password for the site whole, never cut", async () => {
    const texts = await laidOut(
      <PasswordSaveBanner
        bottom={0}
        onAnswer={() => undefined}
        save={
          {
            offer: { offer: { kind: "save", origin: site, username: "person@fixture.invalid" } },
            pending: false,
          } as never
        }
      />,
    );
    const question = texts.find(({ words }) => words.startsWith("Save password for"))!;
    expect(question.cut, question.shown).toBe(false);
    expect(question.shown).toBe(`Save password for ${host}?`);
    expect(brokenInHost(texts)).toEqual([]);
  });

  for (const problem of ["no-state", "unsupported", "stopped"] as const) {
    const copy = browserSignInProblemCopy(problem, { context: "request", site, sourceName: null });
    it(`draw the site whole in a sign-in's "${copy.title}"`, async () => {
      const texts = await laidOut(
        <View style={{ paddingHorizontal: 16 + 14 }}>
          <AddressSentence parts={sentenceOf(copy.titleParts)} role="secondaryMedium" />
          {copy.fix === null ? null : (
            <AddressSentence parts={sentenceOf(copy.fixParts ?? [])} role="caption" />
          )}
        </View>,
      );
      expect(brokenInHost(texts)).toEqual([]);
      expect(texts.some(({ cut }) => cut)).toBe(false);
    });
  }

  it("broke the site inside itself drawn raw, as it was", async () => {
    const copy = browserSignInProblemCopy("no-state", {
      context: "request",
      site,
      sourceName: null,
    });
    const texts = await laidOut(
      <View style={{ paddingHorizontal: 16 + 14 }}>
        <AppText role="secondaryMedium">{copy.title}</AppText>
      </View>,
    );
    expect(texts.flatMap(({ broken }) => broken).some((word) => word.includes("fixture"))).toBe(
      true,
    );
  });
});
