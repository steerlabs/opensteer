import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backgroundTextResult, runTitleProcess } from "./title-process.js";

describe("background text failures", () => {
  it.each([
    ["request refused by provider", "refused"],
    ["authentication required", "signed-out"],
    ["rate limit quota exceeded", "usage-limit"],
    ["model unavailable", "unavailable"],
  ])("classifies private stderr: %s", async (diagnostic, failure) => {
    const directory = await mkdtemp(join(tmpdir(), "background-text-test-"));
    try {
      const signal = AbortSignal.timeout(2_000);
      await expect(
        backgroundTextResult(signal, () =>
          runTitleProcess(
            { wrapProcessLaunch: (launch) => launch },
            {
              executable: process.execPath,
              args: ["-e", "process.stderr.write(process.argv[1]);process.exitCode=1", diagnostic!],
              cwd: directory,
              environment: {},
            },
            signal,
          ),
        ),
      ).resolves.toEqual({ ok: false, failure });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
