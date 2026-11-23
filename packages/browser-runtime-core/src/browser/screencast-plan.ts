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

/**
 * What the follow view last told Chromium on the bound tab's session, as far as it knows. A stop
 * it sent is the session's (`SessionCastState`), not the tab's: after one, the tab is told none.
 */
export type Told =
  | { readonly state: "none" }
  /** A start is being prepared: nothing of it has reached Chromium. */
  | { readonly state: "preparing" }
  /** A start was sent; `at`, the facts that bear on whether the page could take it, then. */
  | { readonly state: "sent"; readonly key: CastKey; readonly at: StartFacts }
  | { readonly state: "running"; readonly key: CastKey };

/** The facts that bear on whether the page can take a start, as they were when one was sent. */
export interface StartFacts {
  /** The page's finished navigations; null without a navigation port. */
  readonly finished: number | null;
  readonly pending: boolean;
  readonly loading: boolean;
  readonly document: string | null;
}

export function startFacts(tab: TabFacts): StartFacts {
  return {
    document: tab.document,
    finished: tab.navigation?.finished ?? null,
    loading: tab.loading,
    pending: tab.navigation?.pending ?? false,
  };
}

/** Why the page could not take a start: Chromium's answer to it, and the facts when it was sent. */
export interface Refusal extends StartFacts {
  readonly why: string;
}

/**
 * What the follow view told one page session that outlives the tab bound to it: the stops it
 * sent there that Chromium has not answered. While one is, no frame on the session is a cast's
 * and no start goes out on it. Written only by `afterSession`.
 */
export interface SessionCastState {
  /**
   * Bumped when the engine ended the session's casts or a stop's answer was given up on: a stop
   * sent in an earlier generation is settled, and its late answer never changes current `stops`.
   */
  readonly generation: number;
  /** Stops sent in this generation and not answered. */
  readonly stops: number;
  /** Stops whose answer was given up on while this session was not yet charged to a tab (U4). */
  readonly timedOut: number;
  /**
   * Stops of earlier generations whose answer was given up on (S3) and has still not arrived
   * from Chromium (W1). While positive, a frame arriving on the session may still be an earlier
   * cast's: it may be shown, but it does not prove the running cast works.
   */
  readonly staleStops: number;
  /** Generations strictly below this ended via `casts-ended`; their late answers change nothing. */
  readonly endedBefore: number;
}

export const initialSessionCastState: SessionCastState = {
  endedBefore: 0,
  generation: 0,
  staleStops: 0,
  stops: 0,
  timedOut: 0,
};

/**
 * How long a stop's or start's answer is waited for on a live session (S3, X2) before the follow
 * view moves on. While an earlier stop or start is still unanswered (`staleStops > 0`), a frame
 * arriving on the session may still be an earlier cast's: it may be shown, but it never proves the
 * running cast works, sets no `shown`, resets no retry count, and leaves the first-frame wait
 * running (W1), until a subsequent start is answered on that session (X1).
 */
export const stopAnswerWaitMs = 5_000;

/**
 * Upper bound on preparing a start (`settleRendering`, `Emulation.setVisibleSize`, or the page's
 * geometry lock) so a wedged preparation cannot leave the tab waiting forever (X2). Strictly above
 * desktop's paint (5 s) + placement (5 s) waits so normal paint timeouts still take their backoff.
 */
export const prepareWaitMs = 15_000;

/**
 * Upper bound on asking the page to redraw its surface (`invalidateSurface`) so a wedged repair
 * cannot leave the tab waiting forever (X2). Strictly above desktop's placement wait (5 s).
 */
export const repairWaitMs = 10_000;

/**
 * Upper bound on waiting for a native capture surface to come back after it was let go (X2).
 * Strictly above desktop's placement wait (5 s) so a normal resize/reparent finishes first, while
 * a timed-out `#applyPlacement` still retries once and gives up rather than staying blank forever.
 */
export const captureWaitMs = 10_000;

