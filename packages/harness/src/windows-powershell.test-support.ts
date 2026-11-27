import { tmpdir } from "node:os";
import { beforeAll } from "vitest";
import { runSupervisedCommand } from "./process-supervisor.js";

const startupTimeoutMs = 60_000;

export function warmWindowsPowerShell(
  fixture: string,
  launch: () => {
    executable: string;
    environment: Readonly<Record<string, string>>;
    args: readonly string[];
  },
): void {
  beforeAll(async () => {
    const started = performance.now();
    try {
      const { args, environment, executable } = launch();
      const { code, signal, stderr } = await runSupervisedCommand({
        executable,
        args: [...args, "-Command", "exit 0"],
        cwd: tmpdir(),
        environment,
        timeoutMs: startupTimeoutMs,
      });
      if (code !== 0) throw new Error(`Shell exited with ${signal ?? code}: ${stderr.trim()}`);
    } catch (cause) {
      throw new Error(
        `Windows PowerShell startup for ${fixture} failed (runner startup limit: ${startupTimeoutMs} ms)`,
        { cause },
      );
    } finally {
      console.info(
        `Windows PowerShell startup for ${fixture} took ${Math.round(performance.now() - started)} ms`,
      );
    }
  }, startupTimeoutMs + 10_000);
}
