import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { OpensteerCloudClient } from "../../packages/opensteer/src/cloud/client.js";
import { resolveOpensteerRuntimeConfig } from "../../packages/opensteer/src/sdk/runtime-resolution.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
          uploadMethod: "POST",
          maxUploadBytes: 1024,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          storageId: "storage_123",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          importId: "bpi_123",
          profileId: "bp_123",
          status: "ready",
          archiveFormat: "tar.gz",
          storageId: "storage_final",
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
      archiveFormat: "tar.gz",
    });
    const uploaded = await client.uploadBrowserProfileImportPayload({
      uploadUrl: created.uploadUrl,
      payload: Buffer.from("test"),
    });
    const finalized = await client.finalizeBrowserProfileImport(created.importId, {
      storageId: uploaded.storageId,
    });

    expect(finalized).toMatchObject({
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
          archiveFormat: "tar.gz",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://storage.example/upload",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.opensteer.dev/v1/browser-profiles/imports/bpi_123/finalize",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          storageId: "storage_123",
        }),
      }),
    );
  });

  test("OpensteerCloudClient uploads a local browser profile snapshot", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-cloud-profile-upload-"));
    await mkdir(path.join(userDataDir, "Default"), { recursive: true });
    await writeFile(
      path.join(userDataDir, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Personal" },
          },
        },
      }),
    );
    await writeFile(path.join(userDataDir, "Default", "Preferences"), "{}");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          importId: "bpi_456",
          profileId: "bp_456",
          status: "awaiting_upload",
          uploadUrl: "https://storage.example/upload",
          uploadMethod: "POST",
          maxUploadBytes: 1024 * 1024,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          storageId: "storage_456",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          importId: "bpi_456",
          profileId: "bp_456",
          status: "ready",
          archiveFormat: "tar.gz",
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

    try {
      const result = await client.uploadLocalBrowserProfile({
        profileId: "bp_456",
        fromUserDataDir: userDataDir,
        profileDirectory: "Default",
      });

      expect(result).toMatchObject({
        importId: "bpi_456",
        status: "ready",
        revision: 7,
      });
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://api.opensteer.dev/v1/browser-profiles/imports",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            profileId: "bp_456",
            archiveFormat: "tar.gz",
          }),
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://storage.example/upload",
        expect.objectContaining({
          method: "POST",
          body: expect.any(Uint8Array),
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "https://api.opensteer.dev/v1/browser-profiles/imports/bpi_456/finalize",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            storageId: "storage_456",
          }),
        }),
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