export type SessionEvent =
  | { readonly kind: "stop-sent" }
  /** A stop's answer, of the generation it was sent in. */
  | { readonly kind: "stop-answered"; readonly generation: number }
  /** The engine ended the session's casts: nothing of them is outstanding. */
  | { readonly kind: "casts-ended" }
  /** The time a stop's answer was given, in that generation, is up. */
  | { readonly kind: "stop-timed-out"; readonly generation: number }
  /** A start's answer was not received in its time: a late frame from it may still arrive (X2). */
  | { readonly kind: "start-timed-out" }
  /**
   * Chromium answered a start on this session: because a session takes commands in order, every
   * earlier timed-out stop or start has taken effect, settling all earlier `staleStops` (X1).
   */
  | { readonly kind: "start-answered" }
  /** A bound tab took the session's timed-out stop count into its own retries (U4). */
  | { readonly kind: "timed-out-taken" };

/** The session's state after `event`, the only way it changes. */
export function afterSession(state: SessionCastState, event: SessionEvent): SessionCastState {
  switch (event.kind) {
    case "stop-sent":
      return { ...state, stops: state.stops + 1 };
    case "stop-answered":
      if (event.generation === state.generation && state.stops > 0)
        return { ...state, stops: state.stops - 1 };
      if (
        event.generation >= state.endedBefore &&
        event.generation < state.generation &&
        state.staleStops > 0
      )
        return { ...state, staleStops: state.staleStops - 1 };
      return state;
    case "casts-ended":
      return {
        endedBefore: state.generation + 1,
        generation: state.generation + 1,
        staleStops: 0,
        stops: 0,
        timedOut: 0,
      };
    case "stop-timed-out":
      return event.generation === state.generation && state.stops > 0
        ? {
            endedBefore: state.endedBefore,
            generation: state.generation + 1,
            staleStops: state.staleStops + state.stops,
            stops: 0,
            timedOut: state.timedOut + 1,
          }
        : state;
    case "start-timed-out":
      return {
        ...state,
        staleStops: state.staleStops + 1,
      };
    case "start-answered":
      return state.staleStops > 0 || state.endedBefore < state.generation
        ? { ...state, endedBefore: state.generation, staleStops: 0 }
        : state;
    case "timed-out-taken":
      return state.timedOut > 0 ? { ...state, timedOut: 0 } : state;
  }
}

/** A start sent or a cast running is stopped by a stop sent to Chromium; one prepared is not. */
export function stopReachesChromium(told: Told): boolean {
  return told.state === "sent" || told.state === "running";
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
   * it is drawn, a change (a tab closed beside it), which does not, or a capture-lost retry.
   */
  readonly repairing: "retry" | "change" | "capture" | null;
  /** Whether a capture-lost hold already ran its one surface repair without capture returning. */
  readonly captureRetried: boolean;
  readonly refusal: Refusal | null;
  /** Retries of this cast, on the same facts, since a picture was last delivered. */
  readonly unpictured: number;
  readonly paint: PaintWait | null;
  /** The cast given up, and why: none is started for it again until it changes or loading ends. */
  readonly failed: {
    /** Null when given up because the page's capture was let go and did not come back. */
    readonly key: CastKey | null;
    readonly why: string;
    /** Raw underlying error (e.g. CDP refusal text), kept for diagnostics rather than user copy. */
    readonly detail?: string;
    readonly whileLoading?: boolean;
  } | null;
  /** The cast the last start asked for: a start for another one counts afresh. */
  readonly lastKey: CastKey | null;
}

/** A tab bound anew; its session's stops are the session's own. */
export function initialTabCastState(): TabCastState {
  return {
    captureRetried: false,
    failed: null,
    lastKey: null,
    paint: null,
    redraw: false,
    refusal: null,
    repairing: null,
    shown: false,
    told: { state: "none" },
    trouble: null,
    unpictured: 0,
  };
}

/**
 * The time a running cast is given for its first picture, counted from Chromium's answer (R10):
 * three seconds, then six, then twelve as it is retried with none; ten seconds (then twenty, then
 * forty) while its document still loads or has a pending navigation (U6); one second after a frame
 * of another size came with the start, as its own follows at once if it comes at all.
 */
export const firstFrameWaitMs = 3_000;
export const loadingFirstFrameWaitMs = 10_000;
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
  /**
   * It arrived while an earlier-generation timed-out stop was still unanswered on the session
   * (W1): show it (same tab and size), but do not treat it as proof the running cast works.
   */
  | "show-unproven"
  /** It is the running cast's, of the new document it saw commit: the cast is restamped for it. */
  | "restamp-show"
  /** It is no cast's to show: from before the document changed, or nothing is cast. */
  | "dropped";

