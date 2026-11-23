import { z } from "zod";
import { browserFrameFits } from "@opensteer/browser-core";
import type {
  BrowserCaptureDescriptor,
  BrowserDialog,
  BrowserSurfaceId,
} from "@opensteer/protocol/browser";
import { BrowserRuntimeError } from "../errors.js";
import type { LatestFrameStream } from "../stream/latest-frame-stream.js";
import { readImageDimensions } from "../stream/frame.js";
import {
  BrowserPaintTimeoutError,
  screencastEndedEvent,
  type CdpSession,
  type PageCapture,
} from "./backend.js";
import {
  after,
  canTakeStart,
  fits,
  frameVerdict,
  initialTabCastState,
  nextStep,
  sameSize,
  wanted,
  type CastEvent,
  type CastFacts,
  type CastKey,
  type Refusal,
  type Step,
  type TabCastState,
} from "./screencast-plan.js";
import type {
  PageSize,
  SurfaceBinding,
  SurfaceLedger,
  SurfaceLedgerEvent,
} from "./surface-ledger.js";

export { screencastRaster } from "./screencast-plan.js";

const paintRetryInitialMs = 1_000;
const paintRetryMaxMs = 16_000;
/** Steps one pass may take before it is quiet: more is a loop between steps, and it stops. */
const passStepLimit = 24;

interface CdpScreencastFrame {
  geometry: PageSize | null;
  /** How far Chromium zooms the page into the picture, as for a mobile page with no viewport. */
  pageScale: number;
  data: string;
}

/** The tab the follow view is bound to, and what it told Chromium there. */
interface Bound {
  readonly id: BrowserSurfaceId;
  readonly binding: string;
  readonly cdp: CdpSession;
  readonly page: SurfaceBinding["page"];
  /** Written only by `after`: `this.apply` stores what it returns. */
  state: TabCastState;
  /** The latest frame that came with the start in flight, of what it asked for: not yet acked. */
  held: unknown;
  /** The document the follow view had seen when the held frame arrived. */
  heldDocument: string | null;
  /** A start, or a repair's redraw, under way: given up by aborting it. */
  inFlight: AbortController | null;
  /** The page zoom of the latest picture shown, which input on it undoes. */
  pageScale: number;
  paintDelay: number;
  releaseRendering: (() => void) | null;
  /** Why the next start is sent: what last stopped the cast, or what bound the tab. */
  startWhy: string;
  /** The last wait recorded, so each is recorded once. */
  waiting: string | null;
  paintTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The time the plan gives the running cast for a picture, and how long it is: one timer serves
   * the first frame and a start's own frame after one of another size, at the plan's length.
   */
  firstFrameTimer: { readonly timer: ReturnType<typeof setTimeout>; readonly ms: number } | null;
  readonly unbind: () => void;
}

interface ScreencastControllerOptions {
  surfaceId?: BrowserSurfaceId;
  frameQuality?: number;
  frames: LatestFrameStream;
  ledger: SurfaceLedger;
  onDialogChanged(dialog: BrowserDialog | null): void;
  onError?(error: BrowserRuntimeError): void;
}

/**
 * The follow view: the person's picture of the tab in view. Each trigger (a ledger event,
 * streaming, raster demand, a capture or navigation change, a frame, a timer, a stop's answer)
 * only records what happened and asks for a pass. A pass reads the facts afresh, compares them
 * with what Chromium was told and what was shown, and takes one step (`nextStep`), until nothing
 * is left to do or what is left waits on a fact it names. What was told, and what came of it, is
 * written only by `after`.
 */
