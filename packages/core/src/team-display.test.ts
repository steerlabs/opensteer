import { expect, it } from "vitest";
import { createId } from "./ids.js";
import {
  ThreadRequestWaitsSchema,
  ThreadRequestOutcomeSchema,
  threadRequestFactLimit,
} from "./team-display.js";

it("keeps shared wait facts payload-free and bounds the window without hiding its total", () => {
  const item = {
    requestId: createId("request"),
    class: "approval",
    since: "2026-11-10T12:00:00.000Z",
    waitingOn: { kind: "person", name: "Maya" },
  };
  const waits = ThreadRequestWaitsSchema.parse({
    items: [{ ...item, payload: { secret: "not public" }, presentation: { title: "Not public" } }],
    total: 40,
  });
  expect(waits).toEqual({ items: [item], total: 40 });
  expect(
    ThreadRequestWaitsSchema.safeParse({
      items: Array.from({ length: threadRequestFactLimit + 1 }, () => item),
      total: 40,
    }).success,
  ).toBe(false);
  expect(ThreadRequestWaitsSchema.safeParse({ items: [item], total: 0 }).success).toBe(false);
});
it("shares only the resolver or cancellation fact while leaving question content private", () => {
  const common = { requestId: createId("request"), at: "2026-11-10T12:00:00.000Z" };
  expect(
    ThreadRequestOutcomeSchema.parse({
      ...common,
      status: "fulfilled",
      resolvedByName: "Dev Patel",
      response: { kind: "text", text: "private" },
    }),
  ).toEqual({ ...common, status: "fulfilled", resolvedByName: "Dev Patel" });
  expect(
    ThreadRequestOutcomeSchema.parse({
      ...common,
      status: "cancelled",
      reason: "no-eligible-manager",
    }),
  ).toEqual({ ...common, status: "cancelled", reason: "no-eligible-manager" });
  expect(
    ThreadRequestOutcomeSchema.parse({
      ...common,
      class: "approval",
      status: "fulfilled",
      resolvedByName: "Dev Patel",
      response: { kind: "text", text: "private" },
    }),
  ).toEqual({ ...common, class: "approval", status: "fulfilled", resolvedByName: "Dev Patel" });
  expect(
    ThreadRequestOutcomeSchema.parse({
      ...common,
      class: "question",
      status: "cancelled",
      reason: "no-eligible-manager",
      payload: { secret: "private" },
    }),
  ).toEqual({ ...common, class: "question", status: "cancelled", reason: "no-eligible-manager" });
});
