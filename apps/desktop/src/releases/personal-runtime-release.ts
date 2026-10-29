import { harnessCatalog, shippedHarnessKindRecord, type ShippedHarnessKind } from "@opensteer/core";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { noFollowFlag } from "@opensteer/shared/privateFiles";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { arch as hostArchitecture, platform as hostPlatform } from "node:os";
import path from "node:path";
import { z } from "zod";

const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), "Artifact paths must not have outer whitespace")
  .refine((value) => !path.posix.isAbsolute(value), "Artifact paths must be relative")
  .refine((value) => !value.includes("\\"), "Artifact paths must use forward slashes")
  .refine(
    (value) =>
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Artifact paths must contain only concrete path segments",
  );

const StableVersionSchema = z
  .string()
  .max(120)
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u);
const maximumArtifactBytes = 1 * 1_024 * 1_024 * 1_024;
const maximumArchitectureHeaderBytes = 64 * 1_024;
const maximumReleaseEntries = 4_096;

/**
 * What each shipped engine's runtime is, in the manifest's own vocabulary: a
 * platform executable for the engines that ship one, code for the engine that
 * ships a Node program instead.
 */
const harnessArtifactModes: Record<ShippedHarnessKind, "code" | "executable"> =
  shippedHarnessKindRecord((kind) => {
    const runtime = harnessCatalog.find((entry) => entry.kind === kind)?.runtime;
    return runtime?.shape === "script" ? "code" : "executable";
  });

export const PersonalRuntimeReleaseManifestSchema = z
  .strictObject({
    architecture: z.enum(["amd64", "arm64"]),
    assets: z.strictObject({
      agentSkills: RelativeArtifactPathSchema,
      webDistribution: z.strictObject({
        directory: RelativeArtifactPathSchema,
        hostVersion: StableVersionSchema,
        manifest: RelativeArtifactPathSchema,
      }),
    }),
    entrypoints: z.strictObject({
      browserHarness: RelativeArtifactPathSchema,
      channelRuntime: RelativeArtifactPathSchema,
      host: RelativeArtifactPathSchema,
      initdb: RelativeArtifactPathSchema,
      nativeFsHelper: RelativeArtifactPathSchema,
      node: RelativeArtifactPathSchema,
      pgIsReady: RelativeArtifactPathSchema,
      postgres: RelativeArtifactPathSchema,
      runner: RelativeArtifactPathSchema,
    }),
    files: z
      .array(
        z.strictObject({
          mode: z.enum(["data", "executable", "code"]),
          path: RelativeArtifactPathSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        }),
      )
      .min(6)
      .max(2_048),
    /**
     * The harness runtimes the Runner spawns, exactly one per engine whose
     * bytes this distribution ships — an enum-keyed record admits no other key
     * and demands every one. The distribution that ships the bytes names them,
     * so no driver resolves a package or searches PATH. An `installed` engine
     * is absent because nothing here ships it: the Runner finds the one the
     * person installed.
     */
    // Strip retired runtime keys so the previous release's receipt remains readable.
    harnesses: z.object(shippedHarnessKindRecord(() => RelativeArtifactPathSchema)),
    hostVersion: StableVersionSchema,
    operatingSystem: z.enum(["darwin", "linux", "win32"]),
    postgresMajor: z.number().int().min(14).max(99),
    postgresVersion: StableVersionSchema,
    runnerVersion: StableVersionSchema,
    schemaVersion: z.literal(7),
  })
  .superRefine((manifest, context) => {
    const files = new Map<string, (typeof manifest.files)[number]>();
    for (const [index, file] of manifest.files.entries()) {
      if (files.has(file.path)) {
        context.addIssue({
          code: "custom",
          message: "A Personal runtime artifact may appear only once",
          path: ["files", index, "path"],
        });
      }
      files.set(file.path, file);
    }
    for (const [name, entrypoint] of Object.entries(manifest.entrypoints)) {
      if (files.get(entrypoint)?.mode !== "executable") {
        context.addIssue({
          code: "custom",
          message: `Personal runtime entrypoint ${name} must reference an executable artifact`,
          path: ["entrypoints", name],
        });
      }
    }
    for (const [name, harness] of Object.entries(manifest.harnesses)) {
      // An engine published as JavaScript is a program the bundle's own Node
      // interpreter reads, not machine code for this architecture, so its
      // artifact is code and the architecture check below leaves it alone.
      const expected = harnessArtifactModes[name as ShippedHarnessKind];
      if (files.get(harness)?.mode !== expected) {
        context.addIssue({
          code: "custom",
          message: `Personal runtime harness ${name} must reference a ${expected} artifact`,
          path: ["harnesses", name],
        });
      }
    }
    const agentSkillsPrefix = `${manifest.assets.agentSkills}/`;
    if (files.get(`${agentSkillsPrefix}plugin.json`)?.mode !== "data") {
      context.addIssue({
        code: "custom",
        message: "Personal runtime agent skills must include a data-only plugin manifest",
        path: ["assets", "agentSkills"],
      });
    }
    if (
      ![...files.values()].some(
        (file) =>
          file.mode === "data" &&
          file.path.startsWith(`${agentSkillsPrefix}skills/`) &&
          file.path.endsWith("/SKILL.md"),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Personal runtime agent skills must include at least one Skill",
        path: ["assets", "agentSkills"],
      });
    }
    const web = manifest.assets.webDistribution;
    const webPrefix = `${web.directory}/`;
    if (
      !web.manifest.startsWith(webPrefix) ||
      files.get(web.manifest)?.mode !== "data" ||
      files.get(`${webPrefix}index.html`)?.mode !== "data"
    ) {
      context.addIssue({
        code: "custom",
        message: "Personal runtime Web distribution must declare its manifest and index",
        path: ["assets", "webDistribution"],
      });
    }
    if (web.hostVersion !== manifest.hostVersion) {
      context.addIssue({
        code: "custom",
        message: "Personal runtime Web distribution does not match its Host release",
        path: ["assets", "webDistribution"],
      });
    }
    const versionMajor = Number(manifest.postgresVersion.split(".", 1)[0]);
    if (versionMajor !== manifest.postgresMajor) {
      context.addIssue({
        code: "custom",
        message: "PostgreSQL version and major version do not match",
        path: ["postgresMajor"],
      });
    }
  });
