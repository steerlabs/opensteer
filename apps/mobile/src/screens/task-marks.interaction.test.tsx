// @vitest-environment happy-dom

import { act, useEffect, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import type { ThreadHeaderState } from "../thread/thread-pane.js";

// Failure journeys: a closed picker is released before native dismissal or
// focuses a missing opener; connection health loses to assignment state.
const harness = vi.hoisted(() => ({
  liquidGlass: false,
  client: null as HostClient | null,
  dismiss: null as (() => void) | null,
  focus: vi.fn<(handle: number) => void>(),
  handles: new Map<number, HTMLElement>(),
  focusEffects: new Map<() => void | (() => void), (() => void) | undefined>(),
  foreground: new Set<(state: string) => void>(),
  platform: "ios",
  setOptions: vi.fn(),
}));
vi.mock("../thread/settings/engine-mark.js", () => ({ EngineMark: () => null }));
vi.mock("../voice/cursor-mark.js", () => ({ PillMic: () => null, VoiceCursor: () => null }));
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
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: {
    readonly children?: ReactNode;
    readonly actions: readonly {
      id: string;
      subactions?: readonly { id: string; title: string }[];
      title: string;
    }[];
    readonly onPressAction?: (event: { nativeEvent: { event: string } }) => void;
    readonly title?: string;
  }) => (
    <div data-menu-heading={props.title}>
      {props.children}
      {props.actions
        .flatMap((action) => action.subactions ?? [action])
        .map((action) => (
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
vi.mock("../thread/folded-page.js", () => ({ FoldedPage: () => null, foldedPageWidth: 46 }));
vi.mock("../navigation-header.js", () => ({
  browserHeaderActions: () => ({}),
  headerActions: () => ({}),
}));
vi.mock("../ui/bar-title.js", () => ({
  barGlassInset: 8,
  barItemWidth: 44,
  barNameFloor: 64,
  barTitleWidth: () => 260,
  barYield: () => 0,
  useBarTitleRoom: () => 300,
  useBarTitleWidth: () => 260,
}));
vi.mock("../ui/glass.js", () => ({
  GlassSurface: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  useLiquidGlass: () => harness.liquidGlass,
}));
vi.mock("../ui/motion.js", () => ({ appear: undefined }));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/action-review.js", () => ({ ActionReviewSheet: () => null }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  monoFontFamily: "monospace",
  Field: () => null,
  Notice: ({ title, detail }: { readonly title: string; readonly detail: string }) => (
    <div>
      {title}
      {detail}
    </div>
  ),
  PrimaryButton: ({ label }: { readonly label: string }) => <button>{label}</button>,
  SecondaryButton: ({
    label,
    onPress,
  }: {
    readonly label: string;
    readonly onPress: () => void;
  }) => <button onClick={onPress}>{label}</button>,
  StatusDot: () => null,
  CodeBlock: ({ label, text }: { readonly label?: string; readonly text: string }) => (
    <pre aria-label={label}>{text}</pre>
  ),
}));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../team/team-marks.js", async (load) => ({
  ...(await load<typeof import("../team/team-marks.js")>()),
  AgentOrb: () => <i data-chat-orb />,
}));
vi.mock("../ui/icon-glyph.js", () => ({ IconGlyph: () => null }));
vi.mock("../ui/task-mark.js", () => ({
  TaskMark: ({ mark }: { readonly mark: { icon: string; color: string | null } }) => (
    <i data-task-icon={mark.icon} data-task-color={mark.color} />
  ),
}));

