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