export type PersonalRuntimeReleaseManifest = z.infer<typeof PersonalRuntimeReleaseManifestSchema>;

/**
 * The release as shipped cannot be used: an artifact is missing, it was built
 * for another Desktop or computer, or it is not what was signed. Anything else
 * the reader throws is the file system failing to read it (too many open
 * files, a full or failing disk), which can pass.
 */
export class PersonalRuntimeReleaseError extends Error {
  readonly kind: "incompatible" | "missing" | "tampered";

  constructor(kind: PersonalRuntimeReleaseError["kind"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersonalRuntimeReleaseError";
    this.kind = kind;
  }
}

const missing = (message: string, options?: ErrorOptions) =>
  new PersonalRuntimeReleaseError("missing", message, options);
const incompatible = (message: string, options?: ErrorOptions) =>
  new PersonalRuntimeReleaseError("incompatible", message, options);
const tampered = (message: string, options?: ErrorOptions) =>
  new PersonalRuntimeReleaseError("tampered", message, options);

export interface VerifiedPersonalRuntimeRelease {
  readonly assets: {
    readonly agentSkills: string;
    readonly webDistribution: {
      readonly directory: string;
      readonly hostVersion: string;
      readonly manifestPath: string;
    };
  };
  readonly directory: string;
  readonly entrypoints: {
    readonly browserHarness: string;
    readonly channelRuntime: string;
    readonly host: string;
    readonly initdb: string;
    readonly nativeFsHelper: string;
    readonly node: string;
    readonly pgIsReady: string;
    readonly postgres: string;
    readonly runner: string;
  };
  readonly harnesses: Record<ShippedHarnessKind, string>;
  readonly identity: {
    readonly architecture: "amd64" | "arm64";
    readonly hostVersion: string;
    readonly manifestSha256: string;
    readonly operatingSystem: "darwin" | "linux" | "win32";
    readonly postgresMajor: number;
    readonly postgresVersion: string;
    readonly runnerVersion: string;
  };
  readonly manifest: PersonalRuntimeReleaseManifest;
}

interface ReadPersonalRuntimeReleaseOptions {
  readonly architecture?: string;
  readonly operatingSystem?: NodeJS.Platform | string;
}

/**
 * Resolve only the complete runtime selected by the signed Desktop release.
 * There is no PATH lookup, source-tree executable, Docker, or system
 * PostgreSQL fallback.
 */
export async function readPersonalRuntimeRelease(
  releaseDirectory: string,
  options: ReadPersonalRuntimeReleaseOptions = {},
): Promise<VerifiedPersonalRuntimeRelease> {
  const directory = path.resolve(releaseDirectory);
  const rootMetadata = await lstat(directory).catch((error: unknown) => {
    throw absent(error, "Personal runtime release directory is missing.");
  });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw tampered("Personal runtime release directory must be a real directory.");
  }
  const manifestPath = path.join(directory, "release.json");
  const serialized = await readStableRegularFile(
    directory,
    manifestPath,
    "Personal runtime release manifest",
    512 * 1_024,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized.toString("utf8"));
  } catch (error) {
    throw tampered("Personal runtime release manifest is not valid JSON.", { cause: error });
  }
  let manifest: PersonalRuntimeReleaseManifest;
  try {
    manifest = PersonalRuntimeReleaseManifestSchema.parse(decoded);
  } catch (error) {
    throw incompatible("Personal runtime release manifest is incompatible with this Desktop.", {
      cause: error,
    });
  }
  const expectedOperatingSystem = normalizeOperatingSystem(
    options.operatingSystem ?? hostPlatform(),
  );
  const expectedArchitecture = normalizeArchitecture(options.architecture ?? hostArchitecture());
  if (
    manifest.operatingSystem !== expectedOperatingSystem ||
    manifest.architecture !== expectedArchitecture
  ) {
    throw incompatible(
      `Personal runtime release targets ${manifest.operatingSystem}/${manifest.architecture}, not ${expectedOperatingSystem}/${expectedArchitecture}.`,
    );
  }

  const actualFiles = await enumerateReleaseFiles(directory);
  const expectedFiles = new Set(["release.json", ...manifest.files.map(({ path }) => path)]);
  if (
    actualFiles.size !== expectedFiles.size ||
    [...actualFiles].some((artifact) => !expectedFiles.has(artifact))
  ) {
    const message = "Personal runtime release contains undeclared or missing artifacts.";
    throw [...expectedFiles].some((artifact) => !actualFiles.has(artifact))
      ? missing(message)
      : tampered(message);
  }
  // Only a platform executable has an architecture to check; a script
  // harness is read by the interpreter this same bundle ships.
  const machineCodeHarnesses = Object.fromEntries(
    Object.entries(manifest.harnesses).filter(
      ([kind]) => harnessArtifactModes[kind as ShippedHarnessKind] === "executable",
    ),
  );
  const programPaths = new Set([
    ...Object.values(manifest.entrypoints),
    ...Object.values(machineCodeHarnesses),
  ]);
  const programHeaders = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const artifactPath = resolveArtifactPath(directory, file.path);
    const verified = await verifyArtifactFile(
      directory,
      artifactPath,
      `Personal runtime artifact ${file.path}`,
      file.mode === "executable",
      expectedOperatingSystem,
    );
    if (verified.sha256 !== file.sha256) {
      throw tampered(`Personal runtime artifact ${file.path} failed release verification.`);
    }
    if (programPaths.has(file.path)) programHeaders.set(file.path, verified.header);
  }
  for (const [label, programs] of [
    ["entrypoint", manifest.entrypoints],
    ["harness", machineCodeHarnesses],
  ] as const) {
    for (const [name, program] of Object.entries(programs)) {
      const content = programHeaders.get(program);
      if (!content) throw missing(`Personal runtime ${label} ${name} is missing.`);
      const architectures = executableArchitectures(content, expectedOperatingSystem);
      if (!architectures.has(expectedArchitecture)) {
        throw tampered(
          `Personal runtime ${label} ${name} does not contain ${expectedArchitecture} code.`,
        );
      }
    }
  }

  return {
    assets: {
      agentSkills: resolveArtifactPath(directory, manifest.assets.agentSkills),
      webDistribution: {
        directory: resolveArtifactPath(directory, manifest.assets.webDistribution.directory),
        hostVersion: manifest.assets.webDistribution.hostVersion,
        manifestPath: resolveArtifactPath(directory, manifest.assets.webDistribution.manifest),
      },
    },
    directory,
    entrypoints: {
      browserHarness: resolveArtifactPath(directory, manifest.entrypoints.browserHarness),
      channelRuntime: resolveArtifactPath(directory, manifest.entrypoints.channelRuntime),
      host: resolveArtifactPath(directory, manifest.entrypoints.host),
      initdb: resolveArtifactPath(directory, manifest.entrypoints.initdb),
      nativeFsHelper: resolveArtifactPath(directory, manifest.entrypoints.nativeFsHelper),
      node: resolveArtifactPath(directory, manifest.entrypoints.node),
      pgIsReady: resolveArtifactPath(directory, manifest.entrypoints.pgIsReady),
      postgres: resolveArtifactPath(directory, manifest.entrypoints.postgres),
      runner: resolveArtifactPath(directory, manifest.entrypoints.runner),
    },
    harnesses: shippedHarnessKindRecord((kind) =>
      resolveArtifactPath(directory, manifest.harnesses[kind]),
    ),
    identity: {
      architecture: manifest.architecture,
      hostVersion: manifest.hostVersion,
      manifestSha256: createHash("sha256").update(serialized).digest("hex"),
      operatingSystem: manifest.operatingSystem,
      postgresMajor: manifest.postgresMajor,
      postgresVersion: manifest.postgresVersion,
      runnerVersion: manifest.runnerVersion,
    },
    manifest,
  };
}

