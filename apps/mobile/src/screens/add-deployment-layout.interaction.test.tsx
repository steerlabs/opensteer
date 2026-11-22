// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, layoutTextSizes } from "../../test-support/layout-phones.js";
import {
  layout,
  layoutWindow,
  textElement,
  readingColumn,
  textFaults,
} from "../../test-support/yoga-frames.js";

/*
 * The account row in Add an Opensteer, laid out by React Native's own layout engine on the
 * smallest phone and beside iPhone Duo's vertical bar, at the smallest and largest text sizes.
 * An email address and the account service's address are read whole: drawn through
 * `AddressText`, they wrap only at their own joints (after "@", at ".", after "//"), no part that
 * fits the column breaks inside itself, and nothing is cut short. Where the phone breaks, and that
 * it adds no hyphen, only a phone shows: the VM walk checks it.
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
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../navigation-ref.js", () => ({
  resetToDeployment: () => undefined,
  resetToDeployments: () => undefined,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({}),
}));
vi.mock("./setup-scanner.js", () => ({ useSetupScanner: () => null }));
vi.mock("../ui/action-line.js", () => ({ ActionLine: () => null }));
// The door's words are not what this lays out.
vi.mock("./account-door.js", () => ({
  accountDoorPresentation: () => ({ description: "", disabled: false, title: "Sign in" }),
  accountFlowCanContinue: () => false,
  accountIdentityLabel: () => "",
  eligibleSingletonDeployment: () => null,
}));
vi.mock("../ui/symbol.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Symbol: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 17, width: props.size ?? 17 }} />
    ),
  };
});

const { AccountIdentityRow } = await import("./add-deployment.js");
const { addressWords } = await import("../ui/address-words.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const email = "alexandra.montgomery-whitfield@northwind-traders.example";
const issuer = "https://accounts.opensteer.example";

describe("the Opensteer account row", () => {
  for (const phone of layoutPhones)
    for (const fontScale of layoutTextSizes)
      it(`reads whole on ${phone.name} at text size ${fontScale}`, async () => {
        Object.assign(layoutWindow, phone.window, { fontScale });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        roots.push(root);
        await act(async () =>
          root.render(
            <View
              style={{
                paddingLeft: 16 + phone.insets.left,
                paddingRight: 16 + phone.insets.right,
                width: phone.window.width,
              }}
            >
              <AccountIdentityRow email={email} issuer={issuer} />
            </View>,
          ),
        );
        const frames = await layout(container, phone.window);
        expect(frames.settled, "the layout never comes to rest").toBe(true);
        expect(
          textFaults(frames, { column: readingColumn(phone) }),
          "a text a person reads is broken or cut",
        ).toEqual([]);
        for (const words of [email, issuer]) {
          const text = textElement(container, words);
          // Drawn the one way: held together inside each part, breakable only between parts.
          expect(text.textContent, `"${words}" is drawn raw`).toBe(addressWords(words));
          expect(frames.shown(text), `"${words}" is cut`).toBe(words);
          expect(
            frames.frame(text).x + frames.frame(text).width,
            `"${words}" runs past the row`,
          ).toBeLessThanOrEqual(phone.window.width - phone.insets.right - 16 + 0.5);
        }
      });
});
