// @vitest-environment happy-dom

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { headerFontScaleLimit } from "../theme.js";
import type { ThreadHeaderState } from "./thread-pane.js";

/*
 * What is around a conversation, from its bar. What can go wrong:
 * - an empty control sits in the bar of a conversation with nothing around it;
 * - the control's counts or marks miss a place, a task or a schedule, or a
 *   place an agent works in does not say so;
 * - a tile stands for an empty section, or tiles show with only one section;
 * - the sheet opens on something other than what needs the reader, or jumps
 *   to another section as the Host's data changes while it is open, or keeps
 *   showing a section that emptied;
 * - earlier tasks lose their day, or some are hidden;
 * - a schedule's switch settles on the tap rather than the Host's answer, or
 *   can be flipped again while the Host is asked, or offline;
 * - a row opens a sibling of what it names, or a parent is opened a second
 *   time over the child instead of gone back to;
 * - a streamed token redraws the bar;
 * - an old Host, which sends no automations, breaks the control or invents some.
 */

const deploymentId = "deployment";
const harness = vi.hoisted(() => ({
  client: null as HostClient | null,
  options: {} as Record<string, unknown>,
  setOptions: vi.fn(),
  navigate: vi.fn(),
  dispatch: vi.fn(),
  fontScale: 1,
  goBack: vi.fn(),
  haptic: vi.fn(async () => undefined),
  routes: [] as { name: string; params?: object }[],
}));

