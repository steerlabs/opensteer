import type { HarnessProcessLaunch } from "@opensteer/harness";
import { createId } from "@opensteer/core";
import { TriggerExecutionContextSchema, type TriggerExecutionContext } from "@opensteer/protocol";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, type TestContext } from "vitest";
import { TriggerProgramExecutor } from "./program-executor.js";

const nativeFsHelperBinary = fileURLToPath(
  new URL("../../native-fs-helper/opensteer-native-fs.exe", import.meta.url),
);
const usersSid = "S-1-5-32-545";
const systemSid = "S-1-5-18";
const fullControl = 0x1f01ff;

it("keeps a program's inputs and result private to this account under a parent other users can read", async (test) => {
  const fixture = await permissiveRoot(test);
  const root = fixture.path;
  const privateDirectory = join(root, "private");
  const context = triggerContext();
  let seen: ReturnType<typeof readAcls<"root" | "execution" | "result">> | undefined;

  const output = await fixture.track(
    executor(privateDirectory).execute({
      context,
      endpoints: { mcp: context.mcp },
      planLaunch: async (input) => {
        seen = readAcls({
          root: privateDirectory,
          execution: input.privateDirectory,
          result: input.resultFile ?? "",
        });
        return (launch: HarnessProcessLaunch) => launch;
      },
      signal: fixture.signal,
      workspace: { instructions: undefined, path: root },
    }),
  );

  expect(output).toMatchObject({ error: null, result: { doubled: 84 }, status: "succeeded" });
  if (!seen) throw new Error("The launch did not inspect the program ACLs");
  const { acls, user } = seen;
  expect(readAcls({ parent: root }).acls.parent.rules.map((rule) => rule.sid)).toContain(usersSid);
  for (const acl of [acls.root, acls.execution, acls.result]) {
    expect(acl?.owner).toBe(user);
    expect(acl?.rules.map((rule) => rule.sid).sort()).toEqual([user, systemSid].sort());
    for (const rule of acl?.rules ?? []) {
      expect(rule).toMatchObject({ rights: fullControl, type: "Allow" });
    }
  }
  expect(acls.root).toMatchObject({ protected: true });
  expect(acls.root.rules.every((rule) => !rule.inherited)).toBe(true);
  expect(acls.result.rules.every((rule) => rule.inherited)).toBe(true);
  await expect(stat(join(privateDirectory, context.occurrenceId))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses an existing private directory that other users can read, before writing anything", async (test) => {
  const fixture = await permissiveRoot(test);
  const root = fixture.path;
  const privateDirectory = join(root, "private");
  await mkdir(privateDirectory);
  const context = triggerContext();
  let launched = false;

  await expect(
    fixture.track(
      executor(privateDirectory).execute({
        context,
        endpoints: { mcp: context.mcp },
        planLaunch: async () => {
          launched = true;
          return (launch: HarnessProcessLaunch) => launch;
        },
        signal: fixture.signal,
        workspace: { instructions: undefined, path: root },
      }),
    ),
  ).rejects.toThrow();

  expect(launched).toBe(false);
  expect(await readdir(privateDirectory)).toEqual([]);
});

it("joins a canceled program before removing the workspace it holds open", async (test) => {
  const fixture = await permissiveRoot(test);
  const entered = Promise.withResolvers<void>();
  // Leave the request open so the program holds its working directory until canceled.
  const server = createServer(() => entered.resolve());
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  test.onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const context = triggerContext(`import { get } from "node:http";
    export default async function () {
      get("http://127.0.0.1:${address.port}");
      await new Promise(() => {});
    }`);
  const running = fixture.track(
    executor(join(fixture.path, "private")).execute({
      context,
      endpoints: { mcp: context.mcp },
      planLaunch: async () => (launch) => launch,
      signal: fixture.signal,
      workspace: { instructions: undefined, path: fixture.path },
    }),
  );
  try {
    await Promise.race([
      entered.promise,
      running.then((outcome) => {
        throw new Error(`Program finished before entering: ${outcome.error}`);
      }),
    ]);
  } finally {
    await fixture.close();
  }
  expect(await running).toMatchObject({ status: "canceled" });
  await expect(stat(fixture.path)).rejects.toMatchObject({ code: "ENOENT" });
});

function executor(privateDirectory: string): TriggerProgramExecutor {
  return new TriggerProgramExecutor({
    nativeFsHelperBinary,
    nodeExecutable: process.execPath,
    privateDirectory,
  });
}

/** A directory that, like a checkout or shared data folder, grants every local user read access. */
async function permissiveRoot(test: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-program-")));
  const abort = new AbortController();
  const running: Promise<unknown>[] = [];
  let stopping: Promise<void> | undefined;
  const close = () =>
    (stopping ??= (async () => {
      abort.abort();
      await Promise.allSettled(running);
      await rm(root, { force: true, recursive: true });
    })());
  test.onTestFinished(close);
  execFileSync("icacls", [root, "/grant", `*${usersSid}:(OI)(CI)RX`], { windowsHide: true });
  await mkdir(join(root, ".opensteer"), { recursive: true });
  return {
    path: root,
    signal: AbortSignal.any([test.signal, abort.signal]),
    track<Value>(work: Promise<Value>): Promise<Value> {
      running.push(work);
      return work;
    },
    close,
  };
}

interface Acl {
  readonly owner: string;
  readonly protected: boolean;
  readonly rules: readonly {
    readonly inherited: boolean;
    readonly rights: number;
    readonly sid: string;
    readonly type: string;
  }[];
}

function readAcls<Key extends string>(paths: Record<Key, string>) {
  return JSON.parse(
    powershell(
      `$paths = ConvertFrom-Json -InputObject $env:OPENSTEER_ACL_PATHS
      $sid = [System.Security.Principal.SecurityIdentifier]
      $acls = @{}
      foreach ($entry in $paths.PSObject.Properties) {
        $acl = Get-Acl -LiteralPath $entry.Value
        $acls[$entry.Name] = [pscustomobject]@{
          owner = $acl.GetOwner($sid).Value
          protected = $acl.AreAccessRulesProtected
          rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {
            [pscustomobject]@{
              inherited = $_.IsInherited
              rights = [int]$_.FileSystemRights
              sid = $_.IdentityReference.Value
              type = [string]$_.AccessControlType
            }
          })
        }
      }
      [pscustomobject]@{
        user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        acls = $acls
      } | ConvertTo-Json -Compress -Depth 4`,
      { OPENSTEER_ACL_PATHS: JSON.stringify(paths) },
    ),
  ) as { user: string; acls: Record<Key, Acl> };
}

function powershell(script: string, environment: Record<string, string> = {}): string {
  return execFileSync(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}`],
    { encoding: "utf8", env: { ...process.env, ...environment }, windowsHide: true },
  );
}

function triggerContext(
  source = `export default function ({ event }) {
  return { doubled: event.payload.price * 2 };
}`,
): TriggerExecutionContext {
  const occurrenceId = createId("triggerOccurrence");
  const triggerId = createId("trigger");
  const revisionId = createId("triggerRevision");
  const threadId = createId("thread");
  return TriggerExecutionContextSchema.parse({
    anchorThreadId: threadId,
    browserCdp: null,
    event: {
      id: occurrenceId,
      payload: { price: 42 },
      receivedAt: new Date().toISOString(),
      source: { kind: "manual" },
      trigger: { anchorThreadId: threadId, id: triggerId, revisionId },
    },
    executionGeneration: 1,
    mcp: { token: "test-token", url: "http://127.0.0.1:1/mcp" },
    occurrenceId,
    program: {
      language: "typescript",
      source,
      toolContractVersion: 5,
    },
    revisionId,
    triggerId,
  });
}
