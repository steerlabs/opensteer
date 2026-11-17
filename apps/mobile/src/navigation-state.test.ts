import { createRequire } from "node:module";
import {
  CommonActions,
  StackActions,
  StackRouter,
  type NavigationAction,
} from "@react-navigation/native";
import { PendingDestination } from "./pending-destination.js";
import { SideMemory } from "./side-memory.js";
import { personalRouteInvalid } from "./side-memory-validity.js";
import type { HostSnapshot } from "@opensteer/client/host";
import { tabFixture, tabStoreFixture } from "@opensteer/client/test-support";
import { TabIdSchema } from "@opensteer/core";

// Use the real stack router without importing the native rendering layer in Node.
vi.mock("@react-navigation/native", async () => {
  const require = createRequire(import.meta.url);
  const core = require.resolve("@react-navigation/core", {
    paths: [require.resolve("@react-navigation/native")],
  });
  return import(require.resolve("@react-navigation/routers", { paths: [core] }));
});

import { describe, expect, it, vi } from "vitest";
import {
  applicationLinkState,
  deploymentRoot,
  deploymentsRoot,
  selectionRootTransition,
  threadReturn,
  threadRoot,
} from "./navigation-state.js";

describe("returning to a thread from a sheet", () => {
  const destination = { deploymentId: "dep_1", threadId: "thr_1" };
  const home = { name: "Home", params: { deploymentId: "dep_1" } };

  it("goes back to the thread the sheet was opened over", () => {
    expect(
      threadReturn(
        [home, { name: "Thread", params: destination }, { name: "Computer" }],
        destination,
      ),
    ).toBe("pop-to");
  });

  it("opens another thread from the list rather than over the sheet", () => {
    expect(
      threadReturn(
        [
          home,
          { name: "Thread", params: { ...destination, threadId: "thr_2" } },
          { name: "Computer" },
        ],
        destination,
      ),
    ).toBe("push-from-top");
    expect(threadReturn([home, { name: "Settings" }, { name: "Computer" }], destination)).toBe(
      "push-from-top",
    );
  });
});

describe("mobile root navigation", () => {
  it("keeps Chat as the selected deployment's root", () => {
    expect(deploymentRoot("dep_one")).toEqual({
      index: 0,
      routes: [{ name: "Home", params: { deploymentId: "dep_one" } }],
    });
  });

  it("opens an exact deep-linked thread above that deployment's Chat", () => {
    expect(
      threadRoot({ deploymentId: "dep_two", requestId: "req_one", threadId: "thr_one" }),
    ).toEqual({
      index: 1,
      routes: [
        { name: "Home", params: { deploymentId: "dep_two" } },
        {
          name: "Thread",
          params: { deploymentId: "dep_two", requestId: "req_one", threadId: "thr_one" },
        },
      ],
    });
  });

  it("moves a hydrated catalog directly into its selected deployment", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "Deployments",
        baseDeploymentId: null,
        baseRouteName: "Deployments",
        deploymentId: "dep_one",
      }),
    ).toEqual(deploymentRoot("dep_one"));
  });

  it("defers a selection change while modal work is open", () => {
    // Joining a team from another computer selects that computer under the sheet.
    for (const activeRouteName of ["Settings", "JoinTeam"])
      expect(
        selectionRootTransition({
          activeRouteName,
          baseDeploymentId: "dep_one",
          baseRouteName: "Home",
          deploymentId: "dep_two",
        }),
      ).toBe("defer");
  });

  it("settles on the joining computer's Home with the team's channel over it", () => {
    // What the join sheet resets to once it has switched computers.
    expect(
      selectionRootTransition({
        activeRouteName: "TeamChannel",
        baseDeploymentId: "dep_two",
        baseRouteName: "Home",
        deploymentId: "dep_two",
      }),
    ).toBeNull();
  });

  it("replaces the root beneath a thread-bound sheet rather than deferring", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "ThreadSettings",
        baseDeploymentId: "dep_one",
        baseRouteName: "Home",
        deploymentId: "dep_two",
      }),
    ).toEqual(deploymentRoot("dep_two"));
  });

  it("replaces another deployment root after a deferred selection settles", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "TaskSearch",
        baseDeploymentId: "dep_one",
        baseRouteName: "Home",
        deploymentId: "dep_two",
      }),
    ).toEqual(deploymentRoot("dep_two"));
  });

  it("returns to onboarding only when the selection itself is cleared", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "Thread",
        baseDeploymentId: "dep_one",
        baseRouteName: "Home",
        deploymentId: null,
      }),
    ).toEqual(deploymentsRoot());
  });
});

