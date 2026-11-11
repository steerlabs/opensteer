import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import { DeploymentCatalogSchema } from "@opensteer/client/connections";
import { ProtectedAuthStateSchema } from "@opensteer/client/auth";
import {
  readPrivateFileText,
  replacePrivateFileAtomically,
} from "@opensteer/shared/atomicPrivateFile";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { syncDirectory } from "@opensteer/shared/privateFiles";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { lstat, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  desktopDeploymentPaths,
  desktopDeploymentCatalogPath,
  desktopNativeAuthSecretsPath,
} from "../app/application-paths.js";
import {
  ProtectedJsonFile,
  type DesktopSecretCryptography,
} from "../secrets/protected-json-file.js";

const JournalSchema = z.strictObject({
  version: z.literal(1),
  deploymentId: DeploymentIdSchema,
  resetId: z.uuid(),
  next: z.number().int().min(0).max(5),
  complete: z.boolean(),
});
type Journal = z.infer<typeof JournalSchema>;
export interface PersonalOldDataState {
  readonly kind: "old-data";
  readonly deploymentId: DeploymentId;
  readonly entries: readonly { readonly source: string; readonly destination: string }[];
}

/** Only the supervisor may call execute, after its existing shutdown has completed. */
export class PersonalDataReset {
  readonly #root: string;
  readonly #cryptography: DesktopSecretCryptography;
  readonly #queue = new MutationQueue();
  readonly #afterRename: ((index: number) => Promise<void>) | undefined;
  constructor(options: {
    dataDirectory: string;
    cryptography: DesktopSecretCryptography;
    afterRename?: (index: number) => Promise<void>;
  }) {
    this.#root = path.resolve(options.dataDirectory);
    this.#cryptography = options.cryptography;
    this.#afterRename = options.afterRename;
  }

  async plan(deploymentId: DeploymentId): Promise<PersonalOldDataState> {
    const pending = await this.#read();
    const journal =
      pending && !pending.complete
        ? pending
        : {
            version: 1 as const,
            deploymentId,
            resetId: randomUUID(),
            next: 0,
            complete: false,
          };
    if (journal.deploymentId !== deploymentId)
      throw new Error("Another Personal reset is pending.");
    return this.#plan(journal);
  }

  async needsFreshStart(): Promise<boolean> {
    const journal = await this.#read();
    return (
      journal !== null && !(await exists(path.join(this.#root, "personal-deployment.v1.json")))
    );
  }

  async pending(): Promise<PersonalOldDataState | null> {
    const journal = await this.#read();
    return journal && !journal.complete ? this.#plan(journal) : null;
  }

  execute(plan: PersonalOldDataState): Promise<void> {
    return this.#queue.run(async () => {
      await this.#verifyParents();
      const existing = await this.#read();
      const resetId = plan.entries[0]?.destination.split(".set-aside-")[1];
      const journal =
        existing && !existing.complete
          ? existing
          : JournalSchema.parse({
              version: 1,
              deploymentId: plan.deploymentId,
              resetId,
              next: 0,
              complete: false,
            });
      if (JSON.stringify(this.#plan(journal)) !== JSON.stringify(plan))
        throw new Error("Personal reset plan changed.");
      // The durable intent precedes every rename; source/destination presence closes the crash window.
      await this.#write(journal);
      for (let index = journal.next; index < plan.entries.length; index++) {
        const entry = plan.entries[index]!;
        const source = await exists(entry.source);
        const destination = await exists(entry.destination);
        if (source && destination) throw new Error("Personal reset destination already exists.");
        if (source) {
          await rename(entry.source, entry.destination);
          await syncDirectory(path.dirname(entry.source));
          await this.#afterRename?.(index);
        }
        journal.next = index + 1;
        await this.#write(journal);
      }
      await this.#restoreOtherConnections(plan);
      journal.complete = true;
      await this.#write(journal);
    });
  }

  #plan(journal: Journal): PersonalOldDataState {
    const paths = desktopDeploymentPaths(this.#root, journal.deploymentId);
    return {
      kind: "old-data",
      deploymentId: journal.deploymentId,
      entries: [
        paths.rootDirectory,
        paths.browserProfilesDirectory,
        desktopDeploymentCatalogPath(this.#root),
        desktopNativeAuthSecretsPath(this.#root),
        path.join(this.#root, "personal-deployment.v1.json"),
      ].map((source) => ({
        source,
        destination: `${source}.set-aside-${journal.resetId}`,
      })),
    };
  }

  async #restoreOtherConnections(plan: PersonalOldDataState): Promise<void> {
    const catalog = plan.entries[2]!;
    const content = await this.#text(catalog.destination);
    if (content !== undefined) {
      const state = DeploymentCatalogSchema.parse(JSON.parse(content));
      const deployments = state.deployments.filter(
        ({ authority }) => authority.document.deploymentId !== plan.deploymentId,
      );
      const selectedDeploymentId = deployments.some(
        ({ authority }) => authority.document.deploymentId === state.selectedDeploymentId,
      )
        ? state.selectedDeploymentId
        : (deployments[0]?.authority.document.deploymentId ?? null);
      await replacePrivateFileAtomically(
        catalog.source,
        JSON.stringify(
          DeploymentCatalogSchema.parse({
            ...state,
            deployments,
            selectedDeploymentId,
            revision: state.revision + 1,
          }),
        ),
      );
    }
    const auth = plan.entries[3]!;
    const protectedFile = (filePath: string) =>
      new ProtectedJsonFile({
        content: "critical",
        cryptography: this.#cryptography,
        filePath,
        maxFileBytes: 512 * 1024,
        maxPlaintextBytes: 384 * 1024,
        messages: {
          protectedState: "Desktop authorization state",
          protectedStore: "Desktop authorization store",
        },
        schema: ProtectedAuthStateSchema,
      });
    const state = await protectedFile(auth.destination).read();
    if (state)
      await protectedFile(auth.source).write({
        ...state,
        hosts: state.hosts.filter(({ deploymentId }) => deploymentId !== plan.deploymentId),
      });
  }

  async #verifyParents(): Promise<void> {
    for (const directory of [
      this.#root,
      path.join(this.#root, "deployments"),
      path.join(this.#root, "session"),
      path.join(this.#root, "session/browser-profiles"),
    ]) {
      if (await exists(directory)) {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new Error("Personal reset requires real storage directories.");
      }
    }
  }
  #journalPath(): string {
    return path.join(this.#root, "personal-reset.v1.json");
  }
  async #text(file: string): Promise<string | undefined> {
    return readPrivateFileText(file, 1024 * 1024, {
      invalid: () => new Error("Personal reset state is invalid."),
      exposed: () => new Error("Personal reset state is not private."),
    });
  }
  async #read(): Promise<Journal | null> {
    await this.#verifyParents();
    const content = await this.#text(this.#journalPath());
    return content === undefined ? null : JournalSchema.parse(JSON.parse(content));
  }
  #write(journal: Journal): Promise<void> {
    return replacePrivateFileAtomically(this.#journalPath(), JSON.stringify(journal));
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) throw new Error("Personal reset refuses symbolic links.");
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export class PersonalOldDatabaseError extends Error {
  constructor() {
    super("This database belongs to an earlier Opensteer lineage. Start fresh to continue.");
    this.name = "PersonalOldDatabaseError";
  }
}

export function isOldDatabaseDiagnostic(diagnostic: string): boolean {
  return /(?:^|\n)MigrationLineageError: /u.test(diagnostic);
}
