import { createPublicKey, randomUUID, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { browserPoolControlBytes } from "@opensteer/browser-runtime-core/browser-pool";
import type {
  BrowserPoolAgentCall,
  BrowserPoolAgentKind,
  BrowserPoolAgentResult,
  BrowserPoolAgentStatus,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { AgentCrashed } from "./agent.js";
import { FakeHypervisorDriver } from "./fake-driver.test-support.js";
import { homeKeyPair, startTestPoolAgent, testGuest, type TestPoolAgent } from "./test-support.js";

const slotId = "slot-a";
const open: TestPoolAgent[] = [];

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close();
});

async function fixture(options: Parameters<typeof startTestPoolAgent>[0] = {}) {
  let agent = await startTestPoolAgent(options);
  open.push(agent);
  const home = homeKeyPair();
  const summary = await agent.agent.createSlot({
    slotId,
    term: 1,
    homeKey: home.spki,
    guest: testGuest,
  });
  const controlKey = createPublicKey({
    key: Buffer.from(summary.controlKey, "base64"),
    format: "der",
    type: "spki",
  });
  const status = () => agent.agent.status(slotId, 1);
  const call = async (
    kind: BrowserPoolAgentKind,
    extra: Partial<BrowserPoolAgentCall> = {},
  ): Promise<BrowserPoolAgentResult> => {
    const current = await status();
    return agent.agent.apply(callFor(current, kind, extra));
  };
  const restart = async (next: Parameters<TestPoolAgent["restart"]>[0] = {}) => {
    const index = open.indexOf(agent);
    agent = await agent.restart(next);
    open.splice(index, 1, agent);
    return agent;
  };
  return {
    get agent() {
      return agent;
    },
    get driver() {
      return agent.driver;
    },
    home,
    controlKey,
    status,
    call,
    restart,
    effects: () => agent.agent.effects(slotId).filter((effect) => effect !== "lost"),
  };
}

function callFor(
  status: BrowserPoolAgentStatus,
  kind: BrowserPoolAgentKind,
  extra: Partial<BrowserPoolAgentCall> = {},
): BrowserPoolAgentCall {
  return {
    id: randomUUID(),
    slotId: status.slotId,
    term: status.term,
    kind,
    expect: {
      instance: status.instance,
      epoch: status.epoch,
      phase: status.phase,
      savedStateId: status.savedState?.id ?? null,
    },
    ...(kind === "resume" ? { intent: { id: randomUUID(), sequence: 1 } } : {}),
    ...(kind === "sign"
      ? {
          control: {
            kind: "retire" as const,
            fence: {
              slot: status.slotId,
              term: status.term,
              instance: status.instance!,
              epoch: status.epoch!,
            },
            intent: { id: randomUUID(), sequence: 1 },
          },
        }
      : {}),
    ...extra,
  };
}

describe("identity and signed controls", () => {
  it("issues the instance at start and the epoch at resume, and signs each control in order", async () => {
    const f = await fixture();
    const started = await f.call("start");
    expect(started).toMatchObject({ applied: true, status: { phase: "running", epoch: 1 } });
    expect(started.control).toMatchObject({
      kind: "install",
      fence: { slot: slotId, term: 1, epoch: 1 },
    });
    expect(
      verify(
        null,
        browserPoolControlBytes(started.control!),
        f.controlKey,
        Buffer.from(started.signature!, "base64"),
      ),
    ).toBe(true);
    const signed = await f.call("sign");
    expect(signed.control).toMatchObject({ kind: "retire", expect: started.control!.fence });
    expect(signed.control!.sequence).toBe(started.control!.sequence + 1);
    const paused = await f.call("pause");
    expect(paused.savedState).toMatchObject({ id: expect.any(String) });
    const resumed = await f.call("resume");
    expect(resumed.control).toMatchObject({
      kind: "adopt",
      fence: { instance: started.status.instance, epoch: 2 },
      expect: started.control!.fence,
    });
    expect(resumed.control!.sequence).toBe(signed.control!.sequence + 1);
    // A fresh start is a new instance; the sequence keeps growing across it and across restarts.
    await f.call("stop");
    await f.restart();
    const again = await f.call("start");
    expect(again.status.instance).not.toBe(started.status.instance);
    expect(again.control!.sequence).toBe(resumed.control!.sequence + 1);
  });

  it("installs with no expected fence on a hypervisor whose guests start empty, and tells the guest its floor", async () => {
    const driver = new FakeHypervisorDriver({ startsEmpty: true });
    const booted: Record<string, string>[] = [];
    const boot = driver.boot.bind(driver);
    driver.boot = async (input, signal) => {
      booted.push({ ...input.parameters });
      return boot(input, signal);
    };
    const f = await fixture({ driver });
    const first = await f.call("start");
    expect(first.control!.expect).toBeNull();
    expect(booted[0]).toMatchObject({
      "opensteer.pool.slot": slotId,
      "opensteer.pool.floor": `1.${first.control!.sequence - 1}`,
    });
    await f.call("stop");
    expect((await f.call("start")).control!.expect).toBeNull();
  });

  it("refuses a sign for another fence, an install or an adopt", async () => {
    const f = await fixture();
    await f.call("start");
    const status = await f.status();
    const fence = { slot: slotId, term: 1, instance: status.instance!, epoch: status.epoch! };
    for (const control of [
      { kind: "retire" as const, fence: { ...fence, epoch: 9 } },
      { kind: "install" as const, fence },
      { kind: "adopt" as const, fence },
    ])
      expect(await f.call("sign", { control })).toMatchObject({
        applied: false,
        reason: "not-current",
      });
  });
});