describe("warm mobile sides on the native stack router", () => {
  const pageTabId = TabIdSchema.parse("tab_page");
  const task = { name: "Thread", params: { deploymentId: "d", threadId: "task" } };
  const page = {
    name: "WorkspaceBrowser",
    params: { deploymentId: "d", threadId: "task", tabId: pageTabId },
  };
  const channel = { name: "TeamChannel", params: { teamId: "a", channelId: "general" } };
  const reply = { name: "TeamThread", params: { ...channel.params, rootId: "root" } };
  function fixture() {
    const memory = new SideMemory();
    memory.account("account");
    const router = StackRouter({ initialRouteName: "Home" });
    const options = {
      routeNames: [
        "Home",
        "Deployments",
        "Thread",
        "WorkspaceBrowser",
        "TeamChannel",
        "TeamChannels",
        "TeamThread",
        "Settings",
        "TeamSettings",
        "JoinTeam",
        "NeedsYou",
        "Subagent",
      ],
      routeParamList: {},
      routeGetIdList: {},
    };
    let state = router.getRehydratedState(
      { index: 0, routes: deploymentRoot("d").routes },
      options,
    );
    const apply = (action: NavigationAction | ReturnType<typeof CommonActions.reset> | null) => {
      if (action === null) return;
      const next = router.getStateForAction(
        state,
        action as Parameters<typeof router.getStateForAction>[1],
        options,
      );
      if (next === null) throw new Error(`Router refused ${action.type}`);
      state = router.getRehydratedState(next, options);
      memory.record(state);
    };
    return {
      memory,
      apply,
      state: () => state,
      back: () => apply((state.index === 1 ? memory.back(state) : null) ?? CommonActions.goBack()),
      enter: (target: { name: string; params: object }) => apply(memory.enter(state, target)),
      resume: (side: string) => apply(memory.resume(state, side)),
      push: (target: { name: string; params: object }) =>
        apply(StackActions.push(target.name, target.params)),
    };
  }

  it("restores task + exact place and each team's channel/thread, retaining Home and router keys", () => {
    const f = fixture();
    f.enter(task);
    f.push(page);
    const tasks = f.state().routes;
    f.enter(channel);
    f.push(reply);
    const teamA = f.state().routes;
    expect(teamA.map((route) => route.name)).toEqual(["Home", "TeamChannel", "TeamThread"]);
    expect(f.memory.resume(f.state(), "b")).toBeNull();
    f.resume("tasks");
    expect(f.state().routes).toEqual(tasks);
    f.resume("a");
    expect(f.state().routes).toEqual(teamA);
    expect(f.memory.resume(f.state(), "a")).toBeNull();
    f.back();
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "TeamChannel"]);
    f.back();
    expect(f.state().routes).toEqual(tasks);
    f.resume("a");
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "TeamChannel"]);
  });

  it("an explicit notification or team link replaces only its side and spends its landing params", () => {
    const f = fixture();
    f.enter(task);
    f.push(page);
    f.enter(channel);
    f.push(reply);
    const teamA = f.state().routes;
    f.enter({
      ...task,
      params: {
        deploymentId: "d",
        threadId: "notified",
        messageId: "message",
        requestId: "request",
      },
    });
    expect(f.state().routes.at(-1)?.params).toMatchObject({
      messageId: "message",
      requestId: "request",
    });
    f.resume("a");
    expect(f.state().routes).toEqual(teamA);
    f.resume("tasks");
    expect(f.state().routes.at(-1)?.params).toEqual({ deploymentId: "d", threadId: "notified" });
    f.enter({
      ...reply,
      params: { teamId: "b", channelId: "b-channel", rootId: "b-root", replyId: "landing" },
    });
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "TeamThread"]);
    f.resume("a");
    expect(f.state().routes).toEqual(teamA);
    f.resume("b");
    expect(f.state().routes.at(-1)?.params).toEqual({
      teamId: "b",
      channelId: "b-channel",
      rootId: "b-root",
    });
  });

  it("records only through the active index, excludes presented flows, and keeps all unspent params", () => {
    const f = fixture();
    f.enter(task);
    f.push({
      ...page,
      params: { ...page.params, futureParam: { selection: [1, 2] }, editAddress: true },
    });
    f.push({ name: "Settings", params: { token: "secret" } });
    f.push({ name: "TeamSettings", params: { teamId: "unrelated" } });
    f.enter(channel);
    f.resume("tasks");
    expect(f.state().routes.map(({ name, params }) => ({ name, params }))).toEqual([
      { name: "Home", params: { deploymentId: "d" } },
      task,
      {
        ...page,
        params: { ...page.params, futureParam: { selection: [1, 2] }, editAddress: true },
      },
    ]);
    f.memory.record({ ...f.state(), index: 1 });
    const action = f.memory.resume({ ...f.state(), index: 1 }, "a");
    f.apply(action);
    f.resume("tasks");
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
    f.push({ name: "Settings", params: {} });
    f.push({ name: "JoinTeam", params: { link: "old sheet" } });
    f.apply(f.memory.enter(f.state(), reply));
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "TeamThread"]);
    f.back();
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
    f.enter(reply);
    f.resume("tasks");
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
  });

  it("clears sides on account and Deployment changes", () => {
    const f = fixture();
    f.enter(task);
    f.push(page);
    f.enter(channel);
    expect(f.memory.account("other")).toBe(true);
    f.apply(CommonActions.reset(deploymentRoot("d")));
    expect(f.memory.resume(f.state(), "a")).toBeNull();
    f.resume("tasks");
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home"]);
    f.enter(task);
    f.enter(channel);
    f.apply(CommonActions.reset(deploymentRoot("other-deployment")));
    f.resume("a");
    f.resume("tasks");
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home"]);
    f.enter(channel);
    f.apply(CommonActions.reset({ index: 0, routes: [{ name: "Deployments" }] }));
    f.apply(CommonActions.reset(deploymentRoot("other-deployment")));
    f.resume("a");
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home"]);
  });

  it("trims only confirmed deletion/closure, and forgets a team back to remembered Tasks", () => {
    const f = fixture();
    f.enter(task);
    f.push(page);
    f.enter(channel);
    const unavailable = {
      deploymentId: "d",
      connection: "offline",
      threadLookups: {},
      tasks: null,
    } as unknown as HostSnapshot;
    expect(
      f.memory.trim(f.state(), (route) => personalRouteInvalid(route, unavailable)),
    ).toBeNull();
    f.resume("tasks");
    expect(f.state().routes.map((route) => route.name)).toEqual([
      "Home",
      "Thread",
      "WorkspaceBrowser",
    ]);
    const live = (tabs: HostSnapshot["tabs"]) =>
      ({
        ...unavailable,
        connection: "connected",
        session: "authenticated",
        can: {
          createTasks: true,
          useVoice: true,
          manageComputers: true,
          managePrivateResources: true,
        },
        tabs,
      }) as unknown as HostSnapshot;
    const listed = tabStoreFixture([tabFixture({ tabId: pageTabId })]);
    const syncing = tabStoreFixture([]);
    syncing.disconnected();
    // Still syncing, then listed: neither is closure.
    for (const tabs of [syncing, listed])
      expect(
        f.memory.trim(f.state(), (route) => personalRouteInvalid(route, live(tabs))),
      ).toBeNull();
    f.apply(
      f.memory.trim(f.state(), (route) => personalRouteInvalid(route, live(tabStoreFixture([])))),
    );
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
    f.push(page);
    f.resume("a");
    const deleted = { ...unavailable, threadLookups: { task: "missing" } } as HostSnapshot;
    f.apply(f.memory.trim(f.state(), (route) => personalRouteInvalid(route, deleted)));
    f.resume("tasks");
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home"]);
    f.enter(task);
    f.push(page);
    const tasks = f.state().routes;
    f.enter({ name: "TeamChannels", params: { teamId: "a" } });
    f.push(channel);
    f.push(reply);
    f.apply(f.memory.trim(f.state(), (route) => "channelId" in (route.params ?? {})));
    expect(f.state().routes).toEqual(tasks);
    f.resume("a");
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "TeamChannels"]);
    f.apply(f.memory.forget(f.state(), "a"));
    expect(f.state().routes).toEqual(tasks);
    f.resume("a");
    expect(f.state().routes).toEqual(tasks);
  });

  it("keeps a tab route by its tabId alone, never a viewing lease", () => {
    const f = fixture();
    f.enter(task);
    f.push(page);
    f.enter(channel);
    f.resume("tasks");
    expect(f.state().routes.at(-1)?.params).toEqual(page.params);
  });
});

