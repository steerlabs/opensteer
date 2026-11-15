import {
  createId,
  TabAgentEventViewSchema,
  AppIdSchema,
  SequenceSchema,
  type App,
} from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { AppsList, appNoticeTitle } from "./apps.js";
import { foldTranscriptEvent } from "./transcript.js";
import { conversationRows, groupTranscriptEntries } from "./agent-activity-model.js";
it("restores one app at its latest publication point, idempotently, including conversation mode", () => {
  const event = TabAgentEventViewSchema.parse({
    type: "app.published",
    eventId: createId("event"),
    sequence: "1",

    threadId: createId("thread"),
    environmentId: createId("environment"),
    runId: createId("run"),
    createdAt: new Date().toISOString(),
    data: { appId: "app_11111111-1111-4111-8111-111111111111", version: 1, title: "Budget" },
  });
  if (event.type !== "app.published") throw new Error("Expected app publication");
  const first = foldTranscriptEvent([], event);
  expect(foldTranscriptEvent(first, event)).toEqual(first);
  expect(first[0]).toMatchObject({
    kind: "app",
    appId: event.data.appId,
    version: 1,
    title: "Budget",
    runId: event.runId,
  });
  const next = foldTranscriptEvent(first, {
    ...event,
    eventId: createId("event"),
    sequence: SequenceSchema.parse("2"),
    data: { ...event.data, version: 2 },
  });
  const rows = conversationRows(groupTranscriptEntries(next), {
    live: true,
    atComputer: () => false,
  });
  expect(rows.map((row) => row.group.kind)).toEqual(["app"]);
  expect(rows.map((row) => row.key)).toEqual(next.map((entry) => entry.id));
});

