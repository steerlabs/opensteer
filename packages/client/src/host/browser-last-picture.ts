import { encodeBase64Url } from "@opensteer/shared/base64url";
import type { BrowserFrameStore, BrowserFrameView } from "./client.js";
import type { PlaceItem } from "./places.js";

export interface BrowserLastPicture {
  readonly frame: BrowserFrameView;
  readonly uri: string;
}

/** A still picture of a tab, whatever kept it. It shows what the page was, never that it is live. */
export interface BrowserTabPicture {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

interface Entry {
  readonly picture: BrowserLastPicture;
  readonly invalidation: string | number | undefined;
  readonly unsubscribe: () => void;
  /** The page the picture belongs to, once the place list has named it. */
  documentId: string | null | undefined;
}

/**
 * Pictures are the compressed frames already received, never copies or
 * re-encodings; a row decodes one at the size it draws. A phone's live page
 * sends ~50–150 KB frames, so the count binds first; the byte cap bounds a
 * desktop-sized frame.
 */
const keptPictures = 8;
const keptBytes = 3 * 1024 * 1024;

const caches = new WeakMap<BrowserFrameStore, Map<string, Entry>>();
/** Each listed tab's page as of the latest place list, so a picture is tied to the page it shows. */
const listedDocuments = new WeakMap<BrowserFrameStore, ReadonlyMap<string, string | null>>();

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

function current(
  frames: BrowserFrameStore,
  sessionId: string,
  tabId: string,
): { readonly key: string; readonly entry: Entry } | null {
  const cache = cacheFor(frames);
  const key = pictureKey(sessionId, tabId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.invalidation !== frames.invalidationKey?.(sessionId, tabId)) {
    entry.unsubscribe();
    cache.delete(key);
    return null;
  }
  return { key, entry };
}

/** A device-local picture already presented, scoped to the reader's frame store and session. */
export function getBrowserLastPicture(
  frames: BrowserFrameStore,
  sessionId: string,
  tabId: string,
): BrowserLastPicture | null {
  const found = current(frames, sessionId, tabId);
  if (!found) return null;
  const cache = cacheFor(frames);
  cache.delete(found.key);
  cache.set(found.key, found.entry);
  return found.entry.picture;
}

/**
 * What a list row may show for a tab: a picture this device already holds.
 * Asking never streams, requests, subscribes or reorders what is kept.
 */
export function browserTabPicture(
  client: { readonly browserWatchFrames: BrowserFrameStore; readonly browserFrames: BrowserFrameStore },
  sessionId: string,
  tabId: string,
): BrowserTabPicture | null {
  for (const frames of [client.browserWatchFrames, client.browserFrames]) {
    const picture = current(frames, sessionId, tabId)?.entry.picture;
    if (picture)
      return {
        get uri() {
          return picture.uri;
        },
        width: picture.frame.header.rasterWidth,
        height: picture.frame.header.rasterHeight,
      };
  }
  return null;
}

/**
 * Forgets pictures of tabs no longer listed, and of tabs that have since
 * loaded another page, whose picture would show the wrong one.
 */
export function keepBrowserLastPictures(
  frames: BrowserFrameStore,
  places: readonly PlaceItem[],
): void {
  const documents = new Map<string, string | null>();
  for (const place of places)
    if (place.destination.kind === "browser" && place.destination.tabId && place.browser)
      documents.set(
        pictureKey(place.destination.sessionId, place.destination.tabId),
        place.browser.documentId,
      );
  listedDocuments.set(frames, documents);
  for (const [key, entry] of caches.get(frames) ?? []) {
    const documentId = documents.get(key);
    if (documentId === undefined || (entry.documentId != null && entry.documentId !== documentId)) {
      entry.unsubscribe();
      caches.get(frames)?.delete(key);
    } else entry.documentId ??= documentId;
  }
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
  cache.set(key, {
    picture,
    unsubscribe,
    invalidation,
    documentId: listedDocuments.get(frames)?.get(key),
  });
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.picture.frame.data.byteLength;
  while (cache.size > keptPictures || (cache.size > 1 && bytes > keptBytes)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const entry = cache.get(oldest)!;
    bytes -= entry.picture.frame.data.byteLength;
    entry.unsubscribe();
    cache.delete(oldest);
  }
}
