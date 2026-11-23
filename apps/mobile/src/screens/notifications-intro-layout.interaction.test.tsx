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
  inside,
  layout,
  layoutWindow,
  reachable,
  readingColumn,
  textElement,
  textFaults,
} from "../../test-support/yoga-frames.js";

/*
 * The notifications sheet, the first thing over Home once a phone reaches a Home, laid out by
 * React Native's own layout engine. The phone walk of 963f808d0 saw it at the largest text size
 * with its title broken inside "needed" and Continue below the sheet's edge, which nothing
 * scrolled: the walk could not answer it. A sheet that fits its contents is never taller than
 * the screen below the status bar; here the answers can be reached and no word breaks.
 */

const platform = vi.hoisted(() => ({ os: "ios" as "ios" | "android" }));
const geometry = vi.hoisted(() => ({
  insets: { bottom: 0, left: 0, right: 0, top: 0 },
  window: { height: 0, width: 0 },
}));

vi.mock("react-native", async () => {
  const native = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    ...native,
    Platform: {
      ...(native as { Platform?: object }).Platform,
      get OS() {
        return platform.os;
      },
      select: (choices: Record<string, unknown>) => choices[platform.os] ?? choices.default,
    },
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
vi.mock("../../assets/icon.png", () => ({ default: 1 }));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({
    goBack: () => undefined,
    isFocused: () => true,
    navigate: () => undefined,
  }),
}));
vi.mock("../ui/mobile-client-context.js", () => ({ useHostValue: () => true }));
vi.mock("../ui/notifications-context.js", () => ({
  useMobileNotifications: () => ({
    intro: null,
    registration: { requestPermission: async () => undefined },
  }),
  usePushRegistration: () => ({ status: "unknown" }),
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/pane.js", () => ({ useContentInsets: () => geometry.insets }));
vi.mock("../ui/screen.js", () => ({ useGutter: () => 16 }));

const { NotificationsIntroScreen } = await import("./notifications-intro.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
  platform.os = "ios";
});

async function draw(phone: LayoutPhone, fontScale: number) {
  // Inside a form sheet the safe area's top inset is zero: the sheet already stands below the
  // status bar (react-native-screens gives the sheet's content its own safe area). Its bottom is
  // the screen's.
  geometry.insets = { ...phone.insets, top: 0 };
  geometry.window = phone.window;
  Object.assign(layoutWindow, phone.window, { fontScale });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  // The sheet, as iOS draws a form sheet at its largest: it sizes to what it holds, and stands
  // below the status bar and a 10 pt gap (UISheetPresentationController's large detent), so it is
  // never taller than the window less those. What it holds is clipped at its edge.
  const top = phone.insets.top + 10;
  await act(async () =>
    root.render(
      <View style={phone.window}>
        <View
          style={{
            marginTop: top,
            maxHeight: phone.window.height - top,
            overflow: "hidden",
            width: phone.window.width,
          }}
          testID="sheet"
        >
          <NotificationsIntroScreen />
        </View>
      </View>,
    ),
  );
  const frames = await layout(container, phone.window);
  expect(frames.settled, "the layout never comes to rest").toBe(true);
  expect(
    textFaults(frames, {
      column: readingColumn(phone),
      // The example notification is cut to its lines by design, as a banner is.
      preview: (words) => words.startsWith("Update the pricing") || words.startsWith("Needs your"),
    }),
    "a text a person reads is broken or cut",
  ).toEqual([]);
  return { container, frames };
}

describe("the notifications sheet", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      for (const os of ["ios", "android"] as const)
        it(`can be answered on ${os}, on ${phone.name}, at text size ${fontScale}`, async () => {
          platform.os = os;
          const { container, frames } = await draw(phone, fontScale);
          // A title breaks only between words, whatever the size: it is capped where its widest
          // word fits the narrowest phone.
          expect(frames.broken(textElement(container, "Know when"))).toEqual([]);
          const sheet = frames.frame(container.querySelector('[data-testid="sheet"]')!);
          const answers = os === "ios" ? ["Continue"] : ["Enable notifications", "Not now"];
          // The answers stay in view, inside the sheet's edge, whatever the words above them.
          for (const answer of answers) {
            const button = textElement(container, answer);
            expect(reachable(frames, button, phone.window), `${answer} can't be reached`).toBe(
              true,
            );
            expect(inside(frames.frame(button), sheet), `${answer} is past the sheet's edge`).toBe(
              true,
            );
          }
          // The words have room to be read: never a peephole above the answers.
          const words = frames.frame(container.querySelector('[data-rn="ScrollView"]')!);
          expect(words.height, "the words' window").toBeGreaterThanOrEqual(sheet.height * 0.4);
        });
});
