import type { BrowserCookie } from "@opensteer/browser-profile/cookies";
import { browserCookieFromCdp } from "@opensteer/browser-profile/cookies";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession } from "playwright-core";
import { z } from "zod";
import type { ChromiumTabEntry } from "./tab-lifecycle-extension.js";

export const tabRestoreSidecarFilename = "opensteer-tabs.json";

const tabRestoreSidecarEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  surfaceId: z.string().min(1),
  url: z.string(),
});

const tabRestoreSidecarSchema = z.object({
  version: z.literal(1),
  tabs: z.array(tabRestoreSidecarEntrySchema),
});

export type TabRestoreSidecarEntry = z.infer<typeof tabRestoreSidecarEntrySchema>;

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Prepares Chromium's native profile Preferences while preserving Chromium's own
 * `Default/Sessions/` files for cold-start session restore. When Chromium exited
 * uncleanly (e.g. `SIGKILL` or host crash), resets `profile.exit_type` to
 * `"Normal"` so `--restore-last-session` automatically restores the session
 * instead of pausing on an unclean-exit recovery bubble.
 */
export async function initializeNativePreferences(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("Native profile directory must be absolute.");
  const defaultDir = path.join(directory, "Default");
  const preferencesPath = path.join(defaultDir, "Preferences");
  await mkdir(defaultDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(preferencesPath, JSON.stringify({ session: { restore_on_startup: 1 } }), {
      flag: "wx",
      mode: 0o600,
    });
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }

  // Existing Preferences belong to Chromium; only normalize unclean-exit markers.
  let raw: string;
  try {
    raw = await readFile(preferencesPath, "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const prefs = parsed as Record<string, unknown>;
  const profile =
    prefs.profile && typeof prefs.profile === "object" && !Array.isArray(prefs.profile)
      ? (prefs.profile as Record<string, unknown>)
      : null;
  const unclean =
    (typeof profile?.exit_type === "string" && profile.exit_type !== "Normal") ||
    profile?.exited_cleanly === false;
  if (!unclean) return;

  const session =
    prefs.session && typeof prefs.session === "object" && !Array.isArray(prefs.session)
      ? (prefs.session as Record<string, unknown>)
      : {};
  const normalized = {
    ...prefs,
    profile: { ...profile, exit_type: "Normal", exited_cleanly: true },
    session: { ...session, restore_on_startup: 1 },
  };
  await writeFileAtomic(preferencesPath, JSON.stringify(normalized));
}

export async function readTabRestoreSidecar(
  directory: string,
): Promise<readonly TabRestoreSidecarEntry[]> {
  if (!path.isAbsolute(directory)) throw new Error("Native profile directory must be absolute.");
  const sidecarPath = path.join(directory, tabRestoreSidecarFilename);
  let raw: string;
  try {
    raw = await readFile(sidecarPath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = tabRestoreSidecarSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return [...parsed.data.tabs].sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

export async function writeTabRestoreSidecar(
  directory: string,
  entries: readonly TabRestoreSidecarEntry[],
): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("Native profile directory must be absolute.");
  const sidecarPath = path.join(directory, tabRestoreSidecarFilename);
  const normalized = [...entries]
    .sort((a, b) => a.index - b.index)
    .map((entry, index) => ({
      index,
      surfaceId: entry.surfaceId,
      url: entry.url,
    }));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFileAtomic(sidecarPath, JSON.stringify({ version: 1, tabs: normalized }));
}

export interface RestoredTabMatchResult {
  readonly matched: ReadonlyMap<string, ChromiumTabEntry>;
  readonly orphans: readonly ChromiumTabEntry[];
  readonly missingSurfaceIds: readonly string[];
}

/**
 * Matches Chromium's restored TabStripModel tabs against the Home's authoritative
 * tab list using the profile's strip-order sidecar. Disambiguates duplicate URLs
 * by relative strip index first, then falls back to URL order if a hard crash
 * shifted indices. Any restored tab not owned by a Home tab is returned as an orphan.
 */
export function matchRestoredTabs(
  restoredTabs: readonly ChromiumTabEntry[],
  sidecarTabs: readonly TabRestoreSidecarEntry[],
  homeTabs: readonly { readonly surfaceId: string; readonly url: string }[],
): RestoredTabMatchResult {
  const homeById = new Map(homeTabs.map((tab) => [tab.surfaceId, tab]));
  const orderedRestored = [...restoredTabs].sort(
    (a, b) => a.windowId - b.windowId || a.index - b.index,
  );
  const eligibleSidecar = [...sidecarTabs]
    .filter((entry) => homeById.has(entry.surfaceId))
    .sort((a, b) => a.index - b.index);

  const matched = new Map<string, ChromiumTabEntry>();
  const usedTabIds = new Set<number>();

  // Pass 1: exact relative strip position + URL match (disambiguates duplicate URLs).
  const minLength = Math.min(orderedRestored.length, eligibleSidecar.length);
  for (let i = 0; i < minLength; i++) {
    const restored = orderedRestored[i]!;
    const sidecar = eligibleSidecar[i]!;
    if (matched.has(sidecar.surfaceId) || usedTabIds.has(restored.tabId)) continue;
    if (restored.url === sidecar.url) {
      matched.set(sidecar.surfaceId, restored);
      usedTabIds.add(restored.tabId);
    }
  }

  // Pass 2: URL fallback for remaining sidecar entries (handles index shift after SIGKILL).
  for (const sidecar of eligibleSidecar) {
    if (matched.has(sidecar.surfaceId)) continue;
    const candidate = orderedRestored.find(
      (restored) => !usedTabIds.has(restored.tabId) && restored.url === sidecar.url,
    );
    if (candidate) {
      matched.set(sidecar.surfaceId, candidate);
      usedTabIds.add(candidate.tabId);
    }
  }

  // Pass 3: URL fallback for Home tabs absent from the sidecar.
  for (const home of homeTabs) {
    if (matched.has(home.surfaceId)) continue;
    const candidate = orderedRestored.find(
      (restored) => !usedTabIds.has(restored.tabId) && restored.url === home.url,
    );
    if (candidate) {
      matched.set(home.surfaceId, candidate);
      usedTabIds.add(candidate.tabId);
    }
  }

  const orphans = orderedRestored.filter((restored) => !usedTabIds.has(restored.tabId));
  const missingSurfaceIds = homeTabs
    .filter((home) => !matched.has(home.surfaceId))
    .map((home) => home.surfaceId);

  return { matched, orphans, missingSurfaceIds };
}

export function assertImportedCookies(
  expected: readonly BrowserCookie[],
  actual: readonly unknown[],
): void {
  const identity = (cookie: BrowserCookie) =>
    JSON.stringify([
      cookie.name,
      cookie.domain.replace(/^\./u, "").toLowerCase(),
      cookie.hostOnly ?? !cookie.domain.startsWith("."),
      cookie.path,
      cookie.partitionKey ? new URL(cookie.partitionKey).origin : null,
      cookie.partitionKey ? (cookie.partitionKeyHasCrossSiteAncestor ?? true) : null,
    ]);
  const readback = new Map(
    actual.map((value) => {
      const cookie = browserCookieFromCdp(value);
      return [identity(cookie), cookie.value];
    }),
  );
  for (const cookie of expected) {
    if (cookie.expires >= 0 && cookie.expires <= Date.now() / 1000) continue;
    if (readback.get(identity(cookie)) !== cookie.value) {
      throw new Error("Chromium rejected an imported profile cookie.");
    }
  }
}

/**
 * Chromium 151 Storage.setCookies only acknowledges SetCanonicalCookie. A
 * filtered CookieManager::DeleteCookies calls CookieMonster::DeleteMatchingCookies,
 * which awaits FlushStore even for zero matches. Use an unvisited, empty origin:
 * no cookie is removed and no page navigates. This commits the whole cookie jar
 * (including native session cookies) before acknowledging an Opensteer write.
 * It guarantees process-crash durability, not power-loss durability.
 * https://github.com/chromium/chromium/blob/151.0.7922.34/net/cookies/cookie_monster.cc#L873
 */
export async function flushNativeCookies(channel: CDPSession): Promise<void> {
  const host = `${randomUUID()}.invalid`;
  const { cookies } = await channel.send("Network.getAllCookies");
  if (
    cookies.some(
      (cookie) =>
        host === cookie.domain.replace(/^\./u, "") ||
        host.endsWith(`.${cookie.domain.replace(/^\./u, "")}`),
    )
  ) {
    throw new Error("Native cookie flush origin is not empty.");
  }
  await channel.send("Storage.clearDataForOrigin", {
    origin: `https://${host}`,
    storageTypes: "cookies",
  });
}
