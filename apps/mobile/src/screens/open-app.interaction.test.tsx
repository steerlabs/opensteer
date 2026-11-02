// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HostClientRequestError, type HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { computerReasonWords } from "@opensteer/client/integrations";
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
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
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
const windowInfo = (id: number, title: string) => ({
  id,
  title,
  focused: false,
  main: true,
  minimized: false,
  onScreen: true,
});
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
  const base = host.getSnapshot();
  const snapshot = { ...base, deploymentId: "deployment" };
  vi.spyOn(host, "getSnapshot").mockImplementation(() => snapshot);
  const approved = await host.listApprovedComputerApps();
  const app = approved.find((a) => a.target.kind === "app" && a.name === "Notes")!;
  const list = vi.spyOn(host, "listApprovedComputerApps").mockResolvedValue(approved);
  const windows = vi.spyOn(host, "listComputerAppWindows").mockResolvedValue([]);
  const open = vi.spyOn(host, "openComputerView").mockImplementation(
    async (machineId, target) =>
      ({
        viewId: "opened",
        generation: 2,
        machineId,
        target,
        ...(target.kind === "app" && target.window !== undefined
          ? { window: { id: target.window, title: "Chosen" } }
          : {}),
      }) as Awaited<ReturnType<typeof host.openComputerView>>,
  );
  const close = vi
    .spyOn(host, "closeComputerView")
    .mockResolvedValue({} as Awaited<ReturnType<typeof host.closeComputerView>>);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = () =>
    act(async () =>
      root!.render(<OpenAppScreen route={{ params: { deploymentId: "deployment" } }} />),
    );
  return { host, snapshot, approved, app, list, windows, open, close, render };
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
      ? [windowInfo(42, "Shopping")]
      : app.displayName === "Keynote"
        ? [windowInfo(1, "One"), windowInfo(2, "Two")]
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
it("opens a single window, dismissing the sheet before pushing the exact window route", async () => {
  const w = await setup();
  w.windows.mockResolvedValue([windowInfo(42, "Shopping")]);
  await w.render();
  await press("Notes, Shopping");
  expect(w.open).toHaveBeenCalledWith(w.app.machineId, { ...w.app.target, window: 42 });
  expect(state.goBack.mock.invocationCallOrder[0]).toBeLessThan(
    state.dispatch.mock.invocationCallOrder[0]!,
  );
  expect(state.dispatch).toHaveBeenCalledWith({
    type: "PUSH",
    payload: {
      name: "WorkspaceBrowser",
      params: {
        deploymentId: "deployment",
        scope: "workspace",
        machineId: w.app.machineId,
        appKey: "com.apple.notes",
        viewId: "opened",
        generation: 2,
        windowId: 42,
      },
    },
  });
});
it("offers multiple windows through NativeMenu and opens the chosen one", async () => {
  const w = await setup();
  w.list.mockResolvedValue([w.app]);
  w.windows.mockResolvedValue([windowInfo(1, "First"), windowInfo(42, "Chosen")]);
  await w.render();
  expect(container.querySelector("[data-native-menu]")).not.toBeNull();
  await press("Chosen");
  expect(w.open).toHaveBeenCalledWith(w.app.machineId, { ...w.app.target, window: 42 });
});
it("opens without a window when an older Host refuses enumeration", async () => {
  const w = await setup();
  w.windows.mockRejectedValue(new Error("computer-view-unsupported"));
  await w.render();
  await press("Notes");
  expect(w.open).toHaveBeenCalledWith(w.app.machineId, w.app.target);
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
  "leaves a late owner view to expire, without navigating, after %s",
  async (leave) => {
    const w = await setup();
    let finish!: (view: Awaited<ReturnType<typeof w.host.openComputerView>>) => void;
    w.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await w.render();
    await press("Notes, No windows open");
    if (leave === "unmount") {
      await act(async () => root!.unmount());
      root = null;
    } else state.focused = false;
    await act(async () =>
      finish({
        viewId: "late",
        generation: 3,
        machineId: w.app.machineId,
        target: w.app.target,
      } as Awaited<ReturnType<typeof w.host.openComputerView>>),
    );
    // The Host may have answered with a view another device is watching.
    expect(w.close).not.toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  },
);
it("does not list someone else's approved apps", async () => {
  const w = await setup();
  w.snapshot.machines = w.snapshot.machines.map((m) => ({ ...m, ownership: "other" as const }));
  await w.render();
  expect(container.textContent).toContain("No apps to open yet");
  expect(w.windows).not.toHaveBeenCalled();
});
it("switches to an existing owner view of the exact window without opening again", async () => {
  const w = await setup();
  // Create the real Host projection before replacing its open RPC with the assertion spy.
  w.open.mockRestore();
  vi.mocked(w.host.getSnapshot).mockRestore();
  if (w.app.target.kind !== "app") throw new Error("Missing app fixture");
  w.windows.mockRestore();
  const windows = await w.host.listComputerAppWindows(w.app.machineId, w.app.target.app);
  const chosen = windows[0]!;
  await w.host.openComputerView(w.app.machineId, { ...w.app.target, window: chosen.id });
  const snapshot = { ...w.host.getSnapshot(), deploymentId: "deployment" };
  vi.spyOn(w.host, "getSnapshot").mockReturnValue(snapshot);
  const open = vi.spyOn(w.host, "openComputerView");
  vi.spyOn(w.host, "listComputerAppWindows").mockResolvedValue([chosen]);
  await w.render();
  await press("Notes, Open");
  expect(open).not.toHaveBeenCalled();
  expect(state.dispatch).toHaveBeenCalled();
});
it("asks the Host for the front window when windows are unknown, even with one already open", async () => {
  const w = await setup();
  w.open.mockRestore();
  vi.mocked(w.host.getSnapshot).mockRestore();
  if (w.app.target.kind !== "app") throw new Error("Missing app fixture");
  w.windows.mockRestore();
  const [first] = await w.host.listComputerAppWindows(w.app.machineId, w.app.target.app);
  await w.host.openComputerView(w.app.machineId, { ...w.app.target, window: first!.id });
  const snapshot = { ...w.host.getSnapshot(), deploymentId: "deployment" };
  vi.spyOn(w.host, "getSnapshot").mockReturnValue(snapshot);
  const open = vi.spyOn(w.host, "openComputerView");
  // An older Host can't say which windows are open, so the front one may be another.
  vi.spyOn(w.host, "listComputerAppWindows").mockRejectedValue(new Error("unsupported"));
  await w.render();
  await press("Notes");
  expect(open).toHaveBeenCalledWith(w.app.machineId, w.app.target);
});
