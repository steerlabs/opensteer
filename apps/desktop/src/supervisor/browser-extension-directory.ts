import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { z } from "zod";

const maximumBytes = 32 * 1024 * 1024;
const Manifest = z.object({
  background: z.object({ service_worker: z.string().regex(/^b\/[a-zA-Z0-9_-]+\/.+/u) }),
});
function buildId(bytes: Uint8Array): string {
  return Manifest.parse(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  ).background.service_worker.split("/")[1]!;
}

// fflate does not expose Unix file types, so check the central directory before inflating.
function validateArchive(zip: Buffer): void {
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) throw new Error("Invalid extension zip");
  if (zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0)
    throw new Error("Split extension zip");
  let offset = zip.readUInt32LE(end + 16);
  let total = 0;
  const names = new Set<string>();
  for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid zip entry");
    const length = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 46, offset + 46 + length).toString("utf8");
    const mode = zip.readUInt32LE(offset + 38) >>> 16;
    if (
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.includes(":") ||
      name.split("/").some((part) => part === ".." || part === "." || part === "") ||
      ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000) ||
      (zip.readUInt32LE(offset + 38) & 0x10) !== 0 ||
      names.has(name)
    ) {
      throw new Error("Unsafe extension zip entry");
    }
    names.add(name);
    total += zip.readUInt32LE(offset + 24);
    if (total > maximumBytes) throw new Error("Extension zip is too large");
    offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  if (offset !== end) throw new Error("Invalid extension zip directory");
}

export interface BrowserExtensionDirectoryOptions {
  readonly userDataDirectory: string;
  readonly zipPath: string;
  readonly log: (message: string) => void;
  /** Fault injection after each published step. */
  readonly afterPublish?: (name: string) => void;
}

let pending: Promise<unknown> = Promise.resolve();
export function syncBrowserExtensionDirectory(
  options: BrowserExtensionDirectoryOptions,
): Promise<string | null> {
  const result = pending.then(() => sync(options));
  pending = result.catch(() => undefined);
  return result;
}

async function usable(directory: string): Promise<string | null> {
  try {
    const manifest = await readFile(path.join(directory, "manifest.json"));
    const id = buildId(manifest);
    const worker = Manifest.parse(JSON.parse(manifest.toString())).background.service_worker;
    if (!(await stat(path.join(directory, worker))).isFile()) return null;
    await readFile(path.join(directory, "connect.html"));
    await readFile(path.join(directory, "icons/probe.png"));
    return id;
  } catch {
    return null;
  }
}

async function sync(options: BrowserExtensionDirectoryOptions): Promise<string | null> {
  const directory = path.resolve(options.userDataDirectory, "Browser Extension");
  try {
    const zip = await readFile(options.zipPath);
    if (zip.length > maximumBytes) throw new Error("Extension zip is too large");
    validateArchive(zip);
    const files = unzipSync(zip, {
      filter: (entry) => {
        if (entry.originalSize > maximumBytes) throw new Error("Extension entry is too large");
        return true;
      },
    });
    if (!Object.keys(files).some((name) => name.startsWith("b/"))) {
      options.log("Skipping flat-layout browser extension zip");
      return (await usable(directory)) ? directory : null;
    }
    const manifest = files["manifest.json"];
    if (!manifest) throw new Error("Missing extension manifest");
    const id = buildId(manifest);
    const worker = Manifest.parse(JSON.parse(Buffer.from(manifest).toString())).background
      .service_worker;
    if (!files[worker] || !files["connect.html"] || !files["icons/probe.png"])
      throw new Error("Incomplete extension zip");
    for (const name of Object.keys(files)) {
      if (
        !["manifest.json", "connect.html", "icons/probe.png", "INSTALL.txt"].includes(name) &&
        !name.startsWith(`b/${id}/`)
      )
        throw new Error("Unexpected extension zip entry");
    }
    const previous = await usable(directory);
    if (previous === id) return directory;
    await mkdir(path.join(directory, "b"), { recursive: true });
    const target = path.join(directory, "b", id);
    try {
      await stat(target);
    } catch {
      const temporary = await mkdtemp(path.join(directory, "b", ".install-"));
      try {
        for (const [name, bytes] of Object.entries(files)) {
          if (!name.startsWith(`b/${id}/`)) continue;
          const destination = path.join(temporary, name.slice(`b/${id}/`.length));
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, bytes);
        }
        await rename(temporary, target);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    options.afterPublish?.(`b/${id}`);
    for (const name of ["connect.html", "icons/probe.png", "manifest.json"]) {
      const destination = path.join(directory, name);
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, files[name]!);
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
      options.afterPublish?.(name);
    }
    for (const entry of await readdir(path.join(directory, "b"), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== id && entry.name !== previous)
        await rm(path.join(directory, "b", entry.name), { recursive: true, force: true });
    }
    return directory;
  } catch (error) {
    options.log(
      `Browser extension folder sync failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return (await usable(directory)) ? directory : null;
  }
}