export type CastEvent =
  /** A pass read the facts: a refusal or a given-up cast they release is released. */
  | { readonly kind: "observed" }
  | { readonly kind: "start-begun" }
  /** The start was handed to Chromium; `at`, the facts that bear on it as it went. */
  | { readonly kind: "sent"; readonly key: CastKey; readonly at: StartFacts }
  | { readonly kind: "answered" }
  /**
   * The start failed: Chromium's refusal if it was sent (or a CDP preparation command failed during
   * a navigation, with `at`); otherwise an attempt with no picture (S2, U5).
   */
  | { readonly kind: "start-failed"; readonly why: string; readonly at?: StartFacts }
  /** A start being prepared came to nothing: given up, or the facts no longer wanted it. */
  | { readonly kind: "not-sent" }
  | { readonly kind: "paint-timed-out" }
  | { readonly kind: "paint-backoff-ended" }
  /** A stop step: a restart (`retry` when on the same facts), a pause, a leaving, or a give-up. */
  | { readonly kind: "stopped"; readonly retry: boolean; readonly givenUp?: string }
  | { readonly kind: "repair-begun"; readonly retry: boolean }
  | { readonly kind: "repair-drawn" }
  /** The engine ended the session's casts itself (a renderer gone, a debugger detached). */
  | { readonly kind: "casts-ended" }
  /** The session's stop was not answered in its time: the next start is an attempt (S3, U4). */
  | { readonly kind: "stop-timed-out"; readonly count?: number }
  | { readonly kind: "frame"; readonly verdict: FrameVerdict }
  /** The time the plan gave the running cast for a picture (`wait` with a timer) is up (U5). */
  | {
      readonly kind: "first-frame-timeout";
      readonly binding?: string;
      readonly session?: SessionCastState;
    }
  | { readonly kind: "resumed" }
  | { readonly kind: "tab-closed-beside" }
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
 * Whether a fact that bears on a refusal differs from when its start was sent (S5): the finished
 * navigations, a pending one, loading (either way: a refusal sent before loading began is
 * released as it begins), or the document. A refusal is released as soon as one is seen to.
 */
export function refusalReleased(tab: TabFacts, refusal: Refusal): boolean {
  const now = startFacts(tab);
  return (
    now.finished !== refusal.finished ||
    now.pending !== refusal.pending ||
    now.loading !== refusal.loading ||
    now.document !== refusal.document
  );
}

/**
 * Whether a refusal came of a navigation (the page took no command while one was under way),
 * rather than of the page itself: only one outside any is the caller's to hear.
 */
