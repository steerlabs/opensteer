import type { HostConfig } from "@opensteer/config";
import type { HostHomeKind } from "@opensteer/core";

/**
 * What kind of Home this is, from its own configuration: a managed Home is a
 * Cloud Computer, a networked personal Home a server, a loopback one on macOS
 * a Mac. Anything else (a loopback Home in development on Linux) says nothing.
 */
export function personalHomeKind(
  config: Pick<HostConfig, "exposure" | "managedHome">,
  platform: NodeJS.Platform = process.platform,
): HostHomeKind | undefined {
  if (config.managedHome) return "cloud-computer";
  if (config.exposure === "networked") return "server";
  return platform === "darwin" ? "mac" : undefined;
}

/** The identity option for this Home's kind: nothing when it is none of them. */
export function personalHomeKindOption(
  config: Pick<HostConfig, "exposure" | "managedHome">,
  platform?: NodeJS.Platform,
): { readonly homeKind?: HostHomeKind } {
  const homeKind = personalHomeKind(config, platform);
  return homeKind ? { homeKind } : {};
}
