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

  // Round F, found while preparing E2 on a host: a tool that does not end at once when its
  // step is given up on (one that ignores SIGTERM, standing for a request PID 1 already took)
  // must still be waited for, or the drained step ends while the tool still acts.
  it("is waited for until it has exited, even after its step was given up on", async () => {
    const step = new AbortController();
    const started = Date.now();
    const stubborn = withStepSignal(step.signal, () =>
      run("bash", ["-c", "trap '' TERM; sleep 1"]),
    ).catch(() => "given up");
    setTimeout(() => step.abort(), 50);
    expect(await stubborn).toBe("given up");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("is not started at all once its step was given up on", async () => {
    const step = new AbortController();
    step.abort();
    await expect(withStepSignal(step.signal, () => run("true", []))).rejects.toThrow(
      /not started/u,
    );
  });
});
