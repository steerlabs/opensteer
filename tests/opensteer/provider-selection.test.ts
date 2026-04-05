import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { CloudSessionProxy } from "../../packages/opensteer/src/cloud/session-proxy.js";
import { resolveFilesystemWorkspacePath } from "../../packages/opensteer/src/root.js";
import {
  createOpensteerSemanticRuntime,
  resolveOpensteerRuntimeConfig,
} from "../../packages/opensteer/src/sdk/runtime-resolution.js";
import { OpensteerRuntime } from "../../packages/opensteer/src/sdk/runtime.js";
import { writePersistedSessionRecord } from "../../packages/opensteer/src/live-session.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider selection", () => {
  test("explicit provider overrides env provider", () => {
    vi.stubEnv("OPENSTEER_PROVIDER", "cloud");
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
    vi.stubEnv("OPENSTEER_BASE_URL", "https://cloud.example");

    expect(
      resolveOpensteerRuntimeConfig({
        provider: {
          mode: "local",
        },
        environment: process.env,
      }),
    ).toEqual({
      provider: {
        mode: "local",
        source: "explicit",
      },
    });
  });

  test("cloud provider requires both api key and base url", () => {
    expect(() =>
      resolveOpensteerRuntimeConfig({
        provider: {
          mode: "cloud",
        },
      }),
    ).toThrow("provider=cloud requires OPENSTEER_API_KEY or provider.apiKey.");

    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");

    expect(() =>
      resolveOpensteerRuntimeConfig({
        provider: {
          mode: "cloud",
        },
      }),
    ).toThrow("provider=cloud requires OPENSTEER_BASE_URL or provider.baseUrl.");
  });

  test("existing local lane does not force local execution when provider resolves to cloud", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-provider-cloud-"));
    const workspace = "docs";
    const rootPath = resolveFilesystemWorkspacePath({
      rootDir,
      workspace,
    });

    try {
      await writePersistedSessionRecord(rootPath, {
        layout: "opensteer-session",
        version: 1,
        provider: "local",
        workspace,
        engine: "playwright",
        pid: process.pid,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        userDataDir: "/tmp/local-profile",
      });

      vi.stubEnv("OPENSTEER_PROVIDER", "cloud");
      vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
      vi.stubEnv("OPENSTEER_BASE_URL", "https://cloud.example");

      const runtime = createOpensteerSemanticRuntime({
        runtimeOptions: {
          rootDir,
          workspace,
        },
      });

      expect(runtime).toBeInstanceOf(CloudSessionProxy);
      await runtime.disconnect();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("env cloud falls back to local when local-only runtime options are provided", async () => {
    vi.stubEnv("OPENSTEER_PROVIDER", "cloud");
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
    vi.stubEnv("OPENSTEER_BASE_URL", "https://cloud.example");

    const runtime = createOpensteerSemanticRuntime({
      runtimeOptions: {
        policy: {
          timeout: {
            resolveTimeoutMs() {
              return 1000;
            },
          },
        },
      },
    });

    expect(runtime).toBeInstanceOf(OpensteerRuntime);
    await runtime.disconnect();
  });

  test("explicit cloud rejects local-only runtime options", () => {
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
    vi.stubEnv("OPENSTEER_BASE_URL", "https://cloud.example");

    expect(() =>
      createOpensteerSemanticRuntime({
        provider: {
          mode: "cloud",
        },
        runtimeOptions: {
          policy: {
            timeout: {
              resolveTimeoutMs() {
                return 1000;
              },
            },
          },
        },
      }),
    ).toThrow("provider=cloud does not support local runtime options: policy.");
  });

  test("explicit cloud allows browser runtime options", async () => {
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
    vi.stubEnv("OPENSTEER_BASE_URL", "https://cloud.example");

    const runtime = createOpensteerSemanticRuntime({
      provider: {
        mode: "cloud",
      },
      runtimeOptions: {
        browser: "persistent",
      },
    });

    expect(runtime).toBeInstanceOf(CloudSessionProxy);
    await runtime.disconnect();
  });

  test("existing cloud lane does not force cloud execution when provider resolves to local", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-provider-local-"));
    const workspace = "docs";
    const rootPath = resolveFilesystemWorkspacePath({
      rootDir,
      workspace,
    });

    try {
      await writePersistedSessionRecord(rootPath, {
        layout: "opensteer-session",
        version: 1,
        provider: "cloud",
        workspace,
        sessionId: "session_123",
        baseUrl: "https://cloud.example/runtime/session_123",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });

      vi.stubEnv("OPENSTEER_PROVIDER", "cloud");
      vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
      vi.stubEnv("OPENSTEER_BASE_URL", "https://cloud.example");

      const runtime = createOpensteerSemanticRuntime({
        provider: {
          mode: "local",
        },
        runtimeOptions: {
          rootDir,
          workspace,
        },
      });

      expect(runtime).toBeInstanceOf(OpensteerRuntime);
      await runtime.disconnect();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
