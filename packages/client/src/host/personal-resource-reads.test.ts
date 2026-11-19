import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { expect, test, vi } from "vitest";
import {
  PersonalResourceReads,
  type PersonalResourceReadOptions,
  inventoryBound,
  readerGraceMs,
  runnerSettleMs,
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
    apply: (pages) => applied.push(...pages),
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
          ? { ok: false, error: { code: "timeout", message: "Host busy", retryable: true } }
          : { ok: true, data: { revision: "3", next: null, data: { kind } as never } };
      },
      apply: (pages) => applied.push(...pages),
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
    apply: (pages) => applied.push(...pages),
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

test("an inventory larger than a mebibyte installs whole, as one change, and counts as loaded", async () => {
  const applied: unknown[][] = [];
  const loaded: PersonalResourceKind[] = [];
  // Twenty pages of about 60 KiB, as the Host serves a large model catalog.
  const reads = new PersonalResourceReads({
    read: async (kind, cursor) => {
      const index = cursor ? Number(cursor) : 0;
      return {
        ok: true,
        data: {
          revision: "7",
          next: index < 19 ? String(index + 1) : null,
          data: { kind, padding: "m".repeat(60 * 1024), index } as never,
        },
      };
    },
    apply: (pages) => applied.push([...pages]),
    canRead: () => true,
    watchChanged: () => undefined,
    loaded: (kind) => loaded.push(kind),
  });
  const release = reads.watch("harness-catalog", () => {});
  await vi.waitFor(() => expect(loaded).toEqual(["harness-catalog"]));
  expect(applied).toHaveLength(1);
  expect(applied[0]).toHaveLength(20);
  expect(reads.interests().installed).toEqual({ "harness-catalog": "7" });
  release();
});

test("a Host that repeats a cursor installs nothing and is read again on its next revision", async () => {
  let calls = 0;
  const applied: unknown[] = [];
  const reads = new PersonalResourceReads({
    read: async (kind) => {
      calls++;
      return { ok: true, data: { revision: "1", next: "again", data: { kind } as never } };
    },
    apply: (pages) => applied.push(...pages),
    canRead: () => true,
    watchChanged: () => undefined,
  });
  const release = reads.watch("machine", () => {});
  await vi.waitFor(() => expect(calls).toBe(2));
  expect(applied).toEqual([]);
  reads.changed({ machine: "2" });
  await vi.waitFor(() => expect(calls).toBe(4));
  release();
});

