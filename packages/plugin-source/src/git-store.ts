/**
 * Git's on-disk format for bare repositories, written the way Git itself writes it: loose objects
 * and refs land through a temporary file renamed into place, and a ref moves only under its
 * `<ref>.lock`, so a killed process leaves either the old state or the new one, and native Git
 * and this module can share a repository. Like Git's default `core.fsync`, loose objects and refs
 * are not flushed to disk: a killed process is covered, losing power is not.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { constants, deflate, inflate, inflateSync } from "node:zlib";
import * as Git from "isomorphic-git";
import type { SourceError } from "@opensteer/plugin-engine-sdk/core";

/** A refusal with the source failure it should surface as; anything else thrown is a Git failure. */
export class Refusal extends Error {
  readonly reason: SourceError["reason"];
  constructor(reason: SourceError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}

type ObjectType = "blob" | "tree" | "commit" | "tag";
interface GitObject {
  readonly type: ObjectType;
  readonly bytes: Uint8Array;
}
export interface TreeFile {
  readonly path: string;
  readonly object: string;
}

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);
const utf8 = new TextDecoder("utf-8", { fatal: true });

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
const missing = (error: unknown) => errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";

/**
 * A lock older than this was left by a process that died holding it: Git holds a ref lock only
 * for one write and rename. Git itself never clears one, which would refuse every later save.
 */
const staleLockMilliseconds = 10_000;

const objectFile = (repository: string, object: string) =>
  join(repository, "objects", object.slice(0, 2), object.slice(2));

const parseHeader = (raw: Uint8Array) => {
  const end = raw.indexOf(0);
  if (end < 0 || end > 32) return undefined;
  const match = /^(blob|tree|commit|tag) (\d+)$/u.exec(
    Buffer.from(raw.subarray(0, end)).toString("latin1"),
  );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { type: match[1] as ObjectType, size: Number(match[2]), start: end + 1 };
};

const refuse = () => Promise.reject(new Error("isomorphic-git only reads here"));
/** isomorphic-git reads packed objects and is given no way to write. */
const readOnly = {
  promises: {
    readFile,
    readdir,
    stat,
    lstat,
    readlink,
    writeFile: refuse,
    unlink: refuse,
    mkdir: refuse,
    rmdir: refuse,
    symlink: refuse,
  },
};

/** Objects Git packed (a push, `git gc`) are read through isomorphic-git, which caches pack indexes in `cache`. */
const readPacked = async (repository: string, object: string, cache: object) => {
  try {
    const result = await Git.readObject({
      fs: readOnly,
      gitdir: repository,
      oid: object,
      format: "content",
      cache,
    });
    if (result.format !== "content") throw new Error("unexpected object format");
    const bytes = result.object;
    return {
      type: result.type,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  } catch (error) {
    if (error instanceof Git.Errors.NotFoundError) return undefined;
    throw error;
  }
};

/** One object's type and bytes, or undefined when the repository does not hold it. */
export const readObject = async (
  repository: string,
  object: string,
  cache: object,
): Promise<GitObject | undefined> => {
  let compressed: Buffer;
  try {
    compressed = await readFile(objectFile(repository, object));
  } catch (error) {
    if (missing(error)) return readPacked(repository, object, cache);
    throw error;
  }
  const raw = await inflateAsync(compressed);
  const header = parseHeader(raw);
  if (header === undefined || raw.length - header.start !== header.size)
    throw new Error("damaged loose object");
  return {
    type: header.type,
    bytes: new Uint8Array(raw.buffer, raw.byteOffset + header.start, header.size),
  };
};

/** One object's type and size without reading a loose object's contents into memory. */
export const objectHeader = async (repository: string, object: string, cache: object) => {
  let handle: FileHandle;
  try {
    handle = await open(objectFile(repository, object), "r");
  } catch (error) {
    if (!missing(error)) throw error;
    const packed = await readPacked(repository, object, cache);
    return packed === undefined ? undefined : { type: packed.type, size: packed.bytes.length };
  }
  try {
    // The header is the first bytes the stream inflates to; a dynamic block's code tables take
    // at most a few hundred bytes before it.
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
    const header = parseHeader(
      inflateSync(buffer.subarray(0, bytesRead), { finishFlush: constants.Z_SYNC_FLUSH }),
    );
    if (header === undefined) throw new Error("damaged loose object");
    return { type: header.type, size: header.size };
  } finally {
    await handle.close();
  }
};

export const objectId = (type: ObjectType, bytes: Uint8Array) =>
  createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

/** Write `bytes` to `target` through a synced temporary file beside it, then rename it into place. */
const writeAtomically = async (target: string, bytes: Uint8Array, mode: number, prefix: string) => {
  const temporary = join(dirname(target), `${prefix}${randomUUID()}`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    // Windows refuses to replace a read-only object another writer just finished.
    if (!(await exists(target))) throw error;
  }
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    (error: unknown) => (missing(error) ? false : Promise.reject(error)),
  );

/** Store one loose object, as `git hash-object -w` does, and return its ID. */
export const writeObject = async (repository: string, type: ObjectType, bytes: Uint8Array) => {
  const object = objectId(type, bytes);
  const target = objectFile(repository, object);
  if (await exists(target)) return object;
  const compressed = await deflateAsync(
    Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]),
  );
  await mkdir(dirname(target), { recursive: true });
  await writeAtomically(target, compressed, 0o444, "tmp_obj_");
  return object;
};

