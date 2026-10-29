import type { BrowserCookie } from "@opensteer/browser-profile/snapshot";
import {
  BrowserSourceSnapshotSchema,
  browserCookieIdentity,
  browserSiteCookieMatches,
  browserSiteDomain,
  maxBrowserSourceCookies,
  maxBrowserSourceSnapshotBytes,
  type BrowserSourceSnapshot,
} from "@opensteer/browser-profile/source-state";

export type SiteCookies =
  | { status: "exported"; snapshot: BrowserSourceSnapshot }
  | { status: "no-state" | "too-large" | "unsupported" };

function convertCookie(cookie: ChromeCookie): BrowserCookie | null {
  if (!cookie.session && cookie.expirationDate === undefined) return null;
  const sameSite =
    cookie.sameSite === "strict"
      ? "Strict"
      : cookie.sameSite === "lax"
        ? "Lax"
        : cookie.sameSite === "no_restriction"
          ? "None"
          : undefined;
  const partitionKey = cookie.partitionKey?.topLevelSite;
  return {
    domain: cookie.domain,
    expires: cookie.session ? -1 : cookie.expirationDate!,
    hostOnly: cookie.hostOnly,
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    ...(partitionKey
      ? {
          partitionKey,
          ...(cookie.partitionKey?.hasCrossSiteAncestor === undefined
            ? {}
            : { partitionKeyHasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor }),
        }
      : {}),
    ...(sameSite === undefined ? {} : { sameSite }),
    secure: cookie.secure,
    value: cookie.value,
  };
}

/**
 * Reads this Chrome profile's cookies for one schemeful site: unpartitioned
 * cookies on the site's domain and its subdomains, plus cookies partitioned
 * under the site as a top-level site. `browserSiteCookieMatches` is the only
 * filter, so the export is exactly what the Host will accept and replace.
 */
export async function readSiteCookies(site: string): Promise<SiteCookies> {
  const domain = browserSiteDomain(site);
  let found: ChromeCookie[];
  try {
    found = [
      ...(await chrome.cookies.getAll({ domain })),
      ...(await chrome.cookies.getAll({
        domain,
        partitionKey: { hasCrossSiteAncestor: false, topLevelSite: site },
      })),
      ...(await chrome.cookies.getAll({
        domain,
        partitionKey: { hasCrossSiteAncestor: true, topLevelSite: site },
      })),
    ];
  } catch {
    return { status: "unsupported" };
  }
  const selected = new Map<string, BrowserCookie>();
  for (const chromeCookie of found) {
    const cookie = convertCookie(chromeCookie);
    if (!cookie || !browserSiteCookieMatches(site, cookie)) continue;
    selected.set(browserCookieIdentity(cookie), cookie);
  }
  if (selected.size === 0) return { status: "no-state" };
  if (selected.size > maxBrowserSourceCookies) return { status: "too-large" };
  const parsed = BrowserSourceSnapshotSchema.safeParse({
    cookies: [...selected.values()],
    origins: [],
  });
  if (!parsed.success) return { status: "unsupported" };
  if (
    new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > maxBrowserSourceSnapshotBytes
  ) {
    return { status: "too-large" };
  }
  return { status: "exported", snapshot: parsed.data };
}
