import { browserFrameLimits } from "@opensteer/browser-core";
import { rasterShowsSize } from "../stream/frame.js";
import type { PageSize } from "./surface-ledger.js";

/*
 * What the follow view decides, as values: what should be cast now, whether what runs still
 * pictures it, whether the page can take a start, what a frame is, the one next step, and the
 * state that follows from each thing that happened (`after`, the only writer of that state).
 * Nothing here waits or reads a live object; the follow view reads the facts fresh for each pass,
 * turns what happened into an event, and stores what `after` returns.
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
  /** The viewer takes a picture of a capture's region with the region's own header. */
  readonly captureRegions: boolean;
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
  readonly captureRegions: boolean;
}

export type Want =
  | { readonly kind: "none"; readonly why: string }
  | { readonly kind: "hold"; readonly why: string }
  | { readonly kind: "cast"; readonly key: CastKey };

/** What the follow view last told Chromium on the bound tab's session, as far as it knows. */
export type Told =
  | { readonly state: "none" }
  /** A start is being prepared: nothing of it has reached Chromium. */
  | { readonly state: "preparing" }
  | { readonly state: "sent"; readonly key: CastKey }
  | { readonly state: "running"; readonly key: CastKey }
  /** A stop was sent on this session and is not answered: no frame on it is this cast's. */
  | { readonly state: "stopping" };

/** Why the page could not take a start: each fact that bears on it, as it was when sent. */
export interface Refusal {
  /** The page's finished navigations; null without a navigation port. */
  readonly finished: number | null;
  readonly pending: boolean;
  readonly loading: boolean;
  readonly document: string | null;
  readonly why: string;
}

/**
 * A start whose paint wait timed out: the next waits for its backoff to end (the follow view
 * says so with an event), unless the picture it would be changes first.
 */
export interface PaintWait {
  readonly size: PageSize;
  readonly captureRevision: number | null;
  readonly geometryRevision: number;
}

/**
 * What came of the running cast short of a picture, the worst kept: each is answered in its own
 * way, and a cast given up says which it was.
 */
export type Trouble =
  /**
   * A frame of another size came with the start and none fitting since: on a page sized natively
   * the start's own frame follows it (F30), and the follow view gives it a shorter time.
   */
  | "other-size"
  /** No picture came in the time the cast was given (R10). */
  | "no-picture"
  /** A frame of the cast was not shown because the facts did not fit it then. */
  | "set-aside"
  /** A frame of the cast had another size or shape than the region it was cast for. */
  | "misfit";

const troubleRank: Record<Trouble, number> = {
  misfit: 3,
  "no-picture": 1,
  "other-size": 0,
  "set-aside": 2,
};

function worse(left: Trouble | null, right: Trouble): Trouble {
  return left !== null && troubleRank[left] > troubleRank[right] ? left : right;
}

/** What a cast given up says it was given up for, by what came of it. */
const givenUpFor: Record<Exclude<Trouble, "other-size">, string> = {
  misfit: "its frames do not fit the region it is cast for",
  "no-picture": "no picture arrived",
  "set-aside": "its frames were set aside each time",
};

export interface TabCastState {
  readonly told: Told;
  /** A picture was delivered for the running cast since its answer, or since its document. */
  readonly shown: boolean;
  readonly trouble: Trouble | null;
  /** The page's view may no longer be at the size it is cast at (a tab closed beside it). */
  readonly redraw: boolean;
  /**
   * The page is asked to draw its surface again before the next start: a retry, which counts once
   * it is drawn, or a change (a tab closed beside it), which does not.
   */
  readonly repairing: "retry" | "change" | null;
  readonly refusal: Refusal | null;
  /** Retries of this cast, on the same facts, since a picture was last delivered. */
  readonly unpictured: number;
  readonly paint: PaintWait | null;
  /** The cast given up, and why: none is started for it again until it changes. */
  readonly failed: { readonly key: CastKey; readonly why: string } | null;
  /** The cast the last start asked for: a start for another one counts afresh. */
  readonly lastKey: CastKey | null;
}

