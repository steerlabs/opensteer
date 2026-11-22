// @vitest-environment happy-dom
import type { SurfaceModel } from "@opensteer/client/host";
import { mockCardUseRequest, mockPasswordSignInRequest } from "@opensteer/client/mock";
import { controlledClientSession } from "@opensteer/client/test-support";
import type { Request } from "@opensteer/core";
import { act, type ReactNode } from "react";
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
} from "../../test-support/yoga-frames.js";
import { createThreadMutationGate } from "./thread-mutation-gate.js";

/*
 * The saved login and saved card sheets, laid out by React Native's own layout engine on the
 * smallest phone and on iPhone Duo, at the default and the largest text size. On the Duo the
 * walk saw the clock and Wi-Fi of the vertical bar over the credential copy and the card's
 * heading, which also stood twice, once in the bar and once under it. Here the heading is said
 * once, nothing a person reads is under the vertical bar or cut, and the answers are reachable.
 */

const geometry = vi.hoisted(() => ({ insets: { bottom: 0, left: 0, right: 0, top: 0 } }));

vi.mock(
  "react-native",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReactNative,
);
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => geometry.insets,
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success" },
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
  selectionAsync: async () => undefined,
}));
vi.mock("./agent-mark.js", () => ({
  AgentEngine: ({ children }: { readonly children: unknown }) => children,
  AskerMark: () => null,
  threadEngine: () => null,
}));
vi.mock("./password-approval-auth.js", () => ({ authenticatePasswordApproval: async () => true }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_reason: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/symbol.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Symbol: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 17, width: props.size ?? 17 }} />
    ),
  };
});
vi.mock("../ui/sheet-bar.js", async () => {
  const { Pressable } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    SheetBarButton: (props: { label: string; onPress: () => void }) => (
      <Pressable
        accessibilityLabel={props.label}
        onPress={props.onPress}
        style={{ height: 44, width: 44 }}
      />
    ),
  };
});
vi.mock("../markdown/markdown.js", () => ({ Markdown: () => null }));
vi.mock("./waiting-questions.js", () => ({ QuestionCard: () => null }));
vi.mock("../computers/here-device.js", () => ({ useHereDeviceId: () => null }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({}),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ dispatch: () => undefined, goBack: () => undefined }),
}));
vi.mock("./integration-connect-sheet.js", () => ({ IntegrationConnectCard: () => null }));
vi.mock("./composer-menu.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    NativeMenu: (props: { children?: ReactNode; style?: unknown }) => (
      <View style={[{ minHeight: 44, minWidth: 44 }, props.style]}>{props.children}</View>
    ),
  };
});
vi.mock("../ui/ai-sharing.js", () => import("../../test-support/ai-sharing.js"));

const { RequestSheetContent } = await import("./request-sheet.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

const card = mockCardUseRequest({ index: 4, site: "https://shop.example.com" });
const login = mockPasswordSignInRequest({ index: 3 });
const reads = {
  card: {
    stage: "card-approval",
    permissionVersion: 7,
    cards: [
      {
        id: "00000000-0000-4000-8000-000000000042",
        revision: 1,
        brand: "Visa",
        lastFour: "4242",
        label: "Preview card",
        expiryMonth: 12,
        expiryYear: 2030,
      },
    ],
  },
  login: { stage: "approval", permissionVersion: 6, accounts: [] },
} as const;

async function draw(phone: LayoutPhone, fontScale: number, request: Request, read: object) {
  // A sheet reaches the window's sides: the vertical bar is in its own safe area.
  geometry.insets = { ...phone.insets, top: 0 };
  Object.assign(layoutWindow, phone.window, { fontScale });
  const session = controlledClientSession();
  const surface: SurfaceModel = {
    denied: null,
    queued: 0,
    queuedTitle: null,
    request: { ...request, reviewedRevision: "1" },
    textRole: "message",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <View style={phone.window}>
        <RequestSheetContent
          canRespond
          canStartResponse={() => true}
          disabledReason={null}
          gate={createThreadMutationGate(null, () => undefined)}
          hostClient={
            {
              connection: session.connection,
              dispatch: async () => undefined,
              getSnapshot: () => ({ machines: [], threads: [], harnesses: [] }),
              getThreadTranscript: () => undefined,
              load: async () => undefined,
              refresh: async () => undefined,
              rpc: {
                "browser.password-sign-in.get": async () => ({ ok: true, data: read }),
                "browser.sources.inspect": async () => ({ ok: false }),
              },
              subscribe: () => () => undefined,
            } as never
          }
          machines={[]}
          onClose={() => undefined}
          reason={false}
          surface={surface}
        />
      </View>,
    ),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toMatch(/Expires in|Expired|no longer running/u),
  );
  return { container, frames: await layout(container, phone.window) };
}

const sheets = [
  {
    kind: "card",
    request: card,
    read: reads.card,
    heading: "Use a saved card on shop.example.com?",
    copy: "It isn't handed to the agent",
  },
  {
    kind: "login",
    request: login,
    read: reads.login,
    heading: "Sign in to github.com",
    copy: "It isn't handed to the agent",
  },
] as const;

describe("the saved login and card sheets", () => {
  for (const sheet of sheets)
    for (const phone of layoutPhones)
      for (const fontScale of layoutTextSizes)
        it(`read whole on ${phone.name} at text size ${fontScale}: ${sheet.kind}`, async () => {
          const { container, frames } = await draw(phone, fontScale, sheet.request, sheet.read);
          const bar = {
            height: phone.window.height,
            width: phone.insets.right,
            x: phone.window.width - phone.insets.right,
            y: 0,
          };
          // Its heading, once.
          expect(container.textContent!.split(sheet.heading).length - 1).toBe(1);
          for (const words of [sheet.heading, sheet.copy, "Expires in"]) {
            const text = textElement(container, words);
            expect(frames.cut(text), `"${words}" is cut`).toBe(false);
            if (phone.insets.right > 0)
              expect(overlaps(frames.frame(text), bar), `the vertical bar covers "${words}"`).toBe(
                false,
              );
            expect(reachable(frames, text, phone.window), `"${words}" can't be reached`).toBe(true);
          }
          const decline = [...container.querySelectorAll("[data-pressable]")].find((control) =>
            /Don.t Allow|Don't allow/u.test(control.textContent ?? ""),
          );
          if (!decline) throw new Error(`No Don't Allow: ${container.textContent}`);
          expect(frames.frame(decline).height).toBeGreaterThanOrEqual(43.5);
          expect(reachable(frames, decline, phone.window), "Don't Allow can't be reached").toBe(
            true,
          );
        });
});
