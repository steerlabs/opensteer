// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { HostSnapshot } from "@opensteer/client/host";
import { BrowserTabsScreen } from "./browser-tabs.js";

const state = vi.hoisted(() => ({ dispatch: vi.fn(), goBack: vi.fn() }));
const snapshot = {
  browserSessions: [
    {
      id: "browser",
      tabs: [],
      tabCatalog: {
        tabs: [
          { id: "last", order: 2, title: "Last", site: "https://last.example" },
          { id: "current", order: 1, title: "Current", site: "https://current.example" },
          { id: "first", order: 0, title: "First", site: "https://first.example" },
        ],
      },
    },
  ],
} as unknown as HostSnapshot;
vi.mock("@opensteer/client/react", () => ({
  useHostSelector: (_: unknown, select: (value: HostSnapshot) => unknown) => select(snapshot),
  usePlaceList: () => [],
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
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../browser/agent-marks.js", () => ({ AgentMarks: () => null }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { create: (value: object) => value, hairlineWidth: 1 },
  Image: () => null,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityState?: { selected: boolean };
    onPress: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-selected={props.accessibilityState?.selected}
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
function open() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <BrowserTabsScreen
        route={{
          params: { deploymentId: "deployment", sessionId: "browser", tabId: "current" },
        }}
      />,
    ),
  );
}
function press(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing ${label}`);
  act(() => button.click());
}
it("lists the browser's catalog order and marks the current tab", () => {
  open();
  expect(
    [...container.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
  ).toEqual(["All tabs", "First, first.example", "Current, current.example", "Last, last.example"]);
  expect(container.querySelector('[aria-selected="true"]')?.getAttribute("aria-label")).toBe(
    "Current, current.example",
  );
});
it("sets the tab on the page route by key and dismisses the sheet", () => {
  open();
  press("First, first.example");
  expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "SET_PARAMS",
    source: "page-under-sheet",
    payload: { params: { editAddress: false, tabId: "first" } },
  });
  expect(state.goBack).toHaveBeenCalledOnce();
});
it("only dismisses when choosing the current tab", () => {
  open();
  press("Current, current.example");
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
