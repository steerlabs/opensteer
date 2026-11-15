// @vitest-environment happy-dom

import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import type { TabLayout } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appId,
  appTab,
  attachMockTabs,
  groupId,
  pageTab,
  phoneTab,
  tabId,
  usedBy,
  windowTab,
  type MockTabs,
} from "../../test-support/mock-tabs.js";

/*
 * The one tab list on a phone, driven the way a person drives it: rows, row
 * menus, group heads and the bar menu, over the real MockHostClient carrying
 * the frozen tabs contract.
 *
 * What can go wrong:
 * - a kind is sorted into its own section, left out, or drawn outside its group;
 * - a row opens something other than exactly its tabId, or opens while a move
 *   is being placed;
 * - a move, group, ungroup or close sends a different layout change than the
 *   Host's organize rules expect, or a failure is swallowed;
 * - an unavailable tab hides why;
 * - the page's tab sheet replaces the page with anything but the chosen tab.
 */

const harness = vi.hoisted(() => ({
  client: null as HostClient | null,
  dispatch: [] as { type: string; payload?: unknown; source?: string }[],
  goBack: 0,
  options: {} as { headerRight?: () => ReactNode },
  state: { index: 0, routes: [{ key: "page", name: "WorkspaceBrowser" }] } as {
    index: number;
    routes: { key: string; name: string }[];
  },
}));
vi.mock(
  "react-native",
  async () => (await import("../../test-support/tab-screen-mocks.js")).reactNative,
);
vi.mock("../theme.js", async () => (await import("../../test-support/tab-screen-mocks.js")).theme);
vi.mock(
  "../ui/primitives.js",
  async () => (await import("../../test-support/tab-screen-mocks.js")).primitives,
);
vi.mock(
  "../thread/composer-menu.js",
  async () => (await import("../../test-support/tab-screen-mocks.js")).composerMenu,
);
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../browser/acting-dot.js", () => ({
  ActingDot: () => null,
  agentWorkingLabel: "Agent working",
}));
vi.mock("../browser/agent-marks.js", () => ({
  AgentMarks: (props: { readonly agents: readonly { readonly title: string }[] }) => (
    <i data-agents={props.agents.map(({ title }) => title).join(",")} />
  ),
}));
vi.mock("../threads/task-row.js", () => ({ NeedsYouTag: () => <i>needs you</i> }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { readonly children?: ReactNode }) => <main>{children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/pane.js", () => ({ useContentInsets: () => ({ bottom: 0 }) }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileState: () => ({ selection: { deploymentId, hostClient: harness.client } }),
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => harness.client,
}));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { setParams: (params: object) => ({ payload: { params }, type: "SET_PARAMS" }) },
  StackActions: {
    push: (name: string, params?: object) => ({ payload: { name, params }, type: "PUSH" }),
  },
  useIsFocused: () => true,
  useNavigation: () => ({
    dispatch: (action: { type: string; payload?: unknown }) => harness.dispatch.push(action),
    getState: () => harness.state,
    goBack: () => (harness.goBack += 1),
    setOptions: (options: typeof harness.options) => Object.assign(harness.options, options),
  }),
}));

const { TabsScreen } = await import("./tabs.js");
const { BrowserTabsScreen } = await import("./browser-tabs.js");

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  harness.dispatch = [];
  harness.goBack = 0;
  harness.options = {};
  document.body.replaceChildren();
});

const work = groupId(1);
const tabs = (agentThread: string) => [
  pageTab("news", "Morning news"),
  windowTab("notes", "Shopping list"),
  phoneTab("pixel"),
  appTab("budget", appId(1), {
    state: "unavailable",
    title: "Budget",
    unavailableCode: "app-stopped",
    unavailableReason: "This app's server is stopped.",
  }),
  pageTab("docs", "Docs", { usedBy: usedBy(agentThread) }),
];
const layout = (): TabLayout["items"] => [
  { kind: "tab", tabId: tabId("news") },
  {
    group: {
      collapsed: false,
      color: "blue",
      groupId: work,
      name: "Errands",
      tabIds: [tabId("notes"), tabId("pixel")],
    },
    kind: "group",
  },
  { kind: "tab", tabId: tabId("budget") },
  { kind: "tab", tabId: tabId("docs") },
];

