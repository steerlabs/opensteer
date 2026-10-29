import type { DeploymentId } from "@opensteer/core";
import {
  AccountCredentialSchema,
  HostCredentialSchema,
  ProtectedAuthStateSchema,
  emptyProtectedAuthState,
  type AccountCredential,
  type HostCredential,
  type ProtectedAuthState,
  type ProtectedAuthStore,
} from "../auth/protected-auth-store.js";

const defaultUnavailableDetail = "Protected credential storage is unavailable.";

export interface MemoryProtectedAuthStoreOptions {
  /** Flipped by a test to make storage usable again without a new store. */
  readonly availability?: { available: boolean; detail?: string };
  /** Makes every write reject, as a locked credential store does. */
  readonly writeFailure?: string;
}

/**
 * The `ProtectedAuthStore` contract in memory, for this package's own tests.
 *
 * Whether the medium is really protected is the platform implementation's
 * guarantee and is tested where that implementation lives. What the OAuth
 * manager needs to be tested against is the contract: storage that can be
 * unusable, become usable again, and reject one write.
 */
export class MemoryProtectedAuthStore implements ProtectedAuthStore {
  readonly #availability: { available: boolean; detail?: string };
  readonly #writeFailure: string | null;
  #state: ProtectedAuthState = emptyProtectedAuthState();

  constructor(options: MemoryProtectedAuthStoreOptions = {}) {
    this.#availability = options.availability ?? { available: true };
    this.#writeFailure = options.writeFailure ?? null;
  }

  async assertAvailable(): Promise<void> {
    this.#assertAvailable();
  }

  async load(): Promise<ProtectedAuthState> {
    this.#assertAvailable();
    return this.#state;
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
    return this.#mutate((current) => ({
      ...current,
      hosts: current.hosts.filter((candidate) => candidate.deploymentId !== deploymentId),
    }));
  }

  clearHosts(deploymentIds: readonly (DeploymentId | string)[]): Promise<ProtectedAuthState> {
    const ids = new Set<string>(deploymentIds);
    return this.#mutate((current) => ({
      ...current,
      hosts: current.hosts.filter(({ deploymentId }) => !ids.has(deploymentId)),
    }));
  }

  async #mutate(
    mutation: (current: ProtectedAuthState) => ProtectedAuthState,
  ): Promise<ProtectedAuthState> {
    this.#assertAvailable();
    if (this.#writeFailure !== null) throw new Error(this.#writeFailure);
    this.#state = ProtectedAuthStateSchema.parse(mutation(this.#state));
    return this.#state;
  }

  #assertAvailable(): void {
    if (this.#availability.available) return;
    throw new Error(this.#availability.detail ?? defaultUnavailableDetail);
  }
}