const { useThreadHeader } = await import("./thread-header.js");
const { ThreadMenu } = await import("../thread/thread-menu.js");
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
describe("mobile task mark review journeys", () => {
  it("schedules Android focus after hiding the task picker", async () => {
    harness.platform = "android";
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const host = await client();
    const thread = host.getSnapshot().threads.find(({ purpose }) => purpose === "task")!;
    const container = render(
      <ThreadMenu
        deploymentId="deployment-1"
        hostClient={host}
        maxWidth={260}
        onFind={() => undefined}
        onOpenThread={() => undefined}
        task={null}
        threadId={thread.id}
        title={thread.title}
      >
        Task
      </ThreadMenu>,
    );
    const opener = container.querySelector('[aria-label$="Actions"]');
    await press(container, "Change icon…");
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
  });

  it.each([null, "Studio Mac offline"] as const)(
    "announces connection-first header state %s with and without an assignment",
    async (connectionLabel) => {
      const host = await client();
      const thread = host.getSnapshot().threads.find(({ purpose }) => purpose === "task")!;
      for (const assigned of [false, true]) {
        const header: ThreadHeaderState = {
          connectionLabel,
          task: assigned
            ? {
                announcement: "Working",
                assignmentId: "assignment",
                detail: null,
                moving: true,
                open: true,
                requester: "Weekly plan",
                requesterThreadId: null,
                stopBlocked: null,
                tone: "working",
                word: "Working",
              }
            : null,
          title: "Tokyo flights",
          placeName: "Travel",
          placeKind: "folder",
          icon: "plane",
          color: "teal",
          isVoice: false,
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
          .querySelector('[aria-label$="Actions"]')
          ?.getAttribute("aria-label");
        expect(label).toBe(
          `Tokyo flights, Travel${connectionLabel !== null ? `, ${connectionLabel}` : assigned ? ", Working" : ""}. Actions`,
        );
      }
    },
  );

  // Ways the header hierarchy can fail: a finished task with a menu still spends
  // a second bar line repeating the menu's state; dropping that line also
  // drops the state from what VoiceOver reads; a state that still asks for the
  // reader (working, waiting, failed, stopped) or a lost connection disappears
  // with it; the folder's name or the task menu goes too.
  it.each([
    ["completed", "Finished", null, false],
    ["completed", "Finished", "Travel", false],
    ["completed", "Finished", null, true],
    ["failed", "Couldn’t finish", null, false],
    ["stopped", "Stopped", null, false],
    ["waiting", "Needs you", null, false],
    ["working", "Working", null, false],
  ] as const)(
    "keeps a %s task's menu state accessible while compacting only Finished (%s, folder %s, offline %s)",
    async (tone, word, folderName, offline) => {
      const host = await client();
      const thread = host.getSnapshot().threads.find(({ purpose }) => purpose === "task")!;
      const header: ThreadHeaderState = {
        connectionLabel: offline ? "Studio Mac offline" : null,
        task: {
          announcement: word,
          assignmentId: "assignment",
          detail: null,
          moving: tone === "working",
          open: tone === "working" || tone === "waiting",
          requester: "Weekly plan",
          requesterThreadId: null,
          stopBlocked: null,
          tone,
          word,
        },
        title: "Tokyo flights",
        placeName: folderName,
        placeKind: folderName === null ? null : "folder",
        icon: "plane",
        color: "teal",
        isVoice: false,
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
      if (offline) expect(bar).toContain("Studio Mac offline");
      if (folderName !== null) expect(bar).toContain(folderName);
      // The word stands alone on its line; "Mark Done" in the menu is not that line.
      const says = [...container.querySelectorAll("*")].some(
        (node) => node.childElementCount === 0 && node.textContent === word,
      );
      expect(says).toBe(tone !== "completed");
      expect(container.querySelector('[aria-label$="Actions"]')?.getAttribute("aria-label")).toBe(
        `Tokyo flights${folderName === null ? "" : `, ${folderName}`}, ${offline ? "Studio Mac offline" : word}. Actions`,
      );
    },
  );

  // Ways the capsule can lose what the bar said: the word and folder leave the
  // bar and reach neither the menu nor VoiceOver, or an offline computer is
  // dropped with them though nothing there will answer.
  it.each([null, "Studio Mac offline"])(
    "moves a task's word and folder into the menu on Liquid Glass (offline: %s)",
    async (connectionLabel) => {
      harness.liquidGlass = true;
      try {
        const host = await client();
        const thread = host.getSnapshot().threads.find(({ purpose }) => purpose === "task")!;
        const header: ThreadHeaderState = {
          connectionLabel,
          task: {
            announcement: "Needs you",
            assignmentId: "assignment",
            detail: "Waiting for approval",
            moving: false,
            open: true,
            requester: "Weekly plan",
            requesterThreadId: null,
            stopBlocked: null,
            tone: "waiting",
            word: "Needs you",
          },
          title: "Tokyo flights",
          placeName: "Travel",
          placeKind: "folder",
          icon: "plane",
          color: "teal",
          isVoice: false,
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
        const drawn = container.querySelector('[aria-label$="Actions"]');
        expect(drawn?.textContent).toContain("Tokyo flights");
        expect(drawn?.textContent).not.toContain("Needs you");
        expect(drawn?.textContent).not.toContain("Travel");
        expect(drawn?.textContent?.includes("Studio Mac offline")).toBe(connectionLabel !== null);
        expect(drawn?.getAttribute("aria-label")).toBe(
          `Tokyo flights, Travel, ${connectionLabel ?? "Needs you"}. Actions`,
        );
        expect(
          container.querySelector("[data-menu-heading]")?.getAttribute("data-menu-heading"),
        ).toBe("From Weekly plan · Needs you\nTravel\nWaiting for approval");
      } finally {
        harness.liquidGlass = false;
      }
    },
  );
});
