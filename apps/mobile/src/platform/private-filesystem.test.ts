import { describe, expect, it } from "vitest";
import {
  createDocumentPrivateFilesystem,
  type DocumentDirectory,
  type DocumentFile,
  type DocumentFilesystem,
} from "./private-filesystem.js";

const root = "file:///app/Documents/";

/**
 * `expo-file-system` without a disk, modelling exactly what the platform gives
 * and nothing stronger.
 *
 * `replace` is the crucial one: Expo's move with `overwrite` deletes the
 * destination and then renames into it, so a process that dies between the two
 * loses the destination outright. Modelling that is what makes the journal's
 * recovery paths provable — a single-step rename fake would prove nothing.
 *
 * `interrupt` is called before every mutating step with a label; a test that
 * throws from it stops the write exactly where a terminated app would.
 */
class MemoryDocumentFilesystem implements DocumentFilesystem {
  readonly root = root;
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>([root.slice(0, -1)]);
  interrupt: (step: string) => void = () => undefined;
  delayAsyncWrites = false;

  readonly directory = (uri: string): DocumentDirectory => ({
    uri,
    exists: this.directories.has(uri),
    create: () => {
      this.directories.add(uri);
    },
    list: () => [...this.files.keys()].filter((path) => path.startsWith(`${uri}/`)),
  });

  readonly file = (
    uri: string,
  ): DocumentFile & { write(content: string | Uint8Array): void | Promise<void> } => ({
    uri,
    exists: this.files.has(uri),
    bytes: async () => {
      const bytes = this.files.get(uri);
      if (bytes === undefined) throw new Error(`${uri} does not exist.`);
      return bytes;
    },
    create: (options) => {
      if (this.files.has(uri) && options?.overwrite !== true) {
        throw new Error(`${uri} already exists.`);
      }
      this.interrupt(`create:${uri}`);
      this.files.set(uri, new Uint8Array());
    },
    delete: () => {
      this.interrupt(`delete:${uri}`);
      this.files.delete(uri);
    },
    write: (content) => {
      if (this.delayAsyncWrites) return new Promise<void>(() => undefined);
      return this.file(uri).writeSync(content);
    },
    writeSync: (content) => {
      this.interrupt(`write:${uri}`);
      this.files.set(
        uri,
        typeof content === "string" ? new TextEncoder().encode(content) : content,
      );
    },
  });

  replace(sourceUri: string, targetUri: string): void {
    const bytes = this.files.get(sourceUri);
    if (bytes === undefined) throw new Error(`${sourceUri} does not exist.`);
    this.interrupt(`replace:${sourceUri}`);
    // Delete-then-move, as the platform does it.
    this.files.delete(targetUri);
    this.files.set(targetUri, bytes);
    this.files.delete(sourceUri);
  }
}

const open = () => {
  const platform = new MemoryDocumentFilesystem();
  return { files: createDocumentPrivateFilesystem(platform), platform };
};

const catalog = `${root}opensteer/deployments.json`;
const text = (bytes: Uint8Array | null): string => new TextDecoder().decode(bytes ?? undefined);

/** Stops the write at `step`, the way a terminated process would. */
const dieAt = (platform: MemoryDocumentFilesystem, step: string): void => {
  platform.interrupt = (current) => {
    if (current === step) throw new Error("The operating system stopped this app.");
  };
};

