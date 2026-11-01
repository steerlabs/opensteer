import {
  OpensteerError,
  type BrowserProfileId,
  type DeploymentId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import type {
  BrowserAttachTicketIdentity,
  BrowserProfileStorage,
  LocalProfileBinding,
} from "@opensteer/protocol";
import type { LocalProfileInventory } from "@opensteer/protocol/browser-relay";
import { randomUUID } from "node:crypto";
import type { BrowserRuntimeTarget } from "./browser-service.js";

export type BrowserLocalProfileRepository = Pick<
  OpensteerStore,
  | "getBrowserProfileStorage"
  | "bindBrowserProfile"
  | "acknowledgeBrowserProfileReady"
  | "reconcileBrowserProfileInventory"
  | "listBrowserProfileErasureJobs"
  | "listPendingBrowserProfileDeletions"
  | "acknowledgeBrowserProfileDeletion"
>;

/** Metadata and deletion obligations; the owning engine alone keeps browser state. */
export class BrowserLocalProfiles {
  readonly options: {
    deploymentId: DeploymentId;
    repository: BrowserLocalProfileRepository;
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
  acknowledgeReady(binding: LocalProfileBinding) {
    return this.options.repository.acknowledgeBrowserProfileReady(binding);
  }

  async identity(
    profileId: BrowserProfileId,
    runnerId: RunnerId,
    target: BrowserRuntimeTarget,
  ): Promise<Extract<BrowserAttachTicketIdentity, { kind: "profile-local" }>> {
    this.options.beforeProfileOpen?.();
    if (!target.localProfileStorage) refuse("Update this computer to open browser profiles.");
    let storage = await this.storage(profileId);
    if (storage.kind === "unbound")
      storage = await this.options.repository.bindBrowserProfile({
        version: 1,
        deploymentId: this.options.deploymentId,
        profileId,
        runnerId,
        ...target.localProfileStorage,
        bindingId: randomUUID(),
      });
    if (storage.kind !== "local")
      throw new Error("Native browser profile binding was not recorded");
    this.validatePlacement(storage, runnerId, target);
    return {
      kind: "profile-local",
      binding: storage.binding,
      initialized: storage.initialized,
      readyUrl: new URL(`/v1/browser-profiles/${profileId}/ready`, this.options.baseUrl).toString(),
    };
  }
  validatePlacement(
    storage: Extract<BrowserProfileStorage, { kind: "local" }>,
    runnerId: RunnerId,
    target: BrowserRuntimeTarget,
  ): void {
    if (storage.binding.runnerId !== runnerId)
      refuse("This profile belongs to its owning computer.");
    if (!target.localProfileStorage) refuse("Update this computer to open this profile.");
    if (target.localProfileStorage.storageInstanceId !== storage.binding.storageInstanceId)
      refuse("This computer's profile storage changed. Restore the original storage instance.");
    if (target.localProfileStorage.engine !== storage.binding.engine)
      refuse("Open this profile with its original browser engine.");
  }
  async reconcileInventory(
    stream: RunnerAuxiliaryStream,
    inventory: LocalProfileInventory,
  ): Promise<void> {
    const advertised = stream.identity.modules.browser;
    if (
      !advertised?.localProfileStorage ||
      advertised.localProfileStorage.engine !== inventory.engine ||
      advertised.localProfileStorage.storageInstanceId !== inventory.storageInstanceId
    )
      refuse("The browser inventory does not match this computer's storage instance.");
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
function refuse(message: string): never {
  throw new OpensteerError({ code: "conflict", message });
}
