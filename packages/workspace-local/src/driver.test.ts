import {
  createId,
  type EnvironmentId,
  type StorageAuthorityId,
  type UserId,
} from "@opensteer/core";
import { localWorkspaceBindingId } from "@opensteer/workspace/local-binding";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalWorkspaceErrorCode } from "./errors.js";
import {
  LocalWorkspaceAuthority,
  type LocalWorkspaceAuthorityOptions,
  type LocalWorkspaceBindingRequest,
} from "./index.js";
import type { RegistryDocument } from "./registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LocalWorkspaceAuthority", () => {
  it("preflights an empty managed root without creating a Workspace", async () => {
    const fixture = await createFixture();

    expect(await fixture.authority.preflight()).toEqual({
      available: true,
      detail: "Managed local Workspace storage is ready.",
    });
    expect(await lstat(fixture.visibleRootPath)).toMatchObject({});
    expect((await registryDocument(fixture.registryFilePath)).bindings).toEqual([]);
  });

  it("mints one storage authority identity and never rewrites it", async () => {
    const fixture = await createFixture();

    const first = await fixture.authority.storageAuthorityId();
    const second = await new LocalWorkspaceAuthority(fixture.options).storageAuthorityId();

    expect(first).toBe(second);
    expect((await registryDocument(fixture.registryFilePath)).storageAuthorityId).toBe(first);
  });

  it("moves a verified version 2 registry into Runner ownership without adopting its bindings", async () => {
    const fixture = await provisionedFixture();
    const current = await registryDocument(fixture.registryFilePath);
    const legacyRegistryFilePath = path.join(fixture.basePath, "host", "workspace-registry.json");
    const {
      receipts: _receipts,
      storageAuthorityId: _storageAuthorityId,
      version: _version,
      ...legacy
    } = current;
    await mkdir(path.dirname(legacyRegistryFilePath), { recursive: true, mode: 0o700 });
    await overwriteRegistry(legacyRegistryFilePath, { ...legacy, version: 2 });
    await rm(fixture.registryFilePath);

    const migrated = new LocalWorkspaceAuthority({
      ...fixture.options,
      legacyRegistryFilePath,
    });
    expect(await migrated.preflight()).toEqual({
      available: true,
      detail: "Managed local Workspace storage is ready.",
    });
    const document = await registryDocument(fixture.registryFilePath);
    expect(document).toMatchObject({
      bindings: current.bindings,
      namespace: current.namespace,
      receipts: [],
      revision: current.revision,
      rootIdentity: current.rootIdentity,
      version: 3,
    });
    expect(document.storageAuthorityId).toMatch(/^sta_/u);
    expect(JSON.parse(await readFile(legacyRegistryFilePath, "utf8"))).toEqual({
      ...legacy,
      version: 2,
    });
  });

  it("refuses to migrate a version 2 registry for another environment", async () => {
    const fixture = await provisionedFixture();
    const current = await registryDocument(fixture.registryFilePath);
    const legacyRegistryFilePath = path.join(fixture.basePath, "host", "workspace-registry.json");
    const {
      receipts: _receipts,
      storageAuthorityId: _storageAuthorityId,
      version: _version,
      ...legacy
    } = current;
    await mkdir(path.dirname(legacyRegistryFilePath), { recursive: true, mode: 0o700 });
    await overwriteRegistry(legacyRegistryFilePath, { ...legacy, version: 2 });
    await rm(fixture.registryFilePath);

    const authority = new LocalWorkspaceAuthority({
      ...fixture.options,
      legacyRegistryFilePath,
      namespace: { kind: "single-owner", ownerEnvironmentId: createId("environment") },
    });
    expect(await authority.preflight()).toEqual({
      available: false,
      detail: "The configured local Workspace namespace does not match its legacy registry.",
    });
    await expect(lstat(fixture.registryFilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to migrate a version 2 registry after its physical root is replaced", async () => {
    const fixture = await provisionedFixture();
    const current = await registryDocument(fixture.registryFilePath);
    const legacyRegistryFilePath = path.join(fixture.basePath, "host", "workspace-registry.json");
    const {
      receipts: _receipts,
      storageAuthorityId: _storageAuthorityId,
      version: _version,
      ...legacy
    } = current;
    await mkdir(path.dirname(legacyRegistryFilePath), { recursive: true, mode: 0o700 });
    await overwriteRegistry(legacyRegistryFilePath, { ...legacy, version: 2 });
    await rm(fixture.registryFilePath);
    await rename(fixture.visibleRootPath, `${fixture.visibleRootPath}.replaced`);
    await mkdir(fixture.visibleRootPath, { mode: 0o700 });

    const authority = new LocalWorkspaceAuthority({
      ...fixture.options,
      legacyRegistryFilePath,
    });
    expect(await authority.preflight()).toEqual({
      available: false,
      detail: "The managed Workspace root has been replaced.",
    });
    await expect(lstat(fixture.registryFilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a non-empty root without its protected registry as unavailable", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.visibleRootPath);
    await mkdir(path.join(fixture.visibleRootPath, "untracked"));

    expect(await fixture.authority.preflight()).toEqual({
      available: false,
      detail: "The protected local Workspace registry is missing for a non-empty managed root.",
    });
    await expect(lstat(fixture.registryFilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives a stable binding before it touches storage", async () => {
    const fixture = await createFixture();
    const intent = provisionIntent(fixture.environmentId);

    expect(localWorkspaceBindingId(intent)).toBe(localWorkspaceBindingId(intent));
    await expect(lstat(fixture.visibleRootPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(fixture.registryFilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses stable managed paths for Main and specialized Workspaces", async () => {
    const fixture = await createFixture();
    const main = await fixture.provision({ kind: "main" });
    const specialized = await fixture.provision({ kind: "specialized" });

    expect((await fixture.authority.resolveReadAuthority(main.binding)).root).toBe(
      path.join(fixture.visibleRootPath, "main"),
    );
    expect((await fixture.authority.resolveReadAuthority(specialized.binding)).root).toBe(
      path.join(fixture.visibleRootPath, specialized.intent.workspaceId),
    );
  });

  it("places separate owners in fixed owner-scoped namespaces", async () => {
    const fixture = await createFixture({ namespace: { kind: "owner-scoped" } });
    const first = await fixture.provision({
      kind: "main",
      ownerEnvironmentId: createId("environment"),
    });
    const second = await fixture.provision({
      kind: "main",
      ownerEnvironmentId: createId("environment"),
    });

    expect((await fixture.authority.resolveReadAuthority(first.binding)).root).toBe(
      path.join(fixture.visibleRootPath, first.intent.createdBy, "main"),
    );
    expect((await fixture.authority.resolveReadAuthority(second.binding)).root).toBe(
      path.join(fixture.visibleRootPath, second.intent.createdBy, "main"),
    );
  });

  it("replays one durable intent across concurrent retries", async () => {
    const fixture = await createFixture();
    const request = await fixture.provisionRequest({});

    await Promise.all([
      fixture.authority.provision(request),
      fixture.authority.provision(request),
      fixture.authority.provision(request),
    ]);

    expect((await registryDocument(fixture.registryFilePath)).bindings).toHaveLength(1);
  });

  it("resumes the persisted intent after the Runner process restarts", async () => {
    const fixture = await createFixture();
    const request = await fixture.provisionRequest({});
    await new LocalWorkspaceAuthority(fixture.options).provision(request);
    const restarted = new LocalWorkspaceAuthority(fixture.options);

    expect(await restarted.inspect(request.binding)).toEqual({ status: "ready" });
    await expect(restarted.provision(request)).resolves.toBeUndefined();
    expect((await registryDocument(fixture.registryFilePath)).bindings).toHaveLength(1);
  });

  it("atomically moves a deleted Workspace out of its managed path before removing data", async () => {
    const fixture = await provisionedFixture();
    await writeFile(path.join(fixture.workspacePath, "kept-until-purge.txt"), "content", "utf8");

    const receipt = await fixture.authority.destroy(fixture.binding);

    expect(receipt.outcome).toBe("destroyed");
    await expect(lstat(fixture.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await registryDocument(fixture.registryFilePath)).bindings).toEqual([]);
    expect(await readdir(path.join(fixture.basePath, ".opensteer-trash"))).toEqual([]);
  });

  it("replays a destruction from its durable receipt", async () => {
    const fixture = await provisionedFixture();
    const first = await fixture.authority.destroy(fixture.binding);

    expect(await fixture.authority.destroy(fixture.binding)).toEqual(first);
  });

  it("refuses to report a destruction it has no receipt for", async () => {
    const fixture = await provisionedFixture();
    const document = await registryDocument(fixture.registryFilePath);
    await overwriteRegistry(fixture.registryFilePath, { ...document, bindings: [] });

    await expect(fixture.authority.destroy(fixture.binding)).rejects.toMatchObject({
      code: LocalWorkspaceErrorCode.registryInvalid,
    });
  });

  it("converges deletion when the managed directory is already absent", async () => {
    const fixture = await provisionedFixture();
    await rm(fixture.visibleRootPath, { recursive: true });

    expect(await fixture.authority.destroy(fixture.binding)).toMatchObject({
      outcome: "already-destroyed",
    });
    expect((await registryDocument(fixture.registryFilePath)).bindings).toEqual([]);
  });

  it("serializes concurrent provisioning of separate Workspaces", async () => {
    const fixture = await createFixture();
    const requests = await Promise.all(
      Array.from({ length: 12 }, () => fixture.provisionRequest({})),
    );

    await Promise.all(requests.map((request) => fixture.authority.provision(request)));

    expect(new Set(requests.map((request) => request.binding.bindingId)).size).toBe(12);
    expect((await registryDocument(fixture.registryFilePath)).bindings).toHaveLength(12);
  });

  it("rejects an operation identity already bound to another durable intent", async () => {
    const fixture = await provisionedFixture();
    const conflicting = await fixture.provisionRequest({
      idempotencyKey: fixture.request.idempotencyKey,
    });

    await expect(fixture.authority.provision(conflicting)).rejects.toMatchObject({
      code: LocalWorkspaceErrorCode.idempotencyConflict,
    });
  });

  it("rejects a binding that does not match its creation intent", async () => {
    const fixture = await createFixture();
    const request = await fixture.provisionRequest({});
    const tampered = {
      ...request,
      binding: { ...request.binding, bindingId: createId("workspaceBinding") },
    };

    await expect(fixture.authority.provision(tampered)).rejects.toMatchObject({
      code: LocalWorkspaceErrorCode.workspaceMismatch,
    });
    await expect(lstat(path.join(fixture.visibleRootPath, "main"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses every operation fenced to another machine's disk", async () => {
    const fixture = await provisionedFixture();
    const foreign: LocalWorkspaceBindingRequest = {
      ...fixture.binding,
      storageAuthorityId: createId("storageAuthority"),
    };

    await expect(fixture.authority.destroy(foreign)).rejects.toMatchObject({
      code: LocalWorkspaceErrorCode.authorityMismatch,
    });
    expect(await fixture.authority.inspect(foreign)).toMatchObject({
      issue: { code: "authority-mismatch" },
    });
    await expect(fixture.authority.resolveReadAuthority(foreign)).rejects.toMatchObject({
      code: LocalWorkspaceErrorCode.authorityMismatch,
    });
    expect((await registryDocument(fixture.registryFilePath)).bindings).toHaveLength(1);
  });

  it("rejects duplicate binding IDs in the protected registry", async () => {
    const fixture = await provisionedFixture();
    const document = await registryDocument(fixture.registryFilePath);
    const firstBinding = document.bindings[0];
    if (firstBinding === undefined) throw new Error("Expected a registry binding");
    document.bindings.push({
      ...firstBinding,
      idempotencyKey: "another-operation",
      workspaceId: createId("workspace"),
    });
    await overwriteRegistry(fixture.registryFilePath, document);

    expect(await fixture.authority.inspect(fixture.binding)).toMatchObject({
      issue: { code: "registry-invalid" },
      status: "failed",
    });
  });

  it("rejects traversal segments loaded from a tampered registry", async () => {
    const fixture = await provisionedFixture();
    const document = await registryDocument(fixture.registryFilePath);
    const firstBinding = document.bindings[0];
    if (firstBinding === undefined) throw new Error("Expected a registry binding");
    firstBinding.relativeSegments = ["..", "escape"];
    await overwriteRegistry(fixture.registryFilePath, document);

    expect(await fixture.authority.inspect(fixture.binding)).toMatchObject({
      issue: { code: "registry-invalid" },
      status: "failed",
    });
  });

  it("rejects execution from another environment", async () => {
    const fixture = await provisionedFixture();

    await expect(
      fixture.authority.resolveExecutionPath({
        environmentId: createId("environment"),
        plan: { ...fixture.binding, kind: "local-directory" },
      }),
    ).rejects.toMatchObject({ code: LocalWorkspaceErrorCode.environmentMismatch });
    await expect(
      fixture.authority.resolveExecutionPath({
        environmentId: fixture.environmentId,
        plan: { ...fixture.binding, kind: "local-directory" },
      }),
    ).resolves.toBe(fixture.workspacePath);
  });

  it("rejects stale binding generations", async () => {
    const fixture = await provisionedFixture();

    expect(await fixture.authority.inspect({ ...fixture.binding, generation: 2 })).toMatchObject({
      issue: { code: "generation-mismatch" },
    });
  });

  it("marks a missing directory unavailable and never recreates it", async () => {
    const fixture = await provisionedFixture();
    await rm(fixture.workspacePath, { recursive: true });

    expect(await fixture.authority.inspect(fixture.binding)).toMatchObject({
      issue: { code: "directory-missing" },
    });
    await expect(fixture.authority.provision(fixture.request)).rejects.toMatchObject({
      code: LocalWorkspaceErrorCode.directoryMissing,
    });
    await expect(lstat(fixture.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks a replaced directory unavailable and never accepts it", async () => {
    const fixture = await provisionedFixture();
    await rename(fixture.workspacePath, `${fixture.workspacePath}.original`);
    await mkdir(fixture.workspacePath);

    expect(await fixture.authority.inspect(fixture.binding)).toMatchObject({
      issue: { code: "directory-replaced" },
    });
    await expect(fixture.authority.provision(fixture.request)).rejects.toMatchObject({
      code: LocalWorkspaceErrorCode.directoryReplaced,
    });
  });

  it("detects replacement of the configured visible root", async () => {
    const fixture = await provisionedFixture();
    await rename(fixture.visibleRootPath, `${fixture.visibleRootPath}.original`);
    await mkdir(fixture.visibleRootPath);

    expect(await fixture.authority.inspect(fixture.binding)).toMatchObject({
      issue: { code: "directory-replaced" },
    });
  });

  it("reports what this disk holds so a reconnect can be reconciled", async () => {
    const fixture = await provisionedFixture();

    expect(await fixture.authority.inventory()).toEqual({
      bindings: [
        {
          bindingId: fixture.binding.bindingId,
          generation: 1,
          state: "ready",
          workspaceId: fixture.binding.workspaceId,
        },
      ],
      storageAuthorityId: fixture.binding.storageAuthorityId,
      truncated: false,
    });
  });

  it("delegates root creation and every persisted identity decision to one native authority", async () => {
    let workspaceFileId = "200";
    const rootIdentity = { fileId: "100", kind: "posix", volumeId: "1" } as const;
    const authority: NonNullable<LocalWorkspaceAuthorityOptions["filesystemAuthority"]> = {
      directoryIdentity: vi.fn(async ({ path: relativePath }) =>
        relativePath === "."
          ? rootIdentity
          : { fileId: workspaceFileId, kind: "posix" as const, volumeId: "1" },
      ),
      ensureDirectory: vi.fn(async ({ path: relativePath, root }) => {
        await mkdir(path.join(root, ...relativePath.split("/")), { recursive: true });
        return { fileId: workspaceFileId, kind: "posix" as const, volumeId: "1" };
      }),
      ensureRoot: vi.fn(async ({ root }) => {
        const existed = await lstat(root).then(
          () => true,
          () => false,
        );
        await mkdir(root, { recursive: true });
        return { created: !existed, identity: rootIdentity };
      }),
      list: vi.fn(async () => ({ entries: [], truncated: false })),
    };
    const fixture = await createFixture({ filesystemAuthority: authority });

    await expect(fixture.authority.preflight()).resolves.toMatchObject({ available: true });
    const request = await fixture.provisionRequest({});
    await fixture.authority.provision(request);
    expect(authority.ensureRoot).toHaveBeenCalledWith(
      { root: fixture.visibleRootPath },
      expect.any(AbortSignal),
    );
    expect(authority.ensureDirectory).toHaveBeenCalledOnce();

    workspaceFileId = "201";
    await expect(fixture.authority.inspect(request.binding)).resolves.toMatchObject({
      issue: { code: "directory-replaced" },
    });
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link visible root", async () => {
    const fixture = await createFixture();
    const realRoot = path.join(fixture.basePath, "real-root");
    await mkdir(realRoot);
    await symlink(realRoot, fixture.visibleRootPath, "dir");

    await expect(fixture.provisionRequest({})).rejects.toMatchObject({
      code: LocalWorkspaceErrorCode.directoryReplaced,
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic-link Workspace directory",
    async () => {
      const fixture = await provisionedFixture();
      const originalPath = `${fixture.workspacePath}.original`;
      await rename(fixture.workspacePath, originalPath);
      await symlink(originalPath, fixture.workspacePath, "dir");

      expect(await fixture.authority.inspect(fixture.binding)).toMatchObject({
        issue: { code: "directory-replaced" },
      });
    },
  );

  it("does not adopt a pre-existing directory", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.visibleRootPath);
    await mkdir(path.join(fixture.visibleRootPath, "main"));

    await expect(fixture.provisionRequest({ kind: "main" })).rejects.toMatchObject({
      code: LocalWorkspaceErrorCode.registryInvalid,
    });
  });

  it("keeps the protected registry outside the visible root with private permissions", async () => {
    const fixture = await provisionedFixture();
    expect(path.relative(fixture.visibleRootPath, fixture.registryFilePath)).toMatch(/^\.\./);
    if (process.platform !== "win32") {
      expect((await lstat(fixture.registryFilePath)).mode & 0o777).toBe(0o600);
      expect((await lstat(path.dirname(fixture.registryFilePath))).mode & 0o777).toBe(0o700);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a registry parent whose permissions become public",
    async () => {
      const fixture = await provisionedFixture();
      await chmod(path.dirname(fixture.registryFilePath), 0o755);

      expect(await fixture.authority.preflight()).toEqual({
        available: false,
        detail: "The protected local Workspace registry parent directory has unsafe permissions.",
      });
    },
  );

  it("rejects a registry placed inside the visible root", async () => {
    const basePath = await temporaryDirectory();
    const visibleRootPath = path.join(basePath, "workspaces");
    expect(
      () =>
        new LocalWorkspaceAuthority({
          namespace: { kind: "single-owner", ownerEnvironmentId: createId("environment") },
          registryFilePath: path.join(visibleRootPath, ".registry.json"),
          visibleRootPath,
        }),
    ).toThrow("must not overlap");
  });
});

interface ProvisionIntent {
  readonly createdBy: UserId;
  readonly idempotencyKey: string;
  readonly kind: "main" | "specialized";
  readonly ownerEnvironmentId: EnvironmentId;
  readonly workspaceId: ReturnType<typeof createId<"workspace">>;
}

function provisionIntent(
  ownerEnvironmentId: EnvironmentId,
  overrides: Partial<ProvisionIntent> = {},
): ProvisionIntent {
  return {
    createdBy: createId("user"),
    idempotencyKey: `workspace:${createId("workspace")}:provision:v1:1`,
    kind: "specialized",
    ownerEnvironmentId,
    workspaceId: createId("workspace"),
    ...overrides,
  };
}

async function createFixture(input?: {
  readonly filesystemAuthority?: LocalWorkspaceAuthorityOptions["filesystemAuthority"];
  readonly namespace?: LocalWorkspaceAuthorityOptions["namespace"];
}) {
  const basePath = await temporaryDirectory();
  const environmentId =
    input?.namespace?.kind === "single-owner"
      ? input.namespace.ownerEnvironmentId
      : createId("environment");
  const options: LocalWorkspaceAuthorityOptions = {
    ...(input?.filesystemAuthority ? { filesystemAuthority: input.filesystemAuthority } : {}),
    namespace: input?.namespace ?? { kind: "single-owner", ownerEnvironmentId: environmentId },
    registryFilePath: path.join(basePath, "private", "workspace-registry.json"),
    visibleRootPath: path.join(basePath, "workspaces"),
  };
  const authority = new LocalWorkspaceAuthority(options);
  const provisionRequest = async (overrides: Partial<ProvisionIntent>) => {
    const intent = provisionIntent(overrides.ownerEnvironmentId ?? environmentId, overrides);
    const storageAuthorityId: StorageAuthorityId = await authority.storageAuthorityId();
    return {
      binding: {
        bindingId: localWorkspaceBindingId(intent),
        generation: 1,
        ownerEnvironmentId: intent.ownerEnvironmentId,
        storageAuthorityId,
        workspaceId: intent.workspaceId,
      },
      fingerprint: { createdBy: intent.createdBy, workspaceKind: intent.kind },
      idempotencyKey: intent.idempotencyKey,
      intent,
    };
  };
  return {
    authority,
    basePath,
    environmentId,
    options,
    provision: async (overrides: Partial<ProvisionIntent>) => {
      const request = await provisionRequest(overrides);
      await authority.provision(request);
      return request;
    },
    provisionRequest,
    registryFilePath: options.registryFilePath,
    visibleRootPath: options.visibleRootPath,
  };
}

async function provisionedFixture() {
  const fixture = await createFixture();
  const request = await fixture.provisionRequest({});
  await fixture.authority.provision(request);
  const workspacePath = (await fixture.authority.resolveReadAuthority(request.binding)).root;
  return { ...fixture, binding: request.binding, request, workspacePath };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opensteer-workspace-local-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function registryDocument(filePath: string): Promise<RegistryDocument> {
  return JSON.parse(await readFile(filePath, "utf8")) as RegistryDocument;
}

async function overwriteRegistry(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
  if (process.platform !== "win32") await chmod(filePath, 0o600);
}