export function refusedInNavigation(tab: TabFacts, refusal: Refusal): boolean {
  return (
    refusal.loading ||
    refusal.pending ||
    tab.loading ||
    tab.navigation?.pending === true ||
    refusalReleased(tab, refusal)
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
  const until = [tab.navigation ? "its navigations" : null, "its loading", "its document"].filter(
    (fact) => fact !== null,
  );
  return { ok: false, why: `refused (${refusal.why}) until ${until.join(", ")} change` };
}

/** The one next step for the bound tab, from the facts, what was told, and its session's stops. */
export function nextStep(
  facts: CastFacts,
  bound: string | null,
  state: TabCastState | null,
  session: SessionCastState = initialSessionCastState,
): Step {
  const inView = facts.closed ? null : (facts.tab?.binding ?? null);
  if (bound !== inView) return { kind: "bind" };
  const tab = facts.tab;
  if (!tab || !state) return { kind: "idle" };
  const want = wanted(facts);
  const told = state.told;
  // A start being prepared is given up as well: nothing of it has reached Chromium.
  if (want.kind === "none")
    return told.state === "none" ? { kind: "idle" } : { kind: "stop", why: want.why };
  if (told.state === "preparing")
    return { kind: "wait", timer: prepareWaitMs, why: "a start is being prepared" };
  // No start goes out on a session whose stop is with Chromium: a frame of a new cast can then
  // never be taken for the old one's, or the old one's for it. The session's own timer bounds it.
  if (session.stops > 0) return { kind: "wait", why: "a stop is with Chromium" };
  if (state.repairing) return { kind: "wait", timer: repairWaitMs, why: "the page is drawn again" };
  const limit = pictureLimit(tab.native);
  if (want.kind === "hold") {
    if (want.why === "its capture is let go") {
      const loadingNow = tab.loading || tab.navigation?.pending === true;
      if (state.failed !== null && !(state.failed.whileLoading === true && !loadingNow))
        return { kind: "wait", why: `its cast was given up: ${state.failed.why}` };
      if (state.trouble === "no-picture") {
        if (state.captureRetried || (!state.shown && state.unpictured >= limit))
          return { kind: "fail", why: "the page lost its capture" };
        return { kind: "repair", retry: true, why: "its capture did not come back" };
      }
      return { kind: "wait", timer: captureWaitMs, why: want.why };
    }
    return { kind: "wait", why: want.why };
  }
  const key = want.key;
  if (told.state === "sent")
    return { kind: "wait", timer: stopAnswerWaitMs, why: "a start is with Chromium" };
  if (told.state === "running") {
    const fit = fits(told.key, key);
    if (fit === "new-document")
      return { document: key.document, geometryRevision: key.geometryRevision, kind: "restamp" };
    if (!fit) return { kind: "restart", retry: false, why: difference(told.key, key) };
    const trouble = state.shown ? null : state.trouble;
    // At the bound the cast is given up, whatever else asks for a repair (S6).
    if (trouble !== null && trouble !== "other-size" && state.unpictured >= limit)
      return { kind: "fail", why: givenUpFor[trouble] };
    // A tab closed beside it: a change, which a repair answers once per such event (R2).
    if (state.redraw) return { kind: "repair", retry: false, why: "a tab closed" };
    if (state.shown) return { kind: "idle" };
    if (trouble === "set-aside")
      return { kind: "restart", retry: true, why: "its frame was set aside" };
    if (trouble === "misfit" || trouble === "no-picture")
      return { kind: "repair", retry: true, why: givenUpFor[trouble] };
    if (trouble === "other-size")
      return {
        kind: "wait",
        timer: otherSizeWaitMs,
        why: "its own frame, after one of another size",
      };
    // A document still loading, or still with the browser side, sends its first frame as it paints,
    // with a longer limit so a page that loads forever and never paints still repairs and gives up
    // at the bound (U6).
    if (tab.loading || tab.navigation?.pending)
      return {
        kind: "wait",
        timer: loadingFirstFrameWaitMs * 2 ** Math.min(state.unpictured, 2),
        why: "its document's first frame, as it loads",
      };
    return {
      kind: "wait",
      timer: firstFrameWaitMs * 2 ** Math.min(state.unpictured, 2),
      why: "its first frame",
    };
  }
  const loadingNow = tab.loading || tab.navigation?.pending === true;
  if (
    state.failed !== null &&
    state.failed.key !== null &&
    sameCast(state.failed.key, key) &&
    !(state.failed.whileLoading === true && !loadingNow)
  )
    return { kind: "wait", why: `its cast was given up: ${state.failed.why}` };
  if (state.paint && samePaint(state.paint, key))
    return { kind: "wait", why: "the page did not paint" };
  const can = canTakeStart(tab, state.refusal);
  if (!can.ok) {
    // W2: a refusal held while the page loads or a navigation is pending is bounded like the
    // loading first-frame wait so a stuck load never leaves the tab blank forever.
    if (state.refusal !== null && !refusalReleased(tab, state.refusal) && loadingNow)
      return {
        kind: "wait",
        timer: loadingFirstFrameWaitMs * 2 ** Math.min(state.unpictured, 2),
        why: can.why,
      };
    return { kind: "wait", why: can.why };
  }
  return { kind: "start" };
}

/**
 * The cast a start being prepared is still to be sent for: the one the plan would start now, had
 * it not begun. Null when the facts moved so that it would not (a dialog, a pause, a refusal).
 */
export function startStillWanted(
  facts: CastFacts,
  bound: string,
  state: TabCastState,
  session: SessionCastState,
): CastKey | null {
  if (state.told.state !== "preparing") return null;
  const step = nextStep(facts, bound, { ...state, told: { state: "none" } }, session);
  const want = wanted(facts);
  return step.kind === "start" && want.kind === "cast" ? want.key : null;
}

/** The running cast's key, restamped for the new document it pictures at the same size. */
export function restamped(told: CastKey, want: CastKey): CastKey {
  return { ...told, document: want.document, geometryRevision: want.geometryRevision };
}

/**
 * A frame as the follow view measured it: the size it says, its raster's when it decodes, and the
 * document the follow view had seen when it arrived, which is the document it can picture.
 */
export interface FrameMeasure {
  readonly geometry: PageSize | null;
  readonly raster: PageSize | null;
  readonly document: string | null;
  /** True when captured while an earlier-generation timed-out stop was still unanswered (W1). */
  readonly stale?: boolean;
}

/** What a frame is, from what was told, the facts, and its measure. */
export function frameVerdict(
  state: TabCastState,
  session: SessionCastState,
  frame: FrameMeasure,
  facts: CastFacts,
): FrameVerdict {
  const told = state.told;
  // A frame on a session whose stop is with Chromium is the stopped cast's: no one's now. One
  // while nothing is streamed is no one's either (S6).
  if (session.stops > 0 || !facts.streaming) return "dropped";
  if (told.state === "sent") {
    if (fitsRegion(frame.geometry, told.key.region)) return "held";
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
  if (session.staleStops > 0 || frame.stale === true) return restamp ? "dropped" : "show-unproven";
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
      const loadingNow = facts.tab?.loading === true || facts.tab?.navigation?.pending === true;
      // A cast given up is tried again, with fresh counts, once what it would picture changed, or
      // once a load it failed during has finished (U5).
      if (want.kind === "cast" && next.captureRetried) next = { ...next, captureRetried: false };
      if (want.kind === "cast" && next.told.state === "none" && next.trouble === "no-picture")
        next = { ...next, trouble: null };
      if (
        next.failed &&
        ((want.kind === "cast" &&
          (next.failed.key === null || !sameCast(next.failed.key, want.key))) ||
          (next.failed.whileLoading === true && !loadingNow))
      )
        next = { ...next, failed: null, unpictured: 0 };
      // Retries belong to one cast: once what is wanted moves to another cast while none runs or
      // is with Chromium, the new cast begins its own retries afresh (U1, U8).
      if (
        (next.told.state === "none" || next.told.state === "preparing") &&
        next.repairing === null &&
        next.lastKey &&
        want.kind === "cast" &&
        !sameCast(next.lastKey, want.key)
      )
        next = { ...next, lastKey: null, unpictured: 0 };
      // A pause, or a picture whose size, capture or geometry moved on, ends a paint wait (U3).
      if (
        next.paint &&
        (!facts.streaming ||
          facts.closed ||
          (want.kind === "cast" && !samePaint(next.paint, want.key)))
      )
        next = { ...next, paint: null };
      return next;
    }
    case "start-begun":
      return { ...state, told: { state: "preparing" } };
    case "sent": {
      // A start for another cast is a change, not a retry: its count begins afresh (R6). When
      // `lastKey` is null (after a rebind, a non-retry stop, or a timed-out stop), any attempts
      // already recorded belong to this cast and stay (U4).
      const another = state.lastKey !== null && fits(state.lastKey, event.key) !== "same";
      return {
        ...state,
        lastKey: event.key,
        shown: false,
        told: { at: event.at, key: event.key, state: "sent" },
        trouble: null,
        unpictured: another ? 0 : state.unpictured,
      };
    }
    case "answered":
      return told.state === "sent"
        ? { ...state, paint: null, refusal: null, told: { key: told.key, state: "running" } }
        : state;
    case "start-failed": {
      // Chromium's answer to the start itself: the page could not take it, as it was then.
      if (told.state === "sent")
        return { ...state, refusal: { ...told.at, why: event.why }, told: { state: "none" } };
      if (told.state !== "preparing") return state;
      // A CDP preparation command (`Emulation.setVisibleSize`) that failed during a navigation is
      // held as a navigation-time refusal rather than spinning through microtask retries (U5).
      if (event.at && facts.tab && refusedInNavigation(facts.tab, { ...event.at, why: event.why }))
        return { ...state, refusal: { ...event.at, why: event.why }, told: { state: "none" } };
      // It failed before it reached Chromium (S2): `pictureLimit` is the number of retries after
      // the first attempt, the same in every path (U1). If the wanted cast moved to a new key
      // while the old start was preparing, the new cast starts its own retries afresh (U8).
      const want = wanted(facts);
      const loadingNow = facts.tab?.loading === true || facts.tab?.navigation?.pending === true;
      const prior =
        want.kind === "cast" && state.lastKey !== null && !sameCast(state.lastKey, want.key)
          ? 0
          : state.unpictured;
      const atBound = want.kind === "cast" && prior >= pictureLimit(facts.tab?.native ?? false);
      return {
        ...state,
        failed: atBound
          ? {
              key: want.key,
              why: `its start could not be made (${event.why})`,
              ...(loadingNow ? { whileLoading: true } : {}),
            }
          : state.failed,
        lastKey: want.kind === "cast" ? want.key : state.lastKey,
        told: { state: "none" },
        unpictured: atBound ? prior : prior + 1,
      };
    }
    case "not-sent":
      return told.state === "preparing" ? { ...state, told: { state: "none" } } : state;
    case "paint-timed-out": {
      const want = wanted(facts);
      return {
        ...state,
        paint:
          want.kind === "cast"
            ? {
                captureRevision: want.key.captureRevision,
                geometryRevision: want.key.geometryRevision,
                size: want.key.size,
              }
            : null,
        told: told.state === "preparing" ? { state: "none" } : told,
      };
    }
    case "paint-backoff-ended":
      return { ...state, paint: null };
    case "stopped": {
      const change = !event.retry && event.givenUp === undefined;
      const loadingNow = facts.tab?.loading === true || facts.tab?.navigation?.pending === true;
      const want = wanted(facts);
      return {
        ...state,
        captureRetried:
          event.givenUp !== undefined && want.kind === "hold" ? false : state.captureRetried,
        failed:
          event.givenUp !== undefined &&
          (told.state === "running" || want.kind === "hold" || want.kind === "cast")
            ? {
                key:
                  want.kind === "hold"
                    ? null
                    : told.state === "running"
                      ? told.key
                      : want.kind === "cast"
                        ? want.key
                        : null,
                why: event.givenUp,
                ...(loadingNow ? { whileLoading: true } : {}),
              }
            : state.failed,
        // A stop for a change (resize, pause, leaving) starts the next cast's key afresh so a
        // timed-out stop's count is kept for the start that follows it (U4).
        lastKey: change ? null : state.lastKey,
        redraw: false,
        shown: false,
        told: { state: "none" },
        trouble: null,
        // R2: a retry on the same facts with no picture counts against the cast. A restart for a
        // new fact (another key) is a change, not a retry, and does not; its start counts afresh.
        unpictured: event.retry
          ? state.shown
            ? state.unpictured
            : state.unpictured + 1
          : change
            ? 0
            : state.unpictured,
      };
    }
    case "repair-begun":
      return {
        ...state,
        redraw: false,
        repairing: wanted(facts).kind === "hold" ? "capture" : event.retry ? "retry" : "change",
        shown: false,
        told: { state: "none" },
        trouble: null,
      };
    case "repair-drawn":
      // R2 and R10: a repair counts only once the page is drawn again, and only as a retry; one
      // a tab closed beside it asked for (`redraw`, armed once per such event) is a change; one
      // for a lost capture counts only against `captureRetried`, never against the next cast.
      if (state.repairing === "capture") return { ...state, captureRetried: true, repairing: null };
      return {
        ...state,
        repairing: null,
        unpictured: state.repairing === "retry" ? state.unpictured + 1 : state.unpictured,
      };
    case "casts-ended":
      // The start in flight is ended with them: the follow view lets it go (S1).
      return told.state === "sent" || told.state === "running"
        ? { ...state, redraw: false, shown: false, told: { state: "none" }, trouble: null }
        : state;
    case "stop-timed-out":
      // S3 / U4: the stop counts as answered, and the start after it as an attempt with no picture,
      // kept across a resize or rebind (where `lastKey` is already null), while preserving `lastKey`
      // on a same-cast retry stop so a subsequent new document still resets the old cast's retries.
      return { ...state, unpictured: state.unpictured + (event.count ?? 1) };
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
                ? { key: restamped(told.key, want.key), state: "running" }
                : told,
            trouble: null,
            unpictured: 0,
          };
        }
        case "show-unproven":
        case "held":
        case "dropped":
          return state;
      }
      return state;
    case "first-frame-timeout": {
      // The time is up only if the plan still gives one now: not for another binding, a session
      // stop in flight, a tab not wanted, under a hold, or since pictured (U5).
      const step = nextStep(
        facts,
        event.binding ?? facts.tab?.binding ?? null,
        state,
        event.session ?? initialSessionCastState,
      );
      if (step.kind !== "wait" || step.timer === undefined) return state;
      const want = wanted(facts);
      if (want.kind === "hold" && want.why === "its capture is let go")
        return { ...state, trouble: "no-picture" };
      if (told.state === "running") return { ...state, trouble: "no-picture" };
      const loadingNow = facts.tab?.loading === true || facts.tab?.navigation?.pending === true;
      const limit = pictureLimit(facts.tab?.native ?? false);
      // X2: a start that Chromium never answers is abandoned at `stopAnswerWaitMs`, counted as a
      // retry, and given up at `pictureLimit`.
      if (told.state === "sent") {
        const atBound = state.unpictured >= limit;
        return {
          ...state,
          failed: atBound
            ? {
                key: told.key,
                ...(loadingNow ? { whileLoading: true } : {}),
                why: "the page did not answer the start",
              }
            : state.failed,
          lastKey: told.key,
          told: { state: "none" },
          trouble: null,
          unpictured: atBound ? state.unpictured : state.unpictured + 1,
        };
      }
      // X2: a start whose preparation hangs is abandoned at `prepareWaitMs`, counted as a retry,
      // and given up at `pictureLimit`.
      if (told.state === "preparing") {
        const prior =
          want.kind === "cast" && state.lastKey !== null && !sameCast(state.lastKey, want.key)
            ? 0
            : state.unpictured;
        const atBound = want.kind === "cast" && prior >= limit;
        return {
          ...state,
          failed: atBound
            ? {
                key: want.key,
                ...(loadingNow ? { whileLoading: true } : {}),
                why: "the page did not prepare the start",
              }
            : state.failed,
          lastKey: want.kind === "cast" ? want.key : state.lastKey,
          told: { state: "none" },
          trouble: null,
          unpictured: want.kind === "cast" ? (atBound ? prior : prior + 1) : state.unpictured,
        };
      }
      // X2: a redraw (`invalidateSurface`) that hangs is abandoned at `repairWaitMs`, counted as a
      // retry if it was a retry repair, and given up at `pictureLimit`.
      if (state.repairing !== null) {
        if (state.repairing === "capture") {
          const atBound = state.captureRetried === true;
          return {
            ...state,
            captureRetried: !atBound,
            failed: atBound
              ? {
                  key: null,
                  ...(loadingNow ? { whileLoading: true } : {}),
                  why: "the page lost its capture",
                }
              : state.failed,
            repairing: null,
            trouble: null,
          };
        }
        const isRetry = state.repairing === "retry";
        const atBound = isRetry && want.kind === "cast" && state.unpictured >= limit;
        return {
          ...state,
          failed: atBound
            ? {
                key: want.key,
                ...(loadingNow ? { whileLoading: true } : {}),
                why: "the page could not be redrawn",
              }
            : state.failed,
          repairing: null,
          trouble: null,
          unpictured:
            isRetry && want.kind === "cast"
              ? atBound
                ? state.unpictured
                : state.unpictured + 1
              : state.unpictured,
        };
      }
      // W2: a refusal held while loading or navigating reached its bound; release it and count as
      // a retry, or give up at `pictureLimit` with `whileLoading` and Opensteer's own sentence
      // (keeping the raw CDP refusal in `detail` for diagnostics).
      if (told.state === "none" && state.refusal !== null && want.kind === "cast") {
        const atBound = state.unpictured >= limit;
        return {
          ...state,
          failed: atBound
            ? {
                detail: state.refusal.why,
                key: want.key,
                whileLoading: true,
                why: "the page could not start casting while loading",
              }
            : state.failed,
          lastKey: want.key,
          refusal: null,
          unpictured: atBound ? state.unpictured : state.unpictured + 1,
        };
      }
      return state;
    }
    case "resumed":
      return { ...state, captureRetried: false, failed: null, refusal: null, unpictured: 0 };
    case "tab-closed-beside":
      return told.state === "running" && facts.tab?.native === false
        ? { ...state, redraw: true, shown: false }
        : state;
    case "restamped": {
      if (told.state !== "running") return state;
      const key = {
        ...told.key,
        document: event.document,
        geometryRevision: event.geometryRevision,
      };
      // A new document at the same size is a new cast: its retries begin afresh (M16, W1).
      return {
        ...state,
        lastKey: key,
        shown: false,
        told: { key, state: "running" },
        trouble: null,
        unpictured: 0,
      };
    }
  }
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

function samePaint(paint: PaintWait, key: CastKey): boolean {
  return (
    sameSize(paint.size, key.size) &&
    paint.captureRevision === key.captureRevision &&
    paint.geometryRevision === key.geometryRevision
  );
}
