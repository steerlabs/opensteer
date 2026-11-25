/**
 * What a page's `will-redirect` needs to judge a redirect into an extension, which Electron does
 * not give it: `will-redirect` names the frame that started the navigation, never the response
 * that redirects. The session's `onBeforeRedirect`, which on real Electron 44 runs before
 * `will-redirect` for the same hop (main frames and subframes, started by a page or by the
 * browser), names that response's URL.
 *
 * It also follows an extension's dynamic address (`use_dynamic_url`), which is only an alias of
 * its static address: Chromium rewrites every request to it into a redirect to the static one
 * (the "dynamic hop"). A navigation to a dynamic address is judged at that hop by how it came
 * there: the frame that started it (`did-start-navigation`), the browser itself, or the web
 * origin whose redirect led there. Subresource hops are followed by request id.
 *
 * One store per Session. Every record is used once; a frame's records go when it starts another
 * navigation or ends one, and a page's when it is destroyed.
 */
import { isDynamicExtensionHost } from "./web-accessible.js";

const maxEntries = 256;
const maxAgeMs = 10_000;

/** Who a navigation to a dynamic address is judged as at its hop. */
export type DynamicJudge =
  | { readonly kind: "browser" }
  | { readonly kind: "initiator"; readonly origin: string | undefined }
  | { readonly kind: "redirect"; readonly origin: string };

/** A redirect into an extension: by a web response (`from`), or Chromium's dynamic hop. */
export type ExtensionRedirect =
  | { readonly dynamicHop: false; readonly from: string | undefined }
  | { readonly dynamicHop: true; readonly judge: DynamicJudge | undefined };

interface Timed<T> {
  readonly value: T;
  readonly at: number;
}

class Store {
  /** How a navigation to a dynamic address started, by `wc:frame:url`. */
  readonly starts = new Map<string, Timed<DynamicJudge>>();
  /** Redirects into an extension, by `wc:frame:toUrl`. */
  readonly redirects = new Map<string, Timed<ExtensionRedirect>>();
  /** Subresource dynamic hops, by request id. */
  readonly requestHops = new Map<number, Timed<string>>();
}

const stores = new WeakMap<object, Store>();

function storeOf(session: object): Store {
  let store = stores.get(session);
  if (!store) {
    store = new Store();
    stores.set(session, store);
  }
  return store;
}

function key(webContentsId: number, frameTreeNodeId: number, url: string): string {
  return `${webContentsId}:${frameTreeNodeId}:${url}`;
}

function put<K, V>(map: Map<K, Timed<V>>, id: K, value: V): void {
  map.delete(id);
  if (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(id, { value, at: Date.now() });
}

function take<K, V>(map: Map<K, Timed<V>>, id: K): V | undefined {
  const entry = map.get(id);
  if (!entry) return undefined;
  map.delete(id);
  return Date.now() - entry.at <= maxAgeMs ? entry.value : undefined;
}

function dropPrefix(map: Map<string, unknown>, prefix: string): void {
  for (const id of map.keys()) if (id.startsWith(prefix)) map.delete(id);
}

/** Whether `url` is an address at an extension's dynamic host. */
export function isDynamicExtensionUrl(url: string): boolean {
  if (!url.startsWith("chrome-extension:")) return false;
  try {
    return isDynamicExtensionHost(new URL(url).hostname);
  } catch {
    return false;
  }
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

/**
 * A frame starts a navigation: its earlier records go. When the address is a dynamic one, how it
 * started is kept for the hop: by `initiatorOrigin` (a page's navigation; undefined when the
 * frame is gone) or by the browser itself (`browserStarted`).
 */
export function extensionNavigationStarted(
  session: object,
  webContentsId: number,
  frameTreeNodeId: number,
  url: string,
  start: { readonly browserStarted: true } | { readonly initiatorOrigin: string | undefined },
): void {
  extensionNavigationEnded(session, webContentsId, frameTreeNodeId);
  if (!isDynamicExtensionUrl(url)) return;
  put(
    storeOf(session).starts,
    key(webContentsId, frameTreeNodeId, url),
    "browserStarted" in start
      ? { kind: "browser" }
      : { kind: "initiator", origin: start.initiatorOrigin },
  );
}

/** A frame's navigation ended (committed or failed): its records go. */
export function extensionNavigationEnded(
  session: object,
  webContentsId: number,
  frameTreeNodeId: number,
): void {
  const store = stores.get(session);
  if (!store || (store.starts.size === 0 && store.redirects.size === 0)) return;
  const prefix = `${webContentsId}:${frameTreeNodeId}:`;
  dropPrefix(store.starts, prefix);
  dropPrefix(store.redirects, prefix);
}

/** A page is gone: every record of it goes. */
export function forgetExtensionNavigations(session: object, webContentsId: number): void {
  const store = stores.get(session);
  if (!store) return;
  dropPrefix(store.starts, `${webContentsId}:`);
  dropPrefix(store.redirects, `${webContentsId}:`);
}

/**
 * A web response redirected the frame's navigation into a dynamic address: the hop that follows is
 * judged as that origin.
 */
export function extensionRedirectedIntoDynamic(
  session: object,
  webContentsId: number,
  frameTreeNodeId: number,
  dynamicUrl: string,
  origin: string,
): void {
  put(storeOf(session).starts, key(webContentsId, frameTreeNodeId, dynamicUrl), {
    kind: "redirect",
    origin,
  });
}

/** Records that the response at `fromUrl` redirected the frame's navigation to `toUrl`. */
export function recordExtensionRedirect(
  session: object,
  webContentsId: number,
  frameTreeNodeId: number,
  fromUrl: string,
  toUrl: string,
): void {
  const store = storeOf(session);
  if (isDynamicExtensionHop(fromUrl, toUrl)) {
    put(store.redirects, key(webContentsId, frameTreeNodeId, toUrl), {
      dynamicHop: true,
      judge: take(store.starts, key(webContentsId, frameTreeNodeId, fromUrl)),
    });
    return;
  }
  let from: string | undefined;
  try {
    const parsed = new URL(fromUrl);
    from = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    from = undefined;
  }
  put(store.redirects, key(webContentsId, frameTreeNodeId, toUrl), { dynamicHop: false, from });
}

/**
 * The redirect that sent the frame's navigation to `toUrl`, once; undefined when no such
 * redirect was seen (a service worker's redirect, a stale, purged or foreign one).
 */
export function takeExtensionRedirect(
  session: object,
  webContentsId: number,
  frameTreeNodeId: number | undefined,
  toUrl: string,
): ExtensionRedirect | undefined {
  if (frameTreeNodeId === undefined) return undefined;
  const store = stores.get(session);
  return store ? take(store.redirects, key(webContentsId, frameTreeNodeId, toUrl)) : undefined;
}

/** Records Chromium's dynamic-to-static rewrite of a subresource request (same request id). */
export function recordDynamicExtensionRequestHop(
  session: object,
  requestId: number,
  toUrl: string,
): void {
  put(storeOf(session).requestHops, requestId, toUrl);
}

/** Whether request `requestId` reached `url` by Chromium's own dynamic-to-static rewrite, once. */
export function takeDynamicExtensionRequestHop(
  session: object,
  requestId: number,
  url: string,
): boolean {
  const store = stores.get(session);
  const entry = store?.requestHops.get(requestId);
  if (!store || !entry || entry.value !== url) return false;
  return take(store.requestHops, requestId) === url;
}
