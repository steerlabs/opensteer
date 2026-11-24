// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TabsClient } from "@opensteer/client/host";
import { MockHostClient, mockIphoneRunnerId } from "@opensteer/client/mock";
import type { WebViewProps } from "react-native-webview";

const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => undefined) }));
const webViews = vi.hoisted(() => [] as WebViewProps[]);
const navigation = vi.hoisted(() => ({
  dispatch: vi.fn(),
  routes: [] as { key: string; name: string; params: Record<string, unknown> }[],
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Linking: linking,
  Platform: { OS: "ios", Version: "27.0", isPad: false, select: () => undefined },
  Pressable: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  StyleSheet: {
    create: <T,>(styles: T) => styles,
    absoluteFill: {},
    hairlineWidth: 1,
  },
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: WebViewProps) => {
    webViews.push(props);
    return null;
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: ReactNode }) => <div>{props.children}</div> },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  withTiming: (value: unknown) => value,
}));
vi.mock("@opensteer/client/react", () => ({
  useAppView: () => ({
    view: { title: "Leads", url: "https://host.test/v1/apps/app_1/dark/token/" },
    failed: false,
    retry: () => undefined,
  }),
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: {
    pop: () => ({ type: "POP" }),
    push: (name: string, params: Record<string, unknown>) => ({ type: "PUSH", name, params }),
    replace: (name: string, params: Record<string, unknown>) => ({
      type: "REPLACE",
      name,
      params,
    }),
  },
  useNavigation: () => ({
    dispatch: navigation.dispatch,
    getState: () => ({ index: navigation.routes.length - 1, routes: navigation.routes }),
  }),
}));
vi.mock("@expo/ui/community/menu", () => ({ MenuView: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock("../ui/primitives.js", () => ({ AppText: () => null, monoFontFamily: "Menlo" }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));

import type { IphoneAppsController } from "../iphone-apps/controller.js";
import { IphoneAppsProvider } from "../iphone-apps/context.js";
import { AppFrame } from "./app-frame.js";
import { ConversationLinksProvider } from "./conversation-links.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  linking.openURL.mockClear();
  navigation.dispatch.mockReset();
  navigation.routes = [];
  webViews.length = 0;
});

/** This phone, enrolled in the Deployment as the mock world's iPhone. */
function phone(deploymentId: string): IphoneAppsController {
  const state = {
    snapshot: { enrollment: { deploymentId, runnerId: mockIphoneRunnerId, state: "enrolled" } },
  };
  return {
    getState: () => state,
    subscribe: () => () => undefined,
  } as unknown as IphoneAppsController;
}

function app(around: "conversation" | "tab" | "nothing", onOpen?: () => void) {
  const host = new MockHostClient({ latencyMs: 0 });
  const snapshot = host.getSnapshot();
  const deploymentId = snapshot.deploymentId!;
  const threadId = snapshot.threads[0]!.id;
  const frame = <AppFrame appId="app_1" client={host} />;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <IphoneAppsProvider controller={phone(deploymentId)}>
        {around === "nothing" ? (
          frame
        ) : (
          <ConversationLinksProvider
            deploymentId={deploymentId}
            hostClient={host}
            threadId={around === "conversation" ? threadId : undefined}
            onOpen={onOpen}
          >
            {frame}
          </ConversationLinksProvider>
        )}
      </IphoneAppsProvider>,
    ),
  );
  navigation.dispatch.mockImplementation(
    (action: { type: string; name?: string; params?: Record<string, unknown> }) => {
      if (action.type === "PUSH")
        navigation.routes.push({ key: "opening", name: action.name!, params: action.params! });
      if (action.type === "REPLACE")
        navigation.routes.splice(0, 1, {
          key: "tab",
          name: action.name!,
          params: action.params!,
        });
    },
  );
  const view = webViews.at(-1)!;
  return {
    host,
    threadId,
    openWindow: (url: string) =>
      act(() =>
        view.onOpenWindow!({ nativeEvent: { targetUrl: url } } as Parameters<
          NonNullable<WebViewProps["onOpenWindow"]>
        >[0]),
      ),
    follow: (url: string) =>
      act(() => {
        view.onShouldStartLoadWithRequest!({
          url,
          isTopFrame: true,
          navigationType: "click",
        } as Parameters<NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>>[0]);
      }),
  };
}

const tabOpened = () =>
  vi.waitFor(() => {
    if (navigation.routes[0]?.name !== "WorkspaceBrowser") throw new Error("No tab shown yet.");
  });

it("opens a link tapped in a conversation's app where the conversation's own links open", async () => {
  const { host, openWindow, threadId } = app("conversation");
  const open = vi.spyOn(host as unknown as TabsClient, "openTab");
  openWindow("https://www.linkedin.com/in/someone");
  expect(open).toHaveBeenCalledExactlyOnceWith({
    kind: "page",
    profileId: "bpr_00000000-0000-4000-8000-000000000003",
    url: "https://www.linkedin.com/in/someone",
  });
  await tabOpened();
  expect(navigation.routes[0]!.params).toMatchObject({ threadId });
  expect(linking.openURL).not.toHaveBeenCalled();
});

it("opens a link tapped in an app's own tab in this phone's browser, with no conversation", async () => {
  const { host, openWindow } = app("tab");
  const open = vi.spyOn(host as unknown as TabsClient, "openTab");
  openWindow("https://www.reddit.com/r/opensteer");
  expect(open).toHaveBeenCalledExactlyOnceWith({
    kind: "page",
    profileId: "bpr_00000000-0000-4000-8000-000000000003",
    url: "https://www.reddit.com/r/opensteer",
  });
  await tabOpened();
  expect(navigation.routes[0]!.params).not.toHaveProperty("threadId");
  expect(linking.openURL).not.toHaveBeenCalled();
});

it("sends a navigation of the app's frame to the system, which proves no tap, even in a conversation", () => {
  const { host, follow } = app("conversation");
  const open = vi.spyOn(host as unknown as TabsClient, "openTab");
  // Android reports no kind of navigation; iOS reports a script's synthetic click as a click.
  follow("https://www.reddit.com/r/opensteer");
  expect(open).not.toHaveBeenCalled();
  expect(linking.openURL).toHaveBeenCalledExactlyOnceWith("https://www.reddit.com/r/opensteer");
});

it("leaves the app's own pages in place, never opens another scheme, and uses the system without a place", () => {
  const { host, openWindow } = app("nothing");
  const open = vi.spyOn(host as unknown as TabsClient, "openTab");
  openWindow("javascript:alert(1)");
  openWindow("tel:+15555550100");
  expect(linking.openURL).not.toHaveBeenCalled();
  openWindow("https://www.linkedin.com/in/someone");
  expect(linking.openURL).toHaveBeenCalledExactlyOnceWith("https://www.linkedin.com/in/someone");
  expect(open).not.toHaveBeenCalled();
  const view = webViews.at(-1)!;
  expect(
    view.onShouldStartLoadWithRequest!({
      url: "https://host.test/v1/apps/app_1/dark/token/settings",
      isTopFrame: true,
      navigationType: "click",
    } as Parameters<NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>>[0]),
  ).toBe(true);
});

it("lets what stands over the screen give way before a link's tab opens under it", async () => {
  const closeSheet = vi.fn();
  const { host, openWindow } = app("tab", closeSheet);
  const open = vi.spyOn(host as unknown as TabsClient, "openTab");
  openWindow("https://www.linkedin.com/in/someone");
  expect(closeSheet).toHaveBeenCalledOnce();
  expect(closeSheet.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]!);
  await tabOpened();
});
