import { browserStoreFixture } from "../test-support/browser-snapshot.js";
import type { BrowserGroupRow, BrowserTabRow } from "@opensteer/protocol/browser-tabs";
import { createId, PlaceEnteredEventViewSchema, SequenceSchema } from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import type { HostSnapshot } from "./client.js";
import { runPlaceDestination, runPlaceSessionId, RunPlaceStore } from "./run-place.js";

const workspaceId = createId("workspace");
const threadId = createId("thread");
const runId = createId("run");
function entered(sequence: string, id = runId) {
  return PlaceEnteredEventViewSchema.parse({
    type: "place.entered",
    eventId: createId("event"),
    environmentId: createId("environment"),
    workspaceId,
    threadId,
    runId: id,
    sequence,
    createdAt: "2026-11-02T13:00:00.000Z",
    data: {
      place: {
        kind: "browser",
        sessionId: "bsn_00000000-0000-4000-8000-000000000001",
        surfaceId: `tab-${sequence}`,
      },
      title: `Page ${sequence}`,
      site: "https://example.com",
    },
  });
}
it("names a phone while its tab is open, after the Run has let go of it", () => {
  const machineId = createId("runner");
  const entry = {
    runId,
    data: { place: { kind: "phone" as const, machineId, display: "main" } },
  };
  const phone = (tabOpenedAt: string | null, sessions: readonly unknown[]) => ({
    machines: [
      { id: machineId, tabOpenedAt, computerUse: { sessions } } as unknown as MachineSummary,
    ],
  });
  const destination = { kind: "phone", machineId };
  const held = phone(null, [{ runId, display: true, sessionId: "cus_held", apps: [] }]);
  expect(runPlaceDestination(entry, held)).toEqual(destination);
  expect(runPlaceSessionId(entry, held)).toBe("cus_held");

  const released = phone("2026-11-05T12:00:00.000Z", []);
  expect(runPlaceDestination(entry, released)).toEqual(destination);
  expect(runPlaceSessionId(entry, released)).toBeNull();

  expect(runPlaceDestination(entry, phone(null, []))).toBeNull();
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
  store.reconcile(workspaceId, SequenceSchema.parse("9"), []);
  store.flush();
  expect(store.get(runId)).toBe(current);
  store.reconcile(workspaceId, SequenceSchema.parse("11"), []);
  store.flush();
  expect(store.get(runId)).toBeNull();
  store.seed([current]);
  expect(store.get(runId)).toBeNull();
});

it("resolves a durable tab from its current ready catalog even while the saved row still names its old session", () => {
  const event = entered("1");
  if (event.data.place.kind !== "browser") throw new Error("Expected browser");
  const original = event.data.place.sessionId;
  const restored = "bsn_00000000-0000-4000-8000-000000000002";
  const tabId = event.data.place.surfaceId;
  const snapshot = {
    machines: [],
    browserTabs: browserStoreFixture(
      [{ id: "group", sessionId: restored, state: "ready" } as BrowserGroupRow],
      [{ groupId: "group", rows: [{ id: tabId, sessionId: restored }] as BrowserTabRow[] }],
    ),
    browserSessions: [
      { id: original, state: "closed" },
      { id: restored, state: "ready" },
    ],
  } as unknown as HostSnapshot;
  expect(runPlaceDestination(event, snapshot)).toEqual({
    kind: "browser",
    tabId,
    sessionId: restored,
  });
  expect(
    runPlaceDestination(event, { ...snapshot, browserSessions: [], browserTabs: undefined }),
  ).toEqual({
    kind: "browser",
    tabId,
    sessionId: original,
  });
});
