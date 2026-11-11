import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RunnerId } from "@opensteer/core";
import type { PersonalExecutionLocation } from "@opensteer/protocol";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";

const maximumInstructionBytes = 100 * 1024;
export interface RunFolder {
  readonly path: string;
  readonly agentHomePath: string;
  readonly instructions: string | undefined;
}
export interface FolderAccessManager {
  prepare(input: {
    readonly location: PersonalExecutionLocation;
    readonly signal: AbortSignal;
  }): Promise<RunFolder>;
  writableRoots(folder: RunFolder): readonly string[];
}

export class TaskFolderManager implements FolderAccessManager {
  readonly computerId: RunnerId;
  constructor(computerId: RunnerId) {
    this.computerId = computerId;
  }
  async prepare(input: {
    readonly location: PersonalExecutionLocation;
    readonly signal: AbortSignal;
  }): Promise<RunFolder> {
    const { folder, agentHome } = input.location;
    input.signal.throwIfAborted();
    if (folder.computerId !== this.computerId || agentHome.computerId !== this.computerId)
      throw new Error("Task folders must belong to the hosting computer");
    const directory = async (path: string) => {
      if (!isAbsolute(path) || path.includes("\0"))
        throw new Error("Task folder must be an absolute path");
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory())
        throw new Error("Task folder must be a directory");
      return canonical;
    };
    const [path, agentHomePath] = await Promise.all([
      directory(folder.path),
      directory(agentHome.path),
    ]);
    const seen = new Set<string>();
    const instructions: string[] = [
      `Agent home folder: ${agentHomePath}\nPersonal memory and standing instructions stay here, including when the task works in another folder.`,
    ];
    for (const root of new Set([agentHomePath, path])) {
      input.signal.throwIfAborted();
      const source = await realpath(join(root, "AGENTS.md")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (!source || seen.has(source)) continue;
      seen.add(source);
      const bytes = await readBoundedRegularFile(source, maximumInstructionBytes, {
        changedError: () => new Error("Task instructions changed during read"),
        invalidFileError: () => new Error("Task instructions must be a regular file"),
        sizeError: () => new Error("Task instructions file is too large"),
      });
      if (!bytes) continue;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (cause) {
        throw new Error("Task instructions are not valid UTF-8", { cause });
      }
      instructions.push(`Instructions from ${source}:\n${text}`);
    }
    input.signal.throwIfAborted();
    return { path, agentHomePath, instructions: instructions.join("\n\n") };
  }
  writableRoots(folder: RunFolder): readonly string[] {
    return [...new Set([folder.path, folder.agentHomePath])];
  }
}
