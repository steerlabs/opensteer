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
  afterSession,
  fits,
  frameVerdict,
  initialSessionCastState,
  initialTabCastState,
  nextStep,
  refusedInNavigation,
  restamped,
  sameSize,
  startFacts,
  startStillWanted,
  stopAnswerWaitMs,
  stopReachesChromium,
  wanted,
  type CastEvent,
  type CastFacts,
  type CastKey,
  type SessionCastState,
  type SessionEvent,
  type StartFacts,
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

/**
 * The tab the follow view is bound to. What it told Chromium there is `state`, written only by
 * `after`; every other field is a handle, a timer or a record that `reconcile` makes agree with
 * the state after each change of it, or a value no decision reads (S1).
 */
interface Bound {
  readonly id: BrowserSurfaceId;
  readonly binding: string;
  readonly cdp: CdpSession;
  readonly page: SurfaceBinding["page"];
  readonly unbind: () => void;
  /** Written only by `after`: `this.apply` stores what it returns. */
  state: TabCastState;
  /**
   * The latest frame that came with the start sent, of what it asked for, not yet acked, and the
   * document the follow view had seen when it arrived. Only while the start is sent: `reconcile`
   * acks and drops it otherwise.
   */
  held: { readonly parameters: unknown; readonly document: string | null } | null;
  /**
   * The start, or the repair's redraw, under way, to abort it by. Only while the state has it (a
   * start preparing or sent, a repair): `reconcile` aborts it otherwise. `stopSent` records when
   * a stop was already sent behind a sent start, so an abandoned start that still resolves is
   * stopped once (U2).
   */
  inFlight: {
    readonly kind: "start" | "repair";
    readonly abort: AbortController;
    stopSent?: boolean;
  } | null;
  /** Kept while the state wants the page drawn (streamed, no paint wait): by `reconcile`. */
  releaseRendering: (() => void) | null;
  /** Armed while the state has a paint wait: by `reconcile`. */
  paintTimer: ReturnType<typeof setTimeout> | null;
  /** How long the next paint backoff is; reset on a pause and an answered start. */
  paintDelay: number;
  /** Armed for the length the plan's wait gives, while it gives one: by `reconcile`. */
  firstFrameTimer: { readonly timer: ReturnType<typeof setTimeout>; readonly ms: number } | null;
  /** The plan's wait now, recorded once each: by `reconcile`. Read by no decision. */
  waiting: string | null;
  /** Why the next start is sent, recorded with it. Read by no decision. */
  startWhy: string;
  /** The page zoom of the latest picture shown, which input on it undoes. Not of casting. */
  pageScale: number;
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
    surfaceId?: BrowserSurfaceId | undefined;
    castId?: number;
    captureRevision?: number;
  }[] = [];
  private diagnose(record: (typeof this.diagnostics)[number]): void {
    if (!("surfaceId" in record) && this.bound) record.surfaceId = this.bound.id;
    if (this.diagnostics.length === 256) this.diagnostics.shift();
    this.diagnostics.push(record);
    if (process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1")
      console.info(JSON.stringify({ browserCapture: true, ...record }));
  }
  private readonly surfaceId: BrowserSurfaceId | undefined;
  private bound: Bound | null = null;
  private readonly lifecycle = new AbortController();
  private closed = false;
  private aborted = false;
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
  /** Each page session's stops (`SessionCastState`): a session outlives the tab bound to it. */
  private readonly sessionStates = new WeakMap<CdpSession, SessionCastState>();
  /**
   * The time each session's oldest stop is given for its answer, while one is with Chromium:
   * armed and cleared by `reconcile` (U4).
   */
  private readonly stopTimers = new Map<
    CdpSession,
    { readonly generation: number; readonly timer: ReturnType<typeof setTimeout> }
  >();

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
    this.reconcile(this.bound, this.bound?.state ?? null);
    // The pass unbinds the tab, stopping its cast.
    await this.quiet();
  }

  /** Chromium is gone; release local listeners without asking its dead CDP transport to stop. */
  abort(): void {
    this.closed = true;
    this.aborted = true;
    this.lifecycle.abort();
    this.streaming = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frames.close();
    this.lastPictures.clear();
    const bound = this.bound;
    this.bound = null;
    if (bound) this.release(bound);
    this.reconcile(null, null);
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
      if (this.bound) this.apply(this.bound, { kind: "tab-closed-beside" });
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
    const before = bound.state;
    bound.state = after(before, event, this.readFacts());
    this.reconcile(bound, before, bound.cdp);
  }

  private session(cdp: CdpSession): SessionCastState {
    return this.sessionStates.get(cdp) ?? initialSessionCastState;
  }

  /** Stores the session's state that follows from `event`: the one way it changes. */
  private applySession(cdp: CdpSession, event: SessionEvent, surfaceId?: BrowserSurfaceId): void {
    this.sessionStates.set(cdp, afterSession(this.session(cdp), event));
    this.reconcile(this.bound, this.bound?.state ?? null, cdp, surfaceId);
  }

  /**
   * Makes every effect agree with the state, after each change of it (S1, U4): session stop
   * timers, work in flight the state no longer has, the frame held for a start no longer sent,
   * rendering demand, the timers the plan gives, the wait recorded, and a cast newly given up.
   */
  private reconcile(
    bound: Bound | null,
    before: TabCastState | null,
    sessionCdp?: CdpSession,
    sessionSurfaceId?: BrowserSurfaceId,
  ): void {
    this.keepStopTimers(
      sessionCdp ?? bound?.cdp,
      sessionSurfaceId ?? (sessionCdp && sessionCdp !== bound?.cdp ? undefined : bound?.id),
    );
    if (!bound || this.bound !== bound) return;
    const state = bound.state;
    const told = state.told.state;
    const work = bound.inFlight;
    if (
      work &&
      (work.kind === "start" ? told !== "preparing" && told !== "sent" : state.repairing === null)
    ) {
      work.abort.abort();
      bound.inFlight = null;
    }
    if (told !== "sent") this.dropHeld(bound);
    if (state.failed && state.failed !== before?.failed) {
      this.diagnose({ stage: "cast-failed", reason: state.failed.why });
      // The code is the one the clients know; the text says what is true of this cast.
      this.onError?.(
        new BrowserRuntimeError(
          "internal",
          `The picture of the page was given up: ${state.failed.why}.`,
          { reason: "browser-capture-mismatch" },
        ),
      );
      if (this.bound !== bound) return;
    }
    const facts = this.readFacts();
    const step = nextStep(facts, bound.binding, state, this.session(bound.cdp));
    this.keepRendering(bound, facts);
    this.keepTimers(bound, step);
    const waiting = step.kind === "wait" ? step.why : null;
    if (waiting !== bound.waiting) {
      bound.waiting = waiting;
      if (waiting !== null) this.diagnose({ stage: "cast-held", reason: waiting });
    }
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
    const bound = this.bound;
    if (this.passing || bound?.inFlight) return;
    // A restart's stop is with Chromium and its start is still to come; a stop while nothing is
    // wanted (a pause, a page under a dialog) is waited on by no one.
    if (bound && this.session(bound.cdp).stops > 0 && wanted(this.readFacts()).kind === "cast")
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
      const step = nextStep(
        this.readFacts(),
        bound?.binding ?? null,
        bound?.state ?? null,
        bound ? this.session(bound.cdp) : initialSessionCastState,
      );
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

  /** A pass with nothing to do now: a page under a dialog shows its last picture. */
  private rest(step: Extract<Step, { kind: "idle" | "wait" }>): void {
    const bound = this.bound;
    if (bound && step.kind === "wait" && step.why === "a dialog is open")
      this.showRetainedPicture(bound);
  }

  private async take(step: Exclude<Step, { kind: "idle" | "wait" }>): Promise<void> {
    if (step.kind === "bind") {
      this.rebind();
      return;
    }
    const bound = this.bound;
    if (!bound) return;
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
      case "fail":
        // Given up: `reconcile` records it and says so.
        this.stopCast(bound, step.why, false, step.why);
        return;
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
    if (this.closed) {
      this.reconcile(null, null);
      return;
    }
    const binding = this.surfaceId ? this.ledger.binding(this.surfaceId) : this.ledger.active();
    if (!binding) {
      this.reconcile(null, null);
      return;
    }
    const session = this.sessions.get(binding.cdp);
    const onFrame = (parameters: unknown) => this.onFrame(bound, parameters);
    const onEnded = () => {
      // The session's stops end with its casts, whichever tab is bound (S1).
      this.applySession(binding.cdp, { kind: "casts-ended" });
      if (this.bound !== bound) return;
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
      firstFrameTimer: null,
      held: null,
      id: binding.surface.id,
      inFlight: null,
      page: binding.page,
      pageScale: 1,
      paintDelay: paintRetryInitialMs,
      paintTimer: null,
      releaseRendering: null,
      startWhy: "bind",
      state: initialTabCastState(),
      unbind: () => {
        offNavigations();
        offCapture();
        binding.cdp.off("Page.screencastFrame", onFrame);
        binding.cdp.off(screencastEndedEvent, onEnded);
      },
      waiting: null,
    };
    this.bound = bound;
    this.claimStopTimeouts(bound);
  }

  /** Charges any stop timeouts recorded on `bound.cdp` while it was unbound to `bound` (U4). */
  private claimStopTimeouts(bound: Bound): void {
    const count = this.session(bound.cdp).timedOut;
    if (count === 0) return;
    this.applySession(bound.cdp, { kind: "timed-out-taken" });
    if (this.bound === bound) this.apply(bound, { count, kind: "stop-timed-out" });
  }

  /** Lets go of a tab's listeners, its rendering and its timers, its start given up. */
  private release(bound: Bound): void {
    bound.inFlight?.abort.abort();
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
    if (bound.held !== null) acknowledgeFrame(bound.cdp, bound.held.parameters);
    bound.held = null;
  }

  /**
   * Stops what the tab was told. A start being prepared is given up before it reaches Chromium; a
   * start sent, or a cast running, is stopped without waiting (a page under a dialog answers
   * nothing else, and Chromium takes a session's commands in order), and its session holds the
   * stop until it is answered.
   */
  private stopCast(bound: Bound, why: string, retry: boolean, givenUp?: string): void {
    if (stopReachesChromium(bound.state.told)) {
      if (bound.state.told.state === "sent" && bound.inFlight?.kind === "start")
        bound.inFlight.stopSent = true;
      this.sendStop(bound, why);
    }
    this.apply(bound, { kind: "stopped", retry, ...(givenUp === undefined ? {} : { givenUp }) });
    bound.startWhy = why;
  }

  private sendStop(bound: Bound, why: string): void {
    const cdp = bound.cdp;
    const generation = this.session(cdp).generation;
    this.applySession(cdp, { kind: "stop-sent" }, bound.id);
    this.diagnose({ stage: "cast-stop", reason: why, surfaceId: bound.id });
    void this.ledger
      .use(bound.id, () => cdp.send("Page.stopScreencast"))
      .catch(() => undefined)
      .finally(() => {
        this.applySession(cdp, { generation, kind: "stop-answered" });
        this.requestPass();
      });
  }

  /** Keeps the tab drawing while it is streamed, except while its paint is waited out. */
  private keepRendering(bound: Bound, facts: CastFacts): void {
    // A pause ends a paint wait, and the next stream starts its backoff afresh.
    if (!facts.streaming || facts.closed) bound.paintDelay = paintRetryInitialMs;
    const keep = facts.streaming && !facts.closed && !bound.state.paint;
    if (keep) bound.releaseRendering ??= bound.cdp.retainRendering?.() ?? null;
    else {
      bound.releaseRendering?.();
      bound.releaseRendering = null;
    }
  }

  /**
   * The timers follow the state and the plan: a paint backoff while one is recorded, and the time
   * the plan gives the running cast for a picture while its step waits on one. Any other step (a
   * hold, a pause, a stop, another tab) clears that timer; it only says the time is up, and
   * `after` decides.
   */
  private keepTimers(bound: Bound, step: Step): void {
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
          this.apply(bound, {
            binding: bound.binding,
            kind: "first-frame-timeout",
            session: this.session(bound.cdp),
          });
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
   * The time each session's stop is given for its answer (S3, U4), armed while one is with
   * Chromium and cleared by `reconcile` once none is, its generation is settled, or closed.
   */
  private keepStopTimers(focus?: CdpSession, surfaceId?: BrowserSurfaceId): void {
    for (const [cdp, armed] of this.stopTimers) {
      const session = this.session(cdp);
      if (this.closed || session.stops === 0 || armed.generation !== session.generation) {
        clearTimeout(armed.timer);
        this.stopTimers.delete(cdp);
      }
    }
    if (!focus || this.closed) return;
    const session = this.session(focus);
    if (session.stops === 0 || this.stopTimers.has(focus)) return;
    const generation = session.generation;
    const timedOutSurface = surfaceId ?? (this.bound?.cdp === focus ? this.bound.id : undefined);
    const timer = setTimeout(() => {
      if (this.stopTimers.get(focus)?.timer !== timer) return;
      this.stopTimers.delete(focus);
      this.diagnose({
        stage: "cast-stop-timeout",
        durationMs: stopAnswerWaitMs,
        surfaceId: timedOutSurface,
      });
      this.applySession(focus, { generation, kind: "stop-timed-out" });
      if (this.bound?.cdp === focus) this.claimStopTimeouts(this.bound);
      this.requestPass();
    }, stopAnswerWaitMs);
    timer.unref();
    this.stopTimers.set(focus, { generation, timer });
  }

  /**
   * Prepares and sends a start: the page's paint first, then, inside the page's geometry lock, a
   * look at the facts as they are (a start the plan would no longer make is not sent), and the
   * start. Resolves once its first command to Chromium is handed off, or it came to nothing: the
   * pass waits for no answer, and goes on to wait on it as a fact.
   */
  private beginStart(bound: Bound): Promise<void> {
    this.apply(bound, { kind: "start-begun" });
    const abort = new AbortController();
    const work: NonNullable<Bound["inFlight"]> = { abort, kind: "start" };
    bound.inFlight = work;
    const handedOff = Promise.withResolvers<void>();
    const signal = AbortSignal.any([this.lifecycle.signal, abort.signal]);
    const current = () => bound.inFlight?.abort === abort && this.bound === bound;
    const why = bound.startWhy;
    /** The cast the plan would start now, and the facts that bear on it, if still to be sent. */
    const stillWanted = (): { readonly key: CastKey; readonly at: StartFacts } | null => {
      if (signal.aborted || !current()) return null;
      const facts = this.readFacts();
      const key = startStillWanted(facts, bound.binding, bound.state, this.session(bound.cdp));
      return key && facts.tab ? { at: startFacts(facts.tab), key } : null;
    };
    let cdpSent: StartFacts | null = null;
    const send = async (): Promise<"answered" | "not-now"> => {
      const first = stillWanted();
      if (!first) return "not-now";
      // Chromium takes a session's commands in order: from here the start waits on Chromium.
      handedOff.resolve();
      if (first.key.sizesView) {
        cdpSent = first.at;
        await bound.cdp.send("Emulation.setVisibleSize", {
          height: first.key.size.height,
          width: first.key.size.width,
        });
      }
      // The facts may have moved while Chromium sized the view: a dialog, a new size.
      const now = stillWanted();
      if (!now || fits(first.key, now.key) !== "same") return "not-now";
      this.diagnose({
        stage: "cast-start",
        reason: why,
        castId: ++this.castId,
        geometryRevision: now.key.geometryRevision,
        ...(now.key.captureRevision === null ? {} : { captureRevision: now.key.captureRevision }),
      });
      this.apply(bound, { at: now.at, key: now.key, kind: "sent" });
      await bound.cdp.send("Page.startScreencast", {
        everyNthFrame: 1,
        format: "jpeg",
        maxHeight: now.key.raster.height,
        maxWidth: now.key.raster.width,
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
          if (!current()) {
            // U2: no cast runs that the state does not know. A start that still answers after the
            // state abandoned it without sending a stop (e.g. casts-ended) is stopped through the
            // session state so stops are counted once.
            if (outcome === "answered" && !work.stopSent && !this.aborted) {
              if (this.bound?.cdp === bound.cdp && stopReachesChromium(this.bound.state.told))
                this.stopCast(this.bound, "abandoned start answered", false);
              else this.sendStop(bound, "abandoned start answered");
            }
            return;
          }
          bound.inFlight = null;
          if (outcome === "answered") {
            // The frame that came with the start is judged now that it runs, as of when it came.
            const held = bound.held;
            bound.held = null;
            this.apply(bound, { kind: "answered" });
            bound.paintDelay = paintRetryInitialMs;
            if (held !== null) this.onFrame(bound, held.parameters, held.document);
          } else this.apply(bound, { kind: "not-sent" });
        },
        (error: unknown) => {
          if (!current()) return;
          bound.inFlight = null;
          if (signal.aborted) {
            this.apply(bound, { kind: "not-sent" });
            return;
          }
          if (error instanceof BrowserPaintTimeoutError) {
            this.apply(bound, { kind: "paint-timed-out" });
            bound.startWhy = "paint-retry";
            this.diagnose({ stage: "cast-paint-timeout" });
            this.showRetainedPicture(bound);
            return;
          }
          this.startFailed(bound, error, cdpSent);
        },
      )
      .finally(() => {
        handedOff.resolve();
        this.requestPass();
      });
    return handedOff.promise;
  }

  /**
   * A start that failed. Sent (or a CDP preparation command that failed during a navigation, U5),
   * it is Chromium's refusal, held until a fact that bears on it differs from when it was sent,
   * and one outside any navigation is told to the caller whose change led to it. Failed before it
   * was sent outside navigation (S2), it is an attempt with no picture: the pass tries again under
   * the same bound. The tab stays bound either way.
   */
  private startFailed(bound: Bound, error: unknown, at: StartFacts | null = null): void {
    const sent = bound.state.told.state === "sent";
    const why = error instanceof Error ? error.message : String(error);
    this.apply(bound, { ...(at ? { at } : {}), kind: "start-failed", why });
    const refusal = bound.state.refusal;
    if (!sent && !refusal) {
      bound.startWhy = "a start that could not be made";
      this.diagnose({ stage: "cast-not-made", reason: why });
      return;
    }
    bound.startWhy = "refusal released";
    const facts = this.readFacts();
    const tab = facts.tab?.binding === bound.binding ? facts.tab : null;
    const navigating = !!tab && !!refusal && refusedInNavigation(tab, refusal);
    this.diagnose({ stage: navigating ? "cast-deferred" : "cast-refused", reason: why });
    if (!navigating) this.failure = error;
  }

  /** Stops the cast and asks the page to draw its surface again; the pass then starts it. */
  private beginRepair(bound: Bound, step: Extract<Step, { kind: "repair" }>): void {
    const why = step.why;
    if (stopReachesChromium(bound.state.told)) {
      if (bound.state.told.state === "sent" && bound.inFlight?.kind === "start")
        bound.inFlight.stopSent = true;
      this.sendStop(bound, why);
    }
    this.apply(bound, { kind: "repair-begun", retry: step.retry });
    bound.startWhy = why;
    const abort = new AbortController();
    bound.inFlight = { abort, kind: "repair" };
    this.diagnose({ stage: "cast-repair", reason: `${bound.state.unpictured}` });
    void (bound.page.invalidateSurface?.() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        if (bound.inFlight?.abort !== abort || this.bound !== bound) return;
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
    if (this.bound !== bound || this.closed) {
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
      this.session(bound.cdp),
      { document, geometry: event.geometry, raster },
      facts,
    );
    switch (verdict) {
      case "held":
        // A frame that comes with a start, of what it asked for, is its picture: it waits for
        // the answer.
        this.dropHeld(bound);
        bound.held = { document, parameters };
        this.diagnose({ stage: "capture-held" });
        return;
      case "show":
      case "restamp-show": {
        const told = bound.state.told;
        const want = wanted(facts);
        if (told.state !== "running" || !raster || want.kind !== "cast") break;
        // A frame of the new document is pictured as it, with the revision it committed at.
        const key = verdict === "restamp-show" ? restamped(told.key, want.key) : told.key;
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