vi.mock("react-native", async () => {
  const { useLayoutEffect } = await import("react");
  type Props = {
    readonly children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    readonly accessibilityLabel?: string;
    readonly accessibilityHint?: string;
    readonly accessibilityRole?: string;
    readonly accessibilityState?: { readonly selected?: boolean };
    readonly onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    readonly onPress?: () => void;
    readonly style?: unknown;
  };
  const contents = (props: Props) =>
    typeof props.children === "function" ? props.children({ pressed: false }) : props.children;
  return {
    Alert: { alert: vi.fn() },
    // Every page at once: which one shows is the selected tab's to say.
    FlatList: (props: {
      data: readonly string[];
      renderItem: (info: { index: number; item: string }) => ReactNode;
    }) => (
      <div>
        {props.data.map((item, index) => (
          <div key={item}>{props.renderItem({ index, item })}</div>
        ))}
      </div>
    ),
    Image: () => <img />,
    Platform: { OS: "ios" },
    Pressable: (props: Props) => {
      const style =
        typeof props.style === "function" ? props.style({ pressed: false }) : props.style;
      const width = [style]
        .flat(9)
        .findLast((entry): entry is { width: number } => typeof entry?.width === "number")?.width;
      return (
        <button
          aria-label={props.accessibilityLabel}
          aria-selected={props.accessibilityState?.selected}
          data-width={width}
          role={props.accessibilityRole}
          title={props.accessibilityHint}
          onClick={props.onPress}
        >
          {contents(props)}
        </button>
      );
    },
    SectionList: (props: {
      accessibilityLabel: string;
      keyExtractor: (item: never) => string;
      renderItem: (info: { index: number; item: never; section: never }) => ReactNode;
      renderSectionHeader: (info: { section: never }) => ReactNode;
      sections: readonly { data: readonly never[]; key: string }[];
    }) => (
      <section aria-label={props.accessibilityLabel}>
        {props.sections.map((section) => (
          <div key={section.key}>
            {props.renderSectionHeader({ section: section as never })}
            {section.data.map((item, index) => (
              <div key={props.keyExtractor(item)}>
                {props.renderItem({ index, item, section: section as never })}
              </div>
            ))}
          </div>
        ))}
      </section>
    ),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: (props: Props) => <span>{contents(props)}</span>,
    // Laid out at once, 351pt across: a 375pt phone less the sheet's insets.
    View: (props: Props) => {
      const { onLayout } = props;
      useLayoutEffect(() => onLayout?.({ nativeEvent: { layout: { width: 351 } } }), [onLayout]);
      return (
        <div aria-label={props.accessibilityLabel} role={props.accessibilityRole}>
          {contents(props)}
        </div>
      );
    },
    useWindowDimensions: () => ({ fontScale: harness.fontScale, height: 800, width: 375 }),
  };
});
vi.mock("@react-navigation/native", () => ({
  StackActions: {
    pop: (count: number) => ({ type: "POP", count }),
    popTo: (name: string, params: object) => ({ type: "POP_TO", name, params }),
    push: (name: string, params: object) => ({ type: "PUSH", name, params }),
  },
  useNavigation: () => ({
    dispatch: harness.dispatch,
    getState: () => ({ routes: harness.routes }),
    goBack: harness.goBack,
    navigate: harness.navigate,
    setOptions: harness.setOptions,
  }),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useHostUserId: () => "user",
  useMobileState: () => ({ selection: { deploymentId, hostClient: harness.client } }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: harness.haptic }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../ui/glass.js", () => ({ useLiquidGlass: () => true }));
vi.mock("../ui/pane.js", () => ({
  useContentInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({
    children,
    maxFontSizeMultiplier,
  }: {
    readonly children?: ReactNode;
    readonly maxFontSizeMultiplier?: number;
  }) => <span data-font-limit={maxFontSizeMultiplier}>{children}</span>,
  Notice: ({ title }: { readonly title: string }) => <p>{title}</p>,
  StatusDot: ({ tone }: { readonly tone: string }) => <i data-dot={tone} />,
  Toggle: (props: {
    readonly accessibilityLabel: string;
    readonly disabled?: boolean;
    readonly onChange: (value: boolean) => void;
    readonly value: boolean;
  }) => (
    <button
      aria-checked={props.value}
      aria-label={props.accessibilityLabel}
      disabled={props.disabled === true}
      role="switch"
      onClick={() => props.onChange(!props.value)}
    />
  ),
}));
vi.mock("../ui/symbol.js", () => ({
  Symbol: ({ name }: { readonly name: string }) => <i data-symbol={name} />,
}));
vi.mock("../ui/chat-orb.js", () => ({ ChatOrb: () => <i data-chat-orb /> }));
vi.mock("../ui/task-mark.js", () => ({
  TaskMark: ({ mark }: { readonly mark: { icon: string | null } }) => (
    <i data-task-icon={mark.icon} />
  ),
}));
vi.mock("./task-status.js", () => ({
  TaskMenu: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  TaskStatus: ({ word }: { readonly word: string }) => <span>{word}</span>,
  useTaskMenuChoices: () => ({ any: false }),
}));
vi.mock("./thread-subtitle.js", () => ({
  ThreadName: ({ title }: { readonly title: string }) => <span>{title}</span>,
  ThreadSubtitle: () => null,
}));
vi.mock("./thread-pane.js", () => ({ sameThreadHeader: () => false }));

const { useThreadHeader } = await import("../screens/thread-header.js");
const { AroundScreen } = await import("./around-sheet.js");
const { aroundPlaces } = await import("./around-model.js");
const { taskFamily } = await import("@opensteer/client/host");
const { surfaceRoute } = await import("../browser/surface-route.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

harness.setOptions.mockImplementation((options: Record<string, unknown>) => {
  harness.options = { ...harness.options, ...options };
});

const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  harness.client = null;
  harness.options = {};
  harness.routes = [];
  harness.fontScale = 1;
  for (const spy of [
    harness.setOptions,
    harness.navigate,
    harness.dispatch,
    harness.goBack,
    harness.haptic,
  ])
    spy.mockClear();
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

async function world(options: { readonly automations?: "absent" } = {}) {
  const loaded = new MockHostClient({ latencyMs: 0, ...options });
  clients.push(loaded);
  await loaded.load();
  let current = loaded.getSnapshot();
  const listeners = new Set<() => void>();
  let gate: Promise<void> = Promise.resolve();
  // The mock Host's own commands and reads, behind a gate the test can hold.
  const dispatch = vi.fn(async (command: Parameters<HostClient["dispatch"]>[0]) => {
    await gate;
    return loaded.dispatch(command);
  });
  const client = {
    dispatch,
    getSnapshot: () => current,
    rpc: loaded.rpc,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as HostClient;
  harness.client = client;
  return {
    client,
    dispatch,
    /** Holds the Host's answer to commands until the returned release. */
    hold: () => {
      let release = () => undefined as void;
      gate = new Promise((resolve) => (release = resolve));
      return () => release();
    },
    snapshot: () => current,
    move(next: HostSnapshot) {
      act(() => {
        current = next;
        listeners.forEach((listener) => listener());
      });
    },
    titled: (title: string) => current.threads.find((thread) => thread.title === title)!.id,
  };
}

const header: ThreadHeaderState = {
  canRetry: false,
  color: null,
  connectionLabel: null,
  icon: null,
  isHome: false,
  task: null,
  title: "Conversation",
  workspaceColor: null,
  workspaceIcon: null,
  workspaceName: null,
};

/** Mounts a conversation's bar and returns its trailing control, as each platform draws it. */
function bar(client: HostClient, threadId: string) {
  function Header(): null {
    useThreadHeader({ deploymentId, fallbackTitle: "Task", header, hostClient: client, threadId });
    return null;
  }
  render(<Header />);
  render((harness.options["headerTitle"] as () => ReactNode)());
  return {
    /** Android's slot, drawn afresh from the latest options. */
    android: () => render((harness.options["headerRight"] as () => ReactNode)()),
    /** iOS's bar items, from the latest options. */
    ios: () =>
      (
        harness.options["unstable_headerRightItems"] as () => {
          type: string;
          element: ReactElement;
        }[]
      )(),
    /** How many times the bar's trailing control has been replaced. */
    writes: () =>
      harness.setOptions.mock.calls.filter(([options]) => "unstable_headerRightItems" in options)
        .length,
  };
}

function control(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>("button[aria-label]");
}

function sheet(threadId: string): HTMLElement {
  return render(<AroundScreen route={{ params: { deploymentId, threadId } }} />);
}

/** The sheet's tiles, by label, and which one is chosen. */
function tabs(container: HTMLElement): { label: string; selected: boolean }[] {
  return [...container.querySelectorAll('[role="tab"]')].map((tab) => ({
    label: tab.getAttribute("aria-label") ?? "",
    selected: tab.getAttribute("aria-selected") === "true",
  }));
}

function chosen(container: HTMLElement): string | undefined {
  return tabs(container)
    .find(({ selected }) => selected)
    ?.label.split(",")[0];
}

function named(container: HTMLElement, label: RegExp): HTMLButtonElement {
  const target = [...container.querySelectorAll("button")].find((node) =>
    label.test(node.getAttribute("aria-label") ?? ""),
  );
  if (!target) throw new Error(`No control named ${String(label)}`);
  return target;
}

function press(container: HTMLElement, label: string): void {
  const target = [...container.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label,
  );
  if (!target) throw new Error(`No control named ${label}`);
  act(() => target.click());
}

describe("the conversation's bar", () => {
  it("draws nothing for a conversation with nothing around it", async () => {
    const w = await world({ automations: "absent" });
    const threadId = w.titled("Review PortableFS integration");
    w.move({ ...w.snapshot(), browserSessions: [] });
    const { android, ios } = bar(w.client, threadId);
    expect(control(android())).toBeNull();
    expect(ios()).toEqual([]);
  });

  it("summarizes places, tasks and schedules in one glass item, says which place is worked in, and opens Around", async () => {
    const w = await world();
    const home = w.snapshot().homeThreadId!;
    const places = aroundPlaces(w.snapshot(), home);
    const working = places.filter((place) => place.working).length;
    expect(working).toBeGreaterThan(0);
    const automations = w.snapshot().threadAutomations[home]!.length;
    const { android, ios } = bar(w.client, home);
    const button = control(android())!;
    expect(button.getAttribute("aria-label")).toBe(
      `${places.length} places open, ${working} working; 1 task running, one needs you; ${automations} schedules`,
    );
    expect(button.title).toBe("Shows the places, tasks and schedules around this conversation");
    expect(
      [...button.querySelectorAll("span")]
        .filter((node) => /^\d+$/.test(node.textContent ?? ""))
        .every((node) => Number(node.getAttribute("data-font-limit")) === headerFontScaleLimit),
    ).toBe(true);
    // A mixed set of places shows the general symbol; the running task its own mark.
    expect(button.querySelector('[data-symbol="rectangle.on.rectangle"]')).not.toBeNull();
    expect(button.querySelectorAll("[data-task-icon]")).toHaveLength(1);
    expect(button.querySelector('[data-symbol="clock"]')).not.toBeNull();
    expect(button.textContent).toBe(`${places.length}1${automations}`);
    // iOS: one custom item, which UIKit draws in the bar's glass capsule.
    const items = ios();
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("custom");
    expect(control(render(items[0]!.element))?.getAttribute("aria-label")).toBe(
      button.getAttribute("aria-label"),
    );
    act(() => button.click());
    expect(harness.navigate).toHaveBeenCalledWith("ThreadAround", { deploymentId, threadId: home });
  });

  it("is not redrawn by a streamed token, only by a change in what is around", async () => {
    const w = await world();
    const home = w.snapshot().homeThreadId!;
    const { writes } = bar(w.client, home);
    const before = writes();
    for (const text of ["Hel", "Hello", "Hello there"]) {
      const snapshot = w.snapshot();
      const entries = snapshot.transcripts[home] ?? [];
      w.move({
        ...snapshot,
        transcripts: {
          ...snapshot.transcripts,
          [home]: [...entries, { ...entries.at(-1)!, id: createId("message"), text } as never],
        },
      });
    }
    // A running child's subject, as its own reply streams, is not the bar's either.
    const { assignments } = w.snapshot();
    const child = Object.values(assignments).find(({ parentThreadId }) => parentThreadId === home)!;
    w.move({
      ...w.snapshot(),
      assignments: {
        ...assignments,
        [child.id]: { ...child, objectivePreview: "A streaming child's changing subject" },
      },
    });
    expect(writes()).toBe(before);
    w.move({ ...w.snapshot(), threadAutomations: {} });
    expect(writes()).toBe(before + 1);
  });

  it("adds and removes the header control as schedules and tasks appear and vanish", async () => {
    const w = await world();
    const threadId = w.titled("Review PortableFS integration");
    const original = w.snapshot();
    const empty = { ...original, browserSessions: [], assignments: {}, threadAutomations: {} };
    w.move(empty);
    const { ios, android } = bar(w.client, threadId);
    expect(ios()).toEqual([]);
    const schedule = original.threadAutomations[threadId]![0]!;
    w.move({ ...empty, threadAutomations: { [threadId]: [schedule] } });
    expect(control(android())?.getAttribute("aria-label")).toBe("1 schedule");
    w.move({
      ...empty,
      threadAutomations: { [threadId]: [schedule, { ...schedule, id: "second" }] },
    });
    expect(control(android())?.getAttribute("aria-label")).toBe("2 schedules");
    const seed = Object.values(original.assignments)[0]!;
    const assignment = { ...seed, parentThreadId: threadId as typeof seed.parentThreadId };
    w.move({ ...empty, assignments: { [assignment.id]: assignment } });
    expect(control(android())?.getAttribute("aria-label")).toMatch(/^1 task running/);
    w.move(empty);
    expect(ios()).toEqual([]);
    expect(control(android())).toBeNull();
  });

  it("adds and removes a places-only control as live places appear and close", async () => {
    const w = await world();
    const original = w.snapshot();
    const home = original.homeThreadId!;
    const live = { ...original, assignments: {}, threadAutomations: {} };
    const empty = { ...live, browserSessions: [], machines: [] };
    w.move(empty);
    const { ios, android } = bar(w.client, home);
    expect(ios()).toEqual([]);
    w.move(live);
    expect(aroundPlaces(live, home).length).toBeGreaterThan(0);
    expect(control(android())?.getAttribute("aria-label")).toContain("place");
    w.move(empty);
    expect(ios()).toEqual([]);
  });

  it("keeps working on a Host without automations, showing places and tasks only", async () => {
    const w = await world({ automations: "absent" });
    const home = w.snapshot().homeThreadId!;
    const button = control(bar(w.client, home).android())!;
    expect(button.getAttribute("aria-label")).not.toContain("schedule");
    expect(button.querySelector('[data-symbol="clock"]')).toBeNull();
    expect(tabs(sheet(home)).map(({ label }) => label.split(",")[0])).toEqual(["Places", "Tasks"]);
  });
});

describe("Around this thread", () => {
  it("has a tile for each section with anything in it, and opens on the task that needs the reader", async () => {
    const w = await world();
    const home = w.snapshot().homeThreadId!;
    const places = aroundPlaces(w.snapshot(), home);
    const automations = w.snapshot().threadAutomations[home]!.length;
    const container = sheet(home);
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs(container)).toEqual([
      { label: `Places, ${places.length}, ${places.length} working`, selected: false },
      { label: "Tasks, 1, 1 needs you", selected: true },
      { label: `Schedules, ${automations}`, selected: false },
    ]);
    expect(container.textContent).not.toContain("From");
  });

  it("opens on a place an agent works in when nothing needs the reader", async () => {
    const w = await world();
    w.move({ ...w.snapshot(), waitingRequests: [] });
    expect(chosen(sheet(w.snapshot().homeThreadId!))).toBe("Places");
  });

  it("keeps the reader's section as the Host changes, and gives way only when it empties", async () => {
    const w = await world();
    const original = w.snapshot();
    const home = original.homeThreadId!;
    const container = sheet(home);
    // What it opened on stops needing the reader: the sheet stays where it is.
    w.move({ ...w.snapshot(), waitingRequests: [] });
    expect(chosen(container)).toBe("Tasks");
    press(container, `Schedules, ${original.threadAutomations[home]!.length}`);
    expect(chosen(container)).toBe("Schedules");
    expect(harness.haptic).toHaveBeenCalledOnce();

    press(container, "Tasks, 1");
    const open = Object.values(original.assignments).find(
      (assignment) => assignment.parentThreadId === home && assignment.status === "open",
    )!;
    w.move({
      ...w.snapshot(),
      assignments: {
        ...original.assignments,
        [open.id]: { ...open, finishedAt: new Date().toISOString(), status: "completed" },
      },
    });
    // The task finished: its tile is gone, and the sheet falls to the first section.
    expect(tabs(container).map(({ label }) => label.split(",")[0])).toEqual([
      "Places",
      "Earlier",
      "Schedules",
    ]);
    expect(chosen(container)).toBe("Places");
    // A section that comes back does not take the sheet back with it.
    w.move({ ...w.snapshot(), assignments: original.assignments });
    expect(chosen(container)).toBe("Places");
  });

  it("shows a lone section's list without tiles", async () => {
    const w = await world();
    const container = sheet(w.titled("Check the delivery ETA"));
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(named(container, /^Phone, Pixel 7, agent working$/u)).toBeDefined();
  });

  it("wraps four tiles two by two at large text sizes rather than squeezing their labels", async () => {
    const w = await world();
    const home = w.snapshot().homeThreadId!;
    const open = Object.values(w.snapshot().assignments).find(
      ({ parentThreadId }) => parentThreadId === home,
    )!;
    const earlier = {
      ...open,
      finishedAt: new Date().toISOString(),
      id: createId("delegation"),
      status: "completed" as const,
      workerThread: { ...open.workerThread, id: createId("thread") },
    };
    w.move({
      ...w.snapshot(),
      assignments: { ...w.snapshot().assignments, [earlier.id]: earlier },
    });
    const widths = (container: HTMLElement) =>
      [...container.querySelectorAll('[role="tab"]')].map((tab) =>
        Number(tab.getAttribute("data-width")),
      );
    // 351pt across less three 8pt gaps: four tiles fit at the default size.
    expect(widths(sheet(home))).toEqual([81.75, 81.75, 81.75, 81.75]);
    harness.fontScale = 1.4;
    expect(widths(sheet(home))).toEqual([171.5, 171.5, 171.5, 171.5]);
  });

  it("lists every earlier task under the day it finished, and opens a schedule's own screen from its row", async () => {
    const w = await world();
    const parent = w.titled("Reconcile August expenses");
    const seed = Object.values(w.snapshot().assignments)[0]!;
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
    const settled = [0, 0, 1, 1, 1].map((offset) => ({
      ...seed,
      finishedAt: day(offset),
      id: createId("delegation"),
      parentThreadId: parent as typeof seed.parentThreadId,
      status: "completed" as const,
      workerThread: { ...seed.workerThread, id: createId("thread") },
    }));
    w.move({
      ...w.snapshot(),
      assignments: Object.fromEntries(settled.map((task) => [task.id, task])),
      threadAutomations: {
        [parent]: [
          { id: "watch", name: "Repository", kind: "watch", paused: false, nextFireAt: null },
          { id: "paused", name: "Later", kind: "schedule", paused: true, nextFireAt: null },
        ],
      },
    });
    const container = sheet(parent);
    expect(tabs(container).map(({ label }) => label)).toEqual([
      `Places, ${aroundPlaces(w.snapshot(), parent).length}`,
      "Earlier, 5",
      "Schedules, 2",
    ]);
    const list = container.querySelector('[aria-label="Earlier"]')!;
    expect([...list.querySelectorAll('[role="header"]')].map((node) => node.textContent)).toEqual([
      "Today",
      "Yesterday",
    ]);
    const title = taskFamily(w.snapshot(), parent).earlier[0]!.title;
    expect(
      [...list.querySelectorAll("button")].filter((node) =>
        node.getAttribute("aria-label")?.startsWith(`${title}, `),
      ),
    ).toHaveLength(5);
    expect(container.querySelector('[aria-label="Repository, Watching"]')).not.toBeNull();
    press(container, "Later, Paused");
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "PUSH",
      name: "Schedule",
      params: { deploymentId, triggerId: "paused" },
    });
  });

  it("pauses and resumes a schedule on what the Host confirms, and not while it is asked or offline", async () => {
    const w = await world();
    w.move({ ...w.snapshot(), connection: "connected" });
    const home = w.snapshot().homeThreadId!;
    const id = w
      .snapshot()
      .threadAutomations[home]!.find(({ name }) => name === "Morning email summary")!.id;
    const container = sheet(home);
    const toggle = () => named(container, /^Morning email summary$/u);
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    const release = w.hold();
    act(() => toggle().click());
    expect(w.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused", triggerId: id, type: "trigger.status.set" }),
    );
    // Asked, not yet answered: it says what the Host last said, and holds still.
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(toggle().disabled).toBe(true);
    await act(async () => release());
    await vi.waitFor(
      () =>
        expect(toggle().getAttribute("aria-checked"), "the Host's pause never showed").toBe(
          "false",
        ),
      { timeout: 2000 },
    );
    expect(toggle().disabled).toBe(false);
    expect(named(container, /^Morning email summary, Paused$/u)).toBeDefined();

    // Resumed on another device before this thread's list ever said paused: the
    // list, reread for that change, stays as it was, and the notice of it hands
    // the switch back to the list.
    w.move({ ...w.snapshot(), triggerRevision: w.snapshot().triggerRevision + 1 });
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    // What the Host reports afterwards wins over what this sheet asked.
    const reported = (paused: boolean) =>
      w.move({
        ...w.snapshot(),
        threadAutomations: {
          ...w.snapshot().threadAutomations,
          [home]: w
            .snapshot()
            .threadAutomations[home]!.map((item) => (item.id === id ? { ...item, paused } : item)),
        },
      });
    reported(true);
    reported(false);
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    w.move({ ...w.snapshot(), connection: "offline" });
    expect(toggle().disabled).toBe(true);
  });

  it("opens exactly the place or task pressed, working places first", async () => {
    const w = await world();
    const home = w.snapshot().homeThreadId!;
    const places = aroundPlaces(w.snapshot(), home);
    harness.routes = [
      { name: "Home", params: { deploymentId } },
      {
        name: "WorkspaceBrowser",
        params: { deploymentId, scope: "workspace", sessionId: "page", tabId: "beside" },
      },
      { name: "ThreadAround", params: { deploymentId, threadId: home } },
    ];
    const container = sheet(home);
    const rows = [...container.querySelectorAll('section[aria-label="Places"] button')].map(
      (node) => node.getAttribute("aria-label")!,
    );
    expect(rows[0]).toMatch(/agent working$/u);
    const last = places.at(-1)!;
    press(container, rows[places.length - 1]!);
    expect(harness.goBack).toHaveBeenCalledOnce();
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "PUSH",
      name: "WorkspaceBrowser",
      params: surfaceRoute(deploymentId, home, last.destination),
    });
    act(() => named(container, /^Book a table for Friday, Needs you/u).click());
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "PUSH",
      name: "Thread",
      params: { deploymentId, threadId: w.titled("Book a table for Friday") },
    });
  });

  it("gives a task the way back to the conversation it works for, and nothing else when that is all", async () => {
    const w = await world();
    const worker = w.titled("Book a table for Friday");
    const container = sheet(worker);
    expect(tabs(container)).toEqual([]);
    expect(container.querySelector("section")).toBeNull();
    press(container, "From Chat");
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "POP_TO",
      name: "Home",
      params: { deploymentId },
    });
    // Its control is the way back too, rather than nothing.
    expect(control(bar(w.client, worker).android())?.getAttribute("aria-label")).toBe("From Chat");
  });

  it("goes back to a parent directly under the task rather than opening it again, and opens it otherwise", async () => {
    const w = await world();
    const snapshot = w.snapshot();
    const parent = w.titled("Switch Slack to Opensteer");
    const seed = Object.values(snapshot.assignments)[0]!;
    const child = createId("thread");
    const assignment = {
      ...seed,
      id: createId("delegation"),
      parentThreadId: parent as typeof seed.parentThreadId,
      workerThread: { ...seed.workerThread, id: child },
    };
    w.move({ ...snapshot, assignments: { ...snapshot.assignments, [assignment.id]: assignment } });
    harness.routes = [
      { name: "Home", params: { deploymentId } },
      { name: "Thread", params: { deploymentId, threadId: parent } },
      { name: "Thread", params: { deploymentId, threadId: child } },
      { name: "ThreadAround", params: { deploymentId, threadId: child } },
    ];
    const container = sheet(child);
    press(container, "From Switch Slack to Opensteer");
    expect(harness.dispatch).toHaveBeenLastCalledWith({ type: "POP", count: 2 });
    expect(harness.goBack).not.toHaveBeenCalled();
    harness.routes = [
      { name: "Home", params: { deploymentId } },
      { name: "Thread", params: { deploymentId, threadId: child } },
      { name: "ThreadAround", params: { deploymentId, threadId: child } },
    ];
    press(container, "From Switch Slack to Opensteer");
    expect(harness.goBack).toHaveBeenCalledOnce();
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "PUSH",
      name: "Thread",
      params: { deploymentId, threadId: parent },
    });
  });
});
