import { PageOpenUrlSchema } from "@opensteer/core";
import { isAppNavigation } from "@opensteer/shared/appFrame";
import { desktopBridge } from "../../desktop/desktop-bridge.js";

/** How the workspace opens a web page a person followed, the same way it opens a reply's link. */
export type AppLinkOpener = (address: string) => void;

/** Where a page an app asked for may go: the workspace, and a way to ask the person first. */
export interface AppLinkPlaces {
  /** Null where there is no workspace (a settings page, an isolated view). */
  readonly open: AppLinkOpener | null;
  /** Asks in Opensteer's own chrome, which an app cannot press; `open` runs only if they agree. */
  readonly ask: (address: string, open: () => void) => void;
}

/**
 * Where a request to open a page came from. `frame`: the bootstrap in that
 * app's frame asked on its private port. `window`: desktop main caught a window
 * an app opened, or a navigation of its frame, naming the document it credits
 * (for a window, the focused frame, which need not be the one that opened it).
 */
export type AppLinkProof =
  | { readonly kind: "frame"; readonly frame: HTMLIFrameElement | null }
  | { readonly kind: "window"; readonly source: string };

export type AppLinkOutcome = "opened" | "asked" | "ignored";

/**
 * How long a press keeps a page active: Chromium and Gecko's five seconds, the
 * longest a browser keeps it, so every window below covers any press that
 * could still be lending its activation.
 */
const activationMs = 5_000;
/** Without a workspace, at most one page per this long, however often an app asks. */
const openMs = 700;
/** The same page is asked about once per this long, the life of the toast that asks. */
const askAgainMs = 4_500;
/** And no two questions closer than this, so an app cannot bury the person in them. */
const askMs = 300;

let pageInputAt = Number.NEGATIVE_INFINITY;
let lastOpenedAt = Number.NEGATIVE_INFINITY;
let lastAskedAt = Number.NEGATIVE_INFINITY;
const askedAt = new Map<string, number>();
/** Frames the pointer was over, and when it was last there; `Infinity` while it still is. */
const pointedFrames = new Map<HTMLIFrameElement, number>();
/** Which frame held focus, as last seen, and since when another frame last held it. */
let focusedFrame: Element | null = null;
const focusLeftAt = new Map<Element, number>();
let watchers = 0;
let stopWatching: (() => void) | null = null;

function now(): number {
  return performance.now();
}

/** Focus moving between frames raises nothing on this page, so it is looked at often. */
function noteFocus(at: number): void {
  if (typeof document === "undefined") return;
  const focused = document.activeElement;
  if (focused === focusedFrame) return;
  if (focusedFrame instanceof HTMLIFrameElement) focusLeftAt.set(focusedFrame, at);
  focusedFrame = focused;
}

/**
 * What this page can see of a person's input: its own presses (a press inside
 * a frame never reaches its listeners, while every key on the page does,
 * Tab included), which frame the pointer is over, and which frame holds focus.
 * Ref-counted so unmounting the last mounted shell or frame stops its timer.
 */
export function watchAppInput(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  watchers += 1;
  if (stopWatching === null) {
    const press = (event: Event) => {
      if (event.isTrusted) pageInputAt = now();
    };
    const over = (event: Event) => {
      if (event.target instanceof HTMLIFrameElement) pointedFrames.set(event.target, Infinity);
    };
    const out = (event: Event) => {
      if (event.target instanceof HTMLIFrameElement) pointedFrames.set(event.target, now());
    };
    const pressTypes = ["pointerdown", "pointerup", "mousedown", "keydown", "touchend"] as const;
    for (const type of pressTypes)
      window.addEventListener(type, press, { capture: true, passive: true });
    document.addEventListener("pointerover", over, { capture: true, passive: true });
    document.addEventListener("pointerout", out, { capture: true, passive: true });
    const timer = window.setInterval(() => noteFocus(now()), 200);
    stopWatching = () => {
      window.clearInterval(timer);
      for (const type of pressTypes) window.removeEventListener(type, press, { capture: true });
      document.removeEventListener("pointerover", over, { capture: true });
      document.removeEventListener("pointerout", out, { capture: true });
    };
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers = Math.max(0, watchers - 1);
    if (watchers === 0 && stopWatching !== null) {
      stopWatching();
      stopWatching = null;
    }
  };
}

/** The frame on this page the request speaks for, while it holds focus. */
function requestingFrame(proof: AppLinkProof): HTMLIFrameElement | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLIFrameElement)) return null;
  if (proof.kind === "frame") return focused === proof.frame ? focused : null;
  return focused.src && isAppNavigation(proof.source, focused.src) ? focused : null;
}

