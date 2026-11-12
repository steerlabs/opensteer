import { processStopTimeoutMs } from "@opensteer/shared/processControl";
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

/**
 * Without its session lock this Host no longer fences its Deployment database
 * against a second Host, so it stops and exits non-zero, even if a close step
 * hangs on the same lost database.
 */
export async function stopHostOnAuthorityLoss(
  runtime: Pick<HostRuntime, "app" | "close" | "closingStep">,
  error: Error,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  runtime.app.log.fatal({ err: error }, "Opensteer Host lost its Deployment database lock");
  let exited = false;
  const fail = () => {
    if (exited) return;
    exited = true;
    clearTimeout(deadline);
    exit(1);
  };
  const deadline = setTimeout(fail, processStopTimeoutMs);
  await stopHost(runtime, "deployment authority lost", fail);
}
