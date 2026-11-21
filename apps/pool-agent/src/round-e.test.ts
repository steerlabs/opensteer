/**
 * Round E (pool-agent-round-d-recheck-gemini.md, the lead's decisions). Each test was written
 * against the round D head (04f6c56b0) and failed there for the reason the re-check gives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callBrowserPoolAgent } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { callFor, fixture, open, slotId } from "./review.test-support.js";
import { guestCharge } from "./capacity.js";
import { homeKeyPair, startTestPoolAgent, testGuest } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

describe("E1: nothing admitted under the old key acts after the replacement", () => {
  it("refuses an old-key, old-term apply that arrives while the replacement stops the guest", async () => {
    const f = await fixture();
    await f.call("start");
    const running = await f.status();
    const kills = f.driver.operations.filter((entry) => entry === `kill:${slotId}`).length;
    let release!: () => void;
    f.driver.gate("kill", new Promise<void>((resolve) => (release = resolve)));
    const next = homeKeyPair();
    const replacing = f.agent.agent.replaceKey({ slotId, term: 2, homeKey: next.spki });
    // The replacement is stopping the guest.
    await expect
      .poll(() => f.driver.operations.filter((entry) => entry === `kill:${slotId}`).length)
      .toBe(kills + 1);
    const applied = vi.spyOn(f.agent.agent, "apply");
    const pause = callFor(running, "pause");
    const sent = callBrowserPoolAgent(
      { url: f.agent.url, homeKey: f.home.privateKey, agentKey: f.controlKey },
      slotId,
      1,
      { op: "apply", call: pause },
    ).then(
      (reply) => reply,
      (error: unknown) => error,
    );
    // It was authenticated under the old key and old term, and waits on the slot's lane.
    await expect.poll(() => applied.mock.calls.length).toBe(1);
    release();
    f.driver.gate("kill", undefined);
    await replacing;
    const reply = await sent;
    // Refused as unauthenticated: no answer, so nothing of the new term is learned.
    expect(reply).toBeInstanceOf(Error);
    expect((reply as Error).message).toMatch(/not signed by this slot's Home/u);
    expect(JSON.stringify(reply)).not.toMatch(/"term":2/u);
    // Nothing written into the new Home's results.
    expect(await f.agent.agent.result(slotId, 2, pause.id)).toBeNull();
    expect(f.agent.agent.effects(slotId)).toEqual(["start", "lost"]);
  });
});

describe("E2: a step that timed out is drained before its slot's lane is released", () => {
  it("leaves no proxy socket for a slot deleted while its slow revive still ran", async () => {
    const f = await fixture({ deadlines: { network: 50 } });
    await f.call("start");
    await f.call("stop");
    // The proxy tripped its start limit; its revive at the next start is slow.
    f.driver.proxyDown.add(slotId);
    f.driver.sockets.delete(slotId);
    let release!: () => void;
    f.driver.gate("reviveProxy", new Promise<void>((resolve) => (release = resolve)));
    let gaveUp = false;
    const starting = f.call("start").then(
      (result) => ((gaveUp = true), result),
      (error: unknown) => ((gaveUp = true), error),
    );
    await expect.poll(() => f.driver.operations.includes(`reviveProxy:${slotId}`)).toBe(true);
    // Past the step's deadline: the start gave up on the revive (it answered, or it drains).
    await vi.waitFor(() =>
      expect(gaveUp || f.events.some((event) => event.event === "step.draining")).toBe(true),
    );
    const deleting = f.agent.agent.deleteSlot(slotId);
    // The delete removes the slot now if nothing holds the slot's lane any more.
    await vi
      .waitFor(() => expect(f.driver.removed).toContain(slotId), { timeout: 300 })
      .catch(() => undefined);
    release();
    f.driver.gate("reviveProxy", undefined);
    await starting;
    expect(await deleting).toBe(true);
    expect(f.driver.sockets.has(slotId)).toBe(false);
  });
});

/** Slots on one fake host that holds two guests (2 GiB each) in memory. */
async function host(ids: readonly string[]) {
  const agent = await startTestPoolAgent({ saveAfterMs: null });
  open.push(agent);
  agent.driver.capacity = { guestBytes: 2 * guestCharge(testGuest.memoryMib), proxies: 10 };
  for (const id of ids)
    await agent.agent.createSlot({
      slotId: id,
      term: 1,
      homeKey: homeKeyPair().spki,
      guest: testGuest,
    });
  const call = async (id: string, kind: Parameters<typeof callFor>[1]) =>
    agent.agent.apply(callFor(await agent.agent.status(id, 1), kind));
  const tier = (id: string) =>
    agent.agent.summaries().find((entry) => entry.slotId === id)?.status.phase === "paused"
      ? agent.driver.writers(id) > 0
        ? "memory"
        : "disk"
      : agent.agent.summaries().find((entry) => entry.slotId === id)?.status.phase;
  return { agent, call, tier };
}

describe("E4: the host never starts or wakes a guest it has no memory for", () => {
  it("saves the oldest guest paused in memory to disk to make room for a start", async () => {
    const h = await host(["a", "b", "c"]);
    await h.call("a", "start");
    await h.call("a", "pause");
    await h.call("b", "start");
    await h.call("b", "pause");
    await h.call("c", "start");
    // The oldest park went to disk; the newer stays in memory; never more than two guests.
    expect(h.tier("a")).toBe("disk");
    expect(h.tier("b")).toBe("memory");
    expect(h.tier("c")).toBe("running");
    expect(h.agent.driver.processes.size).toBe(2);
  });

  it("makes room for a wake from disk the same way", async () => {
    const h = await host(["a", "b", "c"]);
    await h.call("a", "start");
    await h.call("a", "pause");
    await h.call("b", "start");
    await h.call("c", "start");
    // a went to disk to let c in; now c is parked in memory and a wakes from disk.
    expect(h.tier("a")).toBe("disk");
    await h.call("c", "pause");
    await h.call("a", "resume");
    expect(h.tier("a")).toBe("running");
    expect(h.tier("c")).toBe("disk");
    expect(h.agent.driver.processes.size).toBe(2);
  });

  it("refuses a start as 'not now', writing nothing, when no guest in memory can be saved", async () => {
    const h = await host(["a", "b", "c"]);
    await h.call("a", "start");
    await h.call("b", "start");
    const start = callFor(await h.agent.agent.status("c", 1), "start");
    await expect(h.agent.agent.apply(start)).rejects.toMatchObject({ name: "AgentUnavailable" });
    expect(await h.agent.agent.result("c", 1, start.id)).toBeNull();
    expect(h.agent.agent.effects("c")).toEqual([]);
    expect(h.tier("c")).toBe("stopped");
    expect(h.agent.driver.processes.size).toBe(2);
    // Once a guest leaves memory the same start is let in.
    await h.call("b", "stop");
    expect((await h.agent.agent.apply(start)).applied).toBe(true);
  });

  it("refuses a wake from disk as 'not now' when every guest in memory is running", async () => {
    const h = await host(["a", "b", "c"]);
    await h.call("a", "start");
    await h.call("a", "pause");
    await h.call("b", "start");
    await h.call("c", "start");
    expect(h.tier("a")).toBe("disk");
    const wake = callFor(await h.agent.agent.status("a", 1), "resume");
    await expect(h.agent.agent.apply(wake)).rejects.toMatchObject({ name: "AgentUnavailable" });
    expect(h.tier("a")).toBe("disk");
    expect(await h.agent.agent.result("a", 1, wake.id)).toBeNull();
  });
});
