// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { VoiceContext } from "@opensteer/client/react";
import { idleVoiceSnapshot, type VoiceControls, type VoiceSnapshot } from "@opensteer/client/voice";
import { Alert } from "react-native";

// What could break: a Project's task listed again under Main, a folded
// folder hiding that something needs the reader, "new task here" starting it
// in Main, or the folder and its + going nowhere.

const harness = vi.hoisted(() => ({ client: null as HostClient | null }));
vi.mock(
  "react-native",
  async () => (await import("../../test-support/settings-screens.js")).reactNative,
);
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div> },
}));
vi.mock("../ui/motion.js", () => ({ move: undefined }));
vi.mock("./saved-tasks.js", () => ({ SavedTasks: () => null }));
vi.mock("@opensteer/client/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opensteer/client/react")>()),
  usePlaceList: () => [],
}));
vi.mock("../browser/acting-dot.js", () => ({ ActingDot: () => null, agentWorkingLabel: "" }));
vi.mock("../browser/site-label.js", () => ({ tabSiteLabel: () => null }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../screens/deployment-row.js", () => ({
  deploymentTone: () => "ember",
  statusTone: () => "green",
}));
vi.mock("../threads/deployment-mark.js", () => ({ DeploymentMarkView: () => null }));
vi.mock("../threads/task-row.js", () => ({
  NeedsYouTag: () => <em>Needs you</em>,
  setTaskDone: () => undefined,
  taskTextInset: 48,
  TaskRowView: (props: {
    readonly onOpen: (threadId: string) => void;
    readonly row: { readonly threadId: string; readonly title: string };
  }) => <button onClick={() => props.onOpen(props.row.threadId)}>{props.row.title}</button>,
  UnreadDot: () => <i>unread</i>,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({
    doneShelf: { read: async () => false, write: async () => undefined },
    getSnapshot: () => ({ rows: [] }),
    subscribe: () => () => undefined,
  }),
  useMobileState: () => ({
    rows: [{ deploymentId: "deployment-a", name: "Mac", signIn: null, status: "connected" }],
    selection: { deploymentId: "deployment-a", hostClient: harness.client },
  }),
  useSavedSurface: () => ({ source: "live" }),
}));
vi.mock("../ui/chat-orb.js", () => ({ ChatOrb: () => null }));
vi.mock("../ui/pane.js", () => ({
  useContentInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/retained-scroll.js", () => ({ useRetainedScroll: () => ({ ref: null }) }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  StatusDot: () => null,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/workspace-mark.js", () => ({ WorkspaceMark: () => null }));

const { SidebarPanel } = await import("./sidebar-panel.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  harness.client = null;
});

function voice(patch: Partial<VoiceSnapshot>, openThread: VoiceControls["openThread"]) {
  const snapshot = { ...idleVoiceSnapshot, ...patch };
  return {
    dismissNotice: vi.fn(),
    getSnapshot: () => snapshot,
    openThread: vi.fn(openThread),
    setMuted: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    subscribe: () => () => undefined,
    subscribeLevel: () => () => undefined,
  };
}

async function mount(controller: VoiceControls | null = null) {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  clients.push(host);
  await host.load();
  harness.client = host;
  const actions = {
    close: vi.fn(),
    onChat: vi.fn(),
    onNewProject: vi.fn(),
    onNewTask: vi.fn(),
    onOpenPlace: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenTask: vi.fn(),
    onProjects: vi.fn(),
    onSchedules: vi.fn(),
    onSearch: vi.fn(),
    onSettings: vi.fn(),
    onTabs: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <VoiceContext value={controller}>
        <SidebarPanel
          actions={actions}
          deploymentId="deployment-a"
          destination="Home"
          docked
          openProjectId={null}
          openThreadId={null}
          scroll={{ offset: 0 }}
          selectedThreadId={null}
          shelves={{ closedProjects: new Set(), list: null }}
          visible
        />
      </VoiceContext>,
    ),
  );
  const launch = host.getSnapshot().workspaces.find(({ name }) => name === "Customer launch")!;
  return { actions, container, launch };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

describe("the sidebar's Project folders", () => {
  it("lists a Project's work in its folder, not under Main, and keeps its ask when folded", async () => {
    const { container } = await mount();
    const titled = (title: string) =>
      [...container.querySelectorAll("button")].filter((node) => node.textContent === title);
    expect(titled("Prepare the product launch")).toHaveLength(1);
    const folder = button(container, "Customer launch, 1 task needs you");
    // Open, the row says it; the folder does not say it twice.
    expect(folder.textContent).not.toContain("Needs you");

    await act(async () => button(container, "Fold Customer launch").click());
    expect(titled("Prepare the product launch")).toHaveLength(0);
    expect(button(container, "Customer launch, 1 task needs you").textContent).toContain(
      "Needs you",
    );
    await act(async () => button(container, "Unfold Customer launch, 1 hidden").click());
    expect(titled("Prepare the product launch")).toHaveLength(1);
  });

  it("starts a task in the Project, opens it, and makes a new one", async () => {
    const { actions, container, launch } = await mount();
    await act(async () => button(container, "New task in Customer launch").click());
    expect(actions.onNewTask).toHaveBeenCalledWith("deployment-a", launch.id);
    await act(async () => button(container, "Customer launch, 1 task needs you").click());
    expect(actions.onOpenProject).toHaveBeenCalledWith("deployment-a", launch.id);
    await act(async () => button(container, "New project").click());
    expect(actions.onNewProject).toHaveBeenCalledWith("deployment-a");
  });
});

describe("the sidebar's Voice row", () => {
  const rowLabels = (container: HTMLElement) =>
    [...container.querySelectorAll("button")].map(
      (node) => node.getAttribute("aria-label") ?? node.textContent,
    );

  it("stands under Chat only while voice can run", async () => {
    const off = await mount(voice({}, async () => null));
    expect(rowLabels(off.container)).not.toContain("Voice");
    const on = await mount(voice({ available: true }, async () => null));
    const labels = rowLabels(on.container);
    expect(labels[labels.indexOf("Voice") - 1]).toMatch(/^Chat/u);
    const live = await mount(voice({ phase: "listening" }, async () => null));
    expect(rowLabels(live.container)).toContain("Voice, on a call");
  });

  it("opens the Thread once it exists, however many taps it took", async () => {
    let created: (threadId: string) => void = () => undefined;
    const controller = voice(
      { available: true },
      () => new Promise((resolve) => (created = resolve)),
    );
    const { actions, container } = await mount(controller);
    await act(async () => button(container, "Voice").click());
    await act(async () => button(container, "Voice").click());
    expect(controller.openThread).toHaveBeenCalledOnce();
    expect(actions.onOpenTask).not.toHaveBeenCalled();
    await act(async () => created("thr_voice"));
    expect(actions.onOpenTask).toHaveBeenCalledExactlyOnceWith("deployment-a", "thr_voice");
  });

  it("says so when the Thread cannot be opened, and can be tried again", async () => {
    const alert = vi.spyOn(Alert, "alert");
    const controller = voice({ available: true }, async () => null);
    const { actions, container } = await mount(controller);
    await act(async () => button(container, "Voice").click());
    expect(actions.onOpenTask).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledOnce();
    await act(async () => button(container, "Voice").click());
    expect(controller.openThread).toHaveBeenCalledTimes(2);
  });

  it("keeps the call's time on the row", async () => {
    const since = Date.now() - 65_000;
    const { container } = await mount(voice({ phase: "listening", since }, async () => null));
    expect(button(container, "Voice, on a call").textContent).toContain("1:05");
  });
});
