// @vitest-environment happy-dom
import { act, useEffect, useLayoutEffect, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { taskList, markColorPaint, taskMark, type TaskRow } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { workspaceIconNames } from "@opensteer/core";
import { color } from "../theme.js";

/* Interaction failures: identity disappears behind state; unread replaces state;
 * Done hides a failure; a mark-only update is memoized away; default/search/edit
 * errors are inaccessible; a specialist edit recolours its tasks; targets shrink. */
const harness = vi.hoisted(() => ({
  reducedMotion: false,
  client: null as MockHostClient | null,
  navigate: vi.fn(),
  goBack: vi.fn(),
  dismissModal: null as (() => void) | null,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Children = { readonly children?: ReactNode };
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AccessibilityInfo: { announceForAccessibility: vi.fn(), setAccessibilityFocus: vi.fn() },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  findNodeHandle: (node: HTMLElement | null) => (node?.isConnected ? 1 : null),
  Alert: { alert: vi.fn() },
  ActivityIndicator: () => <i data-spinner />,
  KeyboardAvoidingView: ({ children }: Children) => <div>{children}</div>,
  Modal: (props: Children & { readonly visible?: boolean; readonly onDismiss?: () => void }) => {
    useEffect(() => {
      harness.dismissModal = props.visible === false ? () => props.onDismiss?.() : null;
      return () => {
        harness.dismissModal = null;
      };
    }, [props.visible, props.onDismiss]);
    return (
      <div role="dialog" data-modal-visible={props.visible !== false}>
        {props.children}
      </div>
    );
  },
  StyleSheet: { create: (styles: object) => styles, absoluteFill: {} },
  View: (
    props: Children & {
      readonly ref?: Ref<HTMLDivElement>;
      readonly accessibilityElementsHidden?: boolean;
      readonly style?: unknown;
      readonly onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    },
  ) => {
    useLayoutEffect(() => {
      props.onLayout?.({ nativeEvent: { layout: { width: 350 } } });
    }, []);
    return (
      <div
        ref={props.ref}
        aria-hidden={props.accessibilityElementsHidden}
        data-style={JSON.stringify(props.style)}
      >
        {props.children}
      </div>
    );
  },
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  Text: ({ children }: Children) => <span>{children}</span>,
  Pressable: (props: {
    readonly children?: ReactNode;
    readonly ref?: Ref<HTMLButtonElement>;
    readonly accessibilityLabel?: string;
    readonly accessibilityRole?: string;
    readonly accessibilityState?: { checked?: boolean; disabled?: boolean };
    readonly disabled?: boolean;
    readonly onPress?: () => void;
    readonly style?: unknown;
  }) => (
    <button
      ref={props.ref}
      aria-label={props.accessibilityLabel}
      role={props.accessibilityRole === "radio" ? "radio" : undefined}
      aria-checked={props.accessibilityState?.checked}
      disabled={props.disabled}
      onClick={props.onPress}
      data-style={JSON.stringify(
        typeof props.style === "function" ? props.style({ pressed: false }) : props.style,
      )}
    >
      {props.children}
    </button>
  ),
  FlatList: (props: {
    readonly data: readonly unknown[];
    readonly renderItem: (info: { item: unknown }) => ReactNode;
    readonly ListEmptyComponent?: ReactNode;
  }) => (
    <div>
      {props.data.length === 0
        ? props.ListEmptyComponent
        : props.data.map((item, i) => <div key={i}>{props.renderItem({ item })}</div>)}
    </div>
  ),
}));
vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => harness.reducedMotion }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (
    props: Children & {
      actions: readonly { id: string; title: string }[];
      onPressAction: (event: { nativeEvent: { event: string } }) => void;
    },
  ) => (
    <div>
      {props.children}
      {props.actions.map(({ id, title }) => (
        <button key={id} onClick={() => props.onPressAction({ nativeEvent: { event: id } })}>
          {title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("react-native-svg", async () => {
  const { createElement } = await import("react");
  const element = (tag: string) => (props: object) => createElement(tag, props);
  return {
    default: element("svg"),
    Circle: element("circle"),
    Defs: element("defs"),
    Ellipse: element("ellipse"),
    Line: element("line"),
    LinearGradient: element("linearGradient"),
    Path: element("path"),
    Polyline: element("polyline"),
    Rect: element("rect"),
    Stop: element("stop"),
  };
});
vi.mock("../ui/symbol.js", () => ({
  Symbol: (props: { name: string }) => <i data-symbol={props.name} />,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: Children & { style?: unknown }) => (
    <span data-style={JSON.stringify(props.style)}>{props.children}</span>
  ),
  Field: (props: {
    label: string;
    input: { value: string; onChangeText: (value: string) => void };
  }) => (
    <input
      aria-label={props.label}
      value={props.input.value}
      onChange={(event) => props.input.onChangeText(event.currentTarget.value)}
    />
  ),
  Notice: (props: { title: string; detail: string }) => (
    <p>
      {props.title}
      {props.detail}
    </p>
  ),
  RowGroup: ({ children }: Children) => <div>{children}</div>,
  PrimaryButton: (props: { label: string; onPress: () => void; disabled?: boolean }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
  SecondaryButton: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  useNavigation: () => ({
    navigate: harness.navigate,
    goBack: harness.goBack,
    setOptions: vi.fn(),
    isFocused: () => true,
  }),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ signIn: vi.fn() }),
  useMobileState: () => ({ selection: { deploymentId: "test", hostClient: harness.client } }),
}));
vi.mock("../screens/deployment-gate.js", () => ({
  useAttachedHost: () => harness.client,
  DeploymentGate: () => null,
}));
vi.mock("./tasks-pane.js", () => ({
  TasksPane: ({ header }: { header: ReactNode }) => <div>{header}</div>,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: Children) => <div>{children}</div>,
  useReadingColumn: () => ({}),
}));
import { SpecialistScreen } from "../screens/specialist.js";
import { NewSpecialistScreen } from "../screens/new-specialist.js";
import { TaskRowState, TaskRowView } from "./task-row.js";
import { TaskMark } from "../ui/task-mark.js";
import { SpecialistMarkPicker } from "../ui/mark-picker.js";
import { IconChoices } from "../ui/mark-choices.js";

let root: Root | null = null;
let container: HTMLDivElement;
const clients: MockHostClient[] = [];
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  for (const client of clients.splice(0)) client.dispose();
  harness.reducedMotion = false;
  harness.dismissModal = null;
});
function render(content: ReactNode) {
  if (root === null) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(content));
  return container;
}
function button(label: string) {
  const target = [...container.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  );
  if (!target) throw new Error(`No button ${label}`);
  return target;
}
function row(): TaskRow {
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  return {
    ...taskList(client.getSnapshot()).working[0]!,
    title: "Tokyo flights",
    icon: "plane",
    color: "teal",
  };
}

