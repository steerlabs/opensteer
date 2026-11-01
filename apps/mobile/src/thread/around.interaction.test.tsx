// @vitest-environment happy-dom

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import type { ThreadHeaderState } from "./thread-pane.js";

/*
 * What is around a conversation, from its bar. What can go wrong:
 * - an empty control sits in the bar of a conversation with nothing around it;
 * - the control's counts or marks miss a place, a task or a schedule, or a
 *   place an agent works in does not say so;
 * - the sheet's sections move, or an empty one keeps its header;
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
  goBack: vi.fn(),
  routes: [] as { name: string; params?: object }[],
}));

vi.mock("react-native", () => {
  type Props = {
    readonly children?: ReactNode;
    readonly accessibilityLabel?: string;
    readonly accessibilityRole?: string;
    readonly onPress?: () => void;
  };
  return {
    Platform: { OS: "ios" },
    Pressable: (props: Props) => (
      <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
        {props.children}
      </button>
    ),
    ScrollView: (props: Props) => <div>{props.children}</div>,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: (props: Props) => <span>{props.children}</span>,
    View: (props: Props) => (
      <div aria-label={props.accessibilityLabel} role={props.accessibilityRole}>
        {props.children}
      </div>
    ),
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
vi.mock("../ui/glass.js", () => ({ useLiquidGlass: () => true }));
vi.mock("../ui/pane.js", () => ({
  useContentInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  Notice: ({ title }: { readonly title: string }) => <p>{title}</p>,
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
  for (const spy of [harness.setOptions, harness.navigate, harness.dispatch, harness.goBack])
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
  const client = {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as HostClient;
  harness.client = client;
  return {
    client,
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

function sections(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="header"]')].map((node) => node.textContent ?? "");
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

  it("keeps working on a Host without automations, showing places and tasks only", async () => {
    const w = await world({ automations: "absent" });
    const home = w.snapshot().homeThreadId!;
    const button = control(bar(w.client, home).android())!;
    expect(button.getAttribute("aria-label")).not.toContain("schedule");
    expect(button.querySelector('[data-symbol="clock"]')).toBeNull();
    expect(sections(sheet(home))).toEqual([
      `Places · ${aroundPlaces(w.snapshot(), home).length}`,
      "Tasks · 1",
    ]);
  });
});

describe("Around this thread", () => {
  it("shows Places, Tasks and Schedules in order and opens exactly the row pressed", async () => {
    const w = await world();
    const home = w.snapshot().homeThreadId!;
    const places = aroundPlaces(w.snapshot(), home);
    const automations = w.snapshot().threadAutomations[home]!.length;
    const container = sheet(home);
    expect(sections(container)).toEqual([
      `Places · ${places.length}`,
      "Tasks · 1",
      `Schedules · ${automations}`,
    ]);
    expect(container.textContent).not.toContain("From");
    // Working places are listed first and say so.
    const rows = [...container.querySelectorAll("button")].map((node) =>
      node.getAttribute("aria-label"),
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
    const worker = w.titled("Book a table for Friday");
    const task = rows.find((label) => label?.startsWith("Book a table for Friday"))!;
    press(container, task);
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "PUSH",
      name: "Thread",
      params: { deploymentId, threadId: worker },
    });
  });

  it("folds earlier tasks under the rest, four at a time, and opens a schedule's own screen from its row", async () => {
    const w = await world();
    const parent = w.titled("Reconcile August expenses");
    const seed = Object.values(w.snapshot().assignments)[0]!;
    const settled = Array.from({ length: 5 }, (_, index) => ({
      ...seed,
      finishedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
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
    expect(sections(container)).toEqual([
      `Places · ${aroundPlaces(w.snapshot(), parent).length}`,
      "Tasks · 5",
      "Schedules · 2",
    ]);
    const title = taskFamily(w.snapshot(), parent).earlier[0]!.title;
    const earlier = () =>
      [...container.querySelectorAll("button")].filter((node) =>
        node.getAttribute("aria-label")?.startsWith(`${title}, `),
      ).length;
    expect(earlier()).toBe(0);
    press(container, "Earlier · 5");
    expect(earlier()).toBe(4);
    press(container, "Show all");
    expect(earlier()).toBe(5);
    expect(container.querySelector('[aria-label="Repository, Watching"]')).not.toBeNull();
    press(container, "Later, Paused");
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "PUSH",
      name: "Schedule",
      params: { deploymentId, triggerId: "paused" },
    });
  });

  it("gives a task the way back to the conversation it works for, and nothing else when that is all", async () => {
    const w = await world();
    const worker = w.titled("Book a table for Friday");
    const container = sheet(worker);
    expect(sections(container)).toEqual([]);
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
