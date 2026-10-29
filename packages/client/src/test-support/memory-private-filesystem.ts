import type { PrivateFilesystem } from "../connections/private-filesystem.js";

/**
 * The `PrivateFilesystem` contract without a disk, for tests in this package.
 *
 * Containment, file modes and atomic replacement are the platform
 * implementation's guarantees and are tested where that implementation lives.
 * What this package's own tests need is the contract itself: a missing file
 * reads as `null`, a read is bounded, and a write replaces the whole file.
 */
export class MemoryPrivateFilesystem implements PrivateFilesystem {
  readonly root = "/private";
  readonly #directories = new Set<string>();
  readonly #files = new Map<string, Uint8Array>();

  /** The stored bytes as text, or null when nothing is stored at `path`. */
  text(path: string): string | null {
    const bytes = this.#files.get(path);
    return bytes === undefined ? null : new TextDecoder().decode(bytes);
  }

  /** Replaces a file's content directly, as another writer would have left it. */
  put(path: string, content: Uint8Array | string): void {
    this.#files.set(path, bytesOf(content));
  }

  async directoryEmpty(path: string): Promise<boolean> {
    const prefix = `${path}/`;
    return ![...this.#files.keys()].some((candidate) => candidate.startsWith(prefix));
  }

  async ensureDirectory(path: string): Promise<void> {
    this.#directories.add(path);
  }

  async fileExists(path: string): Promise<boolean> {
    return this.#files.has(path);
  }

  async readFile(path: string, maxBytes: number): Promise<Uint8Array | null> {
    const bytes = this.#files.get(path);
    if (bytes === undefined) return null;
    if (bytes.byteLength > maxBytes) {
      throw new Error("The private file exceeds its size limit.");
    }
    return bytes;
  }

  async removeFile(path: string): Promise<boolean> {
    return this.#files.delete(path);
  }

  async writeFileAtomic(path: string, content: Uint8Array | string): Promise<void> {
    this.#files.set(path, bytesOf(content));
  }

  async writeFileExclusive(path: string, content: Uint8Array | string): Promise<void> {
    if (this.#files.has(path)) throw new Error("The private file already exists.");
    this.#files.set(path, bytesOf(content));
  }
}

function bytesOf(content: Uint8Array | string): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content.slice();
}