it("keeps subject, state, unread, time, quiet styling and long-press actions independent", async () => {
  const original = row();
  const open = vi.fn();
  const move = vi.fn();
  const draw = (tone: TaskRow["tone"], unread: boolean, shelf: "open" | "done" = "open") =>
    render(
      <TaskRowView
        row={{ ...original, tone, unread, done: shelf === "done", stopped: tone !== "working" }}
        shelf={shelf}
        time="2:14 PM"
        selected={false}
        onOpen={open}
        onSetDone={move}
      />,
    );
  for (const tone of ["needs-you", "working", "waiting", "failed", "finished"] as const) {
    const view = draw(tone, true);
    expect(view.querySelector("svg")?.getAttribute("color")).toBe(markColorPaint.teal.glyph);
    expect(view.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(view.querySelector('[data-style*="backgroundColor"]')).not.toBeNull();
    expect(view.querySelector('button[aria-label*="Tokyo flights"]')).not.toBeNull();
    expect(view.textContent).toContain(
      tone === "needs-you"
        ? "Needs you"
        : tone === "failed"
          ? "Couldn't finish"
          : tone === "waiting"
            ? "Waiting"
            : tone === "finished"
              ? "2:14 PM"
              : "Tokyo flights",
    );
    expect(view.querySelector("[data-spinner]") !== null).toBe(tone === "working");
  }
  // A seen, finished task with no time to show keeps no state column beside its title.
  const state = (unread: boolean) =>
    render(
      <TaskRowState row={{ ...original, tone: "finished", unread }} shelf="open" time={null} />,
    ).childElementCount;
  expect(state(false)).toBe(0);
  expect(state(true)).toBe(1);
  // The mark reads quietly once settled and seen or put in Done, as on the
  // web; needing someone or having failed stays loud even in Done.
  const markQuiet = () =>
    container.querySelector("svg")!.parentElement!.dataset.style!.includes('"opacity":0.6');
  for (const [tone, unread, shelf, quiet] of [
    ["finished", false, "open", true],
    ["finished", true, "open", false],
    ["working", false, "open", false],
    ["waiting", false, "done", true],
    ["needs-you", false, "done", false],
    ["failed", false, "done", false],
  ] as const) {
    draw(tone, unread, shelf);
    expect(markQuiet(), `${tone} ${unread ? "unread" : "read"} in ${shelf}`).toBe(quiet);
  }
  draw("failed", true, "done");
  expect(container.textContent).toContain("Couldn't finish");
  expect(
    container.querySelector('[data-style*="minHeight"]')?.getAttribute("data-style"),
  ).toContain('"minHeight":48');
  await act(async () => button("Reopen").click());
  expect(move).toHaveBeenCalledWith(expect.objectContaining({ title: "Tokyo flights" }), false);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label*="Tokyo flights"]')?.click(),
  );
  expect(open).toHaveBeenCalledWith(original.threadId);
  draw("finished", false);
  await act(async () => button("Mark Done").click());
  expect(move).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "finished" }), true);
});

