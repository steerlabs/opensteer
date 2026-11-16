import { tabFixture, tabStoreFixture } from "../test-support/tab-fixtures.js";
import {
  createId,
  RunnerIdSchema,
  TabIdSchema,
  PlaceEnteredEventViewSchema,
  SequenceSchema,
} from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import { runPlaceActing } from "./run-page.js";
import {
  runPlaceDestination,
  runPlacePictureSession,
  runPlaceSessionId,
  RunPlaceStore,
} from "./run-place.js";

const threadId = createId("thread");
const runId = createId("run");
function entered(sequence: string, id = runId) {
  return PlaceEnteredEventViewSchema.parse({
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

// Failure mode: a Run in Notes window B shows as acting in, and pictures under, window A's tab,
// because both windows belong to the app the Run's session holds.
it("knows a Run acts in, and pictures, one window of an app by its exact tab", () => {
  const machineId = RunnerIdSchema.parse(createId("runner"));
  const tab = (id: string) =>
    tabFixture({
      tabId: TabIdSchema.parse(id),
      kind: "window",
      appName: "Notes",
      bundleId: "com.apple.Notes",
      computer: { computerId: machineId, name: "Mac" },
    });
  const notes = { bundleId: "com.apple.Notes", displayName: "Notes" };
  const snapshot = {
    tabs: tabStoreFixture([tab("window-a"), tab("window-b")]),
    machines: [
      {
        id: machineId,
        computerUse: {
          sessions: [
            {
              runId,
              display: false,
              sessionId: "cus_notes",
              apps: [notes],
              actingAppKeys: ["com.apple.notes"],
            },
          ],
        },
      } as unknown as MachineSummary,
    ],
  };
  const entryA = PlaceEnteredEventViewSchema.parse({
    ...entered("5"),
    data: { tabId: "window-a", title: "Notes", site: null },
  });
  const inB = [{ runId, threadId }];
  // The Run acts in B: A's tab has no activity of its own.
  expect(runPlaceActing(entryA, snapshot, [], threadId)).toBe(false);
  expect(runPlacePictureSession("window", runPlaceSessionId(entryA, snapshot), runId, [])).toBe(
    null,
  );
  // Back in A, A's own activity names it, and its picture is the session's.
  expect(runPlaceActing(entryA, snapshot, inB, threadId)).toBe(true);
  expect(runPlacePictureSession("window", runPlaceSessionId(entryA, snapshot), runId, inB)).toBe(
    "cus_notes",
  );
  // A page's picture is its own tab's, whoever acts.
  expect(runPlacePictureSession("page", "bsn_page", runId, [])).toBe("bsn_page");
});
