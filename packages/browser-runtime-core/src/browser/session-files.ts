import { open, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BrowserRuntimeError } from "../errors.js";

/** The CDP method a controller answers itself to move file bytes onto this machine. */
export const stageFileMethod = "Opensteer.stageFile";

export const maximumStagedFileChunkBytes = 256 * 1_024;
export const maximumStagedSessionBytes = 512 * 1_024 * 1_024;

const base64 = /^[A-Za-z0-9+/]*={0,2}$/u;

const StageFileParametersSchema = z.strictObject({
  data: z
    .string()
    .max(Math.ceil(maximumStagedFileChunkBytes / 3) * 4)
    .regex(base64),
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  name: z
    .string()
    .min(1)
    .refine(
      (name) =>
        Buffer.byteLength(name, "utf8") <= 255 &&
        name !== "." &&
        name !== ".." &&
        !/[/\\\0]/u.test(name),
      "File name must be one path segment.",
    ),
  offset: z.number().int().nonnegative().max(maximumStagedSessionBytes),
  /** Present only on the last chunk: the whole file's byte length. */
  size: z.number().int().nonnegative().max(maximumStagedSessionBytes).optional(),
});

interface StagedFile {
  readonly name: string;
  readonly path: string;
  written: number;
}

/**
 * One Browser Session's private folder on the Browser Runtime machine. File
 * inputs and drag data can name only files inside it, and it disappears with
 * the session. Each file keeps its original name — the page reads it as
 * `File.name` — inside a folder named for its upload.
 */
export class SessionFiles {
  readonly root: string;
  readonly #files = new Map<string, StagedFile>();
  #bytes = 0;
  #disposed = false;

  constructor(root: string) {
    if (!path.isAbsolute(root) || path.resolve(root) !== root) {
      throw new TypeError("Session files root must be an absolute normalized path.");
    }
    this.root = root;
  }

  /** Chunks arrive in order; the controller already runs one command at a time. */
  async stage(parameters: unknown): Promise<{ readonly path?: string }> {
    if (this.#disposed) {
      throw new BrowserRuntimeError("conflict", "The Browser Session has ended.");
    }
    const parsed = StageFileParametersSchema.safeParse(parameters);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BrowserRuntimeError(
        "bad_message",
        `Opensteer.stageFile ${issue?.path.join(".") || "parameters"}: ${issue?.message ?? "invalid"}`,
      );
    }
    const { data, fileId, name, offset, size } = parsed.data;
    const chunk = Buffer.from(data, "base64");
    if (chunk.byteLength > maximumStagedFileChunkBytes) {
      throw new BrowserRuntimeError("bad_message", "A staged file chunk is too large.");
    }
    let file = this.#files.get(fileId);
    if (offset === 0) {
      if (file) await this.#release(fileId, file);
      const directory = path.join(this.root, fileId);
      await mkdir(directory, { mode: 0o700, recursive: true });
      file = { name, path: path.join(directory, name), written: 0 };
      this.#files.set(fileId, file);
      await (await open(file.path, "w", 0o600)).close();
    } else if (!file || file.name !== name || file.written !== offset) {
      throw new BrowserRuntimeError(
        "bad_message",
        "Staged file chunks must arrive in order, starting at offset 0.",
      );
    }
    if (this.#bytes + chunk.byteLength > maximumStagedSessionBytes) {
      await this.#release(fileId, file);
      throw new BrowserRuntimeError(
        "conflict",
        `Files staged for one Browser Session are limited to ${maximumStagedSessionBytes / 1_024 / 1_024} MiB.`,
      );
    }
    if (chunk.byteLength > 0) {
      const handle = await open(file.path, "a");
      try {
        await handle.write(chunk);
      } finally {
        await handle.close();
      }
      file.written += chunk.byteLength;
      this.#bytes += chunk.byteLength;
    }
    if (size === undefined) return {};
    if (size !== file.written) {
      await this.#release(fileId, file);
      throw new BrowserRuntimeError(
        "bad_message",
        `The staged file is ${file.written} bytes, not the ${size} bytes it was declared as.`,
      );
    }
    return { path: file.path };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#files.clear();
    this.#bytes = 0;
    await rm(this.root, { force: true, recursive: true });
  }

  async #release(fileId: string, file: StagedFile): Promise<void> {
    this.#files.delete(fileId);
    this.#bytes -= file.written;
    await rm(path.dirname(file.path), { force: true, recursive: true });
  }
}

/** Where a runtime keeps every live session's staged files; emptied when it starts. */
export function sessionFilesRoot(profileRoot: string): string {
  return path.join(profileRoot, ".opensteer-runtime", "session-files");
}
