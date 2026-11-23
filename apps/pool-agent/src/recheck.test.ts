/**
 * The re-check of the two fix rounds (pool-agent-recheck-gemini.md, findings 1 to 9).
 * Each test was written against 09fd4c244 and failed there for the reason the re-check gives.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserPoolAgentSlotDeleted,
  callBrowserPoolAgent,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callFor, fixture, open, slotId } from "./review.test-support.js";
import { SlotConflict } from "./agent.js";
import { SlotNumbers } from "./firecracker/slot-numbers.js";
import { DriverStateUncertain } from "./driver.js";
import type { SlotRecord } from "./journal.js";
import { homeKeyPair, testGuest, type FaultyJournal } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

describe("finding 1: a save that fails does not spin", () => {
  it("waits longer after each failed save, with two writes per attempt", async () => {
    const failures: number[] = [];
    const f = await fixture({
      saveAfterMs: 1,
      saveRetryMs: 40,
      faultyJournal: true,
      log: (event) => {
        if (event.event === "save.failed") failures.push(performance.now());
      },
    });
    await f.call("start");
    f.driver.fail("snapshot", new Error("The snapshot failed."), 10_000);
    const journal = f.agent.journal as FaultyJournal;
    const before = journal.writes;
    await f.call("pause");
    const pauseWrites = journal.writes - before;
    await vi.waitFor(() => expect(failures.length).toBeGreaterThanOrEqual(3), { timeout: 3_000 });
    const attempts = f.driver.operations.filter((entry) => entry.startsWith("snapshot:")).length;
    expect(failures[1]! - failures[0]!).toBeGreaterThanOrEqual(39);
    expect(failures[2]! - failures[1]!).toBeGreaterThanOrEqual(79);
    expect(journal.writes - before - pauseWrites).toBe(2 * attempts);
    expect(await f.status()).toMatchObject({ phase: "paused" });
  });

  it("neither tries nor journals a save the array has no room for", async () => {
    const f = await fixture({ saveAfterMs: 1, saveRoomRetryMs: 60, faultyJournal: true });
    await f.call("start");
    f.driver.room = false;
    const journal = f.agent.journal as FaultyJournal;
    await f.call("pause");
    const before = journal.writes;
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.event === "save.no-room")).toBe(true),
    );
    expect(f.driver.operations.filter((entry) => entry.startsWith("snapshot:"))).toEqual([]);
    expect(journal.writes - before).toBe(0);
    // Room again: the next try saves, and only it wrote (its step and its image).
    f.driver.room = true;
    await vi.waitFor(async () =>
      expect((await f.status()).savedState).toMatchObject({ id: expect.any(String) }),
    );
    await vi.waitFor(() =>
      expect(f.driver.operations.filter((entry) => entry.startsWith("snapshot:"))).toHaveLength(1),
    );
    expect(f.events.filter((event) => event.event === "save.no-room")).toHaveLength(1);
  });
});

describe("finding 3: a host reboot with 400 slots does not fail the agent's start", () => {
  it("starts within its deadline with nothing prepared, and prepares a slot when it starts", async () => {
    const f = await fixture();
    const [record] = (await f.agent.journal.list()) as SlotRecord[];
    // 400 slots on disk, as a host that ran them leaves them.
    await Promise.all(
      Array.from({ length: 400 }, (_, index) =>
        f.agent.journal.write({ ...record!, slotId: `many-${index}` }),
      ),
    );
    f.driver.rebootHost();
    // Making a slot's network never finishes now: a start that waited for it would not end.
    f.driver.prepareGate = new Promise<void>(() => {});
    await f.restart({ deadlines: { sweep: 1_000 } });
    expect(f.driver.prepared.size).toBe(0);
    f.driver.prepareGate = undefined;
    const status = await f.agent.agent.status("many-7", 1);
    expect(await f.agent.agent.apply(callFor(status, "start"))).toMatchObject({ applied: true });
    expect([...f.driver.prepared]).toEqual(["many-7"]);
    expect(f.driver.violations).toEqual([]);
  });
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
    await vi.waitFor(
      () =>
        expect(
          f.driver.operations.filter((entry) => entry === `discard:${slotId}`).length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 3_000 },
    );
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
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.event === "slot.create-draining")).toBe(true),
    );
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

describe("findings 6 and 7: the host check and the agent's unit", () => {
  const script = () => readFile(new URL("../host/setup-host.sh", import.meta.url), "utf8");

  it("names l1tf among the CPU vulnerabilities and reads what the kernel said about kvm-pit", async () => {
    const text = await script();
    const named = /NAMED_VULNERABILITIES="([^"]+)"/u.exec(text)![1]!.split(" ");
    expect(named).toEqual(expect.arrayContaining(["l1tf", "spec_store_bypass"]));
    expect(text).toContain("/run/opensteer-pool/kvm-pit.json");
  });

  it("restarts the agent with a growing delay and no start limit", async () => {
    const unit = (await script())
      .split("opensteer-pool-agent.service <<EOF")[1]!
      .split("\nEOF")[0]!;
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).toContain("Restart=always");
    expect(unit).toMatch(/RestartMaxDelaySec=\d+/u);
  });
});

describe("finding 9: the small ones", () => {
  it("holds the slot until a snapshot writer that outlived its VMM has ended", async () => {
    const f = await fixture({ deadlines: { snapshot: 30, snapshotDrain: 30, kill: 30 } });
    await f.call("start");
    await f.call("pause");
    const paused = await f.status();
    let release!: () => void;
    f.driver.gate("snapshot", new Promise<void>((resolve) => (release = resolve)));
    const saving = f.agent.agent.saveToDisk(slotId, paused.savedState!.id);
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.event === "save.writer-late")).toBe(true),
    );
    const starting = f.call("start");
    // Nothing runs beside the late writer: the queued start has not booted.
    expect(f.driver.operations.filter((entry) => entry.startsWith("boot:"))).toHaveLength(1);
    release();
    await saving;
    await starting;
    expect(f.driver.images.size).toBe(0);
    expect(f.driver.violations).toEqual([]);
  });

  it("bounds the whole wait for a process state once, however many reads it takes", async () => {
    const f = await fixture({ deadlines: { inspect: 300 } });
    await f.call("start");
    const jail = [...f.driver.processes.keys()][0]!;
    f.driver.answerUnknown(jail);
    // Two quick "unknown" answers, then a read that never answers.
    f.driver.hangInspectAfter = f.driver.inspections + 2;
    const began = performance.now();
    expect(await f.status()).toMatchObject({ phase: "stopped" });
    expect(performance.now() - began).toBeLessThan(420);
  });
});