test("a Runner that drops and comes back costs one read of what it moves, and a first read never waits", async () => {
  vi.useFakeTimers();
  try {
    const asked: string[] = [];
    const reads = new PersonalResourceReads({
      read: async (kind) => {
        asked.push(kind);
        return {
          ok: true,
          data: {
            revision: reads.revision(kind) ?? "1.0123456789abcdef.1",
            next: null,
            data: { kind } as never,
          },
        };
      },
      apply: () => undefined,
      canRead: () => true,
      watchChanged: () => undefined,
    });
    const release = reads.watch("machine", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual(["machine"]);
    // Disconnect, then reconnect, within the window: one reread, of the newest.
    reads.changed({ machine: "1.0123456789abcdef.2" });
    await vi.advanceTimersByTimeAsync(runnerSettleMs / 2);
    reads.changed({ machine: "1.0123456789abcdef.3" });
    expect(asked).toEqual(["machine"]);
    await vi.advanceTimersByTimeAsync(runnerSettleMs);
    expect(asked).toEqual(["machine", "machine"]);
    expect(reads.interests().installed).toEqual({ machine: "1.0123456789abcdef.3" });
    // A new Host boot is not a flap: read at once.
    reads.changed({ machine: "1.fedcba9876543210.1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(3);
    release();
  } finally {
    vi.useRealTimers();
  }
});

test("a kind is watched exactly while some reader that read it is mounted, or within its grace", async () => {
  vi.useFakeTimers();
  try {
    // A small deterministic generator, so a failing sequence can be replayed.
    let seed = 7;
    const random = (bound: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    for (let run = 0; run < 200; run++) {
      const reads = new PersonalResourceReads({
        read: () => new Promise(() => undefined),
        apply: () => undefined,
        canRead: () => true,
        watchChanged: () => undefined,
      });
      const readers = Array.from({ length: 3 }, () => ({
        interest: reads.interest(),
        mounted: 0,
        held: false,
        graceUntil: -1,
      }));
      let now = 0;
      const steps: string[] = [];
      for (let step = 0; step < 30; step++) {
        const reader = readers[random(readers.length)]!;
        const op = random(5);
        if (op === 0) {
          reader.interest.open();
          reader.mounted++;
          reader.graceUntil = -1;
          reader.interest.hold("machine");
          reader.held = true;
          steps.push("mount");
        } else if (op === 1 && reader.mounted > 0) {
          reader.interest.hold("machine");
          steps.push("render");
        } else if (op === 2 && reader.mounted > 0) {
          reader.interest.close();
          if (--reader.mounted === 0) reader.graceUntil = now + readerGraceMs;
          steps.push("unmount");
        } else {
          const by = random(readerGraceMs * 2);
          now += by;
          await vi.advanceTimersByTimeAsync(by);
          for (const each of readers)
            if (each.mounted === 0 && each.graceUntil !== -1 && each.graceUntil <= now) {
              each.held = false;
              each.graceUntil = -1;
            }
          steps.push(`wait ${by}`);
        }
        const expected = readers.some(
          (each) => each.held && (each.mounted > 0 || each.graceUntil > now),
        );
        expect(reads.interests().interests.includes("machine"), steps.join(", ")).toBe(expected);
      }
      reads.dispose();
    }
  } finally {
    vi.useRealTimers();
  }
});

test("an inventory past its kind's bound stops as it arrives, keeps the last complete one, and says so", async () => {
  let pagesRead = 0;
  let large = false;
  const applied: unknown[][] = [];
  const unreadable: [PersonalResourceKind, boolean][] = [];
  const reads = new PersonalResourceReads({
    read: async (kind, cursor) => {
      pagesRead++;
      const revision = reads.revision(kind) ?? "1";
      // Past the first revision the Host pages without end, 60 KiB at a time.
      return {
        ok: true,
        data: {
          revision,
          next: large ? String(Number(cursor ?? 0) + 1) : null,
          data: { kind, padding: large ? "m".repeat(60 * 1024) : "", revision } as never,
        },
      };
    },
    apply: (pages) => applied.push([...pages]),
    canRead: () => true,
    watchChanged: () => undefined,
    unreadable: (kind, value) => unreadable.push([kind, value]),
  });
  const release = reads.watch("harness", () => {});
  await vi.waitFor(() => expect(applied).toHaveLength(1));
  large = true;
  pagesRead = 0;
  reads.changed({ harness: "2" });
  await vi.waitFor(() => expect(unreadable).toEqual([["harness", true]]));
  // It stopped at the bound: about 2 MiB of 60 KiB pages, not more.
  expect(pagesRead).toBeLessThanOrEqual(Math.ceil(inventoryBound("harness") / (60 * 1024)) + 1);
  expect(applied).toHaveLength(1);
  expect(reads.interests().installed).toEqual({ harness: "1" });
  // The next revision reads again, and a complete answer clears the report.
  large = false;
  reads.changed({ harness: "3" });
  await vi.waitFor(() => expect(reads.interests().installed).toEqual({ harness: "3" }));
  expect(unreadable).toEqual([
    ["harness", true],
    ["harness", false],
  ]);
  release();
});

test("a new reader or an attach reads a Runner kind at once and takes over a settling reread", async () => {
  vi.useFakeTimers();
  try {
    const asked: string[] = [];
    const reads = new PersonalResourceReads({
      read: async (kind) => {
        asked.push(reads.revision(kind) ?? "first");
        return {
          ok: true,
          data: {
            revision: reads.revision(kind) ?? "1.0123456789abcdef.1",
            next: null,
            data: { kind } as never,
          },
        };
      },
      apply: () => undefined,
      canRead: () => true,
      watchChanged: () => undefined,
    });
    const first = reads.watch("machine", () => {});
    await vi.advanceTimersByTimeAsync(0);
    // A Runner drops: the reread settles. A screen mounting meanwhile reads now, once.
    reads.changed({ machine: "1.0123456789abcdef.2" });
    const second = reads.watch("machine", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual(["first", "1.0123456789abcdef.2"]);
    await vi.advanceTimersByTimeAsync(runnerSettleMs * 2);
    expect(asked).toHaveLength(2);
    // After a gap the client attaches; the revision the Host answers it with is read at once.
    reads.resume(true);
    reads.changed({ machine: "1.0123456789abcdef.5" });
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual(["first", "1.0123456789abcdef.2", "1.0123456789abcdef.5"]);
    // A live push after that answer settles again.
    reads.changed({ machine: "1.0123456789abcdef.6" });
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(runnerSettleMs);
    expect(asked).toHaveLength(4);
    first();
    second();
  } finally {
    vi.useRealTimers();
  }
});

test("a command waiting on a kind whose read fails for good fails with that error at once", async () => {
  let calls = 0;
  const reads = new PersonalResourceReads({
    read: async (kind) => {
      calls++;
      // A repeated cursor: no retry can mend it.
      return { ok: true, data: { revision: "1", next: "again", data: { kind } as never } };
    },
    apply: () => undefined,
    canRead: () => true,
    watchChanged: () => undefined,
  });
  const started = Date.now();
  await expect(reads.current("browser-home", 10_000)).rejects.toThrow("repeats a cursor");
  expect(Date.now() - started).toBeLessThan(1_000);
  // One read: its two pages, the second repeating the cursor.
  expect(calls).toBe(2);
  reads.dispose();
});

test("any read that fails for good marks its kind unreadable, and a reset forgets it for the next history", async () => {
  let refuse = true;
  const unreadable: [PersonalResourceKind, boolean][] = [];
  const reads = new PersonalResourceReads({
    read: async (kind) =>
      refuse
        ? // A single row too large for the Host's page: refused before any byte reaches here.
          { ok: false, error: { code: "resource_exhausted", message: "Too large" } }
        : { ok: true, data: { revision: "1", next: null, data: { kind } as never } },
    apply: () => undefined,
    canRead: () => true,
    watchChanged: () => undefined,
    unreadable: (kind, value) => unreadable.push([kind, value]),
  });
  const release = reads.watch("environment", () => {});
  await vi.waitFor(() => expect(unreadable).toEqual([["environment", true]]));
  // A new history: the same failure there is reported again, not suppressed.
  reads.reset();
  reads.resume();
  await vi.waitFor(() =>
    expect(unreadable).toEqual([
      ["environment", true],
      ["environment", true],
    ]),
  );
  // Try again, once the Host can answer.
  refuse = false;
  reads.retry("environment");
  await vi.waitFor(() => expect(unreadable.at(-1)).toEqual(["environment", false]));
  release();
});
