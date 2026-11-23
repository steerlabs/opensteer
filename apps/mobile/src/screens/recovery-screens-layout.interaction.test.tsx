// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, type LayoutPhone } from "../../test-support/layout-phones.js";
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
 * The screens a person meets when something is wrong (F38, the re-check of 963f808d0..fb245664c):
 * a phone its Home removed, a Home that can't be verified or is too old for this phone, the app
 * not starting, and the connection pill's sheet. Laid out by React Native's own layout engine on
 * the narrowest phone at the largest text size: no title breaks inside a word, nothing a person
 * reads is cut, and the way on can be reached. They scrolled not at all before.
 */

const geometry = vi.hoisted(() => ({
  /** The frame the screen's content is given: the window, or a sheet's own frame. */
  frame: null as { height: number; width: number } | null,
  insets: { bottom: 0, left: 0, right: 0, top: 0 },
  window: { height: 0, width: 0 },
}));
const state = vi.hoisted(() => ({ rows: [] as unknown[], deploymentId: null as string | null }));

vi.mock(
  "react-native",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReactNative,
);
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ ...(geometry.frame ?? geometry.window), x: 0, y: 0 }),
  useSafeAreaInsets: () => geometry.insets,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: async () => undefined,
  selectionAsync: async () => undefined,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ canGoBack: () => false, goBack: () => undefined, navigate: () => {} }),
}));
vi.mock("../navigation-ref.js", () => ({ resetToDeployments: () => undefined }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ getSnapshot: () => ({ rows: state.rows, selection: {} }) }),
  useMobileState: () => ({
    rows: state.rows,
    selection: { deploymentId: state.deploymentId, hostClient: null },
  }),
}));
vi.mock("../ui/shell-gate.js", () => ({ useShellGate: () => undefined }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/connection-gate.js", () => ({ ConnectionGate: () => null }));
vi.mock("../ui/route-gate.js", () => ({ ConnectionRouteGate: () => null }));
vi.mock("./gate-asleep-line.js", () => ({ GateAsleepLine: () => null }));
vi.mock("../iphone-apps/context.js", () => ({ useOptionalIphoneApps: () => null }));
vi.mock("./use-deployment-update.js", () => ({ useDeploymentUpdate: () => null }));
vi.mock("./deployment-update.js", () => ({ deploymentUpdateRows: () => [] }));
vi.mock("../client/deployment-rows.js", () => ({
  deploymentStatusDetail: () =>
    "This address answers as another Home than the one this phone added. Check the address on the Home, then try again.",
  deploymentStatusLabel: () => "Can’t verify",
  isMacHomeRow: () => false,
}));

const { RemovedView } = await import("../phone-setup/removed-view.js");
const { removedCopy } = await import("../phone-setup/removed-copy.js");
const { DeploymentGate } = await import("./deployment-gate.js");
const { StartupFailureView } = await import("../startup-failure.js");
const { ConnectionDetails } = await import("../ui/connection-details.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const narrowest = layoutPhones[0]!;
const largest = 3.571;
/** A phone with a Dynamic Island and a home indicator: the insets the smallest phone has none of. */
const islandPhone: LayoutPhone = {
  header: 103,
  insets: { bottom: 34, left: 0, right: 0, top: 59 },
  name: "a phone with an island and a home indicator",
  window: { height: 844, width: 390 },
};

async function draw(phone: LayoutPhone, screen: ReactNode, insets = phone.insets) {
  geometry.insets = insets;
  geometry.window = phone.window;
  if (insets === phone.insets) geometry.frame = null;
  Object.assign(layoutWindow, phone.window, { fontScale: largest });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<View style={phone.window}>{screen}</View>));
  const frames = await layout(container, phone.window);
  expect(frames.settled, "the layout never comes to rest").toBe(true);
  expect(textFaults(frames, { column: readingColumn(phone) }), "a text is broken or cut").toEqual(
    [],
  );
  return { container, frames };
}

const control = (container: Element, label: string) => {
  const found = [...container.querySelectorAll("[data-pressable]")].find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`No "${label}" in ${container.textContent ?? ""}`);
  return found;
};

