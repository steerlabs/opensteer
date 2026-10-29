import { createId, type PortableFsWorkspaceBacking, type Workspace } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { PortableFsWorkspaceFilesDriver } from "./workspace-files-portablefs-driver.js";

describe("PortableFsWorkspaceFilesDriver", () => {
  it("establishes one read-only authority session and returns a bounded directory page", async () => {
    const workspace = readyWorkspace();
    const claims: Array<Record<string, unknown>> = [];
    const issueReadSessionGrant = vi.fn(async () => readGrant(workspace));
    const requests: string[] = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer signed-request");
      if (url.pathname.endsWith("/session")) {
        if (init?.method === "PUT") {
          expect(JSON.parse(String(init.body))).toMatchObject({ access: ["read"] });
          return Response.json({ expiresAt: futureIso(), ready: true }, { status: 201 });
        }
        return Response.json({ ready: false });
      }
      if (url.pathname === `/v1/volumes/${workspace.backing.volumeId}/identity`) {
        return Response.json({
          csrPem: "-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----",
          keyId: "a".repeat(43),
        });
      }
      if (url.pathname.includes("/entries")) {
        expect(url.searchParams.get("limit")).toBe("200");
        expect(url.searchParams.get("parent")).toBe("");
        return Response.json({
          cursor: null,
          entries: [fileEntry("README.md")],
          parentKey: "",
          revision: "directory_revision_1",
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const service = new PortableFsWorkspaceFilesDriver({
      baseUrl: "http://files.internal:4315",
      fetchImplementation: fetchImplementation as typeof fetch,
      manager: { issueReadSessionGrant } as never,
      tokens: {
        issue: (value) => {
          claims.push({ ...value });
          return "signed-request";
        },
      },
    });

    await expect(service.list(workspace, { limit: 200, parentKey: "" })).resolves.toEqual({
      cursor: null,
      entries: [
        {
          executable: false,
          hidden: false,
          key: "UkVBRE1FLm1k",
          kind: "file",
          mode: 0o644,
          modifiedAt: null,
          name: "README.md",
          sizeBytes: 5,
        },
      ],
      parentKey: "",
      revision: "directory_revision_1",
    });
    expect(requests).toEqual([
      `GET /v1/volumes/${workspace.backing.volumeId}/session`,
      `GET /v1/volumes/${workspace.backing.volumeId}/identity`,
      `PUT /v1/volumes/${workspace.backing.volumeId}/session`,
      `GET /v1/volumes/${workspace.backing.volumeId}/entries`,
    ]);
    expect(issueReadSessionGrant).toHaveBeenCalledWith(
      workspace.backing.volumeId,
      expect.objectContaining({
        owner: workspace.createdBy,
        subject: `opensteer-files:${"a".repeat(43)}`,
      }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^files:/) }),
    );
    // The install fence is the current storage lifecycle generation, so an
    // archive initiation that bumps it fences this session out.
    expect(claims.find((value) => value.operation === "session.install")).toMatchObject({
      bodySha256: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      fence: workspace.backing.generation,
      volumeId: workspace.backing.volumeId,
    });
    expect(claims.find((value) => value.operation === "identity")).toMatchObject({
      volumeId: workspace.backing.volumeId,
    });
    expect(claims.at(-1)).toMatchObject({
      aud: "portablefs-files",
      cursor: "",
      limit: 200,
      operation: "list",
      pathKey: "",
      volumeId: workspace.backing.volumeId,
    });
  });

  it("reads only the bounded preview and preserves content metadata", async () => {
    const workspace = readyWorkspace();
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/session")) {
        return Response.json({ expiresAt: futureIso(), ready: true });
      }
      expect(url.searchParams.get("length")).toBe(String(512 * 1_024));
      expect(url.searchParams.get("mode")).toBe("preview");
      return new Response("hello", {
        headers: {
          "content-length": "5",
          "content-type": "text/plain; charset=utf-8",
          etag: '"file-etag"',
          "last-modified": "Tue, 12 Aug 2026 12:00:00 GMT",
          "x-opensteer-file-size": "900000",
          "x-opensteer-file-truncated": "true",
        },
      });
    });
    const service = new PortableFsWorkspaceFilesDriver({
      baseUrl: "http://files.internal:4315",
      fetchImplementation: fetchImplementation as typeof fetch,
      manager: { issueReadSessionGrant: vi.fn() } as never,
      tokens: { issue: () => "signed-request" },
    });

    const result = await service.preview(workspace, "UkVBRE1FLm1k");
    expect(new TextDecoder().decode(result.bytes)).toBe("hello");
    expect(result.metadata).toEqual({
      contentType: "text/plain; charset=utf-8",
      etag: '"file-etag"',
      modifiedAt: "2026-08-12T12:00:00.000Z",
      sizeBytes: 900_000,
      truncated: true,
    });
  });

  it("rejects storage that is not ready without contacting the Files service", async () => {
    const workspace = { ...readyWorkspace(), status: "failed" as const };
    const fetchImplementation = vi.fn();
    const service = new PortableFsWorkspaceFilesDriver({
      baseUrl: "http://files.internal:4315",
      fetchImplementation,
      manager: { issueReadSessionGrant: vi.fn() } as never,
      tokens: { issue: () => "signed-request" },
    });

    await expect(service.list(workspace, { limit: 200, parentKey: "" })).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("reports an archive in progress as retryable without touching the gateway or Manager", async () => {
    // Mid-cycle there is neither a servable filesystem nor a sealed archive:
    // the read session was evicted at the claim and the authority may already
    // be stopping, so neither a session install nor an archived read is honest.
    const workspace = { ...readyWorkspace(), status: "archiving" as const };
    const fetchImplementation = vi.fn();
    const getVolume = vi.fn();
    const service = new PortableFsWorkspaceFilesDriver({
      baseUrl: "http://files.internal:4315",
      fetchImplementation,
      manager: { getVolume, issueReadSessionGrant: vi.fn() } as never,
      tokens: { issue: () => "signed-request" },
    });

    for (const operation of [
      () => service.list(workspace, { limit: 200, parentKey: "" }),
      () => service.preview(workspace, "UkVBRE1FLm1k"),
      () => service.download(workspace, "UkVBRE1FLm1k"),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "workspace_unavailable",
        message: expect.stringContaining("being archived"),
        retryable: true,
      });
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(getVolume).not.toHaveBeenCalled();
  });

  it("reads an archived Workspace without creating a live Manager session", async () => {
    const workspace = { ...readyWorkspace(), status: "archived" as const };
    const claims: Array<Record<string, unknown>> = [];
    const issueReadSessionGrant = vi.fn();
    const getVolume = vi.fn(async () => ({
      archive_summary: {
        attempt: "44444444-4444-4444-8444-444444444444",
        logical_bytes: 2_048,
        logical_inodes: 12,
        sealed_epoch: 3,
        sealed_unix: 1_900_000_000,
      },
      authority_generation: 3,
      created_unix: 1_900_000_000,
      id: workspace.backing.volumeId,
      owner: "owner",
      product_issuer: "opensteer",
      quota_bytes: 1_024,
      quota_inodes: 100,
      state: "ARCHIVED",
      updated_unix: 1_900_000_000,
    }));
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe(`/v1/volumes/${workspace.backing.volumeId}/entries`);
      return Response.json({
        cursor: null,
        entries: [],
        parentKey: "",
        revision: "archived-revision",
      });
    });
    const service = new PortableFsWorkspaceFilesDriver({
      baseUrl: "http://files.internal:4315",
      fetchImplementation: fetchImplementation as typeof fetch,
      manager: { getVolume, issueReadSessionGrant } as never,
      tokens: {
        issue: (value) => {
          claims.push({ ...value });
          return "signed-request";
        },
      },
    });

    await service.list(workspace, { limit: 200, parentKey: "" });
    await service.list(workspace, { limit: 200, parentKey: "" });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(issueReadSessionGrant).not.toHaveBeenCalled();
    // The immutable archive summary is fetched once and cached.
    expect(getVolume).toHaveBeenCalledOnce();
    expect(claims[0]).toEqual(
      expect.objectContaining({
        archived: true,
        attempt: "44444444-4444-4444-8444-444444444444",
        operation: "list",
        sealedEpoch: 3,
        volumeId: workspace.backing.volumeId,
      }),
    );
  });

  it("translates a session evicted again after reinstall into a retryable product error", async () => {
    const workspace = readyWorkspace();
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === `/v1/volumes/${workspace.backing.volumeId}/identity`) {
        return Response.json({
          csrPem: "-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----",
          keyId: "a".repeat(43),
        });
      }
      if (url.pathname.endsWith("/session")) {
        if (init?.method === "PUT") {
          return Response.json({ expiresAt: futureIso(), ready: true }, { status: 201 });
        }
        return Response.json({ expiresAt: futureIso(), ready: true });
      }
      return Response.json(
        { error: { code: "session_required", message: "session was evicted" } },
        { status: 409 },
      );
    });
    const service = new PortableFsWorkspaceFilesDriver({
      baseUrl: "http://files.internal:4315",
      fetchImplementation: fetchImplementation as typeof fetch,
      manager: { issueReadSessionGrant: vi.fn(async () => readGrant(workspace)) } as never,
      tokens: { issue: () => "signed-request" },
    });

    await expect(service.list(workspace, { limit: 200, parentKey: "" })).rejects.toMatchObject({
      code: "workspace_unavailable",
      retryable: true,
    });
  });
});

