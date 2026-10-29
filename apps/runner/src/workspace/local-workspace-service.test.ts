import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, type EnvironmentId, type StorageAuthorityId } from "@opensteer/core";
import {
  workspaceLocalOperationId,
  type HostWorkspaceLocalRequest,
  type RunnerBootId,
  type RunnerConnectionId,
  type RunnerConnectionLeaseId,
  type WorkspaceStorageFence,
} from "@opensteer/protocol";
import { localWorkspaceBindingId } from "@opensteer/workspace/local-binding";
import {
  LocalWorkspaceAuthority,
  type NativeWorkspaceFilesAuthority,
} from "@opensteer/workspace-local";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWorkspaceService, type LocalWorkspaceIdentity } from "./local-workspace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LocalWorkspaceService", () => {
  it("provisions once and replays the same operation without creating a second directory", async () => {
    const machine = await fixture();
    const request = await machine.provisionRequest();

    await expect(machine.handle(request)).resolves.toMatchObject({
      type: "runner.workspace.local.provisioned",
    });
    await expect(machine.handle(request)).resolves.toMatchObject({
      type: "runner.workspace.local.provisioned",
    });
    expect((await machine.authority.inventory()).bindings).toHaveLength(1);
  });

  it("refuses a request fenced to an earlier connection, because the Host may have reissued it", async () => {
    const machine = await fixture();
    const request = await machine.provisionRequest();

    const result = await machine.handle({
      ...request,
      fence: { ...request.fence, connectionGeneration: request.fence.connectionGeneration - 1 },
    });

    expect(result).toMatchObject({
      error: { code: "fence-stale", retryable: true },
      type: "runner.workspace.local.error",
    });
    expect((await machine.authority.inventory()).bindings).toEqual([]);
  });

  it("refuses a request fenced to another machine's disk", async () => {
    const machine = await fixture();
    const request = await machine.provisionRequest();
    const foreign = createId("storageAuthority");

    const result = await machine.handle({
      ...request,
      binding: { ...request.binding, storageAuthorityId: foreign },
      fence: { ...request.fence, storageAuthorityId: foreign },
    });

    expect(result).toMatchObject({
      error: { code: "authority-mismatch", retryable: false },
      type: "runner.workspace.local.error",
    });
  });

  it("answers a destroy only with the receipt it recorded, and replays that receipt", async () => {
    const machine = await fixture();
    const provision = await machine.provisionRequest();
    await machine.handle(provision);
    const destroy: HostWorkspaceLocalRequest = {
      binding: provision.binding,
      fence: provision.fence,
      operationId: workspaceLocalOperationId({
        generation: 1,
        operation: "destroy",
        workspaceId: provision.binding.workspaceId,
      }),
      requestId: globalThis.crypto.randomUUID(),
      type: "host.workspace.local.destroy",
    };

    const first = await machine.handle(destroy);
    const replay = await machine.handle({ ...destroy, requestId: globalThis.crypto.randomUUID() });

    expect(first).toMatchObject({
      receipt: { outcome: "destroyed" },
      type: "runner.workspace.local.destroyed",
    });
    expect(replay).toMatchObject({
      receipt: { outcome: "destroyed" },
      type: "runner.workspace.local.destroyed",
    });
  });

  it("reports a missing directory rather than silently recreating it", async () => {
    const machine = await fixture();
    const provision = await machine.provisionRequest();
    await machine.handle(provision);
    const read = await machine.authority.resolveReadAuthority(provision.binding);
    await rm(read.root, { recursive: true });

    const inspected = await machine.handle({
      binding: provision.binding,
      fence: provision.fence,
      operationId: `workspace:${provision.binding.workspaceId}:inspect:v1`,
      requestId: globalThis.crypto.randomUUID(),
      type: "host.workspace.local.inspect",
    });

    expect(inspected).toMatchObject({
      health: { issue: { code: "directory-missing" } },
      type: "runner.workspace.local.inspected",
    });
  });

  it("reads a bounded range against the identity-bound root", async () => {
    const machine = await fixture();
    const provision = await machine.provisionRequest();
    await machine.handle(provision);
    const read = await machine.authority.resolveReadAuthority(provision.binding);
    await writeFile(join(read.root, "notes.txt"), "hello", "utf8");

    const result = await machine.handle({
      binding: provision.binding,
      fence: provision.fence,
      maxBytes: 1_024,
      offset: 0,
      operationId: `workspace:${provision.binding.workspaceId}:files.read:v1`,
      pathSegmentsBase64: [Buffer.from("notes.txt", "utf8").toString("base64url")],
      requestId: globalThis.crypto.randomUUID(),
      type: "host.workspace.local.files.read",
    });

    expect(result).toMatchObject({ bytesRead: 5, type: "runner.workspace.local.files.read" });
    expect(machine.filesystem.roots).toEqual([read.root]);
  });
});