/** A tab bound anew; its session's stop may still be with Chromium. */
export function initialTabCastState(stopping: boolean): TabCastState {
  return {
    failed: null,
    lastKey: null,
    paint: null,
    redraw: false,
    refusal: null,
    repairing: null,
    shown: false,
    told: stopping ? { state: "stopping" } : { state: "none" },
    trouble: null,
    unpictured: 0,
  };
}

/**
 * The time a running cast is given for its first picture, counted from Chromium's answer (R10):
 * three seconds, then six, then twelve as it is retried with none; one second after a frame of
 * another size came with the start, as its own follows at once if it comes at all.
 */
export const firstFrameWaitMs = 3_000;
export const otherSizeWaitMs = 1_000;

/**
 * How many restarts or repairs a cast gets with no picture delivered before it is given up: one
 * on a page sized natively, whose one repair sizes its view again, three on one sized by command.
 */
export function pictureLimit(native: boolean): number {
  return native ? 1 : 3;
}

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
  | { readonly kind: "start" }
  /** `retry`: on the same facts, with no picture; otherwise for a change in them. */
  | { readonly kind: "restart"; readonly why: string; readonly retry: boolean }
  /** Stop, ask the page to draw its surface again, then start. */
  | { readonly kind: "repair"; readonly why: string; readonly retry: boolean }
  /** No picture came of it: stop, say so, and start nothing for this cast again. */
  | { readonly kind: "fail"; readonly why: string }
  /**
   * Nothing to do until the named fact changes, or, with `timer`, until that many milliseconds
   * pass with no picture: then the follow view says so (`first-frame-timeout`).
   */
  | { readonly kind: "wait"; readonly why: string; readonly timer?: number }
  | { readonly kind: "idle" };

/** What a frame is, judged against what was told and the facts. */
export type FrameVerdict =
  /** It came with the start in flight, of what that start asked for: its picture, held. */
  | "held"
  /** It came with the start, of another size: what the page last drew before it was shown. */
  | "other-size-with-start"
  /** It came with the start, of another size, on a page the follow view sized itself. */
  | "misfit-with-start"
  /** It is the running cast's, and the facts do not fit it now. */
  | "set-aside"
  /** It is the running cast's, and of another size or shape than its region. */
  | "misfit"
  | "show"
  /** It is the running cast's, of the new document it saw commit: the cast is restamped for it. */
  | "restamp-show"
  /** It is no cast's to show: from before the document changed, or nothing is cast. */
  | "dropped";

export type CastEvent =
  /** A pass read the facts: a refusal or a given-up cast they release is released. */
  | { readonly kind: "observed" }
  | { readonly kind: "start-begun" }
  | { readonly kind: "sent"; readonly key: CastKey }
  | { readonly kind: "answered" }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  /** A start being prepared came to nothing: given up, or the facts no longer wanted it. */
  | { readonly kind: "not-sent" }
  | { readonly kind: "paint-timed-out"; readonly paint: PaintWait | null }
  | { readonly kind: "paint-backoff-ended" }
  /** A stop step: a restart (`retry` when on the same facts), a pause, a leaving, or a give-up. */
  | {
      readonly kind: "stopped";
      readonly retry: boolean;
      readonly failed?: { readonly key: CastKey; readonly why: string };
    }
  | { readonly kind: "repair-begun"; readonly retry: boolean }
  | { readonly kind: "repair-drawn" }
  /** A stop on the session was answered; `remaining` are still with Chromium. */
  | { readonly kind: "stop-answered"; readonly remaining: number }
  /** The engine ended the session's casts itself (a renderer gone, a debugger detached). */
  | { readonly kind: "casts-ended" }
  | { readonly kind: "frame"; readonly verdict: FrameVerdict }
  /** The time the plan gave the running cast for a picture (`wait` with a timer) is up. */
  | { readonly kind: "first-frame-timeout" }
  | { readonly kind: "resumed" }
  | { readonly kind: "tab-closed-beside"; readonly native: boolean }
  | {
      readonly kind: "restamped";
      readonly geometryRevision: number;
      readonly document: string | null;
    };

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
      captureRegions: facts.captureRegions,
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
 * Whether the cast `told` still pictures what is wanted: the same size, capture, raster and way
 * of showing a region, and the same geometry. A geometry bumped only because another document
 * committed at the same size and capture is a new document the cast pictures as it is. Any other
 * bump (device metrics at the same size, a scale) is not: Chromium can apply those without
 * another frame of a still page.
 */
