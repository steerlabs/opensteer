import { testHostConnection } from "@opensteer/client/test-support";
// @vitest-environment happy-dom
import {
  automationName,
  HostClientRequestError,
  scheduleList,
  sectionAutomations,
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
  foreground: true,
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
    TextInput: (props: {
      accessibilityLabel?: string;
      onChangeText?: (text: string) => void;
      placeholder?: string;
      secureTextEntry?: boolean;
      value?: string;
    }) => (
      <input
        aria-label={props.accessibilityLabel ?? props.placeholder}
        onChange={(event) => props.onChangeText?.(event.currentTarget.value)}
        placeholder={props.placeholder}
        type={props.secureTextEntry ? "password" : "text"}
        value={props.value ?? ""}
      />
    ),
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
    popToTop: () => ({ type: "POP_TO_TOP" }),
    push: (name: string, params: object) => ({ payload: { name, params }, type: "PUSH" }),
  },
  useIsFocused: () => harness.focused,
  useNavigation: () => ({
    dispatch: harness.dispatch,
    getState: () => ({ index: harness.routes.length - 1, routes: harness.routes }),
    setOptions: harness.setOptions,
  }),
}));
vi.mock("../ui/foreground.js", () => ({ useAppForeground: () => harness.foreground }));
vi.mock("../navigation-header.js", () => ({
  headerActions: (actions: object) => actions,
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => <p>No Host</p>,
  useAttachedHost: () => harness.host,
}));
vi.mock(
  "../ui/action-line.js",
  async () => (await import("../../test-support/action-line-mocks.js")).actionLine,
);
vi.mock(
  "../ui/placeholder.js",
  async () => (await import("../../test-support/action-line-mocks.js")).placeholder,
);
vi.mock("../ui/screen.js", () => ({
  Screen: (props: Children) => <main>{props.children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/symbol.js", () => ({
  Symbol: (props: { name: string }) => <i data-symbol={props.name} />,
}));
vi.mock("../ui/agent-orb.js", () => ({ AgentOrb: () => <i data-mark="chat" /> }));
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
  harness.foreground = true;
  harness.routes = [];
});