async function mount(screen: "tabs" | "sheet" = "tabs") {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  await host.load();
  // A task this reader can open is using Docs.
  const thread = host.getSnapshot().threads[0]!.id;
  const mock = attachMockTabs(host, { layout: layout(), tabs: tabs(thread) });
  harness.client = host;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      screen === "tabs" ? (
        <TabsScreen route={{ params: { deploymentId } } as never} />
      ) : (
        <BrowserTabsScreen route={{ params: { deploymentId, tabId: tabId("news") } } as never} />
      ),
    ),
  );
  return { container, host, mock };
}

/** The rows in the order drawn, by title. */
function rowTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button[data-testid^="tab:"]')].map(
    (button) => button.getAttribute("aria-label")!.split(", ")[0]!,
  );
}
function row(container: HTMLElement, title: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>('button[data-testid^="tab:"]'),
  ].find((button) => button.getAttribute("aria-label")?.startsWith(`${title}, `));
  if (!found) throw new Error(`No row for ${title}: ${rowTitles(container).join(" | ")}`);
  return found;
}
function menuChoice(container: HTMLElement, menu: string, label: string): HTMLButtonElement {
  const found = [
    ...(container.querySelector(`[aria-label="${menu}"]`)?.querySelectorAll("button") ?? []),
  ].find((button) => button.textContent === label);
  if (!found) throw new Error(`No ${label} in ${menu}`);
  return found;
}
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}
async function press(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error(`Never happened: ${what}`);
    },
    { timeout: 2_000 },
  );
}
function pushes(): unknown[] {
  return harness.dispatch.filter(({ type }) => type === "PUSH").map(({ payload }) => payload);
}
function organizeCalls(mock: MockTabs): unknown[] {
  return mock.calls.filter(({ method }) => method === "organizeTabs").map(({ args }) => args[0]);
}

describe("one mixed list", () => {
  it("keeps every kind in the Host's one order, inside its group, and says why a tab can't open", async () => {
    const { container } = await mount();
    expect(rowTitles(container)).toEqual([
      "Morning news",
      "Shopping list",
      "Pixel",
      "Budget",
      "Docs",
    ]);
    expect(button(container, "Errands, group of 2 tabs")).toBeDefined();
    expect(row(container, "Budget").getAttribute("aria-label")).toContain(
      "This app's server is stopped.",
    );
    expect(row(container, "Docs").querySelector("[data-agents]")).not.toBeNull();
  });

  it("opens exactly the tab chosen, by its tabId, whatever its kind", async () => {
    const { container } = await mount();
    await press(row(container, "Pixel"));
    await press(row(container, "Shopping list"));
    expect(pushes()).toEqual([
      { name: "WorkspaceBrowser", params: { deploymentId, tabId: tabId("pixel") } },
      { name: "WorkspaceBrowser", params: { deploymentId, tabId: tabId("notes") } },
    ]);
  });

  it("folds a collapsed group to its head, through the Host's shared layout", async () => {
    const { container, mock } = await mount();
    await press(button(container, "Errands, group of 2 tabs"));
    await waitFor(() => !rowTitles(container).includes("Pixel"), "the group folded");
    expect(mock.calls.at(-1)).toEqual({
      args: [{ collapsed: true, groupId: work }],
      method: "updateTabGroup",
    });
    expect(rowTitles(container)).toEqual(["Morning news", "Budget", "Docs"]);
  });

  it("narrows to the tabs agents use from the bar menu", async () => {
    const { container } = await mount();
    const bar = document.createElement("div");
    document.body.append(bar);
    const barRoot = createRoot(bar);
    roots.push(barRoot);
    await act(async () => barRoot.render(<>{harness.options.headerRight?.()}</>));
    await press(menuChoice(bar, "More", "Tabs with agents"));
    await waitFor(() => rowTitles(container).length === 1, "the list narrowed");
    expect(rowTitles(container)).toEqual(["Docs"]);
  });
});

