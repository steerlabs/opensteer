import { isRecord } from "@opensteer/shared/isRecord";
import path from "node:path";

export { isRecord };

const extensionIdPattern = /^[a-p]{32}$/u;
const extensionVersionPattern = /^\d{1,9}(?:\.\d{1,9}){0,3}$/u;
const MAX_PATTERN_LENGTH = 2_048;

export interface ParsedMatchPattern {
  readonly raw: string;
  readonly allUrls: boolean;
  readonly scheme: string;
  readonly host: string;
  readonly pathPattern: string;
}

export function isExtensionId(value: unknown): value is string {
  return typeof value === "string" && extensionIdPattern.test(value);
}

export function isExtensionVersion(value: unknown): value is string {
  return typeof value === "string" && extensionVersionPattern.test(value);
}

export function assertExtensionId(value: unknown): string {
  if (!isExtensionId(value)) throw new Error("Invalid extension ID.");
  return value;
}

export function assertExtensionVersion(value: unknown): string {
  if (!isExtensionVersion(value)) throw new Error("Invalid extension version.");
  return value;
}

/**
 * Compares Chrome dotted numeric versions (up to 4 integer components).
 * Returns negative if left < right, 0 if equal, positive if left > right.
 */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length, 4);
  for (let index = 0; index < length; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Linear-time O(N+M) wildcard glob matcher (`*` matches any sequence).
 * Avoids RegExp compilation and catastrophic backtracking on untrusted patterns.
 */
export function globMatch(pattern: string, text: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  let p = 0;
  let t = 0;
  let starIdx = -1;
  let matchIdx = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      starIdx = p++;
      matchIdx = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (starIdx !== -1) {
      p = starIdx + 1;
      t = ++matchIdx;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Parses a Chrome extension match pattern according to Chromium's match pattern grammar. */
export function parseMatchPattern(pattern: string): ParsedMatchPattern | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  if (pattern === "<all_urls>") {
    return {
      raw: pattern,
      allUrls: true,
      scheme: "*",
      host: "*",
      pathPattern: "/*",
    };
  }
  const schemeSep = pattern.indexOf("://");
  if (schemeSep <= 0) return null;
  const scheme = pattern.slice(0, schemeSep).toLowerCase();
  if (!["*", "http", "https", "chrome-extension"].includes(scheme)) return null;
  const rest = pattern.slice(schemeSep + 3);
  const slashIndex = rest.indexOf("/");
  if (slashIndex < 0) return null;
  const host = rest.slice(0, slashIndex).toLowerCase();
  const pathPattern = rest.slice(slashIndex);
  if (!host || !pathPattern.startsWith("/")) return null;
  if (
    host !== "*" &&
    host.includes("*") &&
    (!host.startsWith("*.") || host.slice(2).includes("*"))
  ) {
    return null;
  }
  return {
    raw: pattern,
    allUrls: false,
    scheme,
    host,
    pathPattern,
  };
}

/** Returns true when `url` matches a Chrome match pattern. */
export function matchesPattern(pattern: string, urlString: string): boolean {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return false;
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  const protocol = url.protocol.slice(0, -1).toLowerCase();
  if (parsed.allUrls) {
    return protocol === "http" || protocol === "https";
  }
  if (parsed.scheme === "*") {
    if (protocol !== "http" && protocol !== "https") return false;
  } else if (protocol !== parsed.scheme) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  if (parsed.host !== "*") {
    if (parsed.host.startsWith("*.")) {
      const suffix = parsed.host.slice(2);
      if (hostname !== suffix && !hostname.endsWith(`.${suffix}`)) return false;
    } else if (hostname !== parsed.host) {
      return false;
    }
  }
  const pathWithQuery = `${url.pathname}${url.search}`;
  return globMatch(parsed.pathPattern, pathWithQuery);
}

/**
 * Returns true when `broad` match pattern strictly covers every URL matched by `narrow`.
 * Properly distinguishes HTTP-only, HTTPS-only, and wildcard web schemes.
 */
export function patternCovers(broad: string, narrow: string): boolean {
  if (broad === narrow) return true;
  const b = parseMatchPattern(broad);
  const n = parseMatchPattern(narrow);
  if (!b || !n) return false;

  // Scheme coverage: `*` / `<all_urls>` covers `http`, `https`, `*`, `<all_urls>`, NOT `chrome-extension`.
  const bCoversWeb = b.allUrls || b.scheme === "*";
  if (n.allUrls || n.scheme === "*") {
    if (!bCoversWeb) return false;
  } else if (n.scheme === "http" || n.scheme === "https") {
    if (!bCoversWeb && b.scheme !== n.scheme) return false;
  } else if (b.scheme !== n.scheme) {
    return false;
  }

  // Host coverage
  if (b.host !== "*") {
    if (n.host === "*") return false;
    if (b.host.startsWith("*.")) {
      const suffix = b.host.slice(2);
      const nBase = n.host.startsWith("*.") ? n.host.slice(2) : n.host;
      if (nBase !== suffix && !nBase.endsWith(`.${suffix}`)) return false;
    } else if (b.host !== n.host) {
      return false;
    }
  }

  // Path coverage: `/*` covers any path; otherwise require exact match or glob coverage of non-wildcard narrow.
  if (b.pathPattern === "/*") return true;
  if (b.pathPattern === n.pathPattern) return true;
  if (!n.pathPattern.includes("*")) return globMatch(b.pathPattern, n.pathPattern);
  return false;
}

/** Matches Chrome `tabs.query({ title })` glob patterns in linear time. */
export function matchesTitlePattern(pattern: string, title: string): boolean {
  return globMatch(pattern, title);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function declaredPermissions(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  return stringList(manifest.permissions).filter(
    (item) => !item.includes("://") && item !== "<all_urls>",
  );
}

export function declaredOptionalPermissions(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  return stringList(manifest.optional_permissions);
}

export function declaredHostPermissions(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  const patterns = new Set<string>(stringList(manifest.host_permissions));
  if (manifest.manifest_version === 2) {
    for (const item of stringList(manifest.permissions)) {
      if (item === "<all_urls>" || item.includes("://")) patterns.add(item);
    }
  }
  return [...patterns];
}

export function declaredOptionalHostPermissions(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  return stringList(manifest.optional_host_permissions);
}

export const RESTRICTED_WEB_STORE_EXCLUDE_MATCHES: readonly string[] = [
  "*://chromewebstore.google.com/*",
  "*://chrome.google.com/webstore*",
];
const RESTRICTED_WEB_STORE_EXCLUDE_SET = new Set(RESTRICTED_WEB_STORE_EXCLUDE_MATCHES);

/**
 * Matches Chromium's `ExtensionsClient::IsScriptableURL` Web Store boundary:
 * third-party extensions may never inject scripts/CSS, read cookies, or gain host/activeTab
 * access on the Chrome Web Store origin.
 */
export function isRestrictedWebStoreUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "chromewebstore.google.com") return true;
    if (host === "chrome.google.com" && /^\/webstore(?:\/|$)/u.test(parsed.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

interface NormalizedContentScriptScope {
  readonly matches: readonly string[];
  readonly excludeMatches: readonly string[];
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly allFrames: boolean;
  readonly matchAboutBlank: boolean;
  readonly matchOriginAsFallback: boolean;
}

function normalizedContentScripts(manifest: unknown): NormalizedContentScriptScope[] {
  if (!isRecord(manifest) || !Array.isArray(manifest.content_scripts)) return [];
  const result: NormalizedContentScriptScope[] = [];
  for (const script of manifest.content_scripts) {
    if (!isRecord(script)) continue;
    result.push({
      matches: [...new Set(stringList(script.matches))].sort(),
      excludeMatches: [
        ...new Set(
          stringList(script.exclude_matches).filter(
            (pattern) => !RESTRICTED_WEB_STORE_EXCLUDE_SET.has(pattern),
          ),
        ),
      ].sort(),
      includeGlobs: [...new Set(stringList(script.include_globs))].sort(),
      excludeGlobs: [...new Set(stringList(script.exclude_globs))].sort(),
      allFrames: script.all_frames === true,
      matchAboutBlank: script.match_about_blank === true,
      matchOriginAsFallback: script.match_origin_as_fallback === true,
    });
  }
  return result;
}

export function declaredContentScriptMatches(manifest: unknown): string[] {
  const matches = new Set<string>();
  for (const script of normalizedContentScripts(manifest)) {
    for (const pattern of script.matches) matches.add(pattern);
  }
  return [...matches];
}

export function hasManifestPermission(manifest: unknown, permission: string): boolean {
  return declaredPermissions(manifest).includes(permission);
}

export function hasHostPermission(manifest: unknown, url: string): boolean {
  if (isRestrictedWebStoreUrl(url)) return false;
  return declaredHostPermissions(manifest).some((pattern) => matchesPattern(pattern, url));
}

/**
 * Chrome's rule for exposing sensitive tab fields (`url`, `title`, `favIconUrl`):
 * requires `tabs`, host permission for the tab's URL, or an `activeTab` grant on that tab.
 */
export function canReadTabDetails(
  manifest: unknown,
  tabUrl: string | undefined,
  activeTabGranted: boolean,
): boolean {
  if (activeTabGranted) return true;
  if (hasManifestPermission(manifest, "tabs")) return true;
  if (tabUrl && hasHostPermission(manifest, tabUrl)) return true;
  return false;
}

/**
 * Chrome's rule for `chrome.cookies.*` and `chrome.cookies.onChanged`:
 * requires both the `cookies` API permission and host access to the cookie's URL.
 */
export function canAccessCookieUrl(manifest: unknown, url: string): boolean {
  return hasManifestPermission(manifest, "cookies") && hasHostPermission(manifest, url);
}

/** Constructs synthetic URLs for an Electron Cookie so Chrome host match patterns can check it. */
export function cookieAccessUrls(cookie: {
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
}): string[] {
  const rawDomain = (cookie.domain ?? "").replace(/^\./u, "").trim();
  if (!rawDomain) return [];
  const cookiePath = cookie.path?.startsWith("/") ? cookie.path : "/";
  if (cookie.secure) return [`https://${rawDomain}${cookiePath}`];
  return [`https://${rawDomain}${cookiePath}`, `http://${rawDomain}${cookiePath}`];
}

function hostPatternsCoveredBy(previous: readonly string[], next: readonly string[]): boolean {
  return next.every((target) => previous.some((existing) => patternCovers(existing, target)));
}

/**
 * Returns true when `next` requests any API permission, host permission, or content-script
 * effective scope (matches, removed exclusions, `all_frames`, `match_about_blank`) not covered
 * by `previous`.
 */
export function permissionsExpanded(previous: unknown, next: unknown): boolean {
  const prevPerms = new Set(declaredPermissions(previous));
  for (const perm of declaredPermissions(next)) {
    if (!prevPerms.has(perm)) return true;
  }
  const prevHosts = declaredHostPermissions(previous);
  const nextHosts = declaredHostPermissions(next);
  if (!hostPatternsCoveredBy(prevHosts, nextHosts)) return true;

  const prevScripts = normalizedContentScripts(previous);
  const nextScripts = normalizedContentScripts(next);
  for (const nextScript of nextScripts) {
    // Each new content script entry must be covered by at least one previous entry
    // with >= match scope, <= exclusions (every previous exclude_matches / exclude_globs
    // still excluded), >= include_globs restriction, and >= frame/about:blank/fallback scope.
    const covered = prevScripts.some(
      (prevScript) =>
        hostPatternsCoveredBy(prevScript.matches, nextScript.matches) &&
        (!nextScript.allFrames || prevScript.allFrames) &&
        (!nextScript.matchAboutBlank || prevScript.matchAboutBlank) &&
        (!nextScript.matchOriginAsFallback || prevScript.matchOriginAsFallback) &&
        prevScript.excludeMatches.every((excluded) =>
          nextScript.excludeMatches.some((nextEx) => patternCovers(nextEx, excluded)),
        ) &&
        (prevScript.includeGlobs.length === 0 ||
          (nextScript.includeGlobs.length > 0 &&
            nextScript.includeGlobs.every((nextGlob) =>
              prevScript.includeGlobs.some((prevGlob) => prevGlob === "*" || prevGlob === nextGlob),
            ))) &&
        prevScript.excludeGlobs.every((prevEx) =>
          nextScript.excludeGlobs.some((nextEx) => nextEx === "*" || nextEx === prevEx),
        ),
    );
    if (!covered) return true;
  }
  return false;
}

/** Verifies that a downloaded Store manifest matches what the user approved in the install sheet. */
export function sameApprovedManifest(approved: unknown, installed: unknown): boolean {
  if (!isRecord(approved) || !isRecord(installed)) return false;
  const normalize = (manifest: Record<string, unknown>) =>
    JSON.stringify([
      typeof manifest.version === "string" ? manifest.version : null,
      [...declaredPermissions(manifest)].sort(),
      [...declaredHostPermissions(manifest)].sort(),
      normalizedContentScripts(manifest).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    ]);
  return normalize(approved) === normalize(installed);
}

/** Chrome's install warning for the sites an extension can read and change, if any. */
export function siteAccess(manifest: unknown): string | null {
  if (!isRecord(manifest)) return null;
  const patterns = new Set<string>([
    ...declaredHostPermissions(manifest),
    ...declaredContentScriptMatches(manifest),
  ]);
  const hosts = new Set<string>();
  for (const pattern of patterns) {
    const parsed = parseMatchPattern(pattern);
    if (!parsed) continue;
    if (parsed.allUrls || parsed.host === "*") {
      return "It can read and change your data on all websites.";
    }
    const cleanHost = parsed.host.replace(/^\*\./u, "");
    if (cleanHost) hosts.add(cleanHost);
  }
  const hostList = [...hosts];
  if (!hostList.length) return null;
  const sites =
    hostList.length === 1
      ? hostList[0]
      : hostList.length === 2
        ? `${hostList[0]} and ${hostList[1]}`
        : `${hostList[0]} and ${hostList.length - 1} other sites`;
  return `It can read and change your data on ${sites}.`;
}

/** Full Chrome-style install permission warnings derived from a verified manifest. */
export function permissionWarnings(manifest: unknown): string[] {
  const warnings: string[] = [];
  const access = siteAccess(manifest);
  if (access) warnings.push(access);
  const perms = new Set(declaredPermissions(manifest));
  if (perms.has("tabs") || perms.has("webNavigation")) {
    warnings.push("Read your browsing history.");
  }
  if (perms.has("cookies")) {
    warnings.push("Read and change your cookies.");
  }
  if (perms.has("contextMenus")) {
    warnings.push("Add items to your right-click menu.");
  }
  if (perms.has("notifications")) {
    warnings.push("Display notifications.");
  }
  if (perms.has("scripting")) {
    warnings.push("Run scripts on websites you visit.");
  }
  return warnings;
}

/**
 * Resolves a relative file path inside an extension directory, preventing directory
 * traversal and sibling-prefix escapes (`root + path.sep`).
 */
export function resolveExtensionFile(extensionRoot: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes("\0")) return null;
  const root = path.resolve(extensionRoot);
  const cleaned = relativePath.replace(/^\/+/u, "");
  if (!cleaned) return null;
  const resolved = path.resolve(root, cleaned);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * Validates URLs supplied by an extension to navigation APIs (`tabs.create`, `tabs.update`,
 * `windows.create`). Allowlists `http:`, `https:`, `about:blank`, and the extension's own pages.
 */
export function validateExtensionUrl(rawUrl: string, extensionId: string): string {
  if (rawUrl === "about:blank") return rawUrl;
  const base = `chrome-extension://${extensionId}/`;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, base);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return parsed.href;
  }
  if (parsed.protocol === "chrome-extension:" && parsed.href.startsWith(base)) {
    return parsed.href;
  }
  throw new Error("Disallowed extension URL scheme.");
}

/** Resolves a popup or options path strictly within the extension's own origin. */
export function resolveExtensionPageUrl(
  extensionId: string,
  pagePath: string | undefined,
): string | null {
  if (!pagePath) return null;
  const base = `chrome-extension://${extensionId}/`;
  try {
    const resolved = new URL(pagePath, base).href;
    return resolved.startsWith(base) ? resolved : null;
  } catch {
    return null;
  }
}

/** Extracts a Chrome extension ID from a `chrome-extension://<id>` origin or worker scope. */
export function extensionIdFromOrigin(originOrScope: string | undefined | null): string | null {
  if (!originOrScope) return null;
  try {
    const url = new URL(originOrScope);
    if (url.protocol !== "chrome-extension:") return null;
    return isExtensionId(url.hostname) ? url.hostname : null;
  } catch {
    return null;
  }
}
