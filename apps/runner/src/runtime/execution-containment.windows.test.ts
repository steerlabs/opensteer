import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSupervised, type SupervisedProcess } from "@opensteer/harness";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { ExecutionContainment } from "./execution-containment.js";

const directories: string[] = [];
const spawned: SupervisedProcess[] = [];

afterEach(async () => {
  for (const supervised of spawned.splice(0)) await supervised.terminate(0).catch(() => undefined);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function containment(): Promise<ExecutionContainment> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-containment-"));
  directories.push(dataDirectory);
  return new ExecutionContainment({ bootId: "rbt_a", dataDirectory });
}

/** Starts a Node target that starts `descendant`, prints its pid once it is ready, then runs `then`. */
async function supervisedTree(
  owner: ExecutionContainment,
  executionId: string,
  descendant: string,
  then: string,
): Promise<SupervisedProcess> {
  const launch = owner.wrap(
    executionId,
    (input) => input,
  )({
    args: [
      "-e",
      `const c=require("node:child_process").spawn(${descendant});` +
        `c.stdout.once("data",()=>{console.log(c.pid);${then}});`,
    ],
    cwd: tmpdir(),
    environment: { ...process.env } as Record<string, string>,
    executable: process.execPath,
  });
  const supervised = spawnSupervised({ ...launch, output: "raw", stdin: "closed" });
  spawned.push(supervised);
  await withTimeout(
    (async () => {
      for await (const chunk of supervised.stdout)
        if (chunk.toString("utf8").includes("\n")) return;
      throw new Error("The target exited before its descendant was ready");
    })(),
    20_000,
    { timeoutError: () => new Error("The supervised target never reported its descendant") },
  );
  return supervised;
}

const nodeDescendant = `process.execPath,["-e","console.log(1);setInterval(()=>{},1000)"],{stdio:["ignore","pipe","ignore"]}`;

// Gives itself an empty DACL, so the supervisor cannot open it to end it, and starts in
// its own process group, so the graceful CTRL_BREAK never reaches it: its drain fails.
// libuv starts a detached child without breaking away, so it stays in the Job.
const unopenableDescendant = `${JSON.stringify(
  join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ),
)},["-NoProfile","-NonInteractive","-EncodedCommand",${JSON.stringify(
  Buffer.from(
    `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Unopenable {
  delegate bool Handler(uint kind);
  static Handler ignore = kind => true;
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll")] static extern bool InitializeAcl(byte[] acl, int length, int revision);
  [DllImport("advapi32.dll")] static extern int SetSecurityInfo(IntPtr handle, int type, uint information, IntPtr owner, IntPtr group, byte[] dacl, IntPtr sacl);
  public static int Become() {
    SetConsoleCtrlHandler(ignore, true);
    var acl = new byte[8];
    if (!InitializeAcl(acl, acl.Length, 2)) return -1;
    return SetSecurityInfo(GetCurrentProcess(), 6, 0x80000004, IntPtr.Zero, IntPtr.Zero, acl, IntPtr.Zero);
  }
}
'@
if ([Unopenable]::Become() -ne 0) { exit 72 }
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
Start-Sleep -Seconds 600`,
    "utf16le",
  ).toString("base64"),
)}],{detached:true,stdio:["ignore","pipe","ignore"]}`;

describe("ExecutionContainment of supervised Job trees", () => {
  it("proves a tree gone once its supervisor reports the drain, with the target's own status", async () => {
    const owner = await containment();
    const supervised = await supervisedTree(
      owner,
      "run_1",
      nodeDescendant,
      "process.exitCode=3;c.unref();c.stdout.destroy()",
    );
    await expect(supervised.exited).resolves.toEqual({ code: 3, signal: null });
    await expect(owner.liveRoots("run_1")).resolves.toBe(0);
    await expect(owner.terminate("run_1")).resolves.toBe("proven");
  });

  it.each([
    {
      exit: { code: 1, signal: null },
      how: "from another process",
      kill: ({ child }: SupervisedProcess): boolean => process.kill(child.pid ?? Number.NaN),
    },
    {
      exit: { code: null, signal: "SIGTERM" },
      how: "through its own handle",
      kill: ({ child }: SupervisedProcess): boolean => child.kill(),
    },
  ])("leaves a tree unknown when its supervisor is killed $how", async ({ exit, kill }) => {
    const owner = await containment();
    const supervised = await supervisedTree(owner, "run_1", nodeDescendant, "");
    kill(supervised);
    await expect(supervised.exited).resolves.toEqual(exit);
    await expect(owner.liveRoots("run_1")).resolves.toBe(1);
    await expect(owner.terminate("run_1")).resolves.toBe("unknown");
  });

  it("leaves a tree unknown when its supervisor gives up draining", async () => {
    const owner = await containment();
    const supervised = await supervisedTree(owner, "run_1", unopenableDescendant, "");
    await expect(owner.terminate("run_1")).resolves.toBe("unknown");
    await expect(supervised.exited).resolves.toEqual({ code: 256, signal: null });
    await expect(owner.liveRoots("run_1")).resolves.toBe(1);
  });
});
