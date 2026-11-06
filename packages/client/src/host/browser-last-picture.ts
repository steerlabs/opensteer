import { encodeBase64Url } from "@opensteer/shared/base64url";
import type { BrowserFrameStore, BrowserFrameView } from "./client.js";

export interface BrowserLastPicture {
  readonly frame: BrowserFrameView;
  readonly uri: string;
}

interface Entry {
  readonly picture: BrowserLastPicture;
  readonly invalidation: string | number | undefined;
  readonly unsubscribe: () => void;
}

const caches = new WeakMap<BrowserFrameStore, { sessionId: string; entries: Map<string, Entry> }>();

function cacheFor(frames: BrowserFrameStore, sessionId: string) {
  let cache = caches.get(frames);
  if (cache?.sessionId !== sessionId) {
    if (cache) for (const entry of cache.entries.values()) entry.unsubscribe();
    cache = { sessionId, entries: new Map() };
    caches.set(frames, cache);
  }
  return cache;
}

/** A device-local picture already presented, scoped to the reader's frame store and session. */
export function getBrowserLastPicture(
  frames: BrowserFrameStore,
  sessionId: string,
  tabId: string,
): BrowserLastPicture | null {
  const cache = cacheFor(frames, sessionId);
  const entry = cache.entries.get(tabId);
  if (!entry) return null;
  if (entry.invalidation !== frames.invalidationKey?.(sessionId, tabId)) {
    entry.unsubscribe();
    cache.entries.delete(tabId);
    return null;
  }
  cache.entries.delete(tabId);
  cache.entries.set(tabId, entry);
  return entry.picture;
}

export function rememberBrowserLastPicture(
  frames: BrowserFrameStore,
  sessionId: string,
  tabId: string,
  frame: BrowserFrameView,
): void {
  if (!frames.invalidationKey || frame.header.surfaceId !== tabId) return;
  const cache = cacheFor(frames, sessionId);
  if (cache.entries.get(tabId)?.picture.frame === frame) return;
  cache.entries.get(tabId)?.unsubscribe();
  const invalidation = frames.invalidationKey?.(sessionId, tabId);
  let uri: string | undefined;
  const picture: BrowserLastPicture = {
    frame,
    get uri() {
      if (uri === undefined) {
        const base64 = encodeBase64Url(new Uint8Array(frame.data))
          .replaceAll("-", "+")
          .replaceAll("_", "/");
        uri = `data:image/${frame.header.encoding};base64,${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
      }
      return uri;
    },
  };
  // Authorization listeners keep no transport lease or frame credit alive.
  const unsubscribe = frames.subscribe(
    sessionId,
    () => {
      if (frames.invalidationKey?.(sessionId, tabId) === invalidation) return;
      cache.entries.get(tabId)?.unsubscribe();
      cache.entries.delete(tabId);
    },
    tabId,
  );
  cache.entries.delete(tabId);
  cache.entries.set(tabId, { picture, unsubscribe, invalidation });
  while (cache.entries.size > 4) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.entries.get(oldest)?.unsubscribe();
    cache.entries.delete(oldest);
  }
}