describe("fencing", () => {
  it("refuses a call for another slot, a stale term or a stale predecessor, and stores the refusal", async () => {
    const f = await fixture();
    await f.call("start");
    const status = await f.status();
    const stale = callFor(status, "pause", { term: 0 });
    await expect(f.agent.agent.apply({ ...stale, slotId: "slot-b" })).rejects.toThrow(
      "does not know this slot",
    );
    expect(await f.agent.agent.apply(stale)).toMatchObject({ applied: false, reason: "fenced" });
    const old = callFor({ ...status, epoch: 7 }, "pause");
    expect(await f.agent.agent.apply(old)).toMatchObject({
      applied: false,
      reason: "predecessor-changed",
    });
    // The same id answers the same refusal, also after the state moved.
    await f.call("pause");
    expect(await f.agent.agent.apply(old)).toMatchObject({
      applied: false,
      reason: "predecessor-changed",
    });
    await expect(f.agent.agent.status(slotId, 2)).rejects.toThrow(
      "does not know this slot and term",
    );
    expect(await f.agent.agent.result(slotId, 2, old.id)).toBeNull();
    expect(f.effects()).toEqual(["start", "pause"]);
  });

  it("never starts a second writer beside a process of the slot that the journal does not know", async () => {
    const f = await fixture();
    f.driver.processes.set("stray", {
      slotId,
      jailId: "stray",
      state: "running",
      snapshotted: null,
    });
    expect((await f.call("start")).applied).toBe(true);
    expect(f.driver.writers(slotId)).toBe(1);
    expect(f.driver.processes.has("stray")).toBe(false);
    expect(f.driver.violations).toEqual([]);
  });

  it("answers a repeated or concurrent call with its stored result and acts once", async () => {
    const f = await fixture();
    const status = await f.status();
    const start = callFor(status, "start");
    const [one, two] = await Promise.all([f.agent.agent.apply(start), f.agent.agent.apply(start)]);
    expect(two).toEqual(one);
    expect(await f.agent.agent.apply(start)).toEqual(one);
    expect(await f.agent.agent.result(slotId, 1, start.id)).toEqual(one);
    expect(f.effects()).toEqual(["start"]);
    expect(f.driver.violations).toEqual([]);
  });
});

