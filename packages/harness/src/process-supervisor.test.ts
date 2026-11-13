import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectStreamText, spawnSupervised } from "./process-supervisor.js";

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
