import { describe, expect, it } from "vitest";
import { MemorySecureStore } from "./memory-secure-store.js";
import {
  createSecureRecordStore,
  maxRecordChunks,
  maxSecureStoreValueBytes,
  splitIntoSecureStoreChunks,
} from "./secure-record-store.js";

const store = () => {
  const secureStore = new MemorySecureStore();
  return { records: createSecureRecordStore({ keyPrefix: "test", secureStore }), secureStore };
};

/** Stops the write at the `occurrence`th `step`, the way a terminated process would. */
const dieAt = (secureStore: MemorySecureStore, step: string, occurrence = 1): void => {
  let seen = 0;
  secureStore.interrupt = (current) => {
    if (current !== step) return;
    seen += 1;
    if (seen === occurrence) throw new Error("The operating system stopped this app.");
  };
};

describe("splitIntoSecureStoreChunks", () => {
  it("never exceeds the ceiling in bytes, not characters", () => {
    const value = "é".repeat(4_000);
    const chunks = splitIntoSecureStoreChunks(value);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(
        maxSecureStoreValueBytes,
      );
    }
    expect(chunks.join("")).toBe(value);
  });

  it("does not split a surrogate pair", () => {
    const value = "🔥".repeat(1_000);
    for (const chunk of splitIntoSecureStoreChunks(value)) {
      expect(chunk).toBe(chunk.normalize());
      expect([...chunk].every((character) => character === "🔥")).toBe(true);
    }
  });
});

describe("createSecureRecordStore", () => {
  it("round-trips a record larger than one value", async () => {
    const { records } = store();
    const value = "a".repeat(10_000);
    await records.write("account", value);

    expect(await records.read("account")).toBe(value);
  });

  it("drops the chunks a shorter rewrite no longer uses", async () => {
    const { records, secureStore } = store();
    await records.write("account", "a".repeat(6_000));
    await records.write("account", "short");

    expect(await records.read("account")).toBe("short");
    expect(secureStore.keys).toEqual(["test.account", "test.account.g1.0"]);
  });

  it("removes every chunk and the manifest", async () => {
    const { records, secureStore } = store();
    await records.write("account", "a".repeat(6_000));
    await records.remove("account");

    expect(secureStore.keys).toEqual([]);
    expect(await records.read("account")).toBeNull();
  });

  it("refuses a record too large to store rather than truncating it", async () => {
    const { records } = store();
    const value = "a".repeat(maxSecureStoreValueBytes * (maxRecordChunks + 1));

    await expect(records.write("account", value)).rejects.toThrow(/too large/u);
    expect(await records.read("account")).toBeNull();
  });

  it("reports a record whose chunks went missing rather than returning part of it", async () => {
    const { records, secureStore } = store();
    await records.write("account", "a".repeat(6_000));
    await secureStore.deleteItemAsync("test.account.g0.1");

    await expect(records.read("account")).rejects.toThrow(/incomplete/u);
  });

  it("reports an unreadable manifest", async () => {
    const { records, secureStore } = store();
    secureStore.put("test.account", "not a count");

    await expect(records.read("account")).rejects.toThrow(/unreadable/u);
  });

  it("never mixes two generations when a rewrite is interrupted part way", async () => {
    const { records, secureStore } = store();
    const held = "a".repeat(6_000);
    await records.write("account", held);
    dieAt(secureStore, "set:test.account.g1.1");

    await expect(records.write("account", "b".repeat(3_000))).rejects.toThrow(/stopped this app/u);

    secureStore.interrupt = () => undefined;
    expect(await records.read("account")).toBe(held);
  });

  it("commits the manifest only after every chunk of the new generation is stored", async () => {
    const { records, secureStore } = store();
    const held = "a".repeat(6_000);
    await records.write("account", held);
    // The second manifest write of the rewrite is the commit; the first only
    // announces the generation the chunks are about to go under.
    dieAt(secureStore, "set:test.account", 2);

    await expect(records.write("account", "replacement")).rejects.toThrow(/stopped this app/u);

    secureStore.interrupt = () => undefined;
    expect(await records.read("account")).toBe(held);
    expect(secureStore.peek("test.account.g1.0")).toBe("replacement");
  });

  it("finishes a collection the operating system interrupted, on the next write", async () => {
    const { records, secureStore } = store();
    await records.write("account", "a".repeat(6_000));
    dieAt(secureStore, "delete:test.account.g0.0");

    await expect(records.write("account", "short")).rejects.toThrow(/stopped this app/u);
    // The manifest committed, so the record is already the new one; only the
    // superseded chunks are still on the device.
    secureStore.interrupt = () => undefined;
    expect(await records.read("account")).toBe("short");
    expect(secureStore.keys).toContain("test.account.g0.0");

    await records.write("account", "third");
    expect(await records.read("account")).toBe("third");
    expect(secureStore.keys).toEqual(["test.account", "test.account.g2.0"]);
  });

  it("leaves no readable record when a first write never reaches its manifest", async () => {
    const { records, secureStore } = store();
    dieAt(secureStore, "set:test.account");

    await expect(records.write("account", "first")).rejects.toThrow(/stopped this app/u);

    secureStore.interrupt = () => undefined;
    expect(await records.read("account")).toBeNull();
  });

  it("keeps the last writer's value whole when two writes to one record overlap", async () => {
    const { records, secureStore } = store();
    const long = "long".padEnd(6_000, "a");
    const short = "short";

    // Both are in flight before either has read the manifest. Picking one
    // generation for both would interleave their chunks into a value that was
    // neither of them.
    await Promise.all([records.write("account", long), records.write("account", short)]);

    expect(await records.read("account")).toBe(short);
    expect(secureStore.keys).toEqual(["test.account", "test.account.g1.0"]);
  });

  it("leaves no orphan chunk behind when an interrupted write is retried and then removed", async () => {
    const { records, secureStore } = store();
    dieAt(secureStore, "set:test.account.g0.2");

    await expect(records.write("account", "a".repeat(6_000))).rejects.toThrow(/stopped this app/u);
    secureStore.interrupt = () => undefined;
    await records.write("account", "short");
    await records.remove("account");

    expect(secureStore.keys).toEqual([]);
  });
});
