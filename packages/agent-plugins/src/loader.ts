import { isRecord } from "@opensteer/shared/isRecord";
import { setFileMode } from "@opensteer/shared/privateFiles";
import type { Stats } from "node:fs";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isLoopbackHostname } from "@opensteer/core";
import { z } from "zod";
import { parse as parseYaml } from "yaml";

export const agentPluginManifestSchemaUrl =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" as const;
export const agentPluginMcpSchemaUrl =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" as const;

const maximumDocumentBytes = 1 * 1_024 * 1_024;
const maximumSkillBytes = 256 * 1_024;
const maximumServers = 128;
const maximumArguments = 256;
const maximumEnvironmentEntries = 128;
const maximumPackageBytes = 64 * 1_024 * 1_024;
const maximumPackageFileBytes = 16 * 1_024 * 1_024;
const maximumPackageFiles = 10_000;

const PluginNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);

const PluginManifestSchema = z
  .object({
    $schema: z.literal(agentPluginManifestSchemaUrl),
    author: z
      .strictObject({
        email: z.string().optional(),
        name: z.string().optional(),
        url: z.string().optional(),
      })
      .optional(),
    description: z.string().optional(),
    extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    homepage: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    license: z.string().optional(),
    name: PluginNameSchema,
    repository: z.string().optional(),
    version: z.string().optional(),
  })
  .strip();

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

const HeaderSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\r\n\0]/u.test(value)),
    z
      .string()
      .max(8_192)
      .refine((value) => !/[\r\n\0]/u.test(value)),
  )
  .superRefine((headers, context) => {
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(headers)) {
      const normalized = name.toLowerCase();
      try {
        validateHeaderName(name);
        validateHeaderValue(name, value);
      } catch {
        context.addIssue({ code: "custom", message: `Invalid HTTP header ${name}` });
      }
      if (seen.has(normalized)) {
        context.addIssue({ code: "custom", message: `Duplicate header name ${name}` });
      }
      seen.add(normalized);
      if (
        normalized === "authorization" ||
        normalized === "connection" ||
        normalized === "content-length" ||
        normalized === "cookie" ||
        normalized === "host" ||
        normalized === "mcp-protocol-version" ||
        normalized === "mcp-session-id" ||
        normalized === "proxy-authorization" ||
        isSecretBearingName(normalized)
      ) {
        context.addIssue({
          code: "custom",
          message: `Secret-bearing remote header ${name} is not stored in Agent Plugin manifests; use MCP OAuth`,
        });
      }
    }
  });

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
            message: `Secret-bearing environment variable ${name} is not stored in Agent Plugin manifests; use client-managed authorization`,
          });
        }
      }
    })
    .optional(),
  type: z.literal("stdio"),
});

const StreamableHttpServerSchema = z.strictObject({
  headers: HeaderSchema.optional(),
  type: z.literal("streamable-http"),
  url: z.string().min(1).max(8_192),
});

const LegacySseServerSchema = z.strictObject({
  headers: HeaderSchema.optional(),
  type: z.literal("sse"),
  url: z.string().min(1).max(8_192),
});

const McpServerSchema = z.discriminatedUnion("type", [
  StdioServerSchema,
  StreamableHttpServerSchema,
  LegacySseServerSchema,
]);
const McpDocumentSchema = z.strictObject({
  $schema: z.literal(agentPluginMcpSchemaUrl),
  mcpServers: z.record(z.string().min(1).max(128), z.unknown()),
});

export interface AgentPluginIssue {
  readonly component: "manifest" | "mcp" | "skill";
  readonly entry: string | null;
  readonly message: string;
}

interface LoadedAgentPlugin {
  readonly issues: readonly AgentPluginIssue[];
  readonly manifest: z.infer<typeof PluginManifestSchema>;
  readonly root: string;
  readonly sourceRoot: string;
  readonly servers: readonly LoadedAgentPluginServer[];
  readonly skills: readonly LoadedAgentPluginSkill[];
}

export interface LoadedAgentPluginSkill {
  readonly description: string;
  readonly digest: string;
  readonly directory: string;
  readonly name: string;
  readonly skillFile: string;
}

export type LoadedAgentPluginServer =
  | {
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly name: string;
      readonly type: "stdio";
    }
  | {
      readonly headers: Readonly<Record<string, string>>;
      readonly name: string;
      readonly type: "streamable-http";
      readonly url: string;
    };

/**
 * Loads one Agent Plugins 1.0 package without executing it. Filesystem paths
 * are resolved before use so a package cannot extend its authority with a
 * symlink, junction, or reparse point.
 */
export async function loadAgentPlugin(input: {
  readonly dataDirectory: string;
  readonly directory: string;
}): Promise<LoadedAgentPlugin> {
  if (!isAbsolute(input.directory) || !isAbsolute(input.dataDirectory)) {
    throw new Error("Agent Plugin and data directories must be absolute");
  }
  const requestedRoot = resolve(input.directory);
  await requireRealDirectory(requestedRoot, "Agent Plugin root");
  const sourceRoot = await realpath(requestedRoot);
  const sourceManifestPath = join(sourceRoot, "plugin.json");
  await requireContainedRegularFile(sourceRoot, sourceManifestPath, "plugin.json");
  const root = await snapshotPackage(sourceRoot, resolve(input.dataDirectory, "packages"));
  const manifestPath = join(root, "plugin.json");
  const rawManifest = await readJsonDocument(manifestPath);
  const manifestInput = recordValue(rawManifest, "plugin.json");
  const issues: AgentPluginIssue[] = [];
  for (const key of Object.keys(manifestInput)) {
    if (!PluginManifestSchema.keyof().options.includes(key as never)) {
      issues.push({ component: "manifest", entry: null, message: `Ignored unknown field ${key}` });
    }
  }
  if ("extensions" in manifestInput && !isRecord(manifestInput.extensions)) {
    issues.push({
      component: "manifest",
      entry: null,
      message: "Ignored non-object extensions field",
    });
    delete manifestInput.extensions;
  }
  const manifest = PluginManifestSchema.parse(manifestInput);
  const pluginData = join(resolve(input.dataDirectory), manifest.name);
  await mkdir(pluginData, { mode: 0o700, recursive: true });
  const resolvedData = await realpath(pluginData);

  const [skills, servers] = await Promise.all([
    loadSkills(root, issues),
    loadMcpServers(root, resolvedData, issues),
  ]);
  return Object.freeze({
    issues: Object.freeze(issues),
    manifest: Object.freeze(manifest),
    root,
    sourceRoot,
    servers: Object.freeze(servers),
    skills: Object.freeze(skills),
  });
}