describe("moving and grouping without dragging", () => {
  it("moves a tab before another, into that tab's group, and opens nothing while placing it", async () => {
    const { container, mock } = await mount();
    await press(menuChoice(container, "Morning news actions", "Move…"));
    await press(row(container, "Pixel"));
    expect(pushes()).toEqual([]);
    expect(organizeCalls(mock)).toEqual([
      { beforeTabId: tabId("pixel"), group: { groupId: work }, tabIds: [tabId("news")] },
    ]);
    await waitFor(() => rowTitles(container)[0] === "Shopping list", "the move applied");
    expect(rowTitles(container)).toEqual([
      "Shopping list",
      "Morning news",
      "Pixel",
      "Budget",
      "Docs",
    ]);
  });

  it("moves a whole group before an outside tab as one block", async () => {
    const { container, mock } = await mount();
    await press(menuChoice(container, "Errands actions", "Move group…"));
    await press(row(container, "Morning news"));
    expect(organizeCalls(mock)).toEqual([
      {
        beforeTabId: tabId("news"),
        group: { groupId: work },
        tabIds: [tabId("notes"), tabId("pixel")],
      },
    ]);
  });

  it("puts any kind in a new named group, takes it out again, and closes it without stopping anything", async () => {
    const { container, mock } = await mount();
    await press(menuChoice(container, "Budget actions", "New group"));
    const name = container.querySelector<HTMLInputElement>('input[aria-label="New group name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        name,
        "Money",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(button(container, "Save"));
    expect(organizeCalls(mock).at(-1)).toEqual({
      group: { color: "grey", name: "Money" },
      tabIds: [tabId("budget")],
    });
    await press(menuChoice(container, "Pixel actions", "Remove from group"));
    expect(organizeCalls(mock).at(-1)).toEqual({ group: null, tabIds: [tabId("pixel")] });
    await press(menuChoice(container, "Shopping list actions", "Close tab"));
    expect(mock.calls.at(-1)).toEqual({ args: [[tabId("notes")]], method: "closeTabs" });
    await waitFor(() => !rowTitles(container).includes("Shopping list"), "the closed tab left");
  });

  it("says when a change fails, and leaves the list as the Host has it", async () => {
    const { container, mock } = await mount();
    mock.failNext("organizeTabs", "That group was removed on another device.");
    await press(menuChoice(container, "Morning news actions", "Move…"));
    await press(row(container, "Docs"));
    await waitFor(
      () => container.textContent?.includes("That group was removed on another device.") === true,
      "the failure was shown",
    );
    expect(rowTitles(container)).toEqual([
      "Morning news",
      "Shopping list",
      "Pixel",
      "Budget",
      "Docs",
    ]);
  });

  it("reopens the last closed tab from the bar menu", async () => {
    const { container, host, mock } = await mount();
    await press(menuChoice(container, "Docs actions", "Close tab"));
    await waitFor(() => !rowTitles(container).includes("Docs"), "the tab closed");
    const bar = document.createElement("div");
    document.body.append(bar);
    const barRoot = createRoot(bar);
    roots.push(barRoot);
    await act(async () => barRoot.render(<>{harness.options.headerRight?.()}</>));
    await press(menuChoice(bar, "More", "Reopen closed tab"));
    await waitFor(() => rowTitles(container).includes("Docs"), "the tab came back");
    expect(mock.calls.at(-1)?.method).toBe("reopenTab");
    expect(host).toBeDefined();
  });
});

describe("the tab sheet over a tab", () => {
  it("marks the tab in front and puts any chosen kind in its place", async () => {
    harness.state = {
      index: 1,
      routes: [
        { key: "page", name: "WorkspaceBrowser" },
        { key: "sheet", name: "BrowserTabs" },
      ],
    };
    const { container } = await mount("sheet");
    expect(row(container, "Morning news").getAttribute("aria-selected")).toBe("true");
    await press(row(container, "Pixel"));
    expect(harness.dispatch).toEqual([
      {
        payload: { params: { editAddress: false, popup: false, tabId: tabId("pixel") } },
        source: "page",
        type: "SET_PARAMS",
      },
    ]);
    expect(harness.goBack).toBe(1);
  });
});
