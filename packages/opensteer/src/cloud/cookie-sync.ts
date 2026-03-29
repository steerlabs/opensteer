import type { PortableBrowserProfileCookieRecord } from "@opensteer/protocol";

// Keep this helper engine-agnostic so opensteer does not depend on Playwright types.
export interface BrowserProfileSyncCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path?: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expires?: number;
  readonly sameSite?: "Strict" | "Lax" | "None";
  readonly partitionKey?: string;
}

export interface PrepareBrowserProfileSyncCookiesInput {
  readonly cookies: readonly BrowserProfileSyncCookie[];
  readonly domains?: readonly string[];
}

export interface PreparedBrowserProfileSyncCookies {
  readonly cookies: readonly PortableBrowserProfileCookieRecord[];
}

export function prepareBrowserProfileSyncCookies(
  input: PrepareBrowserProfileSyncCookiesInput,
): PreparedBrowserProfileSyncCookies {
  const filteredDomains = [
    ...new Set((input.domains ?? []).map(normalizeCookieDomain).filter(Boolean)),
  ];
  const deduped = new Map<string, PortableBrowserProfileCookieRecord>();

  for (const cookie of input.cookies) {
    if (!cookieMatchesDomainFilters(cookie, filteredDomains)) {
      continue;
    }

    const normalized = toPortableBrowserProfileCookieRecord(cookie);
    if (!normalized) {
      continue;
    }

    const dedupeKey = [
      normalized.name,
      normalizeCookieDomain(normalized.domain),
      normalized.path || "/",
    ].join("\u0001");
    deduped.set(dedupeKey, normalized);
  }

  const syncedCookies = [...deduped.values()];
  return {
    cookies: syncedCookies,
  };
}

export function normalizeCookieDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, "");
}

function cookieMatchesDomainFilters(
  cookie: Pick<BrowserProfileSyncCookie, "domain">,
  filteredDomains: readonly string[],
): boolean {
  if (filteredDomains.length === 0) {
    return true;
  }

  const cookieDomain = extractCookieDomain(cookie);
  if (!cookieDomain) {
    return false;
  }

  return filteredDomains.some((domain) => {
    return cookieDomain === domain || cookieDomain.endsWith(`.${domain}`);
  });
}

function extractCookieDomain(cookie: Pick<BrowserProfileSyncCookie, "domain">): string | null {
  if (typeof cookie.domain !== "string" || cookie.domain.trim().length === 0) {
    return null;
  }

  return normalizeCookieDomain(cookie.domain);
}

function toPortableBrowserProfileCookieRecord(
  cookie: BrowserProfileSyncCookie,
): PortableBrowserProfileCookieRecord | null {
  const name = typeof cookie.name === "string" ? cookie.name.trim() : "";
  const domain = typeof cookie.domain === "string" ? cookie.domain.trim() : "";
  if (!name || !domain) {
    return null;
  }

  const path = typeof cookie.path === "string" && cookie.path.trim().length > 0 ? cookie.path : "/";
  const expiresAt =
    typeof cookie.expires === "number" && Number.isFinite(cookie.expires) && cookie.expires > 0
      ? Math.floor(cookie.expires * 1000)
      : null;
  const sameSite = normalizeSameSite(cookie.sameSite);

  return {
    name,
    value: cookie.value,
    domain,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(sameSite === undefined ? {} : { sameSite }),
    ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
    session: expiresAt === null,
    ...(expiresAt === null ? { expiresAt: null } : { expiresAt }),
  };
}

function normalizeSameSite(
  value: BrowserProfileSyncCookie["sameSite"],
): PortableBrowserProfileCookieRecord["sameSite"] {
  if (value === "Strict") return "strict";
  if (value === "Lax") return "lax";
  if (value === "None") return "none";
  return undefined;
}
