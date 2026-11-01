import { createBrowserSessionId } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import type { BrowserLaunchRequest } from "@opensteer/browser-runtime-core";

export function nativeProfileRequest(directory: string): BrowserLaunchRequest & {
  storage: Extract<BrowserLaunchRequest["storage"], { kind: "local" }>;
} {
  const profileId = createId("browserProfile");
  return {
    initialViewport: { devicePixelRatio: 1, width: 800, height: 600 },
    partitionKey: `profile:${profileId}`,
    sessionId: createBrowserSessionId(),
    storage: {
      kind: "local",
      directory,
      binding: {
        version: 1,
        deploymentId: createId("deployment"),
        profileId,
        runnerId: createId("runner"),
        storageInstanceId: randomUUID(),
        bindingId: randomUUID(),
        engine: "chromium",
      },
    },
  };
}

export async function nativeRuntimeProfile() {
  const { LocalProfileStore } = await import("@opensteer/browser-runtime-core");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "native-runtime-fixture-"));
  const store = await LocalProfileStore.acquire(root, "chromium");
  const binding = {
    ...nativeProfileRequest(root).storage.binding,
    storageInstanceId: store.storageInstanceId,
  };
  try {
    await store.provision(binding, false, async () => {}, new AbortController().signal);
  } finally {
    await store.close();
  }
  return {
    identity: {
      kind: "profile-local" as const,
      binding,
      initialized: true,
      readyUrl: "https://fixture.invalid/ready",
    },
    localProfiles: { root },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
