// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabsClient } from "@opensteer/client/host";
import type { TabTarget } from "@opensteer/core";
import { attachMockTabs } from "../../test-support/mock-tabs.js";
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
    isFocused: () => true,
  }),
}));
vi.mock("@expo/ui/community/menu", () => ({ MenuView: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../ui/copy-mark.js", () => ({ CopyMark: () => null }));
vi.mock("../ui/primitives.js", () => ({ monoFontFamily: "Menlo" }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));

import type { IphoneAppsController } from "../iphone-apps/controller.js";
import { IphoneAppsProvider } from "../iphone-apps/context.js";
import { Markdown } from "../markdown/markdown.js";
import * as Clipboard from "expo-clipboard";
import {
  ReferenceNavigationContext,
  type ReferenceNavigation,
} from "../markdown/reference-context.js";
import { ConversationLinksProvider } from "./conversation-links.js";
import { useConversationLinks, type ConversationLinks } from "./link-context.js";

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
  const tabs = attachMockTabs(host, { layout: [], tabs: [] });
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
  // The tab the tap pushed, as the stack now holds it.
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
  return { deploymentId, host, tabs, tap, threadId };
}

describe("a conversation's links on a phone that lends a browser", () => {
  const opens = (host: MockHostClient) => vi.spyOn(host as unknown as TabsClient, "openTab");

  it("opens a web link as a new tab in this phone's own browser, in its recent profile, over the conversation", async () => {
    const { deploymentId, host, tabs, tap, threadId } = conversation({ enrolled: true });
    const open = opens(host);
    tap("the photo");
    expect(open).toHaveBeenCalledWith({
      kind: "page",
      profileId: "bpr_00000000-0000-4000-8000-000000000003",
      url: "https://unsplash.com/photos/tiger",
    });
    await vi.waitFor(() => {
      if (navigation.routes.length !== 1) throw new Error("The new tab was never shown.");
    });
    const [tab] = tabs.model.rows.values();
    expect(navigation.routes[0]).toMatchObject({
      name: "WorkspaceBrowser",
      params: { deploymentId, tabId: tab!.tabId, threadId },
    });
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  it("opens the computer's own address on the conversation's computer", () => {
    const { host, tap } = conversation({ enrolled: true });
    const open = opens(host);
    tap("the preview");
    const target = open.mock.calls[0]![0] as TabTarget;
    const home =
      target.kind !== "page"
        ? null
        : "profileId" in target
          ? host.getSnapshot().browserProfiles.find(({ id }) => id === target.profileId)
              ?.homeRunnerId
          : target.computerId;
    expect(home).toBe("rnr_11111111-1111-4111-8111-111111111111");
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  it("takes the link the way it always went when opening here fails, with no error", async () => {
    const { tabs, tap } = conversation({ enrolled: true });
    tabs.failNext("openTab", "This phone's browser is not available.");
    tap("the photo");
    await vi.waitFor(() => {
      if (linking.openURL.mock.calls.length === 0) throw new Error("The link never left.");
    });
    expect(linking.openURL).toHaveBeenCalledWith("https://unsplash.com/photos/tiger");
    expect(navigation.routes).toEqual([]);
  });
});

it("leaves links as they were on a phone that is not one of the Deployment's devices", () => {
  const { host, tap } = conversation({ enrolled: false });
  const open = vi.spyOn(host as unknown as TabsClient, "openTab");
  tap("the photo");
  tap("the preview");
  expect(open).not.toHaveBeenCalled();
  expect(navigation.routes).toEqual([]);
  expect(linking.openURL.mock.calls).toEqual([
    ["https://unsplash.com/photos/tiger"],
    ["http://localhost:5173/tiger"],
  ]);
});

it("opens a link to something in Opensteer here, never in a browser, and holds Open and Copy", () => {
  const host = new MockHostClient({ latencyMs: 0 });
  attachMockTabs(host, { layout: [], tabs: [] });
  const snapshot = host.getSnapshot();
  const opened: string[] = [];
  const references = {
    open: async (href: string) => void opened.push(href),
  } as unknown as ReferenceNavigation;
  let links: ConversationLinks | null = null;
  const Probe = () => {
    links = useConversationLinks();
    return null;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <IphoneAppsProvider controller={phone(snapshot.deploymentId!, true)}>
        <ReferenceNavigationContext value={references}>
          <ConversationLinksProvider
            deploymentId={snapshot.deploymentId!}
            hostClient={host}
            threadId={snapshot.threads[0]!.id}
          >
            <Probe />
          </ConversationLinksProvider>
        </ReferenceNavigationContext>
      </IphoneAppsProvider>,
    ),
  );
  const open = vi.spyOn(host as unknown as TabsClient, "openTab");
  const task = { href: `opensteer:${snapshot.threads[1]!.id}`, label: "the review" };
  const file = { href: "/Users/me/Opensteer/notes.md:42", label: "notes" };
  for (const link of [task, file]) {
    expect(links!.menu(link).map(({ title }) => title)).toEqual(["Open", "Copy"]);
    links!.open(link.href);
  }
  expect(opened).toEqual([task.href, file.href]);
  links!.act(task, "copy");
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(`[the review](${task.href})`);
  expect(open).not.toHaveBeenCalled();
  expect(navigation.routes).toEqual([]);
  expect(linking.openURL).not.toHaveBeenCalled();
});
