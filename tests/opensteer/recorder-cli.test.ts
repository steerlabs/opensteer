import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { ensureCliArtifactsBuilt } from "./cli-artifacts.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");

describe("recorder CLI", () => {
  test("prints record in help output", async () => {
    await ensureCliArtifactsBuilt();

    const result = await execFile("node", [CLI_SCRIPT, "--help"], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 4,
    });

    expect(result.stdout).toContain("opensteer record --workspace <id> --url <url> [--output <path>]");
  }, 60_000);

  test("requires a workspace id", async () => {
    await ensureCliArtifactsBuilt();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "opensteer-recorder-cli-"));

    try {
      const execution = execFile("node", [CLI_SCRIPT, "record", "--url", "https://example.com"], {
        cwd,
        maxBuffer: 1024 * 1024 * 4,
      });

      await expect(execution).rejects.toMatchObject({
        stderr: expect.stringMatching(/record requires \\"--workspace <id>\\"/),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
