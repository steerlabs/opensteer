import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  SavedHostViewSchema,
  SavedTaskSchema,
  projectSavedTasks,
  savedViewScopeKey,
} from "./saved-host-view.js";

it("saves task subjects and folders without conversation content or authority", () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const tasks = projectSavedTasks(client.getSnapshot());
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(Object.keys(task).sort()).toEqual(["folder", "glyph", "group", "id", "title"]);
      expect(SavedTaskSchema.parse(task)).toEqual(task);
    }
    const serialized = JSON.stringify(tasks);
    for (const key of [
      "cursor",
      "runId",
      "author",
      "attachment",
      "request",
      "accessMode",
      "sequence",
    ])
      expect(serialized).not.toContain(`"${key}"`);
    expect(SavedHostViewSchema.safeParse({ cursor: "0" }).success).toBe(false);
  } finally {
    client.dispose();
  }
});
it("bounds Unicode subjects and retains the newest fifty across working, ready and done", () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const snapshot = client.getSnapshot(),
      template = snapshot.tasks!.entries[0]!;
    const tasks = projectSavedTasks({
      ...snapshot,
      threads: [],
      activeTasks: [],
      threadReadStates: {},
      waitingRequests: [],
      tasks: {
        ...snapshot.tasks!,
        entries: Array.from({ length: 60 }, (_, index) => ({
          ...template,
          thread: {
            ...template.thread,
            id: createId("thread"),
            title: "🌺".repeat(1000),
            listed: true,
            status: index % 3 === 0 ? "running" : "idle",
            doneAt: index % 3 === 2 ? new Date().toISOString() : null,
            askedAt: new Date(index * 1000).toISOString(),
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
  } finally {
    client.dispose();
  }
});
it("binds saved rows to the expected Host, epoch and login", () => {
  const scope = {
    schema: 1 as const,
    epoch: 6,
    hostIdentity: {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
    },
    loginId: crypto.randomUUID(),
  };
  expect(savedViewScopeKey({ ...scope })).toBe(savedViewScopeKey(scope));
  expect(savedViewScopeKey({ ...scope, epoch: 7 })).not.toBe(savedViewScopeKey(scope));
  expect(savedViewScopeKey({ ...scope, loginId: crypto.randomUUID() })).not.toBe(
    savedViewScopeKey(scope),
  );
  expect(
    SavedHostViewSchema.safeParse({
      ...scope,
      userId: createId("user"),
      capturedAt: new Date().toISOString(),
      tasks: [],
      chat: { messages: [] },
    }).success,
  ).toBe(false);
});
