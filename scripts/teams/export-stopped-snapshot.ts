import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { UserIdSchema, WorkspaceIdSchema } from "../../packages/core/src/ids.js";
import { noFollowFlag } from "@opensteer/shared/privateFiles";

const snapshotSchema = z.strictObject({
  format: z.literal("opensteer-stopped-content-v1"),
  state: z.literal("stopped"),
  workspaces: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        id: WorkspaceIdSchema,
        kind: z.literal("main"),
        ownerId: UserIdSchema,
        name: z.string(),
      }),
      z.strictObject({ id: WorkspaceIdSchema, kind: z.literal("project"), name: z.string() }),
    ]),
  ),
  chats: z.array(
    z.strictObject({
      workspaceId: WorkspaceIdSchema,
      threadId: z.string(),
      title: z.string(),
      messages: z.array(z.strictObject({ author: z.string(), at: z.string(), text: z.string() })),
    }),
  ),
  files: z.array(
    z.strictObject({
      workspaceId: WorkspaceIdSchema,
      path: z.string(),
      source: z.string().nullable(),
    }),
  ),
});

type ExportedFile = { path: string; sha256: string; bytes: number; nonce?: string; tag?: string };

function inside(root: string, candidate: string) {
  const local = relative(root, candidate);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function safeRelative(value: string) {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === ".." || part === "." || !part) ||
    value.includes("\0")
  )
    throw new Error("Unsafe snapshot path");
  return value;
}

async function safeSource(root: string, local: string) {
  safeRelative(local);
  let current = root;
  for (const part of local.split("/")) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Snapshot symlinks are not permitted");
  }
  const canonical = await realpath(current);
  if (!inside(root, canonical)) throw new Error("Snapshot path escaped its root");
  const stat = await lstat(canonical);
  if (!stat.isFile()) throw new Error("Snapshot source must be a regular file");
  return canonical;
}

function refuseLiveDirectory(path: string) {
  const home = homedir();
  for (const live of [
    join(home, "Opensteer"),
    join(home, "Opensteer Beta"),
    join(home, "Library/Application Support/Opensteer"),
    join(home, "Library/Application Support/Opensteer Beta"),
  ]) {
    if (inside(live, path))
      throw new Error("A live Opensteer directory is not an export snapshot or destination");
  }
}

