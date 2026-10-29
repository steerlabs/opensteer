import type { DesktopUpdates, readEmbeddedDesktopRelease } from "../config.js";

type Release = ReturnType<typeof readEmbeddedDesktopRelease>;

/** Apply once while staging; runtime configuration never reads the build environment. */
export function stageDesktopUpdatePolicy(
  release: Release,
  operatingSystem: string,
  architecture: string,
  hostOverride: string | undefined,
): Release {
  const { updates, ...withoutUpdates } = release;
  if (!updates || operatingSystem !== "darwin" || architecture !== "arm64") return withoutUpdates;
  if (updates.channel !== (release.application.channel === "stable" ? "latest" : "insider"))
    throw new Error("Desktop update channel does not match the application.");
  const host = hostOverride?.trim();
  if (host && !/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/u.test(host))
    throw new Error("Desktop update GitHub host must be a hostname with an optional port.");
  return { ...withoutUpdates, updates: { ...updates, ...(host ? { host } : {}) } };
}

export function desktopUpdateFeed(updates: DesktopUpdates): string {
  return `https://${updates.host ?? "github.com"}/${updates.owner}/${updates.repo}#${updates.channel}`;
}

/** JSON scalars are also YAML scalars; quote the test host, including its port. */
export function desktopAppUpdateYaml(updates: DesktopUpdates): string {
  return Object.entries({
    provider: "github",
    owner: updates.owner,
    repo: updates.repo,
    ...(updates.host ? { host: updates.host } : {}),
    updaterCacheDirName:
      updates.channel === "latest" ? "opensteer-updater" : "opensteer-beta-updater",
  })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
    .join("");
}
