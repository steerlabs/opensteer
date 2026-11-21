/**
 * The re-check of the two fix rounds (pool-agent-recheck-gemini.md, findings 1 to 9).
 * Each test was written against 09fd4c244 and failed there for the reason the re-check gives.
 */
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { fixture, open } from "./review.test-support.js";
import type { FaultyJournal } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

describe("finding 1: a save that fails does not spin", () => {
  it("tries a save that always fails a bounded number of times, with two writes each", async () => {
    const f = await fixture({ saveAfterMs: 1, faultyJournal: true });
    await f.call("start");
    await f.call("pause");
    f.driver.fail("snapshot", new Error("The snapshot failed."), 10_000);
    const journal = f.agent.journal as FaultyJournal;
    const before = journal.writes;
    await delay(400);
    const attempts = f.driver.operations.filter((entry) => entry.startsWith("snapshot:")).length;
    // One attempt; the next waits 30 s.
    expect(attempts).toBe(1);
    expect(journal.writes - before).toBe(2);
    expect(await f.status()).toMatchObject({ phase: "paused" });
  });

  it("does not try or journal a save the array has no room for until space changes", async () => {
    const f = await fixture({ saveAfterMs: 1, faultyJournal: true });
    await f.call("start");
    f.driver.room = false;
    await f.call("pause");
    const journal = f.agent.journal as FaultyJournal;
    const before = journal.writes;
    await delay(300);
    expect(f.driver.operations.filter((entry) => entry.startsWith("snapshot:"))).toEqual([]);
    expect(journal.writes - before).toBe(0);
    expect(f.events.filter((event) => event.event === "save.no-room")).toHaveLength(1);
  });
});
