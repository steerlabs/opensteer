import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ComputerFolder, RunnerId } from "@opensteer/core";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";

const maximumInstructionBytes = 100 * 1024;

/** Agent home, checked for this Run. */
export interface AgentHomeWorkspace {
  readonly path: string;
  /** Agent home's AGENTS.md, absent for shared Messaging, which gets no personal context. */
  readonly instructions: string | undefined;
}
export interface AgentHomeAccess {
  prepare(input: {
    readonly agentHome: ComputerFolder;
    readonly personalContext?: boolean;
    readonly signal: AbortSignal;
  }): Promise<AgentHomeWorkspace>;
  /** A folder that must resolve inside Agent home, such as an app server's. */
  folder(folder: ComputerFolder, agentHome: ComputerFolder): Promise<string>;
}

/**
 * The Host creates Agent home; the Runner only checks it. The path the Host sends is canonical,
 * so one that no longer resolves to itself (a swapped symlink) is refused rather than followed.
 */
export class AgentHomeManager implements AgentHomeAccess {
  readonly computerId: RunnerId;
  constructor(computerId: RunnerId) {
    this.computerId = computerId;
  }

  async prepare(input: {
    readonly agentHome: ComputerFolder;
    readonly personalContext?: boolean;
    readonly signal: AbortSignal;
  }): Promise<AgentHomeWorkspace> {
    input.signal.throwIfAborted();
    const path = await this.#home(input.agentHome);
    const instructions =
      input.personalContext === false ? undefined : await readInstructions(join(path, "AGENTS.md"));
    input.signal.throwIfAborted();
    return { path, instructions };
  }

  async folder(folder: ComputerFolder, agentHome: ComputerFolder): Promise<string> {
    const home = await this.#home(agentHome);
    const path = await this.#directory(folder);
    const inside = relative(home, path);
    if (inside.startsWith("..") || isAbsolute(inside))
      throw new Error(`${folder.path} resolves outside Agent home`);
    return path;
  }

  async #home(agentHome: ComputerFolder): Promise<string> {
    const path = await this.#directory(agentHome);
    if (path !== agentHome.path)
      throw new Error(`Agent home ${agentHome.path} now resolves to ${path}. Restore it.`);
    return path;
  }

  async #directory(folder: ComputerFolder): Promise<string> {
    if (folder.computerId !== this.computerId)
      throw new Error("Agent home belongs to the hosting computer");
    if (!isAbsolute(folder.path) || folder.path.includes("\0"))
      throw new Error("Agent home must be an absolute path");
    const canonical = await realpath(folder.path).catch((cause: unknown) => {
      throw new Error(`${folder.path} is missing`, { cause });
    });
    if (!(await stat(canonical)).isDirectory()) throw new Error(`${folder.path} is not a folder`);
    return canonical;
  }
}

async function readInstructions(path: string): Promise<string | undefined> {
  const source = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!source) return undefined;
  const bytes = await readBoundedRegularFile(source, maximumInstructionBytes, {
    changedError: () => new Error("Agent home instructions changed during read"),
    invalidFileError: () => new Error("Agent home instructions must be a regular file"),
    missing: "null",
    sizeError: () => new Error("Agent home instructions file is too large"),
  });
  if (!bytes) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error("Agent home instructions are not valid UTF-8", { cause });
  }
  return `Instructions from ${source}:\n${text}`;
}
