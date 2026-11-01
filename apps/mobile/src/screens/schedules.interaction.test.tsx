// @vitest-environment happy-dom
import {
  HostClientRequestError,
  scheduleList,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { createId } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Schedules and one schedule, driven over the real MockHostClient's triggers
 * and commands through the real schedules client. Native views are DOM
 * stand-ins that keep their labels, presses, busy and disabled states.
 *
 * What can go wrong:
 * - the list is one undivided run, puts paused ones among what runs next, or
 *   loses the Host's next-run order;
 * - an old Host, a failure or a dropped connection reads as "No schedules";
 *   a failure has no way to try again;
 * - Pause, Resume or Run now settles on the tap instead of on the Host's
 *   answer, gives no sign it is waiting, or can be pressed offline;
 * - "Runs in" opens a thread the reader cannot see, a second copy of the one
 *   underneath, or Chat as if it were a task;
 * - a run's reply opens anywhere but its thread, at the message it wrote.
 */

const harness = vi.hoisted(() => ({
  dispatch: vi.fn(),
  focused: true,
  host: null as unknown as HostClient,
  routes: [] as { name: string; params?: object }[],
  setOptions: vi.fn(),
}));

type Children = { readonly children?: ReactNode };
type Pressed = { readonly children?: ReactNode | ((state: { pressed: boolean }) => ReactNode) };

vi.mock("react-native", () => {
  const press = (props: Pressed & Record<string, unknown>) => {
    const state = props["accessibilityState"] as { busy?: boolean; disabled?: boolean } | undefined;
    return (
      <button
        aria-busy={state?.busy === true}
        aria-label={props["accessibilityLabel"] as string | undefined}
        data-role={props["accessibilityRole"] as string | undefined}
        disabled={props["disabled"] === true}
        onClick={props["onPress"] as () => void}
      >
        {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
      </button>
    );
  };
  return {
    ActivityIndicator: () => <i role="progressbar" />,
    Platform: {
      OS: "ios",
      select: (choices: { ios?: unknown; default?: unknown }) => choices.ios ?? choices.default,
    },
    Pressable: press,
    RefreshControl: (props: { onRefresh: () => void }) => (
      <button aria-label="Pull to refresh" onClick={props.onRefresh} />
    ),
    ScrollView: (props: Children & { refreshControl?: ReactNode }) => (
      <div>
        {props.refreshControl}
        {props.children}
      </div>
    ),
    SectionList: (props: {
      ListEmptyComponent?: ReactNode;
      ListFooterComponent?: ReactNode;
      ListHeaderComponent?: ReactNode;
      keyExtractor: (item: never) => string;
      refreshControl?: ReactNode;
      renderItem: (info: { index: number; item: never; section: never }) => ReactNode;
      renderSectionHeader: (info: { section: never }) => ReactNode;
      sections: readonly { data: readonly never[]; title: string }[];
    }) => (
      <div>
        {props.refreshControl}
        {props.ListHeaderComponent}
        {props.sections.length === 0
          ? props.ListEmptyComponent
          : props.sections.map((section) => (
              <section data-section={section.title} key={section.title}>
                {props.renderSectionHeader({ section: section as never })}
                {section.data.map((item, index) => (
                  <div key={props.keyExtractor(item)}>
                    {props.renderItem({ index, item, section: section as never })}
                  </div>
                ))}
              </section>
            ))}
        {props.ListFooterComponent}
      </div>
    ),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: (props: Children) => <span>{props.children}</span>,
    View: (props: Children & { accessibilityLabel?: string; accessibilityRole?: string }) => (
      <div aria-label={props.accessibilityLabel} data-role={props.accessibilityRole}>
        {props.children}
      </div>
    ),
  };
});
vi.mock("@react-navigation/native", () => ({
  StackActions: {
    popTo: (name: string, params: object) => ({ payload: { name, params }, type: "POP_TO" }),
    push: (name: string, params: object) => ({ payload: { name, params }, type: "PUSH" }),
  },
  useIsFocused: () => harness.focused,
  useNavigation: () => ({
    dispatch: harness.dispatch,
    getState: () => ({ index: harness.routes.length - 1, routes: harness.routes }),
    setOptions: harness.setOptions,
  }),
}));
vi.mock("../navigation-header.js", () => ({ useSidebarMenu: () => undefined }));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => <p>No Host</p>,
  useAttachedHost: () => harness.host,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: (props: Children) => <main>{props.children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/symbol.js", () => ({
  Symbol: (props: { name: string }) => <i data-symbol={props.name} />,
}));
vi.mock("../ui/chat-orb.js", () => ({ ChatOrb: () => <i data-mark="chat" /> }));
vi.mock("../ui/task-mark.js", () => ({
  TaskMark: (props: { quiet?: boolean }) => <i data-mark="task" data-quiet={props.quiet} />,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: Children & { accessibilityLabel?: string }) => (
    <span aria-label={props.accessibilityLabel}>{props.children}</span>
  ),
  Notice: (props: {
    action?: { label: string; onPress: () => void };
    detail: string;
    title: string;
  }) => (
    <aside aria-label={props.title}>
      <span>{props.detail}</span>
      {props.action === undefined ? null : (
        <button onClick={props.action.onPress}>{props.action.label}</button>
      )}
    </aside>
  ),
  StatusDot: () => <i />,
}));

