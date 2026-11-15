import {
  createId,
  TabAgentEventViewSchema,
  AppIdSchema,
  SequenceSchema,
  type App,
} from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { AppsList } from "./apps.js";
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
    const invalidate = () => {
      revision++;
      for (const listener of listeners) listener();
    };
    return { list, client, reads, invalidate };
  }
  const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve));

  it("reads only while shown and never lets an answer from before a change overwrite it", async () => {
    const { list, client, reads, invalidate } = harness();
    expect(client.listApps).not.toHaveBeenCalled();
    const release = list.subscribe(() => {});
    expect(client.listApps).toHaveBeenCalledTimes(1);
    invalidate();
    expect(client.listApps).toHaveBeenCalledTimes(2);
    reads[1]!.resolve([app("After")]);
    await settled();
    reads[0]!.resolve([app("Before")]);
    await settled();
    expect(list.state.apps?.map((held) => held.name)).toEqual(["After"]);
    release();
    invalidate();
    expect(client.listApps).toHaveBeenCalledTimes(2);
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
