import { maximumSkillBytes } from "@opensteer/shared/agentSkills";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { isRecord } from "@opensteer/shared/isRecord";
import { setFileMode } from "@opensteer/shared/privateFiles";
import type { Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isLoopbackHostname } from "@opensteer/core";
import {
  LocalMcpSecretSchema,
  localMcpMaxSecrets,
  type LocalMcpSecret,
} from "@opensteer/integration-core/local-mcp";
import { PluginDeviceSchema } from "@opensteer/integration-core/models";
import { z } from "zod";
import { parse as parseYaml } from "yaml";

const maximumArguments = 256;
const maximumEnvironmentEntries = 128;
const maximumPackageBytes = 64 * 1_024 * 1_024;
const maximumPackageFileBytes = 16 * 1_024 * 1_024;
/** The files a registered folder may hold; its package adds one, the validated registration. */
export const maximumLocalServerFolderFiles = 10_000;
/** The files a package may hold, its generated registration file included. */
export const maximumPluginPackageFiles = maximumLocalServerFolderFiles + 1;
/** The definition of a package digest; a change to what it covers is a new format. */
export const pluginPackageFormat = "opensteer.plugin-package/2";
/** The validated registration the Host writes into every local-server package. */
export const localServerRegistrationFile = "local-server-registration.json";

const PluginNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);

const AgentSkillFrontmatterSchema = z
  .object({
    "allowed-tools": z.string().optional(),
    compatibility: z.string().min(1).max(500).optional(),
    description: z.string().trim().min(1).max(1_024),
    license: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  })
  .passthrough();

const StdioServerSchema = z.strictObject({
  args: z.array(z.string().max(32_768)).max(maximumArguments).optional(),
  command: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => !/[\r\n\0]/u.test(value)),
  cwd: z
    .string()
    .max(4_096)
    .regex(/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/u)
    .optional(),
  env: z
    .record(
      z
        .string()
        .min(1)
        .max(256)
        .refine((name) => name !== "PLUGIN_ROOT" && name !== "PLUGIN_DATA"),
      z.string().max(32_768),
    )
    .refine((value) => Object.keys(value).length <= maximumEnvironmentEntries)
    .superRefine((value, context) => {
      for (const name of Object.keys(value)) {
        if (isSecretBearingName(name.toLowerCase())) {
          context.addIssue({
            code: "custom",
            message: `Secret-bearing environment variable ${name} is not stored in local-server registrations; declare it in launch.secrets so the computer's owner enters it`,
          });
        }
      }
    })
    .optional(),
  type: z.literal("stdio"),
});

const StreamableHttpServerSchema = z.strictObject({
  type: z.literal("streamable-http"),
  url: z.string().min(1).max(8192),
});
const secrets = z
  .array(LocalMcpSecretSchema)
  .min(1)
  .max(localMcpMaxSecrets)
  .refine(
    (items) => new Set(items.map(({ name }) => name)).size === items.length,
    "Each secret needs its own name",
  );
export const LocalServerPackageRegistrationSchema = z
  .strictObject({
    name: PluginNameSchema,
    description: z.string().optional(),
    launch: StdioServerSchema.omit({ type: true })
      .extend({ secrets: secrets.optional() })
      .optional(),
    url: z.string().min(1).max(8192).optional(),
    device: PluginDeviceSchema.optional(),
  })
  .refine(
    (input) => (input.launch !== undefined) !== (input.url !== undefined),
    "Provide a launch or a loopback URL",
  );
export type LocalServerPackageRegistration = z.infer<typeof LocalServerPackageRegistrationSchema>;
export interface LocalServerPackageIssue {
  readonly component: "skill";
  readonly entry: string | null;
  readonly message: string;
}

interface LocalServerPackageSkill {
  readonly description: string;
  readonly digest: string;
  readonly directory: string;
  readonly name: string;
  readonly skillFile: string;
}

