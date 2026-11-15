import { createRequire } from "node:module";
import {
  CommonActions,
  StackActions,
  StackRouter,
  type NavigationAction,
} from "@react-navigation/native";
import { SideMemory } from "./side-memory.js";
import { personalRouteInvalid } from "./side-memory-validity.js";
import { BrowserTabStore } from "@opensteer/client/host";
import type { BrowserGroupRow } from "@opensteer/protocol/browser-tabs";
import type { LegacyHostSnapshot as HostSnapshot } from "@opensteer/client/host";

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
  deploymentRoot,
  deploymentsRoot,
  linkedSelectionFailureIsCurrent,
  selectionMayReconcileLinkedRoot,
  selectionRootTransition,
  startupRoot,
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

  it("does not let a remembered selection erase a linked thread while selection catches up", () => {
    expect(
      selectionMayReconcileLinkedRoot({
        linkedDeploymentId: "dep_two",
        selectionDeploymentId: "dep_one",
      }),
    ).toBe(false);
    expect(
      selectionMayReconcileLinkedRoot({
        linkedDeploymentId: "dep_two",
        selectionDeploymentId: "dep_two",
      }),
    ).toBe(true);
  });

  it("lets only the newest failed link release its protected root", () => {
    expect(
      linkedSelectionFailureIsCurrent({
        currentAttempt: 2,
        failedAttempt: 1,
        failedDeploymentId: "dep_one",
        linkedDeploymentId: "dep_two",
      }),
    ).toBe(false);
    expect(
      linkedSelectionFailureIsCurrent({
        currentAttempt: 2,
        failedAttempt: 2,
        failedDeploymentId: "dep_two",
        linkedDeploymentId: "dep_two",
      }),
    ).toBe(true);
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

describe("a pairing link at startup", () => {
  const pairing = { code: `osp_${"a".repeat(43)}`, origin: "https://mac.tailnet.ts.net" };

  it("opens the pairing form over the computer startup selected on its own", () => {
    expect(startupRoot({ destination: null, pairing, selectedDeploymentId: "dep_one" })).toEqual({
      index: 1,
      routes: [
        { name: "Home", params: { deploymentId: "dep_one" } },
        { name: "AddPersonal", params: pairing },
      ],
    });
  });

  it("opens the pairing form over the first run when nothing is selected", () => {
    expect(startupRoot({ destination: null, pairing, selectedDeploymentId: null })).toEqual({
      index: 1,
      routes: [{ name: "Deployments" }, { name: "AddPersonal", params: pairing }],
    });
  });

  it("keeps the pairing form in front while a startup selection catches up", () => {
    expect(
      selectionRootTransition({
        activeRouteName: "AddPersonal",
        baseDeploymentId: null,
        baseRouteName: "Deployments",
        deploymentId: "dep_one",
      }),
    ).toBe("defer");
  });

  it("starts where the selection or link says when there is no pairing link", () => {
    expect(
      startupRoot({ destination: null, pairing: null, selectedDeploymentId: "dep_one" }),
    ).toEqual(deploymentRoot("dep_one"));
    const destination = { deploymentId: "dep_one", threadId: "thr_one" };
    expect(
      startupRoot({
        destination: threadRoot(destination),
        pairing: null,
        selectedDeploymentId: null,
      }),
    ).toEqual(threadRoot(destination));
  });
});

describe("warm mobile sides on the native stack router", () => {
  const task = { name: "Thread", params: { deploymentId: "d", threadId: "task" } };
  const page = {
    name: "WorkspaceBrowser",
    params: { deploymentId: "d", threadId: "task", sessionId: "browser", tabId: "tab" },
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
    f.apply(f.memory.enter(f.state(), reply));
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "TeamThread"]);
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
    const browserTabs = new BrowserTabStore();
    browserTabs.seed({
      groups: {
        rows: [{ id: "g", sessionId: "browser", createdAt: "2026-01-01" } as BrowserGroupRow],
        complete: true,
      },
      tabs: [],
    });
    const live = {
      ...unavailable,
      connection: "connected",
      session: "authenticated",
      can: {
        createTasks: true,
        useVoice: true,
        manageComputers: true,
        managePrivateResources: true,
      },
      browserTabs,
    } as HostSnapshot;
    expect(f.memory.trim(f.state(), (route) => personalRouteInvalid(route, live))).toBeNull();
    browserTabs.applyTabs("g", { op: "begin", generation: "tabs" });
    browserTabs.applyTabs("g", { op: "end", revision: 0, count: 0, meta: {} });
    f.apply(f.memory.trim(f.state(), (route) => personalRouteInvalid(route, live)));
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

  it("preserves exact owner-view generation and never invents another tab", () => {
    const f = fixture();
    f.enter(task);
    const ownerView = {
      name: "WorkspaceBrowser",
      params: {
        deploymentId: "d",
        threadId: "task",
        machineId: "mac",
        appKey: "notes",
        viewId: "view",
        generation: 7,
        windowId: 123,
      },
    };
    f.push(ownerView);
    f.enter(channel);
    f.resume("tasks");
    expect(f.state().routes.at(-1)?.params).toEqual(ownerView.params);
    const unknown = {
      threadLookups: {},
      deploymentId: "d",
      connection: "connected",
      session: "authenticated",
      can: {},
      machines: [{ id: "mac", computerUse: { sessions: [] } }],
    } as unknown as HostSnapshot;
    expect(f.memory.trim(f.state(), (route) => personalRouteInvalid(route, unknown))).toBeNull();
    const replaced = {
      ...unknown,
      machines: [
        {
          id: "mac",
          computerUse: {
            ownerViews: [{ viewId: "view", generation: 8, state: "live" }],
            sessions: [],
          },
        },
      ],
    } as unknown as HostSnapshot;
    f.apply(f.memory.trim(f.state(), (route) => personalRouteInvalid(route, replaced)));
    expect(f.state().routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
  });
});
