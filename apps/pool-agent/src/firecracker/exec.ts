import { execFile, spawn } from "node:child_process";

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly input?: string;
  /** Exit codes that are not failures (such as "already exists"). */
  readonly allow?: readonly number[];
}

/** Runs a host tool without a shell; arguments are never interpreted. */
export function run(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024, env: { PATH: hostPath } },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 0;
        if (error && !(options.allow ?? []).includes(code))
          reject(new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Starts a long-lived child detached from the agent, so an agent restart does not end it. */
export function launch(file: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", env: { PATH: hostPath } });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid!);
    });
  });
}

/** Waits for a child we started to exit, with its code. */
export function runToExit(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore", env: { PATH: hostPath } });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${file} did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

const hostPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
