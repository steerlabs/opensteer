import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { expect, test, vi } from "vitest";
import {
  PersonalResourceReads,
  type PersonalResourceReadOptions,
} from "./personal-resource-reads.js";

type Read = Awaited<ReturnType<PersonalResourceReadOptions["read"]>>;

function harness() {
  const pending: {
    kind: PersonalResourceKind;
    signal: AbortSignal;
    answer: (revision: string, available: boolean) => void;
  }[] = [];
  const applied: unknown[] = [];
  const reads = new PersonalResourceReads({
    read: (kind, _cursor, signal) => {
      const answer = Promise.withResolvers<Read>();
      pending.push({
        kind,
        signal,
        answer: (revision, available) =>
          answer.resolve({
            ok: true,
            // Only the kind matters to the reads; each page's shape is the Host's contract.
            data: { revision, next: null, data: { kind, available } as never },
          }),
      });
      return answer.promise;
    },
    apply: (data) => applied.push(data),
    canRead: () => true,
    watchChanged: vi.fn(),
  });
  return { reads, pending, applied };
}

test("a kind changed while its detail read is in flight converges on the newest data", async () => {
  const { reads, pending, applied } = harness();
  const release = reads.watch("browser-availability", () => {});
  reads.changed({ "browser-availability": "1" });
  expect(pending).toHaveLength(1);
  // The Host moves on while the first read is out; no second read starts beside it.
  reads.changed({ "browser-availability": "2.0123456789abcdef.1" });
  expect(pending).toHaveLength(1);
  pending[0]!.answer("1", false);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(applied).toEqual([{ kind: "browser-availability", available: false }]);
  pending[1]!.answer("2.0123456789abcdef.1", true);
  await vi.waitFor(() =>
    expect(reads.interests().installed).toEqual({
      "browser-availability": "2.0123456789abcdef.1",
    }),
  );
  expect(applied.at(-1)).toEqual({ kind: "browser-availability", available: true });
  expect(pending).toHaveLength(2);
  release();
});

test("reads each watched kind once when every revision changes, as after a Host restart", async () => {
  const { reads, pending } = harness();
  const kinds = ["settings", "machine", "environment"] as const;
  const releases = kinds.map((kind) => reads.watch(kind, () => {}));
  reads.changed({ settings: "4", machine: "9.0123456789abcdef.2", environment: "9" });
  for (const read of pending.splice(0)) read.answer(reads.revision(read.kind)!, true);
  await vi.waitFor(() =>
    expect(reads.interests().installed).toEqual({
      settings: "4",
      machine: "9.0123456789abcdef.2",
      environment: "9",
    }),
  );
  // Same durable revisions, a new boot: equality alone tells the client to reread.
  reads.changed({ machine: "9.fedcba9876543210.1", environment: "9.fedcba9876543210.1" });
  expect(pending.map(({ kind }) => kind)).toEqual(["machine", "environment"]);
  for (const read of pending.splice(0)) read.answer(reads.revision(read.kind)!, true);
  await vi.waitFor(() =>
    expect(reads.interests().installed).toMatchObject({ machine: "9.fedcba9876543210.1" }),
  );
  expect(pending).toEqual([]);
  // A resume that hears nothing new reads nothing.
  reads.resume();
  expect(pending).toEqual([]);
  for (const release of releases) release();
});

test("an unwatched kind stops its read and a signal kind is never read", () => {
  const { reads, pending } = harness();
  const heard = vi.fn();
  const releaseSignal = reads.watch("team-replies", heard);
  reads.changed({ "team-replies": "5" });
  expect(heard).toHaveBeenCalledTimes(1);
  expect(reads.interests().installed).toEqual({ "team-replies": "5" });
  const release = reads.watch("machine", () => {});
  reads.changed({ machine: "3" });
  expect(pending.map(({ kind }) => kind)).toEqual(["machine"]);
  release();
  expect(pending[0]!.signal.aborted).toBe(true);
  releaseSignal();
});
