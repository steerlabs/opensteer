import { browserFrameLimits } from "@opensteer/browser-core";
import type { PageSize } from "./surface-ledger.js";

/*
 * What the follow view decides, as values: what should be cast now, whether what runs still
 * pictures it, whether the page can take a start, and the one next step. Nothing here waits or
 * reads a live object; the follow view reads the facts fresh for each pass and does the step.
 */

export interface CaptureFact {
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly rasterScale: number;
}

/** What the page's browser side says of its navigations (`PageNavigationPort`). */
export interface NavigationFact {
  /** Navigations it finished since the page opened. */
  readonly finished: number;
  /** A main-frame navigation to another document has started and not ended. */
  readonly pending: boolean;
  /** The document it last finished is the blank one a page opens with, or there is none yet. */
  readonly blankDocument: boolean;
}

export interface TabFacts {
  /** The tab and the page session it is bound through: a page that woke has a new one. */
  readonly binding: string;
  readonly dialogOpen: boolean;
  readonly size: PageSize | null;
  /** The page has a native capture (`PageCapturePort`). */
  readonly native: boolean;
  /** Its capture now: null while it is let go, and for a page without one. */
  readonly capture: CaptureFact | null;
  /** The follow view sizes the view itself before a start (no capture, no applyGeometry). */
  readonly sizesView: boolean;
  readonly geometryRevision: number;
  readonly document: string | null;
  readonly loading: boolean;
  /** Null for a page without a navigation port. */
  readonly navigation: NavigationFact | null;
}

export interface CastFacts {
  readonly closed: boolean;
  readonly streaming: boolean;
  readonly density: number;
  readonly tab: TabFacts | null;
}

/** What a start asks Chromium for, and what its frames must picture. */
export interface CastKey {
  readonly size: PageSize;
  /** The capture's region where the page has one, else its size. */
  readonly region: PageSize;
  readonly captureRevision: number | null;
  readonly raster: PageSize;
  /** The raster a native capture's frames must have; null where only their shape is checked. */
  readonly expectedRaster: PageSize | null;
  readonly geometryRevision: number;
  readonly document: string | null;
  readonly sizesView: boolean;
}

export type Want =
  | { readonly kind: "none"; readonly why: string }
  | { readonly kind: "hold"; readonly why: string }
  | { readonly kind: "cast"; readonly key: CastKey };

/** What the follow view last told Chromium for the bound tab, as far as it knows. */
export type Told =
  | { readonly state: "none" }
  /** A start is being prepared, or a repair is under way: nothing for it has reached Chromium. */
  | { readonly state: "preparing" }
  | { readonly state: "sent"; readonly key: CastKey }
  | { readonly state: "running"; readonly key: CastKey };

/** Why the page could not take a start, as it was when it refused. */
export interface Refusal {
  /** The page's finished navigations when the start was sent; null without a navigation port. */
  readonly finished: number | null;
  readonly loading: boolean;
  readonly document: string | null;
  readonly why: string;
}

/**
 * A start whose paint wait timed out: the next waits for its backoff to end (the follow view
 * clears this then), unless the picture it would be changes first.
 */
export interface PaintWait {
  readonly size: PageSize;
  readonly captureRevision: number | null;
  readonly geometryRevision: number;
}

export interface TabCastState {
  readonly told: Told;
  /** A picture was shown for the running cast since its answer, or since its document changed. */
  readonly shown: boolean;
  /** Frames of the running cast not shown because the facts did not fit them then. */
  readonly setAside: number;
  /** A frame of the running cast had another size or shape than the region it was cast for. */
  readonly misfit: boolean;
  /** The page's view may no longer be at the size it is cast at (a tab closed beside it). */
  readonly redraw: boolean;
  /**
   * The running cast's only frame so far was of another size, before its answer was handled: on a
   * page sized natively the start's own frame follows (F30), and the follow view gives it a time.
   */
  readonly otherSizeFirst: boolean;
  readonly refusal: Refusal | null;
  /** Restarts and repairs since a picture was last shown. */
  readonly unpictured: number;
  /** A native page's one repair was used. */
  readonly repaired: boolean;
  readonly paint: PaintWait | null;
  /** The cast whose frames never fitted: none is started for it again until the facts change. */
  readonly failedFor: CastKey | null;
  /** Why the next start is sent: what last stopped the cast, or what bound the tab. */
  readonly startWhy: string;
}