export class ScreencastController {
  readonly diagnostics: {
    stage: string;
    reason?: string;
    frameId?: number;
    bytes?: number;
    durationMs?: number;
    geometryRevision?: number;
    surfaceId?: BrowserSurfaceId;
    castId?: number;
    captureRevision?: number;
  }[] = [];
  private diagnose(record: (typeof this.diagnostics)[number]): void {
    if (this.bound) record.surfaceId = this.bound.id;
    if (this.diagnostics.length === 256) this.diagnostics.shift();
    this.diagnostics.push(record);
    if (process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1")
      console.info(JSON.stringify({ browserCapture: true, ...record }));
  }
  private readonly surfaceId: BrowserSurfaceId | undefined;
  private bound: Bound | null = null;
  private readonly lifecycle = new AbortController();
  private closed = false;
  private dialog: BrowserDialog | null = null;
  private frameId = 0;
  private castId = 0;
  private readonly frameQuality: number;
  private readonly frames: LatestFrameStream;
  /**
   * Each page's latest picture. A page under a JavaScript dialog draws
   * nothing, so when the person turns back to one, its last picture is what
   * the stream shows beneath the dialog.
   */
  private readonly lastPictures = new Map<
    BrowserSurfaceId,
    {
      readonly data: Buffer;
      readonly geometry: PageSize;
      readonly raster: PageSize;
      readonly revision: number;
      readonly capture: BrowserCaptureDescriptor | undefined;
    }
  >();
  private readonly ledger: SurfaceLedger;
  /** The page the latest surface list sent to viewers shows. */
  private shownToViewers: BrowserSurfaceId | null = null;
  private readonly onDialogChanged: (dialog: BrowserDialog | null) => void;
  private streaming = false;
  private captureRegions = false;
  private rasterDemand = 2;
  private unsupportedCapture: number | null = null;
  private readonly onError: ScreencastControllerOptions["onError"];
  private unsubscribe: (() => void) | null = null;
  /** A pass is asked for: the facts may have changed since the last one read them. */
  private dirty = false;
  private passing = false;
  /** Ends the current wait on a step: the facts changed. */
  private wake: (() => void) | null = null;
  private quietWaiters: Array<() => void> = [];
  /** A start refused outside any navigation, for the caller whose change led to it. */
  private failure: unknown = null;
  private readonly sessions = new WeakMap<CdpSession, number>();
  private sessionCount = 0;
  /** Each session's stops still with Chromium: a session, not a binding, holds them. */
  private readonly stops = new WeakMap<CdpSession, number>();

  constructor(options: ScreencastControllerOptions) {
    this.surfaceId = options.surfaceId;
    this.onError = options.onError;
    this.frameQuality = options.frameQuality ?? 72;
    this.frames = options.frames;
    this.ledger = options.ledger;
    this.onDialogChanged = options.onDialogChanged;
    if (!Number.isInteger(this.frameQuality) || this.frameQuality < 0 || this.frameQuality > 100) {
      throw new TypeError("The browser screencast policy is invalid.");
    }
  }

  /** Viewers were sent a surface list that shows this page. */
  viewersShown(surfaceId: BrowserSurfaceId | null): void {
    this.shownToViewers = surfaceId;
    if (this.bound) this.showRetainedPicture(this.bound);
  }

  /** The dialog open on the page the person sees, which they can answer. */
  currentDialog(): BrowserDialog | null {
    const surfaceId = this.surfaceId ?? this.ledger.active()?.surface.id;
    return surfaceId ? this.ledger.dialogOf(surfaceId) : null;
  }

  async start(): Promise<void> {
    if (this.closed) throw new BrowserRuntimeError("conflict", "The browser stream is closed.");
    if (!this.unsubscribe) {
      this.unsubscribe = this.ledger.subscribe((event) => this.handleLedgerEvent(event));
    }
    await this.quiet();
    if (this.surfaceId) this.publishDialog();
  }

  /**
   * Starts or pauses the picture of the page in view. Pausing keeps the page bound, so a dialog
   * open there stays the person's to answer. Neither waits for Chromium to stop: a page under a
   * dialog answers nothing else. A start refused outside any navigation is the caller's to hear.
   */
  async setStreaming(streaming: boolean, captureRegions = this.captureRegions): Promise<void> {
    this.captureRegions = captureRegions;
    if (this.closed) throw new BrowserRuntimeError("conflict", "The browser stream is closed.");
    const previous = this.streaming;
    this.streaming = streaming;
    // Asking for the picture again asks the page afresh: a cast given up, or a refusal, is not held.
    if (streaming && !previous && this.bound) {
      this.apply(this.bound, { kind: "resumed" });
      if (this.bound.state.told.state === "none") this.bound.startWhy = "subscribe";
    }
    this.failure = null;
    await this.quiet();
    const failure = this.failure;
    this.failure = null;
    if (failure !== null && streaming) {
      if (this.streaming === streaming) this.streaming = previous;
      this.requestPass();
      throw failure;
    }
  }

  resolvePoint(
    surfaceId: BrowserSurfaceId,
    x: number,
    y: number,
    viewportWidth: number,
    viewportHeight: number,
    captureRevision?: number,
    geometryRevision?: number,
  ): { readonly x: number; readonly y: number } | null {
    const bound = this.bound;
    if (!bound || bound.id !== surfaceId) return null;
    const told = bound.state.told;
    const key = told.state === "running" || told.state === "sent" ? told.key : null;
    const binding = this.ledger.binding(surfaceId);
    const geometry = this.ledger.viewportOf(surfaceId);
    const port = binding?.page.capture;
    const capture = port?.read();
    if (
      port &&
      (!capture ||
        (captureRevision === undefined
          ? !sameSize(capture, geometry)
          : !key ||
            capture.revision !== key.captureRevision ||
            captureRevision !== capture.revision ||
            geometryRevision !== key.geometryRevision) ||
        (geometryRevision !== undefined && geometryRevision !== binding?.surface.geometryRevision))
    )
      return null;
    // The picture the person aimed at must be the size the page is now; a
    // point on a picture from before a resize names another spot.
    if (!geometry || geometry.width !== viewportWidth || geometry.height !== viewportHeight) {
      return null;
    }
    // Image-local DIPs map through the recorded region; Input names CSS pixels.
    return {
      x: (x * (capture?.width ?? geometry.width)) / bound.pageScale,
      y: (y * (capture?.height ?? geometry.height)) / bound.pageScale,
    };
  }

  /** Changes capture resolution without changing the surface's input geometry. */
  async setRasterDemand(density: 0.75 | 1 | 1.25 | 1.5 | 2): Promise<void> {
    if (this.closed) throw new BrowserRuntimeError("conflict", "The browser stream is closed.");
    if (this.rasterDemand === density) return;
    this.rasterDemand = density;
    await this.quiet();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frames.close();
    this.lastPictures.clear();
    // The pass unbinds the tab, stopping its cast.
    await this.quiet();
  }

  /** Chromium is gone; release local listeners without asking its dead CDP transport to stop. */
  abort(): void {
    this.closed = true;
    this.lifecycle.abort();
    this.streaming = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frames.close();
    this.lastPictures.clear();
    const bound = this.bound;
    this.bound = null;
    if (bound) this.release(bound);
    // No one waits on a pass that will not come.
    this.wake?.();
    const waiters = this.quietWaiters;
    this.quietWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private handleLedgerEvent(event: SurfaceLedgerEvent): void {
    if (event.type === "closed") {
      this.abort();
      return;
    }
    if (event.type === "dialog-event" || event.type === "popup") return;
    if (
      event.type !== "geometry" &&
      event.type !== "navigation.committed" &&
      event.type !== "resized"
    )
      // Published as the event arrives, before the surface list that follows
      // it, so a viewer never shows one page's dialog over another page.
      this.publishDialog();
    if (event.type === "changed" && event.change === "closed") {
      this.lastPictures.delete(event.surface.id);
      // When a tab closes, headless Chrome shows the tab that remains at its window's size again,
      // whichever of the two the person was watching: the picture is to be made again.
      if (this.bound)
        this.apply(this.bound, { kind: "tab-closed-beside", native: !!this.bound.page.capture });
    }
    if (event.type === "snapshot") {
      for (const surfaceId of this.lastPictures.keys()) {
        if (!event.surfaces.some((surface) => surface.id === surfaceId)) {
          this.lastPictures.delete(surfaceId);
        }
      }
    }
    this.requestPass();
  }

  /** Stores the state that follows from `event`: the one way a bound tab's state changes. */
  private apply(bound: Bound, event: CastEvent): void {
    bound.state = after(bound.state, event, this.readFacts());
  }

  /**
   * Resolves once a pass is quiet: no step under way, no start of the bound tab in flight, and no
   * restart's stop still with Chromium.
   */
  private quiet(): Promise<void> {
    const quiet = new Promise<void>((resolve) => this.quietWaiters.push(resolve));
    this.requestPass();
    return quiet;
  }

  /**
   * Asks for a pass. It starts once the current burst of events has been told (a microtask
   * later), so it reads the facts they leave, not each one on the way: a tab left and returned to
   * at once was never left.
   */
  private requestPass(): void {
    this.dirty = true;
    this.wake?.();
    if (this.passing) return;
    this.passing = true;
    queueMicrotask(() => {
      void this.runPasses().finally(() => {
        this.passing = false;
        if (this.dirty) this.requestPass();
        else this.settleQuiet();
      });
    });
  }

  private settleQuiet(): void {
    if (this.passing || this.bound?.inFlight) return;
    // A restart's stop is with Chromium and its start is still to come; a stop while nothing is
    // wanted (a pause, a page under a dialog) is waited on by no one.
    if (this.bound?.state.told.state === "stopping" && wanted(this.readFacts()).kind === "cast")
      return;
    const waiters = this.quietWaiters;
    this.quietWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private async runPasses(): Promise<void> {
    let steps = 0;
    while (this.dirty) {
      this.dirty = false;
      const facts = this.readFacts();
      const bound = this.bound;
      if (bound && facts.tab?.binding === bound.binding) this.apply(bound, { kind: "observed" });
      const step = nextStep(facts, bound?.binding ?? null, bound?.state ?? null);
      this.keepRendering(facts);
      this.keepTimers(step);
      if (step.kind === "idle" || step.kind === "wait") {
        this.rest(step);
        continue;
      }
      steps += 1;
      if (steps > passStepLimit) {
        this.diagnose({ stage: "pass-limit", reason: step.kind });
        return;
      }
      await this.take(step);
      this.dirty = true;
    }
  }

  private readFacts(): CastFacts {
    const binding = this.closed
      ? null
      : this.surfaceId
        ? this.ledger.binding(this.surfaceId)
        : this.ledger.active();
    const page = binding?.page;
    let session = binding ? this.sessions.get(binding.cdp) : undefined;
    if (binding && session === undefined) {
      session = ++this.sessionCount;
      this.sessions.set(binding.cdp, session);
    }
    const capture = page?.capture?.read() ?? null;
    return {
      captureRegions: this.captureRegions,
      closed: this.closed,
      density: this.rasterDemand,
      streaming: this.streaming,
      tab:
        binding && page
          ? {
              binding: `${binding.surface.id}#${String(session)}`,
              capture: capture
                ? {
                    height: capture.height,
                    rasterScale: capture.rasterScale,
                    revision: capture.revision,
                    width: capture.width,
                  }
                : null,
              dialogOpen: this.ledger.dialogOpen(binding.surface.id),
              document: binding.surface.documentId ?? null,
              geometryRevision: binding.surface.geometryRevision ?? 0,
              loading: binding.surface.loading === true,
              native: !!page.capture,
              navigation: page.navigations?.read() ?? null,
              size: this.ledger.viewportOf(binding.surface.id),
              sizesView: !page.capture && !page.applyGeometry,
            }
          : null,
    };
  }

  /** A pass with nothing to do now: say what it waits on, once. */
  private rest(step: Extract<Step, { kind: "idle" | "wait" }>): void {
    const bound = this.bound;
    if (!bound) return;
    if (step.kind === "wait") {
      if (bound.waiting !== step.why) {
        bound.waiting = step.why;
        this.diagnose({ stage: "cast-held", reason: step.why });
      }
      if (step.why === "a dialog is open") this.showRetainedPicture(bound);
    } else bound.waiting = null;
  }

  private async take(step: Exclude<Step, { kind: "idle" | "wait" }>): Promise<void> {
    if (step.kind === "bind") {
      this.rebind();
      return;
    }
    const bound = this.bound;
    if (!bound) return;
    bound.waiting = null;
    switch (step.kind) {
      case "stop":
        this.stopCast(bound, step.why, false);
        return;
      case "restart":
        this.stopCast(bound, step.why, step.retry);
        return;
      case "restamp":
        this.apply(bound, {
          document: step.document,
          geometryRevision: step.geometryRevision,
          kind: "restamped",
        });
        this.diagnose({ stage: "cast-kept", geometryRevision: step.geometryRevision });
        return;
      case "start":
        await this.untilChanged(this.beginStart(bound));
        return;
      case "repair":
        this.beginRepair(bound, step);
        return;
      case "fail": {
        const told = bound.state.told;
        this.stopCast(
          bound,
          step.why,
          false,
          told.state === "running" ? { key: told.key, why: step.why } : undefined,
        );
        this.diagnose({ stage: "cast-failed", reason: step.why });
        // The code is the one the clients know; the text says what is true of this cast.
        this.onError?.(
          new BrowserRuntimeError(
            "internal",
            `The picture of the page was given up: ${step.why}.`,
            { reason: "browser-capture-mismatch" },
          ),
        );
        return;
      }
    }
  }

  /** `work`, or the facts changing first: a pass never waits on a step the facts left behind. */
  private untilChanged(work: Promise<void>): Promise<void> {
    if (this.dirty) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.wake === done) this.wake = null;
        resolve();
      };
      this.wake = done;
      void work.then(done, done);
    });
  }

  /** Unbinds the tab bound (its cast stops) and binds the one in view. */
  private rebind(): void {
    const previous = this.bound;
    this.bound = null;
    if (previous) {
      this.stopCast(previous, "the tab left", false);
      this.release(previous);
    }
    if (this.closed) return;
    const binding = this.surfaceId ? this.ledger.binding(this.surfaceId) : this.ledger.active();
    if (!binding) return;
    const session = this.sessions.get(binding.cdp);
    const onFrame = (parameters: unknown) => this.onFrame(bound, parameters);
    const onEnded = () => {
      if (this.bound !== bound) return;
      this.dropHeld(bound);
      this.apply(bound, { kind: "casts-ended" });
      bound.startWhy = "the engine ended its cast";
      this.diagnose({ stage: "cast-ended" });
      this.requestPass();
    };
    const offNavigations =
      binding.page.navigations?.subscribe(() => this.requestPass()) ?? (() => undefined);
    const offCapture =
      binding.page.capture?.subscribe(() => this.requestPass()) ?? (() => undefined);
    binding.cdp.on("Page.screencastFrame", onFrame);
    binding.cdp.on(screencastEndedEvent, onEnded);
    const bound: Bound = {
      binding: `${binding.surface.id}#${String(session)}`,
      cdp: binding.cdp,
      held: null,
      heldDocument: null,
      firstFrameTimer: null,
      id: binding.surface.id,
      inFlight: null,
      page: binding.page,
      pageScale: 1,
      paintDelay: paintRetryInitialMs,
      paintTimer: null,
      releaseRendering: null,
      startWhy: "bind",
      // A stop of this session still with Chromium, from before it was left, is still awaited.
      state: initialTabCastState((this.stops.get(binding.cdp) ?? 0) > 0),
      unbind: () => {
        offNavigations();
        offCapture();
        binding.cdp.off("Page.screencastFrame", onFrame);
        binding.cdp.off(screencastEndedEvent, onEnded);
      },
      waiting: null,
    };
    this.bound = bound;
  }

  /** Lets go of a tab's listeners, its rendering and its timers, its start given up. */
  private release(bound: Bound): void {
    bound.inFlight?.abort();
    bound.inFlight = null;
    this.dropHeld(bound);
    bound.releaseRendering?.();
    bound.releaseRendering = null;
    if (bound.paintTimer) clearTimeout(bound.paintTimer);
    bound.paintTimer = null;
    if (bound.firstFrameTimer) clearTimeout(bound.firstFrameTimer.timer);
    bound.firstFrameTimer = null;
    bound.unbind();
  }

  private dropHeld(bound: Bound): void {
    if (bound.held !== null) acknowledgeFrame(bound.cdp, bound.held);
    bound.held = null;
    bound.heldDocument = null;
  }

  /**
   * Stops what the tab was told. A start being prepared is given up before it reaches Chromium; a
   * start sent, or a cast running, is stopped without waiting (a page under a dialog answers
   * nothing else, and Chromium takes a session's commands in order), and the session is stopping
   * until the stop is answered.
   */
  private stopCast(
    bound: Bound,
    why: string,
    retry: boolean,
    failed?: { readonly key: CastKey; readonly why: string },
  ): void {
    const told = bound.state.told;
    bound.inFlight?.abort();
    bound.inFlight = null;
    if (told.state === "sent" || told.state === "running") this.sendStop(bound, why);
    this.dropHeld(bound);
    this.apply(bound, { kind: "stopped", retry, ...(failed ? { failed } : {}) });
    bound.startWhy = why;
  }

  private sendStop(bound: Bound, why: string): void {
    const cdp = bound.cdp;
    this.stops.set(cdp, (this.stops.get(cdp) ?? 0) + 1);
    this.diagnose({ stage: "cast-stop", reason: why });
    void this.ledger
      .use(bound.id, () => cdp.send("Page.stopScreencast"))
      .catch(() => undefined)
      .finally(() => {
        const remaining = Math.max(0, (this.stops.get(cdp) ?? 1) - 1);
        this.stops.set(cdp, remaining);
        const current = this.bound;
        if (current?.cdp === cdp) this.apply(current, { kind: "stop-answered", remaining });
        this.requestPass();
      });
  }

  /**
   * Keeps the tab drawing while it is streamed, except while its paint is waited out; a pause
   * ends that wait, and the next stream starts its backoff afresh.
   */
  private keepRendering(facts: CastFacts): void {
    const bound = this.bound;
    if (!bound) return;
    if (!facts.streaming || facts.closed) {
      if (bound.state.paint) this.apply(bound, { kind: "paint-backoff-ended" });
      bound.paintDelay = paintRetryInitialMs;
    }
    const keep = facts.streaming && !facts.closed && !bound.state.paint;
    if (keep) bound.releaseRendering ??= bound.cdp.retainRendering?.() ?? null;
    else {
      bound.releaseRendering?.();
      bound.releaseRendering = null;
    }
  }

  /**
   * The timers follow the plan: a paint backoff while one is recorded, and the time the plan gives
   * the running cast for a picture while its step waits on one. Any other step (a hold, a pause, a
   * stop, another tab) clears that timer; it only says the time is up, and `after` decides.
   */
  private keepTimers(step: Step): void {
    const bound = this.bound;
    if (!bound) return;
    const state = bound.state;
    if (state.paint && !bound.paintTimer) {
      const timer = setTimeout(() => {
        if (bound.paintTimer !== timer) return;
        bound.paintTimer = null;
        if (this.bound === bound) this.apply(bound, { kind: "paint-backoff-ended" });
        this.requestPass();
      }, bound.paintDelay);
      timer.unref();
      bound.paintTimer = timer;
      bound.paintDelay = Math.min(bound.paintDelay * 2, paintRetryMaxMs);
    } else if (!state.paint && bound.paintTimer) {
      clearTimeout(bound.paintTimer);
      bound.paintTimer = null;
    }
    const ms = step.kind === "wait" ? step.timer : undefined;
    if (bound.firstFrameTimer && bound.firstFrameTimer.ms !== ms) {
      clearTimeout(bound.firstFrameTimer.timer);
      bound.firstFrameTimer = null;
    }
    if (ms !== undefined && !bound.firstFrameTimer) {
      const timer = setTimeout(() => {
        if (bound.firstFrameTimer?.timer !== timer) return;
        bound.firstFrameTimer = null;
        if (this.bound === bound) {
          const before = bound.state.trouble;
          this.apply(bound, { kind: "first-frame-timeout" });
          if (bound.state.trouble !== before)
            this.diagnose({ stage: "cast-first-frame-timeout", durationMs: ms });
        }
        this.requestPass();
      }, ms);
      timer.unref();
      bound.firstFrameTimer = { ms, timer };
    }
  }

  /**
   * Prepares and sends a start: the page's paint first, then, inside the page's geometry lock, a
   * look at the facts as they are (a start the facts no longer want is not sent), and the start.
   * Resolves once its first command to Chromium is handed off, or it came to nothing: the pass
   * waits for no answer, and goes on to wait on it as a fact.
   */
  private beginStart(bound: Bound): Promise<void> {
    const abort = new AbortController();
    bound.inFlight = abort;
    this.apply(bound, { kind: "start-begun" });
    const handedOff = Promise.withResolvers<void>();
    const signal = AbortSignal.any([this.lifecycle.signal, abort.signal]);
    const current = () => bound.inFlight === abort && this.bound === bound;
    const why = bound.startWhy;
    let sentAt: Refusal | null = null;
    /** The cast the facts want now, if this start is still to be sent for it. */
    const stillWanted = (): CastKey | null => {
      if (signal.aborted || !current()) return null;
      const facts = this.readFacts();
      const want = wanted(facts);
      if (
        facts.tab?.binding !== bound.binding ||
        want.kind !== "cast" ||
        bound.state.told.state !== "preparing" ||
        !canTakeStart(facts.tab, bound.state.refusal).ok
      )
        return null;
      return want.key;
    };
    const send = async (): Promise<"answered" | "not-now"> => {
      const key = stillWanted();
      if (!key) return "not-now";
      // Chromium takes a session's commands in order: from here the start waits on Chromium.
      handedOff.resolve();
      if (key.sizesView) {
        await bound.cdp.send("Emulation.setVisibleSize", {
          height: key.size.height,
          width: key.size.width,
        });
        // The facts may have moved while Chromium sized the view: a dialog, a new size.
        const now = stillWanted();
        if (!now || fits(key, now) !== "same") return "not-now";
      }
      const facts = this.readFacts();
      sentAt = {
        document: facts.tab?.document ?? null,
        finished: facts.tab?.navigation?.finished ?? null,
        loading: facts.tab?.loading ?? false,
        pending: facts.tab?.navigation?.pending ?? false,
        why: "",
      };
      this.diagnose({
        stage: "cast-start",
        reason: why,
        castId: ++this.castId,
        geometryRevision: key.geometryRevision,
        ...(key.captureRevision === null ? {} : { captureRevision: key.captureRevision }),
      });
      this.dropHeld(bound);
      this.apply(bound, { key, kind: "sent" });
      await bound.cdp.send("Page.startScreencast", {
        everyNthFrame: 1,
        format: "jpeg",
        maxHeight: key.raster.height,
        maxWidth: key.raster.width,
        quality: this.frameQuality,
      });
      return "answered";
    };
    void this.ledger
      .use(bound.id, async () => {
        if (bound.page.settleRendering) await bound.page.settleRendering(signal);
        if (signal.aborted) return "not-now" as const;
        return bound.page.capture ? this.ledger.withGeometry(bound.id, send) : send();
      })
      .then(
        (outcome) => {
          if (!current()) return;
          bound.inFlight = null;
          if (outcome === "answered") {
            this.apply(bound, { kind: "answered" });
            bound.paintDelay = paintRetryInitialMs;
            const held = bound.held;
            const seen = bound.heldDocument;
            bound.held = null;
            // The frame that came with the start is judged now that it runs, as of when it came.
            if (held !== null) this.onFrame(bound, held, seen);
          } else {
            this.dropHeld(bound);
            this.apply(bound, { kind: "not-sent" });
          }
        },
        (error: unknown) => {
          if (!current()) return;
          bound.inFlight = null;
          this.dropHeld(bound);
          if (signal.aborted) {
            this.apply(bound, { kind: "not-sent" });
            return;
          }
          if (error instanceof BrowserPaintTimeoutError) {
            const want = wanted(this.readFacts());
            this.apply(bound, {
              kind: "paint-timed-out",
              paint:
                want.kind === "cast"
                  ? {
                      captureRevision: want.key.captureRevision,
                      geometryRevision: want.key.geometryRevision,
                      size: want.key.size,
                    }
                  : null,
            });
            bound.startWhy = "paint-retry";
            this.diagnose({ stage: "cast-paint-timeout" });
            this.showRetainedPicture(bound);
            return;
          }
          this.refused(bound, error, sentAt);
        },
      )
      .finally(() => {
        handedOff.resolve();
        this.requestPass();
      });
    return handedOff.promise;
  }

  /**
   * Records what the page could not take a start for, from each fact that bears on it as it was
   * when the start was sent: the next start waits for one of them to settle. A refusal outside any
   * navigation is told to the caller whose change led to it; the tab stays bound either way.
   */
  private refused(bound: Bound, error: unknown, sentAt: Refusal | null): void {
    const facts = this.readFacts();
    const tab = facts.tab?.binding === bound.binding ? facts.tab : null;
    const why = error instanceof Error ? error.message : String(error);
    const at = sentAt ?? {
      document: tab?.document ?? null,
      finished: tab?.navigation?.finished ?? null,
      loading: tab?.loading ?? false,
      pending: tab?.navigation?.pending ?? false,
      why,
    };
    this.apply(bound, { kind: "refused", refusal: { ...at, why } });
    bound.startWhy = "refusal released";
    const navigating =
      !!tab &&
      (at.loading ||
        at.pending ||
        tab.loading ||
        tab.navigation?.pending === true ||
        tab.document !== at.document ||
        (tab.navigation?.finished ?? 0) !== (at.finished ?? 0));
    this.diagnose({ stage: navigating ? "cast-deferred" : "cast-refused", reason: why });
    if (!navigating) this.failure = error;
  }

  /** Stops the cast and asks the page to draw its surface again; the pass then starts it. */
  private beginRepair(bound: Bound, step: Extract<Step, { kind: "repair" }>): void {
    const why = step.why;
    const told = bound.state.told;
    bound.inFlight?.abort();
    if (told.state === "sent" || told.state === "running") this.sendStop(bound, why);
    this.dropHeld(bound);
    this.apply(bound, { kind: "repair-begun", retry: step.retry });
    bound.startWhy = why;
    const abort = new AbortController();
    bound.inFlight = abort;
    this.diagnose({ stage: "cast-repair", reason: `${bound.state.unpictured}` });
    void (bound.page.invalidateSurface?.() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        if (bound.inFlight !== abort || this.bound !== bound) return;
        bound.inFlight = null;
        this.apply(bound, { kind: "repair-drawn" });
      })
      .finally(() => this.requestPass());
  }

  private onFrame(bound: Bound, parameters: unknown, seenDocument?: string | null): void {
    const session = screencastSessionSchema.safeParse(parameters);
    if (!session.success) return;
    const event = parseScreencastFrame(parameters);
    if (!event) {
      this.diagnose({ stage: "capture-discard", reason: "Invalid screencast metadata." });
      acknowledgeFrame(bound.cdp, parameters);
      return;
    }
    // A frame of a session whose stop is with Chromium is the stopped cast's: no one's now.
    if (this.bound !== bound || this.closed || (this.stops.get(bound.cdp) ?? 0) > 0) {
      acknowledgeFrame(bound.cdp, parameters);
      return;
    }
    const data = Buffer.from(event.data, "base64");
    const decoded = readImageDimensions(data, "jpeg");
    const raster = decoded && browserFrameFits(decoded.width, decoded.height) ? decoded : null;
    const facts = this.readFacts();
    const document = seenDocument === undefined ? (facts.tab?.document ?? null) : seenDocument;
    const verdict = frameVerdict(
      bound.state,
      { document, geometry: event.geometry, raster },
      facts,
    );
    switch (verdict) {
      case "held":
        // A frame that comes with a start, of what it asked for, is its picture: it waits for
        // the answer.
        this.dropHeld(bound);
        bound.held = parameters;
        bound.heldDocument = document;
        this.diagnose({ stage: "capture-held" });
        return;
      case "show":
      case "restamp-show": {
        const told = bound.state.told;
        const want = wanted(facts);
        if (told.state !== "running" || !raster || want.kind !== "cast") break;
        // A frame of the new document is pictured as it, with the revision it committed at.
        const key =
          verdict === "restamp-show"
            ? {
                ...told.key,
                document: want.key.document,
                geometryRevision: want.key.geometryRevision,
              }
            : told.key;
        const delivered = this.admit(bound, key, event, data, raster);
        this.apply(bound, { kind: "frame", verdict: delivered ? verdict : "dropped" });
        break;
      }
      case "misfit":
      case "misfit-with-start": {
        const told = bound.state.told;
        const region = told.state === "running" || told.state === "sent" ? told.key.region : null;
        this.diagnose({
          stage: "capture-discard",
          reason: `viewport ${describe(event.geometry)} raster ${describe(raster)}, expected ${describe(region)}`,
        });
        this.apply(bound, { kind: "frame", verdict });
        this.requestPass();
        break;
      }
      case "dropped":
        if (bound.state.told.state === "running" && !raster)
          this.diagnose({
            stage: "capture-discard",
            reason: "Chromium returned an invalid browser frame.",
          });
        this.requestPass();
        break;
      case "other-size-with-start":
      case "set-aside":
        this.apply(bound, { kind: "frame", verdict });
        this.requestPass();
        break;
    }
    acknowledgeFrame(bound.cdp, parameters);
  }

  /** Shows a frame of the running cast; whether it reached the viewers. */
  private admit(
    bound: Bound,
    key: CastKey,
    event: CdpScreencastFrame,
    data: Buffer,
    raster: PageSize,
  ): boolean {
    const received = performance.now();
    bound.pageScale = event.pageScale;
    this.ledger.recordPageScale(bound.id, event.pageScale);
    const capture = key.captureRevision === null ? undefined : this.captureOf(bound, key);
    const delivered = this.enqueueFrame(
      bound.id,
      data,
      raster,
      key.size,
      key.geometryRevision,
      capture,
    );
    if (!delivered) return false;
    this.lastPictures.set(bound.id, {
      capture,
      data,
      geometry: key.size,
      raster,
      revision: key.geometryRevision,
    });
    this.diagnose({
      stage: "capture-admit",
      frameId: this.frameId,
      bytes: data.byteLength,
      durationMs: performance.now() - received,
      geometryRevision: key.geometryRevision,
    });
    return true;
  }

  private captureOf(bound: Bound, key: CastKey): BrowserCaptureDescriptor | undefined {
    const capture = bound.page.capture?.read();
    return capture && capture.revision === key.captureRevision
      ? captureDescriptor(capture)
      : undefined;
  }

  /** Sends a picture to the viewers; false when they cannot take it (a crop they do not show). */
  private enqueueFrame(
    surfaceId: BrowserSurfaceId,
    data: Buffer,
    parsed: PageSize,
    geometry: PageSize,
    revision: number,
    capture?: BrowserCaptureDescriptor,
  ): boolean {
    if (
      capture &&
      !this.captureRegions &&
      (capture.width !== geometry.width || capture.height !== geometry.height)
    ) {
      if (this.unsupportedCapture !== capture.revision) {
        this.unsupportedCapture = capture.revision;
        this.onError?.(
          new BrowserRuntimeError("conflict", "Update the Host to view a natively cropped page.", {
            reason: "browser-capture-region-unsupported",
          }),
        );
      }
      return false;
    }
    this.unsupportedCapture = null;
    this.frameId += 1;
    this.frames.enqueue({
      data,
      header: {
        encoding: "jpeg",
        geometryRevision: revision,
        ...(capture && this.captureRegions ? { capture } : {}),
        frameId: this.frameId,
        rasterHeight: parsed.height,
        rasterWidth: parsed.width,
        surfaceId,
        viewportHeight: geometry.height,
        viewportWidth: geometry.width,
      },
    });
    return true;
  }

  /**
   * Tells viewers about the dialog on the page they see, when that changed;
   * one that opened while its page was out of view shows once the page does.
   */
  private publishDialog(): void {
    const dialog = this.currentDialog();
    if (this.dialog?.id === dialog?.id) return;
    this.dialog = dialog;
    this.onDialogChanged(dialog);
  }

  /**
   * Shows the bound page's latest picture again while its dialog keeps it
   * from drawing. Viewers take a picture only of the page a list told them
   * is shown, and input reaches only the page the stream is bound to, so it
   * waits for both: the list or the binding, whichever comes last, sends it.
   */
  private showRetainedPicture(bound: Bound): void {
    if (this.closed || !this.streaming || this.bound !== bound) return;
    if (
      (!this.surfaceId && bound.id !== this.shownToViewers) ||
      !this.ledger.dialogOpen(bound.id)
    ) {
      return;
    }
    const last = this.lastPictures.get(bound.id);
    const size = this.ledger.viewportOf(bound.id);
    if (
      last &&
      size &&
      sameSize(last.geometry, size) &&
      last.revision === (this.ledger.binding(bound.id)?.surface.geometryRevision ?? 0)
    ) {
      this.enqueueFrame(
        bound.id,
        last.data,
        last.raster,
        last.geometry,
        last.revision,
        last.capture,
      );
    }
  }
}