describe("saved state", () => {
  it("consumes a saved state with exactly one resume, in memory and from disk", async () => {
    const f = await fixture();
    await f.call("start");
    for (const tier of ["memory", "disk"] as const) {
      await f.call("pause");
      const paused = await f.status();
      if (tier === "disk")
        expect(await f.agent.agent.saveToDisk(slotId, paused.savedState!.id)).toBe("saved");
      const first = callFor(paused, "resume");
      expect(await f.agent.agent.apply(first)).toMatchObject({ applied: true });
      expect(await f.agent.agent.apply(first)).toMatchObject({ applied: true });
      expect(await f.agent.agent.apply(callFor(paused, "resume"))).toMatchObject({
        applied: false,
      });
    }
    expect(f.effects()).toEqual(["start", "pause", "resume", "pause", "save", "resume"]);
    expect(f.driver.violations).toEqual([]);
    expect(f.driver.images.size).toBe(0);
  });

  it("saves an idle guest to disk on its own, frees its VMM, and restores it in a new jail", async () => {
    const f = await fixture({ saveAfterMs: 10 });
    await f.call("start");
    await f.call("pause");
    await expect.poll(() => f.effects()).toEqual(["start", "pause", "save"]);
    expect(f.driver.writers(slotId)).toBe(0);
    expect(f.driver.images.size).toBe(1);
    const resumed = await f.call("resume");
    expect(resumed).toMatchObject({ applied: true, status: { phase: "running", epoch: 2 } });
    expect(f.driver.writers(slotId)).toBe(1);
    expect(f.driver.images.size).toBe(0);
    expect(f.driver.operations.filter((op) => op.startsWith("restore"))).toHaveLength(1);
    expect(f.driver.violations).toEqual([]);
  });

  it("lets a wake that arrives during a save resume from memory and never loads the image", async () => {
    const f = await fixture();
    await f.call("start");
    await f.call("pause");
    const paused = await f.status();
    let finish!: () => void;
    f.driver.gate("snapshot", new Promise<void>((resolve) => (finish = resolve)));
    const saving = f.agent.agent.saveToDisk(slotId, paused.savedState!.id);
    await expect.poll(() => f.driver.operations.at(-1)).toBe(`snapshot:${slotId}`);
    const waking = f.agent.agent.apply(callFor(paused, "resume"));
    finish();
    expect(await saving).toBe("skipped");
    expect(await waking).toMatchObject({ applied: true });
    expect(f.driver.operations.some((op) => op.startsWith("restore"))).toBe(false);
    expect(f.driver.images.size).toBe(0);
    expect(f.driver.violations).toEqual([]);
  });

  it("discards a saved state at its discard time on the agent's clock, in memory and on disk", async () => {
    let now = Date.parse("2026-11-21T00:00:00Z");
    const f = await fixture({ now: () => now });
    await f.call("start");
    for (const tier of ["memory", "disk"] as const) {
      const paused = (await f.call("pause")).status;
      expect(Date.parse(paused.savedState!.discardAt)).toBe(now + 24 * 60 * 60_000);
      if (tier === "disk") await f.agent.agent.saveToDisk(slotId, paused.savedState!.id);
      now += 24 * 60 * 60_000 - 1;
      expect((await f.status()).phase).toBe("paused");
      now += 1;
      expect(await f.status()).toMatchObject({ phase: "stopped", savedState: null, epoch: null });
      expect(f.driver.writers(slotId)).toBe(0);
      expect(f.driver.images.size).toBe(0);
      expect(await f.agent.agent.apply(callFor(paused, "resume"))).toMatchObject({
        applied: false,
      });
      await f.call("start");
    }
  });

  it("discards an expired saved state at an agent restart", async () => {
    let now = Date.parse("2026-11-21T00:00:00Z");
    const f = await fixture({ now: () => now });
    await f.call("start");
    await f.call("pause");
    await f.agent.agent.saveToDisk(slotId, (await f.status()).savedState!.id);
    now += 25 * 60 * 60_000;
    await f.restart();
    expect(await f.status()).toMatchObject({ phase: "stopped", savedState: null });
    expect(f.driver.images.size).toBe(0);
  });

  it("discards a saved state that changed, or that this host's software cannot load", async () => {
    for (const damage of ["corrupt", "fingerprint"] as const) {
      const f = await fixture();
      await f.call("start");
      await f.call("pause");
      const id = (await f.status()).savedState!.id;
      await f.agent.agent.saveToDisk(slotId, id);
      if (damage === "corrupt") f.driver.corrupt(id);
      else f.driver.changeFingerprint("fake-host-2");
      await f.restart();
      expect(await f.status()).toMatchObject({ phase: "stopped", savedState: null });
      expect((await f.call("start")).applied).toBe(true);
    }
  });

  it("loses every guest and saved state when the host restarted, and starts cold", async () => {
    const f = await fixture();
    await f.call("start");
    await f.call("pause");
    await f.agent.agent.saveToDisk(slotId, (await f.status()).savedState!.id);
    f.driver.restartHost();
    await f.restart();
    expect(await f.status()).toMatchObject({ phase: "stopped", savedState: null, epoch: null });
    expect((await f.call("start")).applied).toBe(true);
  });
});

