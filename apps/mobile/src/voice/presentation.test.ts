import { createRequire } from "node:module";
import { placeList, type HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { ThreadIdSchema, type ThreadId } from "@opensteer/core";
import type {
  PresentationCommitGuard,
  ScreenPresentationReceipt,
  ScreenShowTarget,
  ScreenSurface,
} from "@opensteer/client/screen";
import { StackActions, StackRouter } from "@react-navigation/native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mobileScreenPresentation,
  type PresentationDevice,
  type PresentationNavigator,
} from "./presentation.js";
import { holdRemoteEditing, observeInteraction, remoteEditing } from "./interaction.js";

// The real stack router behind a stand-in container: actions change the state
// at once, as React Navigation's store does, and its `state` event follows
// later, as the container emits it from an effect.
vi.mock("@react-navigation/native", () => {
  const from = (base: string, name: string) => createRequire(base).resolve(name);
  const native = from(import.meta.url, "@react-navigation/native");
  return import(from(from(native, "@react-navigation/core"), "@react-navigation/routers"));
});

const deploymentId = "dep_test";
const routeNames = ["Home", "Thread", "WorkspaceBrowser", "Settings"];
const config = { routeNames, routeParamList: {}, routeGetIdList: {} };
type Stack = ReturnType<ReturnType<typeof StackRouter>["getInitialState"]>;

