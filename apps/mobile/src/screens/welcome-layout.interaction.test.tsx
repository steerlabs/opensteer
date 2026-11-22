// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inside,
  layout,
  layoutWindow,
  overlaps,
  textElement,
} from "../../test-support/yoga-frames.js";

vi.mock("react-native", async () => ({
  ...(await import("../../test-support/yoga-frames.js")).layoutReactNative,
  Share: { share: async () => ({ action: "sharedAction" }) },
}));
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: async () => undefined,
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 0 }));
// Marks are their size: what they draw inside is not what this reads.
vi.mock("../ui/symbol.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Symbol: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 17, width: props.size ?? 17 }} />
    ),
  };
});
vi.mock("../ui/screen.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Screen: (props: { children?: ReactNode }) => <View style={{ flex: 1 }}>{props.children}</View>,
    useReadingColumn: () => ({ paddingHorizontal: 16 }),
  };
});

const { Welcome } = await import("./welcome.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const sizes = [
  { name: "the smallest phone", width: 320, height: 568 },
  { name: "beside iPhone Duo's vertical bar", width: 382, height: 678 },
] as const;
const textSizes = [1, 1.35, 3.1] as const;

/*
 * "Where should your Opensteer live?" on a phone: the two places, the Mac link, the website's
 * address and its Copy. Whatever the width and text size, each is whole, nothing covers
 * anything else, and every control is the size of a touch.
 */
describe("where an account's first Opensteer lives, on a phone", () => {
  for (const size of sizes)
    for (const fontScale of textSizes)
      it(`stays whole on ${size.name} at text size ${fontScale}`, async () => {
        layoutWindow.fontScale = fontScale;
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        await act(async () =>
          root.render(
            <View style={{ height: size.height, width: size.width }}>
              <Welcome
                account={
                  {
                    available: true,
                    detail: null,
                    identity: null,
                    origin: "https://accounts.example.com",
                    status: "signed-in",
                  } as never
                }
                cloudAddress="https://app.opensteer.com/cloud-computer/checkout"
                failure={null}
                onAccount={() => undefined}
                onAddress={() => undefined}
                onCopyCloudAddress={() => undefined}
                onScan={() => undefined}
                portalOrigin="https://app.opensteer.com"
                signedInAs="alex@example.com"
                signingIn={false}
              />
            </View>,
          ),
        );
        const frames = await layout(container, size);
        const words = [
          "Where should your Opensteer live?",
          "Free. Works while your Mac is awake.",
          "Always on. Set it up on the Opensteer website, then come back here.",
          "https://app.opensteer.com/cloud-computer/checkout",
          "Your Opensteer appears here as soon as it’s ready.",
        ];
        const said = words.map((text) => textElement(container, text));
        for (const [index, element] of said.entries())
          expect(frames.cut(element), `"${words[index]}" is cut`).toBe(false);
        const controls = [...container.querySelectorAll("[data-pressable]")];
        expect(controls.length).toBeGreaterThanOrEqual(3);
        const page = { height: Number.POSITIVE_INFINITY, width: size.width, x: 0, y: 0 };
        for (const control of controls) {
          const frame = frames.frame(control);
          expect(inside(frame, page), `${control.textContent} runs off the screen`).toBe(true);
          expect(
            frame.height,
            `${control.textContent} is smaller than a touch`,
          ).toBeGreaterThanOrEqual(43.5);
          for (const element of said)
            if (!control.contains(element))
              expect(
                overlaps(frame, frames.frame(element)),
                `${control.textContent} covers "${element.textContent}"`,
              ).toBe(false);
        }
        for (let a = 0; a < said.length; a += 1)
          for (let b = a + 1; b < said.length; b += 1)
            expect(
              overlaps(frames.frame(said[a]!), frames.frame(said[b]!)),
              `"${words[a]}" and "${words[b]}" cover each other`,
            ).toBe(false);
      });
});

describe("the phone's front door", () => {
  for (const size of sizes)
    for (const fontScale of textSizes)
      it(`keeps Sign in and Other ways in whole on ${size.name} at text size ${fontScale}`, async () => {
        layoutWindow.fontScale = fontScale;
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        await act(async () =>
          root.render(
            <View style={{ height: size.height, width: size.width }}>
              <Welcome
                account={
                  {
                    available: true,
                    detail: null,
                    identity: null,
                    origin: "https://accounts.example.com",
                    status: "signed-out",
                  } as never
                }
                failure={null}
                onAccount={() => undefined}
                onAddress={() => undefined}
                onScan={() => undefined}
                portalOrigin="https://app.opensteer.com"
                signingIn={false}
              />
            </View>,
          ),
        );
        const frames = await layout(container, size);
        const sentence = textElement(container, "will find your Opensteer");
        expect(frames.cut(sentence), "the sentence is cut").toBe(false);
        const controls = [...container.querySelectorAll("[data-pressable]")];
        expect(controls.map((control) => control.textContent)).toEqual([
          "Sign in",
          "Other ways in",
        ]);
        for (const control of controls) {
          const frame = frames.frame(control);
          expect(
            frame.height,
            `${control.textContent} is smaller than a touch`,
          ).toBeGreaterThanOrEqual(43.5);
          expect(overlaps(frame, frames.frame(sentence))).toBe(false);
          expect(frame.x + frame.width).toBeLessThanOrEqual(size.width);
        }
        expect(overlaps(frames.frame(controls[0]!), frames.frame(controls[1]!))).toBe(false);
      });
});
