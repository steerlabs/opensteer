import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectStreamText,
  killedSupervisedProcesses,
  runningSupervisedProcesses,
  spawnSupervised,
} from "./process-supervisor.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function node(script: string, options: Partial<Parameters<typeof spawnSupervised>[0]> = {}) {
  return spawnSupervised({
    args: ["-e", script],
    cwd: tmpdir(),
    environment: {},
    executable: process.execPath,
    ...options,
  } as Parameters<typeof spawnSupervised>[0]);
}

describe("spawnSupervised", () => {
  it.skipIf(process.platform === "win32")(
    "reports a target a SIGKILL ended as 137 and keeps whose it was, as the kernel's kill for memory looks",
    async () => {
      const marker = `killed-${process.pid}-${Date.now()}`;
      const child = node('process.kill(process.pid, "SIGKILL")', {
        environment: { OPENSTEER_TEST_MARKER: marker },
      });
      await expect(child.exited).resolves.toMatchObject({ code: 137 });
      expect(
        killedSupervisedProcesses().some(
          ({ environment }) => environment.OPENSTEER_TEST_MARKER === marker,
        ),
      ).toBe(true);
      // An ordinary failure is not a kill.
      const failed = node("process.exit(3)", {
        environment: { OPENSTEER_TEST_MARKER: `${marker}-3` },
      });
      await expect(failed.exited).resolves.toMatchObject({ code: 3 });
      expect(
        killedSupervisedProcesses().some(
          ({ environment }) => environment.OPENSTEER_TEST_MARKER === `${marker}-3`,
        ),
      ).toBe(false);
    },
  );

  describe.skipIf(process.platform === "win32")("a SIGKILL the supervisor did not send", () => {
    const recorded = (marker: string) =>
      killedSupervisedProcesses().some(
        ({ environment }) => environment.OPENSTEER_TEST_MARKER === marker,
      );
    const ready = async (child: ReturnType<typeof node>) => {
      for await (const chunk of child.stdout) if (String(chunk).includes("ready")) return;
    };

    it("is kept for a target that a SIGKILL nobody sent ended while the parent was stopping it", async () => {
      // As the kernel's kill for memory does while a Run is stopping.
      const marker = `while-stopping-${process.pid}-${Date.now()}`;
      const child = node(
        'process.on("SIGTERM", () => process.kill(process.pid, "SIGKILL")); console.log("ready"); setInterval(() => {}, 1000)',
        { environment: { OPENSTEER_TEST_MARKER: marker } },
      );
      await ready(child);
      await child.terminate(5_000);
      await expect(child.exited).resolves.toMatchObject({ code: 137 });
      expect(recorded(marker)).toBe(true);
    });

    it("is not kept for a target the supervisor itself forced", async () => {
      const marker = `forced-${process.pid}-${Date.now()}`;
      const child = node(
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
        { environment: { OPENSTEER_TEST_MARKER: marker } },
      );
      await ready(child);
      await child.terminate(100);
      await expect(child.exited).resolves.toMatchObject({ code: 137 });
      expect(recorded(marker)).toBe(false);
    });

    it("is not kept for a target that exited 137 by itself", async () => {
      const marker = `exited-${process.pid}-${Date.now()}`;
      const child = node("process.exit(137)", { environment: { OPENSTEER_TEST_MARKER: marker } });
      await expect(child.exited).resolves.toMatchObject({ code: 137 });
      expect(recorded(marker)).toBe(false);
    });
  });

  // Sol's sequence (X2): the kernel kills the target while its supervisor cannot run; a force
  // queued for an already dead target must not count as what ended it.
  it.skipIf(process.platform === "win32").each(Array.from({ length: 50 }, (_, run) => run))(
    "reports a target the kernel killed while a force for it was queued, as its own end (run %i)",
    async (run) => {
      const marker = `zombie-${process.pid}-${run}-${Date.now()}`;
      const child = node("console.log(process.pid); setInterval(() => {}, 1000)", {
        environment: { OPENSTEER_TEST_MARKER: marker },
        output: "raw",
      });
      const supervisorPid = child.child.pid!;
      let printed = "";
      for await (const chunk of child.stdout) {
        printed += chunk.toString("utf8");
        if (printed.includes("\n")) break;
      }
      const targetPid = Number(printed.trim());
      process.kill(supervisorPid, "SIGSTOP");
      try {
        process.kill(targetPid, "SIGKILL");
        await vi.waitFor(() =>
          expect(
            execFileSync("ps", ["-o", "stat=", "-p", String(targetPid)], { encoding: "utf8" }),
          ).toMatch(/^Z/u),
        );
        runningSupervisedProcesses()
          .find(({ pid }) => pid === supervisorPid)
          ?.control("force");
      } finally {
        process.kill(supervisorPid, "SIGCONT");
      }
      await expect(child.exited).resolves.toMatchObject({ code: 137 });
      expect(
        killedSupervisedProcesses().some(
          ({ environment }) => environment.OPENSTEER_TEST_MARKER === marker,
        ),
      ).toBe(true);
    },
  );

  // The same sequence with the step that lost run 16 of hosted CI held open. On Linux a killed
  // target's leader reads as a zombie (`ps` shows Z) while its other threads are still dying, and
  // waitid reports nothing until the last of them has gone. Those threads are kept dying here (one
  // CPU, the idle class, a busy loop on that CPU) while the force reaches the supervisor.
  it.runIf(process.platform === "linux").each(Array.from({ length: 3 }, (_, run) => run))(
    "reports a target the kernel killed whose other threads were still dying when a force for it was queued (run %i)",
    async (run) => {
      const marker = `dying-${process.pid}-${run}-${Date.now()}`;
      const child = node("console.log(process.pid); setInterval(() => {}, 1000)", {
        environment: { OPENSTEER_TEST_MARKER: marker },
        output: "raw",
      });
      const supervisorPid = child.child.pid!;
      let printed = "";
      for await (const chunk of child.stdout) {
        printed += chunk.toString("utf8");
        if (printed.includes("\n")) break;
      }
      const targetPid = Number(printed.trim());
      const threads = () =>
        readdirSync(`/proc/${String(targetPid)}/task`).filter((id) => id !== String(targetPid));
      const held = threads();
      expect(held.length).toBeGreaterThan(0);
      for (const thread of held) {
        execFileSync("taskset", ["-pc", "0", thread], { stdio: "ignore" });
        execFileSync("chrt", ["--idle", "-p", "0", thread], { stdio: "ignore" });
      }
      const busy = spawn("taskset", ["-c", "0", process.execPath, "-e", "for (;;) {}"], {
        stdio: "ignore",
      });
      let stillDying = false;
      try {
        process.kill(supervisorPid, "SIGSTOP");
        try {
          process.kill(targetPid, "SIGKILL");
          await vi.waitFor(() =>
            expect(
              execFileSync("ps", ["-o", "stat=", "-p", String(targetPid)], { encoding: "utf8" }),
            ).toMatch(/^Z/u),
          );
          stillDying = threads().length > 0;
          runningSupervisedProcesses()
            .find(({ pid }) => pid === supervisorPid)
            ?.control("force");
        } finally {
          process.kill(supervisorPid, "SIGCONT");
        }
        await expect(child.exited).resolves.toMatchObject({ code: 137 });
      } finally {
        if (busy.pid !== undefined) process.kill(busy.pid, "SIGKILL");
      }
      // The window was held: when the force was queued, the target had not wholly ended.
      expect(stillDying).toBe(true);
      expect(
        killedSupervisedProcesses().some(
          ({ environment }) => environment.OPENSTEER_TEST_MARKER === marker,
        ),
      ).toBe(true);
    },
  );

  it("refuses to start anything without the native supervisor", () => {
    vi.stubEnv(processSupervisorExecutableVariable, undefined);
    expect(() => node("")).toThrow(processSupervisorExecutableVariable);
  });

  it.skipIf(process.platform === "win32")(
    "finds a bare command on the child's own PATH",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "opensteer-supervised-path-"));
      roots.push(root);
      await writeFile(join(root, "tool"), `#!/bin/sh\nprintf '%s|' "$@"\n`);
      await chmod(join(root, "tool"), 0o755);
      const child = spawnSupervised({
        args: ["a b", ""],
        cwd: root,
        environment: { PATH: root },
        executable: "tool",
      });
      const output = collectStreamText(child.stdout);
      await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
      await expect(output).resolves.toBe("a b||");
    },
  );

  it("reports a command missing from the child's PATH as ENOENT", () => {
    expect(() =>
      spawnSupervised({
        args: [],
        cwd: tmpdir(),
        environment: { PATH: tmpdir() },
        executable: "opensteer-no-such-command",
      }),
    ).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("gives a child closed stdin end-of-file at once", async () => {
    const child = node("process.stdin.resume().on('end', () => process.exit(7))", {
      stdin: "closed",
    });
    await expect(child.exited).resolves.toEqual({ code: 7, signal: null });
  });

  it("yields every byte of raw output, past the bounded default", async () => {
    const bytes = 3 * 1_048_576;
    const child = node(`process.stdout.write(Buffer.alloc(${bytes}, 97))`, { output: "raw" });
    const output = collectStreamText(child.stdout);
    await child.exited;
    expect((await output).length).toBe(bytes);
  });
});