function container(initial: readonly { name: string; params?: object }[]) {
  const router = StackRouter({});
  let state = router.getRehydratedState(
    { index: initial.length - 1, routes: initial.map((route) => ({ ...route })), stale: true },
    config,
  ) as Stack;
  const listeners = new Set<() => void>();
  let unannounced = false;
  const navigator: PresentationNavigator = {
    isReady: () => true,
    getRootState: () => state,
    getCurrentRoute: () => state.routes[state.index],
    getCurrentOptions: () =>
      state.routes[state.index]?.name === "Settings" ? { presentation: "formSheet" } : {},
    canGoBack: () => state.index > 0,
    goBack: () => navigator.dispatch(StackActions.pop()),
    dispatch(action) {
      const next = router.getStateForAction(
        state,
        action as Parameters<typeof router.getStateForAction>[1],
        config,
      );
      if (!next) return;
      state = next as Stack;
      unannounced = true;
    },
    addListener(_type, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    navigator,
    routes: () => state.routes.map(({ name, params }) => ({ name, ...params })),
    announce() {
      if (!unannounced) return;
      unannounced = false;
      for (const listener of listeners) listener();
    },
  };
}

const device = {
  active: true,
  editing: false,
  covered: false,
  macVideo: true,
  rise: null as (() => void) | null,
};
const phone: PresentationDevice = {
  active: () => device.active,
  editing: () => device.editing || remoteEditing(),
  covered: () => device.covered,
  get macVideo() {
    return device.macVideo;
  },
  observe(listener) {
    device.rise = listener;
    const stop = observeInteraction(listener);
    return () => {
      device.rise = null;
      stop();
    };
  },
};

let host: MockHostClient;
let snapshot: HostSnapshot;
let task: ThreadId;
let chat: ThreadId;
let page: Extract<ScreenSurface, { kind: "browser" }>;
beforeEach(async () => {
  Object.assign(device, {
    active: true,
    editing: false,
    covered: false,
    macVideo: true,
    rise: null,
  });
  host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  await host.load();
  snapshot = host.getSnapshot();
  chat = ThreadIdSchema.parse(snapshot.homeThreadId);
  task = ThreadIdSchema.parse(snapshot.threads.find(({ id }) => id !== chat)!.id);
  const tab = placeList(snapshot).find((place) => place.destination.kind === "browser")!;
  page = tab.destination as Extract<ScreenSurface, { kind: "browser" }>;
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
const disposers: (() => void)[] = [];

function presentation(stack: ReturnType<typeof container>) {
  const made = mobileScreenPresentation({
    navigator: stack.navigator,
    device: phone,
    hostClient: host,
    deploymentId: () => deploymentId,
  });
  disposers.push(made.dispose);
  return made;
}

/** The shared controller's guard: anything the person did since `capture` refuses. */
function guardSince(port: ReturnType<typeof presentation>["port"]): PresentationCommitGuard {
  const captured = port.capture().interactionRevision;
  return {
    operationId: "op",
    check: () =>
      port.capture().interactionRevision === captured
        ? port.blocked()
        : { outcome: "superseded", reason: "interaction-ended" },
  };
}

async function present(
  port: ReturnType<typeof presentation>["port"],
  target: ScreenShowTarget,
  guard = guardSince(port),
) {
  const prepared = await port.prepare(target, new AbortController().signal);
  return { prepared, committed: prepared.commitIfCurrent(guard) };
}

const home = { name: "Home", params: { deploymentId } };
const thread = (threadId: string) => ({ name: "Thread", params: { deploymentId, threadId } });

describe("a presentation on the phone", () => {
  it("prepares without navigating, then pushes one screen and confirms it", async () => {
    const stack = container([home]);
    const { port } = presentation(stack);
    const guard = guardSince(port);
    const prepared = await port.prepare({ conversationId: task }, new AbortController().signal);
    expect(stack.routes()).toEqual([{ name: "Home", deploymentId }]);
    expect(prepared.commitIfCurrent(guard)).toBe("committed");
    expect(stack.routes()).toEqual([
      { name: "Home", deploymentId },
      { name: "Thread", deploymentId, threadId: task },
    ]);
    await expect(prepared.confirmation).resolves.toEqual({ outcome: "applied" });
    // Its own arrival is not something the person did.
    stack.announce();
    expect(guard.check()).toBeNull();
  });

  it("adds nothing when the target is already in front, and Back returns to what was there", async () => {
    const stack = container([home, thread(task)]);
    const { port } = presentation(stack);
    const same = await present(port, { conversationId: task });
    expect(same.committed).toBe("committed");
    await expect(same.prepared.confirmation).resolves.toEqual({ outcome: "applied" });
    expect(stack.routes()).toHaveLength(2);

    const both = await present(port, { conversationId: task, surface: page });
    await expect(both.prepared.confirmation).resolves.toEqual({ outcome: "applied" });
    expect(stack.routes().at(-1)).toEqual({
      name: "WorkspaceBrowser",
      deploymentId,
      threadId: task,
      sessionId: page.sessionId,
      tabId: page.tabId,
    });
    expect(stack.routes()).toHaveLength(3);
    const again = await present(port, { conversationId: task, surface: page });
    await expect(again.prepared.confirmation).resolves.toEqual({ outcome: "applied" });
    expect(stack.routes()).toHaveLength(3);
    stack.navigator.goBack();
    expect(stack.routes().at(-1)).toEqual({ name: "Thread", deploymentId, threadId: task });
  });

  it("shows a surface alone, and Chat by returning to it rather than stacking another", async () => {
    const stack = container([home, thread(task)]);
    const { port } = presentation(stack);
    const alone = await present(port, { surface: page });
    await expect(alone.prepared.confirmation).resolves.toEqual({ outcome: "applied" });
    expect(stack.routes().at(-1)).toEqual({
      name: "WorkspaceBrowser",
      deploymentId,
      scope: "workspace",
      sessionId: page.sessionId,
      tabId: page.tabId,
    });
    const toChat = await present(port, { conversationId: chat });
    await expect(toChat.prepared.confirmation).resolves.toEqual({ outcome: "applied" });
    // Chat is the root and its only screen: there is nothing above it for Back.
    expect(stack.routes()).toEqual([{ name: "Home", deploymentId }]);
    expect(stack.navigator.canGoBack()).toBe(false);
  });

  it("refuses after the person goes Back, before the container announces it", async () => {
    const stack = container([home, thread(task)]);
    const { port } = presentation(stack);
    const guard = guardSince(port);
    const prepared = await port.prepare({ surface: page }, new AbortController().signal);
    stack.navigator.goBack();
    expect(prepared.commitIfCurrent(guard)).toEqual({
      outcome: "superseded",
      reason: "interaction-ended",
    });
    expect(stack.routes()).toEqual([{ name: "Home", deploymentId }]);
    // The late announcement neither revives it nor counts twice.
    stack.announce();
    await expect(prepared.confirmation).resolves.toEqual({
      outcome: "superseded",
      reason: "interaction-ended",
    });
  });

  it("is blocked by a sheet, the keyboard, typing, the drawer or the background, and outdated by them", async () => {
    const stack = container([home, { name: "Settings" }]);
    const { port } = presentation(stack);
    expect(port.blocked()).toEqual({ outcome: "superseded", reason: "busy" });
    stack.navigator.goBack();
    expect(port.blocked()).toBeNull();

    const captured = port.capture().interactionRevision;
    device.rise!();
    expect(port.capture().interactionRevision).not.toBe(captured);
    device.editing = true;
    expect(port.blocked()).toEqual({ outcome: "superseded", reason: "busy" });
    device.editing = false;
    const beforeRemote = guardSince(port);
    const closeRemote = holdRemoteEditing();
    try {
      expect(port.blocked()).toEqual({ outcome: "superseded", reason: "busy" });
      const duringRemote = guardSince(port);
      expect(duringRemote.check()).toEqual({ outcome: "superseded", reason: "busy" });
      closeRemote();
      expect(port.blocked()).toBeNull();
      expect(beforeRemote.check()).toEqual({ outcome: "superseded", reason: "interaction-ended" });
      expect(duringRemote.check()).toEqual({ outcome: "superseded", reason: "interaction-ended" });
    } finally {
      closeRemote();
    }
    device.covered = true;
    expect(port.blocked()).toEqual({ outcome: "superseded", reason: "busy" });
    device.covered = false;
    device.active = false;
    const { committed } = await present(port, { conversationId: task });
    expect(committed).toEqual({ outcome: "superseded", reason: "busy" });
    expect(stack.routes()).toHaveLength(1);
  });

  it("refuses what it cannot show exactly, without navigating", async () => {
    const stack = container([home]);
    const { port } = presentation(stack);
    const closed = { outcome: "unavailable", reason: "closed" } satisfies ScreenPresentationReceipt;
    expect(
      (
        await present(port, {
          conversationId: ThreadIdSchema.parse("thr_00000000-0000-4000-8000-0000000009ff"),
        })
      ).committed,
    ).toEqual(closed);
    expect(
      (await present(port, { surface: { ...page, tabId: "mock-tab-gone" as typeof page.tabId } }))
        .committed,
    ).toEqual(closed);
    const app = placeList(snapshot).find((place) => place.destination.kind === "app")!;
    if (app.destination.kind !== "app") throw new Error("Missing app place");
    const appSurface: ScreenSurface = {
      kind: "app",
      machineId: app.destination.machineId as never,
      appKey: app.destination.appKey,
      source: { kind: "task-session", sessionId: app.destination.computerSessionId! },
    };
    const stale: ScreenSurface = {
      ...appSurface,
      source: { kind: "owner-view", viewId: "cv_gone" as never, generation: 1, windowId: 1 },
    };
    expect((await present(port, { surface: stale })).committed).toEqual(closed);
    device.macVideo = false;
    expect((await present(port, { surface: appSurface })).committed).toEqual({
      outcome: "unsupported",
    });
    expect(stack.routes()).toHaveLength(1);
    device.macVideo = true;
    expect((await present(port, { surface: appSurface })).committed).toBe("committed");
  });

  it("settles as unconfirmed when the route never arrives", async () => {
    const stack = container([home]);
    const dispatch = stack.navigator.dispatch;
    stack.navigator.dispatch = () => undefined;
    const { port } = presentation(stack);
    const { prepared, committed } = await present(port, { conversationId: task });
    expect(committed).toBe("committed");
    prepared.dispose();
    await expect(prepared.confirmation).resolves.toEqual({ outcome: "unconfirmed" });
    stack.navigator.dispatch = dispatch;
  });

  it("keeps a task's conversation as context, never Chat", () => {
    const stack = container([home]);
    const { port } = presentation(stack);
    expect(port.capture().currentThreadId).toBeUndefined();
    stack.navigator.dispatch(StackActions.push("Thread", { deploymentId, threadId: task }));
    expect(port.capture().currentThreadId).toBe(task);
  });
});

describe("the person's spoken navigation", () => {
  it("never stacks a second copy of what is in front", () => {
    const stack = container([home, thread(task)]);
    const { show } = presentation(stack);
    show({ kind: "thread", threadId: task });
    expect(stack.routes()).toHaveLength(2);
    show({ kind: "place", destination: page });
    show({ kind: "place", destination: page });
    expect(stack.routes()).toHaveLength(3);
    show({ kind: "chat" });
    expect(stack.routes()).toEqual([{ name: "Home", deploymentId }]);
  });

  it("outdates a presentation captured before it", async () => {
    const stack = container([home]);
    const { port, show } = presentation(stack);
    const guard = guardSince(port);
    const prepared = await port.prepare({ surface: page }, new AbortController().signal);
    show({ kind: "thread", threadId: task });
    expect(prepared.commitIfCurrent(guard)).toEqual({
      outcome: "superseded",
      reason: "interaction-ended",
    });
    expect(stack.routes().at(-1)).toEqual({ name: "Thread", deploymentId, threadId: task });
  });
});
