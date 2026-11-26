import { DeviceIdSchema } from "@opensteer/core";
import { createId, TabIdSchema, WindowIdSchema, type Tab } from "@opensteer/core";
import type { IntegrationConnectionSummary } from "@opensteer/integration-core/models";
import { describe, expect, it, vi } from "vitest";
import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import type { NativeTargetAcquiredHandler, TabServicePort } from "../../tabs/ports.js";
import { bindNativeTab, type NativeTabBindingOptions } from "./native-tab-binding.js";
import { NativeTabTargets } from "../native-tab-targets.js";

const computerId = createId("runner");
const ownerId = createId("user");
const tabId = TabIdSchema.parse("tab_fixture");
const windowId = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000001");
const app = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
const claims: RunToolScope = {
  aud: "opensteer-run-tools",
  bindingGeneration: 1,
  environmentId: createId("environment"),
  requestedBy: ownerId,
  runId: createId("run"),
  runnerBootId: "boot",
  runnerId: computerId,
  threadId: createId("thread"),
  exp: 100,
  iat: 1,
  iss: "opensteer-host",
  jti: "token",
};
const tab: Tab = {
  tabId,
  kind: "window",
  title: "Note",
  appName: "Notes",
  bundleId: app.bundleId,
  computer: { computerId: DeviceIdSchema.parse(computerId), name: "Mac" },
  groupId: null,
  state: "asleep",
  openedBy: "person",
  usedBy: [],
  createdAt: "2026-11-15T00:00:00Z",
  updatedAt: "2026-11-15T00:00:00Z",
};
const connection = {
  id: "connection",
  definitionId: "macos-app",
  computer: { runnerId: computerId, app, blockedAt: null },
} as unknown as IntegrationConnectionSummary;