export function fits(told: CastKey, want: CastKey): "same" | "new-document" | false {
  if (
    !sameSize(told.size, want.size) ||
    !sameSize(told.region, want.region) ||
    told.captureRevision !== want.captureRevision ||
    !sameSize(told.raster, want.raster) ||
    told.sizesView !== want.sizesView ||
    told.captureRegions !== want.captureRegions
  )
    return false;
  if (told.geometryRevision === want.geometryRevision) return "same";
  return told.document !== want.document ? "new-document" : false;
}

/**
 * Whether two casts picture the same page the same way: its size, capture, raster and document.
 * A cast given up is tried again when any of these changes (a person who navigates gets another
 * try); a new metrics revision alone does not.
 */
export function sameCast(left: CastKey, right: CastKey): boolean {
  return (
    sameSize(left.size, right.size) &&
    sameSize(left.region, right.region) &&
    left.captureRevision === right.captureRevision &&
    sameSize(left.raster, right.raster) &&
    left.document === right.document
  );
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
  if (told.captureRegions !== want.captureRegions) return "capture regions";
  return `geometry ${told.geometryRevision} to ${want.geometryRevision}`;
}

/**
 * Whether a fact that bears on a refusal settled since it was recorded: a navigation finished, a
 * pending one ended, loading stopped, or another document committed. A refusal with nothing
 * pending, nothing loading and no navigation stays one until the document changes.
 */
export function refusalReleased(tab: TabFacts, refusal: Refusal): boolean {
  return (
    (tab.navigation !== null && tab.navigation.finished > (refusal.finished ?? -1)) ||
    (refusal.pending && tab.navigation?.pending !== true) ||
    (refusal.loading && !tab.loading) ||
    tab.document !== refusal.document
  );
}

/**
 * Whether the page can take a start now: not while its first document is still to commit (a tab
 * opened with an address takes no command until then), and not after a refusal until a fact that
 * bears on it settled.
 */
export function canTakeStart(
  tab: TabFacts,
  refusal: Refusal | null,
): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  if (tab.navigation?.pending && tab.navigation.blankDocument)
    return { ok: false, why: "its first document has not committed" };
  if (!refusal || refusalReleased(tab, refusal)) return { ok: true };
  const until = [
    tab.navigation ? "a navigation finishes" : null,
    refusal.pending ? "its navigation ends" : null,
    refusal.loading ? "its loading stops" : null,
    "another document commits",
  ].filter((fact) => fact !== null);
  return { ok: false, why: `refused (${refusal.why}) until ${until.join(" or ")}` };
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
    return told.state === "none" || told.state === "stopping"
      ? { kind: "idle" }
      : { kind: "stop", why: want.why };
  if (told.state === "preparing") return { kind: "wait", why: "a start is being prepared" };
  // No start goes out on a session whose stop is with Chromium: a frame of a new cast can then
  // never be taken for the old one's, or the old one's for it.
  if (told.state === "stopping") return { kind: "wait", why: "a stop is with Chromium" };
  if (state.repairing) return { kind: "wait", why: "the page is drawn again" };
  if (want.kind === "hold") return { kind: "wait", why: want.why };
  const key = want.key;
  if (told.state === "sent") return { kind: "wait", why: "a start is with Chromium" };
  const limit = pictureLimit(tab.native);
  if (told.state === "running") {
    const fit = fits(told.key, key);
    if (fit === "new-document")
      return { document: key.document, geometryRevision: key.geometryRevision, kind: "restamp" };
    if (!fit) return { kind: "restart", retry: false, why: difference(told.key, key) };
    if (state.redraw) return { kind: "repair", retry: false, why: "a tab closed" };
    if (state.shown) return { kind: "idle" };
    const trouble = state.trouble;
    if (trouble !== null && trouble !== "other-size") {
      if (state.unpictured >= limit) return { kind: "fail", why: givenUpFor[trouble] };
      return trouble === "set-aside"
        ? { kind: "restart", retry: true, why: "its frame was set aside" }
        : { kind: "repair", retry: true, why: givenUpFor[trouble] };
    }
    if (trouble === "other-size")
      return {
        kind: "wait",
        timer: otherSizeWaitMs,
        why: "its own frame, after one of another size",
      };
    // A document still loading, or still with the browser side, sends its first frame as it paints.
    if (tab.loading || tab.navigation?.pending)
      return { kind: "wait", why: "its document's first frame, as it loads" };
    return {
      kind: "wait",
      timer: firstFrameWaitMs * 2 ** Math.min(state.unpictured, 2),
      why: "its first frame",
    };
  }
  if (state.failed !== null && sameCast(state.failed.key, key))
    return { kind: "wait", why: `its cast was given up: ${state.failed.why}` };
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
  return { kind: "start" };
}

