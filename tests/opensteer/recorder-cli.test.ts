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
  test("keeps record hidden from the primary help surface", async () => {
    await ensureCliArtifactsBuilt();

    const result = await execFile("node", [CLI_SCRIPT, "--help"], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 4,
    });

    expect(result.stdout).not.toContain("record <url> [--output <path>]");
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

  test("routes provider=cloud record through cloud config validation instead of the local-only guard", async () => {
    await ensureCliArtifactsBuilt();

    const execution = execFile(
      "node",
      [
        CLI_SCRIPT,
        "record",
        "--provider",
        "cloud",
        "--workspace",
        "cloud-recording",
        "--url",
        "https://example.com",
        "--cloud-api-key",
        "test-api-key",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENSTEER_PROVIDER: "",
          OPENSTEER_BASE_URL: "",
          OPENSTEER_API_KEY: "",
          OPENSTEER_CLOUD_APP_BASE_URL: "",
        },
        maxBuffer: 1024 * 1024 * 4,
      },
    );

    await expect(execution).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "record with provider=cloud requires OPENSTEER_CLOUD_APP_BASE_URL",
      ),
    });
  }, 60_000);

  test("allows headless cloud recording and keeps the local headed validation local-only", async () => {
    await ensureCliArtifactsBuilt();

    const execution = execFile(
      "node",
      [
        CLI_SCRIPT,
        "record",
        "--provider",
        "cloud",
        "--workspace",
        "cloud-recording",
        "--url",
        "https://example.com",
        "--headless",
        "true",
        "--cloud-api-key",
        "test-api-key",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENSTEER_PROVIDER: "",
          OPENSTEER_BASE_URL: "",
          OPENSTEER_API_KEY: "",
          OPENSTEER_CLOUD_APP_BASE_URL: "",
        },
        maxBuffer: 1024 * 1024 * 4,
      },
    );

    await expect(execution).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "record with provider=cloud requires OPENSTEER_CLOUD_APP_BASE_URL",
      ),
    });
  }, 60_000);

  test("requires a cloud app base URL before starting cloud recording", async () => {
    await ensureCliArtifactsBuilt();

    const execution = execFile(
      "node",
      [
        CLI_SCRIPT,
        "record",
        "--provider",
        "cloud",
        "--workspace",
        "cloud-recording",
        "--url",
        "https://example.com",
        "--cloud-api-key",
        "test-api-key",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENSTEER_PROVIDER: "",
          OPENSTEER_BASE_URL: "",
          OPENSTEER_API_KEY: "",
          OPENSTEER_CLOUD_APP_BASE_URL: "",
        },
        maxBuffer: 1024 * 1024 * 4,
      },
    );

    await expect(execution).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "record with provider=cloud requires OPENSTEER_CLOUD_APP_BASE_URL",
      ),
    });
  }, 60_000);

  test("rejects removed timeout flags instead of ignoring them", async () => {
    await ensureCliArtifactsBuilt();

    const execution = execFile(
      "node",
      [
        CLI_SCRIPT,
        "record",
        "--workspace",
        "timeout-removed",
        "--url",
        "https://example.com",
        "--record-timeout-ms",
        "1000",
      ],
      {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024 * 4,
      },
    );

    await expect(execution).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown option: --record-timeout-ms."),
    });
  }, 60_000);
});
