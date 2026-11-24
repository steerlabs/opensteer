import { app } from "electron";

/**
 * Prevents any Electron smoke from hanging silently for 30 minutes:
 * - emits a startup line immediately;
 * - exits non-zero on uncaught exceptions or unhandled rejections instead of opening Electron's
 *   modal error dialog;
 * - enforces an overall wall-clock bound for the smoke process.
 */
export function installSmokeGuard(name: string, timeoutMs = 180_000): () => void {
  process.stdout.write(`[smoke] ${name}: starting (pid=${process.pid}, timeout=${timeoutMs}ms)\n`);
  const fail = (kind: string, detail: unknown): void => {
    const message =
      detail instanceof Error ? (detail.stack ?? detail.message) : String(detail ?? "unknown");
    process.stderr.write(`[smoke] ${name}: ${kind}: ${message}\n`);
    app.exit(1);
  };
  const onUncaught = (error: unknown) => fail("uncaughtException", error);
  const onUnhandled = (reason: unknown) => fail("unhandledRejection", reason);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  const timer = setTimeout(() => {
    fail("timeout", `exceeded ${timeoutMs}ms`);
  }, timeoutMs);
  timer.unref();
  return () => {
    clearTimeout(timer);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
  };
}
