import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeCommandProbes, planLaunch, resolveCommand } from "./command.js";
import { echoArgvScript, generatedShims } from "./commandShims.test-support.js";
import { processSupervisorExecutableVariable } from "./processControl.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer cmd ☃ "));
  roots.push(root);
  return root;
}

/** The inherited environment with PATH replaced, in one spelling. */
function environmentWithPath(directories: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0].toUpperCase() !== "PATH",
      ),
    ),
    Path: directories,
  };
}

/** Resolves and plans `command` as the Runner does, then runs it under the real Go supervisor. */
async function runSupervised(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Record<string, string>,
  kind?: "batch" | "batch-shim",
) {
  const resolved = resolveCommand(command, { cwd, environment, platform: "win32" });
  if (!resolved) throw new Error(`${command} was not resolved`);
  if (kind) expect(resolved.kind).toBe(kind);
  const plan = planLaunch(resolved, args, { environment, platform: "win32" });
  const supervisor = process.env[processSupervisorExecutableVariable];
  if (!supervisor) throw new Error("The test setup did not name the process supervisor");
  const child = spawn(
    supervisor,
    [
      ...(plan.windowsCommandLine ? ["--windows-command-line", plan.windowsCommandLine] : []),
      "--",
      plan.executable,
      ...plan.args,
    ],
    { cwd, env: environment, stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return {
    code,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

const trickyArguments = [
  "plain",
  "with space",
  "",
  "naïve ☃ 日本語",
  'say "hi"',
  '"',
  "trailing\\",
  "trailing space\\",
  "C:\\dir with space\\",
  'back\\\\"slash',
  "tab\there",
  "%SystemRoot%",
  "%",
  "!SystemRoot!",
  "^",
  "a&echo injected",
  "a|echo injected",
  "a && echo injected",
  "a>redirected.txt",
  "a<missing.txt",
  "(paren)",
  "a,b;c=d",
  '"quoted & unquoted',
];

/** Every argument a batch parameter can hold: all but a double quote. */
const parameterArguments = trickyArguments.filter((argument) => !argument.includes('"'));

/** Reads `%~1`, `%~2` and each later `%~1` after `shift`, as an ordinary batch program would. */
const ordinaryBatch = [
  "@echo off",
  "setlocal EnableExtensions DisableDelayedExpansion",
  'set "HERE=%~dp0"',
  'set "FIRST_EXISTS=no"',
  'if exist "%~1" set "FIRST_EXISTS=yes"',
  'set "SECOND=%~2"',
  "set COUNT=0",
  ":next",
  "if [%1]==[] goto report",
  "set /a COUNT+=1",
  'set "ARG_%COUNT%=%~1"',
  "shift",
  "goto next",
  ":report",
  'node "%HERE%report.js"',
  "",
].join("\r\n");

const reportBatchParameters = `const count = Number(process.env.COUNT);
const args = Array.from({ length: count }, (_, index) => process.env["ARG_" + (index + 1)] ?? "");
process.stdout.write(JSON.stringify({ args, firstExists: process.env.FIRST_EXISTS, second: process.env.SECOND ?? "" }));`;

describe("commands on real Windows", () => {
  const nodeDirectory = path.dirname(process.execPath);

  it("gives an ordinary batch program each argument as %~n, and runs nothing else", async () => {
    const root = await directory();
    await writeFile(path.join(root, "args.cmd"), ordinaryBatch);
    await writeFile(path.join(root, "report.js"), reportBatchParameters);
    const input = path.join(root, "input file.txt");
    await writeFile(input, "");
    const args = [input, ...parameterArguments];
    const result = await runSupervised(
      "args",
      args,
      root,
      environmentWithPath(`${root};${nodeDirectory}`),
      "batch",
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    // A second command would have printed, redirected or read beside the report.
    expect(JSON.parse(result.stdout)).toEqual({ args, firstExists: "yes", second: args[1] });
    expect((await readdir(root)).sort()).toEqual(["args.cmd", "input file.txt", "report.js"]);
  });

  it.each(["npm", "pnpm"] as const)(
    "passes exact arguments through the shim %s generates, found by PATHEXT",
    async (manager) => {
      const root = await directory();
      const modules = path.join(root, "node_modules");
      await mkdir(path.join(modules, ".bin"), { recursive: true });
      await mkdir(path.join(modules, "echo-argv", "bin"), { recursive: true });
      await writeFile(path.join(modules, ".bin", "echo-argv.cmd"), generatedShims[manager].node);
      await writeFile(path.join(modules, "echo-argv", "bin", "echo-argv.js"), echoArgvScript);
      const result = await runSupervised(
        "echo-argv",
        trickyArguments,
        root,
        environmentWithPath(`${path.join(modules, ".bin")};${nodeDirectory}`),
        "batch-shim",
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      // A second command would have printed, redirected or read beside the argv.
      expect(JSON.parse(result.stdout)).toEqual(trickyArguments);
      expect(await readdir(root)).toEqual(["node_modules"]);
    },
  );

  it("discovers only runnable kinds on NTFS, in PATHEXT order and without case", async () => {
    const root = await directory();
    for (const name of ["tool.ps1", "tool.js", "TOOL.CMD", "tool.bat"])
      await writeFile(path.join(root, name), "");
    await mkdir(path.join(root, "tool.exe"));
    const resolve = (pathext: string) =>
      resolveCommand("tool", {
        cwd: root,
        environment: { PATHEXT: pathext, Path: `"${root}"` },
        platform: "win32",
      });
    expect(resolve(".EXE;.PS1;.JS;.cmd;.BAT")).toEqual({
      kind: "batch",
      path: path.join(root, "tool.cmd"),
    });
    expect(resolve(".BAT;.CMD")).toEqual({ kind: "batch", path: path.join(root, "tool.bat") });
    expect(resolve(".EXE;.PS1")).toBeUndefined();
  });

  const windowsApps = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps");
  const aliases = listAliases(windowsApps);
  it.skipIf(aliases.length === 0)(
    `finds app execution aliases at their visible path${aliases.length === 0 ? " (this Windows has none)" : ""}`,
    async () => {
      for (const alias of aliases) {
        const candidate = path.join(windowsApps, alias);
        expect(nodeCommandProbes.isExecutionAlias(candidate), candidate).toBe(true);
        expect(
          resolveCommand(alias.slice(0, -".exe".length), {
            cwd: tmpdir(),
            environment: { Path: windowsApps },
            platform: "win32",
          }),
        ).toEqual({ kind: "native", path: candidate });
      }
      if (!aliases.some((alias) => alias.toLowerCase() === "winget.exe")) return;
      const result = await runSupervised(
        "winget",
        ["--version"],
        tmpdir(),
        environmentWithPath(windowsApps),
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^v\d+\./u);
    },
  );
});

/** Windows keeps only app execution aliases as programs in this directory. */
function listAliases(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".exe"));
  } catch {
    return [];
  }
}
