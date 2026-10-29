import { z } from "zod";
import { advertisedRunnerModules, type RunnerDescriptor } from "./runner.js";

export const iphoneIntegrationsProtocolVersion = 1;
export const RunnerDeviceProfileSchema = z.enum(["iphone"]);
export type RunnerDeviceProfile = z.infer<typeof RunnerDeviceProfileSchema>;
export const iphoneOutdatedReason = "Update Opensteer on this iPhone to keep sharing its apps.";
export const runnerDeviceProfileMismatchReason =
  "This device doesn't match how it was added to Opensteer. Remove it and add it again.";

/** The descriptor has already been parsed and its signature verified by the caller. */
export function runnerDescriptorProfileRefusal(
  profile: RunnerDeviceProfile | null,
  descriptor: RunnerDescriptor,
): { reason: "runner-device-profile-mismatch" | "iphone-app-outdated"; message: string } | null {
  const integrations = descriptor.modules.integrations;
  const mismatch = {
    reason: "runner-device-profile-mismatch" as const,
    message: runnerDeviceProfileMismatchReason,
  };
  if (profile === null)
    return descriptor.device?.platform === "ios" || integrations?.platform === "ios"
      ? mismatch
      : null;
  const modules = advertisedRunnerModules(descriptor.modules);
  if (
    descriptor.runnerKind !== "local" ||
    descriptor.capabilities.length !== 0 ||
    descriptor.device?.form !== "phone" ||
    descriptor.device.platform !== "ios" ||
    modules.length !== 1 ||
    modules[0] !== "integrations" ||
    integrations?.platform !== "ios" ||
    integrations.computerAppApprovals !== true ||
    integrations.loginText !== undefined ||
    integrations.passwordSignIn !== undefined ||
    integrations.ownerViewVersion !== undefined ||
    integrations.macWindowVideoVersion !== undefined
  )
    return mismatch;
  return integrations.protocolVersion === iphoneIntegrationsProtocolVersion
    ? null
    : { reason: "iphone-app-outdated", message: iphoneOutdatedReason };
}
