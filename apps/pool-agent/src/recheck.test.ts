/**
 * The re-check of the two fix rounds (pool-agent-recheck-gemini.md, findings 1 to 9).
 * Each test was written against 09fd4c244 and failed there for the reason the re-check gives.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  BrowserPoolAgentSlotDeleted,
  callBrowserPoolAgent,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { afterEach, describe, expect, it } from "vitest";
import { callFor, fixture, open, slotId } from "./review.test-support.js";
import { SlotConflict } from "./agent.js";
import { SlotNumbers } from "./firecracker/slot-numbers.js";
import { DriverStateUncertain } from "./driver.js";
import { homeKeyPair, testGuest, type FaultyJournal } from "./test-support.js";

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

describe("finding 3: a host reboot with 400 slots does not fail the agent's start", () => {
  it("starts within its deadline with nothing prepared, and prepares a slot when it starts", async () => {
    const f = await fixture();
    const home = homeKeyPair();
    for (let index = 0; index < 400; index += 1)
      await f.agent.agent.createSlot({
        slotId: `many-${index}`,
        term: 1,
        homeKey: home.spki,
        guest: testGuest,
      });
    f.driver.rebootHost();
    // 400 slots one at a time would take 4 s; the start has 1 s.
    f.driver.prepareMs = 10;
    const began = performance.now();
    await f.restart({ deadlines: { sweep: 1_000 } });
    expect(performance.now() - began).toBeLessThan(1_000);
    expect(f.driver.prepared.size).toBe(0);
    const status = await f.agent.agent.status("many-7", 1);
    expect(await f.agent.agent.apply(callFor(status, "start"))).toMatchObject({ applied: true });
    expect([...f.driver.prepared]).toEqual(["many-7"]);
    expect(f.driver.violations).toEqual([]);
  }, 60_000);
});

describe("finding 4: a deleted slot keeps nothing secret", () => {
  it("destroys the control key, keeps only id, term, time and the Home's public key", async () => {
    const f = await fixture();
    await f.call("start");
    await f.agent.agent.deleteSlot(slotId, 1);
    const directory = f.agent.journal.directory;
    const [name] = (await readdir(directory)).filter((entry) => entry.endsWith(".json"));
    const tombstone = JSON.parse(await readFile(join(directory, name!), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(tombstone).sort()).toEqual(["deletedAt", "homeKey", "slotId", "term", "v"]);
    expect(f.agent.agent.controlKey(slotId)).toBeUndefined();
    await f.restart();
    expect(f.agent.agent.controlKey(slotId)).toBeUndefined();
  });

  it("answers the slot's own Home, signed by the host key, that the slot was deleted", async () => {
    const f = await fixture();
    await f.agent.agent.deleteSlot(slotId, 1);
    const call = () =>
      callBrowserPoolAgent(
        {
          url: f.agent.url,
          homeKey: f.home.privateKey,
          agentKey: f.controlKey,
          hostKey: f.agent.hostPublicKey,
        },
        slotId,
        1,
        { op: "status" },
      );
    await expect(call()).rejects.toBeInstanceOf(BrowserPoolAgentSlotDeleted);
  });

  it("prunes an expired tombstone while the agent runs", async () => {
    let now = Date.now();
    const f = await fixture({ now: () => now, hostCheckMs: 20 });
    await f.agent.agent.deleteSlot(slotId, 1);
    now += 31 * 24 * 60 * 60_000;
    await expect
      .poll(async () =>
        (await readdir(f.agent.journal.directory)).filter((e) => e.endsWith(".json")),
      )
      .toEqual([]);
    expect(f.agent.agent.authority(slotId)).toBeUndefined();
  });
});

describe("finding 5: delete goes through the same lanes as everything else", () => {
  it("leaves a slot whose delete failed with its timers, so its parked state still expires", async () => {
    const f = await fixture({ retentionMs: 400, retryMs: 50 });
    await f.call("start");
    await f.call("pause");
    f.driver.fail("discard", new Error("The discard failed."));
    await expect(f.agent.agent.deleteSlot(slotId, 1)).rejects.toThrow("The discard failed.");
    // Nothing asks the agent: only its own timer can discard the expired state.
    await delay(1_000);
    const discards = f.driver.operations.filter((entry) => entry === `discard:${slotId}`);
    expect(discards.length).toBeGreaterThanOrEqual(2);
  });

  it("does not let a create see a slot in the middle of its delete", async () => {
    const f = await fixture();
    await f.call("start");
    await f.call("pause");
    let release!: () => void;
    f.driver.gate("discard", new Promise<void>((resolve) => (release = resolve)));
    const deleting = f.agent.agent.deleteSlot(slotId, 1);
    await expect.poll(() => f.driver.operations.includes(`discard:${slotId}`)).toBe(true);
    const creating = f.agent.agent.createSlot({
      slotId,
      term: 1,
      homeKey: f.home.spki,
      guest: testGuest,
    });
    release();
    await deleting;
    await expect(creating).rejects.toBeInstanceOf(SlotConflict);
  });

  it("releases the number of a create whose network did not finish in time", async () => {
    const f = await fixture({ deadlines: { network: 50 } });
    let release!: () => void;
    f.driver.prepareGate = new Promise<void>((resolve) => (release = resolve));
    const home = homeKeyPair();
    const creating = f.agent.agent.createSlot({
      slotId: "late",
      term: 1,
      homeKey: home.spki,
      guest: testGuest,
    });
    // The prepare outlives its deadline, as a real one that ignores its signal does.
    await delay(150);
    release();
    await expect(creating).rejects.toThrow();
    await expect.poll(() => f.driver.prepared.has("late")).toBe(false);
    await expect.poll(() => f.driver.removed.includes("late")).toBe(true);
  });

  it("treats a failed write of the slot-number file as uncertain, as the journal's", async () => {
    const numbers = new SlotNumbers("/nonexistent", {
      write: async () => {
        throw new Error("The directory sync failed after the rename.");
      },
    });
    await expect(numbers.allocate("a")).rejects.toBeInstanceOf(DriverStateUncertain);
    await expect(numbers.allocate("b")).rejects.toBeInstanceOf(DriverStateUncertain);
  });

  it("stops the agent when the driver's own state became uncertain", async () => {
    const fatal: unknown[] = [];
    const f = await fixture({ fatal: (error) => fatal.push(error) });
    f.driver.prepareError = new DriverStateUncertain("The slot-number file is uncertain.");
    await expect(f.call("start")).rejects.toThrow();
    expect(fatal).toHaveLength(1);
  });
});