export const initialTabCastState: TabCastState = {
  failedFor: null,
  misfit: false,
  otherSizeFirst: false,
  paint: null,
  redraw: false,
  refusal: null,
  repaired: false,
  setAside: 0,
  shown: false,
  startWhy: "bind",
  told: { state: "none" },
  unpictured: 0,
};

/** How many restarts or repairs a cast gets with no picture shown before it is given up. */
export const unpicturedLimit = 3;

export type Step =
  /** The tab in view is not the one bound: unbind it (its cast stops) and bind this one. */
  | { readonly kind: "bind" }
  | { readonly kind: "stop"; readonly why: string }
  /** A new document at the same size and capture: the running cast pictures it. */
  | {
      readonly kind: "restamp";
      readonly geometryRevision: number;
      readonly document: string | null;
    }
  | { readonly kind: "start"; readonly why: string }
  | { readonly kind: "restart"; readonly why: string }
  /** Stop, ask the page to draw its surface again, then start. */
  | { readonly kind: "repair" }
  /** Its frames never fit: stop, say so, and start nothing for this cast again. */
  | { readonly kind: "fail"; readonly why: string }
  /** Nothing to do until the named fact changes. */
  | { readonly kind: "wait"; readonly why: string }
  | { readonly kind: "idle" };

/** At most two raster pixels per page DIP, reduced to the stream's resource bound. */
export function screencastRaster(size: PageSize, density = 2): PageSize {
  const width = size.width * Math.min(2, density);
  const height = size.height * Math.min(2, density);
  const shrink = Math.min(
    1,
    browserFrameLimits.maxWidth / width,
    browserFrameLimits.maxHeight / height,
    Math.sqrt(browserFrameLimits.maxPhysicalPixels / (width * height)),
  );
  return {
    height: Math.max(1, Math.floor(height * shrink)),
    width: Math.max(1, Math.floor(width * shrink)),
  };
}

export function wanted(facts: CastFacts): Want {
  if (facts.closed) return { kind: "none", why: "closed" };
  if (!facts.streaming) return { kind: "none", why: "paused" };
  const tab = facts.tab;
  if (!tab) return { kind: "none", why: "no tab" };
  // A page under a dialog draws nothing and answers nothing else: its last picture stays.
  if (tab.dialogOpen) return { kind: "hold", why: "a dialog is open" };
  if (!tab.size) return { kind: "hold", why: "the page has no size yet" };
  if (tab.native && !tab.capture) return { kind: "hold", why: "its capture is let go" };
  const capture = tab.capture;
  if (capture && (capture.width > tab.size.width || capture.height > tab.size.height))
    return { kind: "hold", why: "its capture is larger than the page" };
  const region = capture ? { height: capture.height, width: capture.width } : tab.size;
  const raster = screencastRaster(region, Math.min(facts.density, capture?.rasterScale ?? 2));
  // CDP aspect-fits within these integer limits. Rounding the limiting edge can shorten the
  // other edge by several pixels on tall pages.
  const scale = Math.min(raster.width / region.width, raster.height / region.height);
  return {
    kind: "cast",
    key: {
      captureRevision: capture?.revision ?? null,
      document: tab.document,
      expectedRaster: capture
        ? {
            height: Math.max(1, Math.floor(region.height * scale)),
            width: Math.max(1, Math.floor(region.width * scale)),
          }
        : null,
      geometryRevision: tab.geometryRevision,
      raster,
      region,
      size: tab.size,
      sizesView: tab.sizesView,
    },
  };
}

/**
 * Whether the cast `told` still pictures what is wanted: the same size, capture and raster, and
 * the same geometry. A geometry bumped only because another document committed at the same size
 * and capture is a new document the cast pictures as it is. Any other bump (device metrics at the
 * same size, a scale) is not: Chromium can apply those without another frame of a still page.
 */
export function fits(told: CastKey, want: CastKey): "same" | "new-document" | false {
  if (
    !sameSize(told.size, want.size) ||
    !sameSize(told.region, want.region) ||
    told.captureRevision !== want.captureRevision ||
    !sameSize(told.raster, want.raster) ||
    told.sizesView !== want.sizesView
  )
    return false;
  if (told.geometryRevision === want.geometryRevision) return "same";
  return told.document !== want.document ? "new-document" : false;
}