export function resolveArtifactPath(directory: string, artifactPath: string): string {
  const relative = RelativeArtifactPathSchema.parse(artifactPath);
  const root = path.resolve(directory);
  const resolved = path.resolve(root, ...relative.split("/"));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw tampered("Personal runtime artifact escapes its signed release directory.");
  }
  return resolved;
}

async function readStableRegularFile(
  directory: string,
  candidate: string,
  label: string,
  maximumBytes: number,
): Promise<Buffer> {
  const before = await lstat(candidate).catch((error: unknown) => {
    throw absent(error, `${label} is missing from the Desktop release.`);
  });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw tampered(`${label} must be a real regular file.`);
  }
  if (before.size < 1 || before.size > maximumBytes) {
    throw tampered(`${label} has an invalid size.`);
  }
  const [realDirectory, realCandidate] = await Promise.all([
    realpath(directory),
    realpath(candidate),
  ]);
  if (!realCandidate.startsWith(`${realDirectory}${path.sep}`)) {
    throw tampered(`${label} resolves outside the Desktop release.`);
  }
  const handle = await open(candidate, constants.O_RDONLY | noFollowFlag());
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw tampered(`${label} changed while it was opened.`);
    }
    const content = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(content, offset, opened.size - offset, offset);
      if (bytesRead === 0) throw tampered(`${label} changed while it was read.`);
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw tampered(`${label} changed while it was verified.`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function enumerateReleaseFiles(directory: string): Promise<ReadonlySet<string>> {
  const files = new Set<string>();
  let entriesSeen = 0;
  const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) throw tampered("Personal runtime release directory is nested too deeply.");
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > maximumReleaseEntries) {
        throw tampered("Personal runtime release contains too many artifacts.");
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw tampered(`Personal runtime artifact ${relative} must not be a symbolic link.`);
      }
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relative, depth + 1);
      } else if (entry.isFile()) {
        files.add(relative);
      } else {
        throw tampered(`Personal runtime artifact ${relative} has an unsupported file type.`);
      }
    }
  };
  await walk(directory, "", 0);
  return files;
}

