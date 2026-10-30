import { withTimeout } from "@opensteer/shared/withTimeout";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { createDatabase, databaseShutdownDetails } from "./connection.js";

it("names a gated checkout while destroy waits, and clears it after release", async () => {
  const pool = new EventEmitter();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const endStarted = Promise.withResolvers<void>();
  let ending = false;
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release() {
      pool.emit("release", undefined, client);
      if (ending) ended.resolve();
    },
  };
  const database = createDatabase(
    { connectionString: "postgres://secret:password@example.invalid/private" },
    Object.assign(pool, {
      connect: vi.fn().mockResolvedValue(client),
      end: () => {
        ending = true;
        endStarted.resolve();
        return ended.promise;
      },
    }) as unknown as Pool,
  );
  await database.connection().execute(async () => undefined);
  const holding = database.connection().execute(async () => {
    entered.resolve();
    await gate.promise;
  });
  try {
    await withTimeout(entered.promise, 1_000, {
      timeoutError: () => new Error("Checkout callback never entered"),
    });
    const closing = database.destroy();
    await withTimeout(endStarted.promise, 1_000, {
      timeoutError: () => new Error("Database destroy never reached pool.end"),
    });
    expect(databaseShutdownDetails(database)).toContain("checked out");
    expect(databaseShutdownDetails(database)).toContain("connection-shutdown.test.ts");
    expect(databaseShutdownDetails(database)).not.toMatch(/password|example.invalid|private/);
    gate.resolve();
    await expect(
      withTimeout(Promise.all([holding, closing]), 1_000, {
        timeoutError: () => new Error("Database checkout did not release during shutdown"),
      }),
    ).resolves.toEqual([undefined, undefined]);
    expect(databaseShutdownDetails(database)).toBe("");
  } finally {
    gate.resolve();
    await holding;
    await database.destroy();
  }
});

it("clears failed acquisitions and releases a callback that throws", async () => {
  const pool = new EventEmitter();
  const failure = new Error("Injected terminal database failure");
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: () => pool.emit("release", undefined, client),
  };
  const database = createDatabase(
    { connectionString: "unused" },
    Object.assign(pool, {
      connect: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(client),
      end: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Pool,
  );
  try {
    await expect(database.connection().execute(async () => undefined)).rejects.toBe(failure);
    expect(databaseShutdownDetails(database)).toBe("");
    await expect(
      database.connection().execute(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(databaseShutdownDetails(database)).toBe("");
    await expect(
      database.transaction().execute(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.query.mock.calls.map(([statement]) => statement)).toEqual(["begin", "rollback"]);
    expect(databaseShutdownDetails(database)).toBe("");
  } finally {
    await database.destroy();
  }
});
