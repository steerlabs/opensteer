import {
  DeploymentIdSchema,
  EnvironmentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
  IsoDateTimeSchema,
  RunnerIdSchema,
} from "@opensteer/core";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import {
  ensurePrivateDirectory as ensureSharedPrivateDirectory,
  noFollowFlag,
  setPrivateFileMode,
} from "@opensteer/shared/privateFiles";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  desktopDeploymentPaths,
  prepareDesktopDeploymentDirectories,
  preparePrivateDesktopDeploymentDirectories,
  type DesktopDeploymentPaths,
} from "../app/application-paths.js";
import { snapshotDatabase } from "../supervisor/personal-database-snapshot.js";
import type { DesktopPrivateFilesystem } from "./desktop-private-files.js";

const RuntimeVersionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u);

export const PersonalRuntimeIdentitySchema = z.strictObject({
  architecture: z.enum(["amd64", "arm64"]),
  hostVersion: RuntimeVersionSchema,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  operatingSystem: z.enum(["darwin", "linux", "win32"]),
  postgresMajor: z.number().int().min(14).max(99),
  postgresVersion: RuntimeVersionSchema,
  runnerVersion: RuntimeVersionSchema,
});
export type PersonalRuntimeIdentity = z.infer<typeof PersonalRuntimeIdentitySchema>;

/**
 * A Personal Deployment is a computer, so it is named after that computer: the
 * name its owner already gave it and already recognizes in every other list of
 * their machines. The suffixes a network adds ("Mac mini.local") are the
 * network's, not the name's, so they come off. Only a machine with no hostname
 * at all falls back to a generic name, and it can be renamed like any other.
 */
export function defaultPersonalDeploymentName(hostname = os.hostname()): string {
  const prettified = hostname
    .trim()
    .replace(/\.(?:local|lan|localdomain)\.?$/iu, "")
    .trim()
    .slice(0, 120)
    .trim();
  return prettified === "" ? unnamedPersonalDeploymentName : prettified;
}

const unnamedPersonalDeploymentName = "My computer";
/** What releases before hostname naming called every Personal Deployment. */
const retiredPersonalDeploymentName = "This computer";

/**
 * Whether this name is one Opensteer made up rather than one a person chose.
 * Only such a name gives way to the Mac's own name; a name somebody typed,
 * here or in their Account, is never overwritten.
 */
export function isGeneratedPersonalDeploymentName(name: string, hostname = os.hostname()): boolean {
  return (
    name === retiredPersonalDeploymentName ||
    name === unnamedPersonalDeploymentName ||
    name === defaultPersonalDeploymentName(hostname)
  );
}

const personalDeploymentManifestFields = {
  createdAt: IsoDateTimeSchema,
  databaseInitialized: z.boolean(),
  deploymentId: DeploymentIdSchema,
  environmentId: EnvironmentIdSchema,
  hostInstanceId: HostInstanceIdSchema,
  hostKeyFingerprint: HostKeyFingerprintSchema.nullable(),
  hostPort: z.number().int().min(1_024).max(65_535),
  ownerInitialized: z.boolean(),
  postgresPort: z.number().int().min(1_024).max(65_535),
  release: PersonalRuntimeIdentitySchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  runnerId: RunnerIdSchema,
  setupIntentId: z.uuid(),
  updatedAt: IsoDateTimeSchema,
  workspaceRoot: z.string().min(1).max(4_096),
};

export const PersonalDeploymentManifestSchema = z
  .strictObject({
    ...personalDeploymentManifestFields,
    name: z.string().trim().min(1).max(120),
    schemaVersion: z.literal(3),
  })
  .superRefine(refinePersonalDeploymentManifest);
export type PersonalDeploymentManifest = z.infer<typeof PersonalDeploymentManifestSchema>;

function refinePersonalDeploymentManifest(
  manifest: {
    readonly createdAt: string;
    readonly hostPort: number;
    readonly postgresPort: number;
    readonly updatedAt: string;
    readonly workspaceRoot: string;
  },
  context: z.RefinementCtx,
): void {
  if (!path.isAbsolute(manifest.workspaceRoot)) {
    context.addIssue({
      code: "custom",
      message: "Personal Workspace root must be absolute",
      path: ["workspaceRoot"],
    });
  }
  if (manifest.hostPort === manifest.postgresPort) {
    context.addIssue({
      code: "custom",
      message: "Host and PostgreSQL require different loopback ports",
      path: ["hostPort"],
    });
  }
  if (Date.parse(manifest.updatedAt) < Date.parse(manifest.createdAt)) {
    context.addIssue({
      code: "custom",
      message: "Personal manifest updatedAt cannot precede createdAt",
      path: ["updatedAt"],
    });
  }
}

