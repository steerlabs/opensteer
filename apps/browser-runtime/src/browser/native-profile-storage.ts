import type { BrowserCookie } from "@opensteer/browser-profile/cookies";
import { browserCookieFromCdp } from "@opensteer/browser-profile/cookies";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession } from "playwright-core";

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
 * `"Normal"` so `--restore-last-session` restores the session instead of pausing
 * on an unclean-exit recovery bubble. Without `restoreLastSession` (K4) Chromium
 * opens a new tab instead of its last session (`restore_on_startup` 5).
 */
export async function initializeNativePreferences(
  directory: string,
  restoreLastSession = true,
): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("Native profile directory must be absolute.");
  const restoreOnStartup = restoreLastSession ? 1 : 5;
  const defaultDir = path.join(directory, "Default");
  const preferencesPath = path.join(defaultDir, "Preferences");
  await mkdir(defaultDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      preferencesPath,
      JSON.stringify({ session: { restore_on_startup: restoreOnStartup } }),
      { flag: "wx", mode: 0o600 },
    );
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }

  // Existing Preferences belong to Chromium; only unclean-exit markers and the startup choice change.
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
  const session =
    prefs.session && typeof prefs.session === "object" && !Array.isArray(prefs.session)
      ? (prefs.session as Record<string, unknown>)
      : {};
  const unclean =
    (typeof profile?.exit_type === "string" && profile.exit_type !== "Normal") ||
    profile?.exited_cleanly === false;
  // A launch that restores changes the startup choice only back from the one K4 wrote.
  const startup = restoreLastSession
    ? session.restore_on_startup === 5
    : session.restore_on_startup !== 5;
  if (!unclean && !startup) return;
  const normalized = {
    ...prefs,
    ...(unclean ? { profile: { ...profile, exit_type: "Normal", exited_cleanly: true } } : {}),
    session: { ...session, restore_on_startup: restoreOnStartup },
  };
  await writeFileAtomic(preferencesPath, JSON.stringify(normalized));
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
