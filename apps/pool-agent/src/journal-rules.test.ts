/**
 * The journal rules S1 and S2 (pool-agent-review-state-sol.md, findings 1 and 8).
 * Each test was written against 5f37312fb and failed there for the reason the review gives.
 */
import { afterEach, describe, expect, it } from "vitest";
import { AgentCrashed } from "./agent.js";
import { callFor, fixture, slotId, open } from "./review.test-support.js";
import { FaultyJournal } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

describe("rule S2 and finding 8: a journal write that fails is fatal to the agent", () => {
  it("stops serving after a write reported failed once it was renamed, and the restart reads what is on disk", async () => {
    const f = await fixture({ faultyJournal: true });
    const start = callFor(await f.status(), "start");
    // The start's pending write succeeds; its result write is renamed, then reported failed.
    (f.agent.journal as FaultyJournal).failWrite("after", 1);
    await expect(f.agent.agent.apply(start)).rejects.toThrow();
    // The same process must not answer from a record it could not confirm.
    await expect(f.agent.agent.apply(start)).rejects.toThrow();
    await expect(f.agent.agent.status(slotId, 1)).rejects.toThrow();
    await f.restart({ faultyJournal: false });
    // The renamed record is the truth: the start was applied and its answer is the same.
    expect(await f.agent.agent.apply(start)).toMatchObject({ applied: true });
    expect(f.driver.writers(slotId)).toBe(1);
  });

  it("does not continue on the in-memory record after a write that never reached the disk", async () => {
    const f = await fixture({ faultyJournal: true });
    await f.call("start");
    const pause = callFor(await f.status(), "pause");
    (f.agent.journal as FaultyJournal).failWrite("before");
    await expect(f.agent.agent.apply(pause)).rejects.toThrow();
    await expect(f.agent.agent.apply(pause)).rejects.toThrow();
    await f.restart({ faultyJournal: false });
    expect(await f.status()).toMatchObject({ phase: "running" });
    expect(await f.agent.agent.apply(pause)).toMatchObject({ applied: true });
  });
});

describe("rule S1 and finding 1: recovery ends a guest and answers its call in one write", () => {
  for (const failing of [0, 1, 2])
    it(`keeps the interrupted call's id when the agent dies at recovery write ${failing + 1}`, async () => {
      let armed = false;
      const f = await fixture({
        checkpoint: (point) => {
          if (armed && point === "start:booted") throw new AgentCrashed(point);
        },
      });
      const start = callFor(await f.status(), "start");
      armed = true;
      await expect(f.agent.agent.apply(start)).rejects.toBeInstanceOf(AgentCrashed);
      armed = false;
      // The recovering agent dies at one of its own journal writes.
      await f
        .restart({ journalFault: { when: "before", skip: failing } })
        .then((agent) => agent.agent.status(slotId, 1))
        .catch(() => undefined);
      await f.restart({ faultyJournal: false });
      const answer = await f.agent.agent.apply(start);
      expect(answer).toMatchObject({ applied: false, reason: "interrupted" });
      expect(f.driver.operations.filter((op) => op.startsWith("boot")).length).toBe(1);
    });
});
