import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { TriggerSummary } from "@opensteer/triggers";
import { MockHostClient } from "../mock/mock-host-client.js";
import { HostClientRequestError, type HostClient, type HostSnapshot } from "./client.js";
import { unwrapRpcResult } from "./host-session-client.js";
import { scheduleDetail, scheduleList, scheduleTiming, schedulesClient } from "./schedules.js";
import { describeRepeating, runOutcome } from "./automation-presentation.js";

const mocks: MockHostClient[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.dispose();
});
function fixture() {
  const mock = new MockHostClient({ latencyMs: 0, now: () => new Date("2026-11-01T12:00:00Z") });
  mocks.push(mock);
  let snapshot: HostSnapshot = { ...mock.getSnapshot(), connection: "connected" };
  const listeners = new Set<() => void>();
  const list = vi.fn(mock.rpc["triggers.list"]);
  const get = vi.fn(mock.rpc["triggers.get"]);
  const dispatch = vi.fn(mock.dispatch.bind(mock));
  const client = {
    getSnapshot: () => snapshot,
    subscribe: (f: () => void) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    rpc: { "triggers.list": list, "triggers.get": get },
    dispatch,
  } as unknown as HostClient;
  return {
    mock,
    client,
    list,
    get,
    dispatch,
    snapshot: () => snapshot,
    emit: (patch: Partial<HostSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const f of listeners) f();
    },
  };
}
async function ready<T>(get: () => { status: string; data: T | null }) {
  await vi.waitFor(() => expect(get().status, "schedule read never became ready").toBe("ready"), {
    timeout: 1000,
  });
  return get().data!;
}