/**
 * A frame as the follow view measured it: the size it says, its raster's when it decodes, and the
 * document the follow view had seen when it arrived, which is the document it can picture.
 */
export interface FrameMeasure {
  readonly geometry: PageSize | null;
  readonly raster: PageSize | null;
  readonly document: string | null;
}

/** What a frame is, from what was told, the facts, and its measure. */
export function frameVerdict(
  state: TabCastState,
  frame: FrameMeasure,
  facts: CastFacts,
): FrameVerdict {
  const told = state.told;
  if (told.state === "sent") {
    if (facts.streaming && fitsRegion(frame.geometry, told.key.region)) return "held";
    return told.key.sizesView ? "misfit-with-start" : "other-size-with-start";
  }
  if (told.state !== "running") return "dropped";
  const want = wanted(facts);
  if (want.kind !== "cast") return "set-aside";
  const fit = fits(told.key, want.key);
  if (!fit) return "set-aside";
  // A new document at the same size: a frame that arrived before the follow view saw it commit is
  // the old one's (dropped, finding 4); one that arrived after is the new one's.
  const restamp = fit === "new-document";
  if (restamp && frame.document !== want.key.document) return "dropped";
  // Chromium can deliver a picture of another size than the page's: one made before the latest
  // resize, or the window's, when Chrome put the view back at that size as another tab closed.
  // The frame's device size is the whole viewport, a scrollbar included; one pixel more is the
  // desktop app redrawing a page that sat undrawn.
  if (!fitsRegion(frame.geometry, told.key.region)) return "misfit";
  if (!frame.raster) return "dropped";
  // Chromium can also label such a picture with the page's size; its shape gives it away.
  const expected = told.key.expectedRaster;
  if (
    !rasterShowsSize(frame.raster, told.key.region) ||
    (expected &&
      (Math.abs(frame.raster.width - expected.width) > 1 ||
        Math.abs(frame.raster.height - expected.height) > 1))
  )
    return "misfit";
  return restamp ? "restamp-show" : "show";
}

