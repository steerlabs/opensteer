import {
  browserCookieFromCdp,
  browserCookieToCdp,
  type BrowserCdpCookie,
} from "@opensteer/browser-profile/cookies";
import type { BrowserCookie } from "@opensteer/browser-profile/snapshot";
import {
  browserCookieIdentity,
  browserSiteCookieMatches,
  browserSiteDomain,
} from "@opensteer/browser-profile/source-state";
import { BrowserRuntimeError } from "../errors.js";

/**
 * The one cookie-write batch that makes a live browser context hold exactly
 * `cookies` for `site`. Every live cookie in the site's scope that the new set
 * does not replace is written with an expiry in the past, which Chromium treats
 * as deleting that slot; a slot the new set names is overwritten, never
 * deleted.
 *
 * `liveCookies` are raw CDP cookies. One Chromium cannot export (an opaque
 * partition) cannot be in any site's scope, so it is left alone rather than
 * failing the sign-in.
 */
export function siteCookieReplacementBatch(
  site: string,
  liveCookies: readonly unknown[],
  cookies: readonly BrowserCookie[],
): BrowserCdpCookie[] {
  try {
    browserSiteDomain(site);
  } catch (error) {
    throw new BrowserRuntimeError("bad_message", "The sign-in site is not a schemeful site.", {
      cause: error,
    });
  }
  if (cookies.some((cookie) => !browserSiteCookieMatches(site, cookie))) {
    throw new BrowserRuntimeError(
      "bad_message",
      "The sign-in contains cookies outside the requested site.",
    );
  }
  const replaced = new Set(cookies.map(cookieSlot));
  const deletions: BrowserCdpCookie[] = [];
  for (const raw of liveCookies) {
    let live: BrowserCookie;
    try {
      live = browserCookieFromCdp(raw);
    } catch {
      continue;
    }
    if (!browserSiteCookieMatches(site, live) || replaced.has(cookieSlot(live))) continue;
    deletions.push(browserCookieToCdp({ ...live, expires: expiredCookieTime }));
  }
  return [...deletions, ...cookies.map(browserCookieToCdp)];
}

/** One second after the epoch: in the past, and still a valid cookie expiry. */
const expiredCookieTime = 1;

/**
 * Chromium keys a cookie by its canonical domain: `.example.com` for a domain
 * cookie, `example.com` for a host-only one, whichever spelling the input used.
 */
function cookieSlot(cookie: BrowserCookie): string {
  const hostOnly = cookie.hostOnly ?? !cookie.domain.startsWith(".");
  const hostname = cookie.domain.replace(/^\./u, "");
  return browserCookieIdentity({ ...cookie, domain: hostOnly ? hostname : `.${hostname}` });
}
