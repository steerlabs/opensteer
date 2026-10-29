import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPrivateFilesystem } from "./desktop-private-files.js";
import {
  defaultPersonalDeploymentName,
  NativePersonalDeploymentFilesystem,
  PersonalDeploymentManifestSchema,
  PersonalFilesystemError,
  type PersonalDeploymentManifest,
} from "./personal-deployment-store.js";

const directories = vi.hoisted(() => ({ failure: null as NodeJS.ErrnoException | null }));
vi.mock("@opensteer/shared/privateFiles", async (original) => {
  const actual = await original<typeof import("@opensteer/shared/privateFiles")>();
  return {
    ...actual,
    ensurePrivateDirectory: async (
      ...input: Parameters<typeof actual.ensurePrivateDirectory>
    ): Promise<void> => {
      if (directories.failure) throw directories.failure;
      await actual.ensurePrivateDirectory(...input);
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  directories.failure = null;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("NativePersonalDeploymentFilesystem", () => {
  it("discards a release-realistic v1 manifest and migrates v2 identity to v3", async () => {
    const root = await temporaryDirectory();
    const current = { ...manifest(path.join(root, "Workspaces")), revision: 4 };
    const { name: _name, schemaVersion: _schemaVersion, ...priorFields } = current;
    let content: Buffer | null = Buffer.from(
      `${JSON.stringify({ ...priorFields, schemaVersion: 1 })}\n`,
    );
    const writeFileAtomic = vi.fn(async (_path: string, next: Buffer | string) => {
      content = Buffer.isBuffer(next) ? next : Buffer.from(next);
    });
    const privateFiles = {
      readFile: vi.fn(async () => content),
      root,
      rootIdentity: { fileId: "1", kind: "posix", volumeId: "1" },
      writeFileAtomic,
    } as unknown as DesktopPrivateFilesystem;
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: root,
      minimumFreeBytes: 0,
      privateFiles,
    });

    await expect(files.load()).resolves.toBeNull();
    expect(writeFileAtomic).not.toHaveBeenCalled();

    const prior = { ...current, authorityEpoch: 37, name: "Studio", schemaVersion: 2 as const };
    const expected = { ...current, name: "Studio" };
    content = Buffer.from(`${JSON.stringify(prior)}\n`);
    await expect(files.load()).resolves.toEqual(expected);
    expect(writeFileAtomic).toHaveBeenCalledOnce();
    expect(JSON.parse(content!.toString())).toEqual(expected);
  });

  it("discards invalid manifests and rejects oversized files", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = path.join(root, "data");
    const files = new NativePersonalDeploymentFilesystem({ dataDirectory, minimumFreeBytes: 0 });
    await mkdir(dataDirectory);
    await writeFile(files.manifestPath, '{"schemaVersion":1}\n');
    await expect(files.load()).resolves.toBeNull();
    await writeFile(files.manifestPath, '{"schemaVersion":3}\n');
    await expect(files.load()).resolves.toBeNull();
    await writeFile(files.manifestPath, "not-json\n");
    await expect(files.load()).resolves.toBeNull();
    await writeFile(files.manifestPath, "x".repeat(64 * 1_024 + 1));
    await expect(files.load()).rejects.toThrow(/too large/u);
    expect((await readFile(files.manifestPath)).byteLength).toBeGreaterThan(64 * 1_024);
  });

  it("durably creates stable identity and private managed directories", async () => {
    const root = await temporaryDirectory();
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: path.join(root, "data"),
      minimumFreeBytes: 0,
    });
    const input = manifest(path.join(root, "Opensteer", "Workspaces"));
    const created = await files.create(input);
    expect(await files.create({ ...input, deploymentId: createId("deployment") })).toEqual(created);
    expect(await files.load()).toEqual(created);

    const paths = await files.prepare(created);
    expect(paths.workspaceRoot).toBe(input.workspaceRoot);
    for (const directory of [
      paths.browserProfileRoot,
      paths.rootDirectory,
      paths.hostDataDirectory,
      paths.postgresDataDirectory,
      paths.runnerDataDirectory,
      paths.workspaceRoot,
    ]) {
      const metadata = await lstat(directory);
      expect(metadata.isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(metadata.mode & 0o077).toBe(0);
    }
    expect(await files.inspectDatabase(created)).toBe("empty");
    await writeFile(path.join(paths.postgresDataDirectory, "PG_VERSION"), "17\n");
    expect(await files.inspectDatabase(created)).toBe("initialized");
    await writeFile(path.join(paths.postgresDataDirectory, "PG_VERSION"), "16\n");
    expect(await files.inspectDatabase(created)).toBe("inconsistent");
  });

  it("allows monotonic state changes but rejects identity changes and stale writes", async () => {
    const root = await temporaryDirectory();
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: path.join(root, "data"),
      minimumFreeBytes: 0,
    });
    const created = await files.create(manifest(path.join(root, "Workspaces")));
    const advanced = PersonalDeploymentManifestSchema.parse({
      ...created,
      databaseInitialized: true,
      revision: 1,
      updatedAt: "2026-08-12T12:00:01.000Z",
    });
    await expect(files.save(created, advanced)).resolves.toEqual(advanced);
    await expect(files.save(created, advanced)).rejects.toThrow(/changed concurrently/u);
    await expect(
      files.save(advanced, {
        ...advanced,
        environmentId: createId("environment"),
        revision: 2,
        updatedAt: "2026-08-12T12:00:02.000Z",
      }),
    ).rejects.toThrow(/environmentId is immutable/u);
  });

  it("commits only forward, same-platform, same-PostgreSQL-major runtime updates", async () => {
    const root = await temporaryDirectory();
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: path.join(root, "data"),
      minimumFreeBytes: 0,
    });
    const created = await files.create(manifest(path.join(root, "Workspaces")));
    const nextRelease = {
      ...created.release,
      hostVersion: "1.2.4",
      manifestSha256: "b".repeat(64),
      postgresVersion: "17.5.0",
      runnerVersion: "2.4.0",
    };
    const updated = await files.commitCompatibleRelease(
      created,
      nextRelease,
      "2026-08-12T12:00:01.000Z",
    );
    expect(updated).toMatchObject({ release: nextRelease, revision: 1 });
    await expect(
      files.save(updated, {
        ...updated,
        release: { ...updated.release, hostVersion: "1.2.5" },
        revision: 2,
        updatedAt: "2026-08-12T12:00:02.000Z",
      }),
    ).rejects.toThrow(/update transaction/u);
    await expect(
      files.commitCompatibleRelease(
        updated,
        { ...updated.release, runnerVersion: "2.3.9" },
        "2026-08-12T12:00:02.000Z",
      ),
    ).rejects.toThrow(/cannot move backward/u);
    await expect(
      files.commitCompatibleRelease(
        updated,
        {
          ...updated.release,
          manifestSha256: "c".repeat(64),
          postgresMajor: 18,
          postgresVersion: "18.1.0",
        },
        "2026-08-12T12:00:02.000Z",
      ),
    ).rejects.toThrow(/PostgreSQL major/u);
  });

  it("rejects a symlinked manifest and a symlinked managed directory", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = path.join(root, "data");
    const files = new NativePersonalDeploymentFilesystem({ dataDirectory, minimumFreeBytes: 0 });
    const outside = path.join(root, "outside.json");
    await writeFile(outside, "{}\n");
    await rm(dataDirectory, { force: true, recursive: true });
    await writeFile(path.join(root, "placeholder"), "x");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dataDirectory));
    await symlink(outside, files.manifestPath);
    await expect(files.load()).rejects.toThrow(/real regular file/u);

    await rm(files.manifestPath);
    const created = await files.create(manifest(path.join(root, "Workspaces")));
    const paths = await files.prepare(created);
    await rm(paths.runnerDataDirectory, { recursive: true });
    await symlink(root, paths.runnerDataDirectory);
    await expect(files.prepare(created)).rejects.toThrow(/real directory/u);
    if (process.platform !== "win32") await chmod(dataDirectory, 0o700);
  });
});

