import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  replacePrivateFileAtomically,
  readPrivateFileText,
} from "@opensteer/shared/atomicPrivateFile";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { ensurePrivateDirectory, syncDirectory } from "@opensteer/shared/privateFiles";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { desktopDeploymentPaths } from "../app/application-paths.js";

export type BrowserProfileReleaseState = "released" | "retained-until-exit";

/** Removal markers outlive enrollment slots and Electron's retained Sessions. */
export class DesktopBrowserProfileErasure {
  readonly #dataDirectory: string;
  readonly #releaseState: (root: string) => BrowserProfileReleaseState;
  readonly #mutations = new MutationQueue();
  /** Deployments whose engine did not stop; only a new process can erase under them. */
  readonly #held = new Set<DeploymentId>();

  constructor(
    dataDirectory: string,
    releaseState: (root: string) => BrowserProfileReleaseState = () => "released",
  ) {
    this.#dataDirectory = path.resolve(dataDirectory);
    this.#releaseState = releaseState;
  }

  erase(deploymentId: DeploymentId, engine: "stopped" | "held" = "stopped"): Promise<void> {
    return this.#mutations.run(async () => {
      if (engine === "held") this.#held.add(deploymentId);
      await this.#verifyParents();
      await ensurePrivateDirectory(this.#markerDirectory());
      await replacePrivateFileAtomically(this.#marker(deploymentId), '{"version":1}\n');
      await this.#finish(deploymentId);
    });
  }

  prepare(deploymentId: DeploymentId): Promise<void> {
    return this.#mutations.run(async () => {
      await this.#verifyParents();
      if (await this.#pending(deploymentId)) {
        if (!(await this.#finish(deploymentId))) {
          throw new Error(
            "Restart Opensteer to finish removing this Deployment's browser profiles.",
          );
        }
      }
    });
  }

  finishPending(): Promise<void> {
    return this.#mutations.run(async () => {
      await this.#verifyParents();
      if (!(await realDirectoryIfPresent(this.#markerDirectory()))) return;
      for (const name of await readdir(this.#markerDirectory())) {
        const parsed = DeploymentIdSchema.safeParse(name.replace(/\.json$/u, ""));
        if (!parsed.success || name !== `${parsed.data}.json`) continue;
        if (await this.#pending(parsed.data)) await this.#finish(parsed.data);
      }
    });
  }

  async #finish(deploymentId: DeploymentId): Promise<boolean> {
    const root = desktopDeploymentPaths(this.#dataDirectory, deploymentId).browserProfilesDirectory;
    await realDirectoryIfPresent(path.dirname(root));
    if (await realDirectoryIfPresent(root)) {
      if (this.#held.has(deploymentId)) return false;
      if (this.#releaseState(await realpath(root)) === "retained-until-exit") return false;
      await rm(root, { force: true, recursive: true });
      await syncDirectory(path.dirname(root));
    }
    await rm(this.#marker(deploymentId), { force: true });
    await syncDirectory(this.#markerDirectory());
    return true;
  }

  hasPending(deploymentId: DeploymentId): Promise<boolean> {
    return this.#pending(deploymentId);
  }

  async #pending(deploymentId: DeploymentId): Promise<boolean> {
    if (!(await realDirectoryIfPresent(this.#markerDirectory()))) return false;
    const content = await readPrivateFileText(this.#marker(deploymentId), 128, {
      invalid: invalidStorage,
      exposed: invalidStorage,
    });
    if (content === undefined) return false;
    if (content !== '{"version":1}\n') throw invalidStorage();
    return true;
  }

  async #verifyParents(): Promise<void> {
    await realDirectoryIfPresent(this.#dataDirectory);
    await realDirectoryIfPresent(path.join(this.#dataDirectory, "session"));
    await realDirectoryIfPresent(path.join(this.#dataDirectory, "session", "browser-profiles"));
    await realDirectoryIfPresent(this.#markerDirectory());
  }

  #markerDirectory(): string {
    return path.join(this.#dataDirectory, "session", "browser-profile-removals");
  }

  #marker(deploymentId: DeploymentId): string {
    return path.join(this.#markerDirectory(), `${DeploymentIdSchema.parse(deploymentId)}.json`);
  }
}

async function realDirectoryIfPresent(directory: string): Promise<boolean> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalidStorage();
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function invalidStorage(): Error {
  return new Error("Browser profile removal requires real app-owned storage directories.");
}