describe("failures and deadlines", () => {
  it("ends a guest whose step failed and refuses the call, so the next start is cold", async () => {
    for (const operation of ["boot", "pause", "resume", "restore", "stepClock"] as const) {
      const f = await fixture();
      if (operation !== "boot") {
        await f.call("start");
        await f.call("pause");
        if (operation === "restore")
          await f.agent.agent.saveToDisk(slotId, (await f.status()).savedState!.id);
        if (operation === "pause") await f.call("resume");
      }
      f.driver.fail(operation, new Error(`${operation} broke`));
      const kind = operation === "boot" ? "start" : operation === "pause" ? "pause" : "resume";
      const result = await f.call(kind);
      expect(result).toMatchObject({
        applied: false,
        status: { phase: "stopped", savedState: null },
      });
      expect(f.driver.writers(slotId)).toBe(0);
      expect((await f.call("start")).applied).toBe(true);
      expect(f.driver.violations).toEqual([]);
    }
  });

  it("bounds a step that never answers by its deadline", async () => {
    const f = await fixture({ deadlines: { resume: 50 } });
    await f.call("start");
    await f.call("pause");
    f.driver.fail("resume", "hang");
    const before = Date.now();
    expect(await f.call("resume")).toMatchObject({ applied: false, reason: "resume-failed" });
    expect(Date.now() - before).toBeLessThan(5_000);
  });
});

/** Every point the agent journals or acts at, with the call that reaches it. */
const crashPoints: readonly {
  point: string;
  setup: string[];
  kind: BrowserPoolAgentKind | "save";
}[] = [
  { point: "start:journaled", setup: [], kind: "start" },
  { point: "start:booted", setup: [], kind: "start" },
  { point: "pause:journaled", setup: ["start"], kind: "pause" },
  { point: "pause:paused", setup: ["start"], kind: "pause" },
  { point: "resume:consumed", setup: ["start", "pause"], kind: "resume" },
  { point: "resume:resumed", setup: ["start", "pause"], kind: "resume" },
  { point: "resume:consumed", setup: ["start", "pause", "save"], kind: "resume" },
  { point: "resume:restored", setup: ["start", "pause", "save"], kind: "resume" },
  { point: "resume:resumed", setup: ["start", "pause", "save"], kind: "resume" },
  { point: "stop:journaled", setup: ["start"], kind: "stop" },
  { point: "stop:killed", setup: ["start", "pause"], kind: "stop" },
  { point: "save:journaled", setup: ["start", "pause"], kind: "save" },
  { point: "save:written", setup: ["start", "pause"], kind: "save" },
  { point: "save:image-recorded", setup: ["start", "pause"], kind: "save" },
  { point: "save:vmm-ended", setup: ["start", "pause"], kind: "save" },
];

describe("agent restart between any two steps", () => {
  for (const { point, setup, kind } of crashPoints)
    it(`settles ${kind} interrupted at ${point}${setup.includes("save") ? " from disk" : ""} with one writer and a working cold start`, async () => {
      let armed = false;
      const f = await fixture({
        checkpoint: (reached) => {
          if (armed && reached === point) throw new AgentCrashed(reached);
        },
      });
      for (const step of setup) {
        if (step === "save")
          await f.agent.agent.saveToDisk(slotId, (await f.status()).savedState!.id);
        else await f.call(step as BrowserPoolAgentKind);
      }
      const before = await f.status();
      armed = true;
      let interrupted: BrowserPoolAgentCall | undefined;
      if (kind === "save") {
        await expect(
          f.agent.agent.saveToDisk(slotId, before.savedState!.id),
        ).rejects.toBeInstanceOf(AgentCrashed);
      } else {
        interrupted = callFor(before, kind);
        await expect(f.agent.agent.apply(interrupted)).rejects.toBeInstanceOf(AgentCrashed);
      }
      armed = false;
      await f.restart();
      expect(f.driver.writers(slotId)).toBeLessThanOrEqual(1);
      const after = await f.status();
      if (interrupted) {
        // The Home repeats the same call: it gets a definite answer, the same one each time.
        const answer = await f.agent.agent.apply(interrupted);
        expect(await f.agent.agent.apply(interrupted)).toEqual(answer);
        if (kind === "stop")
          expect(answer).toMatchObject({ applied: true, status: { phase: "stopped" } });
        else
          expect(answer).toMatchObject({
            applied: false,
            reason: "interrupted",
            status: { phase: "stopped" },
          });
      } else {
        // An interrupted save keeps the live state when it can be proven, in memory or on disk.
        expect(after.phase).toBe("paused");
        expect(after.savedState?.id).toBe(before.savedState!.id);
        expect((await f.call("resume")).applied).toBe(true);
        await f.call("stop");
      }
      const status = await f.status();
      if (status.phase !== "stopped") await f.call("stop");
      expect((await f.call("start")).applied).toBe(true);
      expect(f.driver.writers(slotId)).toBe(1);
      expect(f.driver.violations).toEqual([]);
    });
});

