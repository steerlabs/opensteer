import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCodexRunCaptures } from "./codex-capture.test-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "codex-records-"));
  directories.push(path);
  return path;
}
function record(pid: number, order: number, message: object) {
  return JSON.stringify({
    captureProcessId: pid,
    captureProcessIdentity: `process-${pid}`,
    captureRunId: null,
    captureOrder: order,
    captureTime: order,
    ...message,
  });
}
it("admits a held half-write only after complete atomic publication", async () => {
  const path = await fixture();
  const pending = join(path, "process-1-0.pending");
  const complete = record(1, 0, { method: "thread/start" });
  await writeFile(pending, complete.slice(0, complete.length / 2));
  expect((await readCodexRunCaptures(path)).length).toBe(0);
  await writeFile(pending, complete);
  await rename(pending, join(path, "process-1-0.json"));
  expect((await readCodexRunCaptures(path)).map((row) => row.method)).toEqual(["thread/start"]);
});
it("attributes interleaved credentials only after a Run starts and excludes naming processes", async () => {
  const path = await fixture();
  const publish = (pid: number, order: number, message: object) =>
    writeFile(join(path, `process-${pid}-${order}.json`), record(pid, order, message));
  await publish(1, 0, { fakeOpensteerTokens: { agentTools: "fixture-secret" } });
  await publish(2, 0, { fakeOpensteerTokens: {} });
  expect((await readCodexRunCaptures(path)).length).toBe(0);
  await publish(2, 1, { method: "thread/start", params: { ephemeral: true } });
  await publish(1, 1, { method: "thread/start", captureRunId: "run-thread", params: {} });
  const rows = await readCodexRunCaptures(path);
  expect(rows.map((row) => row.captureProcessId)).toEqual([1, 1]);
  expect(rows.some((row) => Boolean(row.fakeOpensteerTokens))).toBe(true);
});
it("fails malformed published records without disclosing their contents", async () => {
  const path = await fixture();
  await writeFile(join(path, "broken.json"), '{"secret":"fixture-secret"');
  await expect(readCodexRunCaptures(path)).rejects.toThrow("Malformed published Codex capture");
});
it("ignores missing captures but propagates other I/O failures", async () => {
  const path = await fixture();
  expect((await readCodexRunCaptures(join(path, "absent"))).length).toBe(0);
  await mkdir(join(path, "broken.json"));
  await expect(readCodexRunCaptures(path)).rejects.toThrow();
});

it("the fake app server publishes complete ordered process records", async () => {
  const path = await fixture();
  const engine = fileURLToPath(
    new URL(
      "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
      import.meta.url,
    ),
  );
  const result = spawnSync(
    process.execPath,
    [engine, `--capture=${path}`, "--capture-records", "--capture-tokens"],
    {
      input:
        [
          { id: 1, method: "initialize", params: {} },
          { id: 2, method: "thread/resume", params: { threadId: "run-thread" } },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      timeout: 5000,
      env: { ...process.env, OPENSTEER_AGENT_TOOLS_TOKEN: "fixture-secret" },
    },
  );
  // Never attach stdout/stderr or captured credentials to assertion diagnostics.
  expect(result.status === 0).toBe(true);
  const rows = await readCodexRunCaptures(path);
  expect(rows.length > 0).toBe(true);
  expect(new Set(rows.map((row) => row.captureProcessIdentity)).size).toBe(1);
  expect(rows.map((row) => row.captureOrder)).toEqual(rows.map((_, index) => index));
  expect(rows.some((row) => row.captureRunId === "run-thread")).toBe(true);
});