export interface PersonalDeploymentPreparedPaths extends DesktopDeploymentPaths {
  readonly browserProfileRoot: string;
  readonly credentialKeyPath: string;
  readonly hostPrivateKeyPath: string;
  readonly hostPublicKeyPath: string;
  /** The messaging service's own Runner identity and data directory lease. */
  readonly messagingDataDirectory: string;
  readonly postgresLogPath: string;
  readonly workspaceRegistryPath: string;
  readonly workspaceRoot: string;
}

export interface PersonalDeploymentFilesystemPort {
  commitCompatibleRelease(
    previous: PersonalDeploymentManifest,
    release: PersonalRuntimeIdentity,
    updatedAt: string,
  ): Promise<PersonalDeploymentManifest>;
  create(input: Omit<PersonalDeploymentManifest, "revision">): Promise<PersonalDeploymentManifest>;
  load(): Promise<PersonalDeploymentManifest | null>;
  inspectDatabase(
    manifest: PersonalDeploymentManifest,
  ): Promise<"empty" | "initialized" | "inconsistent">;
  /**
   * Copies the stopped cluster before `toRelease` first runs on it; resolves
   * to the snapshot's name. See `snapshotDatabase` for the copy itself.
   */
  snapshotDatabase(
    manifest: PersonalDeploymentManifest,
    toRelease: PersonalRuntimeIdentity,
    createdAt: Date,
  ): Promise<string>;
  /**
   * initdb only reads the bootstrap superuser password from a real file, so
   * the secret is staged as an owner-only file inside the deployment's
   * private directory for exactly the duration of initialization.
   */
  stageDatabaseInitPassword(
    manifest: PersonalDeploymentManifest,
    password: string,
  ): Promise<string>;
  discardDatabaseInitPassword(manifest: PersonalDeploymentManifest): Promise<void>;
  prepare(manifest: PersonalDeploymentManifest): Promise<PersonalDeploymentPreparedPaths>;
  save(
    previous: PersonalDeploymentManifest,
    next: PersonalDeploymentManifest,
  ): Promise<PersonalDeploymentManifest>;
}

const maximumManifestBytes = 64 * 1_024;
const minimumPersonalFreeBytes = 512 * 1_024 * 1_024;

export class NativePersonalDeploymentFilesystem implements PersonalDeploymentFilesystemPort {
  readonly #dataDirectory: string;
  readonly #manifestPath: string;
  readonly #minimumFreeBytes: number;
  readonly #privateFiles: DesktopPrivateFilesystem | undefined;
  readonly #mutations = new MutationQueue();

  constructor(options: {
    readonly dataDirectory: string;
    readonly minimumFreeBytes?: number;
    readonly privateFiles?: DesktopPrivateFilesystem;
  }) {
    this.#dataDirectory = path.resolve(options.dataDirectory);
    this.#manifestPath = path.join(this.#dataDirectory, "personal-deployment.v1.json");
    this.#minimumFreeBytes = options.minimumFreeBytes ?? minimumPersonalFreeBytes;
    this.#privateFiles = options.privateFiles;
    if (!Number.isSafeInteger(this.#minimumFreeBytes) || this.#minimumFreeBytes < 0) {
      throw new TypeError("Personal deployment free-space threshold must be non-negative.");
    }
  }

  get manifestPath(): string {
    return this.#manifestPath;
  }

  /** Ownership-critical state is accepted only when the current schema validates it. */
  load(): Promise<PersonalDeploymentManifest | null> {
    return this.#mutations.run(() => this.#load());
  }

  async #load(): Promise<PersonalDeploymentManifest | null> {
    let content: string;
    if (this.#privateFiles) {
      const bytes = await this.#privateFiles.readFile(this.#manifestPath, maximumManifestBytes);
      if (!bytes) return null;
      content = bytes.toString("utf8");
    } else {
      let metadata;
      try {
        metadata = await lstat(this.#manifestPath);
      } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") return null;
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("Personal deployment manifest must be a real regular file.");
      }
      if (metadata.size > maximumManifestBytes) {
        throw new Error("Personal deployment manifest is too large.");
      }
      content = await readFile(this.#manifestPath, "utf8");
    }
    const parsed = parsePersonalDeploymentManifest(content);
    if (!parsed) return null;
    if (parsed.migrated) {
      if (this.#privateFiles) {
        await this.#privateFiles.writeFileAtomic(
          this.#manifestPath,
          serializedJson(parsed.manifest),
        );
      } else {
        await writeAtomicJson(this.#manifestPath, parsed.manifest);
      }
    }
    return parsed.manifest;
  }

  async inspectDatabase(
    manifestInput: PersonalDeploymentManifest,
  ): Promise<"empty" | "initialized" | "inconsistent"> {
    const manifest = PersonalDeploymentManifestSchema.parse(manifestInput);
    const directory = desktopDeploymentPaths(
      this.#dataDirectory,
      manifest.deploymentId,
    ).postgresDataDirectory;
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return "empty";
      throw error;
    }
    if (entries.length === 0) return "empty";
    const versionPath = path.join(directory, "PG_VERSION");
    try {
      const metadata = await lstat(versionPath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 32) {
        return "inconsistent";
      }
      const major = (await readFile(versionPath, "utf8")).trim();
      return major === String(manifest.release.postgresMajor) ? "initialized" : "inconsistent";
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return "inconsistent";
      throw error;
    }
  }