async function loadSkills(
  root: string,
  issues: AgentPluginIssue[],
): Promise<LoadedAgentPluginSkill[]> {
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
  const loaded: LoadedAgentPluginSkill[] = [];
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

interface SnapshotFile {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly path: string;
}

async function snapshotPackage(sourceRoot: string, snapshotRoot: string): Promise<string> {
  const files: SnapshotFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Agent Plugin contains symlink ${relativePath}`);
      if (stat.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      if (!stat.isFile())
        throw new Error(`Agent Plugin contains unsupported entry ${relativePath}`);
      if (stat.size > maximumPackageFileBytes) {
        throw new Error(
          `Agent Plugin file ${relativePath} exceeds ${maximumPackageFileBytes} bytes`,
        );
      }
      const bytes = await readFile(path);
      totalBytes += bytes.byteLength;
      if (files.length >= maximumPackageFiles || totalBytes > maximumPackageBytes) {
        throw new Error("Agent Plugin package exceeds the installation limit");
      }
      files.push({ bytes, mode: stat.mode & 0o777, path: relativePath });
    }
  };
  await visit(sourceRoot, "");
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path).update("\0").update(String(file.mode)).update("\0").update(file.bytes);
  }
  const digest = hash.digest("hex");
  await mkdir(snapshotRoot, { mode: 0o700, recursive: true });
  const destination = join(snapshotRoot, digest);
  try {
    await requireRealDirectory(destination, "Agent Plugin snapshot");
    return await realpath(destination);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  const temporary = join(snapshotRoot, `.install-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const file of files) {
      const target = join(temporary, ...file.path.split("/"));
      await mkdir(resolve(target, ".."), { mode: 0o700, recursive: true });
      await writeFile(target, file.bytes, { flag: "wx", mode: file.mode });
      await setFileMode(target, file.mode);
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!isRecord(error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error;
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
    for (const file of files) file.bytes.fill(0);
  }
  return realpath(destination);
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

async function loadMcpServers(
  root: string,
  pluginData: string,
  issues: AgentPluginIssue[],
): Promise<LoadedAgentPluginServer[]> {
  const mcpPath = join(root, "mcp.json");
  const stat = await optionalLstat(mcpPath);
  if (!stat) return [];
  if (!stat.isFile() || stat.isSymbolicLink()) {
    issues.push({ component: "mcp", entry: null, message: "mcp.json must be a regular file" });
    return [];
  }
  let document: z.infer<typeof McpDocumentSchema>;
  try {
    document = McpDocumentSchema.parse(await readJsonDocument(mcpPath));
  } catch (error) {
    issues.push({ component: "mcp", entry: null, message: safeIssue(error) });
    return [];
  }
  const entries = Object.entries(document.mcpServers);
  if (entries.length > maximumServers) {
    issues.push({
      component: "mcp",
      entry: null,
      message: `mcp.json exceeds ${maximumServers} servers`,
    });
    return [];
  }
  const servers: LoadedAgentPluginServer[] = [];
  for (const [name, candidate] of entries) {
    try {
      const parsed = McpServerSchema.parse(candidate);
      if (parsed.type === "sse") {
        throw new Error("Legacy HTTP+SSE is not supported by this client");
      }
      servers.push(
        parsed.type === "stdio"
          ? await materializeStdio(name, parsed, root, pluginData)
          : materializeRemote(name, parsed),
      );
    } catch (error) {
      issues.push({ component: "mcp", entry: name, message: safeIssue(error) });
    }
  }
  return servers;
}

async function materializeStdio(
  name: string,
  server: z.infer<typeof StdioServerSchema>,
  root: string,
  pluginData: string,
): Promise<LoadedAgentPluginServer> {
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
    type: "stdio" as const,
  });
}

function materializeRemote(
  name: string,
  server: z.infer<typeof StreamableHttpServerSchema>,
): LoadedAgentPluginServer {
  const url = new URL(server.url);
  const loopback = isLoopbackHostname(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("remote MCP URL must be HTTPS, or HTTP on an exact loopback host");
  }
  return Object.freeze({
    headers: Object.freeze({ ...server.headers }),
    name,
    type: server.type,
    url: url.toString(),
  });
}

async function readJsonDocument(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (stat.size > maximumDocumentBytes)
    throw new Error(`${path} exceeds ${maximumDocumentBytes} bytes`);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
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

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must contain a JSON object`);
  return { ...value };
}

function safeIssue(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Invalid Agent Plugin data";
  return error instanceof Error ? error.message : "Invalid Agent Plugin data";
}

function isSecretBearingName(name: string): boolean {
  return /(?:^|[-_])(api[-_]?key|authorization|cookie|credential|password|secret|token)(?:$|[-_])/u.test(
    name,
  );
}