async function fixture() {
  const basePath = await mkdtemp(join(tmpdir(), "opensteer-local-workspace-service-"));
  temporaryDirectories.push(basePath);
  const environmentId = createId("environment");
  const authority = new LocalWorkspaceAuthority({
    namespace: { kind: "single-owner", ownerEnvironmentId: environmentId },
    registryFilePath: join(basePath, "private", "workspace-registry.json"),
    visibleRootPath: join(basePath, "workspaces"),
  });
  const filesystem = recordingFilesystem();
  const service = new LocalWorkspaceService({ authority, filesystem: filesystem.authority });
  const storageAuthorityId: StorageAuthorityId = await authority.storageAuthorityId();
  const identity: LocalWorkspaceIdentity = {
    bootId: "rbt_11111111-1111-4111-8111-111111111111" as RunnerBootId,
    connectionGeneration: 2,
    connectionId: "rcn_11111111-1111-4111-8111-111111111111" as RunnerConnectionId,
    connectionLeaseId: "rls_11111111-1111-4111-8111-111111111111" as RunnerConnectionLeaseId,
    environmentId,
    runnerId: createId("runner"),
    storageAuthorityId,
  };
  const fence: WorkspaceStorageFence = {
    bootId: identity.bootId,
    connectionGeneration: identity.connectionGeneration,
    connectionId: identity.connectionId,
    connectionLeaseId: identity.connectionLeaseId,
    environmentId: identity.environmentId,
    runnerId: identity.runnerId,
    storageAuthorityId,
  };
  return {
    authority,
    filesystem,
    handle: (request: HostWorkspaceLocalRequest) =>
      service.handle(request, identity, AbortSignal.timeout(10_000)),
    provisionRequest: async (): Promise<
      Extract<HostWorkspaceLocalRequest, { type: "host.workspace.local.provision" }>
    > => {
      const intent = {
        createdBy: createId("user"),
        kind: "specialized" as const,
        ownerEnvironmentId: environmentId as EnvironmentId,
        workspaceId: createId("workspace"),
      };
      const operationId = workspaceLocalOperationId({
        generation: 1,
        operation: "provision",
        workspaceId: intent.workspaceId,
      });
      return {
        binding: {
          bindingId: localWorkspaceBindingId({ ...intent, idempotencyKey: operationId }),
          generation: 1,
          ownerEnvironmentId: environmentId,
          storageAuthorityId,
          workspaceId: intent.workspaceId,
        },
        fence,
        fingerprint: { createdBy: intent.createdBy, workspaceKind: intent.kind },
        operationId,
        requestId: globalThis.crypto.randomUUID(),
        type: "host.workspace.local.provision",
      };
    },
  };
}

/** Records the roots a read was performed against, which is the containment
 * decision the Host is trusting the machine to make. */
function recordingFilesystem() {
  const roots: string[] = [];
  const authority: NativeWorkspaceFilesAuthority = {
    filesDownload: async () => {
      throw new Error("unused");
    },
    filesList: async (input) => {
      roots.push(input.root);
      return { directoryRevision: "r".repeat(43), entries: [], hasMore: false, nextOffset: 0 };
    },
    filesReadRange: async (input) => {
      roots.push(input.root);
      return {
        bytes: Buffer.from("hello", "utf8"),
        bytesRead: 5,
        eof: true,
        metadata: {
          modifiedAt: "2026-08-12T12:00:00.000Z",
          mode: 0o644,
          revision: "v".repeat(43),
          sizeBytes: 5,
        },
        offset: input.offset,
      };
    },
  };
  return { authority, roots };
}