const { SchedulesScreen } = await import("./schedules.js");
const { ScheduleScreen } = await import("./schedule.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const deploymentId = "dep-a";
const roots: Root[] = [];
const mocks: MockHostClient[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const mock of mocks.splice(0)) mock.dispose();
  document.body.replaceChildren();
  harness.dispatch.mockReset();
  harness.setOptions.mockReset();
  harness.focused = true;
  harness.routes = [];
});

/** The real mock Host's triggers and commands behind a client whose connection the test holds. */
function host() {
  const mock = new MockHostClient({ latencyMs: 0 });
  mocks.push(mock);
  let snapshot: HostSnapshot = { ...mock.getSnapshot(), connection: "connected" };
  const listeners = new Set<() => void>();
  const list = vi.fn(mock.rpc["triggers.list"]);
  const get = vi.fn(mock.rpc["triggers.get"]);
  const dispatch = vi.fn(mock.dispatch.bind(mock));
  const client = {
    dispatch,
    getSnapshot: () => snapshot,
    rpc: { "triggers.get": get, "triggers.list": list },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as HostClient;
  harness.host = client;
  return {
    dispatch,
    emit: (patch: Partial<HostSnapshot>) =>
      act(() => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of listeners) listener();
      }),
    get,
    list,
    mock,
    snapshot: () => snapshot,
    summaries: async () => unwrapRpcResult(await mock.rpc["triggers.list"]({})).triggers,
  };
}

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

function listScreen(): HTMLElement {
  harness.routes = [{ name: "Home", params: { deploymentId } }, { name: "Schedules" }];
  return mount(<SchedulesScreen route={{ params: { deploymentId } }} />);
}

function detailScreen(triggerId: string): HTMLElement {
  harness.routes = [
    ...(harness.routes.length === 0
      ? [{ name: "Home", params: { deploymentId } }]
      : harness.routes),
    { name: "Schedule", params: { deploymentId, triggerId } },
  ];
  return mount(<ScheduleScreen route={{ params: { deploymentId, triggerId } }} />);
}

async function shown(scope: HTMLElement, text: string, what: string): Promise<void> {
  await vi.waitFor(() => expect(scope.textContent, what).toContain(text), { timeout: 2000 });
}

function button(scope: HTMLElement, label: string | RegExp): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((candidate) => {
    const name = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof label === "string" ? name === label : label.test(name);
  });
  if (found === undefined) throw new Error(`No control named ${String(label)}.`);
  return found;
}

function press(target: HTMLButtonElement): void {
  act(() => target.click());
}

function pushed(): unknown[] {
  return harness.dispatch.mock.calls.map(([action]) => action);
}

/** A dispatch the test lets through, so the waiting state can be seen first. */
function holdNextDispatch(f: ReturnType<typeof host>): () => void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.dispatch.mockImplementationOnce(async (command) => {
    await gate;
    return f.mock.dispatch(command);
  });
  return () => act(() => release());
}