describe("administration", () => {
  it("fences the previous Home when its key is replaced with a higher term", async () => {
    const f = await fixture();
    await f.call("start");
    const before = await f.status();
    const next = homeKeyPair();
    await expect(f.agent.agent.replaceKey({ slotId, term: 1, homeKey: next.spki })).rejects.toThrow(
      "higher term",
    );
    await f.agent.agent.replaceKey({ slotId, term: 2, homeKey: next.spki });
    expect(await f.agent.agent.apply(callFor(before, "pause"))).toMatchObject({
      applied: false,
      reason: "fenced",
    });
    await expect(f.agent.agent.status(slotId, 1)).rejects.toThrow();
    expect((await f.agent.agent.status(slotId, 2)).term).toBe(2);
  });

  it("erases a slot only after its VMM ended and its saved state is gone", async () => {
    const f = await fixture();
    await f.call("start");
    await f.call("pause");
    await f.agent.agent.saveToDisk(slotId, (await f.status()).savedState!.id);
    expect(await f.agent.agent.deleteSlot(slotId)).toBe(true);
    expect(f.driver.writers(slotId)).toBe(0);
    expect(f.driver.images.size).toBe(0);
    expect(f.driver.prepared.has(slotId)).toBe(false);
    await f.restart();
    expect(f.agent.agent.slotIds()).toEqual([]);
  });
});

describe("many slots", () => {
  it("wakes three guests while two others save, with saves capped and wakes not behind them", async () => {
    const driver = new FakeHypervisorDriver();
    const f = await fixture({ driver, maxConcurrentSaves: 2 });
    const slots = ["w1", "w2", "w3", "s1", "s2"];
    const status = (id: string) => f.agent.agent.status(id, 1);
    const call = async (id: string, kind: BrowserPoolAgentKind) =>
      f.agent.agent.apply(callFor(await status(id), kind));
    for (const id of slots) {
      await f.agent.agent.createSlot({
        slotId: id,
        term: 1,
        homeKey: f.home.spki,
        guest: testGuest,
      });
      await call(id, "start");
      await call(id, "pause");
    }
    for (const id of ["w1", "w2", "w3"])
      await f.agent.agent.saveToDisk(id, (await status(id)).savedState!.id);
    // Both saves hold their snapshot open until every wake has finished.
    let release!: () => void;
    driver.gate("snapshot", new Promise<void>((resolve) => (release = resolve)));
    const saves = ["s1", "s2"].map(async (id) =>
      f.agent.agent.saveToDisk(id, (await status(id)).savedState!.id),
    );
    await expect
      .poll(() => driver.operations.filter((op) => op.startsWith("snapshot:s")).length)
      .toBe(2);
    const wakes = await Promise.all(["w1", "w2", "w3"].map((id) => call(id, "resume")));
    expect(wakes.every((result) => result.applied)).toBe(true);
    expect(driver.operations.filter((op) => op.startsWith("restore:w"))).toHaveLength(3);
    release();
    expect(await Promise.all(saves)).toEqual(["saved", "saved"]);
    for (const id of slots) expect(driver.writers(id)).toBeLessThanOrEqual(1);
    expect(driver.violations).toEqual([]);
  });
});
