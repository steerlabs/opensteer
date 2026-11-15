import { createId, TabIdSchema, WindowIdSchema, type Tab } from "@opensteer/core";
import type { IntegrationConnectionSummary } from "@opensteer/integration-core";
import { describe, expect, it, vi } from "vitest";
import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import type { TabServicePort, NativeTargetAcquiredHandler } from "../../tabs/ports.js";
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
  computer: { computerId, name: "Mac" },
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
  it("uses the private exact-window lookup and rechecks closure before acquisition", async () => {
    let open = true;
    let tabGeneration = 1;
    const tabs: Pick<TabServicePort, "get" | "authorizeShow"> = {
      get: async () => tab,
      authorizeShow: async () => {
        if (!open) throw new Error("not_found");
      },
    };
    const acquired = vi.fn<NativeTargetAcquiredHandler>(async () => tabId);
    const bind = vi.fn<NativeTabBindingOptions["bind"]>(
      async (_connection, target, beforeAcquired) => {
        expect(target).toMatchObject({ windowId });
        await beforeAcquired();
        await acquired({
          ownerId,
          runClaims: claims,
          computerId,
          kind: "window",
          windowId,
          key: "acquire",
        });
        return { value: { tabId, window: { windowId, title: "Note", ref: "ref", focused: true } } };
      },
    );
    const options = {
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
    expect(acquired).toHaveBeenCalledOnce();
    options.connections = async () => {
      tabGeneration++;
      return [connection];
    };
    await expect(bindNativeTab(options, claims, tabId)).rejects.toThrow("changed while binding");
    expect(bind).toHaveBeenCalledOnce();
    open = false;
    await expect(bindNativeTab(options, claims, tabId)).rejects.toThrow("not_found");
    expect(bind).toHaveBeenCalledOnce();
    expect(acquired).toHaveBeenCalledOnce();
  });

  it("retains exact unavailable reasons without opening a viewing lease", async () => {
    const queryWindow = vi.fn(async () => ({
      windowId: null,
      app: null,
      title: null,
      unavailableReason: "window-closed",
    }));
    const views = {
      list: vi.fn(async () => []),
      openForTab: vi.fn(),
      closeTabViews: vi.fn(async () => undefined),
    };
    const targets = new NativeTabTargets({
      views,
      connections: async () => [connection],
      owns: async () => true,
      connected: () => true,
      queryWindow,
      users: () => [],
      phoneUnavailable: () => null,
    });
    await expect(targets.windowState(ownerId, computerId, windowId)).resolves.toMatchObject({
      state: "unavailable",
      unavailableCode: "window-closed",
      unavailableReason: "Window closed",
    });
    queryWindow.mockResolvedValueOnce({
      windowId: null,
      app: null,
      title: null,
      unavailableReason: "window-identity-lost",
    });
    await expect(targets.windowState(ownerId, computerId, windowId)).resolves.toMatchObject({
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
        key: "acquire",
      }),
    ).toBe(tabId);
    expect(acquired).toHaveBeenCalledOnce();
    disconnect();
    await expect(
      targets.acquired({ ownerId, runClaims: claims, computerId, kind: "phone", key: "acquire2" }),
    ).rejects.toThrow("unavailable");
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
