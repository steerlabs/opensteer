import type { BrowserCookie } from "@opensteer/browser-profile/cookies";
import { browserCookieFromCdp } from "@opensteer/browser-profile/cookies";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession } from "playwright-core";

export async function initializeNativePreferences(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("Native profile directory must be absolute.");
  // The runtime holds the root lock and this profile's lifecycle lane, with no browser owning
  // this directory. Chromium never loads a last session (L1): its session records are deleted,
  // and it starts on a new tab page; a restarted Home's tabs open fresh at their addresses.
  const sessions = path.join(directory, "Default", "Sessions");
  const records = await readdir(sessions, { withFileTypes: true }).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const record of records) {
    if (
      !/^(?:Session_.*|Tabs_.*|Current Session|Last Session|Current Tabs|Last Tabs)$/u.test(
        record.name,
      )
    )
      continue;
    if (!record.isFile()) throw new Error("Chromium tab-restore record is not a regular file.");
    await unlink(path.join(sessions, record.name));
  }
  await mkdir(path.join(directory, "Default"), { recursive: true, mode: 0o700 });
  const preferences = path.join(directory, "Default", "Preferences");
  const startup = { session: { restore_on_startup: 5 } };
  const created = await writeFile(preferences, JSON.stringify(startup), {
    flag: "wx",
    mode: 0o600,
  }).then(
    () => true,
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      return false;
    },
  );
  if (created) return;
  // A profile an earlier runtime set to restore its last session is set back to a new tab page.
  const prefs = JSON.parse(await readFile(preferences, "utf8").catch(() => "null")) as {
    session?: { restore_on_startup?: unknown };
  } | null;
  if (prefs?.session?.restore_on_startup !== 1) return;
  const temp = `${preferences}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(
    temp,
    JSON.stringify({ ...prefs, session: { ...prefs.session, restore_on_startup: 5 } }),
    { mode: 0o600 },
  );
  await rename(temp, preferences).catch(async (error: unknown) => {
    await unlink(temp).catch(() => undefined);
    throw error;
  });
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