  async snapshotDatabase(
    manifestInput: PersonalDeploymentManifest,
    toRelease: PersonalRuntimeIdentity,
    createdAt: Date,
  ): Promise<string> {
    const manifest = PersonalDeploymentManifestSchema.parse(manifestInput);
    const paths = desktopDeploymentPaths(this.#dataDirectory, manifest.deploymentId);
    return snapshotDatabase({
      createdAt,
      dataDirectory: paths.postgresDataDirectory,
      deploymentRoot: paths.rootDirectory,
      fromRelease: manifest.release,
      toRelease: PersonalRuntimeIdentitySchema.parse(toRelease),
    });
  }

  async stageDatabaseInitPassword(
    manifestInput: PersonalDeploymentManifest,
    password: string,
  ): Promise<string> {
    const manifest = PersonalDeploymentManifestSchema.parse(manifestInput);
    if (!password || /[\r\n]/u.test(password)) {
      throw new Error("The PostgreSQL bootstrap password must be a single non-empty line.");
    }
    const filePath = this.#databaseInitPasswordPath(manifest);
    const content = `${password}\n`;
    if (this.#privateFiles) {
      await this.#privateFiles.ensureDirectory(path.dirname(filePath));
      await this.#privateFiles.writeFileAtomic(filePath, content);
    } else {
      await ensurePersonalDirectory(path.dirname(filePath));
      await writeAtomicText(filePath, content);
    }
    return filePath;
  }

  async discardDatabaseInitPassword(manifestInput: PersonalDeploymentManifest): Promise<void> {
    const manifest = PersonalDeploymentManifestSchema.parse(manifestInput);
    const filePath = this.#databaseInitPasswordPath(manifest);
    if (this.#privateFiles) {
      await this.#privateFiles.removeFile(filePath);
    } else {
      await rm(filePath, { force: true });
    }
  }

  #databaseInitPasswordPath(manifest: PersonalDeploymentManifest): string {
    return path.join(
      desktopDeploymentPaths(this.#dataDirectory, manifest.deploymentId).temporaryDirectory,
      "initdb-password",
    );
  }

  create(input: Omit<PersonalDeploymentManifest, "revision">): Promise<PersonalDeploymentManifest> {
    return this.#mutations.run(async () => {
      const existing = await this.#load();
      if (existing) return existing;
      const manifest = PersonalDeploymentManifestSchema.parse({ ...input, revision: 0 });
      if (this.#privateFiles) {
        await this.#privateFiles.writeFileExclusive(this.#manifestPath, serializedJson(manifest));
      } else {
        await ensurePersonalDirectory(this.#dataDirectory);
        await writeExclusiveJson(this.#manifestPath, manifest);
      }
      return manifest;
    });
  }

  commitCompatibleRelease(
    previous: PersonalDeploymentManifest,
    releaseInput: PersonalRuntimeIdentity,
    updatedAt: string,
  ): Promise<PersonalDeploymentManifest> {
    return this.#mutations.run(async () => {
      const expected = PersonalDeploymentManifestSchema.parse(previous);
      const release = PersonalRuntimeIdentitySchema.parse(releaseInput);
      assertCompatibleRuntimeTransition(expected.release, release);
      const candidate = PersonalDeploymentManifestSchema.parse({
        ...expected,
        release,
        revision: expected.revision + 1,
        updatedAt,
      });
      assertStableIdentity(expected, candidate, true);
      const current = await this.#load();
      if (!current || current.revision !== expected.revision) {
        throw new Error("Personal deployment manifest changed concurrently.");
      }
      if (this.#privateFiles) {
        await this.#privateFiles.writeFileAtomic(this.#manifestPath, serializedJson(candidate));
      } else {
        await writeAtomicJson(this.#manifestPath, candidate);
      }
      return candidate;
    });
  }

