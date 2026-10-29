import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runParallelismFixture } from "../packages/database/src/integration-parallelism-fixtures/run.test-support.js";

it("reports a killed fixture deadline instead of letting it look like failed database cleanup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "parallelism-child-"));
  try {
    expect(
      await runParallelismFixture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        outputFile: path.join(directory, "run.log"),
        timeoutMs: 40,
      }),
    ).toMatchObject({ code: null, timedOut: true, error: expect.stringContaining("40 ms") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([0, 1])(
  "preserves fixture exit %i so expected test failures still check real cleanup",
  async (code) => {
    expect(
      await runParallelismFixture(process.execPath, ["-e", `process.exit(${code})`], {}),
    ).toEqual({ code, signal: null, timedOut: false });
  },
);

it("reports a signal-killed fixture separately from its timeout and cleanup receipts", async () => {
  expect(
    await runParallelismFixture(
      process.execPath,
      ["-e", 'process.kill(process.pid, "SIGTERM")'],
      {},
    ),
  ).toMatchObject({
    code: null,
    signal: "SIGTERM",
    timedOut: false,
    error: expect.stringContaining("SIGTERM"),
  });
});