async function writeBytes(destination: string, bytes: Buffer, key?: Buffer): Promise<ExportedFile> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!key) {
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    return { path: destination, sha256: digest, bytes: bytes.length };
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  await writeFile(destination, Buffer.concat([cipher.update(bytes), cipher.final()]), {
    flag: "wx",
    mode: 0o600,
  });
  return {
    path: destination,
    sha256: digest,
    bytes: bytes.length,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

async function copyFile(source: string, destination: string, key?: Buffer): Promise<ExportedFile> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(source, constants.O_RDONLY | noFollowFlag());
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    const input = handle.createReadStream({ autoClose: false });
    input.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    if (key) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      await pipeline(input, cipher, output);
      return {
        path: destination,
        sha256: hash.digest("hex"),
        bytes,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    }
    await pipeline(input, output);
    return { path: destination, sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}

export async function exportStoppedSnapshot(options: {
  snapshot: string;
  output: string;
  ownerKeys?: ReadonlyMap<string, Buffer>;
}) {
  const root = await realpath(options.snapshot);
  refuseLiveDirectory(root);
  if ((await lstat(options.snapshot)).isSymbolicLink())
    throw new Error("Snapshot root must not be a symlink");
  const requestedOutput = resolve(options.output);
  const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  refuseLiveDirectory(output);
  if (inside(root, output) || inside(output, root))
    throw new Error("Snapshot and destination must be separate");
  const source = await safeSource(root, "snapshot.json");
  if ((await lstat(source)).size > 64 * 1024 * 1024)
    throw new Error("Snapshot metadata exceeds 64 MiB; split the stopped snapshot explicitly");
  const snapshot = snapshotSchema.parse(JSON.parse(await readFile(source, "utf8")));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  if (workspaces.size !== snapshot.workspaces.length)
    throw new Error("Duplicate snapshot Workspace");
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (!workspaces.has(file.workspaceId)) throw new Error("File has no explicit Workspace");
    safeRelative(file.path);
    if (file.source !== null) safeRelative(file.source);
    const identity = `${file.workspaceId}/${file.path}`;
    if (paths.has(identity)) throw new Error("Duplicate export file");
    paths.add(identity);
  }
  for (const chat of snapshot.chats)
    if (!workspaces.has(chat.workspaceId)) throw new Error("Chat has no explicit Workspace");
  for (const key of options.ownerKeys?.values() ?? [])
    if (key.length !== 32) throw new Error("Owner encryption keys must be 32 bytes");
  await mkdir(output, { mode: 0o700 });
  const manifest = {
    format: "opensteer-content-export-v1",
    complete: false,
    source:
      "Operator-attested stopped data-only snapshot; not a raw PostgreSQL backup or a completeness proof.",
    obligations: [
      "Keep the stopped source confidential and quarantined.",
      "Back up confidential credentials separately; none are exported.",
      "Missing remote-machine bytes must be recovered separately by their owners.",
      "This archive restores no identity, credential, grant, session, pending work or authority.",
      "Private owner keys are required to decrypt private exports; retain them separately.",
    ],
    bundles: [] as {
      workspaceId: string;
      kind: "main" | "project";
      ownerId?: string;
      state: "exported" | "quarantined-source";
      files: ExportedFile[];
      missing: string[];
    }[],
  };
  for (const workspace of snapshot.workspaces) {
    const key = workspace.kind === "main" ? options.ownerKeys?.get(workspace.ownerId) : undefined;
    const bundle = {
      workspaceId: workspace.id,
      kind: workspace.kind,
      ...(workspace.kind === "main" ? { ownerId: workspace.ownerId } : {}),
      state:
        workspace.kind === "main" && !key ? ("quarantined-source" as const) : ("exported" as const),
      files: [] as ExportedFile[],
      missing: [] as string[],
    };
    manifest.bundles.push(bundle);
    if (bundle.state === "quarantined-source") continue;
    const directory = join(
      output,
      workspace.kind === "main" ? "private" : "projects",
      workspace.id,
    );
    const chats = snapshot.chats.filter((chat) => chat.workspaceId === workspace.id);
    bundle.files.push(
      await writeBytes(
        join(directory, key ? "chats.json.enc" : "chats.json"),
        Buffer.from(JSON.stringify({ workspace, chats }, null, 2)),
        key,
      ),
    );
    for (const [index, file] of snapshot.files
      .filter((file) => file.workspaceId === workspace.id)
      .entries()) {
      if (file.source === null) {
        bundle.missing.push(file.path);
        continue;
      }
      let sourcePath;
      try {
        sourcePath = await safeSource(root, file.source);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          bundle.missing.push(file.path);
          continue;
        }
        throw error;
      }
      bundle.files.push(
        await copyFile(sourcePath, join(directory, "files", key ? `${index}.enc` : file.path), key),
      );
    }
    if (key) {
      for (const file of bundle.files) file.path = relative(directory, file.path);
      const privateMetadata = {
        files: bundle.files,
        missing: bundle.missing,
        sourceFiles: snapshot.files.filter((file) => file.workspaceId === workspace.id),
      };
      const encrypted = await writeBytes(
        join(directory, "manifest.json.enc"),
        Buffer.from(JSON.stringify(privateMetadata)),
        key,
      );
      bundle.files = [encrypted];
      bundle.missing = [];
    }
    for (const file of bundle.files) file.path = relative(output, file.path);
  }
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      output: { type: "string" },
      "owner-key": { type: "string", multiple: true },
    },
  });
  if (!values.snapshot || !values.output)
    throw new Error(
      "Usage: pnpm exec tsx scripts/teams/export-stopped-snapshot.ts --snapshot <stopped-content-directory> --output <new-directory> [--owner-key <user-id>=<key-file>]",
    );
  const ownerKeys = new Map<string, Buffer>();
  for (const item of values["owner-key"] ?? []) {
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error("Owner keys require user-id=key-file");
    ownerKeys.set(
      UserIdSchema.parse(item.slice(0, separator)),
      await readFile(item.slice(separator + 1)),
    );
  }
  const manifest = await exportStoppedSnapshot({
    snapshot: values.snapshot,
    output: values.output,
    ownerKeys,
  });
  console.log(JSON.stringify({ complete: manifest.complete, obligations: manifest.obligations }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Offline export failed");
    process.exitCode = 1;
  });
}
