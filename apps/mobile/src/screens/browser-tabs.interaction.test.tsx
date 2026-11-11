import { seedBrowserSession } from "@opensteer/client/test-support";
// @vitest-environment happy-dom
import { seedBrowserSnapshot } from "@opensteer/client/test-support";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { HostSnapshot } from "@opensteer/client/host";
import { BrowserTabsScreen } from "./browser-tabs.js";

const state = vi.hoisted(() => ({ dispatch: vi.fn(), goBack: vi.fn() }));
const occupant = (acting: boolean) => ({
  acting,
  holding: true,
  home: false,
  lastActiveAt: "2026-11-01T10:00:00.000Z",
  threadId: "thread-trip",
});
const rawSnapshot = {
  appTabs: [],
  browserPlacements: [],
  browserProfiles: [],
  machines: [],
  activeTasks: [],
  homeThreadId: "home",
  tasks: null,
  threads: [{ id: "thread-trip", title: "Tokyo trip", icon: null, color: null }],
  transcripts: {
    "thread-trip": [
      {
        id: "visited",
        kind: "place",
        place: { kind: "browser", sessionId: "browser", surfaceId: "first" },
      },
    ],
  },
  workspaceTasks: {},
  browserSessions: [
    seedBrowserSession(
      { id: "browser", placement: { kind: "runner", runnerId: "computer" }, profileId: null },
      {
        rows: [
          { id: "last", order: 2, title: "Last", site: "https://last.example", occupants: [] },
          {
            id: "current",
            order: 1,
            title: "Current",
            site: "https://current.example",
            occupants: [occupant(true)],
          },
          { id: "first", order: 0, title: "First", site: "https://first.example", occupants: [] },
        ],
      },
      [],
    ),
  ],
} as unknown as HostSnapshot;
const snapshot = seedBrowserSnapshot(rawSnapshot);
const currentPlace = {
  key: "browser:browser:current",
  browser: { sessionId: "browser" },
  destination: { kind: "browser", sessionId: "browser", tabId: "current" },
  occupants: [occupant(true)],
};
// The browser's tabs by key, as the snapshot's catalog lists them.
const catalog = () =>
  [
    ...(snapshot.browserSessions[0]!.browserTabs?.sessionTabs(snapshot.browserSessions[0]!.id) ??
      []),
  ].sort((a, b) => a.order - b.order);
