import { parentPort, workerData } from "node:worker_threads";

// Preloaded into a computer REPL worker. `workerData.preempted` maps a context
// to `{afterPrints, ms, release?}`: after that context's print number
// `afterPrints`, inside its slice, the thread sleeps off-CPU for `ms`, as a
// thread preempted on a busy machine does. No guest code runs meanwhile. With a
// `release` SharedArrayBuffer it also sleeps until the test stores 1 there.
const data: unknown = workerData;
const plans =
  typeof data === "object" && data !== null && "preempted" in data ? data.preempted : undefined;
const port = parentPort;
if (port && typeof plans === "object" && plans !== null) {
  const post = port.postMessage.bind(port);
  const prints = new Map<string, number>();
  port.postMessage = (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "text" &&
      "context" in message &&
      typeof message.context === "string"
    ) {
      const count = (prints.get(message.context) ?? 0) + 1;
      prints.set(message.context, count);
      const plan: unknown = (plans as Record<string, unknown>)[message.context];
      post(message);
      if (
        typeof plan === "object" &&
        plan !== null &&
        "afterPrints" in plan &&
        "ms" in plan &&
        plan.afterPrints === count &&
        typeof plan.ms === "number"
      ) {
        const started = performance.now();
        if ("release" in plan && plan.release instanceof SharedArrayBuffer)
          Atomics.wait(new Int32Array(plan.release), 0, 0, 10_000);
        const remaining = plan.ms - (performance.now() - started);
        if (remaining > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
      }
      return;
    }
    post(message);
  };
}
