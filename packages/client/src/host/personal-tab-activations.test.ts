import { browserStoreFixture } from "../test-support/browser-snapshot.js";
import { groupSession } from "./browser-snapshot.js";
import type { BrowserGroupRow, BrowserTabRow } from "@opensteer/protocol/browser-tabs";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserSessionId } from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { HostClient, HostSnapshot } from "./client.js";
import { PersonalTabActivations } from "./personal-tab-activations.js";
import { withTimeout } from "@opensteer/shared/withTimeout";

type Result = NonNullable<Awaited<ReturnType<NonNullable<HostClient["activatePersonalTab"]>>>>;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture(resolved = () => true) {
  const seed = new MockHostClient({ latencyMs: 0 });
  let snapshot: HostSnapshot = {
    ...seed.getSnapshot(),
    connection: "connected",
    browserPlacements: seed.getSnapshot().browserPlacements.map((placement) => ({
      ...placement,
      available: true,
    })),
  };
  const group = seed.browserTabs
    .groups()
    .ids.map((id) => seed.browserTabs.group(id)!)
    .find(
      (group) =>
        seed.browserTabs.tabs(group.id).ids.length > 0 &&
        snapshot.browserPlacements.some(
          (placement) => placement.runnerId === group.placement.runnerId,
        ),
    )!;
  const rows = seed.browserTabs.sessionTabs(group.sessionId);
  const tabId = rows[0]!.id;
  snapshot = {
    ...snapshot,
    browserTabs: browserStoreFixture([group], [{ groupId: group.id, rows }]),
  };
  const result: Result = {
    type: "tab.activate",
    tabId,
    groupId: group.id,
    sessionId: group.sessionId,
    session: groupSession(group),
  };
  seed.dispose();
  const listeners = new Set<() => void>();
  const error = new Error("The browser could not restore.");
  const dispatch = vi.fn(async (_tabId: string): Promise<Result> => {
    throw error;
  });
  const activations = new PersonalTabActivations({
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    resolved,
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
    rows,
    store: () => snapshot.browserTabs!,
    result,
    tabId,
    publish(
      patch: Partial<HostSnapshot> & {
        groups?: readonly BrowserGroupRow[];
        rows?: readonly BrowserTabRow[];
        whole?: boolean;
      } = {},
    ) {
      const { groups, rows: nextRows, whole = true, ...metadata } = patch;
      snapshot = { ...snapshot, ...metadata };
      if (groups || nextRows)
        snapshot = {
          ...snapshot,
          browserTabs: browserStoreFixture(groups ?? [group], [
            { groupId: group.id, rows: nextRows ?? rows, complete: whole },
          ]),
        };
      for (const listener of listeners) listener();
    },
  };
}

it("finishes asleep activations on dispatch while plain activations still await a live row", async () => {
  const resolved = vi.fn(() => false);
  const f = fixture(resolved);
  f.dispatch.mockResolvedValue(f.result);
  const finish = (promise: Promise<Result | null>) =>
    withTimeout(promise, 1_000, {
      timeoutError: () => new Error("The asleep activation did not finish after dispatch"),
    });
  await expect(finish(f.activations.activate(f.tabId, { asleep: true }))).resolves.toBe(f.result);
  const plain = f.activations.activate(f.tabId);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  const settled = vi.fn();
  void plain.then(settled);
  await vi.waitFor(
    () => expect(resolved, "The plain activation never waited for its live row").toHaveBeenCalled(),
    { timeout: 1_000 },
  );
  expect(settled).not.toHaveBeenCalled();
  f.activations.dispose();
  await expect(finish(plain)).resolves.toBeNull();
});

it.each([
  { asleep: false, dispatched: false },
  { asleep: false, dispatched: true },
  { asleep: true, dispatched: false },
])(
  "an asleep activation replaces a pending activation (asleep: $asleep, dispatched: $dispatched)",
  async ({ asleep, dispatched }) => {
    const resolved = vi.fn(() => false);
    const f = fixture(resolved);
    const request = Promise.withResolvers<Result>();
    f.dispatch.mockReturnValueOnce(request.promise).mockResolvedValue(f.result);
    const first = f.activations.activate(f.tabId, asleep ? { asleep: true } : undefined);
    const settled = vi.fn();
    void first.then(settled);
    if (dispatched) {
      request.resolve(f.result);
      await vi.waitFor(
        () =>
          expect(resolved, "The plain activation never waited for its live row").toHaveBeenCalled(),
        { timeout: 1_000 },
      );
    }
    expect(settled).not.toHaveBeenCalled();
    const replacement = f.activations.activate(f.tabId, { asleep: true });
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    await expect(
      withTimeout(replacement, 1_000, {
        timeoutError: () => new Error("The asleep activation joined a pending activation"),
      }),
    ).resolves.toBe(f.result);
    request.resolve(f.result);
    await expect(
      withTimeout(first, 1_000, {
        timeoutError: () => new Error("The superseded activation did not finish"),
      }),
    ).resolves.toBeNull();
  },
);

it("remembers a failed opening across snapshot churn until a new opening starts", async () => {
  const f = fixture();
  const first = f.activations.activate(f.tabId, { opening: "selected" });
  await expect(first).rejects.toBe(f.error);
  for (let revision = 1; revision <= 40; revision++) {
    const sessionId = createBrowserSessionId();
    f.publish({
      connection: revision % 2 === 0 ? "connected" : "offline",
      groups: [{ ...f.group, sessionId }],
      rows: f.rows.map((tab) => ({ ...tab, sessionId })),
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
  f.publish({ groups: [] });
  expect(f.activations.activate(f.tabId, { opening: "selected" })).toBe(first);
  f.publish({ groups: [f.group], rows: [], whole: false });
  expect(f.activations.activate(f.tabId, { opening: "selected" })).toBe(first);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  f.publish({ groups: [f.group], rows: [] });
  f.publish({ groups: [f.group], rows: f.rows });
  await expect(f.activations.activate(f.tabId, { opening: "selected" })).rejects.toBe(f.error);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});

it("activates a sleeping keyed tab and retains committed membership through an interrupted resync", async () => {
  const f = fixture();
  f.publish({ rows: f.rows.map((tab) => ({ ...tab, state: "suspended", documentId: null })) });
  const request = Promise.withResolvers<Result>();
  f.dispatch.mockReturnValueOnce(request.promise);
  const activated = f.activations.activate(f.tabId);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  const store = f.store();
  const ids = store.tabs(f.group.id).ids;
  store.applyTabs(f.group.id, { op: "begin", generation: "interrupted" });
  store.applyTabs(f.group.id, { op: "rows", rows: [] });
  store.disconnected();
  f.publish();
  expect(store.tabs(f.group.id).ids).toBe(ids);
  expect(f.activations.ids).toEqual([f.tabId]);
  request.resolve(f.result);
  await expect(activated).resolves.toBe(f.result);
});
