import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import type { BrowserProfileStorage, LocalProfileBinding } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import {
  BrowserLocalProfiles,
  type BrowserLocalProfileRepository,
} from "./browser-local-profiles.js";
import type { BrowserRuntimeTarget } from "./browser-service.js";

it("binds an empty profile once, acknowledges readiness durably, and refuses changed placement", async () => {
  let storage: BrowserProfileStorage = { kind: "unbound" };
  const deploymentId = createId("deployment"),
    profileId = createId("browserProfile"),
    runnerId = createId("runner");
  const bind = vi.fn(
    async (binding: LocalProfileBinding) =>
      (storage = { kind: "local", binding, initialized: false }),
  );
  const acknowledge = vi.fn(async (binding: LocalProfileBinding) => {
    if (storage.kind !== "local" || JSON.stringify(binding) !== JSON.stringify(storage.binding))
      throw new Error("binding mismatch");
    storage = { ...storage, initialized: true };
  });
  const repository = {
    getBrowserProfileStorage: async () => storage,
    bindBrowserProfile: bind,
    acknowledgeBrowserProfileReady: acknowledge,
  } as unknown as BrowserLocalProfileRepository;
  const profiles = new BrowserLocalProfiles({
    deploymentId,
    repository,
    baseUrl: new URL("https://host.test"),
  });
  const target = {
    localProfileStorage: { engine: "electron", storageInstanceId: randomUUID() },
  } as BrowserRuntimeTarget;
  const first = await profiles.identity(profileId, runnerId, target);
  expect(first).toMatchObject({
    kind: "profile-local",
    initialized: false,
    readyUrl: `https://host.test/v1/browser-profiles/${profileId}/ready`,
  });
  await profiles.acknowledgeReady(first.binding);
  expect(await profiles.identity(profileId, runnerId, target)).toEqual({
    ...first,
    initialized: true,
  });
  expect(bind).toHaveBeenCalledTimes(1);
  await expect(profiles.identity(profileId, createId("runner"), target)).rejects.toThrow(
    "owning computer",
  );
  await expect(
    profiles.identity(profileId, runnerId, {
      ...target,
      localProfileStorage: { ...target.localProfileStorage!, storageInstanceId: randomUUID() },
    }),
  ).rejects.toThrow("storage changed");
  await expect(
    profiles.identity(profileId, runnerId, {
      ...target,
      localProfileStorage: { ...target.localProfileStorage!, engine: "chromium" },
    }),
  ).rejects.toThrow("original browser engine");
  expect(bind).toHaveBeenCalledTimes(1);
});

it("forwards affected usage thread IDs to onReconciled when inventory reconciliation archives a deleted profile", async () => {
  const deploymentId = createId("deployment");
  const profileId = createId("browserProfile");
  const runnerId = createId("runner");
  const threadId = createId("thread");
  const storageInstanceId = randomUUID();
  const binding: LocalProfileBinding = {
    version: 1,
    deploymentId,
    profileId,
    runnerId,
    storageInstanceId,
    bindingId: randomUUID(),
    engine: "chromium",
  };
  const onReconciled = vi.fn(async () => undefined);
  const repository = {
    reconcileBrowserProfileInventory: vi.fn(async () => ({ usageThreadIds: [threadId] })),
  } as unknown as BrowserLocalProfileRepository;
  const profiles = new BrowserLocalProfiles({
    deploymentId,
    repository,
    baseUrl: new URL("https://host.test"),
    onReconciled,
  });
  await profiles.reconcileInventory(
    {
      identity: {
        runnerId,
        modules: {
          browser: {
            localProfileStorage: { engine: "chromium", storageInstanceId },
          },
        },
      },
    } as never,
    {
      type: "browser.profile.inventory",
      module: "browser",
      engine: "chromium",
      storageInstanceId,
      complete: true,
      profiles: [
        {
          phase: "deleted",
          binding,
          deletionId: randomUUID(),
          erasure: "deleted",
        },
      ],
    } as never,
  );
  expect(onReconciled).toHaveBeenCalledExactlyOnceWith(profileId, [threadId]);
});
