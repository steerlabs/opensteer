import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectClaudeExecutable, resolveClaudeExecutable } from "./executable.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function cli(version = "2.1.295") {
  const root = await mkdtemp(join(tmpdir(), "installed-claude-"));
  roots.push(root);
  const executable = join(root, "claude");
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${version} (Claude Code)'\n`);
  await chmod(executable, 0o755);
  return { root, executable };
}

describe("installed Claude executable", () => {
  it("uses the supplied login-shell PATH, even when the process PATH differs", async () => {
    const { root, executable } = await cli();
    expect(resolveClaudeExecutable("claude", { PATH: root })).toBe(executable);
  });
  it("honors an explicit configured executable over PATH", async () => {
    const { executable } = await cli();
    expect(resolveClaudeExecutable(executable, { PATH: "/missing" })).toBe(executable);
    await expect(inspectClaudeExecutable(executable, { PATH: "/missing" })).resolves.toEqual({
      status: "available",
      executable,
      version: "2.1.295",
    });
  });
  it.each(["cmd", "bat", "ps1"])(
    "resolves a Windows .%s shim to the native npm entry",
    (extension) => {
      const shim = `C:\\Users\\person\\npm\\claude.${extension}`;
      const native =
        "C:\\Users\\person\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
      expect(
        resolveClaudeExecutable(shim, {}, "win32", {
          locate: () => shim,
          isFile: (candidate) => candidate === native,
        }),
      ).toBe(native);
    },
  );
  it("supports older Windows npm packages with cli.js", () => {
    const shim = "C:\\npm\\claude.cmd";
    const script = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    expect(
      resolveClaudeExecutable("claude", { PATH: "C:\\npm" }, "win32", {
        locate: () => shim,
        isFile: (candidate) => candidate === script,
      }),
    ).toBe(script);
  });
  it("does not return a Windows launcher when its target is absent", () => {
    expect(
      resolveClaudeExecutable("C:\\npm\\claude.cmd", {}, "win32", {
        locate: () => undefined,
        isFile: () => false,
      }),
    ).toBeUndefined();
  });
  it("uses the Runner's Node port when probing a legacy JavaScript CLI", async () => {
    const { root } = await cli();
    const script = join(root, "cli.js");
    const node = join(root, "runner-node");
    const marker = join(root, "node-used");
    await writeFile(script, 'console.log("2.1.295 (Claude Code)");');
    await writeFile(
      node,
      `#!/bin/sh\nprintf used > '${marker}'\nexec '${process.execPath}' "$@"\n`,
    );
    await chmod(node, 0o755);
    await expect(inspectClaudeExecutable(script, {}, node)).resolves.toMatchObject({
      status: "available",
      executable: script,
    });
    await expect(readFile(marker, "utf8")).resolves.toBe("used");
  });
  it("reports absent CLI with the exact install guidance", async () => {
    await expect(inspectClaudeExecutable("claude", { PATH: "/missing" })).resolves.toEqual({
      status: "unavailable",
      detail:
        "Install Claude Code from https://code.claude.com/docs/en/setup, then restart Opensteer.",
    });
  });
  it("distinguishes an unsupported installed version from absence", async () => {
    const { executable } = await cli("1.0.0");
    const result = await inspectClaudeExecutable(executable, {});
    expect(result.status).toBe("unsupported");
    expect(result.detail).toContain("1.0.0");
    expect(result.detail).toContain("2.1.294");
  });
});
