/**
 * Round E (pool-agent-round-d-recheck-gemini.md, the lead's decisions). Each test was written
 * against the round D head (04f6c56b0) and failed there for the reason the re-check gives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callBrowserPoolAgent } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { callFor, fixture, open, slotId } from "./review.test-support.js";
import { homeKeyPair } from "./test-support.js";

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
    const starting = f.call("start").then(
      (result) => result,
      (error: unknown) => error,
    );
    await expect.poll(() => f.driver.operations.includes(`reviveProxy:${slotId}`)).toBe(true);
    // Well past the step's deadline: the start has given up on the revive.
    await new Promise((resolve) => setTimeout(resolve, 200));
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
