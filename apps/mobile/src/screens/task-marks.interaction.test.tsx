// @vitest-environment happy-dom

import { act, useEffect, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  unwrapRpcResult,
  type AssignmentEntry,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { AssignmentSummarySchema, createId, type AssignmentSummary } from "@opensteer/core";
import { rpcSuccess } from "@opensteer/protocol";
import type { ThreadHeaderState } from "../thread/thread-pane.js";

// Failure journeys: a closed picker is released before native dismissal or
// focuses a missing opener; connection health loses to assignment state;
// an unloaded specialist is called Opensteer; a member is offered owner edits,
// or a refused edit/focus return keeps stale permission.
const harness = vi.hoisted(() => ({
  client: null as HostClient | null,
  dismiss: null as (() => void) | null,
  focus: vi.fn<(handle: number) => void>(),
  handles: new Map<number, HTMLElement>(),
  focusEffects: new Map<() => void | (() => void), (() => void) | undefined>(),
  foreground: new Set<(state: string) => void>(),
  platform: "ios",
  setOptions: vi.fn(),
}));
vi.mock("react-native", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  type Children = { readonly children?: ReactNode };
  return {
    AccessibilityInfo: { setAccessibilityFocus: harness.focus, announceForAccessibility: vi.fn() },
    ActivityIndicator: () => null,
    Alert: { alert: vi.fn() },
    AppState: {
      currentState: "active",
      addEventListener: (_event: string, listener: (state: string) => void) => {
        harness.foreground.add(listener);
        return { remove: () => harness.foreground.delete(listener) };
      },
    },
    findNodeHandle: (node: HTMLElement | null) => {
      if (!node?.isConnected) return null;
      const handle = harness.handles.size + 1;
      harness.handles.set(handle, node);
      return handle;
    },
    FlatList: (props: {
      readonly data: readonly unknown[];
      readonly renderItem: (entry: { item: unknown }) => ReactNode;
    }) => (
      <div>
        {props.data.map((item, index) => (
          <div key={index}>{props.renderItem({ item })}</div>
        ))}
      </div>
    ),
    KeyboardAvoidingView: ({ children }: Children) => <div>{children}</div>,
    Modal: (props: Children & { readonly visible?: boolean; readonly onDismiss?: () => void }) => {
      React.useEffect(() => {
        harness.dismiss = props.visible === false ? () => props.onDismiss?.() : null;
        return () => {
          harness.dismiss = null;
        };
      }, [props.visible, props.onDismiss]);
      return <div data-modal-visible={props.visible !== false}>{props.children}</div>;
    },
    Platform: {
      get OS() {
        return harness.platform;
      },
      select: (choices: { ios?: unknown }) => choices.ios,
    },
    Pressable: (
      props: Children & {
        readonly ref?: Ref<HTMLButtonElement>;
        readonly accessibilityLabel?: string;
        readonly disabled?: boolean;
        readonly onPress?: () => void;
      },
    ) => (
      <button
        ref={props.ref}
        aria-label={props.accessibilityLabel}
        disabled={props.disabled}
        onClick={props.onPress}
      >
        {props.children}
      </button>
    ),
    StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
    Text: ({ children }: Children) => <span>{children}</span>,
    View: (
      props: Children & {
        readonly ref?: Ref<HTMLDivElement>;
        readonly accessibilityLabel?: string;
      },
    ) => (
      <div ref={props.ref} aria-label={props.accessibilityLabel}>
        {props.children}
      </div>
    ),
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div> },
  LayoutAnimationConfig: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: {},
  useFocusEffect: (effect: () => void | (() => void)) =>
    useEffect(() => {
      harness.focusEffects.set(effect, effect() ?? undefined);
      return () => {
        harness.focusEffects.get(effect)?.();
        harness.focusEffects.delete(effect);
      };
    }, [effect]),
  useNavigation: () => ({ setOptions: harness.setOptions, navigate: vi.fn() }),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: {
    readonly children?: ReactNode;
    readonly actions: readonly { id: string; title: string }[];
    readonly onPressAction?: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          onClick={() => props.onPressAction?.({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useHostUserId: () => harness.client?.getSnapshot().user?.id,
}));
vi.mock("./deployment-gate.js", () => ({
  useAttachedHost: () => harness.client,
  DeploymentGate: () => null,
}));
vi.mock("../threads/tasks-pane.js", () => ({
  TasksPane: ({ header }: { readonly header: ReactNode }) => <>{header}</>,
}));
vi.mock("../thread/thread-pane.js", () => ({ sameThreadHeader: () => false }));
vi.mock("../navigation-header.js", () => ({
  browserHeaderActions: () => ({}),
  useSidebarToggle: () => undefined,
}));
vi.mock("../ui/glass.js", () => ({ useLiquidGlass: () => false }));
vi.mock("../ui/motion.js", () => ({ appear: undefined }));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/action-review.js", () => ({ ActionReviewSheet: () => null }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  Field: () => null,
  Notice: () => null,
  PrimaryButton: ({ label }: { readonly label: string }) => <button>{label}</button>,
  SecondaryButton: ({
    label,
    onPress,
  }: {
    readonly label: string;
    readonly onPress: () => void;
  }) => <button onClick={onPress}>{label}</button>,
  StatusDot: () => null,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/chat-orb.js", () => ({ ChatOrb: () => <i data-chat-orb /> }));
vi.mock("../ui/workspace-mark.js", () => ({
  WorkspaceMark: (props: {
    readonly name: string;
    readonly color: string | null;
    readonly icon: string | null;
  }) => <i data-workspace={props.name} data-color={props.color} data-icon={props.icon} />,
  WorkspaceIconGlyph: () => null,
}));
vi.mock("../ui/task-mark.js", () => ({
  TaskMark: ({ mark }: { readonly mark: { icon: string; color: string | null } }) => (
    <i data-task-icon={mark.icon} data-task-color={mark.color} />
  ),
}));

const { SpecialistScreen } = await import("./specialist.js");
const { useThreadHeader } = await import("./thread-header.js");
const { AssignmentCard, TaskScopeContext } = await import("../thread/assignment-card.js");
const { TaskMenu } = await import("../thread/task-status.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  harness.client = null;
  harness.dismiss = null;
  harness.focus.mockReset();
  harness.handles.clear();
  harness.focusEffects.clear();
  harness.foreground.clear();
  harness.setOptions.mockReset();
  harness.platform = "ios";
  vi.unstubAllGlobals();
});
function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function press(container: HTMLElement, label: string) {
  const target = [...container.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  );
  if (!target) throw new Error(`No control named ${label}`);
  await act(async () => target.click());
  await settle();
}
async function client() {
  const result = new MockHostClient({ latencyMs: 0, automations: "absent" });
  clients.push(result);
  await result.load();
  harness.client = result;
  return result;
}
function hold(snapshot: HostSnapshot) {
  let current = snapshot;
  const listeners = new Set<() => void>();
  return {
    client: {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      observeThread: () => () => undefined,
    } as unknown as HostClient,
    move(next: HostSnapshot) {
      act(() => {
        current = next;
        listeners.forEach((listener) => listener());
      });
    },
  };
}
async function specialist(role: "owner" | "member", state: "active" | "revoked" = "active") {
  const host = await client();
  const workspace = host.getSnapshot().workspaces.find(({ kind }) => kind === "specialized")!;
  const rpc = host.rpc;
  const read = rpc["workspace.members.list"].bind(rpc);
  let membership = { role, state };
  const members = vi.fn(async (input: Parameters<typeof read>[0]) => {
    const result = unwrapRpcResult(await read(input));
    return rpcSuccess({
      members: result.members.map((member) =>
        member.userId === host.getSnapshot().user?.id ? { ...member, ...membership } : member,
      ),
    });
  });
  Object.defineProperty(host, "rpc", {
    value: new Proxy(rpc, {
      get: (target, name) =>
        name === "workspace.members.list" ? members : Reflect.get(target, name),
    }),
  });
  const container = render(
    <SpecialistScreen
      route={{ params: { deploymentId: "deployment", workspaceId: workspace.id } }}
    />,
  );
  await settle();
  return {
    host,
    workspace,
    container,
    members,
    setMembership: (role: "owner" | "member") => {
      membership = { role, state: "active" };
    },
  };
}

describe("mobile task mark review journeys", () => {
  it.each(["member", "owner"] as const)(
    "only gives an active owner the appearance editor (%s)",
    async (role) => {
      const { container, members, workspace } = await specialist(role);
      expect(members).toHaveBeenCalledWith({ workspaceId: workspace.id });
      expect(container.querySelector("[data-workspace]")).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Change specialist icon and colour"]') !== null,
      ).toBe(role === "owner");
    },
  );

  it("does not give an inactive owner the editor", async () => {
    const { container } = await specialist("owner", "revoked");
    expect(container.querySelector('[aria-label="Change specialist icon and colour"]')).toBeNull();
  });

  it("rereads ownership on screen focus and foreground return", async () => {
    const fixture = await specialist("owner");
    fixture.setMembership("member");
    await act(async () => {
      harness.focusEffects.forEach((cleanup, effect) => {
        cleanup?.();
        harness.focusEffects.set(effect, effect() ?? undefined);
      });
    });
    await settle();
    expect(
      fixture.container.querySelector('[aria-label="Change specialist icon and colour"]'),
    ).toBeNull();
    fixture.setMembership("owner");
    await act(async () => {
      harness.foreground.forEach((listener) => listener("active"));
    });
    await settle();
    expect(
      fixture.container.querySelector('[aria-label="Change specialist icon and colour"]'),
    ).not.toBeNull();
  });

  it("retains a specialist Modal until dismissal, then focuses its actual opener", async () => {
    const { container } = await specialist("owner");
    const opener = container.querySelector('[aria-label="Change specialist icon and colour"]');
    await press(container, "Change specialist icon and colour");
    harness.focus.mockImplementation(() => {
      expect(container.querySelector('[data-modal-visible="false"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-modal-visible="true"]')).not.toBeNull();
    await press(container, "Close");
    expect(container.querySelector('[data-modal-visible="false"]')).not.toBeNull();
    expect(harness.focus).not.toHaveBeenCalled();
    expect(harness.dismiss).not.toBeNull();
    act(() => harness.dismiss?.());
    expect(harness.focus).toHaveBeenCalledOnce();
    expect(harness.handles.get(harness.focus.mock.calls[0]![0])).toBe(opener);
    expect(container.querySelector("[data-modal-visible]")).toBeNull();
  });

  it("rechecks after refusal and dismisses a revoked owner's editor", async () => {
    const { host, container, setMembership, members } = await specialist("owner");
    await press(container, "Change specialist icon and colour");
    setMembership("member");
    vi.spyOn(host, "dispatch").mockRejectedValueOnce(new Error("Owner required"));
    await press(container, "Magenta");
    expect(members.mock.calls.length).toBeGreaterThan(1);
    expect(container.querySelector('[aria-label="Change specialist icon and colour"]')).toBeNull();
    expect(container.querySelector('[data-modal-visible="false"]')).not.toBeNull();
    act(() => harness.dismiss?.());
    expect(container.querySelector("[data-modal-visible]")).toBeNull();
  });

  it.each(["task", "specialist"] as const)(
    "schedules Android focus after hiding the %s picker",
    async (kind) => {
      harness.platform = "android";
      let frame: FrameRequestCallback | null = null;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      let container: HTMLElement;
      if (kind === "specialist") container = (await specialist("owner")).container;
      else {
        const host = await client();
        const thread = host.getSnapshot().threads.find(({ role }) => role === "work")!;
        container = render(
          <TaskMenu
            hostClient={host}
            maxWidth={260}
            onOpenThread={() => undefined}
            task={null}
            threadId={thread.id}
            title={thread.title}
          >
            Task
          </TaskMenu>,
        );
      }
      const opener = container.querySelector(
        kind === "task"
          ? '[aria-label$="Task actions"]'
          : '[aria-label="Change specialist icon and colour"]',
      );
      await press(
        container,
        kind === "task" ? "Change icon…" : "Change specialist icon and colour",
      );
      await press(container, "Close");
      expect(container.querySelector('[data-modal-visible="false"]')).not.toBeNull();
      expect(harness.focus).not.toHaveBeenCalled();
      expect(frame).not.toBeNull();
      act(() => {
        (frame as FrameRequestCallback | null)?.(0);
      });
      expect(harness.focus).toHaveBeenCalledOnce();
      expect(harness.handles.get(harness.focus.mock.calls[0]![0])).toBe(opener);
      expect(container.querySelector("[data-modal-visible]")).toBeNull();
    },
  );

  it.each([null, "Reconnecting", "Offline"] as const)(
    "announces connection-first header state %s with and without an assignment",
    async (connectionLabel) => {
      const host = await client();
      const thread = host.getSnapshot().threads.find(({ role }) => role === "work")!;
      const retry = vi.spyOn(host, "refresh").mockResolvedValue(undefined);
      for (const assigned of [false, true]) {
        const header: ThreadHeaderState = {
          canRetry: connectionLabel !== null,
          connectionLabel,
          surfaceCount: 0,
          surfacesActing: false,
          task: assigned
            ? {
                announcement: "Working",
                assignmentId: "assignment",
                detail: null,
                moving: true,
                open: true,
                requester: "Chat",
                requesterThreadId: null,
                stopBlocked: null,
                tone: "working",
                word: "Working",
              }
            : null,
          title: "Tokyo flights",
          workspaceId: thread.workspaceId,
          workspaceName: "Travel",
          workspaceColor: "blue",
          workspaceIcon: "luggage",
          icon: "plane",
          color: "teal",
          isHome: false,
        };
        function Header() {
          useThreadHeader({
            deploymentId: "deployment",
            fallbackTitle: "Task",
            header,
            hostClient: host,
            threadId: thread.id,
          });
          return null;
        }
        render(<Header />);
        const options = harness.setOptions.mock.calls.at(-1)?.[0] as {
          headerTitle: () => ReactNode;
        };
        const container = render(options.headerTitle());
        expect(container.textContent).toContain(
          connectionLabel ?? (assigned ? "Working" : "Travel"),
        );
        const label = container
          .querySelector('[aria-label$="Task actions"]')
          ?.getAttribute("aria-label");
        expect(label).toBe(
          `Tokyo flights, Travel${connectionLabel !== null ? `, ${connectionLabel}` : assigned ? ", Working" : ""}. Task actions`,
        );
        if (connectionLabel !== null) {
          const before = retry.mock.calls.length;
          await press(container, "Retry");
          expect(retry).toHaveBeenCalledTimes(before + 1);
        } else expect(container.querySelector('[aria-label="Retry"]')).toBeNull();
      }
    },
  );

  // Ways the header hierarchy can fail: a finished task with a menu still spends
  // a second bar line repeating the menu's state; dropping that line also
  // drops the state from what VoiceOver reads; a state that still asks for the
  // reader (working, waiting, failed, stopped) or a lost connection disappears
  // with it; the specialist's name or the task menu goes too.
  it.each([
    ["completed", "Completed", null, false],
    ["completed", "Completed", "Travel", false],
    ["completed", "Completed", null, true],
    ["failed", "Failed", null, false],
    ["stopped", "Stopped", null, false],
    ["waiting", "Needs you", null, false],
    ["working", "Working", null, false],
  ] as const)(
    "keeps a %s task's menu state accessible while compacting only Completed (%s, specialist %s, offline %s)",
    async (tone, word, workspaceName, offline) => {
      const host = await client();
      const thread = host.getSnapshot().threads.find(({ role }) => role === "work")!;
      const header: ThreadHeaderState = {
        canRetry: offline,
        connectionLabel: offline ? "Offline" : null,
        surfaceCount: 0,
        surfacesActing: false,
        task: {
          announcement: word,
          assignmentId: "assignment",
          detail: null,
          moving: tone === "working",
          open: tone === "working" || tone === "waiting",
          requester: "Chat",
          requesterThreadId: null,
          stopBlocked: null,
          tone,
          word,
        },
        title: "Tokyo flights",
        workspaceId: thread.workspaceId,
        workspaceName,
        workspaceColor: "blue",
        workspaceIcon: "luggage",
        icon: "plane",
        color: "teal",
        isHome: false,
      };
      function Header() {
        useThreadHeader({
          deploymentId: "deployment",
          fallbackTitle: "Task",
          header,
          hostClient: host,
          threadId: thread.id,
        });
        return null;
      }
      render(<Header />);
      const options = harness.setOptions.mock.calls.at(-1)?.[0] as {
        headerTitle: () => ReactNode;
      };
      const container = render(options.headerTitle());
      const bar = container.textContent ?? "";
      expect(bar).toContain("Tokyo flights");
      if (offline) expect(bar).toContain("Offline");
      if (workspaceName !== null) expect(bar).toContain(workspaceName);
      if (tone === "completed") expect(bar).not.toContain(word);
      else expect(bar).toContain(word);
      expect(
        container.querySelector('[aria-label$="Task actions"]')?.getAttribute("aria-label"),
      ).toBe(
        `Tokyo flights${workspaceName === null ? "" : `, ${workspaceName}`}, ${offline ? "Offline" : word}. Task actions`,
      );
      if (offline) {
        const retry = vi.spyOn(host, "refresh").mockResolvedValue(undefined);
        await press(container, "Retry");
        expect(retry).toHaveBeenCalledOnce();
      }
    },
  );

  it("keeps a Travel tile/name beside the task mark and updates only owner colour", async () => {
    const host = await client();
    const snapshot = host.getSnapshot();
    const workspace = {
      ...snapshot.workspaces.find(({ kind }) => kind === "specialized")!,
      name: "Travel",
      icon: "luggage" as const,
      color: "blue" as const,
    };
    const thread = {
      ...snapshot.threads.find(({ role }) => role === "work")!,
      workspaceId: workspace.id,
      title: "Tokyo flights",
      icon: "plane" as const,
      color: "teal" as const,
    };
    const assignment = assignmentFor(snapshot, thread);
    const state = hold({ ...snapshot, workspaces: [workspace], threads: [thread] });
    const open = vi.fn();
    const container = render(
      <TaskScopeContext
        value={{ hostClient: state.client, onViewWork: open, dockedRequestId: null }}
      >
        <AssignmentCard entry={entryFor(assignment)} />
      </TaskScopeContext>,
    );
    expect(container.querySelector('[data-workspace="Travel"]')?.getAttribute("data-color")).toBe(
      "blue",
    );
    expect(container.textContent).toContain("Travel");
    expect(container.querySelector('[aria-label^="Tokyo flights, Travel,"]')).not.toBeNull();
    state.move({
      ...snapshot,
      workspaces: [{ ...workspace, color: "magenta" }],
      threads: [thread],
    });
    expect(container.querySelector('[data-workspace="Travel"]')?.getAttribute("data-color")).toBe(
      "magenta",
    );
    expect(
      container.querySelector('[data-task-icon="plane"]')?.getAttribute("data-task-color"),
    ).toBe("teal");
    await press(
      container,
      container.querySelector("button[aria-label]")!.getAttribute("aria-label")!,
    );
    expect(open).toHaveBeenCalledWith(thread.id);
  });

  it("does not call an unloaded completed specialist Opensteer and resolves attribution when loaded", async () => {
    const host = await client();
    const snapshot = host.getSnapshot();
    const workspace = {
      ...snapshot.workspaces.find(({ kind }) => kind === "specialized")!,
      name: "Travel",
    };
    const thread = {
      ...snapshot.threads.find(({ role }) => role === "work")!,
      workspaceId: workspace.id,
      icon: "plane" as const,
      color: "teal" as const,
    };
    const assignment = {
      ...assignmentFor(snapshot, thread),
      status: "completed" as const,
      finishedAt: "2026-10-25T10:05:00Z",
      returnStatus: "delivered" as const,
    };
    const state = hold({ ...snapshot, workspaces: [], threads: [] });
    const container = render(
      <TaskScopeContext
        value={{ hostClient: state.client, onViewWork: () => undefined, dockedRequestId: null }}
      >
        <AssignmentCard entry={entryFor(assignment)} />
      </TaskScopeContext>,
    );
    expect(container.textContent).not.toContain("Opensteer");
    expect(container.querySelector("[data-chat-orb]")).toBeNull();
    expect(container.querySelector("[data-workspace]")).toBeNull();
    expect(container.querySelector('[data-task-icon="plane"]')).not.toBeNull();
    state.move({ ...snapshot, workspaces: [workspace], threads: [] });
    expect(container.querySelector('[data-workspace="Travel"]')).not.toBeNull();
    expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toContain("Travel");
  });

  it("uses the orb and Opensteer name only for a known Main assignment", async () => {
    const host = await client();
    const snapshot = host.getSnapshot();
    const thread = snapshot.threads.find(({ id }) => id === snapshot.homeThreadId)!;
    const assignment = assignmentFor(snapshot, thread);
    const container = render(
      <TaskScopeContext
        value={{ hostClient: host, onViewWork: () => undefined, dockedRequestId: null }}
      >
        <AssignmentCard entry={entryFor(assignment)} />
      </TaskScopeContext>,
    );
    expect(container.querySelector("[data-chat-orb]")).not.toBeNull();
    expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toContain(
      "Opensteer",
    );
  });
});

function assignmentFor(
  snapshot: HostSnapshot,
  thread: HostSnapshot["threads"][number],
): AssignmentSummary {
  return AssignmentSummarySchema.parse({
    createdAt: "2026-10-25T10:00:00Z",
    updatedAt: "2026-10-25T10:00:00Z",
    currentRunId: null,
    currentRunStatus: null,
    finishedAt: null,
    id: createId("delegation"),
    initialRunId: createId("run"),
    modelLabel: null,
    objectivePreview: "Plan trip",
    origin: "run",
    parentThreadId: snapshot.homeThreadId!,
    resultPreview: null,
    returnStatus: "pending",
    revision: 1,
    status: "open",
    workerThread: {
      id: thread.id,
      environmentId: thread.environmentId,
      workspaceId: thread.workspaceId,
      status: thread.status,
      pendingRequests: 0,
      title: thread.title,
      icon: thread.icon,
      color: thread.color ?? undefined,
    },
  });
}
function entryFor(assignment: AssignmentSummary): AssignmentEntry {
  return {
    assignment,
    createdAt: assignment.createdAt,
    id: `assignment:${assignment.id}`,
    kind: "assignment",
    runId: null,
  };
}
