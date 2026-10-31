import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  OpensteerError,
  type BrowserProfileId,
  type DeploymentId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type {
  BrowserAttachTicketIdentity,
  BrowserProfileStorage,
  CompleteProfileInitialization,
  FrozenProfileSeed,
  LocalProfileBinding,
} from "@opensteer/protocol";
import type { LocalProfileInventory } from "@opensteer/protocol/browser-relay";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import type { BrowserProfileVault } from "./profile-vault.js";
import type { BrowserRuntimeTarget } from "./browser-service.js";

export type BrowserLocalProfileRepository = Pick<
  OpensteerStore,
  | "getBrowserProfileStorage"
  | "reserveBrowserProfileInitialization"
  | "readBrowserProfileInitialization"
  | "completeBrowserProfileInitialization"
  | "reconcileBrowserProfileInventory"
  | "listBrowserProfileErasureJobs"
  | "listPendingBrowserProfileDeletions"
  | "acknowledgeBrowserProfileDeletion"
>;

/** Native authority is independent of the legacy session lease and checkpoint lifecycle. */
export class BrowserLocalProfiles {
  readonly options: {
    deploymentId: DeploymentId;
    repository: BrowserLocalProfileRepository;
    vault: BrowserProfileVault;
    baseUrl: URL;
    beforeProfileOpen?: () => void;
    onReconciled?: (profileId: BrowserProfileId) => Promise<void>;
  };
  constructor(options: BrowserLocalProfiles["options"]) {
    this.options = options;
  }

  storage(profileId: BrowserProfileId) {
    return this.options.repository.getBrowserProfileStorage(profileId);
  }
  pendingDeletions(ownerId: UserId) {
    return this.options.repository.listPendingBrowserProfileDeletions(ownerId);
  }
  jobs(runnerId: RunnerId) {
    return this.options.repository.listBrowserProfileErasureJobs(runnerId);
  }
  acknowledgeDeletion(input: Parameters<OpensteerStore["acknowledgeBrowserProfileDeletion"]>[0]) {
    return this.options.repository.acknowledgeBrowserProfileDeletion(input);
  }

  async identity(
    profileId: BrowserProfileId,
    runnerId: RunnerId,
    target: BrowserRuntimeTarget,
  ): Promise<Extract<BrowserAttachTicketIdentity, { kind: "profile-local" }> | null> {
    this.options.beforeProfileOpen?.();
    let storage = await this.storage(profileId);
    if (!target.localProfileStorage) {
      if (storage.kind !== "vault") refuse("Update this computer to open this profile.");
      return null;
    }
    if (storage.kind === "vault") {
      const loaded = await this.options.vault.load(profileId);
      const seed = this.options.vault.frozenSeed(loaded);
      const binding: LocalProfileBinding = {
        version: 1,
        deploymentId: this.options.deploymentId,
        profileId,
        runnerId,
        ...target.localProfileStorage,
        bindingId: randomUUID(),
      };
      storage = await this.reserve(binding, seed, true);
    }
    if (storage.kind === "vault") throw new Error("Profile conversion was not reserved");
    this.validatePlacement(storage, runnerId, target);
    if (storage.kind === "local") return { kind: "profile-local", binding: storage.binding };
    await this.reserve(storage.binding, storage.seed);
    await this.options.repository.readBrowserProfileInitialization({
      profileId,
      tokenHash: hashToken(this.options.vault.initializationToken(storage.binding, storage.seed)),
    });
    return {
      kind: "profile-local",
      binding: storage.binding,
      initialization: {
        seed: storage.seed,
        initializationUrl: new URL(
          `/v1/browser-profile-initialization/${profileId}`,
          this.options.baseUrl,
        ).toString(),
        initializationToken: this.options.vault.initializationToken(storage.binding, storage.seed),
      },
    };
  }

  validatePlacement(
    storage: Exclude<BrowserProfileStorage, { kind: "vault" }>,
    runnerId: RunnerId,
    target: BrowserRuntimeTarget,
  ) {
    if (storage.binding.runnerId !== runnerId)
      refuse("This profile belongs to another computer. Open it on its owning computer.");
    if (!target.localProfileStorage) refuse("Update this computer to open this profile.");
    if (target.localProfileStorage.storageInstanceId !== storage.binding.storageInstanceId)
      refuse(
        "This computer's profile storage changed. Restore the original browser profile storage instance.",
      );
    if (target.localProfileStorage.engine !== storage.binding.engine)
      refuse(
        "This profile belongs to a different browser engine. Open it with its original engine.",
      );
  }

  private reserve(
    binding: LocalProfileBinding,
    seed: FrozenProfileSeed,
    adoptExistingBinding = false,
  ) {
    const token = this.options.vault.initializationToken(binding, seed);
    return this.options.repository.reserveBrowserProfileInitialization({
      binding,
      seed,
      adoptExistingBinding,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
  }

  async seed(profileId: BrowserProfileId, token: string) {
    const stored = await this.options.repository.readBrowserProfileInitialization({
      profileId,
      tokenHash: hashToken(token),
    });
    const snapshot = this.options.vault.openFrozenRevision(profileId, stored.revision ?? null);
    const seed = this.options.vault.frozenSeed({ revision: stored.seed.revision, snapshot });
    if (seed.digest !== stored.seed.digest)
      refuse("The frozen profile seed does not match. Restore the original recovery artifact.");
    return { binding: stored.binding, seed: stored.seed, snapshot };
  }

  async complete(profileId: BrowserProfileId, token: string, input: CompleteProfileInitialization) {
    if (
      input.binding.deploymentId !== this.options.deploymentId ||
      input.binding.profileId !== profileId ||
      !equalToken(token, this.options.vault.initializationToken(input.binding, input.seed))
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Profile initialization authorization is invalid.",
      });
    const result = await this.options.repository.completeBrowserProfileInitialization({
      ...input,
      tokenHash: hashToken(token),
    });
    if (result.kind !== "local") throw new Error("Profile initialization did not complete");
    return { state: "local" as const, binding: result.binding };
  }

  async reconcileInventory(stream: RunnerAuxiliaryStream, inventory: LocalProfileInventory) {
    const advertised = stream.identity.modules.browser;
    if (
      advertised?.localProfiles !== 1 ||
      !advertised.localProfileStorage ||
      advertised.localProfileStorage.engine !== inventory.engine ||
      advertised.localProfileStorage.storageInstanceId !== inventory.storageInstanceId
    )
      refuse("The browser inventory does not match this computer's advertised storage instance.");
    const seen = new Set<string>();
    for (const claim of inventory.profiles) {
      const binding = claim.binding;
      if (
        binding.deploymentId !== this.options.deploymentId ||
        binding.runnerId !== stream.identity.runnerId ||
        binding.storageInstanceId !== inventory.storageInstanceId ||
        binding.engine !== inventory.engine ||
        seen.has(binding.profileId)
      )
        refuse("The browser inventory contains a conflicting profile binding.");
      seen.add(binding.profileId);
      await this.options.repository.reconcileBrowserProfileInventory(claim);
      await this.options.onReconciled?.(binding.profileId);
    }
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function refuse(message: string): never {
  throw new OpensteerError({ code: "conflict", message });
}
