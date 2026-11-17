import { Storage } from "@google-cloud/storage";
import { createReadStream } from "node:fs";
import { link, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { addAbortSignal, type Readable } from "node:stream";

export interface TeamFileRange {
  start?: number;
  end?: number;
  signal?: AbortSignal;
}
export interface TeamFileObject {
  key: string;
  generation: string;
}
export interface TeamFileStore {
  put(key: string, stagedPath: string): Promise<string>;
  read(key: string, range?: TeamFileRange): Readable;
  delete(key: string, generation: string): Promise<void>;
  list(prefix: string): AsyncIterable<TeamFileObject>;
}
function checkedKey(key: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("Invalid team file key");
  return key;
}
function missing(error: unknown) {
  return (
    error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === 404)
  );
}
export class LocalTeamFileStore implements TeamFileStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async put(key: string, stagedPath: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, checkedKey(key));
    await link(stagedPath, target);
    return (await stat(target, { bigint: true })).ino.toString();
  }
  read(key: string, range: TeamFileRange = {}) {
    return createReadStream(join(this.directory, checkedKey(key)), {
      ...range,
      highWaterMark: 64 * 1024,
    });
  }
  async delete(key: string, generation: string) {
    const target = join(this.directory, checkedKey(key));
    try {
      if ((await stat(target, { bigint: true })).ino.toString() === generation)
        await unlink(target);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  async *list(prefix: string) {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const key of names)
      if (key.startsWith(prefix)) {
        try {
          yield {
            key,
            generation: (
              await stat(join(this.directory, checkedKey(key)), { bigint: true })
            ).ino.toString(),
          };
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
  }
}
export class GcsTeamFileStore implements TeamFileStore {
  readonly #bucket;
  readonly prefix: string;
  constructor(bucket: string, prefix: string, storage = new Storage()) {
    this.prefix = prefix;
    if (
      !prefix ||
      !prefix.endsWith("/") ||
      prefix.startsWith("/") ||
      prefix.split("/").includes("..")
    )
      throw new Error("A team managed-folder prefix ending in / is required");
    this.#bucket = storage.bucket(bucket);
  }
  async put(key: string, stagedPath: string) {
    const [file] = await this.#bucket.upload(stagedPath, {
      destination: this.prefix + checkedKey(key),
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    const generation = file.metadata.generation;
    if (!generation) throw new Error("Storage did not return an object generation");
    return String(generation);
  }
  read(key: string, { signal, ...range }: TeamFileRange = {}) {
    const stream = this.#bucket
      .file(this.prefix + checkedKey(key))
      .createReadStream({ ...range, decompress: false });
    return signal ? addAbortSignal(signal, stream) : stream;
  }
  async delete(key: string, generation: string) {
    try {
      await this.#bucket
        .file(this.prefix + checkedKey(key))
        .delete({ ifGenerationMatch: generation });
    } catch (error) {
      if (!missing(error) && !(error instanceof Error && "code" in error && error.code === 412))
        throw error;
    }
  }
  async *list(prefix: string) {
    const stream = this.#bucket.getFilesStream({ prefix: this.prefix + prefix });
    for await (const file of stream) {
      const entry = file as { name: string; metadata: { generation?: string | number } };
      if (entry.metadata.generation)
        yield {
          key: entry.name.slice(this.prefix.length),
          generation: String(entry.metadata.generation),
        };
    }
  }
}
