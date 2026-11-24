let activeProcessSmokeGuard: string | null = null;

/**
 * Node-process equivalent of `installSmokeGuard` for driver scripts (`test-electron-quit.ts`,
 * `test-electron-menu-bar.ts`) that run setup/codesign before spawning Electron trials.
 * Emits the starting line immediately and enforces one guard per process.
 */
export function installProcessSmokeGuard(
  name: string,
  timeoutMs = 180_000,
  onFail?: () => void,
): () => void {
  if (activeProcessSmokeGuard !== null) {
    throw new Error(
      `Smoke guard already installed for "${activeProcessSmokeGuard}" in this process; refusing duplicate "${name}".`,
    );
  }
  activeProcessSmokeGuard = name;
  process.stdout.write(`[smoke] ${name}: starting (pid=${process.pid}, timeout=${timeoutMs}ms)\n`);
  let exiting = false;
  const fail = (kind: string, detail: unknown): void => {
    if (exiting) return;
    exiting = true;
    const message =
      detail instanceof Error ? (detail.stack ?? detail.message) : String(detail ?? "unknown");
    process.stderr.write(`[smoke] ${name}: ${kind}: ${message}\n`);
    try {
      onFail?.();
    } catch (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error
          ? (cleanupError.stack ?? cleanupError.message)
          : String(cleanupError ?? "unknown");
      process.stderr.write(`[smoke] ${name}: cleanup failed: ${cleanupMessage}\n`);
    }
    process.exit(1);
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
    if (activeProcessSmokeGuard === name) activeProcessSmokeGuard = null;
  };
}