describe("AppsList", () => {
  const computerId = createId("runner");
  const app = (name: string, state: App["state"] = "running"): App => ({
    appId: AppIdSchema.parse("app_22222222-2222-4222-8222-222222222222"),
    name,
    kind: "server",
    state,
    localUrl: "http://127.0.0.1:50000",
    folder: "budget",
    start: "node server.js",
    computerId,
    taskId: null,
    version: 2,
    server: {
      desiredState: state === "stopped" ? "stopped" : "running",
      state,
      port: 50000,
      generation: 1,
      lastError: null,
    },
    createdAt: "2026-11-15T12:00:00.000Z",
    updatedAt: "2026-11-15T12:00:00.000Z",
  });
  function harness() {
    let revision = 0;
    const listeners = new Set<() => void>();
    const reads: { resolve: (apps: App[]) => void }[] = [];
    const client = {
      listApps: vi.fn(
        () => new Promise<App[]>((resolve) => reads.push({ resolve: (apps) => resolve(apps) })),
      ),
      renameApp: vi.fn(),
      startApp: vi.fn(),
      stopApp: vi.fn(),
      deleteApp: vi.fn(),
    };
    const list = new AppsList({
      client,
      revision: () => revision,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const invalidate = () => {
      revision++;
      notify();
    };
    return { list, client, reads, invalidate, notify };
  }
  const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve));

  it("reads only while shown and never lets an answer from before a change overwrite it", async () => {
    const { list, client, reads, invalidate, notify } = harness();
    expect(client.listApps).not.toHaveBeenCalled();
    const release = list.subscribe(() => {});
    expect(client.listApps).toHaveBeenCalledTimes(1);
    // A slow read on a busy stream: unrelated Host updates ask for nothing more.
    for (let index = 0; index < 20; index++) notify();
    expect(client.listApps).toHaveBeenCalledTimes(1);
    // Changes while it is out queue exactly one more read, sent once it answers.
    invalidate();
    invalidate();
    notify();
    expect(client.listApps).toHaveBeenCalledTimes(1);
    reads[0]!.resolve([app("Before")]);
    await vi.waitFor(() => expect(client.listApps).toHaveBeenCalledTimes(2));
    expect(list.state.apps).toBeNull();
    reads[1]!.resolve([app("After")]);
    await settled();
    expect(list.state.apps?.map((held) => held.name)).toEqual(["After"]);
    expect(list.state.loading).toBe(false);
    for (let index = 0; index < 20; index++) notify();
    expect(client.listApps).toHaveBeenCalledTimes(2);
    // Try again reads afresh, and joins a read already out for the same change.
    const reload = list.reload();
    expect(list.reload()).toBe(reload);
    expect(client.listApps).toHaveBeenCalledTimes(3);
    reads[2]!.resolve([app("Again")]);
    await reload;
    expect(list.state.apps?.map((held) => held.name)).toEqual(["Again"]);
    release();
    invalidate();
    expect(client.listApps).toHaveBeenCalledTimes(3);
  });

  it("keeps a newer read over a late action answer", async () => {
    const { list, client, reads, invalidate } = harness();
    list.subscribe(() => {});
    reads[0]!.resolve([app("Budget")]);
    await settled();
    let stopped!: (app: App) => void;
    client.stopApp.mockReturnValue(new Promise<App>((resolve) => (stopped = resolve)));
    const stopping = list.stop(app("Budget").appId);
    // Another device starts it again; this device rereads before its Stop answers.
    invalidate();
    const running = { ...app("Budget"), server: { ...app("Budget").server!, generation: 3 } };
    reads[1]!.resolve([running]);
    await settled();
    stopped(app("Budget", "stopped"));
    await expect(stopping).resolves.toBe(true);
    expect(list.state.apps).toEqual([running]);
    expect(client.listApps).toHaveBeenCalledTimes(2);
  });

  it("still says how a Delete ended after the Host stops listing its app", async () => {
    const { list, client, reads, invalidate } = harness();
    list.subscribe(() => {});
    reads[0]!.resolve([app("Budget")]);
    await settled();
    let fail!: (error: Error) => void;
    client.deleteApp.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const deleting = list.delete(app("Budget").appId);
    expect(list.state.notices).toEqual([]);
    invalidate();
    reads[1]!.resolve([]);
    await settled();
    const notice = { appId: app("Budget").appId, name: "Budget", action: "delete" };
    expect(list.state.notices).toEqual([{ ...notice, message: null }]);
    expect(appNoticeTitle(list.state.notices[0]!)).toBe("Deleting “Budget”…");
    fail(new Error("Its computer could not confirm the server stopped; deletion is pending."));
    await expect(deleting).resolves.toBe(false);
    expect(list.state.notices).toEqual([
      {
        ...notice,
        message: "Its computer could not confirm the server stopped; deletion is pending.",
      },
    ]);
    expect(appNoticeTitle(list.state.notices[0]!)).toBe("“Budget” could not be deleted");
    list.dismissFailure(app("Budget").appId);
    expect(list.state.notices).toEqual([]);
  });

  it("reports a failed Start and keeps the app stopped", async () => {
    const { list, client, reads } = harness();
    list.subscribe(() => {});
    reads[0]!.resolve([app("Budget", "stopped")]);
    await settled();
    let fail!: (error: Error) => void;
    client.startApp.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const started = list.start(app("Budget").appId);
    expect(list.state.pending.get(app("Budget").appId)).toBe("start");
    // A second action on the same app waits for the first instead of racing it.
    await expect(list.stop(app("Budget").appId)).resolves.toBe(false);
    fail(new Error("Port 50000 is in use."));
    await expect(started).resolves.toBe(false);
    expect(list.state.pending.size).toBe(0);
    expect(list.state.failures.get(app("Budget").appId)).toEqual({
      action: "start",
      message: "Port 50000 is in use.",
    });
    expect(list.state.apps?.[0]?.state).toBe("stopped");
  });

  it("applies a successful Stop and Delete to the shown list", async () => {
    const { list, client, reads } = harness();
    list.subscribe(() => {});
    reads[0]!.resolve([app("Budget")]);
    await settled();
    client.stopApp.mockResolvedValue(app("Budget", "stopped"));
    await expect(list.stop(app("Budget").appId)).resolves.toBe(true);
    expect(list.state.apps?.[0]?.state).toBe("stopped");
    client.deleteApp.mockResolvedValue(undefined);
    await expect(list.delete(app("Budget").appId)).resolves.toBe(true);
    expect(list.state.apps).toEqual([]);
  });
});