interface TreeEntry {
  readonly name: string;
  readonly mode: string;
  readonly object: string;
}

/** One tree's entries in tree order. A name that is not UTF-8 is not app source. */
const readTree = async (repository: string, tree: string, cache: object) => {
  const found = await readObject(repository, tree, cache);
  if (found?.type !== "tree") throw new Error("missing tree");
  const bytes = found.bytes;
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const end = bytes.indexOf(0, space);
    if (space < 0 || end < 0 || end + 21 > bytes.length) throw new Error("damaged tree");
    let name: string;
    try {
      name = utf8.decode(bytes.subarray(space + 1, end));
    } catch {
      throw new Refusal("invalid-source");
    }
    entries.push({
      name,
      mode: Buffer.from(bytes.subarray(offset, space)).toString("latin1"),
      object: Buffer.from(bytes.subarray(end + 1, end + 21)).toString("hex"),
    });
    offset = end + 21;
  }
  return entries;
};

const fileModes = new Set(["100644", "100755"]);

/** Every file of a tree, depth first in tree order, as `git ls-tree -r` lists them. */
export const listTree = async (
  repository: string,
  tree: string,
  cache: object,
  prefix = "",
): Promise<TreeFile[]> => {
  const files: TreeFile[] = [];
  for (const entry of await readTree(repository, tree, cache)) {
    const path = prefix + entry.name;
    if (entry.mode === "40000")
      files.push(...(await listTree(repository, entry.object, cache, `${path}/`)));
    else if (fileModes.has(entry.mode)) files.push({ path, object: entry.object });
    // Symbolic links and submodules are not app source.
    else throw new Refusal("invalid-source");
  }
  return files;
};

/** The blob at `path` in a tree, as `<tree>:<path>` names it, or undefined when there is none. */
export const findFile = async (repository: string, tree: string, path: string, cache: object) => {
  let current = tree;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    const entry = (await readTree(repository, current, cache)).find(
      (item) => item.name === segment,
    );
    if (entry === undefined) return undefined;
    if (index === segments.length - 1) return fileModes.has(entry.mode) ? entry.object : undefined;
    if (entry.mode !== "40000") return undefined;
    current = entry.object;
  }
  return undefined;
};

/** Write the trees of a complete file list and return the root tree's ID. */
export const writeTrees = async (repository: string, files: ReadonlyArray<TreeFile>) => {
  interface Folder extends Map<string, string | Folder> {}
  const root: Folder = new Map();
  for (const file of files) {
    const segments = file.path.split("/");
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      const next = folder.get(segment) ?? new Map();
      if (typeof next === "string") throw new Refusal("invalid-source");
      folder.set(segment, next);
      folder = next;
    }
    const name = segments[segments.length - 1] ?? "";
    if (folder.has(name)) throw new Refusal("invalid-source");
    folder.set(name, file.object);
  }
  const write = async (folder: Folder): Promise<string> => {
    const entries: Array<{ key: Buffer; head: Buffer; object: string }> = [];
    for (const [name, value] of folder) {
      const tree = typeof value !== "string";
      const object = tree ? await write(value) : value;
      // Git orders entries by their UTF-8 bytes, a folder as if its name ended in `/`.
      entries.push({
        key: Buffer.from(tree ? `${name}/` : name),
        head: Buffer.from(`${tree ? "40000" : "100644"} ${name}\0`),
        object,
      });
    }
    entries.sort((left, right) => Buffer.compare(left.key, right.key));
    return writeObject(
      repository,
      "tree",
      Buffer.concat(entries.flatMap((entry) => [entry.head, Buffer.from(entry.object, "hex")])),
    );
  };
  return write(root);
};

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
  readonly author: string;
  readonly authored: number;
  readonly committed: number;
  readonly message: string;
}

const signature = /^(.*) <[^>]*> (\d+) [+-]\d{4}$/u;

/** One commit of the repository, or undefined when it holds no commit by that ID. */
export const readCommit = async (
  repository: string,
  commit: string,
  cache: object,
): Promise<ParsedCommit | undefined> => {
  const found = await readObject(repository, commit, cache);
  if (found?.type !== "commit") return undefined;
  const text = Buffer.from(found.bytes).toString("utf8");
  const split = text.indexOf("\n\n");
  const headers = (split < 0 ? text : text.slice(0, split)).split("\n");
  const value = (name: string) =>
    headers
      .filter((line) => line.startsWith(`${name} `))
      .map((line) => line.slice(name.length + 1));
  const tree = value("tree")[0];
  const author = signature.exec(value("author")[0] ?? "");
  const committer = signature.exec(value("committer")[0] ?? "");
  if (tree === undefined || author?.[1] === undefined || committer?.[2] === undefined)
    throw new Error("damaged commit");
  return {
    tree,
    parents: value("parent"),
    author: author[1],
    authored: Number(author[2]),
    committed: Number(committer[2]),
    message: split < 0 ? "" : text.slice(split + 2),
  };
};