/** Lets Chromium send the next frame of a cast whose frame is not shown. */
function acknowledgeFrame(source: CdpSession, parameters: unknown): void {
  const session = screencastSessionSchema.safeParse(parameters);
  if (session.success)
    void source
      .send("Page.screencastFrameAck", { sessionId: session.data.sessionId })
      .catch(() => undefined);
}

function describe(size: PageSize | null): string {
  return size ? `${size.width}x${size.height}` : "unsized";
}

const screencastSessionSchema = z.object({
  sessionId: z.number().int().nonnegative(),
});
const screencastFrameSchema = screencastSessionSchema.extend({
  data: z.string(),
  metadata: z.object({
    deviceWidth: z.number().positive().max(16_384),
    deviceHeight: z.number().positive().max(16_384),
    pageScaleFactor: z.number().positive().optional(),
  }),
});

function parseScreencastFrame(value: unknown): CdpScreencastFrame | null {
  const parsed = screencastFrameSchema.safeParse(value);
  if (!parsed.success) return null;
  const { data, metadata } = parsed.data;
  return {
    data,
    geometry: { width: metadata.deviceWidth, height: metadata.deviceHeight },
    pageScale: metadata.pageScaleFactor ?? 1,
  };
}

function captureDescriptor(capture: PageCapture): BrowserCaptureDescriptor {
  return {
    width: capture.width,
    height: capture.height,
    revision: capture.revision,
  };
}
