import { spawnSupervised } from "@opensteer/harness";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectClaudeExecutable } from "./executable.js";
import {
  fakeClaudeTreeScript,
  processIsAlive,
  readFakeClaudeTreeReport,
} from "./fake-claude-tree.test-support.js";
import { claudeSdkProcess } from "./sdk-process.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1]),
  );
}

describe("Claude Code under the Windows process supervisor", () => {
  it.each(["SIGTERM", "SIGKILL"] as const)(
    "ends the whole Job when the SDK kills its child with %s",
    async (signal) => {
      const root = await mkdtemp(join(tmpdir(), "opensteer-claude-tree-"));
      roots.push(root);
      const config = join(root, "mcp-config.json");
      await writeFile(config, "{}");
      const supervised = spawnSupervised({
        args: ["-e", fakeClaudeTreeScript, "--", "--mcp-config", config],
        cwd: root,
        environment: inheritedEnvironment(),
        executable: process.execPath,
        output: "raw",
      });
      const child = claudeSdkProcess(supervised);
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code)),
      );
      const report = await readFakeClaudeTreeReport(child.stdout);
      expect(processIsAlive(report.grandchild)).toBe(true);

      expect(child.kill(signal)).toBe(true);
      expect(child.killed).toBe(true);
      await exited;

      const survived = processIsAlive(report.grandchild);
      if (survived) process.kill(report.grandchild);
      expect(survived).toBe(false);
      expect(child.exitCode).not.toBeNull();
    },
  );

  it("inspects an npm-installed Claude Code through its native entry, under the supervisor", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer claude npm "));
    roots.push(root);
    const native = join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    await mkdir(join(native, ".."), { recursive: true });
    await writeFile(join(root, "claude.cmd"), "@echo off\r\nexit /b 1\r\n");
    // Node stands in for claude.exe: it answers `--version` with its own version,
    // which proves the native entry ran rather than the batch shim.
    await copyFile(process.execPath, native);

    const result = await inspectClaudeExecutable(join(root, "claude.cmd"), process.env);

    expect(result).toMatchObject({ status: "unsupported" });
    expect(result.detail).toContain(process.version);
  });
});
