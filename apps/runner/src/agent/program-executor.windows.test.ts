import type { HarnessProcessLaunch } from "@opensteer/harness";
import { createId } from "@opensteer/core";
import { TriggerExecutionContextSchema, type TriggerExecutionContext } from "@opensteer/protocol";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { TriggerProgramExecutor } from "./program-executor.js";

const nativeFsHelperBinary = fileURLToPath(
  new URL("../../native-fs-helper/opensteer-native-fs.exe", import.meta.url),
);
const usersSid = "S-1-5-32-545";
const systemSid = "S-1-5-18";
const fullControl = 0x1f01ff;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it("keeps a program's inputs and result private to this account under a parent other users can read", async () => {
  const root = await permissiveRoot();
  const privateDirectory = join(root, "private");
  const context = triggerContext();
  const seen: Record<string, Acl> = {};

  const output = await executor(privateDirectory).execute({
    context,
    endpoints: { mcp: context.mcp },
    planLaunch: async (input) => {
      seen.root = readAcl(privateDirectory);
      seen.execution = readAcl(input.privateDirectory);
      seen.result = readAcl(input.resultFile ?? "");
      return (launch: HarnessProcessLaunch) => launch;
    },
    signal: new AbortController().signal,
    workspace: { instructions: undefined, path: root },
  });

  expect(output).toMatchObject({ error: null, result: { doubled: 84 }, status: "succeeded" });
  expect(readAcl(root).rules.map((rule) => rule.sid)).toContain(usersSid);
  const user = currentUserSid();
  for (const acl of [seen.root, seen.execution, seen.result]) {
    expect(acl?.owner).toBe(user);
    expect(acl?.rules.map((rule) => rule.sid).sort()).toEqual([user, systemSid].sort());
    for (const rule of acl?.rules ?? []) {
      expect(rule).toMatchObject({ rights: fullControl, type: "Allow" });
    }
  }
  expect(seen.root).toMatchObject({ protected: true });
  expect(seen.root?.rules.every((rule) => !rule.inherited)).toBe(true);
  expect(seen.result?.rules.every((rule) => rule.inherited)).toBe(true);
  await expect(stat(join(privateDirectory, context.occurrenceId))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses an existing private directory that other users can read, before writing anything", async () => {
  const root = await permissiveRoot();
  const privateDirectory = join(root, "private");
  await mkdir(privateDirectory);
  const context = triggerContext();
  let launched = false;

  await expect(
    executor(privateDirectory).execute({
      context,
      endpoints: { mcp: context.mcp },
      planLaunch: async () => {
        launched = true;
        return (launch: HarnessProcessLaunch) => launch;
      },
      signal: new AbortController().signal,
      workspace: { instructions: undefined, path: root },
    }),
  ).rejects.toThrow();

  expect(launched).toBe(false);
  expect(await readdir(privateDirectory)).toEqual([]);
});

function executor(privateDirectory: string): TriggerProgramExecutor {
  return new TriggerProgramExecutor({
    nativeFsHelperBinary,
    nodeExecutable: process.execPath,
    privateDirectory,
  });
}

/** A directory that, like a checkout or shared data folder, grants every local user read access. */
async function permissiveRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-program-")));
  roots.push(root);
  execFileSync("icacls", [root, "/grant", `*${usersSid}:(OI)(CI)RX`], { windowsHide: true });
  await mkdir(join(root, ".opensteer"), { recursive: true });
  return root;
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

function readAcl(path: string): Acl {
  return JSON.parse(
    powershell(
      `$acl = Get-Acl -LiteralPath $env:OPENSTEER_ACL_PATH
      $sid = [System.Security.Principal.SecurityIdentifier]
      [pscustomobject]@{
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
      } | ConvertTo-Json -Compress -Depth 4`,
      { OPENSTEER_ACL_PATH: path },
    ),
  ) as Acl;
}

function currentUserSid(): string {
  return powershell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value").trim();
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

function triggerContext(): TriggerExecutionContext {
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
      source: `export default function ({ event }) {
          return { doubled: event.payload.price * 2 };
        }`,
      toolContractVersion: 3,
    },
    revisionId,
    triggerId,
  });
}
