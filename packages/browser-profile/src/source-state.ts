import { parse as parseHost } from "tldts";
import { z } from "zod";
import { BrowserCookieSchema, type BrowserCookie } from "./cookies.js";

export const maxBrowserSourceCookies = 1_000;
export const maxBrowserSourceSnapshotBytes = 1_024 * 1_024;
export const BrowserSourceSnapshotSchema = z.strictObject({
  cookies: z.array(BrowserCookieSchema).max(maxBrowserSourceCookies),
  origins: z.tuple([]),
});
export type BrowserSourceSnapshot = z.infer<typeof BrowserSourceSnapshotSchema>;

/**
 * Normalizes a URL, origin or bare hostname to the schemeful site whose sign-in
 * is shared: `https://github.com` for `https://gist.github.com/x`. Sign-in
 * cookies routinely live on the registrable domain, so a narrower scope would
 * not sign anything in; private suffixes (`app.vercel.app`) stay separate sites.
 * IP addresses and `localhost` are their own site. Any other host without a
 * registrable domain is refused: a public suffix such as `github.io` or
 * `co.uk` would cover every tenant under it, and a bare intranet name has no
 * boundary the scope rule could check.
 */
export function browserSiteFromUrl(input: string): string {
  const trimmed = input.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Choose an HTTP or HTTPS website without credentials.");
  }
  if (!url.hostname || url.hostname.includes("*")) throw new Error("Choose one website.");
  const host = siteHost(url.hostname);
  if (host === null) {
    throw new Error(
      `${url.hostname} is shared by many websites or has no domain of its own. Choose one website, such as github.com.`,
    );
  }
  return `${url.protocol}//${host}`;
}

/** The cookie domain every in-scope cookie belongs to, such as `github.com`. */
export function browserSiteDomain(site: string): string {
  return siteUrl(site).hostname;
}

/**
 * The single scope rule. The extension exports exactly these cookies, the Host
 * rejects a snapshot containing anything else, and a live sign-in replaces
 * exactly these in the destination browser. Keeping one rule means a sign-in
 * never deletes a cookie it cannot restore.
 */
export function browserSiteCookieMatches(site: string, cookie: BrowserCookie): boolean {
  const url = siteUrl(site);
  const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
  if (!domain || domain.endsWith(".") || /[\s/@\\:]/u.test(domain)) return false;
  try {
    if (new URL(`${url.protocol}//${domain}`).hostname !== domain) return false;
  } catch {
    return false;
  }
  // Host-only or not, a cookie belongs to the site its own host normalizes to,
  // so a site never covers a tenant under a private suffix beneath it
  // (`amazonaws.com` never reaches `bucket.s3.amazonaws.com`).
  if (siteHost(domain) !== url.hostname) return false;
  const hostOnly = cookie.hostOnly ?? !cookie.domain.startsWith(".");
  if (cookie.secure && url.protocol !== "https:") return false;
  if (cookie.expires < 0 && cookie.expires !== -1) return false;
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) return false;
  if (cookie.name.startsWith("__Host-") && (!hostOnly || !cookie.secure || cookie.path !== "/"))
    return false;
  if (cookie.partitionKey !== undefined) {
    let topLevel: string;
    try {
      topLevel = browserSiteFromUrl(cookie.partitionKey);
    } catch {
      return false;
    }
    if (new URL(cookie.partitionKey).origin !== cookie.partitionKey || topLevel !== site)
      return false;
    if (cookie.partitionKeyHasCrossSiteAncestor === undefined) return false;
  } else if (cookie.partitionKeyHasCrossSiteAncestor !== undefined) return false;
  return cookie.path.startsWith("/") && !/[\r\n\0]/u.test(cookie.path);
}

/** Identity of one cookie slot; a later cookie with the same identity replaces it. */
export function browserCookieIdentity(cookie: BrowserCookie): string {
  return JSON.stringify([
    cookie.domain.toLowerCase(),
    cookie.path,
    cookie.name,
    cookie.partitionKey ?? null,
    cookie.partitionKeyHasCrossSiteAncestor ?? null,
  ]);
}

export function validateBrowserSourceSnapshot(site: string, value: unknown): BrowserSourceSnapshot {
  siteUrl(site);
  const result = BrowserSourceSnapshotSchema.safeParse(value);
  if (!result.success) throw new Error("Chrome returned invalid browser state.");
  const snapshot = result.data;
  if (snapshot.cookies.some((cookie) => !browserSiteCookieMatches(site, cookie))) {
    throw new Error("Chrome returned cookies outside the requested website.");
  }
  const tooLarge =
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > maxBrowserSourceSnapshotBytes;
  if (tooLarge) throw new Error("Chrome's sign-in state exceeds its 1 MiB limit.");
  return snapshot;
}

/** The site host of a URL hostname, or null when it names no single site. */
function siteHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  const parsed = parseHost(host, { allowPrivateDomains: true });
  if (parsed.isIp || host === "localhost") return host;
  return parsed.domain;
}

function siteUrl(site: string): URL {
  const url = new URL(site);
  if (browserSiteFromUrl(site) !== site || url.origin !== site) {
    throw new Error("A browser sign-in scope must be a schemeful site such as https://github.com.");
  }
  return url;
}
