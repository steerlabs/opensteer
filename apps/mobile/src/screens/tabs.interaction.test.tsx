// @vitest-environment happy-dom

import { MockHostClient } from "@opensteer/client/mock";
import type { TabId } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The one tab list on a phone, driven the way a person drives it: rows, row
 * menus, group heads and the bar menu, over the mock Host's seeded tabs (a
 * group mixing a page, a Mac window, the Agent Phone and an app; pages; a
 * closed window; a stopped app).
 *
 * What can go wrong:
 * - a kind is sorted into its own section, left out, or drawn outside its group;
 * - an agent is marked working because its task runs, not because the Host
 *   reports it acting in that very tab;
 * - a row opens something other than exactly its tabId, or opens while a move
 *   is being placed;
 * - a move, group, ungroup or close sends a different layout change than the
 *   Host's organize rules expect, or a failure is swallowed;
 * - an unavailable tab hides why;
 * - the page's tab sheet replaces the page with anything but the chosen tab.
 */

const harness = vi.hoisted(() => ({
  client: null as import("@opensteer/client/host").HostClient | null,
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
  AgentMarks: (props: {
    readonly agents: readonly { readonly title: string; readonly acting: boolean }[];
  }) => (
    <i
      data-acting={props.agents.map(({ acting }) => String(acting)).join(",")}
      data-agents={props.agents.map(({ title }) => title).join(",")}
    />
  ),
}));
vi.mock("../computers/app-mark.js", () => ({
  MacAppIcon: (props: { readonly app: { readonly bundleId: string } }) => (
    <i data-app-icon={props.app.bundleId} />
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
const hosts: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.dispose();
  harness.dispatch = [];
  harness.goBack = 0;
  harness.options = {};
  harness.state = { index: 0, routes: [{ key: "page", name: "WorkspaceBrowser" }] };
  document.body.replaceChildren();
});

/** The seeded tabs in the Host's one order: the Launch prep group first, then the rest. */
const launchPrep = ["Your reading list", "Launch plan", "Pixel 7", "Ferry tracker"];
const outside = [
  "Le Petit Jardin",
  "Confirm your reservation",
  "Friday dinner",
  "storage documentation",
  "Launch brief",
  "Coffee shortlist",
  "Flight award alerts",
  "Q4 roadmap – Linear",
  "Running shoes – Allbirds",
  "Old draft",
  "Inventory sync",
];

async function mount(screen: "tabs" | "sheet" = "tabs") {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  hosts.push(host);
  await host.load();
  // The world holds still: an agent acts in a tab only when this test says so.
  const places = host.scriptPlaces();
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
        <BrowserTabsScreen
          route={{ params: { deploymentId, tabId: idOf(host, "Your reading list") } } as never}
        />
      ),
    ),
  );
  return { container, host, places };
}