describe("a managed directory that cannot be prepared", () => {
  it.each(["EIO", "ENOSPC", "EMFILE"])("leaves %s to be retried", async (code) => {
    const { created, files } = await createdDeployment();
    const failure = Object.assign(new Error(`${code}: mkdir`), { code, syscall: "mkdir" });
    directories.failure = failure;

    // Failure mode: a fault that can pass stops recovery for good as an
    // invalid directory, telling the person to restore permissions.
    await expect(files.prepare(created)).rejects.toBe(failure);
  });

  it("names EPERM changing the directory's mode as invalid", async () => {
    const { created, files } = await createdDeployment();
    directories.failure = Object.assign(new Error("EPERM: chmod"), {
      code: "EPERM",
      syscall: "chmod",
    });

    await expect(files.prepare(created)).rejects.toMatchObject({
      code: "directory-invalid",
      cause: { code: "EPERM" },
    });
  });

  it.each([
    ["a file inside its path", { code: "ENOTDIR" }],
    ["a file where it belongs", { code: "EEXIST" }],
    ["a symlink where it belongs", { message: "not a real directory" }],
    ["a parent it may not write", { code: "EACCES" }],
  ] as const)("names %s as invalid", async (shape, cause) => {
    const root = await temporaryDirectory();
    const blocker = path.join(root, "blocker");
    if (shape === "a parent it may not write") await mkdir(blocker, { mode: 0o500 });
    else if (shape === "a symlink where it belongs") await symlink(root, blocker);
    else await writeFile(blocker, "x");
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: path.join(root, "data"),
      minimumFreeBytes: 0,
    });
    const created = await files.create(
      manifest(
        shape === "a file inside its path" || shape === "a parent it may not write"
          ? path.join(blocker, "Opensteer", "Workspaces")
          : blocker,
      ),
    );

    try {
      const error = await files.prepare(created).catch((reason: unknown) => reason);
      // Failure mode: a directory the person must repair is retried forever.
      expect(error).toBeInstanceOf(PersonalFilesystemError);
      expect(error).toMatchObject({ code: "directory-invalid", cause });
    } finally {
      if (shape === "a parent it may not write") await chmod(blocker, 0o700);
    }
  });
});

