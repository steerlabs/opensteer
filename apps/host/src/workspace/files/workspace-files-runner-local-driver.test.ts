import {
  OpensteerError,
  createId,
  type LocalWorkspaceBacking,
  type StorageAuthorityId,
  type Workspace,
} from "@opensteer/core";
import type { RunnerIdentity, WorkspaceLocalRequest } from "@opensteer/orchestration";
import {
  workspaceLocalFilesReadMaxBytes,
  type RunnerWorkspaceLocalResult,
  type WorkspaceStorageFence,
} from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import type { RunnerStorageRegistry } from "../runner-local-workspace-driver.js";
import { RunnerLocalWorkspaceFilesDriver } from "./workspace-files-runner-local-driver.js";

const environmentId = createId("environment");
const storageAuthorityId = createId("storageAuthority");
const fileKey = Buffer.from("notes.txt", "utf8").toString("base64url");

describe("RunnerLocalWorkspaceFilesDriver", () => {
  it("lists a directory through the owning machine and keeps its own opaque keys", async () => {
    const { driver, requests } = fixture({
      listing: {
        directoryRevision: "r".repeat(43),
        entries: [
          {
            displayName: "notes.txt",
            executable: false,
            hidden: false,
            kind: "file",
            mode: 0o644,
            modifiedAt: "2026-08-12T12:00:00.000Z",
            nameBase64: Buffer.from("notes.txt", "utf8").toString("base64url"),
            sizeBytes: 12,
          },
        ],
        hasMore: false,
        nextOffset: 1,
      },
    });

    const page = await driver.list(workspace(), { limit: 50, parentKey: "" });

    expect(page.entries).toEqual([
      expect.objectContaining({ key: fileKey, kind: "file", name: "notes.txt" }),
    ]);
    expect(page.cursor).toBeNull();
    expect(requests[0]).toMatchObject({
      offset: 0,
      pathSegmentsBase64: [],
      type: "host.workspace.local.files.list",
    });
  });

  it("refuses a traversal key before it can reach a machine", async () => {
    const { driver, requests } = fixture({});
    const traversal = Buffer.from("..", "utf8").toString("base64url");

    await expect(driver.preview(workspace(), traversal)).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(requests).toEqual([]);
  });

  it("pulls one bounded range per consumer read and holds the revision across chunks", async () => {
    const bytes = Buffer.alloc(workspaceLocalFilesReadMaxBytes + 10, 7);
    const { driver, requests } = fixture({ bytes });

    const response = await driver.download(workspace(), fileKey);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    // One range has already been pulled to learn the file's size and revision.
    expect(requests).toHaveLength(1);

    const first = await reader.read();
    expect(first.value?.byteLength).toBe(workspaceLocalFilesReadMaxBytes);
    expect(requests).toHaveLength(1);

    const second = await reader.read();
    expect(second.value?.byteLength).toBe(10);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      expectedFileRevision: "v".repeat(43),
      maxBytes: workspaceLocalFilesReadMaxBytes,
      offset: workspaceLocalFilesReadMaxBytes,
    });

    expect((await reader.read()).done).toBe(true);
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
  });

  it("reports an unreachable machine as temporarily unavailable, not as a missing file", async () => {
    const { driver } = fixture({ offline: true });

    await expect(driver.list(workspace(), { limit: 50, parentKey: "" })).rejects.toMatchObject({
      code: "workspace_unavailable",
      retryable: true,
    });
  });

  it("passes a machine's not-found through as not found", async () => {
    const { driver } = fixture({
      failure: { code: "not-found", message: "File not found", retryable: false },
    });

    await expect(driver.preview(workspace(), fileKey)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses to read a Workspace whose storage is not ready", async () => {
    const { driver, requests } = fixture({});

    await expect(
      driver.list({ ...workspace(), status: "unavailable" }, { limit: 50, parentKey: "" }),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(requests).toEqual([]);
  });
});