async function verifyArtifactFile(
  directory: string,
  candidate: string,
  label: string,
  executable: boolean,
  operatingSystem: "darwin" | "linux" | "win32",
): Promise<{ readonly header: Buffer; readonly sha256: string }> {
  const before = await lstat(candidate).catch((error: unknown) => {
    throw absent(error, `${label} is missing from the Desktop release.`);
  });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw tampered(`${label} must be a real regular file.`);
  }
  if (before.size < 1 || before.size > maximumArtifactBytes) {
    throw tampered(`${label} has an invalid size.`);
  }
  const [realDirectory, realCandidate] = await Promise.all([
    realpath(directory),
    realpath(candidate),
  ]);
  if (!realCandidate.startsWith(`${realDirectory}${path.sep}`)) {
    throw tampered(`${label} resolves outside the Desktop release.`);
  }
  const handle = await open(candidate, constants.O_RDONLY | noFollowFlag());
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw tampered(`${label} changed while it was opened.`);
    }
    if (executable && operatingSystem !== "win32" && (opened.mode & 0o111) === 0) {
      throw tampered(`${label} is not executable.`);
    }
    const digest = createHash("sha256");
    const header = Buffer.allocUnsafe(Math.min(maximumArchitectureHeaderBytes, opened.size));
    const buffer = Buffer.allocUnsafe(Math.min(1 * 1_024 * 1_024, opened.size));
    let headerBytes = 0;
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(buffer.byteLength, opened.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) throw tampered(`${label} changed while it was read.`);
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (headerBytes < header.byteLength) {
        const copied = Math.min(header.byteLength - headerBytes, bytesRead);
        chunk.copy(header, headerBytes, 0, copied);
        headerBytes += copied;
      }
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw tampered(`${label} changed while it was verified.`);
    }
    return { header, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

function normalizeOperatingSystem(value: string): "darwin" | "linux" | "win32" {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw incompatible(`Personal runtime releases are unsupported on ${value}.`);
}

function normalizeArchitecture(value: string): "amd64" | "arm64" {
  if (value === "x64" || value === "amd64" || value === "x86_64") return "amd64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  throw incompatible(`Personal runtime releases are unsupported on ${value}.`);
}

function executableArchitectures(
  content: Buffer,
  operatingSystem: "darwin" | "linux" | "win32",
): ReadonlySet<"amd64" | "arm64"> {
  if (operatingSystem === "linux") return new Set([elfArchitecture(content)]);
  if (operatingSystem === "win32") return new Set([peArchitecture(content)]);
  return machArchitectures(content);
}

function elfArchitecture(content: Buffer): "amd64" | "arm64" {
  if (
    content.byteLength < 20 ||
    content[0] !== 0x7f ||
    content[1] !== 0x45 ||
    content[2] !== 0x4c ||
    content[3] !== 0x46 ||
    content[4] !== 2 ||
    content[5] !== 1
  ) {
    throw tampered("Personal Linux entrypoint must be a 64-bit little-endian ELF executable.");
  }
  return cpuArchitecture(content.readUInt16LE(18), "ELF");
}

function peArchitecture(content: Buffer): "amd64" | "arm64" {
  if (content.byteLength < 0x40 || content[0] !== 0x4d || content[1] !== 0x5a) {
    throw tampered("Personal Windows entrypoint must be a PE executable.");
  }
  const header = content.readUInt32LE(0x3c);
  if (
    header < 0x40 ||
    header + 6 > content.byteLength ||
    content[header] !== 0x50 ||
    content[header + 1] !== 0x45 ||
    content[header + 2] !== 0 ||
    content[header + 3] !== 0
  ) {
    throw tampered("Personal Windows entrypoint has an invalid PE header.");
  }
  const machine = content.readUInt16LE(header + 4);
  if (machine === 0x8664) return "amd64";
  if (machine === 0xaa64) return "arm64";
  throw incompatible("Personal Windows entrypoint has an unsupported architecture.");
}

function machArchitectures(content: Buffer): ReadonlySet<"amd64" | "arm64"> {
  if (content.byteLength < 8) throw tampered("Personal macOS entrypoint is not Mach-O code.");
  const magic = content.readUInt32BE(0);
  if (magic === 0xfeedface || magic === 0xfeedfacf) {
    return new Set([machCpuArchitecture(content.readUInt32BE(4))]);
  }
  if (magic === 0xcefaedfe || magic === 0xcffaedfe) {
    return new Set([machCpuArchitecture(content.readUInt32LE(4))]);
  }
  const bigEndian = magic === 0xcafebabe || magic === 0xcafebabf;
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
  if (!bigEndian && !littleEndian) {
    throw tampered("Personal macOS entrypoint is not Mach-O code.");
  }
  const read32 = (offset: number) =>
    bigEndian ? content.readUInt32BE(offset) : content.readUInt32LE(offset);
  const count = read32(4);
  const entrySize = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
  if (count < 1 || count > 16 || 8 + count * entrySize > content.byteLength) {
    throw tampered("Personal macOS entrypoint has an invalid universal Mach-O header.");
  }
  const architectures = new Set<"amd64" | "arm64">();
  for (let index = 0; index < count; index += 1) {
    architectures.add(machCpuArchitecture(read32(8 + index * entrySize)));
  }
  return architectures;
}

function cpuArchitecture(machine: number, format: string): "amd64" | "arm64" {
  if (machine === 62) return "amd64";
  if (machine === 183) return "arm64";
  throw incompatible(`Personal ${format} entrypoint has an unsupported architecture.`);
}

function machCpuArchitecture(cpu: number): "amd64" | "arm64" {
  if (cpu === 0x01000007) return "amd64";
  if (cpu === 0x0100000c) return "arm64";
  throw incompatible("Personal macOS entrypoint has an unsupported architecture.");
}

/**
 * A path that is not there is an artifact missing from the release; any other
 * failure to look it up is the file system's, and passes on unchanged.
 */
function absent(error: unknown, message: string): unknown {
  const code = nodeErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR" ? missing(message, { cause: error }) : error;
}