describe("the screens a person meets when something is wrong, at the largest text size", () => {
  // The one view of it, on iPhone and Android alike (the iPhone's own SwiftUI stack went, F43).
  for (const phone of [narrowest, islandPhone])
    it(`lets a phone its Home removed be set up again, on ${phone.name}`, async () => {
      const copy = removedCopy("iPhone", "Studio Mac mini");
      const { container, frames } = await draw(
        phone,
        <RemovedView {...copy} onNotNow={() => undefined} onSetUpAgain={() => undefined} />,
      );
      expect(frames.broken(textElement(container, "This iPhone was removed"))).toEqual([]);
      for (const label of ["Set up again", "Not now"])
        expect(reachable(frames, control(container, label), phone.window), label).toBe(true);
      // Its words keep the screen's gutter, and its last action clears the home indicator.
      expect(frames.frame(textElement(container, "signed out there")).x).toBeGreaterThanOrEqual(16);
      const content = frames.frame(container.querySelector('[data-rn="ScrollContent"]')!);
      const notNow = frames.frame(control(container, "Not now"));
      expect(content.y + content.height - (notNow.y + notNow.height)).toBeGreaterThanOrEqual(
        phone.insets.bottom,
      );
    });

  it("lets a Home that can't be verified be tried again", async () => {
    state.deploymentId = "dep_00000000-0000-4000-8000-0000000000aa";
    state.rows = [
      {
        deploymentId: state.deploymentId,
        name: "Studio Mac mini",
        signIn: null,
        status: "unverified",
        verification: "host-too-old",
      },
      { deploymentId: "dep_00000000-0000-4000-8000-0000000000bb", name: "Office", signIn: null },
    ];
    const { container, frames } = await draw(
      narrowest,
      <DeploymentGate deploymentId={state.deploymentId as never} paddingTop={narrowest.header} />,
    );
    expect(frames.broken(textElement(container, "Studio Mac mini"))).toEqual([]);
    for (const label of ["Try again", "Other computers"])
      expect(reachable(frames, control(container, label), narrowest.window), label).toBe(true);
  });

  for (const phone of [narrowest, islandPhone])
    it(`says why the app could not start, all of it in reach, on ${phone.name}`, async () => {
      const { container, frames } = await draw(
        phone,
        <StartupFailureView
          detail="This phone’s storage could not be read. Restart the phone, then open Opensteer again."
          title="This device's storage did not answer"
        />,
      );
      expect(frames.broken(textElement(container, "Opensteer could not start"))).toEqual([]);
      expect(reachable(frames, textElement(container, "Restart the phone"), phone.window)).toBe(
        true,
      );
      // Never under the status bar, the island or the home indicator, scrolled to either end.
      const content = frames.frame(container.querySelector('[data-rn="ScrollContent"]')!);
      const title = frames.frame(textElement(container, "Opensteer could not start"));
      expect(title.y - content.y).toBeGreaterThanOrEqual(phone.insets.top);
      const last = frames.frame(textElement(container, "Restart the phone"));
      expect(content.y + content.height - (last.y + last.height)).toBeGreaterThanOrEqual(
        phone.insets.bottom,
      );
    });

  // A sheet that fits its contents, as iOS draws a form sheet at its largest: below the status
  // bar and a 10 pt gap, its content's top inset zero, clipping what it holds.
  it("lets the connection sheet's way on be reached inside the sheet", async () => {
    const top = narrowest.insets.top + 10;
    // Inside the sheet, the frame its content is given is the sheet's own.
    geometry.frame = { height: narrowest.window.height - top, width: narrowest.window.width };
    const { container, frames } = await draw(
      narrowest,
      <View
        style={{
          marginTop: top,
          maxHeight: narrowest.window.height - top,
          overflow: "hidden",
          width: narrowest.window.width,
        }}
        testID="sheet"
      >
        <ConnectionDetails
          action={{ label: "Reconnect", onPress: () => undefined }}
          explanation="Your phone can’t reach Studio Mac mini. Messages you send wait here and go when it’s back."
          mark={<View style={{ height: 28, width: 28 }} />}
          meta="Last connected 9:41 · via Connect"
          name="Studio Mac mini"
          others={[
            { key: "a", name: "Office", onPress: () => undefined, state: "Reconnecting…" },
            { key: "b", name: "Cloud Computer", onPress: () => undefined, state: "Offline" },
          ]}
          state="Reconnecting…"
        />
      </View>,
      { ...narrowest.insets, top: 0 },
    );
    const sheet = frames.frame(container.querySelector('[data-testid="sheet"]')!);
    const reconnect = control(container, "Reconnect");
    expect(reachable(frames, reconnect, narrowest.window), "Reconnect").toBe(true);
    // Pinned: in view inside the sheet without scrolling, below the words that scroll.
    expect(reconnect.closest('[data-rn="ScrollContent"]')).toBeNull();
    expect(inside(frames.frame(reconnect), sheet), "Reconnect is past the sheet's edge").toBe(true);
    // Brought into view by scrolling inside the sheet, never past its edge for good.
    const scroll = frames.frame(container.querySelector('[data-rn="ScrollView"]')!);
    expect(inside(scroll, sheet), "the sheet's words run past its edge").toBe(true);
  });

  // The reader's re-check of 5ebc2cbbd: in landscape the island and the home indicator stand at
  // the sides, and the sheet's words and its Reconnect ran under them.
  it("keeps the connection sheet's words and its Reconnect clear of the sides in landscape", async () => {
    const landscape: LayoutPhone = {
      header: 32,
      insets: { bottom: 21, left: 59, right: 59, top: 0 },
      name: "a phone with an island, on its side",
      window: { height: 390, width: 844 },
    };
    geometry.frame = { height: landscape.window.height, width: landscape.window.width };
    const { container, frames } = await draw(
      landscape,
      <View style={{ maxHeight: landscape.window.height, width: landscape.window.width }}>
        <ConnectionDetails
          action={{ label: "Reconnect", onPress: () => undefined }}
          explanation="Your phone can’t reach Studio Mac mini."
          mark={<View style={{ height: 28, width: 28 }} />}
          meta={null}
          name="Studio Mac mini"
          others={[]}
          state="Offline"
        />
      </View>,
      landscape.insets,
    );
    const clear = (label: string, frame: { x: number; width: number }) => {
      expect(frame.x, `${label} starts under the left side`).toBeGreaterThanOrEqual(
        landscape.insets.left,
      );
      expect(frame.x + frame.width, `${label} runs under the right side`).toBeLessThanOrEqual(
        landscape.window.width - landscape.insets.right,
      );
    };
    clear("the name", frames.frame(textElement(container, "Studio Mac mini")));
    clear("Reconnect", frames.frame(control(container, "Reconnect")));
  });
});
