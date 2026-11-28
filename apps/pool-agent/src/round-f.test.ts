/**
 * Round F: what the agent's signed status reports for each guest state, which the Home side's
 * recovery decides from (no runtime is asked while it reports paused; the runtime is asked
 * while it reports running).
 */
import { afterEach, describe, expect, it } from "vitest";
import { callFor, open, slotId } from "./review.test-support.js";
import { homeKeyPair, startTestPoolAgent, testGuest } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

describe("the status a Home recovers from", () => {
  it("reports stopped, running, paused in memory and saved to disk as the Home reads them", async () => {
    const agent = await startTestPoolAgent({ saveAfterMs: null });
    open.push(agent);
    await agent.agent.createSlot({
      slotId,
      term: 1,
      homeKey: homeKeyPair().spki,
      guest: testGuest,
    });
    const status = () => agent.agent.status(slotId, 1);
    const call = async (kind: Parameters<typeof callFor>[1]) =>
      agent.agent.apply(callFor(await status(), kind));
    expect(await status()).toMatchObject({ phase: "stopped", savedState: null, instance: null });
    await call("start");
    const running = await status();
    expect(running).toMatchObject({ phase: "running", savedState: null });
    await call("pause");
    const inMemory = await status();
    expect(inMemory).toMatchObject({ phase: "paused", instance: running.instance });
    expect(inMemory.savedState).not.toBeNull();
    // Saved to disk: the same answer (paused, the same saved state); the tier is the agent's.
    expect(await agent.agent.saveToDisk(slotId, inMemory.savedState!.id)).toBe("saved");
    expect(agent.driver.writers(slotId)).toBe(0);
    expect(await status()).toEqual(inMemory);
    await call("resume");
    expect(await status()).toMatchObject({ phase: "running", instance: running.instance });
    await call("stop");
    expect(await status()).toMatchObject({ phase: "stopped", savedState: null });
  });
});
