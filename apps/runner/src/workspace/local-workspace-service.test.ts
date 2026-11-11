import { mkdir, access, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerManager } from "../apps/app-server-manager.js";
import * as workspaceSkills from "../skills/workspace-skills.js";
import { LocalWorkspaceService, type LocalWorkspaceIdentity } from "./local-workspace-service.js";

const temporaryDirectories: string[] = [];
const appServerManagers: AppServerManager[] = [];

afterEach(async () => {
  await Promise.all(appServerManagers.splice(0).map((manager) => manager.stopAll()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LocalWorkspaceService", () => {
  it("requires team admission for the separate Project provisioning message", async () => {
    const machine = await fixture();
    const legacy = await machine.provisionRequest();
    machine.authority.selectProjectStorage(legacy.binding.ownerEnvironmentId);
    const storageAuthorityId = await machine.authority.storageAuthorityId();
    const request: HostWorkspaceLocalRequest = {
      type: "host.workspace.project.provision",
      binding: { ...legacy.binding, storageAuthorityId },
      fence: { ...legacy.fence, storageAuthorityId },
      operationId: legacy.operationId,
      requestId: legacy.requestId,
    };
    const identity = request.fence;
    expect(
      await machine.service.handle(request, identity, new AbortController().signal),
    ).toMatchObject({ type: "runner.workspace.local.error" });
    machine.service.admitProjectStorage(true);
    expect(
      await machine.service.handle(request, identity, new AbortController().signal),
    ).toMatchObject({ type: "runner.workspace.local.provisioned" });
  });
  it.each(["disconnect", "deadline"])(
    "bounds a stalled metadata scan on %s and retains failed inventory",
    async (reason) => {
      const machine = await fixture();
      const provision = await machine.provisionRequest();
      await machine.handle(provision);
      let finish!: (scan: workspaceSkills.DiscoveredWorkspaceSkills) => void;
      const pending = new Promise<workspaceSkills.DiscoveredWorkspaceSkills>((resolve) => {
        finish = resolve;
      });
      const spy = vi.spyOn(workspaceSkills, "discoverWorkspaceSkills").mockReturnValue(pending);
      const abort = new AbortController();
      if (reason === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = machine.service.scanSkills(provision.binding, abort.signal);
      try {
        await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
        if (reason === "disconnect") abort.abort(new Error("Connection closed"));
        else await vi.advanceTimersByTimeAsync(30_000);
        await expect(result).resolves.toEqual({ status: "failed", reason: "unreadable" });
      } finally {
        finish({ digest: "none", metadata: [], warningCodes: [], skills: [], warnings: [] });
        spy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("removes only the named specialist folder on the bound storage", async () => {
    const machine = await fixture();
    const provision = await machine.provisionRequest();
    await machine.handle(provision);
    const read = await machine.authority.resolveReadAuthority(provision.binding);
    const folder = join(read.root, ".specialists", "registration-1");
    const sibling = join(read.root, ".specialists", "registration-2");
    await mkdir(folder, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const request = {
      ...provision,
      type: "host.workspace.local.specialist.remove",
      specialistId: "registration-1",
    } as const;
    const { fingerprint: _fingerprint, ...remove } = request;
    expect(await machine.handle(remove)).toMatchObject({
      type: "runner.workspace.local.specialist.removed",
    });
    await expect(access(folder)).rejects.toThrow();
    await expect(access(sibling)).resolves.toBeUndefined();
    expect(await machine.handle(remove)).toMatchObject({
      type: "runner.workspace.local.specialist.removed",
    });
  });

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

  it("stops every app server for the destroyed binding before recording its receipt", async () => {
    const machine = await fixture();
    const provision = await machine.provisionRequest();
    const other = await machine.provisionRequest();
    await machine.handle(provision);
    await machine.handle(other);
    const ports = await Promise.all([
      machine.appServers.start(serverSpec(provision.binding)),
      machine.appServers.start(serverSpec(provision.binding)),
    ]);
    const otherSpec = serverSpec(other.binding);
    const otherPort = await machine.appServers.start(otherSpec);

    await expect(machine.handle(destroyRequest(provision))).resolves.toMatchObject({
      receipt: { outcome: "destroyed" },
      type: "runner.workspace.local.destroyed",
    });

    for (const port of ports) await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    expect(await machine.appServers.start(otherSpec)).toBe(otherPort);
    expect(await (await fetch(`http://127.0.0.1:${otherPort}`)).text()).toBe("ok");
  });

  it("withholds a destroy receipt when an app server cannot stop and succeeds on replay", async () => {
    let proof: "unknown" | "proven" = "unknown";
    const machine = await fixture(async (_id, stopEngine) => {
      await stopEngine();
      return proof;
    });
    const provision = await machine.provisionRequest();
    await machine.handle(provision);
    await machine.appServers.start(serverSpec(provision.binding));
    const destroy = destroyRequest(provision);
    try {
      await expect(machine.handle(destroy)).resolves.toMatchObject({
        type: "runner.workspace.local.error",
        error: { retryable: true },
      });
      await expect(
        machine.authority.resolveReadAuthority(provision.binding),
      ).resolves.toHaveProperty("root");
    } finally {
      proof = "proven";
    }
    await expect(machine.handle(destroy)).resolves.toMatchObject({
      receipt: { outcome: "destroyed" },
      type: "runner.workspace.local.destroyed",
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

async function fixture(terminate?: ConstructorParameters<typeof AppServerManager>[0]["terminate"]) {
  const basePath = await mkdtemp(join(tmpdir(), "opensteer-local-workspace-service-"));
  temporaryDirectories.push(basePath);
  const environmentId = createId("environment");
  const authority = new LocalWorkspaceAuthority({
    namespace: { kind: "single-owner", ownerEnvironmentId: environmentId },
    registryFilePath: join(basePath, "private", "workspace-registry.json"),
    visibleRootPath: join(basePath, "workspaces"),
  });
  const filesystem = recordingFilesystem();
  const appServers = new AppServerManager({
    privateDirectory: join(basePath, "private", "app-servers"),
    resolveRoot: async (binding, signal) =>
      (await authority.resolveReadAuthority(binding, signal)).root,
    planLaunch: async () => (launch) => launch,
    terminate:
      terminate ??
      (async (_id, stopEngine) => {
        await stopEngine();
        return "proven";
      }),
  });
  appServerManagers.push(appServers);
  const service = new LocalWorkspaceService({
    authority,
    filesystem: filesystem.authority,
    appServers,
  });
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
    appServers,
    authority,
    filesystem,
    service,
    handle: (request: HostWorkspaceLocalRequest) =>
      service.handle(request, identity, AbortSignal.timeout(10_000)),
    provisionRequest: async (): Promise<
      Extract<HostWorkspaceLocalRequest, { type: "host.workspace.local.provision" }>
    > => {
      const intent = {
        createdBy: createId("user"),
        kind: "project" as const,
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

function serverSpec(binding: HostWorkspaceLocalRequest["binding"]) {
  return {
    appId: `app_${crypto.randomUUID()}`,
    version: 1,
    binding,
    folder: ".",
    command: `exec ${process.execPath} -e 'require("node:http").createServer((q,s)=>s.end("ok")).listen(process.env.PORT,"127.0.0.1")'`,
  };
}

function destroyRequest(provision: HostWorkspaceLocalRequest): HostWorkspaceLocalRequest {
  return {
    binding: provision.binding,
    fence: provision.fence,
    operationId: workspaceLocalOperationId({
      generation: provision.binding.generation,
      operation: "destroy",
      workspaceId: provision.binding.workspaceId,
    }),
    requestId: globalThis.crypto.randomUUID(),
    type: "host.workspace.local.destroy",
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
