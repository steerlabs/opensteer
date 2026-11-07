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

const caches = new WeakMap<BrowserFrameStore, Map<string, Entry>>();

function cacheFor(frames: BrowserFrameStore) {
  let cache = caches.get(frames);
  if (!cache) {
    cache = new Map();
    caches.set(frames, cache);
  }
  return cache;
}

function pictureKey(sessionId: string, tabId: string): string {
  return JSON.stringify([sessionId, tabId]);
}

/** A device-local picture already presented, scoped to the reader's frame store and session. */
export function getBrowserLastPicture(
  frames: BrowserFrameStore,
  sessionId: string,
  tabId: string,
): BrowserLastPicture | null {
  const cache = cacheFor(frames);
  const key = pictureKey(sessionId, tabId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.invalidation !== frames.invalidationKey?.(sessionId, tabId)) {
    entry.unsubscribe();
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.picture;
}

export function rememberBrowserLastPicture(
  frames: BrowserFrameStore,
  sessionId: string,
  tabId: string,
  frame: BrowserFrameView,
): void {
  if (!frames.invalidationKey || frame.header.surfaceId !== tabId) return;
  const cache = cacheFor(frames);
  const key = pictureKey(sessionId, tabId);
  if (cache.get(key)?.picture.frame === frame) return;
  cache.get(key)?.unsubscribe();
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
      cache.get(key)?.unsubscribe();
      cache.delete(key);
    },
    tabId,
  );
  cache.delete(key);
  cache.set(key, { picture, unsubscribe, invalidation });
  while (cache.size > 4) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.get(oldest)?.unsubscribe();
    cache.delete(oldest);
  }
}