/** The first thing that differs between two casts: why one restarts for the other. */
export function difference(told: CastKey, want: CastKey): string {
  if (!sameSize(told.size, want.size))
    return `size ${told.size.width}x${told.size.height} to ${want.size.width}x${want.size.height}`;
  if (told.captureRevision !== want.captureRevision)
    return `capture ${String(told.captureRevision)} to ${String(want.captureRevision)}`;
  if (!sameSize(told.region, want.region)) return "capture region";
  if (!sameSize(told.raster, want.raster))
    return `raster ${told.raster.width}x${told.raster.height} to ${want.raster.width}x${want.raster.height}`;
  return `geometry ${told.geometryRevision} to ${want.geometryRevision}`;
}

/**
 * Whether the page can take a start now: not while its first document is still to commit (a tab
 * opened with an address takes no command until then), and not after a refusal until a fact that
 * bears on it changed. With a navigation port that is a navigation finished after the refused
 * start was sent; without one, another document. Or its loading stopped.
 */
export function canTakeStart(
  tab: TabFacts,
  refusal: Refusal | null,
): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  if (tab.navigation?.pending && tab.navigation.blankDocument)
    return { ok: false, why: "its first document has not committed" };
  if (!refusal || refusalReleased(tab, refusal)) return { ok: true };
  return {
    ok: false,
    why: `refused (${refusal.why}) until ${tab.navigation ? "a navigation finishes" : "another document commits"}${refusal.loading ? " or its loading stops" : ""}`,
  };
}

/**
 * Whether a fact that bears on a refusal changed since: a navigation finished after the refused
 * start was sent (with a navigation port), another document (without one), or its loading stopped.
 * The follow view records a release when it sees one: a fact that changes back does not undo it.
 */
export function refusalReleased(tab: TabFacts, refusal: Refusal): boolean {
  const loadStopped = refusal.loading && !tab.loading;
  return tab.navigation
    ? tab.navigation.finished > (refusal.finished ?? -1) || loadStopped
    : tab.document !== refusal.document || loadStopped;
}

/** The one next step for the bound tab, from the facts and what was told. */
export function nextStep(facts: CastFacts, bound: string | null, state: TabCastState | null): Step {
  const inView = facts.closed ? null : (facts.tab?.binding ?? null);
  if (bound !== inView) return { kind: "bind" };
  const tab = facts.tab;
  if (!tab || !state) return { kind: "idle" };
  const want = wanted(facts);
  const told = state.told;
  // A start being prepared is given up as well: nothing of it has reached Chromium.
  if (want.kind === "none")
    return told.state === "none" ? { kind: "idle" } : { kind: "stop", why: want.why };
  if (told.state === "preparing") return { kind: "wait", why: "a start is being prepared" };
  if (want.kind === "hold") return { kind: "wait", why: want.why };
  const key = want.key;
  if (told.state === "sent") return { kind: "wait", why: "a start is with Chromium" };
  const failed = state.failedFor !== null && fits(state.failedFor, key) === "same";
  if (told.state === "running") {
    const fit = fits(told.key, key);
    if (fit === "new-document")
      return { document: key.document, geometryRevision: key.geometryRevision, kind: "restamp" };
    if (!fit) return { kind: "restart", why: difference(told.key, key) };
    if (state.redraw) return { kind: "repair" };
    if (state.shown) return { kind: "idle" };
    if (state.misfit) {
      if ((tab.native && state.repaired) || state.unpictured >= unpicturedLimit)
        return { kind: "fail", why: "its frames do not fit the region it is cast for" };
      return { kind: "repair" };
    }
    if (state.setAside > 0) {
      if (state.unpictured >= unpicturedLimit)
        return { kind: "fail", why: "its frames were set aside each time" };
      return { kind: "restart", why: "its frame was set aside" };
    }
    if (state.otherSizeFirst)
      return { kind: "wait", why: "its own frame, after one of another size" };
    // A document still loading, or still with the browser side, sends its first frame as it paints.
    if (tab.loading || tab.navigation?.pending)
      return { kind: "wait", why: "its document's first frame, as it loads" };
    return { kind: "wait", why: "its first frame" };
  }
  if (failed) return { kind: "wait", why: "its frames never fit this page" };
  const paint = state.paint;
  if (
    paint &&
    sameSize(paint.size, key.size) &&
    paint.captureRevision === key.captureRevision &&
    paint.geometryRevision === key.geometryRevision
  )
    return { kind: "wait", why: "the page did not paint" };
  const can = canTakeStart(tab, state.refusal);
  if (!can.ok) return { kind: "wait", why: can.why };
  return { kind: "start", why: state.startWhy };
}

export function sameSize(left: PageSize, right: PageSize | null): boolean {
  return left.width === right?.width && left.height === right.height;
}
