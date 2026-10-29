import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { stopProcessGroup } from "@opensteer/shared/processGroup";

/** Keep expected test failures distinct from a fixture killed before teardown. */
export async function runParallelismFixture(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    outputFile?: string;
    timeoutMs?: number;
  },
): Promise<{ code: number | null; signal: string | null; timedOut: boolean; error?: string }> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise((resolve) => {
    const output = options.outputFile ? openSync(options.outputFile, "a", 0o600) : undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        detached: process.platform !== "win32",
        stdio: ["ignore", output ?? "ignore", output ?? "ignore"],
      });
    } finally {
      if (output !== undefined) closeSync(output);
    }
    let timedOut = false;
    let joined: Promise<void> | undefined;
    const stop = () =>
      (joined ??=
        child.pid && process.platform !== "win32"
          ? stopProcessGroup(child.pid, { graceMs: 1_000 })
          : Promise.resolve());
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") child.kill("SIGKILL");
      void stop().catch(() => {}); // Report cleanup errors when the child closes.
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, error: error.message });
    });
    child.once("exit", () => {
      clearTimeout(timer);
      // Stop descendants even if they outlive their fixture's leader.
      void stop().catch(() => {});
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      void (async () => {
        let error = timedOut
          ? `Fixture exceeded its deadline (${timeoutMs} ms); child group stopped`
          : signal
            ? `Fixture ended by ${signal}`
            : undefined;
        try {
          await stop();
        } catch (cause) {
          error = `${error ?? "Fixture exited"}; child group cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
        }
        resolve({ code, signal, timedOut, ...(error ? { error } : {}) });
      })();
    });
  });
}
