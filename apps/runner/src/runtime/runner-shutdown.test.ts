import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  confirmRunnerShutdown,
  executionScopeVariable,
  ExecutionContainment,
} from "./execution-containment.js";

it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "proves detached engine and shell groups that ignored SIGTERM are gone",
  async () => {
    const bootId = `rbt_${randomUUID()}`;
    const dataDirectory = join(tmpdir(), `runner-proof-${randomUUID()}`);
    const containment = new ExecutionContainment({ bootId, dataDirectory });
    const engine = spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 60000);',
      ],
      {
        detached: true,
        env: { ...process.env, [executionScopeVariable]: containment.scope("test-engine") },
      },
    );
    const shell = spawn("/bin/sh", ["-c", "trap '' TERM; printf ready; while :; do :; done"], {
      detached: true,
      env: { ...process.env, [executionScopeVariable]: containment.scope("test-shell") },
    });
    const children = [engine, shell];
    const exits = children.map((child) => once(child, "exit"));
    try {
      await Promise.all(
        children.map((child, index) =>
          Promise.race([
            once(child.stdout, "data"),
            exits[index]!.then(() => {
              throw new Error("Fixture exited before installing its signal handler");
            }),
          ]),
        ),
      );
      const processIdentities = await containment.note("test-shell", [shell.pid!]);
      expect(processIdentities).toEqual([expect.stringMatching(new RegExp(`^${shell.pid}@`))]);
      await expect(
        confirmRunnerShutdown(dataDirectory, { bootId, processIdentities: [...processIdentities] }),
      ).resolves.toBe(true);
      for (const child of children) expect(() => process.kill(child.pid!, 0)).toThrow(/ESRCH/);
      expect(await Promise.all(exits)).toEqual([
        [null, "SIGKILL"],
        [null, "SIGKILL"],
      ]);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(exits);
    }
  },
);
