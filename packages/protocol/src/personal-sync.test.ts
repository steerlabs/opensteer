import { createId } from "@opensteer/core";
import { expect, test } from "vitest";
import { ScopedClientMessageSchema, ScopedHostMessageSchema } from "./personal-sync.js";

test("accepts exact personal version and requires a generation on scoped frames", () => {
  const attach = {
    type: "client.attach",
    apiVersion: 62,
    generation: 1,
    interests: ["settings"],
    installed: { settings: "2" },
  };
  expect(ScopedClientMessageSchema.safeParse(attach).success).toBe(true);
  expect(ScopedClientMessageSchema.safeParse({ ...attach, apiVersion: 61 }).success).toBe(false);
  expect(ScopedClientMessageSchema.safeParse({ ...attach, extra: true }).success).toBe(false);
  expect(
    ScopedClientMessageSchema.safeParse({
      ...attach,
      installed: { settings: "9223372036854775808" },
    }).success,
  ).toBe(false);
  const reply = {
    type: "host.synchronized",
    subscriptionId: "shell",
    scope: { kind: "shell" },
    throughSequence: "1",
  };
  expect(ScopedHostMessageSchema.safeParse(reply).success).toBe(false);
  expect(ScopedHostMessageSchema.safeParse({ ...reply, generation: 1 }).success).toBe(true);
});

test("a change frame cannot mix commits or carry a body through an item preview", () => {
  const frame = {
    type: "host.changes",
    subscriptionId: "detail:0",
    generation: 1,
    scope: { kind: "thread", threadId: createId("thread") },
    fromSequence: "1",
    throughSequence: "3",
    changes: [
      { operation: "remove", entityKind: "item", entityId: "one", sequence: "2", ordinal: 0 },
      { operation: "remove", entityKind: "item", entityId: "two", sequence: "3", ordinal: 0 },
    ],
  };
  expect(ScopedHostMessageSchema.safeParse(frame).success).toBe(false);
  expect(ScopedHostMessageSchema.safeParse({ ...frame, changes: [frame.changes[1]] }).success).toBe(
    true,
  );
  expect(
    ScopedHostMessageSchema.safeParse({
      ...frame,
      changes: [{ ...frame.changes[1], value: { body: "private" } }],
    }).success,
  ).toBe(false);
});
