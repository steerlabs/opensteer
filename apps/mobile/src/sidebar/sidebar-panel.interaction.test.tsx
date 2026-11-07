// @vitest-environment happy-dom

import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { VoiceContext } from "@opensteer/client/react";
import { idleVoiceSnapshot, type VoiceControls, type VoiceSnapshot } from "@opensteer/client/voice";
import { Alert } from "react-native";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import {
  createThreadDraftStore,
  newTaskDraftKey,
  type ThreadDraftStore,
} from "../client/thread-drafts.js";

// What could break: a Project's task listed again under Main, a folded
// folder hiding that something needs the reader, "new task here" starting it
// in Main, or the folder and its + going nowhere.

const harness = vi.hoisted(() => ({
  client: null as HostClient | null,
  drafts: null as ThreadDraftStore | null,
  rowDraws: 0,
}));
const removeChatDraftFile = vi.hoisted(() => vi.fn());
vi.mock("../voice/cursor-mark.js", () => ({ PillMic: () => null, VoiceCursor: () => null }));
vi.mock("react-native", async () => {
  const { reactNative } = await import("../../test-support/settings-screens.js");
  const Box = reactNative.View;
  return {
    ...reactNative,
    // A draft's menu wraps it only once the list has said how wide it is.
    View: (props: {
      readonly children?: ReactNode;
      readonly onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    }) => {
      useLayoutEffect(() => props.onLayout?.({ nativeEvent: { layout: { width: 300 } } }), []);
      return <Box {...props} />;
    },
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div> },
}));
vi.mock("../ui/motion.js", () => ({ move: undefined }));
vi.mock("../platform/attachment-draft-files.js", () => ({ removeChatDraftFile }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: {
    readonly actions: readonly { readonly id: string; readonly title: string }[];
    readonly children?: ReactNode;
    readonly onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
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
  DraftPen: () => <b>pen</b>,
  draftPenLabel: "unsent reply",
  NeedsYouTag: () => <em>Needs you</em>,
  setTaskDone: () => undefined,
  taskTextInset: 48,
  TaskRowView: (props: {
    readonly drafted?: boolean;
    readonly onOpen: (threadId: string) => void;
    readonly row: { readonly threadId: string; readonly title: string };
  }) => {
    harness.rowDraws += 1;
    return (
      <button
        data-drafted={props.drafted === true}
        data-thread={props.row.threadId}
        onClick={() => props.onOpen(props.row.threadId)}
      >
        {props.row.title}
      </button>
    );
  },
  UnreadDot: () => <i>unread</i>,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useHostUserId: () => "user-a",
  useMobileClient: () => ({
    quietSeen: { getSnapshot: () => null, see: () => undefined, subscribe: () => () => undefined },
    drafts: harness.drafts,
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

async function mount(
  controller: VoiceControls | null = null,
  shown: {
    readonly destination?: "Home" | null;
    readonly openDraftId?: string;
    readonly seed?: (drafts: ThreadDraftStore, host: MockHostClient) => Promise<void>;
    readonly selectedTitle?: string;
  } = {},
) {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  clients.push(host);
  await host.load();
  harness.client = host;
  harness.drafts = createThreadDraftStore({
    filePath: "/private/drafts.json",
    now: () => new Date(),
    privateFiles: new MemoryPrivateFilesystem(),
  });
  await harness.drafts.load();
  await shown.seed?.(harness.drafts, host);
  const selectedThreadId =
    host.getSnapshot().threads.find(({ title }) => title === shown.selectedTitle)?.id ?? null;
  const actions = {
    close: vi.fn(),
    onChat: vi.fn(),
    onNewProject: vi.fn(),
    onNewTask: vi.fn(),
    onOpenDraft: vi.fn(),
    onOpenPlace: vi.fn(),
    onOpenDone: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenQuietlyMoved: vi.fn(),
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
  const scroll = { offset: 0 };
  const shelves = { closedProjects: new Set<string>(), list: null };
  const draw = (openDraftId: string | null) =>
    act(async () =>
      root.render(
        <VoiceContext value={controller}>
          <SidebarPanel
            actions={actions}
            deploymentId="deployment-a"
            destination={shown.destination === undefined ? "Home" : shown.destination}
            docked
            openDraftId={openDraftId}
            openProjectId={null}
            openThreadId={selectedThreadId}
            scroll={scroll}
            selectedThreadId={selectedThreadId}
            shelves={shelves}
            visible
          />
        </VoiceContext>,
      ),
    );
  await draw(shown.openDraftId ?? null);
  const launch = host.getSnapshot().workspaces.find(({ name }) => name === "Customer launch")!;
  return { actions, container, draw, drafts: harness.drafts, host, launch };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

describe("the sidebar's drafts", () => {
  const scope = ["deployment-a", "user-a"] as const;
  const firstRow = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-thread]")!;

  it("lists waiting drafts, a saved one with no Workspace left included, and opens the one chosen", async () => {
    const { actions, container } = await mount(null, {
      seed: async (drafts) => {
        await drafts.writeDraft(...scope, newTaskDraftKey("wsp_gone"), "Saved before");
        drafts.placeNewTaskDraft(...scope, "draft-new", "workspace-main");
        await drafts.writeDraft(...scope, newTaskDraftKey("draft-new"), "Book a table\nfor two");
        await drafts.writeDraft(...scope, newTaskDraftKey("draft-open"), "In front");
      },
      openDraftId: "draft-open",
    });
    expect(container.textContent).toContain("Drafts");
    expect(container.textContent).not.toContain("In front");
    await act(async () => button(container, "Draft, Book a table").click());
    expect(actions.onOpenDraft).toHaveBeenCalledWith("deployment-a", "workspace-main", "draft-new");
    await act(async () => button(container, "Draft, Saved before").click());
    expect(actions.onOpenDraft).toHaveBeenLastCalledWith("deployment-a", "wsp_gone", "wsp_gone");
  });

  it("holds the row of a draft opened from the list, its title as it was", async () => {
    const { container, draw, drafts } = await mount(null, {
      seed: async (store) => {
        await store.writeDraft(...scope, newTaskDraftKey("draft-a"), "As it was");
      },
    });
    await draw("draft-a");
    await act(() => drafts.writeDraft(...scope, newTaskDraftKey("draft-a"), "Rewritten"));
    expect(button(container, "Draft, As it was")).toBeDefined();
    expect(container.textContent).not.toContain("Rewritten");

    await draw(null);
    expect(button(container, "Draft, Rewritten")).toBeDefined();
  });

  it("draws nothing for a person with no drafts", async () => {
    const { container } = await mount();
    expect(container.textContent).not.toContain("Drafts");
  });

  it("asks before discarding, then forgets the draft, its files and the Host's copies", async () => {
    const attachment = {
      attachmentId: "attachment-1",
      localUri: "file:///photo.draft",
      mediaType: "image/png",
      name: "photo.png",
      sizeBytes: 3,
      status: "ready",
    } as const;
    const { container, drafts, host } = await mount(null, {
      seed: async (store) => {
        await store.writeDraft(...scope, newTaskDraftKey("draft-a"), "Discard me");
        await store.writeDraftAttachments(...scope, newTaskDraftKey("draft-a"), [attachment]);
        await store.writeDraft(...scope, newTaskDraftKey("draft-b"), "Keep me");
      },
    });
    const discarded = vi.spyOn(host, "discardAttachment").mockResolvedValue(undefined as never);
    const confirm = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    removeChatDraftFile.mockClear();
    // Found by its words: two drafts written a millisecond apart swap places.
    const discard = [...container.querySelectorAll("button")].find(
      ({ parentElement, textContent }) =>
        textContent === "Discard" && parentElement?.textContent?.includes("Discard me"),
    );
    await act(async () => discard!.click());
    expect(drafts.readDraft(...scope, newTaskDraftKey("draft-a"))).not.toBeNull();
    expect(removeChatDraftFile).not.toHaveBeenCalled();
    const [title, detail, options] = confirm.mock.calls.at(-1)!;
    expect([title, detail]).toEqual(["Discard draft?", "“Discard me” will be removed."]);
    await act(async () => options!.find(({ text }) => text === "Discard")!.onPress!());
    await vi.waitFor(() => expect(removeChatDraftFile).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(drafts.readDraft(...scope, newTaskDraftKey("draft-a"))).toBeNull();
    expect(drafts.readDraft(...scope, newTaskDraftKey("draft-b"))?.text).toBe("Keep me");
    expect(removeChatDraftFile).toHaveBeenCalledExactlyOnceWith(
      {
        deploymentId: "deployment-a",
        draftId: "draft-a",
        kind: "new-task",
        userId: "user-a",
      },
      "file:///photo.draft",
    );
    expect(discarded).toHaveBeenCalledExactlyOnceWith("attachment-1");
    await vi.waitFor(() => expect(container.textContent).not.toContain("Discard me"), {
      timeout: 2_000,
    });
  });

  it("offers no discard on a message the Host has not answered", async () => {
    const { container } = await mount(null, {
      seed: async (drafts) => {
        const key = newTaskDraftKey("draft-held");
        await drafts.claimPending(...scope, key, {
          idempotencyKey: "message:held",
          text: "Sent, not confirmed",
          threadId: key,
        });
      },
    });
    expect(button(container, "Draft, Sent, not confirmed, not confirmed")).toBeDefined();
    expect(container.textContent).not.toContain("Discard");
  });

  it("takes discard off the open draft's row the moment its message is sent", async () => {
    const key = newTaskDraftKey("draft-a");
    const { container, draw, drafts } = await mount(null, {
      seed: async (store) => {
        await store.writeDraft(...scope, key, "Send me");
      },
    });
    await draw("draft-a");
    await act(() =>
      drafts.claimPending(...scope, key, {
        idempotencyKey: "message:open",
        text: "Send me",
        threadId: key,
      }),
    );
    expect(button(container, "Draft, Send me, not confirmed")).toBeDefined();
    expect(container.textContent).not.toContain("Discard");
  });

  it("pens a Thread with an unsent reply and Chat, but not the Thread open", async () => {
    const seed = async (drafts: ThreadDraftStore, host: MockHostClient) => {
      const { homeThreadId, threads } = host.getSnapshot();
      await drafts.writeDraft(...scope, homeThreadId!, "A reply to Chat");
      for (const { id } of threads) await drafts.writeDraft(...scope, id, "A reply");
    };
    const launch = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLElement>("[data-thread]")].find(
        ({ textContent }) => textContent === "Prepare the product launch",
      )!;
    const away = await mount(null, { destination: null, seed });
    expect(launch(away.container).dataset["drafted"]).toBe("true");
    const chatRow = () =>
      away.container.querySelector('button[aria-label^="Chat"][aria-label$=", unsent reply"]');
    expect(chatRow()?.textContent).toContain("pen");

    const open = await mount(null, {
      destination: null,
      seed,
      selectedTitle: "Prepare the product launch",
    });
    expect(launch(open.container).dataset["drafted"]).toBe("false");

    const chat = await mount(null, { seed });
    expect(
      chat.container.querySelector('button[aria-label^="Chat"][aria-label$=", unsent reply"]'),
    ).toBeNull();
  });

  it("does not redraw for a keystroke in a reply or in the draft open", async () => {
    const { container, drafts, host } = await mount(null, {
      openDraftId: "draft-open",
      seed: async (store, client) => {
        await store.writeDraft(...scope, client.getSnapshot().threads[0]!.id, "One");
        await store.writeDraft(...scope, newTaskDraftKey("draft-open"), "O");
      },
    });
    expect(firstRow(container)).toBeDefined();
    const draws = harness.rowDraws;
    await act(async () => {
      await drafts.writeDraft(...scope, host.getSnapshot().threads[0]!.id, "One more");
      await drafts.writeDraft(...scope, newTaskDraftKey("draft-open"), "Op");
      await drafts.writeDraft(...scope, newTaskDraftKey("draft-open"), "Ope");
    });
    expect(harness.rowDraws).toBe(draws);
    // A change the list does show still reaches it.
    await act(() => drafts.writeDraft(...scope, newTaskDraftKey("draft-b"), "Another"));
    expect(button(container, "Draft, Another")).toBeDefined();
  });
});

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