it("repaints a memoized row on icon/color-only arrival and leaves unnamed or colourless marks on a neutral tile", () => {
  const original = row();
  const open = vi.fn();
  const move = vi.fn();
  const draw = (value: TaskRow) =>
    render(
      <TaskRowView
        row={value}
        shelf="open"
        time={null}
        selected={false}
        onOpen={open}
        onSetDone={move}
      />,
    );
  draw(original);
  const art = container.querySelector("svg")!.innerHTML;
  draw({ ...original, icon: "hotel", color: "magenta" });
  expect(container.querySelector("svg")!.innerHTML).not.toBe(art);
  expect(container.querySelector("svg")!.getAttribute("color")).toBe(markColorPaint.magenta.glyph);
  expect(container.querySelector("svg")!.parentElement!.dataset.style).toContain(
    markColorPaint.magenta.wash,
  );
  const tile = () => container.firstElementChild!.getAttribute("data-style");
  render(<TaskMark mark={taskMark({ icon: "plane", color: null })} />);
  expect(container.querySelector("svg")!.getAttribute("color")).toBe(color.muted);
  expect(tile()).toContain(color.surfaceRaised);
  render(<TaskMark mark={taskMark({ icon: null, color: "blue" })} />);
  expect(container.querySelector("svg")).toBeNull();
  expect(tile()).toContain(color.surfaceRaised);
  harness.reducedMotion = true;
  draw({ ...original, tone: "working" });
  expect(container.querySelector("[data-spinner]")).toBeNull();
  expect(container.querySelector('[data-symbol="circle.dotted"]')).not.toBeNull();
});

