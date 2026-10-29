import { expect, it, vi } from "vitest";
import { createStoreFixture } from "./store.integration.test-support.js";

const owned = vi.hoisted(() => ({
  next: 0,
  pools: [] as { url: string; destroy: ReturnType<typeof vi.fn> }[],
  closes: [] as (() => Promise<void>)[],
}));

vi.mock("./test-database.test-support.js", () => ({
  cloneTestDatabase: async () => ({
    url: `postgres://fixture/clone_${owned.next++}`,
    drop: vi.fn(),
  }),
  ownTestDatabaseProducer: async (
    _url: string,
    start: () => Promise<{ database: unknown; close(): Promise<void> }>,
  ) => {
    const producer = await start();
    owned.closes.push(producer.close);
    return producer;
  },
}));

vi.mock("./connection.js", async (original) => ({
  ...(await original<typeof import("./connection.js")>()),
  createDatabase: ({ connectionString }: { connectionString: string }) => {
    const pool = { url: connectionString, destroy: vi.fn(async () => undefined) };
    owned.pools.push(pool);
    return pool;
  },
}));

// Guards the old file-wide pool surviving into another test's store/helper bundle.
it("binds separate immutable store fixtures to owned clone pools", async () => {
  const first = await createStoreFixture();
  const second = await createStoreFixture();
  expect(first.database).not.toBe(second.database);
  expect(first.store).not.toBe(second.store);
  expect(first.databaseUrl).not.toBe(second.databaseUrl);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(second)).toBe(true);
  expect(owned.pools.map(({ url }) => url)).toEqual([first.databaseUrl, second.databaseUrl]);
  await Promise.all(owned.closes.map((close) => close()));
  expect(owned.pools.map(({ destroy }) => destroy.mock.calls.length)).toEqual([1, 1]);
});