describe("Schedules", () => {
  it("lists what runs next in the Host's order, then what is paused and why", async () => {
    const f = host();
    const screen = listScreen();
    await shown(screen, "Next up", "the list never loaded");
    const sections = [...screen.querySelectorAll("section")];
    expect(sections.map((section) => section.dataset["section"])).toEqual(["Next up", "Paused"]);
    const names = (section: Element) =>
      [...section.querySelectorAll("button")].map(
        (row) => row.getAttribute("aria-label")!.split(". ")[0],
      );
    const expected = scheduleList(await f.summaries(), f.snapshot());
    expect(names(sections[0]!)).toEqual(
      expected.filter(({ status }) => status === "active").map(({ name }) => name),
    );
    expect(names(sections[1]!)).toEqual(
      expected.filter(({ status }) => status === "paused").map(({ name }) => name),
    );
    // A schedule Opensteer paused says why, where the next run would be.
    const watcher = expected.find(({ name }) => name === "Inbox watcher")!;
    expect(button(screen, /^Inbox watcher\./).getAttribute("aria-label")).toContain(
      watcher.pauseReason!,
    );
    expect(button(screen, /^Morning email summary\./).getAttribute("aria-label")).toMatch(/Next /);
  });

  it("opens the schedule a row names", async () => {
    const f = host();
    const screen = listScreen();
    await shown(screen, "Morning email summary", "the list never loaded");
    press(button(screen, /^Morning email summary\./));
    const id = (await f.summaries()).find(({ name }) => name === "Morning email summary")!.id;
    expect(pushed()).toEqual([
      { payload: { name: "Schedule", params: { deploymentId, triggerId: id } }, type: "PUSH" },
    ]);
  });

  it("says when there are none, and only then", async () => {
    const f = host();
    f.list.mockResolvedValue({ data: { triggers: [] }, ok: true });
    const screen = listScreen();
    await shown(screen, "No schedules yet", "the empty list was never told");
  });

  it("tells an old Host apart from an empty list", async () => {
    const f = host();
    f.list.mockRejectedValue(
      new HostClientRequestError({ code: "not_found", message: "Unknown RPC", status: 404 }),
    );
    const screen = listScreen();
    await vi.waitFor(
      () =>
        expect(
          screen.querySelector('[aria-label="Schedules aren’t available here"]'),
        ).not.toBeNull(),
      { timeout: 2000 },
    );
    expect(screen.textContent).not.toContain("No schedules yet");
    expect(screen.textContent).not.toContain("Try again");
  });

  it("shows a failure with a way to try again", async () => {
    const f = host();
    f.list.mockRejectedValueOnce(new Error("The Host stopped answering."));
    const screen = listScreen();
    await shown(screen, "The Host stopped answering.", "the failure was never shown");
    expect(screen.textContent).not.toContain("No schedules yet");
    press(button(screen, "Try again"));
    await shown(screen, "Morning email summary", "Try again never read the list again");
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it("keeps the last list through a lost connection and says it is offline", async () => {
    const f = host();
    const screen = listScreen();
    await shown(screen, "Morning email summary", "the list never loaded");
    f.emit({ network: "offline" });
    expect(screen.querySelector('[aria-label="Offline"]')).not.toBeNull();
    expect(screen.textContent).toContain("Morning email summary");
  });

  it("reads nothing while another screen covers it", async () => {
    const f = host();
    harness.focused = false;
    const screen = listScreen();
    expect(f.list).not.toHaveBeenCalled();
    expect(screen.textContent).not.toContain("No schedules yet");
  });
});

describe("One schedule", () => {
  async function named(f: ReturnType<typeof host>, name: string) {
    const summary = (await f.summaries()).find((candidate) => candidate.name === name);
    if (summary === undefined) throw new Error(`No seeded schedule ${name}.`);
    return summary;
  }

  it("titles itself and opens the task it runs in", async () => {
    const f = host();
    const summary = await named(f, "GitHub deploys");
    const screen = detailScreen(summary.id);
    await shown(screen, "Runs in", "the schedule never loaded");
    expect(harness.setOptions).toHaveBeenLastCalledWith({ title: "GitHub deploys" });
    press(button(screen, /^Runs in /));
    expect(pushed()).toEqual([
      {
        payload: { name: "Thread", params: { deploymentId, threadId: summary.anchorThreadId } },
        type: "PUSH",
      },
    ]);
  });

  it("goes back to its thread rather than opening a second copy", async () => {
    const f = host();
    const summary = await named(f, "GitHub deploys");
    harness.routes = [
      { name: "Home", params: { deploymentId } },
      { name: "Thread", params: { deploymentId, threadId: summary.anchorThreadId } },
    ];
    const screen = detailScreen(summary.id);
    await shown(screen, "Runs in", "the schedule never loaded");
    press(button(screen, /^Runs in /));
    expect(pushed()).toEqual([
      {
        payload: { name: "Thread", params: { deploymentId, threadId: summary.anchorThreadId } },
        type: "POP_TO",
      },
    ]);
  });

  it("returns to Chat for a schedule that runs in Chat, and opens a run's reply where it was written", async () => {
    const f = host();
    const summary = await named(f, "Morning email summary");
    expect(summary.anchorThreadId).toBe(f.snapshot().homeThreadId);
    const screen = detailScreen(summary.id);
    await shown(screen, "Runs in Chat", "the schedule never loaded");
    expect(button(screen, "Runs in Chat").querySelector('[data-mark="chat"]')).not.toBeNull();
    press(button(screen, "Runs in Chat"));
    const wire = unwrapRpcResult(await f.mock.rpc["triggers.get"]({ triggerId: summary.id }));
    const replied = wire.downstreamRuns[0]!;
    press(button(screen, /Opensteer replied in Chat/));
    expect(pushed()).toEqual([
      { payload: { name: "Home", params: { deploymentId } }, type: "POP_TO" },
      {
        payload: { name: "Home", params: { deploymentId, messageId: replied.run.seedInputId } },
        type: "POP_TO",
      },
    ]);
  });

  it("offers no way into a thread this reader cannot see", async () => {
    const f = host();
    const summary = await named(f, "GitHub deploys");
    const hidden = createId("thread");
    f.list.mockImplementation(async (input) => {
      const answer = unwrapRpcResult(await f.mock.rpc["triggers.list"](input));
      return {
        data: {
          triggers: answer.triggers.map((trigger) =>
            trigger.id === summary.id ? { ...trigger, anchorThreadId: hidden } : trigger,
          ),
        },
        ok: true,
      };
    });
    f.get.mockImplementation(async (input) => {
      const answer = unwrapRpcResult(await f.mock.rpc["triggers.get"](input));
      return {
        data: { ...answer, trigger: { ...answer.trigger, anchorThreadId: hidden } },
        ok: true,
      };
    });
    const list = listScreen();
    await shown(list, "Unavailable thread", "the list never named the unavailable thread");
    expect(button(list, /^GitHub deploys\./).querySelector("[data-quiet]")).not.toBeNull();
    const screen = detailScreen(summary.id);
    await shown(screen, "That thread isn’t available to you", "the schedule never loaded");
    const anchor = button(screen, "Runs in Unavailable thread");
    expect(anchor.disabled).toBe(true);
    press(anchor);
    expect(pushed()).toEqual([]);
  });

  it("pauses, resumes and runs only on the Host's word, waiting visibly", async () => {
    const f = host();
    const summary = await named(f, "Nightly typecheck");
    const screen = detailScreen(summary.id);
    await shown(screen, "Active", "the schedule never loaded");
    // Every row and control here is a labelled button; a new run adds exactly one.
    const controls = () => screen.querySelectorAll("button[aria-label]").length;
    const before = controls();

    let release = holdNextDispatch(f);
    press(button(screen, "Pause"));
    expect(button(screen, "Pause").getAttribute("aria-busy")).toBe("true");
    expect(button(screen, "Run now").disabled).toBe(true);
    expect(screen.textContent).not.toContain("Resume");
    release();
    await vi.waitFor(() => expect(button(screen, "Resume"), "never paused").toBeDefined(), {
      timeout: 2000,
    });
    expect(screen.textContent).toContain("Paused");
    expect(f.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "paused",
        triggerId: summary.id,
        type: "trigger.status.set",
      }),
    );

    release = holdNextDispatch(f);
    press(button(screen, "Resume"));
    expect(button(screen, "Resume").getAttribute("aria-busy")).toBe("true");
    release();
    await vi.waitFor(() => expect(button(screen, "Pause"), "never resumed").toBeDefined(), {
      timeout: 2000,
    });

    release = holdNextDispatch(f);
    press(button(screen, "Run now"));
    expect(button(screen, "Run now").getAttribute("aria-busy")).toBe("true");
    release();
    await vi.waitFor(
      () =>
        expect(button(screen, "Run now").getAttribute("aria-busy"), "the run never settled").toBe(
          "false",
        ),
      { timeout: 2000 },
    );
    expect(f.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ triggerId: summary.id, type: "trigger.run" }),
    );
    expect(controls()).toBe(before + 1);
  });

  it("says why a change failed and leaves the schedule as the Host has it", async () => {
    const f = host();
    const summary = await named(f, "Nightly typecheck");
    const screen = detailScreen(summary.id);
    await shown(screen, "Active", "the schedule never loaded");
    f.dispatch.mockRejectedValueOnce(new Error("The Host refused the change."));
    press(button(screen, "Pause"));
    await shown(screen, "The Host refused the change.", "the refusal was never shown");
    expect(button(screen, "Pause").disabled).toBe(false);
    expect(screen.textContent).not.toContain("Resume");
  });

  it("can't be changed offline, and says so", async () => {
    const f = host();
    const summary = await named(f, "Nightly typecheck");
    const screen = detailScreen(summary.id);
    await shown(screen, "Active", "the schedule never loaded");
    f.emit({ connection: "offline" });
    expect(screen.querySelector('[aria-label="Offline"]')).not.toBeNull();
    expect(screen.textContent).toContain("Connect to the Host to change schedules.");
    expect(button(screen, "Pause").disabled).toBe(true);
    expect(button(screen, "Run now").disabled).toBe(true);
    press(button(screen, "Run now"));
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