describe("pending external destinations", () => {
  function fixture(
    resolve: (
      url: string,
      current: () => boolean,
      release: () => void,
      intent: number,
    ) => Promise<ReturnType<typeof threadRoot> | null>,
  ) {
    const present = vi.fn();
    const failed = vi.fn();
    // "connect" stands in for a Connect code: consumed on arrival, no stack of its own.
    const receive = vi.fn((url: string) => url === "connect");
    const settled = vi.fn();
    const pending = new PendingDestination({ resolve, present, failed, receive, settled });
    return { pending, present, failed, receive, settled };
  }
  const destination = threadRoot({ deploymentId: "new", threadId: "notified" });

  it("hydrates before reading and makes a cold tap the first stack, acknowledging only at navigator readiness", async () => {
    const resolve = vi.fn(async () => destination);
    const f = fixture(resolve);
    const acknowledged = vi.fn();
    const tap = f.pending.submit("tap").then(acknowledged);
    expect(resolve).not.toHaveBeenCalled();
    f.pending.hydrated();
    const fallback = vi.fn(() => deploymentRoot("remembered"));
    const initial = f.pending.initialState(fallback);
    await vi.waitFor(async () => expect(await initial).toEqual(destination));
    expect(fallback).not.toHaveBeenCalled();
    expect(f.present).not.toHaveBeenCalled();
    expect(acknowledged).not.toHaveBeenCalled();
    f.pending.ready();
    await vi.waitFor(() => tap);
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(f.present).not.toHaveBeenCalled();
  });

  it("delivers OAuth callbacks immediately without cancelling the destination waiting on sign-in", async () => {
    const resolve = Promise.withResolvers<ReturnType<typeof threadRoot>>();
    const present = vi.fn();
    const receive = vi.fn((url: string) => (url === "callback" ? ("callback" as const) : false));
    const pending = new PendingDestination({
      receive,
      resolve: () => resolve.promise,
      present,
      failed: vi.fn(),
      settled: vi.fn(),
    });
    pending.hydrated();
    pending.ready();
    const tap = pending.submit("team");
    const sheet = pending.capture();
    await pending.submit("callback");
    expect(sheet()).toBe(true);
    resolve.resolve(destination);
    await vi.waitFor(() => tap);
    expect(present).toHaveBeenCalledWith(destination);
  });

  it("routes warm/background taps immediately after readiness and invalidates old join-sheet work", async () => {
    const f = fixture(async () => destination);
    f.pending.hydrated();
    f.pending.ready();
    const first = f.pending.submit("first");
    await vi.waitFor(() => first);
    const oldSheet = f.pending.capture();
    const second = f.pending.submit("second");
    await vi.waitFor(() => second);
    expect(f.present.mock.calls).toEqual([[destination], [destination]]);
    expect(oldSheet()).toBe(false);
  });

  it("lets B become the initial stack while A is unresolved, and ignores A's late destination", async () => {
    const a = Promise.withResolvers<ReturnType<typeof threadRoot>>();
    const resolve = vi.fn((url: string) =>
      url === "a" ? a.promise : Promise.resolve(destination),
    );
    const f = fixture(resolve);
    f.pending.hydrated();
    const tapA = f.pending.submit("a");
    const initial = f.pending.initialState(() => deploymentsRoot());
    await vi.waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(
        "a",
        expect.any(Function),
        expect.any(Function),
        expect.any(Number),
      ),
    );
    const tapB = f.pending.submit("b");
    await vi.waitFor(async () => expect(await initial).toEqual(destination));
    f.pending.ready();
    await vi.waitFor(() => tapB);
    a.resolve(threadRoot({ deploymentId: "old", threadId: "a" }));
    await a.promise;
    await vi.waitFor(() => tapA);
    expect(f.present).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it("cannot show a stale failure or clear the newer pending tap", async () => {
    const a = Promise.withResolvers<ReturnType<typeof threadRoot>>();
    const b = Promise.withResolvers<ReturnType<typeof threadRoot>>();
    const resolve = vi.fn((url: string) => (url === "a" ? a.promise : b.promise));
    const f = fixture(resolve);
    f.pending.hydrated();
    f.pending.ready();
    const tapA = f.pending.submit("a");
    await vi.waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(
        "a",
        expect.any(Function),
        expect.any(Function),
        expect.any(Number),
      ),
    );
    const acknowledgedB = vi.fn();
    const tapB = f.pending.submit("b").then(acknowledgedB);
    a.reject(new Error("old failure"));
    await vi.waitFor(() => tapA);
    expect(acknowledgedB).not.toHaveBeenCalled();
    b.resolve(destination);
    await vi.waitFor(() => tapB);
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.present.mock.calls).toEqual([[destination]]);
  });

  it("protects the linked Deployment from stale selection and Account restore, then permits a real account change", async () => {
    const f = fixture(async () => destination);
    f.pending.account(null);
    f.pending.hydrated();
    f.pending.ready();
    const tap = f.pending.submit("new");
    await vi.waitFor(() => tap);
    expect(f.pending.mayReconcileSelection("remembered")).toBe(false);
    expect(f.pending.account("restored-account")).toBe(false);
    expect(f.pending.mayReconcileSelection("remembered")).toBe(false);
    expect(f.pending.mayReconcileSelection("new")).toBe(true);
    expect(f.pending.account("another-account")).toBe(true);
  });

  it("renders the first stack while a cold link waits on the network, then presents it", async () => {
    const directory = Promise.withResolvers<void>();
    const f = fixture(async (_url, _current, release) => {
      release();
      await directory.promise;
      return destination;
    });
    f.pending.hydrated();
    const tap = f.pending.submit("unknown-yet");
    expect(await f.pending.initialState(() => deploymentRoot("remembered"))).toEqual(
      deploymentRoot("remembered"),
    );
    f.pending.ready();
    expect(f.present).not.toHaveBeenCalled();
    directory.resolve();
    await tap;
    expect(f.present).toHaveBeenCalledWith(destination);
  });

  it("lets the shown selection reconcile once the linked Deployment fails to open, even before landing", async () => {
    const f = fixture(async () => {
      f.pending.selectionFailed();
      return destination;
    });
    f.pending.hydrated();
    f.pending.ready();
    await f.pending.submit("unreachable");
    expect(f.present).toHaveBeenCalledWith(destination);
    expect(f.pending.mayReconcileSelection("remembered")).toBe(true);

    const landed = fixture(async () => destination);
    landed.pending.hydrated();
    landed.pending.ready();
    await landed.pending.submit("new");
    expect(landed.pending.mayReconcileSelection("remembered")).toBe(false);
    landed.pending.selectionFailed();
    expect(landed.pending.mayReconcileSelection("remembered")).toBe(true);
  });

  it("releases the destination's selection lock even when that selection was already applied", async () => {
    const f = fixture(async () => threadRoot({ deploymentId: "shown", threadId: "notified" }));
    f.pending.hydrated();
    f.pending.ready();
    f.pending.reconciled("shown");
    await f.pending.submit("tap-for-shown-computer");
    expect(f.pending.selectionToReconcile("shown")).toBe(true);
    f.pending.reconciled("shown");
    expect(f.pending.selectionToReconcile("shown")).toBe(false);
    // The computer is later removed from the directory.
    expect(f.pending.selectionToReconcile(null)).toBe(true);
  });

  it("supersedes a link-opened sheet by its own intent, even when it mounts after a newer link", async () => {
    let opened = 0;
    const f = fixture(async (_url, _current, _release, intent) => {
      opened = intent;
      return destination;
    });
    f.pending.hydrated();
    const tap = f.pending.submit("team-link");
    await f.pending.initialState(() => deploymentsRoot());
    const connect = f.pending.submit("connect");
    expect(f.pending.capture(opened)()).toBe(false);
    expect(f.pending.capture()()).toBe(true);
    f.pending.ready();
    await Promise.all([tap, connect]);
  });

  it("re-applies the published selection when a link finishes without a stack of its own", async () => {
    const callback = Promise.withResolvers<null>();
    const f = fixture(async (_url, _current, release) => {
      release();
      return callback.promise;
    });
    f.pending.hydrated();
    f.pending.reconciled("before");
    const link = f.pending.submit("integration-return");
    await f.pending.initialState(() => deploymentRoot("before"));
    f.pending.ready();
    expect(f.pending.selectionToReconcile("selected-by-callback")).toBe(false);
    callback.resolve(null);
    await link;
    expect(f.settled).toHaveBeenCalled();
    expect(f.pending.selectionToReconcile("selected-by-callback")).toBe(true);
  });

  it("still opens the app on its usual stack when a cold-start destination is refused", async () => {
    const error = new Error("That team is not on this phone.");
    const f = fixture(async () => {
      throw error;
    });
    f.pending.hydrated();
    const tap = f.pending.submit("removed-team");
    expect(await f.pending.initialState(() => deploymentRoot("remembered"))).toEqual(
      deploymentRoot("remembered"),
    );
    await expect(tap).rejects.toThrow(error);
    expect(f.failed).toHaveBeenCalledWith(error);
  });

  it("reports a routing failure and rejects the acknowledgment so the OS response remains retryable", async () => {
    const error = new Error("navigation refused");
    const f = fixture(async () => {
      throw error;
    });
    f.pending.hydrated();
    f.pending.ready();
    await expect(f.pending.submit("tap")).rejects.toThrow(error);
    expect(f.failed).toHaveBeenCalledWith(error);
    expect(f.present).not.toHaveBeenCalled();
  });
});