  save(
    previous: PersonalDeploymentManifest,
    next: PersonalDeploymentManifest,
  ): Promise<PersonalDeploymentManifest> {
    return this.#mutations.run(async () => {
      const expected = PersonalDeploymentManifestSchema.parse(previous);
      const candidate = PersonalDeploymentManifestSchema.parse(next);
      assertStableIdentity(expected, candidate, false);
      if (candidate.revision !== expected.revision + 1) {
        throw new Error("Personal deployment manifest revision did not advance exactly once.");
      }
      const current = await this.#load();
      if (!current || current.revision !== expected.revision) {
        throw new Error("Personal deployment manifest changed concurrently.");
      }
      if (this.#privateFiles) {
        await this.#privateFiles.writeFileAtomic(this.#manifestPath, serializedJson(candidate));
      } else {
        await writeAtomicJson(this.#manifestPath, candidate);
      }
      return candidate;
    });
  }

  async prepare(
    manifestInput: PersonalDeploymentManifest,
  ): Promise<PersonalDeploymentPreparedPaths> {
    const manifest = PersonalDeploymentManifestSchema.parse(manifestInput);
    const workspaceRoot = path.resolve(manifest.workspaceRoot);
    if (workspaceRoot !== manifest.workspaceRoot) {
      throw new Error("Personal Workspace root must already be normalized.");
    }
    const paths = this.#privateFiles
      ? await preparePrivateDesktopDeploymentDirectories(
          this.#privateFiles,
          this.#dataDirectory,
          manifest.deploymentId,
        )
      : prepareDesktopDeploymentDirectories(this.#dataDirectory, manifest.deploymentId);
    await ensurePersonalDirectory(paths.rootDirectory);
    await ensurePersonalDirectory(paths.hostDataDirectory);
    await ensurePersonalDirectory(paths.postgresDataDirectory);
    await ensurePersonalDirectory(paths.runnerDataDirectory);
    const messagingDataDirectory = path.join(paths.rootDirectory, "channel-runtime");
    await ensurePersonalDirectory(messagingDataDirectory);
    await ensurePersonalDirectory(paths.logsDirectory);
    await ensurePersonalDirectory(path.dirname(workspaceRoot));
    await ensurePersonalDirectory(workspaceRoot);
    const available = await availableBytes(paths.rootDirectory);
    if (available < this.#minimumFreeBytes) {
      throw new PersonalFilesystemError(
        "disk-space-insufficient",
        `This computer needs at least ${this.#minimumFreeBytes} bytes free to prepare Opensteer.`,
      );
    }
    const derived = desktopDeploymentPaths(this.#dataDirectory, manifest.deploymentId);
    if (derived.rootDirectory !== paths.rootDirectory) {
      throw new Error("Personal deployment paths changed while they were prepared.");
    }
    return {
      ...paths,
      browserProfileRoot: paths.browserProfilesDirectory,
      credentialKeyPath: path.join(paths.hostDataDirectory, "credentials.key"),
      hostPrivateKeyPath: path.join(paths.hostDataDirectory, "host-private.pem"),
      hostPublicKeyPath: path.join(paths.hostDataDirectory, "host-public.pem"),
      messagingDataDirectory,
      postgresLogPath: path.join(paths.logsDirectory, "postgresql.log"),
      // The protected registry belongs to the process that owns the disk,
      // which is now the co-located Runner rather than the Host.
      workspaceRegistryPath: path.join(paths.runnerDataDirectory, "workspace-bindings.v1.json"),
      workspaceRoot,
    };
  }
}

function parsePersonalDeploymentManifest(
  serialized: string,
): { readonly manifest: PersonalDeploymentManifest; readonly migrated: boolean } | null {
  try {
    const value: unknown = JSON.parse(serialized);
    const current = PersonalDeploymentManifestSchema.safeParse(value);
    if (current.success) return { manifest: current.data, migrated: false };
    const prior = z
      .strictObject({
        ...personalDeploymentManifestFields,
        authorityEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        name: z.string().trim().min(1).max(120),
        schemaVersion: z.literal(2),
      })
      .superRefine(refinePersonalDeploymentManifest)
      .parse(value);
    const { authorityEpoch: _authorityEpoch, ...identity } = prior;
    return {
      manifest: PersonalDeploymentManifestSchema.parse({ ...identity, schemaVersion: 3 }),
      migrated: true,
    };
  } catch {
    return null;
  }
}

export class PersonalFilesystemError extends Error {
  readonly code: "disk-space-insufficient" | "directory-invalid";

  constructor(code: PersonalFilesystemError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersonalFilesystemError";
    this.code = code;
  }
}

function assertStableIdentity(
  previous: PersonalDeploymentManifest,
  next: PersonalDeploymentManifest,
  allowReleaseChange: boolean,
): void {
  for (const key of [
    "createdAt",
    "deploymentId",
    "environmentId",
    "hostInstanceId",
    "hostPort",
    "postgresPort",
    "runnerId",
    "schemaVersion",
    "setupIntentId",
    "workspaceRoot",
  ] as const) {
    if (previous[key] !== next[key]) {
      throw new Error(`Personal deployment identity field ${key} is immutable.`);
    }
  }
  if (
    previous.hostKeyFingerprint !== null &&
    previous.hostKeyFingerprint !== next.hostKeyFingerprint
  ) {
    throw new Error("Personal Host signing key fingerprint is immutable once recorded.");
  }
  if (!allowReleaseChange && JSON.stringify(previous.release) !== JSON.stringify(next.release)) {
    throw new Error("Personal runtime release can change only through its update transaction.");
  }
  if (previous.databaseInitialized && !next.databaseInitialized) {
    throw new Error("Personal database initialization cannot move backward.");
  }
  if (previous.ownerInitialized && !next.ownerInitialized) {
    throw new Error("Personal owner initialization cannot move backward.");
  }
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new Error("Personal deployment manifest time cannot move backward.");
  }
}