it("offers all 130 searchable icons with accessible selected states and a distinct default", async () => {
  const choose = vi.fn();
  render(<IconChoices task color="blue" value="plane" onChange={choose} />);
  expect(container.querySelectorAll('button[role="radio"]').length).toBe(
    workspaceIconNames.length + 1,
  );
  expect(button("Plane").getAttribute("aria-checked")).toBe("true");
  await act(async () => button("Use default").click());
  expect(choose).toHaveBeenCalledWith(null);
  const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "plane");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelectorAll('button[role="radio"]').length).toBe(2);
  await act(async () => button("Plane").click());
  expect(choose).toHaveBeenLastCalledWith("plane");
});

it("changes a specialist colour through the client without recolouring its tasks, retaining all seven swatches", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  await client.load();
  const workspace = client.getSnapshot().workspaces.find(({ kind }) => kind === "specialized")!;
  const original = client.getSnapshot().threads.map(({ id, color }) => ({ id, color }));
  const dispatch = vi.spyOn(client, "dispatch");
  render(
    <SpecialistMarkPicker
      hostClient={client}
      workspace={workspace}
      editable
      onClose={vi.fn()}
      onDismiss={vi.fn()}
      onRefused={vi.fn()}
    />,
  );
  for (const hue of ["Lime", "Green", "Teal", "Sky", "Blue", "Purple", "Magenta"])
    expect(button(hue)).toBeDefined();
  await act(async () => button("Magenta").click());
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "workspace.color.set",
      workspaceId: workspace.id,
      color: "magenta",
    }),
  );
  expect(client.getSnapshot().workspaces.find(({ id }) => id === workspace.id)?.color).toBe(
    "magenta",
  );
  expect(client.getSnapshot().threads.map(({ id, color }) => ({ id, color }))).toEqual(original);
});

it("opens colour editing from the specialist screen and hides it on an old Host", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  await client.load();
  harness.client = client;
  const workspace = client.getSnapshot().workspaces.find(({ kind }) => kind === "specialized")!;
  const route = {
    key: "specialist",
    name: "Specialist",
    params: { deploymentId: "test", workspaceId: workspace.id },
  };
  render(<SpecialistScreen route={route} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => button("Change specialist icon and colour").click());
  await act(async () => button("Teal").click());
  expect(client.getSnapshot().workspaces.find(({ id }) => id === workspace.id)?.color).toBe("teal");
  await act(async () => button("Close").click());
  act(() => root?.unmount());
  root = null;
  container.remove();
  const oldClient = new MockHostClient({ latencyMs: 0 });
  clients.push(oldClient);
  await oldClient.load();
  vi.spyOn(oldClient, "getSnapshot").mockReturnValue({
    ...oldClient.getSnapshot(),
    taskMarksAvailable: false,
  });
  harness.client = oldClient;
  render(<SpecialistScreen route={route} />);
  expect(container.querySelector('[aria-label="Change specialist icon and colour"]')).toBeNull();
});

it("creates a specialist with the chosen colour, keeping colour choices off old Hosts", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  await client.load();
  harness.client = client;
  const dispatch = vi.spyOn(client, "dispatch");
  const route = { key: "new-specialist", name: "NewSpecialist", params: { deploymentId: "test" } };
  render(<NewSpecialistScreen route={route} />);
  await act(async () => button("Sky").click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Travel planning",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const create = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("Create"),
  )!;
  await act(async () => create.click());
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "workspace.create", name: "Travel planning", color: "sky" }),
  );
  act(() => root?.unmount());
  root = null;
  container.remove();
  const oldClient = new MockHostClient({ latencyMs: 0 });
  clients.push(oldClient);
  await oldClient.load();
  vi.spyOn(oldClient, "getSnapshot").mockReturnValue({
    ...oldClient.getSnapshot(),
    taskMarksAvailable: false,
  });
  harness.client = oldClient;
  render(<NewSpecialistScreen route={route} />);
  expect(container.querySelector('[aria-label="Sky"]')).toBeNull();
});
