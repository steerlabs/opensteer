/**
 * Who sends a navigation into an extension by a server redirect. Electron's `will-redirect`
 * names the frame that started the navigation, never the response that redirects; the session's
 * `onBeforeRedirect`, which on real Electron 44 runs before `will-redirect` for the same hop
 * (main frames and subframes, started by a page or by the browser), names that response's URL.
 * The session records the redirecting origin here and the page's `will-redirect` takes it.
 */
const maxEntries = 256;
const maxAgeMs = 10_000;

interface Entry {
  readonly origin: string | undefined;
  readonly at: number;
}

const entries = new Map<string, Entry>();

function key(webContentsId: number, frameTreeNodeId: number, url: string): string {
  return `${webContentsId}:${frameTreeNodeId}:${url}`;
}

/** Records that the response at `fromUrl` redirected the frame's navigation to `toUrl`. */
export function recordExtensionRedirect(
  webContentsId: number,
  frameTreeNodeId: number,
  fromUrl: string,
  toUrl: string,
): void {
  let origin: string | undefined;
  try {
    const from = new URL(fromUrl);
    origin = from.protocol === "http:" || from.protocol === "https:" ? from.origin : undefined;
  } catch {
    origin = undefined;
  }
  const id = key(webContentsId, frameTreeNodeId, toUrl);
  entries.delete(id);
  if (entries.size >= maxEntries) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(id, { origin, at: Date.now() });
}

/**
 * The origin of the response that redirected the frame's navigation to `toUrl`, once; undefined
 * when no such redirect was seen (a service worker's redirect, a stale or foreign one).
 */
export function takeExtensionRedirectOrigin(
  webContentsId: number,
  frameTreeNodeId: number | undefined,
  toUrl: string,
): string | undefined {
  if (frameTreeNodeId === undefined) return undefined;
  const id = key(webContentsId, frameTreeNodeId, toUrl);
  const entry = entries.get(id);
  if (!entry) return undefined;
  entries.delete(id);
  return Date.now() - entry.at <= maxAgeMs ? entry.origin : undefined;
}