function idOf(host: MockHostClient, title: string): TabId {
  const tab = [...host.getSnapshot().tabs.rows.values()].find((row) => row.title === title);
  if (!tab) throw new Error(`No seeded tab ${title}`);
  return tab.tabId;
}
function groupOf(host: MockHostClient, name: string) {
  const item = host
    .getSnapshot()
    .tabs.layout.items.find((entry) => entry.kind === "group" && entry.group.name === name);
  if (item?.kind !== "group") throw new Error(`No group ${name}`);
  return item.group;
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
async function barMenu(): Promise<HTMLElement> {
  const bar = document.createElement("div");
  document.body.append(bar);
  const barRoot = createRoot(bar);
  roots.push(barRoot);
  await act(async () => barRoot.render(<>{harness.options.headerRight?.()}</>));
  return bar;
}

describe("one mixed list", () => {
  it("keeps every kind in the Host's one order, inside its group, and says why a tab can't open", async () => {
    const { container } = await mount();
    expect(rowTitles(container)).toEqual([...launchPrep, ...outside]);
    expect(button(container, "Launch prep, group of 4 tabs")).toBeDefined();
    expect(row(container, "Inventory sync").getAttribute("aria-label")).toContain("App stopped");
    expect(row(container, "Old draft").getAttribute("aria-label")).toContain("Window closed");
    expect(row(container, "Launch plan").querySelector("[data-app-icon]")).toMatchObject({
      dataset: { appIcon: "com.apple.Notes" },
    });
  });

  it("marks an agent working only while the Host reports it acting in that very tab", async () => {
    const { container, host, places } = await mount();
    // Build the new architecture is running and uses both pages; it acts in neither yet.
    const marks = (title: string) => row(container, title).querySelector("i[data-agents]");
    expect(marks("Le Petit Jardin")).toMatchObject({
      dataset: { acting: "false", agents: "Build the new architecture" },
    });
    expect(marks("Confirm your reservation")).toMatchObject({ dataset: { acting: "false" } });
    const run = host
      .getSnapshot()
      .runQueue.find(
        ({ status, threadId }) =>
          status === "running" && threadId === "thr_00000000-0000-4000-8000-000000000001",
      )!;
    const now = Date.now();
    await act(async () =>
      places.apply({
        activity: {
          at: now,
          expiresAt: now + 15_000,
          generation: 1,
          geometryRevision: 1,
          order: 1,
          pointer: null,
          runId: run.id,
          seq: 1,
          tabId: idOf(host, "Confirm your reservation"),
          threadId: run.threadId,
        },
        type: "host.place-activity",
      }),
    );
    expect(marks("Confirm your reservation")).toMatchObject({ dataset: { acting: "true" } });
    expect(marks("Le Petit Jardin")).toMatchObject({ dataset: { acting: "false" } });
  });

  it("opens exactly the tab chosen, by its tabId, whatever its kind", async () => {
    const { container, host } = await mount();
    await press(row(container, "Pixel 7"));
    await press(row(container, "Launch plan"));
    await press(row(container, "Ferry tracker"));
    expect(pushes()).toEqual(
      ["Pixel 7", "Launch plan", "Ferry tracker"].map((title) => ({
        name: "WorkspaceBrowser",
        params: { deploymentId, tabId: idOf(host, title) },
      })),
    );
  });

  it("folds a collapsed group to its head, through the Host's shared layout", async () => {
    const { container, host } = await mount();
    const update = vi.spyOn(host, "updateTabGroup");
    await press(button(container, "Launch prep, group of 4 tabs"));
    await waitFor(() => !rowTitles(container).includes("Pixel 7"), "the group folded");
    expect(update.mock.calls).toEqual([
      [{ collapsed: true, groupId: groupOf(host, "Launch prep").groupId }],
    ]);
    expect(rowTitles(container)).toEqual(outside);
  });

  it("narrows to the tabs agents use, or to one computer, from the bar menu", async () => {
    const { container } = await mount();
    await press(menuChoice(await barMenu(), "More", "Tabs with agents"));
    await waitFor(() => !rowTitles(container).includes("Ferry tracker"), "the list narrowed");
    expect(rowTitles(container)).toEqual([
      "Launch plan",
      "Pixel 7",
      "Le Petit Jardin",
      "Confirm your reservation",
      "Friday dinner",
      "storage documentation",
      "Launch brief",
      "Flight award alerts",
    ]);
    await press(menuChoice(await barMenu(), "More: Tabs with agents", "All tabs"));
    await press(menuChoice(await barMenu(), "More", "Alex's iPhone"));
    await waitFor(() => rowTitles(container).length === 1, "the list narrowed to one computer");
    expect(rowTitles(container)).toEqual(["Running shoes – Allbirds"]);
  });
});

describe("moving and grouping without dragging", () => {
  it("moves a tab before another, into that tab's group, and opens nothing while placing it", async () => {
    const { container, host } = await mount();
    const organize = vi.spyOn(host, "organizeTabs");
    await press(menuChoice(container, "Le Petit Jardin actions", "Move…"));
    await press(row(container, "Pixel 7"));
    expect(pushes()).toEqual([]);
    expect(organize.mock.calls).toEqual([
      [
        {
          beforeTabId: idOf(host, "Pixel 7"),
          group: { groupId: groupOf(host, "Launch prep").groupId },
          tabIds: [idOf(host, "Le Petit Jardin")],
        },
      ],
    ]);
    await waitFor(() => rowTitles(container)[2] === "Le Petit Jardin", "the move applied");
    expect(rowTitles(container).slice(0, 6)).toEqual([
      "Your reading list",
      "Launch plan",
      "Le Petit Jardin",
      "Pixel 7",
      "Ferry tracker",
      "Confirm your reservation",
    ]);
  });

  it("moves a whole group before an outside tab as one block", async () => {
    const { container, host } = await mount();
    const organize = vi.spyOn(host, "organizeTabs");
    await press(menuChoice(container, "Launch prep actions", "Move group…"));
    await press(row(container, "Coffee shortlist"));
    expect(organize.mock.calls).toEqual([
      [
        {
          beforeTabId: idOf(host, "Coffee shortlist"),
          group: { groupId: groupOf(host, "Launch prep").groupId },
          tabIds: launchPrep.map((title) => idOf(host, title)),
        },
      ],
    ]);
    await waitFor(() => rowTitles(container)[0] === "Le Petit Jardin", "the group moved");
    expect(rowTitles(container)).toEqual([
      ...outside.slice(0, 5),
      ...launchPrep,
      ...outside.slice(5),
    ]);
  });

  it("puts any kind in a new named group, takes it out again, and closes it", async () => {
    const { container, host } = await mount();
    const organize = vi.spyOn(host, "organizeTabs");
    const close = vi.spyOn(host, "closeTabs");
    await press(menuChoice(container, "Inventory sync actions", "New group"));
    const name = container.querySelector<HTMLInputElement>('input[aria-label="New group name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        name,
        "Money",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(button(container, "Save"));
    // The first tint no group has yet: Launch prep is cyan.
    expect(organize.mock.calls.at(-1)).toEqual([
      { group: { color: "grey", name: "Money" }, tabIds: [idOf(host, "Inventory sync")] },
    ]);
    await waitFor(
      () => container.querySelector('[aria-label="Money, group of 1 tab"]') !== null,
      "the new group was drawn",
    );
    await press(menuChoice(container, "Pixel 7 actions", "Remove from group"));
    expect(organize.mock.calls.at(-1)).toEqual([{ group: null, tabIds: [idOf(host, "Pixel 7")] }]);
    const notes = idOf(host, "Launch plan");
    await press(menuChoice(container, "Launch plan actions", "Close tab"));
    expect(close.mock.calls).toEqual([[[notes]]]);
    await waitFor(() => !rowTitles(container).includes("Launch plan"), "the closed tab left");
  });

  it("says when a change fails, and leaves the list as the Host has it", async () => {
    const { container, host } = await mount();
    vi.spyOn(host, "organizeTabs").mockRejectedValueOnce(
      new Error("That group was removed on another device."),
    );
    await press(menuChoice(container, "Le Petit Jardin actions", "Move…"));
    await press(row(container, "Launch brief"));
    await waitFor(
      () => container.textContent?.includes("Couldn't confirm this change.") === true,
      "the failure was shown",
    );
    expect(rowTitles(container)).toEqual([...launchPrep, ...outside]);
  });

  it("reopens the last closed tab from the bar menu", async () => {
    const { container, host } = await mount();
    const reopen = vi.spyOn(host, "reopenTab");
    await press(menuChoice(container, "Coffee shortlist actions", "Close tab"));
    await waitFor(() => !rowTitles(container).includes("Coffee shortlist"), "the tab closed");
    await press(menuChoice(await barMenu(), "More", "Reopen closed tab"));
    await waitFor(() => rowTitles(container).includes("Coffee shortlist"), "the tab came back");
    expect(reopen.mock.calls).toEqual([[]]);
    expect(rowTitles(container)).toEqual([...launchPrep, ...outside]);
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
    const { container, host } = await mount("sheet");
    expect(row(container, "Your reading list").getAttribute("aria-selected")).toBe("true");
    await press(row(container, "Pixel 7"));
    expect(harness.dispatch).toEqual([
      {
        payload: { params: { editAddress: false, popup: false, tabId: idOf(host, "Pixel 7") } },
        source: "page",
        type: "SET_PARAMS",
      },
    ]);
    expect(harness.goBack).toBe(1);
  });
});