vi.mock("@opensteer/client/react", () => ({
  useHostSelector: (_: unknown, select: (value: HostSnapshot) => unknown) => select(snapshot),
  useBrowserSessionGroupId: () => "browser",
  useBrowserTabs: () => ({ ids: catalog().map(({ id }) => id), syncing: false, whole: true }),
  useBrowserTab: (_: unknown, _group: string, id: string) => {
    const tab = catalog().find((candidate) => candidate.id === id);
    return tab ? { ...tab, iconRef: null } : undefined;
  },
  useBrowserTabIcon: () => null,
  usePlace: (_: unknown, key: string | null) => (key === currentPlace.key ? currentPlace : null),
  useSyncingPlaceholder: () => false,
}));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { setParams: (params: object) => ({ type: "SET_PARAMS", payload: { params } }) },
  StackActions: {
    push: (name: string, params: object) => ({ type: "PUSH", payload: { name, params } }),
  },
  useNavigation: () => ({
    dispatch: state.dispatch,
    goBack: state.goBack,
    getState: () => ({
      index: 2,
      routes: [{ key: "home" }, { key: "page-under-sheet" }, { key: "sheet" }],
    }),
  }),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileState: () => ({ selection: { deploymentId: "deployment", hostClient: {} } }),
}));
vi.mock("../ui/pane.js", () => ({ useContentInsets: () => ({ bottom: 0 }) }));
vi.mock("../computers/here-device.js", () => ({ useHereDeviceId: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../browser/agent-marks.js", () => ({ AgentMarks: () => null }));
vi.mock("../ui/task-mark.js", () => ({ TaskMark: () => null }));
vi.mock("../ui/chat-orb.js", () => ({ ChatOrb: () => null }));
vi.mock("../ui/motion.js", () => ({ enter: {}, exit: {} }));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { create: (value: object) => value, hairlineWidth: 1 },
  Image: () => null,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
    onPress: () => void;
  }) => (
    <button
      aria-expanded={props.accessibilityState?.expanded}
      aria-label={props.accessibilityLabel}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
  FlatList: <T,>(props: {
    data: T[];
    keyExtractor: (item: T) => string;
    renderItem: (value: { item: T; index: number }) => ReactNode;
  }) => (
    <div>
      {props.data.map((item, index) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLElement;
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});
function open(params: { tabId?: string; threadId?: string } = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <BrowserTabsScreen
        route={{
          params: { deploymentId: "deployment", sessionId: "browser", tabId: "current", ...params },
        }}
      />,
    ),
  );
}
function labels() {
  return [...container.querySelectorAll("button")].map((button) =>
    button.getAttribute("aria-label"),
  );
}
function press(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing ${label}`);
  act(() => button.click());
}
it("lists every tab in the browser's catalog order and says which is shown and who is in it", () => {
  open();
  expect(labels()).toEqual([
    "All tabs",
    "First, first.example",
    "Current, current.example, Shown, Tokyo trip, working here",
    "Last, last.example",
  ]);
  expect(container.textContent).not.toContain("All tabs in this browser");
});
it("lists only a task's tabs and folds the browser's others under one row", () => {
  open({ threadId: "thread-trip" });
  expect(container.textContent).toContain("Tokyo trip");
  expect(container.textContent).toContain("2 tabs");
  // Visited earlier by the transcript, and occupied now by its agent.
  expect(labels()).toEqual([
    "All tabs",
    "First, first.example",
    "Current, current.example, Shown, Agent is here",
    "All tabs in this browser, 1",
  ]);
  expect(container.textContent).not.toContain("Other tabs");
  press("All tabs in this browser, 1");
  expect(container.textContent).toContain("Other tabs");
  expect(labels().at(-1)).toBe("Last, last.example");
  press("All tabs in this browser, 1");
  expect(labels()).not.toContain("Last, last.example");
});
it("labels the agent's tab in words, not only by its mark", () => {
  open({ threadId: "thread-trip" });
  const agentTab = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Current, current.example, Shown, Agent is here"]',
  );
  expect(agentTab?.textContent).toContain("Agent");
  const other = container.querySelector<HTMLButtonElement>(
    'button[aria-label="First, first.example"]',
  );
  expect(other?.textContent).not.toContain("Agent");
});
it("opens unfolded when the shown tab is not the task's", () => {
  open({ tabId: "last", threadId: "thread-trip" });
  expect(container.textContent).toContain("Other tabs");
  expect(labels()).toContain("Last, last.example, Shown");
});
it("sets the tab on the page route by key and dismisses the sheet", () => {
  open();
  press("First, first.example");
  expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "SET_PARAMS",
    source: "page-under-sheet",
    payload: { params: { editAddress: false, popup: false, tabId: "first" } },
  });
  expect(state.goBack).toHaveBeenCalledOnce();
});
it("only dismisses when choosing the current tab", () => {
  open();
  press("Current, current.example, Shown, Tokyo trip, working here");
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(state.goBack).toHaveBeenCalledOnce();
});
it("dismisses before pushing All tabs", () => {
  open();
  press("All tabs");
  expect(state.goBack).toHaveBeenCalledOnce();
  expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "PUSH",
    payload: { name: "Tabs", params: { deploymentId: "deployment" } },
  });
  expect(state.goBack.mock.invocationCallOrder[0]).toBeLessThan(
    state.dispatch.mock.invocationCallOrder[0]!,
  );
});
