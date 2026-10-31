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
