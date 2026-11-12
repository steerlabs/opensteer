import type { RunnerBrowserModule, RunnerDescriptor } from "@opensteer/protocol";
import type { NativeQualification } from "./native-port.js";

export function phoneBrowserDescriptor(
  qualification: NativeQualification,
): RunnerBrowserModule | undefined {
  if (!qualification.browser || !qualification.sharedControl) return undefined;
  return {
    runtimeId: qualification.runtimeId,
    wireVersion: 2,
    localProfileStorage: {
      storageInstanceId: qualification.storageInstanceId,
      engine: qualification.platform === "ios" ? "wkwebview" : "android-webview",
    },
    navigationVersion: 1,
    navigationAttributionVersion: 1,
    tabRestoreVersion: 1,
    popupFollowVersion: 1,
    sharedControl: 1,
    targetControl: 1,
    rasterDemand: 1,
    basicInput: 1,
    surfaceState: 1,
    ...(qualification.platform === "ios" && qualification.agentActions ? { agentActions: 1 } : {}),
    ...(qualification.platform === "android" && qualification.cdpBoundary
      ? { cdpBoundary: 1 }
      : {}),
    ...(qualification.fileStaging ? { fileStaging: true } : {}),
  };
}

export function phoneBrowserRunnerDescriptor(
  qualification: NativeQualification,
  identity: Pick<RunnerDescriptor, "runnerId" | "bootId" | "name" | "runtimeVersion">,
): RunnerDescriptor | undefined {
  const browser = phoneBrowserDescriptor(qualification);
  if (!browser && qualification.platform === "android") return undefined;
  return {
    ...identity,
    runnerKind: "local",
    capabilities: [],
    device: { form: "phone", platform: qualification.platform },
    modules: {
      ...(browser ? { browser } : {}),
      ...(qualification.platform === "ios"
        ? { integrations: { platform: "ios", protocolVersion: 2 } }
        : {}),
    },
  };
}
