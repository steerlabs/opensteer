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

test("a push while a read flies: the older answer installs nothing and the newest lands", async () => {
  const { reads, pending, applied } = harness();
  const release = reads.watch("browser-availability", () => {});
  expect(pending).toHaveLength(1);
  // The Host moves on while the first read is out; no second read starts beside it.
  reads.changed({ "browser-availability": "2.0123456789abcdef.1" });
  expect(pending).toHaveLength(1);
  pending[0]!.answer("1", false);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  // The superseded answer never painted.
  expect(applied).toEqual([]);
  pending[1]!.answer("2.0123456789abcdef.1", true);
  await vi.waitFor(() =>
    expect(reads.interests().installed).toEqual({
      "browser-availability": "2.0123456789abcdef.1",
    }),
  );
  expect(applied).toEqual([{ kind: "browser-availability", available: true }]);
  release();
});

test("reads each watched kind until it holds the newest revision, as after a Host restart", async () => {
  const { reads, pending } = harness();
  const kinds = ["settings", "machine", "environment"] as const;
  const releases = kinds.map((kind) => reads.watch(kind, () => {}));
  reads.changed({ settings: "4", machine: "9.0123456789abcdef.2", environment: "9" });
  const answerAll = async () => {
    while (pending.length) {
      for (const read of pending.splice(0)) read.answer(reads.revision(read.kind)!, true);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await vi.waitFor(() => undefined);
    }
  };
  await vi.waitFor(async () => {
    await answerAll();
    expect(reads.interests().installed).toEqual({
      settings: "4",
      machine: "9.0123456789abcdef.2",
      environment: "9",
    });
  });
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
  expect(pending).toEqual([]);
  const release = reads.watch("machine", () => {});
  expect(pending.map(({ kind }) => kind)).toEqual(["machine"]);
  release();
  expect(pending[0]!.signal.aborted).toBe(true);
  releaseSignal();
});

test("a failed read retries with backoff while the kind is watched", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const applied: unknown[] = [];
    const reads = new PersonalResourceReads({
      read: async (kind) => {
        calls++;
        return calls === 1
          ? { ok: false, error: { code: "unavailable", message: "Host busy", retryable: true } }
          : { ok: true, data: { revision: "3", next: null, data: { kind } as never } };
      },
      apply: (data) => applied.push(data),
      canRead: () => true,
      watchChanged: () => undefined,
    });
    const release = reads.watch("machine", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(applied).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(applied).toEqual([{ kind: "machine" }]);
    release();
  } finally {
    vi.useRealTimers();
  }
});

test("a read whose later page meets a newer push installs none of its pages", async () => {
  const pages: Array<(next: string | null, revision: string) => void> = [];
  const applied: unknown[] = [];
  const reads = new PersonalResourceReads({
    read: (kind, cursor) =>
      new Promise((resolve) =>
        pages.push((next, revision) =>
          resolve({ ok: true, data: { revision, next, data: { kind, cursor } as never } }),
        ),
      ),
    apply: (data) => applied.push(data),
    canRead: () => true,
    watchChanged: () => undefined,
  });
  const release = reads.watch("machine", () => {});
  pages[0]!("page-2", "1");
  await vi.waitFor(() => expect(pages).toHaveLength(2));
  reads.changed({ machine: "2" });
  pages[1]!(null, "1");
  // The rerun's first page is the only read after; the old two pages never painted.
  await vi.waitFor(() => expect(pages).toHaveLength(3));
  expect(applied).toEqual([]);
  pages[2]!(null, "2");
  await vi.waitFor(() => expect(applied).toHaveLength(1));
  release();
});

test("an answer older than the push is read again once, then waits for the next push", async () => {
  let calls = 0;
  const reads = new PersonalResourceReads({
    read: async (kind) => {
      calls++;
      return { ok: true, data: { revision: "1", next: null, data: { kind } as never } };
    },
    apply: () => undefined,
    canRead: () => true,
    watchChanged: () => undefined,
  });
  const release = reads.watch("machine", () => {});
  reads.changed({ machine: "2" });
  await vi.waitFor(() => expect(calls).toBe(2));
  for (let tick = 0; tick < 50; tick++) await Promise.resolve();
  expect(calls).toBe(2);
  expect(reads.interests().installed).toEqual({});
  reads.changed({ machine: "3" });
  await vi.waitFor(() => expect(calls).toBe(3));
  release();
});