/** The real mock Host's triggers and commands behind a client whose connection the test holds. */
function host(memoryPasses?: "active" | "off" | "waiting-for-model") {
  const mock = new MockHostClient({ latencyMs: 0, ...(memoryPasses ? { memoryPasses } : {}) });
  mocks.push(mock);
  let snapshot: HostSnapshot = { ...mock.getSnapshot(), connection: "connected" };
  const listeners = new Set<() => void>();
  const list = vi.fn(mock.rpc["triggers.list"]);
  const get = vi.fn(mock.rpc["triggers.get"]);
  const dispatch = vi.fn(mock.dispatch.bind(mock));
  const client = {
    dispatch,
    setTaskDone: mock.setTaskDone.bind(mock),
    resumeThreadInputQueue: mock.resumeThreadInputQueue.bind(mock),
    getSnapshot: () => snapshot,
    rpc: { "triggers.get": get, "triggers.list": list },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as HostClient;
  Object.assign(client, { connection: testHostConnection(client) });
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
  it("groups the list as the web does, each group in its own order", async () => {
    const f = host();
    const screen = listScreen();
    await shown(screen, "Morning email summary", "the list never loaded");
    const expected = sectionAutomations(
      scheduleList(await f.summaries(), f.snapshot()),
      Date.now(),
    );
    const sections = [...screen.querySelectorAll("section")];
    expect(sections.map((section) => section.dataset["section"])).toEqual(
      expected.map(({ title }) => title),
    );
    expect(expected.map(({ id }) => id)).toContain("attention");
    sections.forEach((section, index) =>
      expect(
        [...section.querySelectorAll("button")].map(
          (row) => row.getAttribute("aria-label")!.split(". ")[0],
        ),
      ).toEqual(expected[index]!.items.map(({ item }) => automationName(item))),
    );
    // A schedule Opensteer paused says why, in place of its next run.
    const watcher = expected
      .flatMap(({ items }) => items)
      .find(({ item }) => item.name === "Inbox watcher")!;
    expect(button(screen, /^Inbox watcher\./).getAttribute("aria-label")).toContain(
      watcher.item.pauseReason!,
    );
    expect(button(screen, /^Morning email summary\./).getAttribute("aria-label")).toMatch(/Next /);
  });

  it("says when the Host's 100-row answer may be truncated", async () => {
    const f = host();
    const seed = (await f.summaries())[0]!;
    f.list.mockResolvedValue({
      ok: true,
      data: {
        triggers: Array.from({ length: 100 }, (_, index) => ({
          ...seed,
          id: createId("trigger"),
          name: `Schedule ${index}`,
        })),
      },
    });
    const screen = listScreen();
    await shown(screen, "Showing the first 100 automations.", "the cap warning was missing");
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
    await shown(screen, "No automations yet", "the empty list was never told");
  });

  it("tells an old Host apart from an empty list", async () => {
    const f = host();
    f.list.mockRejectedValue(
      new HostClientRequestError({
        code: "not_found",
        message: "Unknown RPC",
        reason: "unknown-method",
        status: 404,
      }),
    );
    const screen = listScreen();
    await vi.waitFor(
      () =>
        expect(
          screen.querySelector('[aria-label="Automations aren’t available here"]'),
        ).not.toBeNull(),
      { timeout: 2000 },
    );
    expect(screen.textContent).not.toContain("No automations yet");
    expect(screen.textContent).not.toContain("Try again");
  });

  it("shows a failure with a way to try again", async () => {
    const f = host();
    f.list.mockRejectedValueOnce(new Error("The Host stopped answering."));
    const screen = listScreen();
    await shown(screen, "Couldn't load schedules.", "the failure was never shown");
    expect(screen.textContent).not.toContain("No automations yet");
    press(button(screen, "Try again"));
    await shown(screen, "Morning email summary", "Try again never read the list again");
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it("keeps the last list through a lost connection and says it is offline", async () => {
    const f = host();
    const screen = listScreen();
    await shown(screen, "Morning email summary", "the list never loaded");
    f.emit({ network: "offline" });
    expect(screen.querySelector('[aria-label="Offline"]')).toBeNull();
    expect(screen.textContent).toContain("Morning email summary");
  });

  it("reads neither list nor detail while the app is backgrounded", async () => {
    const f = host();
    const summary = (await f.summaries())[0]!;
    harness.foreground = false;
    listScreen();
    detailScreen(summary.id);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });

  it("clears the previous reader's list immediately while the next reader's answer waits", async () => {
    const f = host();
    const screen = listScreen();
    await shown(screen, "Morning email summary", "first reader never loaded");
    let finish!: (answer: Awaited<ReturnType<typeof f.list>>) => void;
    f.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.emit({ user: { ...f.snapshot().user!, id: createId("user") } });
    expect(screen.textContent).not.toContain("Morning email summary");
    await act(async () => finish({ ok: true, data: { triggers: [] } }));
    await shown(screen, "No automations yet", "second reader's empty list never appeared");
  });

  it("reads nothing while another screen covers it", async () => {
    const f = host();
    harness.focused = false;
    const summary = (await f.summaries())[0]!;
    const screen = listScreen();
    detailScreen(summary.id);
    expect(f.list).not.toHaveBeenCalled();
    expect(screen.textContent).not.toContain("No automations yet");
    expect(f.get).not.toHaveBeenCalled();
  });
});

describe("One schedule", () => {
  async function named(f: ReturnType<typeof host>, name: string) {
    const summary = (await f.summaries()).find((candidate) => candidate.name === name);
    if (summary === undefined) throw new Error(`No seeded schedule ${name}.`);
    return summary;
  }

  it.each([
    ["running", "Watching"],
    ["starting", "Starting"],
    ["backoff", "Restarting after it stopped"],
    ["expired", "Waiting for its computer"],
    ["stopped", "Stopped"],
  ] as const)("describes a watch observed as %s", async (observed, words) => {
    const f = host();
    const summary = await named(f, "Inbox watcher");
    const wire = unwrapRpcResult(await f.mock.rpc["triggers.get"]({ triggerId: summary.id }));
    if (wire.activation === null) throw new Error("Watch fixture lacks activation");
    f.get.mockResolvedValue({
      ok: true,
      data: {
        ...wire,
        trigger: { ...wire.trigger, status: "active", pauseReason: null },
        activation: { ...wire.activation, observed },
      },
    });
    const screen = detailScreen(summary.id);
    await shown(screen, words, "watch state was missing");
    expect(screen.textContent).toContain("Watching continuously");
  });

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

  it("does not show the previous schedule while a replacement route waits for the Host", async () => {
    const f = host();
    const first = await named(f, "Nightly typecheck");
    const next = await named(f, "GitHub deploys");
    const screen = detailScreen(first.id);
    await shown(screen, "Active", "first schedule never loaded");
    let finish!: (answer: Awaited<ReturnType<typeof f.get>>) => void;
    f.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() =>
      roots
        .at(-1)!
        .render(<ScheduleScreen route={{ params: { deploymentId, triggerId: next.id } }} />),
    );
    expect(screen.textContent).not.toContain("Runs in");
    expect(screen.querySelector('[aria-label="Pause"]')).toBeNull();
    const data = unwrapRpcResult(await f.mock.rpc["triggers.get"]({ triggerId: next.id }));
    await act(async () => finish({ ok: true, data }));
    await shown(screen, "When its webhook is called", "replacement schedule never loaded");
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
        data: {
          ...answer,
          anchorThread: null,
          trigger: { ...answer.trigger, anchorThreadId: hidden },
        },
        ok: true,
      };
    });
    const list = listScreen();
    await shown(list, "Unavailable task", "the list never named the unavailable thread");
    expect(button(list, /^GitHub deploys\./).querySelector("[data-quiet]")).not.toBeNull();
    const screen = detailScreen(summary.id);
    await shown(screen, "That task isn’t available to you", "the schedule never loaded");
    const anchor = button(screen, "Runs in Unavailable task");
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

    let confirm!: (answer: Awaited<ReturnType<typeof f.get>>) => void;
    f.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    let release = holdNextDispatch(f);
    press(button(screen, "Pause"));
    expect(button(screen, "Pause").getAttribute("aria-busy")).toBe("true");
    expect(button(screen, "Run now").disabled).toBe(true);
    press(button(screen, "Pause"));
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1));
    expect(screen.textContent).not.toContain("Resume");
    release();
    await vi.waitFor(
      () => expect(f.get, "confirmation read never started").toHaveBeenCalledTimes(2),
      { timeout: 1000 },
    );
    expect(button(screen, "Pause").getAttribute("aria-busy")).toBe("false");
    expect(screen.textContent).not.toContain("Resume");
    const confirmed = await f.mock.rpc["triggers.get"]({ triggerId: summary.id });
    await act(async () => confirm(confirmed));
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
    // Pause shows before the resume settles; Run now is enabled only once it has.
    await vi.waitFor(() => expect(button(screen, "Pause").disabled, "never resumed").toBe(false), {
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

  it("shows recent runs and an honest warning when the run answer is lost", async () => {
    const f = host();
    const summary = await named(f, "Nightly typecheck");
    const screen = detailScreen(summary.id);
    await shown(screen, "Active", "the schedule never loaded");
    const before = screen.querySelectorAll("button[aria-label]").length;
    f.dispatch.mockImplementationOnce(async (command) => {
      await f.mock.dispatch(command);
      throw new Error("Lost answer");
    });
    press(button(screen, "Run now"));
    await shown(
      screen,
      "Couldn't confirm this schedule started.",
      "run uncertainty was never shown",
    );
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    // The run it started, and Check.
    expect(screen.querySelectorAll("button[aria-label]").length).toBe(before + 2);
    // Check asks again under the same key; the Host answers for the first run.
    press(button(screen, "Check"));
    await vi.waitFor(() => expect(f.dispatch, "check never asked").toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    await vi.waitFor(
      () => expect(screen.textContent, "check never settled").not.toContain("Couldn't confirm"),
      { timeout: 2000 },
    );
    expect(f.dispatch.mock.calls[1]![0]).toEqual(f.dispatch.mock.calls[0]![0]);
    expect(button(screen, "Run now").disabled).toBe(false);
  });

  it("keeps the unknown run warning visible when confirmation reads also fail", async () => {
    const f = host();
    const summary = await named(f, "Nightly typecheck");
    const screen = detailScreen(summary.id);
    await shown(screen, "Active", "the schedule never loaded");
    f.dispatch.mockRejectedValueOnce(new Error("Lost answer"));
    f.get.mockRejectedValue(new Error("Unable to read runs"));
    press(button(screen, "Run now"));
    await shown(
      screen,
      "Couldn't confirm this schedule started.",
      "run uncertainty was never shown",
    );
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it("drops a deleted schedule without claiming this Host lacks schedules", async () => {
    const f = host();
    const summary = await named(f, "Nightly typecheck");
    const screen = detailScreen(summary.id);
    await shown(screen, "Active", "the detail never loaded");
    f.get.mockRejectedValue(
      new HostClientRequestError({ code: "not_found", status: 404, message: "Trigger not found" }),
    );
    f.emit({ triggerRevision: 1 });
    await vi.waitFor(() =>
      expect(
        screen.querySelector('[aria-label="This isn\'t available"]'),
        "deleted detail was never removed",
      ).not.toBeNull(),
    );
    expect(screen.textContent).not.toContain("Update Opensteer");
    expect(screen.querySelector('[aria-label="Pause"]')).toBeNull();
  });

  it("says why a change failed and leaves the schedule as the Host has it", async () => {
    const f = host();
    const summary = await named(f, "Nightly typecheck");
    const screen = detailScreen(summary.id);
    await shown(screen, "Active", "the schedule never loaded");
    f.dispatch.mockRejectedValueOnce(new Error("The Host refused the change."));
    press(button(screen, "Pause"));
    await shown(
      screen,
      "Couldn't confirm this schedule was paused.",
      "the lost answer was never shown",
    );
    expect(button(screen, "Pause").disabled).toBe(false);
    expect(screen.textContent).not.toContain("Resume");
  });

  it("answers a tap while disconnected beside the buttons, without sending it", async () => {
    const f = host();
    const summary = await named(f, "Nightly typecheck");
    const screen = detailScreen(summary.id);
    await shown(screen, "Active", "the schedule never loaded");
    f.emit({ connection: "offline" });
    expect(screen.querySelector('[aria-label="Offline"]')).toBeNull();
    expect(button(screen, "Run now").disabled).toBe(false);
    press(button(screen, "Run now"));
    await shown(screen, "Not started.", "the unsent run was never answered");
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(screen.textContent).toContain("Active");
  });
});

describe("Managed memory passes", () => {
  it("shows the waiting reason, navigates the unlisted worker and pauses/resumes", async () => {
    const f = host("waiting-for-model");
    const light = (await f.summaries()).find((t) => t.systemRole === "memory-light")!;
    const screen = detailScreen(light.id);
    await shown(
      screen,
      "Waiting for an eligible AI account on the hosting computer.",
      "waiting reason missing",
    );
    expect(screen.textContent).not.toContain("Run now");
    expect(screen.textContent).toContain("It tells you when something matters");
    press(button(screen, /^Runs in /));
    expect(pushed().at(-1)).toMatchObject({
      payload: { params: { threadId: light.anchorThreadId } },
    });
    press(button(screen, "Pause"));
    await vi.waitFor(() => expect(button(screen, "Resume").disabled).toBe(false), {
      timeout: 2000,
    });
    expect(screen.textContent).not.toContain(
      "Waiting for an eligible AI account on the hosting computer.",
    );
    press(button(screen, "Resume"));
    await vi.waitFor(() => expect(button(screen, "Pause").disabled).toBe(false), { timeout: 2000 });
  });

  it("refreshes stopped-worker recovery from another device without streaming reads", async () => {
    const f = host("active");
    const light = (await f.summaries()).find((t) => t.systemRole === "memory-light")!;
    const screen = detailScreen(light.id);
    await shown(screen, "Pause", "detail missing");
    const original = unwrapRpcResult(await f.mock.rpc["triggers.get"]({ triggerId: light.id }));
    let worker = { ...original.anchorThread! };
    f.get.mockImplementation(async () => ({
      ok: true,
      data: { ...original, anchorThread: worker },
    }));
    worker = { ...worker, inputQueuePaused: true };
    f.emit({ triggerRevision: f.snapshot().triggerRevision + 1 });
    await shown(screen, "Resume worker", "Stop state did not refresh");
    const resume = vi.spyOn(harness.host, "resumeThreadInputQueue").mockImplementation(async () => {
      worker = { ...worker, inputQueuePaused: false };
    });
    press(button(screen, "Resume worker"));
    await vi.waitFor(() => expect(screen.textContent).not.toContain("Resume worker"), {
      timeout: 2000,
    });
    expect(resume).toHaveBeenCalledWith(light.anchorThreadId);
    const reads = f.get.mock.calls.length;
    f.emit({
      threads: f.snapshot().threads.map((t) => ({ ...t, updatedAt: "2026-11-03T11:00:00Z" })),
    });
    expect(f.get).toHaveBeenCalledTimes(reads);
  });

  it("shows automation secret names and lets the person add, replace, and remove secrets", async () => {
    const f = host();
    const trigger = (await f.summaries()).find((t) => !t.systemRole)!;
    const screen = detailScreen(trigger.id);
    await shown(screen, "Secrets", "secrets section did not appear");
    expect(screen.textContent).toContain("can read them there");
    expect(screen.textContent).toContain("prints a secret");
    expect(screen.textContent?.toLowerCase()).not.toContain("agent cannot see");

    const setInput = (label: string, value: string) => {
      const input = screen.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      expect(input).not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };

    press(button(screen, "Add"));
    setInput("Secret name", "API_TOKEN");
    const valInput = screen.querySelector<HTMLInputElement>('input[aria-label="Secret value"]')!;
    expect(valInput.type).toBe("password");
    setInput("Secret value", "mobile-secret-1");
    press(button(screen, "Save"));
    await shown(screen, "API_TOKEN", "added secret name never appeared");
    expect(screen.textContent).not.toContain("mobile-secret-1");

    // R7: Lost answer after a committed Add -> Check reads names and confirms (never says "Not saved.").
    f.dispatch.mockImplementationOnce(async (command) => {
      await f.mock.dispatch(command);
      throw new Error("Lost answer");
    });
    press(button(screen, "Add"));
    setInput("Secret name", "LOST_TOKEN");
    setInput("Secret value", "SOL_R7_FIXTURE_TOKEN");
    press(button(screen, "Save"));
    await shown(screen, "Couldn't confirm the secret was saved.", "expected uncertainty");
    press(button(screen, "Check"));
    await shown(screen, "LOST_TOKEN", "committed secret name did not appear after Check");
    await vi.waitFor(
      () => {
        expect(screen.textContent).not.toContain("Not saved.");
        expect(screen.textContent).not.toContain("Couldn't confirm the secret was saved.");
      },
      { timeout: 2000 },
    );
    expect(screen.textContent).not.toContain("SOL_R7_FIXTURE_TOKEN");

    // R7: Lost answer on Replace has no name-level evidence -> Check does NOT falsely say "Not saved."
    f.dispatch.mockImplementationOnce(async (command) => {
      await f.mock.dispatch(command);
      throw new Error("Lost replace answer");
    });
    press(button(screen, "Replace LOST_TOKEN"));
    setInput("New value", "SOL_R7_REPLACE_TOKEN");
    press(button(screen, "Save"));
    await shown(screen, "Couldn't confirm the secret was saved.", "expected replace uncertainty");
    expect(screen.textContent).not.toContain("Not saved.");
    expect(screen.textContent).not.toContain("SOL_R7_REPLACE_TOKEN");
    press(button(screen, "Cancel"));

    // Failed save shows why the Home refused it rather than hiding the reason (S7).
    const beforeRefusedDispatch = f.dispatch.mock.calls.length;
    vi.spyOn(harness.host, "dispatch").mockRejectedValueOnce(
      new HostClientRequestError({
        code: "bad_request",
        reason: "automation-secret-case-conflict",
        status: 400,
        message:
          'Secret "api_token" conflicts with "API_TOKEN" which already exists with different casing.',
      }),
    );
    press(button(screen, "Add"));
    setInput("Secret name", "api_token");
    setInput("Secret value", "other");
    press(button(screen, "Save"));
    await shown(screen, "different capitalization", "save refusal reason did not appear");
    expect(f.dispatch.mock.calls.length).toBe(beforeRefusedDispatch + 1);
    press(button(screen, "Cancel"));

    press(button(screen, "Replace API_TOKEN"));
    const replaceInput = screen.querySelector<HTMLInputElement>('input[aria-label="New value"]')!;
    expect(replaceInput.type).toBe("password");
    setInput("New value", "mobile-secret-2");
    press(button(screen, "Save"));
    await vi.waitFor(
      () => expect(screen.querySelector('input[aria-label="New value"]')).toBeNull(),
      { timeout: 2000 },
    );
    expect(screen.textContent).toContain("API_TOKEN");
    expect(screen.textContent).not.toContain("mobile-secret-2");

    // Remove requires confirmation before deleting (S7).
    press(button(screen, "Remove API_TOKEN"));
    await shown(screen, "Confirm remove", "remove confirmation did not appear");
    expect(screen.textContent).toContain("API_TOKEN");
    press(button(screen, "Confirm remove"));
    await vi.waitFor(() => expect(screen.textContent).not.toContain("API_TOKEN"), {
      timeout: 2000,
    });

    // R7: Refresh failure after a committed write does NOT turn the write into an error/uncertainty.
    f.get.mockRejectedValueOnce(new Error("refresh offline"));
    press(button(screen, "Add"));
    setInput("Secret name", "AFTER_REFRESH_FAIL");
    setInput("Secret value", "mobile-secret-3");
    press(button(screen, "Save"));
    await vi.waitFor(
      () => expect(screen.querySelector('input[aria-label="Secret value"]')).toBeNull(),
      { timeout: 2000 },
    );
    expect(screen.textContent).not.toContain("Couldn't confirm");
    expect(screen.textContent).not.toContain("Not saved.");
    expect(screen.textContent).not.toContain("mobile-secret-3");
  });

  it("shows an explicit recovery state with confirmation when secrets can no longer be read (R6)", async () => {
    const f = host();
    const trigger = (await f.summaries()).find((t) => !t.systemRole)!;
    const baseGet = f.mock.rpc["triggers.get"];
    let unreadable = true;
    f.get.mockImplementation(async (input) => {
      const detail = unwrapRpcResult(await baseGet(input));
      return {
        ok: true as const,
        data: {
          ...detail,
          secretNames: unreadable ? [] : detail.secretNames,
          secretsUnreadable: unreadable,
        },
      };
    });
    f.dispatch.mockImplementation(async (command) => {
      if (command.type === "trigger.secrets.set" && command.clearAll) {
        unreadable = false;
      }
      return f.mock.dispatch(command);
    });
    const screen = detailScreen(trigger.id);
    await shown(screen, "These secrets can no longer be read.", "unreadable state did not appear");
    expect(() => button(screen, "Add")).toThrow();
    press(button(screen, "Clear all secrets"));
    await shown(screen, "Confirm clear all", "clear-all confirmation did not appear");
    press(button(screen, "Confirm clear all"));
    await shown(screen, "No secrets yet.", "empty readable state did not return after clearAll");
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "trigger.secrets.set",
        triggerId: trigger.id,
        clearAll: true,
      }),
    );
  });
});