type PortableWorkspace = Workspace & { readonly backing: PortableFsWorkspaceBacking };

function readyWorkspace(): PortableWorkspace {
  const now = new Date().toISOString();
  const id = createId("workspace");
  return {
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: "test-portablefs",
      volumeId: `volume_${id}`,
    },
    capacityPolicy: {
      blockHardLimitBytes: 512 * 1_024 * 1_024,
      inodeHardLimit: 50_000,
      kind: "hard-quota",
    },
    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id,
    kind: "specialized",
    name: "Client",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function readGrant(workspace: PortableWorkspace) {
  return {
    access: ["read"] as const,
    authorityAddress: "authority.internal:8443",
    authorityCaCertificatePem: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    authorityGeneration: 1,
    authorityServerName: "authority.internal",
    capability: "v1.payload.signature",
    certificateExpiresAt: futureIso(),
    clientCertificatePem: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
    expiresAt: futureIso(),
    managerReleaseId: "manager-test",
    volumeId: workspace.backing.volumeId,
  };
}

function fileEntry(name: string) {
  return {
    executable: false,
    hidden: false,
    key: "UkVBRE1FLm1k",
    kind: "file",
    mode: 0o644,
    modifiedAt: null,
    name,
    nameBytes: "UkVBRE1FLm1k",
    sizeBytes: 5,
  };
}

function futureIso(): string {
  return new Date(Date.now() + 5 * 60_000).toISOString();
}
