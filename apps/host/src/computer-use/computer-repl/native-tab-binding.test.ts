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