export type LocalServerPackageServer =
  | {
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly name: string;
      /** What its computer's owner enters when approving it; see `opensteerExtensionNamespace`. */
      readonly secrets?: readonly LocalMcpSecret[];
      readonly type: "stdio";
    }
  | {
      readonly headers: Readonly<Record<string, string>>;
      readonly name: string;
      readonly type: "streamable-http";
      readonly url: string;
    };

/** Snapshot approved launch material without interpreting a second package format. */
export async function snapshotLocalServerPackage(input: {
  readonly pluginId: string;
  readonly dataDirectory: string;
  readonly directory: string;
  readonly registration: unknown;
}) {
  const registration = LocalServerPackageRegistrationSchema.parse(input.registration);
  if (!isAbsolute(input.directory) || !isAbsolute(input.dataDirectory))
    throw new Error("Package and data directories must be absolute");
  if (!/^[a-zA-Z0-9_-]+(?:-[a-zA-Z0-9_-]+)*$/u.test(input.pluginId))
    throw new Error("Invalid plugin id");
  const requestedRoot = resolve(input.directory);
  await requireRealDirectory(requestedRoot, "Local-server package root");
  const sourceRoot = await realpath(requestedRoot);
  const root = await snapshotPackage(
    sourceRoot,
    resolve(input.dataDirectory, "packages"),
    registration,
  );
  const pluginData = join(resolve(input.dataDirectory), input.pluginId);
  await mkdir(pluginData, { mode: 0o700, recursive: true });
  const issues: LocalServerPackageIssue[] = [];
  const launch = registration.launch;
  const server = await registeredServer(registration, root, await realpath(pluginData));
  const extension = {
    ...(registration.device ? { device: registration.device } : {}),
    ...(launch?.secrets ? { secrets: { [registration.name]: launch.secrets } } : {}),
  };
  return Object.freeze({
    root,
    sourceRoot,
    servers: Object.freeze([server]),
    skills: Object.freeze(await loadSkills(root, issues)),
    issues: Object.freeze(issues),
    manifest: Object.freeze({
      name: registration.name,
      ...(registration.description ? { description: registration.description } : {}),
      ...(Object.keys(extension).length ? { extensions: { "com.opensteer": extension } } : {}),
    }),
  });
}

/** The server a registration names, as it runs from `root` with its data in `pluginData`. */
function registeredServer(
  registration: LocalServerPackageRegistration,
  root: string,
  pluginData: string,
): Promise<LocalServerPackageServer> | LocalServerPackageServer {
  const launch = registration.launch;
  return launch
    ? materializeStdio(
        registration.name,
        StdioServerSchema.parse({
          type: "stdio",
          command: launch.command,
          args: launch.args,
          env: launch.env,
          cwd: launch.cwd,
        }),
        root,
        pluginData,
        launch.secrets,
      )
    : materializeRemote(registration.name, { type: "streamable-http", url: registration.url! });
}

/**
 * The server a local-server package registers in its own registration file, as it runs from
 * `root`, a copy of the package written from verified bytes, with its data in `pluginData`.
 */
export async function packageRegisteredServer(
  root: string,
  pluginData: string,
): Promise<LocalServerPackageServer> {
  const registration = LocalServerPackageRegistrationSchema.parse(
    JSON.parse(await readFile(join(root, localServerRegistrationFile), "utf8")),
  );
  return registeredServer(registration, root, pluginData);
}

