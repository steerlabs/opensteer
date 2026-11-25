/**
 * Who sends a navigation into an extension by a redirect. Electron's `will-redirect` names the
 * frame that started the navigation, never the response that redirects; the session's
 * `onBeforeRedirect`, which on real Electron 44 runs before `will-redirect` for the same hop
 * (main frames and subframes, started by a page or by the browser), names that response's URL.
 * The session records the redirecting origin here and the page's `will-redirect` takes it.
 *
 * It also records Chromium's own rewrite of an extension's dynamic address (`use_dynamic_url`)
 * into its static one: every request to the dynamic host becomes such a redirect, and Chromium
 * enforces the resource's access at the static address itself.
 */
import { isDynamicExtensionHost } from "./web-accessible.js";

const maxEntries = 256;
const maxAgeMs = 10_000;

/** A redirect into an extension: by a web response (`from`), or Chromium's own dynamic hop. */
export interface ExtensionRedirect {
  readonly from: string | undefined;
  readonly dynamicHop: boolean;
}

interface Entry extends ExtensionRedirect {
  readonly at: number;
}

const entries = new Map<string, Entry>();
const requestHops = new Map<number, { readonly url: string; readonly at: number }>();

function key(webContentsId: number, frameTreeNodeId: number, url: string): string {
  return `${webContentsId}:${frameTreeNodeId}:${url}`;
}

function bounded<K, V>(map: Map<K, V>, id: K, value: V): void {
  map.delete(id);
  if (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(id, value);
}

/**
 * Whether `fromUrl` → `toUrl` is Chromium's rewrite of an extension's dynamic address into its
 * static address: the same path and query, from a dynamic host to an extension id.
 */
export function isDynamicExtensionHop(fromUrl: string, toUrl: string): boolean {
  let from: URL;
  let to: URL;
  try {
    from = new URL(fromUrl);
    to = new URL(toUrl);
  } catch {
    return false;
  }
  return (
    from.protocol === "chrome-extension:" &&
    to.protocol === "chrome-extension:" &&
    isDynamicExtensionHost(from.hostname) &&
    /^[a-p]{32}$/u.test(to.hostname.toLowerCase()) &&
    from.pathname === to.pathname &&
    from.search === to.search
  );
}

/** Records that the response at `fromUrl` redirected the frame's navigation to `toUrl`. */
export function recordExtensionRedirect(
  webContentsId: number,
  frameTreeNodeId: number,
  fromUrl: string,
  toUrl: string,
): void {
  const dynamicHop = isDynamicExtensionHop(fromUrl, toUrl);
  let from: string | undefined;
  try {
    const parsed = new URL(fromUrl);
    from =
      !dynamicHop && (parsed.protocol === "http:" || parsed.protocol === "https:")
        ? parsed.origin
        : undefined;
  } catch {
    from = undefined;
  }
  bounded(entries, key(webContentsId, frameTreeNodeId, toUrl), {
    from,
    dynamicHop,
    at: Date.now(),
  });
}

/**
 * The redirect that sent the frame's navigation to `toUrl`, once; undefined when no such
 * redirect was seen (a service worker's redirect, a stale or foreign one).
 */
export function takeExtensionRedirect(
  webContentsId: number,
  frameTreeNodeId: number | undefined,
  toUrl: string,
): ExtensionRedirect | undefined {
  if (frameTreeNodeId === undefined) return undefined;
  const id = key(webContentsId, frameTreeNodeId, toUrl);
  const entry = entries.get(id);
  if (!entry) return undefined;
  entries.delete(id);
  return Date.now() - entry.at <= maxAgeMs
    ? { from: entry.from, dynamicHop: entry.dynamicHop }
    : undefined;
}

/** Records Chromium's dynamic-to-static rewrite of a subresource request (same request id). */
export function recordDynamicExtensionRequestHop(requestId: number, toUrl: string): void {
  bounded(requestHops, requestId, { url: toUrl, at: Date.now() });
}

/** Whether request `requestId` reached `url` by Chromium's own dynamic-to-static rewrite, once. */
export function takeDynamicExtensionRequestHop(requestId: number, url: string): boolean {
  const hop = requestHops.get(requestId);
  if (!hop || hop.url !== url) return false;
  requestHops.delete(requestId);
  return Date.now() - hop.at <= maxAgeMs;
}