describe("schedules", () => {
  it("uses the existing realistic mock, orders schedules before events and paused, and resolves Chat", async () => {
    const f = fixture();
    const summaries = unwrapRpcResult(await f.mock.rpc["triggers.list"]({})).triggers;
    expect(scheduleList([], f.snapshot())).toEqual([]);
    const items = scheduleList(summaries, f.snapshot());
    expect(items.length).toBeGreaterThan(5);
    expect(items[0]?.nextFireAt).not.toBeNull();
    expect(items.at(-1)?.status).toBe("paused");
    expect(items.find((i) => i.anchor.home)?.anchor).toMatchObject({
      title: "Chat",
      visible: true,
    });
    expect(items.find((i) => i.name === "Inbox watcher")).toMatchObject({
      kind: "watch",
      statusWord: "Paused by Opensteer",
      nextFireAt: null,
    });
    expect(
      items.find((i) => i.latestOccurrence?.status === "failed")?.latestOccurrence?.error,
    ).toBeTruthy();
    const hidden = { ...summaries[0]!, anchorThreadId: createId("thread") };
    expect(scheduleList([hidden], f.snapshot())[0]?.anchor).toMatchObject({
      title: "Unavailable thread",
      visible: false,
      mark: { icon: null, color: null },
    });
  });
  it("does no eager reads, bounds many rows to the Host's 100 cap, and stops when hidden", async () => {
    const f = fixture();
    const store = schedulesClient(f.client);
    expect(f.list).not.toHaveBeenCalled();
    const seed = unwrapRpcResult(await f.mock.rpc["triggers.list"]({})).triggers[0]!;
    const many: TriggerSummary[] = Array.from({ length: 100 }, (_, i) => ({
      ...seed,
      id: createId("trigger"),
      name: `Schedule ${i}`,
    }));
    f.list.mockResolvedValue({ ok: true, data: { triggers: many } });
    const stop = store.list.subscribe(() => {});
    expect(await ready(store.list.getSnapshot)).toHaveLength(100);
    stop();
    f.emit({ triggerRevision: 1 });
    expect(f.list).toHaveBeenCalledTimes(1);
    const again = store.list.subscribe(() => {});
    await ready(store.list.getSnapshot);
    expect(f.list).toHaveBeenCalledTimes(2);
    again();
  });
  it.each([
    ["list", "user"],
    ["detail", "user"],
    ["list", "sign-out/sign-in"],
    ["detail", "sign-out/sign-in"],
    ["list", "deployment"],
    ["detail", "deployment"],
  ] as const)(
    "drops cached %s before render after an unobserved %s change",
    async (kind, change) => {
      const f = fixture();
      const store = schedulesClient(f.client);
      const summary = unwrapRpcResult(await f.mock.rpc["triggers.list"]({})).triggers[0]!;
      const resource = kind === "list" ? store.list : store.detail(summary.id);
      const stop = resource.subscribe(() => {});
      await vi.waitFor(
        () =>
          expect(resource.getSnapshot().status, "reader A's schedules never loaded").toBe("ready"),
        { timeout: 1000 },
      );
      const previous = resource.getSnapshot().data;
      expect(previous).not.toBeNull();
      stop();
      if (change === "user") {
        f.emit({ user: { ...f.snapshot().user!, id: createId("user") } });
      } else if (change === "deployment") {
        f.emit({ deploymentId: createId("deployment") });
      } else {
        const user = f.snapshot().user;
        f.emit({ session: "authentication-required", user: null });
        f.emit({ session: "authenticated", user });
      }
      f.list.mockResolvedValue({ ok: true, data: { triggers: [] } });
      const detail = unwrapRpcResult(await f.mock.rpc["triggers.get"]({ triggerId: summary.id }));
      f.get.mockResolvedValue({
        ok: true,
        data: { ...detail, trigger: { ...detail.trigger, name: "Current reader's schedule" } },
      });
      // React reads the snapshot during render, before it installs the subscription.
      expect(resource.getSnapshot()).toMatchObject({ status: "loading", data: null });
      const seen: unknown[] = [];
      const again = resource.subscribe(() => seen.push(resource.getSnapshot().data));
      expect(resource.getSnapshot()).toMatchObject({ status: "loading", data: null });
      expect(seen.every((data) => data === null)).toBe(true);
      await vi.waitFor(
        () =>
          expect(resource.getSnapshot().status, "reader B's schedules never loaded").toBe("ready"),
        { timeout: 1000 },
      );
      expect(seen).not.toContainEqual(previous);
      expect(resource.getSnapshot().data).not.toEqual(previous);
      again();
    },
  );
  it("rereads and fences pending answers when the Deployment changes for the same user", async () => {
    const f = fixture();
    const resource = schedulesClient(f.client).list;
    const stop = resource.subscribe(() => {});
    await ready(resource.getSnapshot);
    const oldAnswer = {
      ok: true as const,
      data: {
        triggers: unwrapRpcResult(await f.mock.rpc["triggers.list"]({})).triggers,
      },
    };
    let finish!: (value: Awaited<ReturnType<typeof f.list>>) => void;
    f.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = resource.refresh();
    f.list.mockResolvedValue({ ok: true, data: { triggers: [] } });
    f.emit({ deploymentId: createId("deployment") });
    expect(resource.getSnapshot()).toMatchObject({ status: "loading", data: null });
    expect(await ready(resource.getSnapshot)).toEqual([]);
    finish(oldAnswer);
    await pending;
    expect(resource.getSnapshot().data).toEqual([]);
    stop();
  });
  it("refreshes on revision and reconnect, ignores stale answers, and does not read for streamed text", async () => {
    const f = fixture();
    const store = schedulesClient(f.client);
    let finishOld!: (value: Awaited<ReturnType<typeof f.list>>) => void;
    f.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const stop = store.list.subscribe(() => {});
    f.emit({ connection: "offline" });
    expect(store.list.getSnapshot().status).toBe("offline");
    f.list.mockResolvedValue({ ok: true, data: { triggers: [] } });
    f.emit({ connection: "connected" });
    await ready(store.list.getSnapshot);
    finishOld({
      ok: true,
      data: { triggers: unwrapRpcResult(await f.mock.rpc["triggers.list"]({})).triggers },
    });
    await Promise.resolve();
    expect(store.list.getSnapshot().data).toEqual([]);
    f.emit({ transcripts: { ...f.snapshot().transcripts } });
    expect(f.list).toHaveBeenCalledTimes(2);
    f.emit({ triggerRevision: 1 });
    await ready(store.list.getSnapshot);
    expect(f.list).toHaveBeenCalledTimes(3);
    stop();
  });
  it("distinguishes an unsupported Host and errors from an honest empty list", async () => {
    const f = fixture();
    f.list.mockRejectedValue(
      new HostClientRequestError({ code: "not_found", status: 404, message: "Unknown RPC" }),
    );
    const store = schedulesClient(f.client);
    const stop = store.list.subscribe(() => {});
    await vi.waitFor(
      () => expect(store.list.getSnapshot().status, "old Host refusal missing").toBe("unavailable"),
      { timeout: 1000 },
    );
    expect(store.list.getSnapshot().data).toBeNull();
    f.list.mockRejectedValue(new Error("Unable to reach Host"));
    await expect(store.list.refresh()).rejects.toThrow("Unable to reach Host");
    expect(store.list.getSnapshot().status).toBe("error");
    f.list.mockResolvedValue({ ok: true, data: { triggers: [] } });
    await store.list.refresh();
    expect(store.list.getSnapshot()).toEqual({ status: "ready", data: [], error: null });
    stop();
  });
  it("reads definition, failures and downstream replies, and confirms actions through Host state", async () => {
    const f = fixture();
    const summaries = unwrapRpcResult(await f.mock.rpc["triggers.list"]({})).triggers;
    const summary = summaries.find((s) => s.name === "Morning email summary")!;
    const wire = unwrapRpcResult(await f.mock.rpc["triggers.get"]({ triggerId: summary.id }));
    const detail = scheduleDetail(wire, f.snapshot());
    expect(detail.item.timing).toMatch(/8:00/);
    expect(detail.occurrences[0]?.outcome).toBe("Opensteer replied in Chat");
    expect(detail.occurrences.find((o) => o.occurrence.status === "failed")?.error).toMatch(
      /Gmail/,
    );
    const store = schedulesClient(f.client);
    const first = store.act(summary.id, "pause");
    expect(store.act(summary.id, "pause")).toBe(first);
    expect((await first).item.status).toBe("paused");
    expect((await store.act(summary.id, "resume")).item.status).toBe("active");
    await store.act(summary.id, "run");
    expect(f.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "trigger.run", idempotencyKey: expect.any(String) }),
    );
    f.emit({ network: "offline" });
    await expect(store.act(summary.id, "pause")).rejects.toThrow("Connect to the Host");
    expect(f.dispatch).toHaveBeenCalledTimes(3);
  });
  it("reuses the command key after an unknown outcome", async () => {
    const f = fixture();
    const summary = unwrapRpcResult(await f.mock.rpc["triggers.list"]({})).triggers[0]!;
    f.dispatch.mockRejectedValueOnce(new Error("Lost answer"));
    const store = schedulesClient(f.client);
    await expect(store.act(summary.id, "pause")).rejects.toThrow("Lost answer");
    const command = f.dispatch.mock.calls[0]![0];
    if (!("idempotencyKey" in command)) throw new Error("Command identity missing");
    const key = command.idempotencyKey;
    await store.act(summary.id, "pause");
    expect(f.dispatch.mock.calls[1]![0]).toMatchObject({ idempotencyKey: key });
  });
  it.each(["dispatch", "confirmation"])(
    "reports an unknown run after a lost %s without resending",
    async (failure) => {
      const f = fixture();
      const summary = unwrapRpcResult(await f.mock.rpc["triggers.list"]({})).triggers[0]!;
      const store = schedulesClient(f.client);
      if (failure === "dispatch") {
        f.dispatch.mockImplementationOnce(async (command) => {
          await f.mock.dispatch(command);
          throw new Error("Lost answer");
        });
      } else f.get.mockRejectedValueOnce(new Error("Lost confirmation"));
      await expect(store.act(summary.id, "run")).rejects.toThrow(
        "Couldn't confirm the run started — check Recent runs",
      );
      expect(f.dispatch).toHaveBeenCalledTimes(1);
      expect(store.detail(summary.id).getSnapshot().status).toBe("ready");
      const first = f.dispatch.mock.calls[0]![0];
      await store.act(summary.id, "run");
      expect(f.dispatch).toHaveBeenCalledTimes(2);
      expect(f.dispatch.mock.calls[1]![0]).not.toMatchObject({
        idempotencyKey: "idempotencyKey" in first ? first.idempotencyKey : null,
      });
    },
  );
  it("refreshes visible detail on run lifecycle changes and fences reads on sign-out", async () => {
    const f = fixture();
    const summary = unwrapRpcResult(await f.mock.rpc["triggers.list"]({})).triggers[0]!;
    const resource = schedulesClient(f.client).detail(summary.id);
    const stop = resource.subscribe(() => {});
    await ready(resource.getSnapshot);
    const wire = unwrapRpcResult(await f.mock.rpc["triggers.get"]({ triggerId: summary.id }));
    let finish!: (value: Awaited<ReturnType<typeof f.get>>) => void;
    f.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.emit({
      threads: f
        .snapshot()
        .threads.map((thread, i) =>
          i === 0
            ? { ...thread, status: thread.status === "running" ? "idle" : "running" }
            : thread,
        ),
    });
    expect(f.get).toHaveBeenCalledTimes(2);
    f.emit({ session: "authentication-required", user: null });
    finish({ ok: true, data: wire });
    await Promise.resolve();
    expect(resource.getSnapshot().data).toBeNull();
    stop();
  });
  it("keeps cron wall time and its timezone across DST, and describes one-shot and frequent cron timing", () => {
    const cron = { kind: "cron" as const, expression: "0 8 * * 1-5", timezone: "Pacific/Auckland" };
    expect(describeRepeating(cron)).toMatch(/8:00/);
    expect(describeRepeating(cron)).toMatch(/New Zealand|Auckland/);
    expect(
      scheduleTiming({
        kind: "schedule",
        schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
      }),
    ).toMatch(/15 minutes/);
    const before = scheduleTiming({
      kind: "schedule",
      schedule: { kind: "at", at: "2026-11-01T05:30:00Z" },
    });
    const after = scheduleTiming({
      kind: "schedule",
      schedule: { kind: "at", at: "2026-11-01T06:30:00Z" },
    });
    expect(before).toMatch(/^Once,/);
    expect(after).toMatch(/\(.+\)$/);
    expect(before).not.toBe(after);
    expect(
      runOutcome({ status: "failed" } as Parameters<typeof runOutcome>[0], null, null, 0),
    ).toBe("Failed");
  });
});
