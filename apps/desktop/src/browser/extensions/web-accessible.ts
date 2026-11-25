import {
  globMatch,
  isExtensionId,
  isRecord,
  parseMatchPattern,
  parsePatternHost,
  patternHostMatches,
} from "./permissions.js";

/** The manifest of an extension loaded in the page's profile, or undefined when none is. */
export type ExtensionManifestLookup = (extensionId: string) => unknown;

const extensionScheme = "chrome-extension:";
const dynamicHostPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Whether `hostname` is an extension's dynamic host: the per-session random host
 * `chrome.runtime.getURL()` gives a `use_dynamic_url` resource on Electron 44.
 */
export function isDynamicExtensionHost(hostname: string): boolean {
  return dynamicHostPattern.test(hostname.toLowerCase());
}

/**
 * Whether a page whose frame has `initiatorOrigin` may reach the extension address `target` by
 * its own navigation or request, as Chrome allows it: always from the extension's own pages, and
 * otherwise only when the extension lists the resource as web-accessible for that origin. An
 * address that is not an extension address is not this rule's to decide and is let through. A
 * refused address reads the same whether the extension is absent, not loaded in this profile,
 * or present with the resource not listed.
 *
 * Stricter than Chrome where Chrome's behavior is not documented: the path is compared after
 * decoding, case-sensitively; a path with `.`/`..` segments, a backslash or a NUL is refused;
 * MV3 `matches` match only web (http/https) initiators and only with the path `/*`; an entry
 * with `use_dynamic_url` grants nothing at the extension's own address; an unknown or opaque
 * initiator matches no MV3 entry.
 *
 * An address at an extension's dynamic host (`use_dynamic_url`) is only an alias of its static
 * address, which this rule cannot see from it: it is let through here, and judged where Chromium
 * rewrites it into the static address (on real Electron 44 every request to a dynamic host becomes
 * that redirect; probe 20261125T022627Z-0fb895a2). A navigation is judged at that hop by its
 * caller with `dynamicAlias: true`; a subresource is left to Chromium, which judges the hop by the
 * request's own initiator.
 *
 * `options.redirect: true` judges a server redirect into an extension: `initiatorOrigin` is then
 * the origin of the response that redirects, which must be a web (http/https) origin; neither the
 * own-pages allowance nor `extension_ids` applies, whoever started the navigation.
 *
 * `options.dynamicAlias: true` judges the static address a dynamic one was rewritten into: an entry
 * with `use_dynamic_url` then counts as listed.
 */
export function mayReachExtensionResource(
  target: string,
  initiatorOrigin: string | undefined,
  manifestOf: ExtensionManifestLookup,
  options: { readonly redirect?: boolean; readonly dynamicAlias?: boolean } = {},
): boolean {
  const redirect = options.redirect === true;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (
    url.protocol === "blob:" ||
    url.protocol === "filesystem:" ||
    url.protocol === "view-source:"
  ) {
    // A wrapped extension address (`blob:chrome-extension://…`) is never web-accessible: only
    // the extension's own pages reach it.
    const inner = extensionOrigin(url.pathname);
    return inner === null || (!redirect && inner === initiatorOrigin);
  }
  if (url.protocol !== extensionScheme) return true;
  // Chromium treats chrome-extension as a standard scheme: its host is case-insensitive.
  const extensionId = url.hostname.toLowerCase();
  if (url.port || url.username || url.password) return false;
  if (redirect && !isWebOrigin(initiatorOrigin)) return false;
  if (isDynamicExtensionHost(extensionId)) return true;
  if (!isExtensionId(extensionId)) return false;
  if (!redirect && initiatorOrigin === `${extensionScheme}//${extensionId}`) return true;
  const resource = resourcePath(url.pathname);
  if (resource === undefined) return false;
  const manifest = manifestOf(extensionId);
  if (!isRecord(manifest)) return false;
  return isWebAccessibleResource(
    manifest,
    resource,
    initiatorOrigin,
    options.dynamicAlias === true,
  );
}

/** Whether `manifest` lists `resource` (a decoded path without the leading slash) for `initiatorOrigin`. */
export function isWebAccessibleResource(
  manifest: Record<string, unknown>,
  resource: string,
  initiatorOrigin: string | undefined,
  dynamicAlias = false,
): boolean {
  const entries = manifest.web_accessible_resources;
  if (!Array.isArray(entries)) return false;
  if (manifest.manifest_version === 2)
    return entries.some((entry) => typeof entry === "string" && resourceMatches(entry, resource));
  if (manifest.manifest_version !== 3) return false;
  return entries.some(
    (entry) =>
      isRecord(entry) &&
      (dynamicAlias || entry.use_dynamic_url !== true) &&
      Array.isArray(entry.resources) &&
      entry.resources.some(
        (pattern) => typeof pattern === "string" && resourceMatches(pattern, resource),
      ) &&
      initiatorAdmitted(entry, initiatorOrigin),
  );
}

function initiatorAdmitted(entry: Record<string, unknown>, initiatorOrigin: string | undefined) {
  if (!initiatorOrigin) return false;
  if (initiatorOrigin.startsWith(`${extensionScheme}//`)) {
    const initiatorId = initiatorOrigin.slice(extensionScheme.length + 2);
    return (
      isExtensionId(initiatorId) &&
      Array.isArray(entry.extension_ids) &&
      entry.extension_ids.some((id) => id === "*" || id === initiatorId)
    );
  }
  let origin: URL;
  try {
    origin = new URL(initiatorOrigin);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  return (
    Array.isArray(entry.matches) &&
    entry.matches.some((pattern) => typeof pattern === "string" && originMatches(pattern, origin))
  );
}

function isWebOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const protocol = new URL(origin).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function originMatches(pattern: string, origin: URL): boolean {
  const parsed = parseMatchPattern(pattern);
  if (!parsed || parsed.pathPattern !== "/*") return false;
  if (parsed.allUrls) return true;
  const scheme = origin.protocol.slice(0, -1);
  if (parsed.scheme !== "*" && parsed.scheme !== scheme) return false;
  if (parsed.scheme === "chrome-extension") return false;
  const host = parsePatternHost(parsed.host);
  return host !== null && patternHostMatches(host, origin);
}

function resourceMatches(pattern: string, resource: string): boolean {
  const normalized = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  return normalized.length > 0 && globMatch(normalized, resource);
}

/** The extension origin a wrapped URL's inner URL belongs to, "" for a malformed extension one, or null. */
function extensionOrigin(inner: string): string | null {
  let url: URL;
  try {
    url = new URL(inner);
  } catch {
    return null;
  }
  if (url.protocol === "blob:" || url.protocol === "filesystem:" || url.protocol === "view-source:")
    return extensionOrigin(url.pathname);
  if (url.protocol !== extensionScheme) return null;
  const extensionId = url.hostname.toLowerCase();
  return isExtensionId(extensionId) ? `${extensionScheme}//${extensionId}` : "";
}

/** The decoded resource path without its leading slash, or undefined when it may not be matched. */
function resourcePath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0"))
    return undefined;
  const resource = decoded.slice(1);
  if (!resource) return undefined;
  if (resource.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  return resource;
}
