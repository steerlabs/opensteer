import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createSuccessEnvelope } from "@opensteer/protocol";

import { writeOpensteerServiceMetadata } from "../../packages/opensteer/src/cli/service-metadata.js";
import { resolveLiveOpensteerServiceMetadata } from "../../packages/opensteer/src/session-service/client.js";
import {
  createOpensteerSemanticRuntime,
  resolveOpensteerRuntimeConfig,
} from "../../packages/opensteer/src/sdk/runtime-resolution.js";
import { Opensteer } from "../../packages/opensteer/src/sdk/opensteer.js";
import { ensureCliArtifactsBuilt } from "./cli-artifacts.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");

beforeAll(async () => {
  await ensureCliArtifactsBuilt();
}, 120_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

  test("transient cloud ping failures do not purge live session metadata", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-liveness-"));
    const opensteerRoot = path.join(rootDir, ".opensteer");
    const metadataPath = path.join(opensteerRoot, "runtime", "sessions", "remote", "service.json");

    vi.stubEnv("OPENSTEER_MODE", "cloud");
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await writeOpensteerServiceMetadata(opensteerRoot, {
      mode: "cloud",
      name: "remote",
      rootPath: opensteerRoot,
      startedAt: 1,
      baseUrl: "https://api.opensteer.dev/v1/sessions/session-123",
      sessionId: "session-123",
      authSource: "env",
    });

    await expect(
      resolveLiveOpensteerServiceMetadata({
        name: "remote",
        rootDir,
      }),
    ).resolves.toMatchObject({
      mode: "cloud",
      name: "remote",
      sessionId: "session-123",
    });

    await expect(readFile(metadataPath, "utf8")).resolves.toContain('"mode": "cloud"');
  });

  test("stale cloud ping responses still purge stale session metadata", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-stale-"));
    const opensteerRoot = path.join(rootDir, ".opensteer");
    const metadataPath = path.join(opensteerRoot, "runtime", "sessions", "remote", "service.json");

    vi.stubEnv("OPENSTEER_MODE", "cloud");
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
      })),
    );

    await writeOpensteerServiceMetadata(opensteerRoot, {
      mode: "cloud",
      name: "remote",
      rootPath: opensteerRoot,
      startedAt: 1,
      baseUrl: "https://api.opensteer.dev/v1/sessions/session-123",
      sessionId: "session-123",
      authSource: "env",
    });

    await expect(
      resolveLiveOpensteerServiceMetadata({
        name: "remote",
        rootDir,
      }),
    ).resolves.toBeUndefined();

    await expect(readFile(metadataPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("Opensteer.attach reuses live cloud session metadata", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-attach-"));
    const opensteerRoot = path.join(rootDir, ".opensteer");

    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/runtime/ping")) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        if (url.endsWith("/api/v2/semantic/operations/session/open")) {
          const request = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response(
            JSON.stringify(
              createSuccessEnvelope(request as Parameters<typeof createSuccessEnvelope>[0], {
                sessionRef: "session:cloud",
                pageRef: "page:cloud",
                url: "https://example.com",
                title: "Cloud Session",
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await writeOpensteerServiceMetadata(opensteerRoot, {
      mode: "cloud",
      name: "remote",
      rootPath: opensteerRoot,
      startedAt: 1,
      baseUrl: "https://api.opensteer.dev/v1/sessions/session-123",
      sessionId: "session-123",
      authSource: "env",
    });

    const attached = Opensteer.attach({
      name: "remote",
      rootDir,
    });

    await expect(
      attached.open({
        url: "https://example.com",
      }),
    ).resolves.toMatchObject({
      sessionRef: "session:cloud",
      pageRef: "page:cloud",
      url: "https://example.com",
      title: "Cloud Session",
    });
  });

  test("CLI rejects unknown legacy --connect option", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-connect-"));

    await expect(
      runCliExpectFailure(rootDir, [
        "open",
        "https://example.com",
        "--connect",
        "ws://127.0.0.1:9222/devtools/browser/test",
      ]),
    ).resolves.toMatchObject({
      error: {
        message: expect.stringContaining('unknown option "--connect"'),
      },
    });
  });

  test("CLI rejects ABP for cloud mode before resolving cloud auth", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cli-cloud-"));

    await expect(
      runCliExpectFailure(rootDir, ["open", "https://example.com", "--cloud", "--engine", "abp"]),
    ).resolves.toMatchObject({
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
