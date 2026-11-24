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
  layout,
  layoutWindow,
  overlaps,
  reachable,
  textElement,
  readingColumn,
  textFaults,
} from "../../test-support/yoga-frames.js";

/*
 * "This Home is no longer here", laid out by React Native's own layout engine on the smallest
 * phone and on iPhone Duo, at the default and the largest text size. The walk saw the title
 * under the bar and the way back below the screen with no way to scroll to it. Here the title
 * is clear of the bar, nothing is cut, and the way back can be reached and is a touch high.
 */

const geometry = vi.hoisted(() => ({
  insets: { bottom: 0, left: 0, right: 0, top: 0 },
  window: { height: 0, width: 0 },
}));

vi.mock("@react-navigation/elements", async () => ({
  // The bar's height a route's screens are given: none on a route without one.
  HeaderHeightContext: (await import("react")).createContext<number | undefined>(undefined),
}));
vi.mock(
  "react-native",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReactNative,
);
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
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    canGoBack: () => false,
    goBack: () => undefined,
    navigate: () => undefined,
  }),
}));
vi.mock("../navigation-ref.js", () => ({ resetToDeployments: () => undefined }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({ rows: [], selection: { deploymentId: null, hostClient: null } }),
}));
vi.mock("../ui/shell-gate.js", () => ({ useShellGate: () => undefined }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/connection-gate.js", () => ({ ConnectionGate: () => null }));
vi.mock("../ui/route-gate.js", () => ({ ConnectionRouteGate: () => null }));
vi.mock("./gate-asleep-line.js", () => ({ GateAsleepLine: () => null }));
vi.mock("../iphone-apps/context.js", () => ({ useOptionalIphoneApps: () => null }));
vi.mock("../phone-setup/removed-view.js", () => ({ RemovedView: () => null }));
vi.mock("./use-deployment-update.js", () => ({ useDeploymentUpdate: () => null }));
vi.mock("./deployment-update.js", () => ({ deploymentUpdateRows: () => [] }));

const { DeploymentGate } = await import("./deployment-gate.js");
const { HeaderHeightContext } = await import("@react-navigation/elements");
const { deploymentsTitle } = await import("./deployments-title.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

/**
 * How the route shows a bar: a transparent one over the content, whose height it hands the gate
 * (Home, a thread); an opaque one the stack lays the screen out below; or none.
 */
type Bar = "transparent" | "opaque" | "none";

async function draw(phone: LayoutPhone, fontScale: number, bar: Bar = "transparent") {
  geometry.insets = phone.insets;
  geometry.window = phone.window;
  Object.assign(layoutWindow, phone.window, { fontScale });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  // As Home draws it: under its bar, which the gate is told to clear.
  await act(async () =>
    root.render(
      <View style={phone.window}>
        {/* The safe-area provider stands outside the stack: under an opaque bar its top inset
            is still the status bar's, though the bar already clears it. */}
        <HeaderHeightContext.Provider value={bar === "none" ? undefined : phone.header}>
          <DeploymentGate
            deploymentId="dep_00000000-0000-4000-8000-0000000000ff"
            {...(bar === "transparent" ? { paddingTop: phone.header } : {})}
          />
        </HeaderHeightContext.Provider>
      </View>,
    ),
  );
  const frames = await layout(container, phone.window);
  // A layout that never comes to rest is a measure loop: the phone's main thread stays busy.
  expect(frames.settled, "the layout never comes to rest").toBe(true);
  expect(
    textFaults(frames, { column: readingColumn(phone) }),
    "a text a person reads is broken or cut",
  ).toEqual([]);
  return { container, frames };
}

describe("a Home that is no longer here, at every text size", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`reads whole and goes back on ${phone.name} at text size ${fontScale}`, async () => {
        const { container, frames } = await draw(phone, fontScale);
        const bar = { height: phone.header, width: phone.window.width, x: 0, y: 0 };
        const title = textElement(container, "This Home is no longer here");
        expect(frames.cut(title), "the title is cut").toBe(false);
        expect(overlaps(frames.frame(title), bar), "the bar covers the title").toBe(false);
        expect(reachable(frames, title, phone.window), "the title can't be reached").toBe(true);
        const words = textElement(container, "It isn’t in this phone’s list any more.");
        expect(frames.cut(words)).toBe(false);
        expect(reachable(frames, words, phone.window), "the words can't be reached").toBe(true);
        const back = [...container.querySelectorAll("[data-pressable]")].find(
          (control) => control.textContent === deploymentsTitle,
        );
        if (!back) throw new Error(`No way back: ${container.textContent}`);
        expect(reachable(frames, back, phone.window), "the way back can't be reached").toBe(true);
        expect(
          frames.frame(back).height,
          "the way back is smaller than a touch",
        ).toBeGreaterThanOrEqual(43.5);
      });
});

/*
 * The reader's re-check of 5ebc2cbbd: a route with no header (setting up this phone again, where
 * a removed phone is told so) passes the gate no room for a bar, and the gate gave its words none
 * for the status bar either: at the largest text size they scrolled up under the island.
 */
describe("the gate on a route with no header, at the largest text size", () => {
  const islandPhone: LayoutPhone = {
    header: 103,
    insets: { bottom: 34, left: 0, right: 0, top: 59 },
    name: "a phone with an island",
    window: { height: 844, width: 390 },
  };
  for (const phone of [layoutPhones[0]!, islandPhone])
    it(`keeps its words below the status bar on ${phone.name}`, async () => {
      const { container, frames } = await draw(phone, layoutTextSizes.at(-1)!, "none");
      const title = textElement(container, "This Home is no longer here");
      expect(frames.frame(title).y).toBeGreaterThanOrEqual(phone.insets.top);
    });
});

/*
 * The reader's re-check 9, finding 6: 04f9b2b89 cleared the status bar whenever the gate was not
 * handed a bar's height, and every route with an opaque bar hands none, the stack laying the
 * screen out below it: 59 pt of space under the bar on Tabs, Apps, Done, Needs you and more.
 */
describe("the gate under an opaque bar, at the largest text size", () => {
  const islandPhone: LayoutPhone = {
    header: 103,
    insets: { bottom: 34, left: 0, right: 0, top: 59 },
    name: "a phone with an island",
    window: { height: 844, width: 390 },
  };
  for (const phone of [layoutPhones[0]!, islandPhone])
    it(`starts its words under the bar, with no room for the status bar again, on ${phone.name}`, async () => {
      const { container, frames } = await draw(phone, layoutTextSizes.at(-1)!, "opaque");
      const title = textElement(container, "This Home is no longer here");
      expect(frames.frame(title).y).toBeLessThan(phone.insets.top);
    });
});
