import type { HarnessProcessLaunch } from "@opensteer/harness";
import { createId } from "@opensteer/core";
import { TriggerExecutionContextSchema } from "@opensteer/protocol";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TriggerProgramExecutor } from "./program-executor.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it("returns a program's result through its private result file, which only inherits its root's access", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-program-")));
  roots.push(root);
  const privateDirectory = join(root, "private");
  await mkdir(join(root, ".opensteer"), { recursive: true });
  const occurrenceId = createId("triggerOccurrence");
  const triggerId = createId("trigger");
  const revisionId = createId("triggerRevision");
  const threadId = createId("thread");
  const context = TriggerExecutionContextSchema.parse({
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
      source: `import { execFileSync } from "node:child_process";
        export default function ({ event }) {
          const acl = execFileSync("icacls", [process.env.OPENSTEER_RESULT_PATH], { encoding: "utf8" });
          return { acl, doubled: event.payload.price * 2 };
        }`,
      toolContractVersion: 3,
    },
    revisionId,
    triggerId,
  });

  const output = await new TriggerProgramExecutor({
    nodeExecutable: process.execPath,
    privateDirectory,
  }).execute({
    context,
    endpoints: { mcp: context.mcp },
    planLaunch: async () => (launch: HarnessProcessLaunch) => launch,
    signal: new AbortController().signal,
    workspace: { instructions: undefined, path: root },
  });

  expect(output).toMatchObject({ error: null, result: { doubled: 84 }, status: "succeeded" });
  const entries = String((output.result as { acl: string }).acl)
    .split(/\r?\n/u)
    .filter((line) => line.includes(":("));
  expect(entries.length).toBeGreaterThan(0);
  // Every entry comes from the private root; the file adds no access of its own.
  for (const entry of entries) expect(entry).toContain("(I)");
  await expect(stat(join(privateDirectory, occurrenceId))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
