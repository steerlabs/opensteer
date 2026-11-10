import { afterEach, expect, it, vi } from "vitest";
import { createBrowserSessionId } from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { HostClient, HostSnapshot } from "./client.js";
import { WorkspaceTabActivations } from "./workspace-tab-activations.js";

type Result = NonNullable<Awaited<ReturnType<NonNullable<HostClient["activateWorkspaceTab"]>>>>;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture() {
  const seed = new MockHostClient({ latencyMs: 0 });
  let snapshot: HostSnapshot = {
    ...seed.getSnapshot(),
    connection: "connected",
    browserPlacements: seed.getSnapshot().browserPlacements.map((placement) => ({
      ...placement,
      available: true,
    })),
  };
  const group = snapshot.workspaceTabs!.find((value) => value.tabs?.length)!;
  const tabId = group.tabs![0]!.id;
  const result: Result = {
    type: "workspace.tab.activate",
    tabId,
    group,
    session: group.session,
    catalog: snapshot.browserSessions.find((session) => session.id === group.session.id)!
      .tabCatalog!,
  };
  seed.dispose();
  const listeners = new Set<() => void>();
  const error = new Error("The browser could not restore.");
  const dispatch = vi.fn(async (_tabId: string): Promise<Result> => {
    throw error;
  });
  const activations = new WorkspaceTabActivations({
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    apply: () => {},
    changed: () => {},
  });
  cleanups.push(() => {
    activations.dispose();
    expect(listeners.size).toBe(0);
  });
  return {
    activations,
    dispatch,
    error,
    group,
    result,
    tabId,
    publish(patch: Partial<HostSnapshot> = {}) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

it("remembers a failed opening across snapshot churn until a new opening starts", async () => {
  const f = fixture();
  const first = f.activations.activate(f.tabId, { opening: "selected" });
  await expect(first).rejects.toBe(f.error);
  for (let revision = 1; revision <= 40; revision++) {
    const sessionId = createBrowserSessionId();
    f.publish({
      connection: revision % 2 === 0 ? "connected" : "offline",
      workspaceTabs: [
        {
          ...f.group,
          revision: f.group.revision + revision,
          session: { ...f.group.session, id: sessionId },
          tabs: f.group.tabs!.map((tab) => ({ ...tab, sessionId })),
        },
      ],
    });
    await expect(f.activations.activate(f.tabId, { opening: "selected" })).rejects.toBe(f.error);
  }
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  await expect(f.activations.activate(f.tabId, { opening: "retry" })).rejects.toBe(f.error);
  await expect(f.activations.activate(f.tabId, { opening: "retry" })).rejects.toBe(f.error);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  await expect(f.activations.activate(f.tabId, { opening: "selected" })).rejects.toBe(f.error);
  expect(f.dispatch).toHaveBeenCalledTimes(3);
});

it("joins pending requests and remembers a failure for the latest opening", async () => {
  const f = fixture();
  const request = Promise.withResolvers<Result>();
  f.dispatch.mockReturnValueOnce(request.promise);
  const first = f.activations.activate(f.tabId, { opening: "first" });
  expect(f.activations.activate(f.tabId, { opening: "first" })).toBe(first);
  expect(f.activations.activate(f.tabId, { opening: "reselected" })).toBe(first);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  request.reject(f.error);
  await expect(first).rejects.toBe(f.error);
  await expect(f.activations.activate(f.tabId, { opening: "reselected" })).rejects.toBe(f.error);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it("does not remember success when the tab needs restoring again", async () => {
  const f = fixture();
  f.dispatch.mockResolvedValue(f.result);
  await expect(f.activations.activate(f.tabId, { opening: "selected" })).resolves.toBe(f.result);
  f.publish();
  await expect(f.activations.activate(f.tabId, { opening: "selected" })).resolves.toBe(f.result);
  await expect(f.activations.activate(f.tabId, { opening: "reselected" })).resolves.toBe(f.result);
  expect(f.dispatch).toHaveBeenCalledTimes(3);
});

it("forgets failure on viewer-scope change, including a change back", async () => {
  const f = fixture();
  await expect(f.activations.activate(f.tabId, { opening: "selected" })).rejects.toBe(f.error);
  f.publish({ session: "authentication-required" });
  f.publish({ session: "authenticated" });
  await expect(f.activations.activate(f.tabId, { opening: "selected" })).rejects.toBe(f.error);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});

it("forgets closed tabs but retains failure across omitted lineages and missing tabs", async () => {
  const f = fixture();
  const first = f.activations.activate(f.tabId, { opening: "selected" });
  await expect(first).rejects.toBe(f.error);
  f.publish({ workspaceTabs: [] });
  expect(f.activations.activate(f.tabId, { opening: "selected" })).toBe(first);
  const { tabs: _tabs, ...bounded } = f.group;
  f.publish({ workspaceTabs: [bounded] });
  expect(f.activations.activate(f.tabId, { opening: "selected" })).toBe(first);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  f.publish({ workspaceTabs: [{ ...f.group, tabs: [] }] });
  f.publish({ workspaceTabs: [f.group] });
  await expect(f.activations.activate(f.tabId, { opening: "selected" })).rejects.toBe(f.error);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});