describe("createDocumentPrivateFilesystem", () => {
  it.each(["atomic", "exclusive"] as const)(
    "persists %s bytes before completing with SDK 58 asynchronous writes",
    async (kind) => {
      const { files, platform } = open();
      platform.delayAsyncWrites = true;
      if (kind === "atomic") await files.writeFileAtomic(catalog, "committed");
      else await files.writeFileExclusive(catalog, "committed");
      expect(text(await files.readFile(catalog, 1_024))).toBe("committed");
      expect([...platform.files.keys()]).toEqual([catalog]);
    },
  );

  it("leaves no journal behind after an atomic write", async () => {
    const { files, platform } = open();
    await files.writeFileAtomic(catalog, "{}");
    await files.writeFileAtomic(catalog, '{"revision":1}');

    expect([...platform.files.keys()]).toEqual([catalog]);
  });

  it("refuses a read past the caller's bound", async () => {
    const { files } = open();
    await files.writeFileAtomic(catalog, "0123456789");

    await expect(files.readFile(catalog, 4)).rejects.toThrow(/size limit/u);
  });

  it("claims a path exclusively", async () => {
    const { files } = open();
    await files.writeFileExclusive(catalog, "{}");

    await expect(files.writeFileExclusive(catalog, "{}")).rejects.toThrow(/already exists/u);
  });

  it("refuses a path outside the private directory", async () => {
    const { files } = open();

    await expect(files.readFile("file:///etc/passwd", 16)).rejects.toThrow(/outside/u);
    await expect(files.readFile(`${root}../other/file`, 16)).rejects.toThrow(/outside/u);
    await expect(files.writeFileAtomic(`${root}a/../../b`, "{}")).rejects.toThrow(/outside/u);
    await expect(files.readFile(root, 16)).rejects.toThrow(/outside/u);
  });

  it("refuses percent-encoded traversal in any case, however many times it is wrapped", async () => {
    const { files } = open();

    await expect(files.readFile(`${root}%2e%2e/other`, 16)).rejects.toThrow(/outside/u);
    await expect(files.readFile(`${root}%2E%2E/other`, 16)).rejects.toThrow(/outside/u);
    await expect(files.readFile(`${root}a/%2E%2e/%2e%2E/b`, 16)).rejects.toThrow(/outside/u);
    await expect(files.readFile(`${root}%252E%252E/other`, 16)).rejects.toThrow(/outside/u);
    await expect(files.writeFileAtomic(`${root}%2F%2Fetc/passwd`, "{}")).rejects.toThrow(
      /outside/u,
    );
  });

  it("keeps the previous file when the staging write is interrupted", async () => {
    const { files, platform } = open();
    await files.writeFileAtomic(catalog, "first");
    dieAt(platform, `write:${catalog}.new`);

    await expect(files.writeFileAtomic(catalog, "second")).rejects.toThrow(/stopped this app/u);

    platform.interrupt = () => undefined;
    expect(text(await files.readFile(catalog, 1_024))).toBe("first");
    await files.writeFileAtomic(catalog, "third");
    expect(text(await files.readFile(catalog, 1_024))).toBe("third");
    expect([...platform.files.keys()]).toEqual([catalog]);
  });

  it("recovers the new content when the app died between the two renames", async () => {
    const { files, platform } = open();
    await files.writeFileAtomic(catalog, "first");
    dieAt(platform, `replace:${catalog}.new`);

    await expect(files.writeFileAtomic(catalog, "second")).rejects.toThrow(/stopped this app/u);
    // This is the window the platform's own overwrite loses the file in: the
    // name itself is gone, and both journal entries are on disk.
    expect(platform.files.has(catalog)).toBe(false);
    expect(platform.files.has(`${catalog}.new`)).toBe(true);
    expect(platform.files.has(`${catalog}.old`)).toBe(true);

    platform.interrupt = () => undefined;
    expect(text(await files.readFile(catalog, 1_024))).toBe("second");
    expect([...platform.files.keys()]).toEqual([catalog]);
  });

  it("restores the previous content when only the superseded copy is left", async () => {
    const { files, platform } = open();
    await files.writeFileAtomic(catalog, "first");
    platform.files.set(`${catalog}.old`, platform.files.get(catalog) ?? new Uint8Array());
    platform.files.delete(catalog);

    expect(await files.fileExists(catalog)).toBe(true);
    expect(text(await files.readFile(catalog, 1_024))).toBe("first");
    expect([...platform.files.keys()]).toEqual([catalog]);
  });

  it("reads as missing when the app died before the file ever existed", async () => {
    const { files, platform } = open();
    dieAt(platform, `write:${catalog}.new`);

    await expect(files.writeFileAtomic(catalog, "first")).rejects.toThrow(/stopped this app/u);

    platform.interrupt = () => undefined;
    expect(await files.readFile(catalog, 1_024)).toBeNull();
    expect(await files.fileExists(catalog)).toBe(false);
  });

  it("removes the journal along with the file", async () => {
    const { files, platform } = open();
    await files.writeFileAtomic(catalog, "first");
    dieAt(platform, `replace:${catalog}.new`);
    await expect(files.writeFileAtomic(catalog, "second")).rejects.toThrow(/stopped this app/u);

    platform.interrupt = () => undefined;
    expect(await files.removeFile(catalog)).toBe(true);
    expect([...platform.files.keys()]).toEqual([]);
    expect(await files.readFile(catalog, 1_024)).toBeNull();
  });

  it("does not let an interrupted write read as free ground for an exclusive claim", async () => {
    const { files, platform } = open();
    await files.writeFileAtomic(catalog, "first");
    dieAt(platform, `replace:${catalog}.new`);
    await expect(files.writeFileAtomic(catalog, "second")).rejects.toThrow(/stopped this app/u);

    platform.interrupt = () => undefined;
    await expect(files.writeFileExclusive(catalog, "third")).rejects.toThrow(/already exists/u);
  });
});
