import { afterEach, expect, it } from "vitest";
import { callFor, fixture, open } from "./review.test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

// Review G4(a): a flushed host ruleset is noticed and re-applied, on a timer and before a
// start or a resume, so no guest starts or wakes without the host's own rules.
it("re-applies the host's rules before a start and on its own timer", async () => {
  const f = await fixture({ hostCheckMs: 20 });
  f.driver.hostTableGone = true;
  await f.agent.agent.apply(callFor(await f.status(), "start"));
  expect(f.driver.hostRepairs).toBe(1);
  f.driver.hostTableGone = true;
  await expect.poll(() => f.driver.hostRepairs, { timeout: 2_000 }).toBe(2);
});
