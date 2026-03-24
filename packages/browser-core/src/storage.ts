import type { FrameRef, PageRef, SessionRef } from "./identity.js";

export type CookieSameSite = "strict" | "lax" | "none";
export type CookiePriority = "low" | "medium" | "high";

export interface CookieRecord {
  readonly sessionRef: SessionRef;
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: CookieSameSite;
  readonly priority?: CookiePriority;
  readonly partitionKey?: string;
  readonly session: boolean;
  readonly expiresAt?: number | null;
}

export interface StorageEntry {
  readonly key: string;
  readonly value: string;
}

export interface IndexedDbRecord {
  readonly key: unknown;
  readonly primaryKey?: unknown;
  readonly value: unknown;
}

export interface IndexedDbIndexSnapshot {
  readonly name: string;
  readonly keyPath?: string | readonly string[];
  readonly multiEntry: boolean;
  readonly unique: boolean;
}

export interface IndexedDbObjectStoreSnapshot {
  readonly name: string;
  readonly keyPath?: string | readonly string[];
  readonly autoIncrement: boolean;
  readonly indexes: readonly IndexedDbIndexSnapshot[];
  readonly records: readonly IndexedDbRecord[];
}

export interface IndexedDbDatabaseSnapshot {
  readonly name: string;
  readonly version: number;
  readonly objectStores: readonly IndexedDbObjectStoreSnapshot[];
}

export interface StorageOriginSnapshot {
  readonly origin: string;
  readonly localStorage: readonly StorageEntry[];
  readonly indexedDb?: readonly IndexedDbDatabaseSnapshot[];
}

export interface SessionStorageSnapshot {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly origin: string;
  readonly entries: readonly StorageEntry[];
}

export interface StorageSnapshot {
  readonly sessionRef: SessionRef;
  readonly capturedAt: number;
  readonly origins: readonly StorageOriginSnapshot[];
  readonly sessionStorage?: readonly SessionStorageSnapshot[];
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function normalizeCookiePath(path: string): string {
  if (path.length === 0) {
    return "/";
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function pathMatchesCookiePath(requestPath: string, cookiePath: string): boolean {
  const normalizedRequestPath = requestPath.length === 0 ? "/" : requestPath;
  const normalizedCookiePath = normalizeCookiePath(cookiePath);

  if (normalizedRequestPath === normalizedCookiePath) {
    return true;
  }

  if (!normalizedRequestPath.startsWith(normalizedCookiePath)) {
    return false;
  }

  if (normalizedCookiePath.endsWith("/")) {
    return true;
  }

  return normalizedRequestPath.charAt(normalizedCookiePath.length) === "/";
}

export function filterCookieRecords(
  cookies: readonly CookieRecord[],
  urls: readonly string[],
): CookieRecord[] {
  const parsed = urls.map(parseUrl).filter((url) => url !== null);
  if (parsed.length === 0) {
    return [...cookies];
  }

  return cookies.filter((cookie) => {
    return parsed.some((url) => {
      let domain = cookie.domain;
      if (!domain.startsWith(".")) {
        domain = `.${domain}`;
      }

      if (!`.${url.hostname}`.endsWith(domain)) {
        return false;
      }

      if (!pathMatchesCookiePath(url.pathname, cookie.path)) {
        return false;
      }

      if (url.protocol !== "https:" && !isLocalHostname(url.hostname) && cookie.secure) {
        return false;
      }

      return true;
    });
  });
}
