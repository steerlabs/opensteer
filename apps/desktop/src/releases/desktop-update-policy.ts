import type { readEmbeddedDesktopRelease } from "../config.js";

type Release = ReturnType<typeof readEmbeddedDesktopRelease>;

/** Apply once while staging; runtime configuration never reads the build environment. */
export function stageDesktopUpdatePolicy(
  release: Release,
  operatingSystem: string,
  architecture: string,
  feedOverride: string | undefined,
): Release {
  const { updates, ...withoutUpdates } = release;
  if (
    release.application.channel !== "stable" ||
    operatingSystem !== "darwin" ||
    architecture !== "arm64"
  )
    return withoutUpdates;
  const feedUrl = feedOverride?.trim() || updates?.feedUrl;
  if (!feedUrl) return withoutUpdates;
  const url = new URL(feedUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Desktop update feed must be HTTPS without credentials or a fragment.");
  return { ...withoutUpdates, updates: { feedUrl } };
}
