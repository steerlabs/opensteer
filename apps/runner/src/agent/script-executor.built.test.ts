import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { programSandboxMounts } from "../sandbox/harness-sandbox.js";

const runnerRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distMainPath = join(runnerRoot, "dist", "main.js");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("built Runner CLI path resolution (Z2)", () => {
  it("resolves existing opensteer CLI paths from bundled dist/main.js, honors OPENSTEER_CLI, and plans bwrap mounts", async () => {
    if (!existsSync(distMainPath)) {
      execFileSync("pnpm", ["build"], { cwd: runnerRoot, stdio: "inherit" });
    }
    // Load dist/main.js directly in native Node ESM (matching production and avoiding Vite
    // transforming the multi-megabyte pre-built bundle inside the test).
    const probeOutput = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const built = await import(${JSON.stringify(pathToFileURL(distMainPath).href)});
         console.log(JSON.stringify({
           resolved: built.resolveAutomationCliPaths(undefined, {}),
           overridden: built.resolveAutomationCliPaths(undefined, {
             OPENSTEER_CLI: "/app/cli/opensteer-cli.mjs",
             OPENSTEER_CLI_BIN_DIR: "/app/bin",
           }),
         }));`,
      ],
      { encoding: "utf8" },
    );
    const { overridden, resolved } = JSON.parse(probeOutput.trim()) as {
      readonly resolved: { readonly cliBinDirectory: string; readonly cliScriptPath: string };
      readonly overridden: { readonly cliBinDirectory: string; readonly cliScriptPath: string };
    };

    // Call with empty env so it uses dist/main.js's OWN bundled import.meta.url.
    expect(resolved.cliBinDirectory).toBe(join(runnerRoot, "bin"));
    expect(resolved.cliScriptPath).toBe(join(runnerRoot, "cli", "opensteer-cli.mjs"));
    await expect(access(resolved.cliBinDirectory)).resolves.toBeUndefined();
    await expect(access(resolved.cliScriptPath)).resolves.toBeUndefined();

    // Respects container OPENSTEER_CLI / OPENSTEER_CLI_BIN_DIR without overriding them.
    expect(overridden).toEqual({
      cliBinDirectory: "/app/bin",
      cliScriptPath: "/app/cli/opensteer-cli.mjs",
    });

    // The sandbox launch plan accepts the built bundle's resolved read-only directories.
    const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-z2-sandbox-")));
    tempDirs.push(root);
    const dataDirectory = join(root, "runner-data");
    const temporaryDirectory = join(root, "tmp");
    const workspaceRoot = join(root, "workspaces");
    const workspaceDirectory = join(workspaceRoot, "workspace");
    const privateDirectory = join(dataDirectory, "private");
    await Promise.all([
      mkdir(dataDirectory, { recursive: true }),
      mkdir(temporaryDirectory, { recursive: true }),
      mkdir(workspaceDirectory, { recursive: true }),
      mkdir(privateDirectory, { recursive: true }),
    ]);
    const args = await programSandboxMounts(
      {
        dataDirectory,
        freshProc: true,
        temporaryDirectory,
        workspaceRoots: [workspaceRoot],
      },
      {
        environment: { PATH: `${resolved.cliBinDirectory}:/usr/bin:/bin` },
        privateDirectory,
        readOnlyDirectories: [resolved.cliBinDirectory, dirname(resolved.cliScriptPath)],
        workspacePath: workspaceDirectory,
      },
    );
    expect(args).toContain("--ro-bind");
    expect(args).toContain(await realpath(resolved.cliBinDirectory));
    expect(args).toContain(await realpath(dirname(resolved.cliScriptPath)));
  });
});
