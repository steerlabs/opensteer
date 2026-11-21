/** Round E, E2: a host tool takes the signal of the step it runs for. */
import { describe, expect, it } from "vitest";
import { withStepSignal } from "../step-signal.js";
import { run } from "./exec.js";

describe("a host tool under a step's signal", () => {
  it("is ended when its step is given up on", async () => {
    const step = new AbortController();
    const started = Date.now();
    const sleeping = withStepSignal(step.signal, () => run("sleep", ["5"]));
    setTimeout(() => step.abort(), 50);
    await expect(sleeping).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("is not started at all once its step was given up on", async () => {
    const step = new AbortController();
    step.abort();
    await expect(withStepSignal(step.signal, () => run("true", []))).rejects.toThrow(
      /not started/u,
    );
  });
});
