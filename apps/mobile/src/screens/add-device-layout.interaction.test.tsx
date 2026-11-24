// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, layoutTextSizes } from "../../test-support/layout-phones.js";
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
 * Add a device on the phone, in its sheet, laid out by React Native's own layout engine at the
 * smallest phone and beside iPhone Duo's vertical bar, at the default and the largest text
 * size. The walk saw the first title under the sheet's header and the lower rows out of reach.
 * Here every title sits below the header and every row can be scrolled to.
 */

vi.mock("react-native", async () => {
  const base = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    ...base,
    // A sheet is the window it is shown in; the keyboard is down.
    KeyboardAvoidingView: base.View,
    Modal: (props: { children?: ReactNode; visible?: boolean }) =>
      props.visible === false ? null : props.children,
    TextInput: Object.assign(base.TextInput, { State: { currentlyFocusedInput: () => null } }),
  };
});
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("react-native-safe-area-context", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    SafeAreaProvider: (props: { children?: ReactNode }) => props.children,
    SafeAreaView: (props: { children?: ReactNode; style?: unknown }) => (
      <View style={props.style}>{props.children}</View>
    ),
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
  };
});
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
// Marks are their size: what they draw inside is not what this reads.
vi.mock("../ui/symbol.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Symbol: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 17, width: props.size ?? 17 }} />
    ),
  };
});
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: async () => undefined,
  selectionAsync: async () => undefined,
}));

const { Sheet } = await import("../ui/sheet.js");
const { AddDeviceGuide, addDeviceGuideSections } = await import("./add-device-guide.js");
const { SettingsComputerEnrollment } = await import("./settings-computer-enrollment.js");
const { MockHostClient } = await import("@opensteer/client/mock");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const hosts: { dispose(): void }[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

describe("Add a device in its sheet", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`keeps every title below the header and every row in reach on ${phone.name} at text size ${fontScale}`, async () => {
        Object.assign(layoutWindow, phone.window, { fontScale });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        const sections = addDeviceGuideSections({ onConnectSomethingElse: () => undefined });
        const host = new MockHostClient({ latencyMs: 0 });
        hosts.push(host);
        await act(async () =>
          root.render(
            <View style={{ height: phone.window.height, width: phone.window.width }}>
              <Sheet onClose={() => undefined} open title="Add a device">
                {/* As the Devices screen draws it: a computer's command first, then the guide. */}
                <SettingsComputerEnrollment host={host} />
                <AddDeviceGuide sections={sections} />
              </Sheet>
            </View>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        expect(
          textFaults(frames, { column: readingColumn(phone) }),
          "a text a person reads is broken or cut",
        ).toEqual([]);
        const header = textElement(container, "Add a device");
        const head = header.parentElement!;
        for (const section of sections) {
          const title = textElement(container, section.title);
          expect(
            overlaps(frames.frame(title), frames.frame(head)),
            `"${section.title}" sits under the sheet's header`,
          ).toBe(false);
          expect(reachable(frames, title, phone.window), `"${section.title}" is out of reach`).toBe(
            true,
          );
        }
        // The computer's name and the command's button, whole.
        const create = textElement(container, "Create connection command");
        expect(
          reachable(frames, create, phone.window),
          "Create connection command is out of reach",
        ).toBe(true);
        const last = sections.at(-1)!.rows.at(-1)!;
        const lastRow = textElement(container, last.label);
        expect(reachable(frames, lastRow, phone.window), "the last row is out of reach").toBe(true);
        // Each section is its own row of the list: no two share a key.
        expect(new Set(sections.map((section) => section.key)).size).toBe(sections.length);
      });
});