/** The state after `event`, the only way it changes. */
export function after(state: TabCastState, event: CastEvent, facts: CastFacts): TabCastState {
  const told = state.told;
  switch (event.kind) {
    case "observed": {
      let next = state;
      if (next.refusal && facts.tab && refusalReleased(facts.tab, next.refusal))
        next = { ...next, refusal: null };
      const want = wanted(facts);
      // A cast given up is tried again, with fresh counts, once what it would picture changed.
      if (next.failed && want.kind === "cast" && !sameCast(next.failed.key, want.key))
        next = { ...next, failed: null, unpictured: 0 };
      return next;
    }
    case "start-begun":
      return { ...state, told: { state: "preparing" } };
    case "sent": {
      // A start for another cast is a change, not a retry: its count begins afresh (R6).
      const another = !state.lastKey || fits(state.lastKey, event.key) !== "same";
      return {
        ...state,
        lastKey: event.key,
        shown: false,
        told: { key: event.key, state: "sent" },
        trouble: null,
        unpictured: another ? 0 : state.unpictured,
      };
    }
    case "answered":
      return told.state === "sent"
        ? { ...state, paint: null, refusal: null, told: { key: told.key, state: "running" } }
        : state;
    case "refused":
      return { ...state, refusal: event.refusal, told: { state: "none" } };
    case "not-sent":
      return told.state === "preparing" ? { ...state, told: { state: "none" } } : state;
    case "paint-timed-out":
      return {
        ...state,
        paint: event.paint,
        told: told.state === "preparing" ? { state: "none" } : told,
      };
    case "paint-backoff-ended":
      return { ...state, paint: null };
    case "stopped":
      return {
        ...state,
        ...(event.failed ? { failed: event.failed } : {}),
        shown: false,
        told: stoppedFrom(told),
        trouble: null,
        // R2: a retry on the same facts with no picture counts against the cast. A restart for a
        // new fact (another key) is a change, not a retry, and does not; its start counts afresh.
        unpictured: event.retry && !state.shown ? state.unpictured + 1 : state.unpictured,
      };
    case "repair-begun":
      return {
        ...state,
        redraw: false,
        repairing: event.retry ? "retry" : "change",
        shown: false,
        told: stoppedFrom(told),
        trouble: null,
      };
    case "repair-drawn":
      // R2 and R10: a repair counts only once the page is drawn again, and only as a retry; one
      // a tab closed beside it asked for (`redraw`, armed once per such event) is a change.
      return {
        ...state,
        repairing: null,
        unpictured: state.repairing === "retry" ? state.unpictured + 1 : state.unpictured,
      };
    case "stop-answered":
      return told.state === "stopping" && event.remaining === 0
        ? { ...state, told: { state: "none" } }
        : state;
    case "casts-ended":
      return told.state === "sent" || told.state === "running" || told.state === "stopping"
        ? { ...state, shown: false, told: { state: "none" }, trouble: null }
        : state;
    case "frame":
      switch (event.verdict) {
        case "other-size-with-start":
          return { ...state, trouble: worse(state.trouble, "other-size") };
        case "misfit-with-start":
          return { ...state, trouble: worse(state.trouble, "misfit") };
        case "set-aside":
          return { ...state, trouble: worse(state.trouble, "set-aside") };
        case "misfit":
          return { ...state, shown: false, trouble: worse(state.trouble, "misfit") };
        case "show":
        case "restamp-show": {
          const want = wanted(facts);
          return {
            ...state,
            shown: true,
            told:
              event.verdict === "restamp-show" && told.state === "running" && want.kind === "cast"
                ? {
                    key: {
                      ...told.key,
                      document: want.key.document,
                      geometryRevision: want.key.geometryRevision,
                    },
                    state: "running",
                  }
                : told,
            trouble: null,
            unpictured: 0,
          };
        }
        case "held":
        case "dropped":
          return state;
      }
      return state;
    case "first-frame-timeout": {
      // The time is up only if the plan still gives one now: not for a tab not wanted, under a
      // hold, loading, or since pictured.
      const step = nextStep(facts, facts.tab?.binding ?? null, state);
      return step.kind === "wait" && step.timer !== undefined
        ? { ...state, trouble: "no-picture" }
        : state;
    }
    case "resumed":
      return { ...state, failed: null, refusal: null, unpictured: 0 };
    case "tab-closed-beside":
      return told.state === "running" && !event.native
        ? { ...state, redraw: true, shown: false }
        : state;
    case "restamped":
      return told.state === "running"
        ? {
            ...state,
            shown: false,
            told: {
              key: {
                ...told.key,
                document: event.document,
                geometryRevision: event.geometryRevision,
              },
              state: "running",
            },
          }
        : state;
  }
}

/** What a stop leaves: a start sent or a cast running is stopping; one prepared, nothing. */
function stoppedFrom(told: Told): Told {
  if (told.state === "sent" || told.state === "running") return { state: "stopping" };
  if (told.state === "preparing") return { state: "none" };
  return told;
}

/** Whether a frame of `geometry` pictures `region`, within the pixel a scrollbar can add. */
export function fitsRegion(geometry: PageSize | null, region: PageSize): boolean {
  return (
    !!geometry &&
    Math.abs(geometry.width - region.width) <= 1 &&
    Math.abs(geometry.height - region.height) <= 1
  );
}

export function sameSize(left: PageSize, right: PageSize | null): boolean {
  return left.width === right?.width && left.height === right.height;
}
