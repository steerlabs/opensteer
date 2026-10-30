import { createId } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import { expect, it } from "vitest";
import { SavedHostViewSchema, projectSavedHome, projectSavedTasks } from "./saved-host-view.js";
import type { MessageEntry } from "./client.js";
it("persists only published message text, excluding even finished synthetic streams and every authority field", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  const snapshot = client.getSnapshot();
  const message = (body: string, extra: Partial<MessageEntry> = {}): MessageEntry => ({
    kind: "message",
    id: createId("message"),
    body,
    createdAt: new Date().toISOString(),
    messageKind: "input",
    author: {
      kind: "human",
      displayName: "A",
      userId: snapshot.user!.id,
      principalId: snapshot.user!.id,
    },
    runId: null,
    ...extra,
  });
  const result = projectSavedHome({
    ...snapshot,
    savedViewReadiness: {
      tasksReady: true,
      workspaceRefusal: 0,
      home: {
        status: "window",
        workspaceId: snapshot.homeWorkspaceId!,
        threadId: snapshot.homeThreadId!,
        latest: true,
      },
    },
    transcripts: {
      [snapshot.homeThreadId!]: [
        message("published"),
        message("QUEUE_SENTINEL", { published: false }),
        message("STREAM_SENTINEL", { id: "stream:finished", streaming: false }),
        message("CONTINUATION_SENTINEL", { messageKind: "continuation" }),
      ],
    },
  });
  expect(result?.messages).toEqual([{ voice: "mine", text: "published" }]);
  const text = JSON.stringify(result);
  for (const secret of [
    "SENTINEL",
    "sequence",
    "runId",
    "author",
    "attachment",
    "request",
    "cursor",
  ])
    expect(text).not.toContain(secret);
  client.dispose();
});
it("distinguishes unknown, absent, empty and historical Home answers, and bounds Unicode projections", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  const snapshot = client.getSnapshot();
  expect(
    projectSavedHome({
      ...snapshot,
      savedViewReadiness: { tasksReady: false, home: { status: "unknown" }, workspaceRefusal: 0 },
    }),
  ).toBeUndefined();
  const readiness = {
    tasksReady: true,
    workspaceRefusal: 0,
    home: { status: "absent" as const, workspaceId: snapshot.homeWorkspaceId! },
  };
  expect(
    projectSavedHome({ ...snapshot, homeThreadId: null, savedViewReadiness: readiness })?.messages,
  ).toEqual([]);
  expect(
    projectSavedHome({
      ...snapshot,
      savedViewReadiness: {
        ...readiness,
        home: {
          status: "window",
          workspaceId: snapshot.homeWorkspaceId!,
          threadId: snapshot.homeThreadId!,
          latest: false,
        },
      },
    }),
  ).toBeUndefined();
  const tasks = projectSavedTasks(snapshot);
  expect(tasks.length).toBeLessThanOrEqual(50);
  for (const row of tasks)
    expect(Object.keys(row).sort()).toEqual(["glyph", "group", "id", "title", "workspaceId"]);
  expect(SavedHostViewSchema.safeParse({ cursor: "0" }).success).toBe(false);
  client.dispose();
});

it("bounds encoded Unicode tails and recent task subjects while retaining historical group order", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  const snapshot = client.getSnapshot();
  const home = projectSavedHome({
    ...snapshot,
    savedViewReadiness: {
      tasksReady: true,
      workspaceRefusal: 0,
      home: {
        status: "window",
        workspaceId: snapshot.homeWorkspaceId!,
        threadId: snapshot.homeThreadId!,
        latest: true,
      },
    },
    transcripts: {
      [snapshot.homeThreadId!]: [
        {
          kind: "message",
          id: createId("message"),
          messageKind: "assistant",
          author: { kind: "platform", cause: "assistant-message" },
          body: "🌺".repeat(80_000),
          runId: null,
          createdAt: new Date().toISOString(),
        },
      ],
    },
  })!;
  expect(home.messages[0]!.text).toMatch(/^Earlier text omitted/u);
  expect(home.messages[0]!.text).not.toContain("�");
  expect(new TextEncoder().encode(home.messages[0]!.text).byteLength).toBeLessThanOrEqual(65_536);
  expect(new TextEncoder().encode(JSON.stringify(home)).byteLength).toBeLessThanOrEqual(262_144);
  const template = snapshot.tasks!.entries.find(
    ({ thread }) => thread.id !== snapshot.homeThreadId,
  )!;
  const tasks = projectSavedTasks({
    ...snapshot,
    threads: [],
    activeTasks: [],
    threadReadStates: {},
    tasks: {
      ...snapshot.tasks!,
      entries: Array.from({ length: 60 }, (_, index) => ({
        ...template,
        thread: {
          ...template.thread,
          id: createId("thread"),
          listed: true,
          title: "🌺".repeat(1_000),
          status: index % 3 === 0 ? "running" : "idle",
          doneAt: index % 3 === 2 ? new Date().toISOString() : null,
          updatedAt: new Date(1_000 * index).toISOString(),
        },
      })),
    },
  });
  expect(tasks).toHaveLength(50);
  expect(new Set(tasks.map(({ group }) => group)).size).toBe(3);
  expect(
    tasks.every(
      ({ title }) => new TextEncoder().encode(title).byteLength <= 512 && !title.includes("�"),
    ),
  ).toBe(true);
  client.dispose();
});
