import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  AccountCredentialSchema,
  HostCredentialSchema,
  ProtectedAuthStateSchema,
  emptyProtectedAuthState,
  type AccountCredential,
  type HostCredential,
  type ProtectedAuthState,
  type ProtectedAuthStore,
} from "@opensteer/client/auth";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { desktopNativeAuthSecretsPath } from "../app/application-paths.js";
import { ProtectedJsonFile, type DesktopSecretCryptography } from "./protected-json-file.js";
import type { DesktopPrivateFilesystem } from "./desktop-private-files.js";

const maxProtectedAuthFileBytes = 512 * 1_024;
const maxProtectedAuthPlaintextBytes = 384 * 1_024;

export type { DesktopSecretCryptography } from "./protected-json-file.js";

export class DesktopProtectedAuthStore implements ProtectedAuthStore {
  readonly #file: ProtectedJsonFile<ProtectedAuthState>;
  readonly #mutations = new MutationQueue();

  constructor(options: {
    readonly cryptography: DesktopSecretCryptography;
    readonly dataDirectory: string;
    readonly platform?: NodeJS.Platform;
    readonly privateFiles?: DesktopPrivateFilesystem;
  }) {
    this.#file = new ProtectedJsonFile({
      content: "rebuildable",
      cryptography: options.cryptography,
      filePath: desktopNativeAuthSecretsPath(options.dataDirectory),
      maxFileBytes: maxProtectedAuthFileBytes,
      maxPlaintextBytes: maxProtectedAuthPlaintextBytes,
      messages: {
        protectedState: "The Desktop authorization state",
        protectedStore: "The protected Desktop authorization store",
      },
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.privateFiles === undefined ? {} : { privateFiles: options.privateFiles }),
      schema: ProtectedAuthStateSchema,
    });
  }

  get filePath(): string {
    return this.#file.filePath;
  }

  async assertAvailable(): Promise<void> {
    await this.#file.assertAvailable();
  }

  /** Rebuildable credential cache: content this release cannot read is signed-out. */
  load(): Promise<ProtectedAuthState> {
    return this.#mutations.run(() => this.#load());
  }

  setAccount(credential: AccountCredential): Promise<ProtectedAuthState> {
    const parsed = AccountCredentialSchema.parse(credential);
    return this.#mutate((current) => ({ ...current, account: parsed }));
  }

  clearAccount(): Promise<ProtectedAuthState> {
    return this.#mutate((current) => ({ ...current, account: null }));
  }

  setHost(credential: HostCredential): Promise<ProtectedAuthState> {
    const parsed = HostCredentialSchema.parse(credential);
    return this.#mutate((current) => ({
      ...current,
      hosts: [
        ...current.hosts.filter(({ deploymentId }) => deploymentId !== parsed.deploymentId),
        parsed,
      ],
    }));
  }

  clearHost(deploymentId: DeploymentId | string): Promise<ProtectedAuthState> {
    const id = DeploymentIdSchema.parse(deploymentId);
    return this.#mutate((current) => ({
      ...current,
      hosts: current.hosts.filter(({ deploymentId: candidate }) => candidate !== id),
    }));
  }

  clearHosts(deploymentIds: readonly (DeploymentId | string)[]): Promise<ProtectedAuthState> {
    const ids = new Set(
      deploymentIds.map((deploymentId) => DeploymentIdSchema.parse(deploymentId)),
    );
    if (ids.size !== deploymentIds.length) {
      throw new Error("Desktop Host credential removal contains duplicate Deployments.");
    }
    return this.#mutate((current) => ({
      ...current,
      hosts: current.hosts.filter(({ deploymentId }) => !ids.has(deploymentId)),
    }));
  }

  clearAll(): Promise<void> {
    return this.#mutations.run(async () => {
      await this.#file.remove();
    });
  }

  #mutate(
    mutation: (current: ProtectedAuthState) => ProtectedAuthState,
  ): Promise<ProtectedAuthState> {
    return this.#mutations.run(async () => {
      const current = await this.#load();
      const next = ProtectedAuthStateSchema.parse(mutation(current));
      await this.#write(next);
      return next;
    });
  }

  async #write(state: ProtectedAuthState): Promise<void> {
    await this.#file.write(state);
  }

  async #load(): Promise<ProtectedAuthState> {
    return (await this.#file.read()) ?? emptyProtectedAuthState();
  }
}
