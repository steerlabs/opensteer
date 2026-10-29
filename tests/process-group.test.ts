import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopProcessGroup } from "../packages/shared/src/processGroup.js";
import { runBounded } from "../scripts/command-runner.js";

/*
 * Ways a command's descendants can outlive the caller that ran it, which then
 * releases locks while they still write:
 * - with its output in a file, no pipe keeps the command open, so the caller
 *   settles once the direct child exits, stopped or not, while a descendant
 *   ignoring SIGTERM runs on;
 * - with pipes, a lingering descendant holds them open, so the caller waits
 *   for its own timeout instead;
 * - the SIGKILL escalation is cancelled when the direct child exits;
 * - joining the group loses the command's own result;
 * - a member this process may not signal (EPERM) keeps the join, and every
 *   lock its caller holds, waiting forever.
 */

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const leftovers: number[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const pid of leftovers.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform !== "win32")("a command's process group", () => {
  const endings = ["stopped", "exit 0", "exit 1"] as const;
  it.each(
    (["outputFile", "pipes"] as const).flatMap((output) =>
      endings.map((ending) => [ending, output] as const),
    ),
  )(
    "settles a command that %s only once its whole group has exited (%s)",
    { timeout: 30_000 },
    async (ending, output) => {
      const directory = await mkdtemp(path.join(tmpdir(), "opensteer-process-group-"));
      directories.push(directory);
      const pidFile = path.join(directory, "descendant.pid");
      const descendant = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const exit = ending === "stopped" ? "" : `process.exit(${ending.slice(-1)});`;
      const command = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" }); const wait = () => require("node:fs").existsSync(${JSON.stringify(pidFile)}) ? (() => { ${exit} })() : setTimeout(wait, 10); wait(); setInterval(() => {}, 1000);`;
      const stop = new AbortController();
      const started = Date.now();
      const settled = runBounded(process.execPath, ["-e", command], {
        signal: stop.signal,
        timeoutMs: 10_000,
        ...(output === "outputFile" ? { outputFile: path.join(directory, "output.log") } : {}),
      }).then(
        (stdout) => ({ resolved: true as const, stdout }),
        (error: unknown) => ({ resolved: false as const, error }),
      );
      let pid: number | undefined;
      while (pid === undefined) {
        pid = await readFile(pidFile, "utf8").then(Number, () => undefined);
        if (Date.now() - started > 9_000) throw new Error("the descendant never started");
        if (pid === undefined) await delay(25);
      }
      leftovers.push(pid);

      if (ending === "stopped") stop.abort(new Error("stopped by the test"));
      const result = await settled;
      expect(alive(pid)).toBe(false);
      // The command's own result survives the join.
      if (ending === "exit 0") expect(result.resolved).toBe(true);
      else
        expect(result.resolved ? "" : String(result.error)).toMatch(
          ending === "stopped" ? /stopped by the test/u : /failed \(exit 1\)/u,
        );
      expect(Date.now() - started).toBeLessThan(9_000);
    },
  );

  it(
    "gives up, naming the group, when only members it may not signal remain",
    { timeout: 15_000 },
    async () => {
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid < 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        return true;
      });
      try {
        const started = Date.now();
        const outcome = await Promise.race([
          stopProcessGroup(4242, { graceMs: 100, reapMs: 500 }).then(
            () => "stopped",
            (error: unknown) => error,
          ),
          delay(5_000).then(() => "still waiting"),
        ]);
        expect(String(outcome)).toMatch(/process group 4242.*EPERM/iu);
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        kill.mockRestore();
      }
    },
  );
});
