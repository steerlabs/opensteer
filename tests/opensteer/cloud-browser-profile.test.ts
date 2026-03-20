import { afterEach, describe, expect, test, vi } from "vitest";

import { OpensteerCloudClient } from "../../packages/opensteer/src/cloud/client.js";
import { CloudSessionProxy } from "../../packages/opensteer/src/cloud/session-proxy.js";
import { resolveOpensteerRuntimeConfig } from "../../packages/opensteer/src/sdk/runtime-resolution.js";

const capturePortableBrowserProfileSnapshotMock = vi.fn();
const encodePortableBrowserProfileSnapshotMock = vi.fn();
const resolveCookieCaptureStrategyMock = vi.fn();
const acquireCdpEndpointMock = vi.fn();
const relaunchBrowserNormallyMock = vi.fn();

vi.mock("../../packages/opensteer/src/cloud/portable-cookie-snapshot.js", () => ({
  capturePortableBrowserProfileSnapshot: (...args: unknown[]) =>
    capturePortableBrowserProfileSnapshotMock(...args),
  encodePortableBrowserProfileSnapshot: (...args: unknown[]) =>
    encodePortableBrowserProfileSnapshotMock(...args),
}));

vi.mock("../../packages/opensteer/src/local-browser/cookie-capture.js", () => ({
  resolveCookieCaptureStrategy: (...args: unknown[]) => resolveCookieCaptureStrategyMock(...args),
  acquireCdpEndpoint: (...args: unknown[]) => acquireCdpEndpointMock(...args),
  relaunchBrowserNormally: (...args: unknown[]) => relaunchBrowserNormallyMock(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("cloud browser-profile integration", () => {
  test("resolves cloud runtime config with a default browser profile preference", () => {
    vi.stubEnv("OPENSTEER_MODE", "cloud");
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");

    expect(
      resolveOpensteerRuntimeConfig({
        cloud: {
          browserProfile: {
            profileId: "bp_123",
            reuseIfActive: true,
          },
        },
      }),
    ).toEqual({
      mode: "cloud",
      cloud: {
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.dev",
        browserProfile: {
          profileId: "bp_123",
          reuseIfActive: true,
        },
      },
    });
  });

  test("OpensteerCloudClient sends browserProfile with session creation", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        sessionId: "session_123",
        baseUrl: "https://api.opensteer.dev/v1/sessions/session_123",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpensteerCloudClient({
      apiKey: "osk_test",
      baseUrl: "https://api.opensteer.dev",
      browserProfile: {
        profileId: "bp_default",
      },
    });

    await client.createSession({
      name: "work",
      browserProfile: {
        profileId: "bp_123",
        reuseIfActive: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.opensteer.dev/v1/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "work",
          browserProfile: {
            profileId: "bp_123",
            reuseIfActive: true,
          },
        }),
      }),
    );
  });

  test("OpensteerCloudClient stages browser profile imports", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          importId: "bpi_123",
          profileId: "bp_123",
          status: "awaiting_upload",
          uploadUrl: "https://storage.example/upload",
          uploadMethod: "PUT",
          uploadFormat: "portable-cookies-v1+json.gz",
          maxUploadBytes: 1024,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          importId: "bpi_123",
          profileId: "bp_123",
          status: "ready",
          uploadFormat: "portable-cookies-v1+json.gz",
          storageId: "storage_123",
          revision: 3,
          createdAt: 1,
          updatedAt: 2,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpensteerCloudClient({
      apiKey: "osk_test",
      baseUrl: "https://api.opensteer.dev",
    });

    const created = await client.createBrowserProfileImport({
      profileId: "bp_123",
    });
    const uploaded = await client.uploadBrowserProfileImportPayload({
      uploadUrl: created.uploadUrl,
      payload: Buffer.from("test"),
    });

    expect(uploaded).toMatchObject({
      importId: "bpi_123",
      status: "ready",
      revision: 3,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.opensteer.dev/v1/browser-profiles/imports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          profileId: "bp_123",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://storage.example/upload",
      expect.objectContaining({
        method: "PUT",
      }),
    );
  });

  test("OpensteerCloudClient syncs cookies into a cloud browser profile", async () => {
    resolveCookieCaptureStrategyMock.mockResolvedValueOnce({
      strategy: "attach",
      attachEndpoint: "9222",
      timeoutMs: 30_000,
    });
    acquireCdpEndpointMock.mockResolvedValueOnce({
      strategy: "attach",
      cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      cleanup: vi.fn(async () => undefined),
    });
    capturePortableBrowserProfileSnapshotMock.mockResolvedValueOnce({
      version: "portable-cookies-v1",
      source: {
        browserFamily: "chromium",
        browserName: "Chromium",
        browserMajor: "136",
        platform: "macos",
        capturedAt: 123,
      },
      cookies: [
        {
          name: "session",
          value: "abc",
          domain: ".example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          session: true,
          expiresAt: null,
        },
      ],
    });
    encodePortableBrowserProfileSnapshotMock.mockResolvedValueOnce(Buffer.from("compressed-state"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          importId: "bpi_456",
          profileId: "bp_456",
          status: "awaiting_upload",
          uploadUrl: "https://storage.example/upload",
          uploadMethod: "PUT",
          uploadFormat: "portable-cookies-v1+json.gz",
          maxUploadBytes: 1024 * 1024,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          importId: "bpi_456",
          profileId: "bp_456",
          status: "ready",
          uploadFormat: "portable-cookies-v1+json.gz",
          storageId: "storage_456",
          revision: 7,
          createdAt: 1,
          updatedAt: 2,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpensteerCloudClient({
      apiKey: "osk_test",
      baseUrl: "https://api.opensteer.dev",
    });

    const result = await client.syncBrowserProfileCookies({
      attachEndpoint: "9222",
      domains: ["example.com"],
      profileId: "bp_456",
    });

    expect(result).toMatchObject({
      importId: "bpi_456",
      status: "ready",
      revision: 7,
    });
    expect(resolveCookieCaptureStrategyMock).toHaveBeenCalledWith({
      attachEndpoint: "9222",
    });
    expect(capturePortableBrowserProfileSnapshotMock).toHaveBeenCalledWith({
      attachEndpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      captureMethod: "attach",
      domains: ["example.com"],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.opensteer.dev/v1/browser-profiles/imports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          profileId: "bp_456",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://storage.example/upload",
      expect.objectContaining({
        method: "PUT",
        body: expect.any(Uint8Array),
      }),
    );
  });

  test("OpensteerCloudClient waits for closing sessions to reach closed", async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: "session_123",
          status: "closing",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: "session_123",
          status: "closing",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: "session_123",
          status: "closed",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpensteerCloudClient({
      apiKey: "osk_test",
      baseUrl: "https://api.opensteer.dev",
    });

    const closePromise = client.closeSession("session_123");

    await Promise.resolve();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.opensteer.dev/v1/sessions/session_123",
      expect.objectContaining({
        method: "DELETE",
      }),
    );

    await vi.advanceTimersByTimeAsync(250);
    await expect(closePromise).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.opensteer.dev/v1/sessions/session_123",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.opensteer.dev/v1/sessions/session_123",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  test("CloudSessionProxy close only uses the cloud control-plane close path", async () => {
    const invoke = vi.fn();
    const cloud = new OpensteerCloudClient({
      apiKey: "osk_test",
      baseUrl: "https://api.opensteer.dev",
    });
    const closeSession = vi.spyOn(cloud, "closeSession").mockResolvedValue(undefined);
    const proxy = new CloudSessionProxy(cloud);

    Reflect.set(proxy, "sessionId", "session_123");
    Reflect.set(proxy, "client", {
      invoke,
    });

    await expect(proxy.close()).resolves.toEqual({ closed: true });

    expect(closeSession).toHaveBeenCalledWith("session_123");
    expect(invoke).not.toHaveBeenCalled();
    expect(Reflect.get(proxy, "sessionId")).toBeUndefined();
    expect(Reflect.get(proxy, "client")).toBeUndefined();
  });
});
