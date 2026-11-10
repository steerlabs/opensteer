import { expect, it } from "vitest";
import {
  RunnerAuxiliaryWelcomeSchema,
  RunnerAuxiliaryFrameFenceSchema,
} from "@opensteer/protocol/runner-auxiliary";
import { RunnerAuxiliaryFenceLedger } from "./auxiliary-fence.js";
import fences from "../../browser-core/test-vectors/fences.v1.json" with { type: "json" };

it("shares auxiliary replacement and lease decisions with native peers", () => {
  let now = fences.now;
  const scheduled: (() => void)[] = [];
  const ledger = new RunnerAuxiliaryFenceLedger({
    clock: {
      now: () => now,
      schedule: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      },
    },
  });
  const welcome = RunnerAuxiliaryWelcomeSchema.parse(fences.welcome);
  ledger.adopt(welcome);
  for (const vector of fences.comparisons)
    expect(
      ledger.accepts(RunnerAuxiliaryFrameFenceSchema.parse({ ...fences.fence, ...vector.patch })),
      vector.name,
    ).toBe(vector.accepted);
  const expired: string[] = [];
  ledger.onLeaseExpired((error) => expired.push(error.message));
  now += 999;
  scheduled.shift()?.();
  expect(expired).toEqual([]);
  ledger.renew(new Date(now + 2_000).toISOString());
  now += 2_000;
  expect(ledger.expired).toBe(true);
  expect(() => ledger.fence).toThrow("expired");
  scheduled.at(-1)?.();
  expect(expired).toEqual(["The auxiliary stream lease has expired"]);
  ledger.release();
});