/** The commit bytes `git commit-tree` writes: the message exactly as given, local time zone. */
export const commitObject = (input: {
  readonly tree: string;
  readonly parent: string | null;
  readonly message: string;
  readonly at: Date;
}) => {
  const offset = -input.at.getTimezoneOffset();
  const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  const person = `PluginEngine <apps@pluginEngine.local> ${Math.floor(input.at.getTime() / 1000)} ${zone}`;
  return Buffer.from(
    `tree ${input.tree}\n${input.parent === null ? "" : `parent ${input.parent}\n`}author ${person}\ncommitter ${person}\n\n${input.message}`,
  );
};

/** A ref's commit: the loose ref first, then `packed-refs`, as Git resolves it. */
export const readRef = async (repository: string, ref: string): Promise<string | null> => {
  try {
    const value = await readFile(join(repository, ref), "utf8");
    if (/^[0-9a-f]{40}\n?$/u.test(value)) return value.slice(0, 40);
    throw new Error("unreadable ref");
  } catch (error) {
    // A folder of other refs is not this ref.
    if (!missing(error) && errorCode(error) !== "EISDIR") throw error;
  }
  let packed: string;
  try {
    packed = await readFile(join(repository, "packed-refs"), "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  for (const line of packed.split("\n")) {
    if (line.slice(41) === ref && /^[0-9a-f]{40} /u.test(line)) return line.slice(0, 40);
  }
  return null;
};

const acquireLock = async (lock: string) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await open(lock, "wx", 0o644);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (attempt > 0) return undefined;
      const held = await stat(lock).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs < staleLockMilliseconds) return undefined;
      await unlink(lock).catch(() => undefined);
    }
  }
};

/**
 * Move `ref` to `next` only while it still names `expected` (null: it must not exist), as
 * `git update-ref <ref> <next> <expected>` does. False when another write won or holds it.
 */
export const updateRef = async (
  repository: string,
  ref: string,
  next: string,
  expected: string | null,
) => {
  const target = join(repository, ref);
  const lock = `${target}.lock`;
  try {
    await mkdir(dirname(target), { recursive: true });
  } catch (error) {
    // A ref already uses part of this name as its own.
    if (errorCode(error) === "ENOTDIR" || errorCode(error) === "EEXIST") return false;
    throw error;
  }
  const handle = await acquireLock(lock);
  if (handle === undefined) return false;
  let held = true;
  let moved = false;
  try {
    if ((await readRef(repository, ref)) !== expected) return false;
    await handle.writeFile(`${next}\n`);
    await handle.close();
    held = false;
    try {
      await rename(lock, target);
    } catch (error) {
      // Other refs live beneath this name.
      if (["EISDIR", "ENOTEMPTY", "EPERM", "EEXIST"].includes(String(errorCode(error))))
        return false;
      throw error;
    }
    moved = true;
    return true;
  } finally {
    if (held) await handle.close();
    if (!moved) await unlink(lock).catch(() => undefined);
  }
};

const configuration =
  "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n[http]\n\treceivepack = true\n[gc]\n\tauto = 0\n";

/** Write a file only if it is absent, atomically; an existing one, such as Git's own, is kept. */
const writeIfAbsent = async (target: string, contents: string) => {
  if (await exists(target)) return;
  const temporary = join(dirname(target), `.tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, target);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

/**
 * The layout `git init --bare --initial-branch=main --template=` makes, plus the native backend's
 * settings. Every step is idempotent, so it also completes a creation a killed process left.
 */
export const initialize = async (repository: string) => {
  await mkdir(repository, { recursive: true, mode: 0o700 });
  for (const folder of ["objects/info", "objects/pack", "refs/heads", "refs/tags"])
    await mkdir(join(repository, folder), { recursive: true });
  await writeIfAbsent(join(repository, "config"), configuration);
  await writeIfAbsent(join(repository, "HEAD"), "ref: refs/heads/main\n");
};

/**
 * Refuse a repository in a format this module would misread or damage, such as SHA-256 objects or
 * reftable refs that a newer Git may create. A repository without a config reads as format 0.
 */
export const supportedFormat = async (repository: string) => {
  let text: string;
  try {
    text = await readFile(join(repository, "config"), "utf8");
  } catch (error) {
    if (missing(error)) return true;
    throw error;
  }
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[#;].*$/u, "").trim();
    const header = /^\[([^\]\s"]+)(?:\s+"[^"]*")?\]$/u.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1].toLowerCase();
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/u.exec(line);
    if (entry?.[1] === undefined) continue;
    const key = entry[1].toLowerCase();
    const value = (entry[2] ?? "true").toLowerCase();
    if (section === "core" && key === "repositoryformatversion" && value !== "0" && value !== "1")
      return false;
    if (
      section === "extensions" &&
      !(key === "objectformat" && value === "sha1") &&
      !(key === "refstorage" && value === "files") &&
      key !== "worktreeconfig" &&
      key !== "noop"
    )
      return false;
  }
  return true;
};