async function loadSkills(
  root: string,
  issues: LocalServerPackageIssue[],
): Promise<LocalServerPackageSkill[]> {
  const skillsRoot = join(root, "skills");
  const stat = await optionalLstat(skillsRoot);
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    issues.push({ component: "skill", entry: null, message: "skills must be a real directory" });
    return [];
  }
  const resolvedSkillsRoot = await realpath(skillsRoot);
  if (!isWithin(root, resolvedSkillsRoot)) {
    issues.push({ component: "skill", entry: null, message: "skills escapes the plugin root" });
    return [];
  }
  const entries = await readdir(resolvedSkillsRoot, { withFileTypes: true });
  const loaded: LocalServerPackageSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(resolvedSkillsRoot, entry.name);
    const skillFile = join(directory, "SKILL.md");
    const skillStat = await optionalLstat(skillFile);
    if (!skillStat) continue;
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
      issues.push({
        component: "skill",
        entry: entry.name,
        message: "SKILL.md is not a regular file",
      });
      continue;
    }
    const resolvedSkillFile = await realpath(skillFile);
    if (!isWithin(root, resolvedSkillFile) || skillStat.size > maximumSkillBytes) {
      issues.push({
        component: "skill",
        entry: entry.name,
        message: "SKILL.md is unsafe or too large",
      });
      continue;
    }
    try {
      const frontmatter = parseSkillFrontmatter(await readFile(resolvedSkillFile, "utf8"));
      if (frontmatter["allowed-tools"] !== undefined) {
        throw new Error(
          "Experimental allowed-tools is not supported because a plugin skill cannot expand Opensteer tool approval",
        );
      }
      if (frontmatter.name !== entry.name) {
        throw new Error(`Skill name ${frontmatter.name} must match directory ${entry.name}`);
      }
      loaded.push(
        Object.freeze({
          description: frontmatter.description,
          digest: await directoryDigest(directory),
          directory,
          name: entry.name,
          skillFile: resolvedSkillFile,
        }),
      );
    } catch (error) {
      issues.push({ component: "skill", entry: entry.name, message: safeIssue(error) });
      continue;
    }
  }
  return loaded;
}

export interface SnapshotFile {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly path: string;
}

export async function readPluginSnapshot(
  sourceRoot: string,
  maximumFiles = maximumPluginPackageFiles,
): Promise<SnapshotFile[]> {
  await requireRealDirectory(sourceRoot, "Local-server package snapshot");
  const found: {
    readonly mode: number;
    readonly path: string;
    readonly relativePath: string;
    readonly size: number;
  }[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const directories: [string, string][] = [];
    await eachConcurrently(await readdir(directory), async (name) => {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new Error(`Local-server package contains symlink ${relativePath}`);
      if (stat.isDirectory()) {
        directories.push([path, relativePath]);
        return;
      }
      if (!stat.isFile())
        throw new Error(`Local-server package contains unsupported entry ${relativePath}`);
      if (stat.size > maximumPackageFileBytes) {
        throw new Error(
          `Local-server package file ${relativePath} exceeds ${maximumPackageFileBytes} bytes`,
        );
      }
      totalBytes += stat.size;
      if (found.length >= maximumFiles || totalBytes > maximumPackageBytes) {
        throw new Error("Local-server package exceeds the installation limit");
      }
      found.push({ mode: stat.mode & 0o777, path, relativePath, size: stat.size });
    });
    for (const [path, relativePath] of directories) await visit(path, relativePath);
  };
  await visit(sourceRoot, "");
  const files: SnapshotFile[] = [];
  await eachConcurrently(found, async ({ mode, path, relativePath, size }) => {
    const bytes = await readFile(path);
    if (bytes.byteLength !== size)
      throw new Error(`Local-server package file ${relativePath} changed while it was read`);
    files.push({ bytes, mode, path: relativePath });
  });
  return files;
}

