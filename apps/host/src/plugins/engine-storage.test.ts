import { afterEach, expect, test, vi } from "vitest";
import { Effect, Stream, Schedule } from "effect";
import type { ReactiveStore } from "@opensteer/plugin-engine-reactivity";
import type { SqlClient } from "effect/sql";
import { backgroundResourceChanges } from "./engine-storage.js";

afterEach(() => vi.useRealTimers());
test("continuous committed changes notify within the coalescing window without history queries", async () => {
  vi.useFakeTimers();
  const notify = vi.fn();
  let started = false;
  const stream = Stream.fromSchedule(Schedule.spaced("10 millis")).pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        started = true;
      }),
    ),
  );
  const sql = vi.fn(() =>
    Effect.succeed([{ signature: "history" }]),
  ) as unknown as SqlClient.SqlClient;
  const database = {
    reactivity: {
      changes: stream.pipe(
        Stream.map((revision) => ({ namespace: "fixture", revision, tables: ["workflowRuns"] })),
      ),
      read: (_tables: string[], value: unknown) => value,
      subscribe: () =>
        stream.pipe(Stream.map((revision) => ({ value: [{ signature: String(revision) }] }))),
    } as unknown as ReactiveStore,
  };
  const controller = new AbortController();
  const running = Effect.runPromise(backgroundResourceChanges(database, sql, notify), {
    signal: controller.signal,
  }).catch(() => undefined);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(started, "Committed-change stream never registered").toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    expect(notify).toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await running;
  }
});
