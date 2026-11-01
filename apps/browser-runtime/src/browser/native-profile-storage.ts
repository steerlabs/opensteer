import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { browserStorageOperation } from "@opensteer/browser-profile/storage-operation";
import { browserCookieFromCdp } from "@opensteer/browser-profile/cookies";
import type { BrowserCookie, BrowserProfileSnapshot } from "@opensteer/browser-profile/snapshot";

export async function initializeNativePreferences(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("Native profile directory must be absolute.");
  // The runtime holds the root lock and this profile's lifecycle lane, with no
  // browser owning this directory. Chromium defers tab restore to the first
  // window; Opensteer's durable tab descriptors are the only tab-restore authority.
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
  await writeFile(
    path.join(directory, "Default", "Preferences"),
    JSON.stringify({ session: { restore_on_startup: 1 } }),
    { flag: "wx", mode: 0o600 },
  ).catch((error) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
}

/** A synthetic, private helper; no imported origin can issue real requests or run a worker. */
export async function importNativeOrigins(
  context: BrowserContext,
  helper: Page,
  snapshot: BrowserProfileSnapshot,
): Promise<void> {
  const channel = await context.newCDPSession(helper);
  try {
    await channel.send("Network.setBypassServiceWorker", { bypass: true });
    await helper.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><html></html>" }),
    );
    for (const state of new Map(snapshot.origins.map((state) => [state.origin, state])).values()) {
      await helper.goto(state.origin);
      // The shared importer awaits IndexedDB transactions. Keep the writer alive
      // until a same-origin document also acknowledges every localStorage write.
      await helper.evaluate(`(async () => {
        const state = ${JSON.stringify(state)};
        const observer = document.createElement("iframe");
        const loaded = new Promise(resolve => observer.addEventListener("load", resolve, { once: true }));
        document.documentElement.appendChild(observer);
        await loaded;
        void observer.contentWindow.localStorage;
        const pending = new Map(state.localStorage.map(({ name, value }) => [name, value]));
        const acknowledged = pending.size ? new Promise(resolve => observer.contentWindow.addEventListener("storage", event => {
          if (pending.get(event.key) === event.newValue) pending.delete(event.key);
          if (!pending.size) resolve();
        })) : Promise.resolve();
        await (${browserStorageOperation.toString()})("restore", state);
        await acknowledged;
        observer.remove();
      })()`);
    }
  } catch {
    // Engine exceptions can include website-controlled storage names or URLs.
    throw new Error("Chromium could not import profile origin storage.");
  } finally {
    await channel.detach().catch(() => undefined);
  }
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