/** Writes a package's files into a new private directory, each with its own mode. */
export async function writePluginSnapshot(
  root: string,
  files: readonly SnapshotFile[],
): Promise<void> {
  await mkdir(root, { mode: 0o700 });
  const directories = new Set(
    files.flatMap(({ path }) => {
      const parts = path.split("/").slice(0, -1);
      return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  for (const directory of [...directories].sort((a, b) => a.length - b.length))
    await mkdir(join(root, ...directory.split("/")), { mode: 0o700 });
  await eachConcurrently(files, async (file) => {
    const target = join(root, ...file.path.split("/"));
    await writeFile(target, file.bytes, { flag: "wx", mode: file.mode });
    await setFileMode(target, file.mode);
  });
}

/** Runs `work` over every item, a bounded number at a time; the first failure fails the whole. */
async function eachConcurrently<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(32, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++]!;
        try {
          await work(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
}

/**
 * What a package digest names, as canonical JSON: the format, then every file once, ordered by
 * the UTF-8 bytes of its path, as its path, mode, size and the SHA-256 of its bytes. The order the
 * files were read in does not matter, and no two different file trees share one manifest.
 */
export function pluginPackageManifest(files: readonly SnapshotFile[]): string {
  const entries = files
    .map(({ path, mode, bytes }) => {
      if (
        !path ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error(`Plugin package path ${JSON.stringify(path)} is not a relative file path`);
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777)
        throw new Error(`Plugin package file ${path} has an invalid mode`);
      return {
        path,
        mode,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    })
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  for (let index = 1; index < entries.length; index += 1)
    if (entries[index]!.path === entries[index - 1]!.path)
      throw new Error(`Plugin package lists ${entries[index]!.path} twice`);
  return canonicalJson({ format: pluginPackageFormat, files: entries });
}

/** A package's digest: the SHA-256 of its manifest, the one definition every reader checks. */
export function pluginSnapshotDigest(files: readonly SnapshotFile[]): string {
  return createHash("sha256").update(pluginPackageManifest(files)).digest("hex");
}

/** A stored package's files, read once and refused unless they are exactly what `digest` names. */
export async function readVerifiedPluginSnapshot(
  root: string,
  digest: string,
): Promise<SnapshotFile[]> {
  const files = await readPluginSnapshot(root);
  if (pluginSnapshotDigest(files) === digest) return files;
  for (const file of files) file.bytes.fill(0);
  throw new PluginPackageMismatchError();
}

/** A stored package whose files are no longer what its digest names. */
export class PluginPackageMismatchError extends Error {
  constructor() {
    super("Plugin package files do not match its digest");
    this.name = "PluginPackageMismatchError";
  }
}

async function snapshotPackage(
  sourceRoot: string,
  snapshotRoot: string,
  registration: LocalServerPackageRegistration,
): Promise<string> {
  const files = await readPluginSnapshot(sourceRoot, maximumLocalServerFolderFiles);
  if (files.some(({ path }) => path === localServerRegistrationFile))
    throw new Error(`${localServerRegistrationFile} is reserved for the validated registration`);
  files.push({
    path: localServerRegistrationFile,
    mode: 0o600,
    // Canonical, so the package digest does not depend on the order its keys were given in.
    bytes: Buffer.from(canonicalJson(registration)),
  });
  return storePluginSnapshot(snapshotRoot, files);
}

/**
 * Stores a package's files under the digest they make, once, and answers its root, read back as
 * delivery and launch will read it. A stored snapshot that is no longer what its name says is
 * written again from these files.
 */
export async function storePluginSnapshot(
  snapshotRoot: string,
  files: readonly SnapshotFile[],
): Promise<string> {
  const digest = pluginSnapshotDigest(files);
  await mkdir(snapshotRoot, { mode: 0o700, recursive: true });
  const destination = join(snapshotRoot, digest);
  try {
    await requireRealDirectory(destination, "Local-server package snapshot");
    return await verifiedSnapshot(destination, digest);
  } catch (error) {
    if (error instanceof PluginPackageMismatchError)
      await rm(destination, { force: true, recursive: true });
    else if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  const temporary = join(snapshotRoot, `.install-${randomUUID()}`);
  try {
    await writePluginSnapshot(temporary, files);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!isRecord(error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error;
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
    for (const file of files) file.bytes.fill(0);
  }
  // Read back as delivery and launch will, so nothing is approved that later fails verification.
  return verifiedSnapshot(destination, digest);
}

async function verifiedSnapshot(destination: string, digest: string): Promise<string> {
  const root = await realpath(destination);
  for (const file of await readVerifiedPluginSnapshot(root, digest)) file.bytes.fill(0);
  return root;
}

async function directoryDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Skill contains a symlink");
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error("Skill contains an unsupported entry");
      const bytes = await readFile(path);
      hash
        .update(relative(root, path).split(sep).join("/"))
        .update("\0")
        .update(String(stat.mode & 0o777))
        .update("\0")
        .update(bytes);
      bytes.fill(0);
    }
  };
  await visit(root);
  return hash.digest("base64url");
}

function parseSkillFrontmatter(content: string): z.infer<typeof AgentSkillFrontmatterSchema> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) throw new Error("SKILL.md must begin with terminated YAML frontmatter");
  return AgentSkillFrontmatterSchema.parse(parseYaml(match[1]!));
}

async function materializeStdio(
  name: string,
  server: z.infer<typeof StdioServerSchema>,
  root: string,
  pluginData: string,
  secrets: readonly LocalMcpSecret[] | undefined,
): Promise<LocalServerPackageServer> {
  for (const { name } of secrets ?? []) {
    if (server.env && Object.hasOwn(server.env, name)) {
      throw new Error(`Secret ${name} is also set in env; declare it only as a secret`);
    }
  }
  if (/\s/u.test(server.command)) {
    throw new Error("stdio command must be one executable token; put arguments in args");
  }
  let command = server.command;
  if (command.startsWith("./")) {
    command = await realpath(join(root, command.slice(2)));
    await requireContainedRegularFile(root, command, "stdio command");
  } else if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    throw new Error("stdio command must be a bare executable or begin with ./");
  }
  const expand = (value: string) =>
    value.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${PLUGIN_DATA}", pluginData);
  const cwd = expand(server.cwd ?? "${PLUGIN_ROOT}");
  const resolvedCwd = resolve(cwd);
  if (!isWithin(root, resolvedCwd) && !isWithin(pluginData, resolvedCwd)) {
    throw new Error("stdio cwd escapes PLUGIN_ROOT and PLUGIN_DATA");
  }
  const env = Object.fromEntries(
    Object.entries(server.env ?? {}).map(([key, value]) => [key, expand(value)]),
  );
  return Object.freeze({
    args: Object.freeze((server.args ?? []).map(expand)),
    command,
    cwd: resolvedCwd,
    env: Object.freeze({ ...env, PLUGIN_DATA: pluginData, PLUGIN_ROOT: root }),
    name,
    ...(secrets ? { secrets: Object.freeze(secrets.map((secret) => Object.freeze(secret))) } : {}),
    type: "stdio" as const,
  });
}

function materializeRemote(
  name: string,
  server: z.infer<typeof StreamableHttpServerSchema>,
): LocalServerPackageServer {
  const url = new URL(server.url);
  const loopback = isLoopbackHostname(url.hostname);
  if (
    !loopback ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("A local server URL must use HTTP or HTTPS on an exact loopback host");
  }
  return Object.freeze({
    headers: Object.freeze({}),
    name,
    type: server.type,
    url: url.toString(),
  });
}

async function requireRealDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`${label} must be a real directory`);
}

async function requireContainedRegularFile(
  root: string,
  path: string,
  label: string,
): Promise<Stats> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const resolved = await realpath(path);
  if (!isWithin(root, resolved)) throw new Error(`${label} escapes the plugin root`);
  return stat;
}

async function optionalLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function safeIssue(error: unknown): string {
  if (error instanceof z.ZodError)
    return error.issues[0]?.message ?? "Invalid Local-server package data";
  return error instanceof Error ? error.message : "Invalid Local-server package data";
}

function isSecretBearingName(name: string): boolean {
  return /(?:^|[-_])(api[-_]?key|authorization|cookie|credential|password|secret|token)(?:$|[-_])/u.test(
    name,
  );
}