function runnerIdentity(storageAuthority: StorageAuthorityId | null): RunnerIdentity {
  const runnerId = createId("runner");
  return {
    allowedModules: ["agents"],
    bootId: "rbt_11111111-1111-4111-8111-111111111111" as RunnerIdentity["bootId"],
    capabilities: ["filesystem"],
    connectionGeneration: 1,
    personalRemoteAccessGeneration: null,
    connectionId: "rcn_11111111-1111-4111-8111-111111111111" as RunnerIdentity["connectionId"],
    connectionLeaseId:
      "rls_11111111-1111-4111-8111-111111111111" as RunnerIdentity["connectionLeaseId"],
    environmentIds: [environmentId],
    fence: {
      bootId: "rbt_11111111-1111-4111-8111-111111111111" as RunnerIdentity["bootId"],
      connectionGeneration: 1,
      connectionId: "rcn_11111111-1111-4111-8111-111111111111" as RunnerIdentity["connectionId"],
      connectionLeaseId:
        "rls_11111111-1111-4111-8111-111111111111" as RunnerIdentity["connectionLeaseId"],
      runnerId,
    },
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [],
        localStorage:
          storageAuthority === null
            ? null
            : { bindings: [], storageAuthorityId: storageAuthority, truncated: false },
        maxConcurrentRuns: 1,
        providerStateModes: ["isolated"],
        workspaceBackings: ["local-directory"],
        workspaceMounts: [],
      },
    },
    name: "Lent machine",
    runnerId,
    runnerKind: "local",
    runtimeVersion: "test",
  };
}

function workspace(): Workspace & { readonly backing: LocalWorkspaceBacking } {
  const now = "2026-08-12T12:00:00.000Z";
  return {
    backing: {
      bindingId: createId("workspaceBinding"),
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId: environmentId,
      storageAuthorityId,
    },
    capacityPolicy: { kind: "host-filesystem" },
    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "specialized",
    name: "Research",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function fixture(options: {
  readonly bytes?: Buffer;
  readonly failure?: { code: string; message: string; retryable: boolean };
  readonly listing?: Extract<
    RunnerWorkspaceLocalResult,
    { type: "runner.workspace.local.files.listed" }
  >["listing"];
  readonly offline?: boolean;
}) {
  const requests: WorkspaceLocalRequest[] = [];
  const bytes = options.bytes ?? Buffer.from("hello", "utf8");
  const runners: RunnerStorageRegistry = {
    identityForEnvironment: () => runnerIdentity(storageAuthorityId),
    requestWorkspaceLocal: async (candidate, request) => {
      if (options.offline) {
        throw new OpensteerError({
          code: "workspace_unavailable",
          message: "That computer is not connected right now.",
          retryable: true,
        });
      }
      requests.push(request);
      const fence: WorkspaceStorageFence = {
        bootId: "rbt_11111111-1111-4111-8111-111111111111" as WorkspaceStorageFence["bootId"],
        connectionGeneration: 1,
        connectionId:
          "rcn_11111111-1111-4111-8111-111111111111" as WorkspaceStorageFence["connectionId"],
        connectionLeaseId:
          "rls_11111111-1111-4111-8111-111111111111" as WorkspaceStorageFence["connectionLeaseId"],
        environmentId: candidate,
        runnerId: createId("runner"),
        storageAuthorityId: storageAuthorityId as StorageAuthorityId,
      };
      const echo = {
        binding: request.binding,
        fence,
        operationId: request.operationId,
        requestId: request.requestId,
      } as const;
      if (options.failure) {
        return {
          error: options.failure as never,
          fence,
          operationId: request.operationId,
          requestId: request.requestId,
          type: "runner.workspace.local.error",
        };
      }
      if (request.type === "host.workspace.local.files.list") {
        return {
          ...echo,
          listing: options.listing ?? {
            directoryRevision: "r".repeat(43),
            entries: [],
            hasMore: false,
            nextOffset: 0,
          },
          type: "runner.workspace.local.files.listed",
        };
      }
      if (request.type === "host.workspace.local.files.read") {
        const slice = bytes.subarray(
          request.offset,
          Math.min(bytes.byteLength, request.offset + request.maxBytes),
        );
        return {
          ...echo,
          bytesRead: slice.byteLength,
          contentBase64: slice.toString("base64"),
          eof: request.offset + slice.byteLength >= bytes.byteLength,
          metadata: {
            modifiedAt: "2026-08-12T12:00:00.000Z",
            mode: 0o644,
            revision: "v".repeat(43),
            sizeBytes: bytes.byteLength,
          },
          offset: request.offset,
          type: "runner.workspace.local.files.read",
        };
      }
      throw new Error("unexpected request");
    },
  };
  return { driver: new RunnerLocalWorkspaceFilesDriver({ runners }), requests };
}