describe("external link stacks", () => {
  const teamId = "dep_team";
  const team = {
    teamId,
    origin: "https://team.example",
    name: "Team",
    onPhone: true,
    state: "offline" as const,
    detail: null,
    session: null,
    userId: null,
  };
  const teams = { team: () => team, teamAt: () => team, computersIn: () => ["personal-in-team"] };

  it.each([null, "personal"])(
    "offers pairing over the hydrated startup root (%s)",
    (selectedDeploymentId) => {
      const offer = { origin: "https://mac.example", code: `osp_${"a".repeat(43)}` };
      const select = vi.fn(async () => undefined);
      const state = applicationLinkState(
        { kind: "pairing", offer },
        { externalIntent: 1, selectedDeploymentId, select, teams },
      );
      expect(state).toEqual({
        index: 1,
        routes: [
          selectedDeploymentId === null
            ? { name: "Deployments" }
            : { name: "Home", params: { deploymentId: selectedDeploymentId } },
          { name: "AddPersonal", params: offer },
        ],
      });
      expect(select).not.toHaveBeenCalled();
    },
  );

  it("opens a member's channel/thread without a JoinTeam sheet or waiting for personal selection", () => {
    const connection = Promise.withResolvers<void>();
    const select = vi.fn(() => connection.promise);
    const state = applicationLinkState(
      {
        kind: "team",
        origin: team.origin,
        page: "unused",
        target: { kind: "message", channelId: "channel", messageId: "42" },
      } as never,
      { externalIntent: 1, selectedDeploymentId: "unrelated", select, teams },
    );
    expect(state).toEqual({
      index: 1,
      routes: [
        { name: "Home", params: { deploymentId: "personal-in-team" } },
        { name: "TeamChannel", params: { teamId, channelId: "channel", messageId: "42" } },
      ],
    });
    expect(select).toHaveBeenCalledWith("personal-in-team");
    connection.resolve();
  });

  it("opens the notice's team even when origin lookup would return another team", () => {
    const state = applicationLinkState(
      { kind: "team-notice", origin: team.origin, teamId, noticeId: "notice" },
      {
        externalIntent: 1,
        selectedDeploymentId: "personal-in-team",
        select: async () => undefined,
        teams: { ...teams, teamAt: () => ({ ...team, teamId: "wrong-team" }) },
      },
    );
    expect(state.routes.at(-1)).toEqual({ name: "TeamNotices", params: { teamId } });
  });

  it("replaces the old Deployment and leaves a useful Back destination", () => {
    const select = vi.fn(async () => undefined);
    const state = applicationLinkState(
      { kind: "open", deploymentId: "new", threadId: "task", requestId: null },
      { externalIntent: 1, selectedDeploymentId: "old", select, teams },
    );
    const router = StackRouter({ initialRouteName: "Home" });
    const options = {
      routeNames: ["Home", "Thread", "Settings"],
      routeParamList: {},
      routeGetIdList: {},
    };
    const opened = router.getRehydratedState(
      { index: state.index ?? 0, routes: state.routes },
      options,
    );
    const back = router.getStateForAction(opened, CommonActions.goBack(), options);
    expect(opened.routes.map(({ name, params }) => ({ name, params }))).toEqual([
      { name: "Home", params: { deploymentId: "new" } },
      { name: "Thread", params: { deploymentId: "new", threadId: "task" } },
    ]);
    expect(back?.routes.map(({ name, params }) => ({ name, params }))).toEqual([
      { name: "Home", params: { deploymentId: "new" } },
    ]);
  });
});
