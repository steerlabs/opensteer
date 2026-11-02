import { isAbsolute, resolve } from "node:path";
import type { EnvironmentId, UserId, WorkspaceKind } from "@opensteer/core";
import type {
  LocalWorkspaceExecutionAccessPlan,
  WorkspaceExecutionAccessPlan,
  WorkspaceNamespace,
} from "@opensteer/workspace";
import type { LocalWorkspaceAuthority } from "@opensteer/workspace-local";

const MAX_INSTRUCTIONS_BYTES = 100 * 1_024;

export interface RunWorkspace {
  readonly instructions: string | undefined;
  readonly path: string;
}

export interface WorkspaceAccessManager {
  prepare(input: {
    readonly instructionsPath: string | null;
    readonly plan: WorkspaceExecutionAccessPlan;
    readonly signal: AbortSignal;
  }): Promise<RunWorkspace>;
  writableRoots(input: {
    readonly plan: WorkspaceExecutionAccessPlan;
    readonly requestedBy: UserId;
    readonly workspaceKind: WorkspaceKind;
    readonly workspacePath: string;
  }): readonly string[];
}

export interface WorkspaceInstructionReader {
  read(
    input: { readonly path: string; readonly root: string },
    signal: AbortSignal,
  ): Promise<{ readonly content: Buffer }>;
}

export interface RunWorkspaceManagerOptions {
  readonly local?: {
    readonly environmentId: EnvironmentId;
    readonly namespace: WorkspaceNamespace;
    readonly preflight?: (signal?: AbortSignal) => Promise<void>;
    readonly resolver: Pick<LocalWorkspaceAuthority, "preflight" | "resolveExecutionPath">;
    readonly root: string;
    readonly workspaceInstructionReader: WorkspaceInstructionReader;
  };
}

/**
 * Product-facing Workspace access router. A plan names its backing explicitly;
 * the Runner never guesses a storage implementation or substitutes another one.
 */
export class RunWorkspaceManager implements WorkspaceAccessManager {
  readonly #local: RunWorkspaceManagerOptions["local"];

  constructor(options: RunWorkspaceManagerOptions) {
    if (!options.local) {
      throw new Error("Runner must configure at least one Workspace backing");
    }
    this.#local = options.local;
  }

  async preflight(signal?: AbortSignal): Promise<{
    readonly workspaceBackings: readonly "local-directory"[];
  }> {
    signal?.throwIfAborted();
    const workspaceBackings: "local-directory"[] = [];
    if (this.#local) {
      const health = await this.#local.resolver.preflight(signal);
      if (!health.available) {
        throw new Error(`Local Workspace storage is unavailable: ${health.detail}`);
      }
      await this.#local.preflight?.(signal);
      workspaceBackings.push("local-directory");
    }
    return { workspaceBackings };
  }

  async prepare(input: {
    readonly instructionsPath: string | null;
    readonly plan: WorkspaceExecutionAccessPlan;
    readonly signal: AbortSignal;
  }): Promise<RunWorkspace> {
    input.signal.throwIfAborted();
    switch (input.plan.kind) {
      case "local-directory":
        return this.#prepareLocal(input.plan, input.instructionsPath, input.signal);
      default:
        throw new Error("Workspace storage is unavailable: relocation-required");
    }
  }

  writableRoots(input: {
    readonly plan: WorkspaceExecutionAccessPlan;
    readonly requestedBy: UserId;
    readonly workspaceKind: WorkspaceKind;
    readonly workspacePath: string;
  }): readonly string[] {
    return [resolve(input.workspacePath)];
  }

  async #prepareLocal(
    plan: LocalWorkspaceExecutionAccessPlan,
    instructionsPath: string | null,
    signal: AbortSignal,
  ): Promise<RunWorkspace> {
    const local = this.#local;
    if (!local) {
      throw new Error("Runner does not support local-directory Workspace access");
    }
    const path = await local.resolver.resolveExecutionPath({
      environmentId: local.environmentId,
      plan,
    });
    signal.throwIfAborted();
    return {
      instructions: await readWorkspaceInstructions(
        local.workspaceInstructionReader,
        path,
        instructionsPath,
        signal,
      ),
      path,
    };
  }
}

async function readWorkspaceInstructions(
  reader: WorkspaceInstructionReader,
  workspacePath: string,
  instructionsPath: string | null,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (instructionsPath === null) return undefined;
  if (isAbsolute(instructionsPath) || instructionsPath.includes("\0")) {
    throw new Error("Workspace instructions path must be relative to the workspace");
  }
  let result: { readonly content: Buffer };
  try {
    result = await reader.read({ path: instructionsPath, root: workspacePath }, signal);
  } catch (error) {
    if (isInstructionNotFoundError(error)) return undefined;
    throw error;
  }
  if (result.content.byteLength > MAX_INSTRUCTIONS_BYTES) {
    throw new Error("Workspace instructions file is invalid or too large");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.content);
  } catch (error) {
    throw new Error("Workspace instructions file is not valid UTF-8", { cause: error });
  }
}

function isInstructionNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === "not-found"
  );
}