describe("native tab binding", () => {
  it("returns a visible target's blocker before binding and keeps authorization masking", async () => {
    const blocked = {
      code: "access_required",
      message: "Pixel needs access for this task.",
      next: 'Use app_access_request {computerId:"rnr_pixel", access:"read-write", reason:"Check calendar"}.',
    };
    const options: NativeTabBindingOptions = {
      selfDeviceId: async (id) => DeviceIdSchema.parse(id),
      tabs: {
        get: async () => ({ ...tab, kind: "phone" }) as Tab,
        authorizeBind: async () => undefined,
      },
      lookup: async () => ({ kind: "phone", computerId, tabGeneration: 1 }),
      connections: async () => [],
      blocked: async () => blocked,
      bind: vi.fn(),
    };
    await expect(bindNativeTab(options, claims, tabId)).rejects.toMatchObject({
      ...blocked,
      code: "forbidden",
      reason: blocked.code,
    });
    options.tabs.authorizeBind = async () => {
      throw new Error("concealed");
    };
    await expect(bindNativeTab(options, claims, tabId)).rejects.toThrow("concealed");
  });
  it("binds the exact existing window and rechecks its tab", async () => {
    let open = true;
    let tabGeneration = 1;
    const tabs: Pick<TabServicePort, "get" | "authorizeBind"> = {
      get: async () => tab,
      authorizeBind: async () => {
        if (!open) throw new Error("not_found");
      },
    };
    const bind = vi.fn<NativeTabBindingOptions["bind"]>(
      async (_connection, target, existingTab) => {
        expect(target).toMatchObject({ windowId });
        expect(existingTab.tabId).toBe(tabId);
        await existingTab.authorize();
        return {
          value: {
            tabId: existingTab.tabId,
            window: { windowId, title: "Note", ref: "ref", focused: true },
          },
        };
      },
    );
    const options = {
      selfDeviceId: async (id: unknown) => DeviceIdSchema.parse(id),
      tabs,
      lookup: async () => ({ kind: "window" as const, computerId, windowId, app, tabGeneration }),
      connections: async () => [connection],
      bind,
    };
    expect((await bindNativeTab(options, claims, tabId)).value).toEqual({
      kind: "window",
      connectionId: "connection",
      tabId,
      window: { windowId, title: "Note", ref: "ref" },
    });
    expect(bind).toHaveBeenCalledOnce();
    options.connections = async () => {
      tabGeneration++;
      return [connection];
    };
    await expect(bindNativeTab(options, claims, tabId)).rejects.toThrow("changed while binding");
    expect(bind).toHaveBeenCalledOnce();
    open = false;
    await expect(bindNativeTab(options, claims, tabId)).rejects.toThrow("not_found");
    expect(bind).toHaveBeenCalledOnce();
  });

  it("projects window state without blocking on remote probes and retains exact unavailable reasons", async () => {
    let now = 1_000;
    const firstProbe = Promise.withResolvers<{
      windowId: string | null;
      app: typeof app | null;
      title: string | null;
      unavailableReason: string | null;
    }>();
    const queryWindow = vi.fn(() => firstProbe.promise);
    const views = {
      list: vi.fn(async () => []),
      openForTab: vi.fn(),
      closeTabViews: vi.fn(async () => undefined),
    };
    const onWindowStateChanged = vi.fn();
    const targets = new NativeTabTargets({
      views,
      connections: async () => [connection],
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
      now: () => now,
      windowRefreshTtlMs: 30_000,
      onWindowStateChanged,
    });
    // Never blocks on a hanging remote queryWindow, and deduplicates concurrent probes.
    await expect(
      Promise.all([
        targets.windowState(ownerId, computerId, windowId, app),
        targets.windowState(ownerId, computerId, windowId, app),
      ]),
    ).resolves.toEqual([
      { state: "asleep", usedBy: [] },
      { state: "asleep", usedBy: [] },
    ]);
    expect(queryWindow).toHaveBeenCalledTimes(1);
    expect(onWindowStateChanged).not.toHaveBeenCalled();

    // Once the background probe finishes with window-closed, it notifies and projects the exact reason.
    firstProbe.resolve({
      windowId: null,
      app: null,
      title: null,
      unavailableReason: "window-closed",
    });
    await vi.waitFor(() => {
      expect(onWindowStateChanged).toHaveBeenCalledWith(ownerId, computerId, windowId);
    });
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toMatchObject({
      state: "unavailable",
      unavailableCode: "window-closed",
      unavailableReason: "Window closed",
    });
    // Within TTL, no redundant remote probe is started.
    expect(queryWindow).toHaveBeenCalledTimes(1);

    // After TTL expires, background refresh updates to window-identity-lost without blocking reads.
    now += 30_000;
    queryWindow.mockResolvedValueOnce({
      windowId: null,
      app: null,
      title: null,
      unavailableReason: "window-identity-lost",
    });
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toMatchObject({
      unavailableCode: "window-closed",
    });
    await vi.waitFor(() => {
      expect(onWindowStateChanged).toHaveBeenCalledTimes(2);
    });
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toMatchObject({
      unavailableCode: "window-identity-lost",
    });
    expect(views.openForTab).not.toHaveBeenCalled();

    const acquired = vi.fn<NativeTargetAcquiredHandler>(async () => tabId);
    const disconnect = targets.onTargetAcquired(acquired);
    expect(
      await targets.acquired({
        ownerId,
        runClaims: claims,
        computerId,
        kind: "window",
        windowId,
        membershipRevision: 0,
        key: "acquire",
      }),
    ).toBe(tabId);
    expect(acquired).toHaveBeenCalledOnce();
    disconnect();
    await expect(
      targets.acquired({
        ownerId,
        runClaims: claims,
        computerId,
        kind: "phone",
        membershipRevision: 0,
        key: "acquire2",
      }),
    ).rejects.toThrow("unavailable");
  });

  it("fences stale probes across forgetComputer, observes view changes, and enforces local app revocation", async () => {
    let approved = true;
    const staleProbe = Promise.withResolvers<{
      windowId: string | null;
      app: typeof app | null;
      title: string | null;
      unavailableReason: string | null;
    }>();
    const queryWindow = vi.fn(() => staleProbe.promise);
    const onWindowStateChanged = vi.fn();
    const targets = new NativeTabTargets({
      views: {
        list: async () => [],
        openForTab: vi.fn(),
        closeTabViews: async () => undefined,
      },
      connections: async () => (approved ? [connection] : []),
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
      onWindowStateChanged,
    });

    // Starts probe at generation 0.
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toEqual({
      state: "asleep",
      usedBy: [],
    });
    expect(queryWindow).toHaveBeenCalledTimes(1);

    // Computer disconnects/reconnects: generation advances, stale probe result must be ignored.
    targets.forgetComputer(computerId);
    staleProbe.resolve({
      windowId: null,
      app: null,
      title: null,
      unavailableReason: "window-closed",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onWindowStateChanged).not.toHaveBeenCalled();

    // Observing an unavailable view updates state immediately without waiting on queryWindow.
    expect(
      targets.observeView({
        machineId: DeviceIdSchema.parse(computerId),
        target: { kind: "app", app, windowId },
        state: "unavailable",
        unavailableReason: "window-closed",
      } as unknown as import("@opensteer/protocol").ComputerView),
    ).toBe(true);
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toMatchObject({
      state: "unavailable",
      unavailableCode: "window-closed",
    });
    expect(queryWindow).toHaveBeenCalledTimes(1);

    // Observing a ready view restores live state immediately.
    expect(
      targets.observeView({
        machineId: DeviceIdSchema.parse(computerId),
        target: { kind: "app", app, windowId },
        state: "ready",
        unavailableReason: null,
      } as unknown as import("@opensteer/protocol").ComputerView),
    ).toBe(true);
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toEqual({
      state: "asleep",
      usedBy: [],
    });

    // Local app revocation takes effect synchronously without any remote probe.
    approved = false;
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toMatchObject({
      state: "unavailable",
      unavailableCode: "access-denied",
    });
  });

  it("keeps confirmed unavailable windows unavailable while tasks hold them and prevents stale probes from overwriting newer observations", async () => {
    const staleProbe = Promise.withResolvers<{
      windowId: string | null;
      app: typeof app | null;
      title: string | null;
      unavailableReason: string | null;
    }>();
    const queryWindow = vi.fn(() => staleProbe.promise);
    const onWindowStateChanged = vi.fn();
    const targets = new NativeTabTargets({
      views: {
        list: async () => [],
        openForTab: vi.fn(),
        closeTabViews: async () => undefined,
      },
      connections: async () => [connection],
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [{ taskId: claims.threadId }],
      phoneUnavailable: () => null,
      onWindowStateChanged,
    });

    // Starts background probe while a task holds the window.
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toEqual({
      state: "open",
      usedBy: [{ taskId: claims.threadId }],
    });
    expect(queryWindow).toHaveBeenCalledTimes(1);

    // A ready owner view observes the window as live while the earlier probe is still pending.
    targets.observeView({
      machineId: DeviceIdSchema.parse(computerId),
      target: { kind: "app", app, windowId },
      state: "ready",
      unavailableReason: null,
    } as unknown as import("@opensteer/protocol").ComputerView);

    // The earlier probe later fails; it must NOT overwrite the newer live observation.
    staleProbe.reject(new Error("timed out"));
    await Promise.resolve();
    await Promise.resolve();
    expect(onWindowStateChanged).not.toHaveBeenCalled();
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toEqual({
      state: "open",
      usedBy: [{ taskId: claims.threadId }],
    });

    // A confirmed window-closed observation must still project unavailable even while usedBy is non-empty.
    targets.observeView({
      machineId: DeviceIdSchema.parse(computerId),
      target: { kind: "app", app, windowId },
      state: "unavailable",
      unavailableReason: "window-closed",
    } as unknown as import("@opensteer/protocol").ComputerView);
    await expect(targets.windowState(ownerId, computerId, windowId, app)).resolves.toMatchObject({
      state: "unavailable",
      unavailableCode: "window-closed",
      unavailableReason: "Window closed",
    });
  });
});

it.each(["paused", "protected"] as const)(
  "projects a phone's %s view refusal until a live view is ready",
  async (reason) => {
    const phoneConnection = { ...connection, definitionId: "android-phone" };
    let ready = false;
    const view = {
      target: { kind: "phone", display: "main" },
      state: "unavailable",
      unavailableReason: reason,
    } as unknown as import("@opensteer/protocol").ComputerView;
    const targets = new NativeTabTargets({
      views: {
        list: async () =>
          ready ? [view, { ...view, state: "ready", unavailableReason: null }] : [view],
        openForTab: vi.fn(),
        closeTabViews: async () => {},
      },
      connections: async () => [phoneConnection],
      owns: async () => true,
      connected: () => true,
      queryWindow: vi.fn(),
      users: () => [],
      phoneUnavailable: () => null,
    });
    expect(await targets.phoneState(ownerId, computerId)).toMatchObject({
      state: "unavailable",
      unavailableCode: reason,
    });
    ready = true;
    expect(await targets.phoneState(ownerId, computerId)).toMatchObject({ state: "open" });
  },
);

describe("NativeTabTargets.currentWindow", () => {
  it("takes the app's shown window from its own list, resolves it exactly, and never launches it", async () => {
    const minimized = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000002");
    let listed = [
      { windowId: minimized, title: "Old", minimized: true },
      { windowId, title: "After relaunch" },
    ];
    const windows = vi.fn(async () => listed);
    const queryWindow = vi.fn(async (_computer: unknown, target: unknown) => ({
      windowId: (target as { windowId: string }).windowId,
      app,
      title: "After relaunch",
      unavailableReason: null,
    }));
    const targets = new NativeTabTargets({
      views: { list: async () => [], openForTab: vi.fn(), closeTabViews: vi.fn(), windows },
      connections: async () => [connection],
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
    });
    await expect(targets.currentWindow(ownerId, computerId, app)).resolves.toMatchObject({
      windowId,
      title: "After relaunch",
    });
    expect(windows).toHaveBeenCalledWith(ownerId, computerId, app);
    expect(queryWindow).toHaveBeenCalledWith(computerId, { windowId });
    // A quit app lists no window: nothing is resolved by bundle, so nothing launches it.
    listed = [];
    await expect(targets.currentWindow(ownerId, computerId, app)).resolves.toBeNull();
    expect(queryWindow).toHaveBeenCalledTimes(1);
  });
});

describe("NativeTabTargets.windowStates batching and observed cache bounding", () => {
  it("batches owns, connections, and views.list once per computer across multiple window tabs", async () => {
    const computerA = createId("runner");
    const computerB = createId("runner");
    const winA1 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000011");
    const winA2 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000012");
    const winB1 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000013");
    const tabA1 = TabIdSchema.parse("tab_batch_a1");
    const tabA2 = TabIdSchema.parse("tab_batch_a2");
    const tabB1 = TabIdSchema.parse("tab_batch_b1");
    const connA = {
      id: "conn-a",
      definitionId: "macos-app",
      computer: { runnerId: computerA, app, blockedAt: null },
    } as unknown as IntegrationConnectionSummary;
    const connB = {
      id: "conn-b",
      definitionId: "macos-app",
      computer: { runnerId: computerB, app, blockedAt: null },
    } as unknown as IntegrationConnectionSummary;
    const owns = vi.fn(async () => true);
    const connections = vi.fn(async () => [connA, connB]);
    const listViews = vi.fn(async (_owner: unknown, targetComputer: unknown) =>
      targetComputer === computerA
        ? [
            {
              target: { kind: "app", app, windowId: winA1 },
              state: "ready",
              unavailableReason: null,
            },
          ]
        : [],
    );
    const queryWindow = vi.fn(async () => ({
      windowId: winA2,
      app,
      title: "Note",
      unavailableReason: null,
    }));
    const targets = new NativeTabTargets({
      views: {
        list: listViews as unknown as ConstructorParameters<
          typeof NativeTabTargets
        >[0]["views"]["list"],
        openForTab: vi.fn(),
        closeTabViews: vi.fn(async () => undefined),
      },
      connections,
      owns,
      connected: (id) => id === computerA,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
    });

    const states = await targets.windowStates(ownerId, [
      { tabId: tabA1, computerId: computerA, windowId: winA1, app },
      { tabId: tabA2, computerId: computerA, windowId: winA2, app },
      { tabId: tabB1, computerId: computerB, windowId: winB1, app },
    ]);

    expect(owns).toHaveBeenCalledTimes(2);
    expect(connections).toHaveBeenCalledTimes(1);
    expect(listViews).toHaveBeenCalledTimes(1);
    expect(listViews).toHaveBeenCalledWith(ownerId, computerA);
    expect(states.get(tabA1)).toEqual({ state: "open", usedBy: [] });
    expect(states.get(tabA2)).toEqual({ state: "asleep", usedBy: [] });
    expect(states.get(tabB1)).toMatchObject({
      state: "unavailable",
      unavailableCode: "computer-offline",
    });
  });

  it("caps observed window cache entries at maxObservedWindows", async () => {
    const queryWindow = vi.fn(async () => ({
      windowId: null,
      app: null,
      title: null,
      unavailableReason: "window-closed",
    }));
    const targets = new NativeTabTargets({
      views: {
        list: async () => [],
        openForTab: vi.fn(),
        closeTabViews: async () => undefined,
      },
      connections: async () => [connection],
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
      maxObservedWindows: 2,
    });
    const w1 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000101");
    const w2 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000102");
    const w3 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000103");
    for (const w of [w1, w2, w3]) {
      targets.observeView({
        machineId: DeviceIdSchema.parse(computerId),
        target: { kind: "app", app, windowId: w },
        state: "unavailable",
        unavailableReason: "window-closed",
      } as unknown as import("@opensteer/protocol").ComputerView);
    }
    // w2 and w3 are retained in cache (unavailable immediately, no queryWindow).
    await expect(targets.windowState(ownerId, computerId, w2, app)).resolves.toMatchObject({
      state: "unavailable",
      unavailableCode: "window-closed",
    });
    await expect(targets.windowState(ownerId, computerId, w3, app)).resolves.toMatchObject({
      state: "unavailable",
      unavailableCode: "window-closed",
    });
    expect(queryWindow).not.toHaveBeenCalled();
    // w1 was evicted by the cap, so reading it falls back to asleep and triggers a background probe.
    await expect(targets.windowState(ownerId, computerId, w1, app)).resolves.toEqual({
      state: "asleep",
      usedBy: [],
    });
    expect(queryWindow).toHaveBeenCalledTimes(1);
  });

  it("refreshes LRU order on read and bounds concurrent window probes per computer", async () => {
    const resolvers: Array<
      (value: {
        windowId: string | null;
        app: typeof app | null;
        title: string | null;
        unavailableReason: string | null;
      }) => void
    > = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const queryWindow = vi.fn(
      () =>
        new Promise<{
          windowId: string | null;
          app: typeof app | null;
          title: string | null;
          unavailableReason: string | null;
        }>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push((value) => {
            inFlight -= 1;
            resolve(value);
          });
        }),
    );
    const listViews = vi.fn(async () => []);
    const targets = new NativeTabTargets({
      views: {
        list: listViews,
        openForTab: vi.fn(),
        closeTabViews: async () => undefined,
      },
      connections: async () => [connection],
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
      maxObservedWindows: 2,
      maxConcurrentWindowProbesPerComputer: 2,
    });

    // LRU touch on read keeps w1 cached over w2 when w3 is inserted.
    const w1 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000201");
    const w2 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000202");
    const w3 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000203");
    for (const w of [w1, w2]) {
      targets.observeView({
        machineId: DeviceIdSchema.parse(computerId),
        target: { kind: "app", app, windowId: w },
        state: "unavailable",
        unavailableReason: "window-closed",
      } as unknown as import("@opensteer/protocol").ComputerView);
    }
    // Read w1 to move it to MRU before observing w3.
    await expect(targets.windowState(ownerId, computerId, w1, app)).resolves.toMatchObject({
      unavailableCode: "window-closed",
    });
    targets.observeView({
      machineId: DeviceIdSchema.parse(computerId),
      target: { kind: "app", app, windowId: w3 },
      state: "unavailable",
      unavailableReason: "window-closed",
    } as unknown as import("@opensteer/protocol").ComputerView);
    // w1 must still be cached (unavailable without probing); w2 was evicted.
    await expect(targets.windowState(ownerId, computerId, w1, app)).resolves.toMatchObject({
      unavailableCode: "window-closed",
    });
    expect(queryWindow).not.toHaveBeenCalled();

    // Unapproved apps skip views.list completely in both single and batch paths.
    listViews.mockClear();
    const unapprovedApp = { bundleId: "com.other.App", displayName: "Other", teamId: null };
    await expect(
      targets.windowState(ownerId, computerId, w1, unapprovedApp),
    ).resolves.toMatchObject({ state: "unavailable", unavailableCode: "access-denied" });
    expect(listViews).not.toHaveBeenCalled();

    // Queueing 4 fresh window probes must cap active concurrency at 2 and drain the rest.
    const probeWindows = [
      WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000301"),
      WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000302"),
      WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000303"),
      WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000304"),
    ];
    await targets.windowStates(
      ownerId,
      probeWindows.map((w, index) => ({
        tabId: TabIdSchema.parse(`tab_probe_${index}`),
        computerId,
        windowId: w,
        app,
      })),
    );
    expect(maxInFlight).toBe(2);
    expect(queryWindow).toHaveBeenCalledTimes(2);

    // Resolve the first two probes -> queued probes 3 and 4 start.
    resolvers
      .splice(0, 2)
      .forEach((resolve) =>
        resolve({ windowId: null, app: null, title: null, unavailableReason: "window-closed" }),
      );
    await vi.waitFor(() => expect(queryWindow).toHaveBeenCalledTimes(4));
    expect(maxInFlight).toBe(2);
    resolvers
      .splice(0)
      .forEach((resolve) =>
        resolve({ windowId: null, app: null, title: null, unavailableReason: "window-closed" }),
      );
  });

  it("notifies window recovery when a previously unavailable observation is evicted and later probes live", async () => {
    const w1 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000401");
    const w2 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000402");
    const w3 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000403");
    const onWindowStateChanged = vi.fn();
    const queryWindow = vi.fn(async () => ({
      windowId: w1,
      app,
      title: "Recovered Note",
      unavailableReason: null,
    }));
    const targets = new NativeTabTargets({
      views: {
        list: async () => [],
        openForTab: vi.fn(),
        closeTabViews: async () => undefined,
      },
      connections: async () => [connection],
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
      maxObservedWindows: 2,
      onWindowStateChanged,
    });

    // Observe w1 as unavailable, then evict it by filling capacity with w2 and w3.
    for (const w of [w1, w2, w3]) {
      targets.observeView({
        machineId: DeviceIdSchema.parse(computerId),
        target: { kind: "app", app, windowId: w },
        state: "unavailable",
        unavailableReason: "window-closed",
      } as unknown as import("@opensteer/protocol").ComputerView);
    }

    // Probing evicted w1 discovers it is live again; onWindowStateChanged must fire so warm catalogs recover.
    await targets.windowState(ownerId, computerId, w1, app);
    await vi.waitFor(() => {
      expect(onWindowStateChanged).toHaveBeenCalledWith(ownerId, computerId, w1);
    });
  });

  it("fences a stale in-flight probe and preserves recovery notifications even under heavy eviction churn", async () => {
    const w1 = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000501");
    const churnWindows = Array.from({ length: 6 }, (_, i) =>
      WindowIdSchema.parse(`win_00000000-0000-4000-8000-00000000051${i}`),
    );
    const staleProbe = Promise.withResolvers<{
      windowId: string | null;
      app: typeof app | null;
      title: string | null;
      unavailableReason: string | null;
    }>();
    const onWindowStateChanged = vi.fn();
    let calls = 0;
    const queryWindow = vi.fn(() => {
      calls += 1;
      if (calls === 1) return staleProbe.promise;
      return Promise.resolve({ windowId: w1, app, title: "Recovered", unavailableReason: null });
    });
    const targets = new NativeTabTargets({
      views: {
        list: async () => [],
        openForTab: vi.fn(),
        closeTabViews: async () => undefined,
      },
      connections: async () => [connection],
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
      maxObservedWindows: 1,
      onWindowStateChanged,
    });

    // Start a probe for w1 with no prior cached observation.
    await targets.windowState(ownerId, computerId, w1, app);
    expect(queryWindow).toHaveBeenCalledTimes(1);

    // Record window-closed for w1, then churn 6 other windows so eviction history overflows.
    for (const w of [w1, ...churnWindows]) {
      targets.observeView({
        machineId: DeviceIdSchema.parse(computerId),
        target: { kind: "app", app, windowId: w },
        state: "unavailable",
        unavailableReason: "window-closed",
      } as unknown as import("@opensteer/protocol").ComputerView);
    }

    // Complete staleProbe with a locked/live result; it must be fenced regardless of eviction churn.
    staleProbe.resolve({ windowId: null, app: null, title: null, unavailableReason: "locked" });
    await Promise.resolve();
    await Promise.resolve();
    expect(onWindowStateChanged).not.toHaveBeenCalled();

    // A fresh post-churn probe discovering w1 is live must still emit a recovery notification.
    await targets.windowState(ownerId, computerId, w1, app);
    await vi.waitFor(() => {
      expect(onWindowStateChanged).toHaveBeenCalledWith(ownerId, computerId, w1);
    });
  });

  it("supersedes pending probes on resolveWindow and scopes eviction overflow per computer", async () => {
    const computerA = createId("runner");
    const computerB = createId("runner");
    const wA = WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000601");
    const churnB = Array.from({ length: 6 }, (_, i) =>
      WindowIdSchema.parse(`win_00000000-0000-4000-8000-00000000061${i}`),
    );
    const connA = {
      id: "conn-a",
      definitionId: "macos-app",
      computer: { runnerId: computerA, app, blockedAt: null },
    } as unknown as IntegrationConnectionSummary;
    const connB = {
      id: "conn-b",
      definitionId: "macos-app",
      computer: { runnerId: computerB, app, blockedAt: null },
    } as unknown as IntegrationConnectionSummary;
    const staleProbe = Promise.withResolvers<{
      windowId: string | null;
      app: typeof app | null;
      title: string | null;
      unavailableReason: string | null;
    }>();
    const onWindowStateChanged = vi.fn();
    let calls = 0;
    const queryWindow = vi.fn(() => {
      calls += 1;
      if (calls === 1) return staleProbe.promise;
      return Promise.resolve({ windowId: wA, app, title: "Live", unavailableReason: null });
    });
    const targets = new NativeTabTargets({
      views: {
        list: async () => [],
        openForTab: vi.fn(),
        closeTabViews: async () => undefined,
      },
      connections: async () => [connA, connB],
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
      maxObservedWindows: 1,
      onWindowStateChanged,
    });

    // Start background probe on computerA, then resolveWindow records wA live.
    await targets.windowState(ownerId, computerA, wA, app);
    await targets.resolveWindow(ownerId, computerA, { windowId: wA });

    // Stale probe completing with window-closed must NOT overwrite resolveWindow's live observation.
    staleProbe.resolve({
      windowId: null,
      app: null,
      title: null,
      unavailableReason: "window-closed",
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(targets.windowState(ownerId, computerA, wA, app)).resolves.toEqual({
      state: "asleep",
      usedBy: [],
    });
    expect(onWindowStateChanged).not.toHaveBeenCalled();

    // Observe wA unavailable, churn 6 unavailable windows on computerB, then forget computerB.
    targets.observeView({
      machineId: DeviceIdSchema.parse(computerA),
      target: { kind: "app", app, windowId: wA },
      state: "unavailable",
      unavailableReason: "window-closed",
    } as unknown as import("@opensteer/protocol").ComputerView);
    for (const w of churnB) {
      targets.observeView({
        machineId: DeviceIdSchema.parse(computerB),
        target: { kind: "app", app, windowId: w },
        state: "unavailable",
        unavailableReason: "window-closed",
      } as unknown as import("@opensteer/protocol").ComputerView);
    }
    targets.forgetComputer(computerB);

    // Forgetting computerB must NOT clear computerA's overflow flag; wA's live probe still notifies.
    await targets.windowState(ownerId, computerA, wA, app);
    await vi.waitFor(() => {
      expect(onWindowStateChanged).toHaveBeenCalledWith(ownerId, computerA, wA);
    });
  });
});
