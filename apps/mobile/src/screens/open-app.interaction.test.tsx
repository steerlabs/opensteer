// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HostClientRequestError, type HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { computerReasonWords } from "@opensteer/client/integrations";
import { RunnerIdSchema, WindowIdSchema, type Tab } from "@opensteer/core";
import { OpenAppScreen } from "./open-app.js";

const state = vi.hoisted(() => ({
  host: null as MockHostClient | null,
  focused: true,
  goBack: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    isFocused: () => state.focused,
    goBack: state.goBack,
    dispatch: state.dispatch,
  }),
  StackActions: {
    push: (name: string, params: object) => ({ type: "PUSH", payload: { name, params } }),
  },
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileState: () => ({
    selection: {
      deploymentId: "deployment",
      hostClient: state.host,
    },
  }),
}));
vi.mock("../ui/pane.js", () => ({ useContentInsets: () => ({ bottom: 0 }) }));
vi.mock("../computers/app-mark.js", () => ({ MacAppIcon: () => null }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../client/mobile-client.js", () => ({ operationDetail: (error: Error) => error.message }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  StatusDot: () => null,
  Notice: ({
    title,
    detail,
    action,
  }: {
    title: string;
    detail: string;
    action?: { label: string; onPress: () => void };
  }) => (
    <div role="alert">
      {title}
      {detail}
      {action && <button onClick={action.onPress}>{action.label}</button>}
    </div>
  ),
}));
vi.mock("../thread/composer-menu.js", () => ({
  NativeMenu: (props: {
    accessibilityLabel: string;
    disabledReason: string | null;
    children: ReactNode;
    options: readonly { id: string; label: string; onPress: () => void }[];
  }) => (
    <div aria-label={props.accessibilityLabel} data-native-menu>
      {props.children}
      {props.options.map((option) => (
        <button key={option.id} disabled={props.disabledReason !== null} onClick={option.onPress}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    select: (choices: Record<string, unknown>) => choices["ios"] ?? choices["default"],
  },
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({
    children,
    accessibilityLabel,
    style,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    style?: unknown;
  }) => (
    <div
      aria-label={accessibilityLabel}
      data-row={[style]
        .flat(Infinity)
        .some(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            (part as { flexDirection?: string }).flexDirection === "row",
        )}
    >
      {children}
    </div>
  ),
  ActivityIndicator: () => <i />,
  Pressable: ({
    children,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    children: ReactNode;
    accessibilityLabel: string;
    disabled: boolean;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  SectionList: (props: {
    sections: readonly { key: string; data: readonly unknown[] }[];
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
    renderSectionHeader: (info: { section: unknown }) => ReactNode;
    renderItem: (info: { section: unknown; item: unknown; index: number }) => ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.sections.length === 0
        ? props.ListEmptyComponent
        : props.sections.map((section) => (
            <section key={section.key}>
              {props.renderSectionHeader({ section })}
              {section.data.map((item, index) => (
                <div key={index}>{props.renderItem({ section, item, index })}</div>
              ))}
            </section>
          ))}
    </div>
  ),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const chosenWindow = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000042");
const otherWindow = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000001");
/** A window as the Mac lists it: the handle that opens exactly it, and its title. */
const windowInfo = (windowId: typeof chosenWindow, title: string) => ({ windowId, title });
let root: Root | null = null;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  state.host?.dispose();
  vi.clearAllMocks();
  state.focused = true;
});
async function setup() {
  const host = new MockHostClient({ latencyMs: 0 });
  state.host = host;
  await host.load();
  // No window tabs: whether an app already has one is each case's to say.
  const windowTabs = [...host.getSnapshot().tabs.rows.values()].filter(
    (tab) => tab.kind === "window",
  );
  await host.closeTabs(windowTabs.map((tab) => tab.tabId));
  const base = host.getSnapshot();
  const snapshot = { ...base, deploymentId: "deployment" };
  vi.spyOn(host, "getSnapshot").mockImplementation(() => snapshot);
  const approved = await host.listApprovedComputerApps();
  const app = approved.find((a) => a.target.kind === "app" && a.name === "Notes")!;
  const list = vi.spyOn(host, "listApprovedComputerApps").mockResolvedValue(approved);
  const windows = vi.spyOn(host, "listComputerAppWindows").mockResolvedValue([]);
  const openTab = host.openTab.bind(host);
  const open = vi.spyOn(host, "openTab");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = () =>
    act(async () =>
      root!.render(<OpenAppScreen route={{ params: { deploymentId: "deployment" } }} />),
    );
  return { host, snapshot, approved, app, list, windows, open, openTab, render };
}
/** The tab the last open resolved to. */
async function openedTab(open: { mock: { results: { value: unknown }[] } }): Promise<Tab> {
  return (await open.mock.results.at(-1)!.value) as Tab;
}
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent === label,
  );
  expect(found, `Missing button ${label}: ${container.textContent}`).toBeDefined();
  return found!;
}
async function press(label: string) {
  await act(async () => button(label).click());
}
it("groups own apps by named Mac and Agent Phone, with window counts", async () => {
  const w = await setup();
  w.windows.mockImplementation(async (_machine, app) =>
    app.displayName === "Notes"
      ? [windowInfo(chosenWindow, "Shopping")]
      : app.displayName === "Keynote"
        ? [windowInfo(otherWindow, "One"), windowInfo(chosenWindow, "Two")]
        : [],
  );
  await w.render();
  expect(container.textContent).toContain("Studio Mac");
  expect(container.textContent).toContain("Mac mini");
  expect(container.textContent).toContain("Agent Phone · Pixel 7");
  expect(container.textContent).toContain("No windows open");
  expect(container.textContent).toContain("Shopping");
  expect(container.textContent).toContain("2 windows");
});
it.each(["offline", "unavailable", "permission-required"])(
  "disables a %s Mac and reports its status",
  async (readiness) => {
    const w = await setup();
    w.snapshot.machines = w.snapshot.machines.map((m) =>
      m.id !== w.app.machineId
        ? m
        : {
            ...m,
            ...(readiness === "offline"
              ? { status: "offline" as const }
              : { computerUse: { ...m.computerUse!, state: readiness } }),
          },
    ) as HostSnapshot["machines"];
    await w.render();
    expect(button("Notes").disabled).toBe(true);
    expect(container.textContent).toMatch(/Offline|Unavailable|Needs permission/);
    await press("Notes");
    expect(w.open).not.toHaveBeenCalled();
  },
);
it("opens a window's tab, dismissing the sheet before showing that tab", async () => {
  const w = await setup();
  w.windows.mockResolvedValue([windowInfo(chosenWindow, "Shopping")]);
  await w.render();
  await press("Notes, Shopping");
  expect(w.open).toHaveBeenCalledWith({
    computerId: w.app.machineId,
    kind: "window",
    windowId: chosenWindow,
  });
  const tab = await openedTab(w.open);
  expect(state.goBack.mock.invocationCallOrder[0]).toBeLessThan(
    state.dispatch.mock.invocationCallOrder[0]!,
  );
  expect(state.dispatch.mock.calls).toEqual([
    [
      {
        type: "PUSH",
        payload: {
          name: "WorkspaceBrowser",
          params: { deploymentId: "deployment", tabId: tab.tabId },
        },
      },
    ],
  ]);
});
it("offers several windows through NativeMenu and opens exactly the one picked", async () => {
  const w = await setup();
  w.list.mockResolvedValue([w.app]);
  w.windows.mockResolvedValue([
    windowInfo(otherWindow, "First"),
    windowInfo(chosenWindow, "Chosen"),
  ]);
  await w.render();
  // The native menu adds no layout of its own, so the row inside it lays out its line.
  expect(container.querySelector('[data-native-menu] > [data-row="true"]')).not.toBeNull();
  await press("Chosen");
  expect(w.open.mock.calls).toEqual([
    [{ computerId: w.app.machineId, kind: "window", windowId: chosenWindow }],
  ]);
});
it("opens through the app's bundle when its windows are unknown", async () => {
  const w = await setup();
  w.windows.mockRejectedValue(new Error("computer-view-unsupported"));
  await w.render();
  await press("Notes");
  expect(w.open).toHaveBeenCalledWith({
    bundleId: "com.apple.Notes",
    computerId: w.app.machineId,
    kind: "window",
  });
});
it.each(["computer-view-limit", "locked-screen"])(
  "shows human words for Host refusal %s",
  async (reason) => {
    const w = await setup();
    w.open.mockRejectedValue(
      new HostClientRequestError({
        code: "conflict",
        message: "technical error",
        reason,
        status: 409,
      }),
    );
    await w.render();
    await press("Notes, No windows open");
    expect(container.textContent).toContain(
      computerReasonWords(reason, {
        machine: w.snapshot.machines.find((m) => m.id === w.app.machineId)!.name,
        phone: false,
        target: "Notes",
      }),
    );
  },
);
it("retries the approved list and shows its empty state", async () => {
  const w = await setup();
  w.list.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue([]);
  await w.render();
  await press("Try again");
  expect(w.list).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("No apps to open yet");
});
it.each(["unmount", "blur"])(
  "navigates nobody when the tab opens after the person left (%s)",
  async (leave) => {
    const w = await setup();
    let finish!: () => void;
    const opened = new Promise<void>((resolve) => (finish = resolve));
    w.open.mockImplementationOnce(async (target) => {
      await opened;
      return w.openTab(target);
    });
    await w.render();
    await press("Notes, No windows open");
    if (leave === "unmount") {
      await act(async () => root!.unmount());
      root = null;
    } else state.focused = false;
    await act(async () => finish());
    await openedTab(w.open);
    expect(state.goBack).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  },
);
it("marks an app that already has a window tab as open", async () => {
  const w = await setup();
  await w.openTab({
    bundleId: "com.apple.Notes",
    computerId: RunnerIdSchema.parse(w.app.machineId),
    kind: "window",
  });
  await w.render();
  expect(button("Notes, Open")).toBeDefined();
  expect(button("Calendar, No windows open")).toBeDefined();
});
