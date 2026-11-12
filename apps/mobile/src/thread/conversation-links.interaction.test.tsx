// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabOpenHandle } from "@opensteer/client/host";
import { MockHostClient, mockIphoneRunnerId } from "@opensteer/client/mock";

const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => undefined) }));
const navigation = vi.hoisted(() => ({
  dispatch: vi.fn(),
  routes: [] as { key: string; name: string; params: Record<string, unknown> }[],
}));

// The real Markdown and link handling over DOM hosts: a tap is a click on the link's words.
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: linking,
  Platform: { OS: "ios", Version: "27.0", isPad: false, select: () => undefined },
  Pressable: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: (props: { accessibilityRole?: string; children?: ReactNode; onPress?: () => void }) => (
    <span data-role={props.accessibilityRole} onClick={props.onPress}>
      {props.children}
    </span>
  ),
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
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
vi.mock("../ui/copy-mark.js", () => ({ CopyMark: () => null }));
vi.mock("../ui/primitives.js", () => ({ monoFontFamily: "Menlo" }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));

import type { IphoneAppsController } from "../iphone-apps/controller.js";
import { IphoneAppsProvider } from "../iphone-apps/context.js";
import { Markdown } from "../markdown/markdown.js";
import { ConversationLinksProvider } from "./conversation-links.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  linking.openURL.mockClear();
  navigation.dispatch.mockReset();
  navigation.routes = [];
});

/** This phone, enrolled in the Deployment as the mock world's iPhone, or nowhere. */
function phone(deploymentId: string, enrolled: boolean): IphoneAppsController {
  const state = {
    snapshot: {
      enrollment: enrolled
        ? { deploymentId, runnerId: mockIphoneRunnerId, state: "enrolled" }
        : null,
    },
  };
  return {
    getState: () => state,
    subscribe: () => () => undefined,
  } as unknown as IphoneAppsController;
}

function conversation(input: { readonly enrolled: boolean }) {
  const host = new MockHostClient({ latencyMs: 0 });
  const snapshot = host.getSnapshot();
  const deploymentId = snapshot.deploymentId!;
  const threadId = snapshot.threads[0]!.id;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <IphoneAppsProvider controller={phone(deploymentId, input.enrolled)}>
        <ConversationLinksProvider
          deploymentId={deploymentId}
          hostClient={host}
          threadId={threadId}
        >
          <Markdown
            look="bubble"
            text="Saved it. See [the photo](https://unsplash.com/photos/tiger) or [the preview](http://localhost:5173/tiger)."
          />
        </ConversationLinksProvider>
      </IphoneAppsProvider>,
    ),
  );
  const tap = (words: string) => {
    const link = [...container.querySelectorAll<HTMLElement>('[data-role="link"]')].find(
      (node) => node.textContent === words,
    );
    if (!link) throw new Error(`No link reads "${words}".`);
    act(() => link.click());
  };
  // The pending tab the tap pushed, as the stack now holds it.
  navigation.dispatch.mockImplementation(
    (action: { type: string; name?: string; params?: Record<string, unknown> }) => {
      if (action.type === "PUSH")
        navigation.routes.push({
          key: `route-${navigation.routes.length}`,
          name: action.name!,
          params: action.params!,
        });
      if (action.type === "POP") navigation.routes.pop();
    },
  );
  return { deploymentId, host, tap, threadId };
}

describe("a conversation's links on a phone that lends a browser", () => {
  it("opens a web link in this phone's own browser, in its recent profile, at once", () => {
    const { host, tap, threadId } = conversation({ enrolled: true });
    const open = vi.spyOn(host, "beginBrowserTabOpen");
    tap("the photo");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toEqual({
      identity: { kind: "profile", profileId: "bpr_00000000-0000-4000-8000-000000000003" },
    });
    expect(open.mock.calls[0]![1]).toMatchObject({ url: "https://unsplash.com/photos/tiger" });
    expect(navigation.routes).toEqual([
      expect.objectContaining({
        name: "WorkspaceBrowser",
        params: expect.objectContaining({
          pendingBrowserTab: open.mock.results[0]!.value.idempotencyKey,
          threadId,
        }),
      }),
    ]);
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  it("opens the computer's own address on the conversation's computer", () => {
    const { host, tap } = conversation({ enrolled: true });
    const open = vi.spyOn(host, "beginBrowserTabOpen");
    tap("the preview");
    const target = open.mock.calls[0]![0];
    expect(target).not.toEqual(
      expect.objectContaining({ placement: { kind: "runner", runnerId: mockIphoneRunnerId } }),
    );
    const runner =
      "placement" in (target as object)
        ? (target as { placement: { runnerId: string } }).placement.runnerId
        : null;
    const profile = (target as { identity: { kind: string; profileId?: string } }).identity;
    const home =
      profile.kind === "profile"
        ? host.getSnapshot().browserProfiles.find(({ id }) => id === profile.profileId)
            ?.homeRunnerId
        : runner;
    expect(home).toBe("rnr_11111111-1111-4111-8111-111111111111");
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  it("takes the link the way it always went when opening here fails, with no error", async () => {
    const { host, tap } = conversation({ enrolled: true });
    let refuse!: (error: Error) => void;
    vi.spyOn(host, "beginBrowserTabOpen").mockImplementation((): BrowserTabOpenHandle => ({
      idempotencyKey: "reply-link:refused",
      result: new Promise((_, reject) => {
        refuse = reject;
      }),
    }));
    const dismiss = vi.spyOn(host, "dismissPendingBrowserTab");
    tap("the photo");
    expect(navigation.routes).toHaveLength(1);
    await act(async () => refuse(new Error("This phone's browser is not available.")));
    expect(navigation.routes).toEqual([]);
    expect(dismiss).toHaveBeenCalledWith("reply-link:refused");
    expect(linking.openURL).toHaveBeenCalledWith("https://unsplash.com/photos/tiger");
  });
});

it("leaves links as they were on a phone that is not one of the Deployment's devices", () => {
  const { host, tap } = conversation({ enrolled: false });
  const open = vi.spyOn(host, "beginBrowserTabOpen");
  tap("the photo");
  tap("the preview");
  expect(open).not.toHaveBeenCalled();
  expect(navigation.routes).toEqual([]);
  expect(linking.openURL.mock.calls).toEqual([
    ["https://unsplash.com/photos/tiger"],
    ["http://localhost:5173/tiger"],
  ]);
});
