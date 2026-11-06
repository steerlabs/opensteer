import type { HostRuntime } from "./runtime.js";

/** Often enough that a hung step is named well before the supervisor kills the Host. */
const slowStopLogIntervalMs = 1_000;

/** Exits once closed, so a handle left open can't hold the process until it is killed. */
export async function stopHost(
  runtime: Pick<HostRuntime, "app" | "close" | "closingStep">,
  signal: string,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  const { log } = runtime.app;
  const started = performance.now();
  log.info({ signal }, "Opensteer Host shutting down");
  const slow = setInterval(
    () => log.warn({ step: runtime.closingStep() }, "Opensteer Host still shutting down"),
    slowStopLogIntervalMs,
  );
  slow.unref();
  let code = 0;
  try {
    await runtime.close();
  } catch (error) {
    code = 1;
    log.error({ err: error, step: runtime.closingStep() }, "Opensteer Host did not close cleanly");
  } finally {
    clearInterval(slow);
  }
  log.info({ elapsedMs: Math.round(performance.now() - started) }, "Opensteer Host stopped");
  exit(code);
}