/**
 * Whether this page can tell that the press lending it activation was inside
 * `frame`. No browser says which frame a press was in, and an app can ask
 * whenever it likes and, in Chromium, move focus into itself at any moment.
 * But activation comes only from input, and this page sees enough of it: if
 * none of its own presses, no other frame under the pointer and no other frame
 * holding focus fall within an activation's lifetime, while the pointer is over
 * `frame` and focus is in it, then every press that could have activated the
 * page went to `frame`.
 */
function pressedIn(frame: HTMLIFrameElement, at: number): boolean {
  const since = at - activationMs;
  forgetGone(since, at);
  if (pageInputAt >= since) return false;
  // One press opens one page at once: what else the app asks for while it lasts is asked about.
  if (lastOpenedAt >= since) return false;
  // With another frame on the page, a press there (a tap, which leaves no pointer behind) could
  // be lending the activation, so only a frame alone on the page is credited without asking.
  for (const other of document.querySelectorAll("iframe")) if (other !== frame) return false;
  if (pointedFrames.get(frame) !== Infinity) return false;
  for (const [other, until] of pointedFrames) if (other !== frame && until >= since) return false;
  for (const [other, until] of focusLeftAt) if (other !== frame && until >= since) return false;
  return true;
}

/**
 * A frame removed while the pointer was over it never reports the pointer
 * leaving: it counts as left when first seen gone, and records older than an
 * activation are dropped, so neither blocks every later press.
 */
function forgetGone(since: number, at: number): void {
  for (const [frame, until] of pointedFrames) {
    if (until === Infinity && !frame.isConnected) pointedFrames.set(frame, at);
    else if (until < since) pointedFrames.delete(frame);
  }
  for (const [frame, until] of focusLeftAt) if (until < since) focusLeftAt.delete(frame);
  for (const [url, until] of askedAt) if (until < at - askAgainMs) askedAt.delete(url);
}

/** The person's own browser, for a page the workspace cannot open. */
function openOutside(url: string): void {
  const bridge = desktopBridge();
  if (bridge) {
    void bridge.openExternalUrl({ url }).catch((reason: unknown) => globalThis.reportError(reason));
    return;
  }
  globalThis.open?.(url, "_blank", "noopener,noreferrer");
}

/**
 * A web page a person followed out of an app opens where a reply's link does:
 * a tab in the workspace, in the profile the start page would choose, or the
 * person's own browser where there is no workspace. It opens at once only when
 * this page can tell the press was in that app's frame; when a press happened
 * but this page cannot tell where (a key, a press on the workspace just
 * before, a window desktop main caught), Opensteer asks; with no press at all
 * the app asked by itself, and nothing happens.
 */
export function openAppLink(
  url: string,
  places: AppLinkPlaces,
  proof: AppLinkProof,
): AppLinkOutcome {
  if (typeof document === "undefined") return "ignored";
  const at = now();
  noteFocus(at);
  const activation = (globalThis.navigator as Navigator | undefined)?.userActivation;
  if (activation && !activation.isActive) return "ignored";
  const go = () =>
    places.open && PageOpenUrlSchema.safeParse(url).success ? places.open(url) : openOutside(url);
  // A press in an app leaves focus there; an app asking while it lacks focus pressed nothing.
  const frame = requestingFrame(proof);
  if (!frame) return "ignored";
  // Without a workspace the page goes to the person's own browser, in no profile of Opensteer's,
  // as every app link did before; a press is still required, and still one a moment.
  if (!places.open) {
    if (at - lastOpenedAt < openMs) return "ignored";
    lastOpenedAt = at;
    openOutside(url);
    return "opened";
  }
  if (activation && proof.kind === "frame" && pressedIn(frame, at)) {
    lastOpenedAt = at;
    go();
    return "opened";
  }
  if (at - lastAskedAt < askMs || (askedAt.get(url) ?? Number.NEGATIVE_INFINITY) >= at - askAgainMs)
    return "ignored";
  lastAskedAt = at;
  askedAt.set(url, at);
  places.ask(url, go);
  return "asked";
}

/**
 * How a question names a page: its whole site, port included, which the
 * person must be able to check, then as much of its path as fits a line.
 */
export function appLinkLabel(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    const site = host.replace(/^www\./u, "");
    const path = pathname === "/" ? "" : pathname;
    const room = Math.max(0, 60 - site.length);
    return site + (path.length > room ? path.slice(0, Math.max(0, room - 1)) + "…" : path);
  } catch {
    return url.slice(0, 60);
  }
}
