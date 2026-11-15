import { tabFixture, tabStoreFixture } from "../test-support/tab-fixtures.js";
import {
  createId,
  RunnerIdSchema,
  TabIdSchema,
  TabPlaceEnteredEventViewSchema,
  SequenceSchema,
} from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import { runPlaceDestination, runPlaceSessionId, RunPlaceStore } from "./run-place.js";

const threadId = createId("thread");
const runId = createId("run");
function entered(sequence: string, id = runId) {
  return TabPlaceEnteredEventViewSchema.parse({
    type: "place.entered",
    eventId: createId("event"),
    environmentId: createId("environment"),
    threadId,
    runId: id,
    sequence,
    createdAt: "2026-11-02T13:00:00.000Z",
    data: { tabId: `tab-${sequence}`, title: `Page ${sequence}`, site: "https://example.com" },
  });
}

it("names a listed tab and reads the Run's own session at a phone, never a closed tab", () => {
  const machineId = RunnerIdSchema.parse(createId("runner"));
  const tabId = TabIdSchema.parse("phone-tab");
  const entry = { runId, data: { tabId } };
  const source = (sessions: readonly unknown[], listed = true) => ({
    tabs: tabStoreFixture(
      listed
        ? [tabFixture({ tabId, kind: "phone", computer: { computerId: machineId, name: "Pixel" } })]
        : [],
    ),
    machines: [{ id: machineId, computerUse: { sessions } } as unknown as MachineSummary],
  });
  const held = source([{ runId, display: true, sessionId: "cus_held", apps: [] }]);
  expect(runPlaceDestination(entry, held)).toEqual({ kind: "tab", tabId });
  expect(runPlaceSessionId(entry, held)).toBe("cus_held");
  // A Run that let go of the phone still names its tab; only its session is gone.
  const released = source([]);
  expect(runPlaceDestination(entry, released)).toEqual({ kind: "tab", tabId });
  expect(runPlaceSessionId(entry, released)).toBeNull();
  const closed = source([{ runId, display: true, sessionId: "cus_held", apps: [] }], false);
  expect(runPlaceDestination(entry, closed)).toBeNull();
  expect(runPlaceSessionId(entry, closed)).toBeNull();
});

it("seeds by Run, accepts only newer sequences and fences terminal Runs against stale seeds", () => {
  const store = new RunPlaceStore();
  const changed = vi.fn();
  store.subscribe(runId, changed);
  const first = entered("9");
  store.accept(first);
  store.accept(entered("8"));
  store.accept(entered("9"));
  expect(store.get(runId)).toBe(first);
  expect(changed).toHaveBeenCalledTimes(1);
  const second = entered("10");
  const other = entered("11", createId("run"));
  store.seed([second, other]);
  expect(store.get(runId)).toBe(second);
  expect(store.get(other.runId)).toBe(other);
  store.end(runId);
  store.seed([first, second]);
  expect(store.get(runId)).toBeNull();
  expect(store.get(other.runId)).toBe(other);
  store.clear();
  expect(store.get(other.runId)).toBeNull();
  store.seed([first]);
  expect(store.get(runId)).toBe(first);
});

it("a resync removes ended Runs without discarding places newer than its cut", () => {
  const store = new RunPlaceStore();
  const current = entered("10");
  store.accept(current);
  store.reconcile(SequenceSchema.parse("9"), []);
  store.flush();
  expect(store.get(runId)).toBe(current);
  store.reconcile(SequenceSchema.parse("11"), []);
  store.flush();
  expect(store.get(runId)).toBeNull();
  store.seed([current]);
  expect(store.get(runId)).toBeNull();
});