describe("defaultPersonalDeploymentName", () => {
  it("names the deployment after its computer and drops the suffixes a network adds", () => {
    expect(defaultPersonalDeploymentName("Mac mini")).toBe("Mac mini");
    expect(defaultPersonalDeploymentName("Mac-mini.local")).toBe("Mac-mini");
    expect(defaultPersonalDeploymentName("workshop.LAN")).toBe("workshop");
    expect(defaultPersonalDeploymentName("desk.localdomain.")).toBe("desk");
    expect(defaultPersonalDeploymentName("  MacBook Pro  ")).toBe("MacBook Pro");
    expect(defaultPersonalDeploymentName("a".repeat(200))).toBe("a".repeat(120));
  });

  it("falls back to a generic name only when the computer has no hostname at all", () => {
    expect(defaultPersonalDeploymentName("")).toBe("My computer");
    expect(defaultPersonalDeploymentName("   .local")).toBe("My computer");
    // Whatever this machine is called, the name is one a manifest can hold.
    const derived = defaultPersonalDeploymentName();
    expect(derived).not.toBe("This computer");
    expect(derived.trim()).toBe(derived);
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.length).toBeLessThanOrEqual(120);
  });
});

async function createdDeployment() {
  const root = await temporaryDirectory();
  const files = new NativePersonalDeploymentFilesystem({
    dataDirectory: path.join(root, "data"),
    minimumFreeBytes: 0,
  });
  const created = await files.create(manifest(path.join(root, "Workspaces")));
  return { created, files };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-personal-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function manifest(workspaceRoot: string): Omit<PersonalDeploymentManifest, "revision"> {
  return {
    createdAt: "2026-08-12T12:00:00.000Z",
    databaseInitialized: false,
    deploymentId: createId("deployment"),
    environmentId: createId("environment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: null,
    hostPort: 4310,
    name: "This computer",
    ownerInitialized: false,
    postgresPort: 5432,
    release: {
      architecture: "arm64",
      hostVersion: "1.2.3",
      manifestSha256: "a".repeat(64),
      operatingSystem: "darwin",
      postgresMajor: 17,
      postgresVersion: "17.4.0",
      runnerVersion: "2.3.4",
    },
    runnerId: createId("runner"),
    schemaVersion: 3,
    setupIntentId: "019ff6c2-309a-7380-9093-e126eb2bda4b",
    updatedAt: "2026-08-12T12:00:00.000Z",
    workspaceRoot: path.resolve(workspaceRoot),
  };
}
