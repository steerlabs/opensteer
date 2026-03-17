import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { writeOpensteerServiceMetadata } from "../../packages/opensteer/src/cli/service-metadata.js";
import {
  createOpensteerSemanticRuntime,
  resolveOpensteerRuntimeConfig,
} from "../../packages/opensteer/src/sdk/runtime-resolution.js";
import { ensureCliArtifactsBuilt } from "./cli-artifacts.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");

beforeAll(async () => {
  await ensureCliArtifactsBuilt();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Opensteer runtime modes", () => {
  test("defaults to local mode", () => {
    expect(resolveOpensteerRuntimeConfig()).toEqual({
      mode: "local",
    });
  });

  test("resolves cloud mode from OPENSTEER_MODE and trims OPENSTEER_BASE_URL", () => {
    vi.stubEnv("OPENSTEER_MODE", "cloud");
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
    vi.stubEnv("OPENSTEER_BASE_URL", "https://api.opensteer.dev///");

    expect(resolveOpensteerRuntimeConfig()).toEqual({
      mode: "cloud",
      cloud: {
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.dev",
      },
    });
  });

  test("rejects legacy connect mode in OPENSTEER_MODE", () => {
    vi.stubEnv("OPENSTEER_MODE", "connect");

    expect(() => resolveOpensteerRuntimeConfig()).toThrow(
      'OPENSTEER_MODE must be one of local, cloud; received "connect".',
    );
  });

  test("rejects ABP in cloud mode", () => {
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");

    expect(() =>
      createOpensteerSemanticRuntime({
        engine: "abp",
        cloud: true,
      }),
    ).toThrow("ABP is not supported in cloud mode.");
  });

  test("cloud session metadata persists routing data without secrets", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-remote-metadata-"));
    await writeOpensteerServiceMetadata(path.join(rootDir, ".opensteer"), {
      mode: "cloud",
      name: "remote",
      rootPath: path.join(rootDir, ".opensteer"),
      startedAt: 1,
      baseUrl: "https://api.opensteer.dev/v1/sessions/session-123",
      sessionId: "session-123",
      authSource: "env",
    });

    const metadata = JSON.parse(
      await readFile(
        path.join(rootDir, ".opensteer", "runtime", "sessions", "remote", "service.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(metadata.mode).toBe("cloud");
    expect(metadata.sessionId).toBe("session-123");
    expect(metadata.baseUrl).toBe("https://api.opensteer.dev/v1/sessions/session-123");
    expect(metadata).not.toHaveProperty("token");
    expect(metadata).not.toHaveProperty("apiKey");
  });

  test("CLI rejects removed --connect option", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-connect-"));

    await expect(runCliExpectFailure(rootDir, [
      "open",
      "https://example.com",
      "--connect",
      "ws://127.0.0.1:9222/devtools/browser/test",
    ])).resolves.toMatchObject({
      error: {
        message: expect.stringContaining("--connect has been removed"),
      },
    });
  });

  test("CLI rejects ABP for cloud mode before resolving cloud auth", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-cloud-"));

    await expect(runCliExpectFailure(rootDir, [
      "open",
      "https://example.com",
      "--cloud",
      "--engine",
      "abp",
    ])).resolves.toMatchObject({
      error: {
        message: expect.stringContaining("ABP is not supported in cloud mode"),
      },
    });
  });
});

async function runCliExpectFailure(
  rootDir: string,
  args: readonly string[],
): Promise<{
  readonly error: {
    readonly message?: string;
  };
}> {
  try {
    await execFile(process.execPath, [CLI_SCRIPT, ...args], {
      cwd: rootDir,
      env: {
        ...process.env,
      },
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const result = error as {
      readonly stdout?: string;
      readonly stderr?: string;
    };
    expect((result.stdout ?? "").trim()).toBe("");
    return JSON.parse((result.stderr ?? "").trim()) as {
      readonly error: {
        readonly message?: string;
      };
    };
  }

  throw new Error("expected CLI command to fail");
}