function assertCompatibleRuntimeTransition(
  previous: PersonalRuntimeIdentity,
  next: PersonalRuntimeIdentity,
): void {
  if (
    previous.operatingSystem !== next.operatingSystem ||
    previous.architecture !== next.architecture ||
    previous.postgresMajor !== next.postgresMajor
  ) {
    throw new PersonalRuntimeTransitionError(
      "Personal runtime updates must retain the operating system, architecture, and PostgreSQL major version.",
    );
  }
  for (const [label, before, after] of [
    ["Host", previous.hostVersion, next.hostVersion],
    ["Runner", previous.runnerVersion, next.runnerVersion],
    ["PostgreSQL", previous.postgresVersion, next.postgresVersion],
  ] as const) {
    if (compareVersions(after, before) < 0) {
      throw new PersonalRuntimeTransitionError(
        `Personal ${label} runtime updates cannot move backward.`,
      );
    }
  }
}

export class PersonalRuntimeTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonalRuntimeTransitionError";
  }
}

function compareVersions(left: string, right: string): number {
  const parsedLeft = versionParts(left);
  const parsedRight = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = parsedLeft.core[index]! - parsedRight.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (parsedLeft.prerelease.length === 0) return parsedRight.prerelease.length === 0 ? 0 : 1;
  if (parsedRight.prerelease.length === 0) return -1;
  const maximum = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < maximum; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^(0|[1-9][0-9]*)$/u.test(leftPart);
    const rightNumeric = /^(0|[1-9][0-9]*)$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function versionParts(value: string): { readonly core: number[]; readonly prerelease: string[] } {
  const [core, prerelease = ""] = RuntimeVersionSchema.parse(value).split("-", 2);
  return {
    core: core!.split(".").map(Number),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

async function writeExclusiveJson(filePath: string, value: unknown): Promise<void> {
  const serialized = serializedJson(value);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await writeAtomicText(filePath, serializedJson(value));
}

async function writeAtomicText(filePath: string, serialized: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await setPrivateFileMode(filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function serializedJson(value: unknown): string {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maximumManifestBytes) {
    throw new Error("Personal deployment manifest is too large.");
  }
  return serialized;
}

/**
 * What is wrong with the directory itself, or with who may use it, and so
 * waits for the person. Any other failure (a failing or full disk, too many
 * open files) can pass and is retried like any other.
 */
const invalidDirectoryCodes = new Set(["EACCES", "EEXIST", "ELOOP", "ENOTDIR", "EPERM", "EROFS"]);

async function ensurePersonalDirectory(directory: string): Promise<void> {
  try {
    await ensureSharedPrivateDirectory(directory, "not a real directory");
  } catch (error) {
    const code = nodeErrorCode(error);
    // Without an errno code, the helper found a symlink or a non-directory.
    if (code !== undefined && !invalidDirectoryCodes.has(code)) throw error;
    throw new PersonalFilesystemError(
      "directory-invalid",
      `Opensteer cannot safely use its managed directory: ${directory}`,
      { cause: error },
    );
  }
}

async function availableBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  const value = BigInt(stats.bavail) * BigInt(stats.bsize);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}
