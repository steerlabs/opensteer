import { z } from "zod";
import { browserFrameFits } from "@opensteer/browser-core";
import type {
  BrowserCaptureDescriptor,
  BrowserDialog,
  BrowserSurfaceId,
} from "@opensteer/protocol/browser";
import { BrowserRuntimeError } from "../errors.js";
import type { LatestFrameStream } from "../stream/latest-frame-stream.js";
import { rasterShowsSize, readImageDimensions } from "../stream/frame.js";
import { BrowserPaintTimeoutError, type CdpSession, type PageCapture } from "./backend.js";
import {
  fits,
  initialTabCastState,
  nextStep,
  canTakeStart,
  refusalReleased,
  sameSize,
  wanted,
  type CastFacts,
  type CastKey,
  type Refusal,
  type Step,
  type TabCastState,
  type Told,
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
/**
 * How long a start whose only frame was of another size waits for its own (F30): a page whose view
 * is not at that size sends no other, and is repaired then.
 */
const ownFrameWaitMs = 1_000;
/** Steps one pass may take before it is quiet: more is a loop between steps, and it stops. */
const passStepLimit = 24;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface CdpScreencastFrame {
  geometry: PageSize | null;
  /** How far Chromium zooms the page into the picture, as for a mobile page with no viewport. */
  pageScale: number;
  data: string;
}

/** A start, or a repair, under way for a bound tab. */
interface Attempt {
  readonly abandon: AbortController;
}

/** The tab the follow view is bound to, and what it told Chromium there. */
interface Bound {
  readonly id: BrowserSurfaceId;
  readonly binding: string;
  readonly cdp: CdpSession;
  readonly page: SurfaceBinding["page"];
  readonly state: Mutable<TabCastState>;
  /** The latest frame that came with the start in flight, of what it asked for: not yet acked. */
  held: unknown;
  attempt: Attempt | null;
  /** The page zoom of the latest picture shown, which input on it undoes. */
  pageScale: number;
  paintDelay: number;
  releaseRendering: (() => void) | null;
  /** The last wait recorded, so each is recorded once. */
  waiting: string | null;
  /** Ends a paint wait. */
  paintTimer: ReturnType<typeof setTimeout> | null;
  /** Ends the wait for a start's own frame after one of another size. */
  ownFrameTimer: ReturnType<typeof setTimeout> | null;
  /** A frame of another size came with the start in flight. */
  otherSizeWithStart: boolean;
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
 * streaming, raster demand, a capture or navigation change, a frame, a timer) only asks for a
 * pass. A pass reads the facts afresh, compares them with what Chromium was told and what was
 * shown, and takes one step (`nextStep`), until nothing is left to do or what is left waits on a
 * fact it names.
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
      this.bound.state.refusal = null;
      this.bound.state.failedFor = null;
      if (this.bound.state.told.state === "none") this.bound.state.startWhy = "subscribe";
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
      const bound = this.bound;
      if (bound && !bound.page.capture && bound.state.told.state === "running") {
        bound.state.shown = false;
        bound.state.redraw = true;
      }
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

  /** Resolves once a pass is quiet: no step under way, and no start of the bound tab in flight. */
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
    if (this.passing || this.bound?.attempt) return;
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
      // A release seen is a release had, whatever is wanted now.
      if (
        bound?.state.refusal &&
        facts.tab?.binding === bound.binding &&
        refusalReleased(facts.tab, bound.state.refusal)
      )
        bound.state.refusal = null;
      const step = nextStep(facts, bound?.binding ?? null, bound?.state ?? null);
      this.keepRendering(facts);
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
    const state = bound.state;
    switch (step.kind) {
      case "stop":
        this.stopCast(bound, step.why);
        return;
      case "restart":
        this.stopCast(bound, step.why);
        return;
      case "restamp": {
        const told = state.told;
        if (told.state !== "running") return;
        state.told = {
          key: { ...told.key, document: step.document, geometryRevision: step.geometryRevision },
          state: "running",
        };
        // A frame set aside before is still a picture missed: the count stays.
        state.shown = false;
        this.diagnose({ stage: "cast-kept", geometryRevision: step.geometryRevision });
        return;
      }
      case "start":
        await this.untilChanged(this.beginStart(bound, step.why));
        return;
      case "repair":
        await this.untilChanged(this.beginRepair(bound));
        return;
      case "fail": {
        const told = state.told;
        this.stopCast(bound, step.why);
        if (told.state === "running") state.failedFor = told.key;
        this.diagnose({ stage: "cast-failed", reason: step.why });
        this.onError?.(
          new BrowserRuntimeError(
            "internal",
            "The browser capture does not match its declared region.",
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
      this.stopCast(previous, "the tab left");
      this.release(previous);
    }
    if (this.closed) return;
    const binding = this.surfaceId ? this.ledger.binding(this.surfaceId) : this.ledger.active();
    if (!binding) return;
    const session = this.sessions.get(binding.cdp);
    const onFrame = (parameters: unknown) => this.onFrame(bound, parameters);
    const offNavigations =
      binding.page.navigations?.subscribe(() => this.requestPass()) ?? (() => undefined);
    const offCapture =
      binding.page.capture?.subscribe(() => this.requestPass()) ?? (() => undefined);
    binding.cdp.on("Page.screencastFrame", onFrame);
    const bound: Bound = {
      attempt: null,
      binding: `${binding.surface.id}#${String(session)}`,
      cdp: binding.cdp,
      held: null,
      id: binding.surface.id,
      page: binding.page,
      pageScale: 1,
      paintDelay: paintRetryInitialMs,
      paintTimer: null,
      ownFrameTimer: null,
      otherSizeWithStart: false,
      releaseRendering: null,
      state: { ...initialTabCastState },
      unbind: () => {
        offNavigations();
        offCapture();
        binding.cdp.off("Page.screencastFrame", onFrame);
      },
      waiting: null,
    };
    this.bound = bound;
  }

  /** Lets go of a tab's listeners and its rendering, its start given up. */
  private release(bound: Bound): void {
    bound.attempt?.abandon.abort();
    bound.attempt = null;
    if (bound.held !== null) acknowledgeFrame(bound.cdp, bound.held);
    bound.held = null;
    bound.releaseRendering?.();
    bound.releaseRendering = null;
    this.endPaintWait(bound);
    this.endOwnFrameWait(bound);
    bound.unbind();
  }

  /**
   * Stops what the tab was told. A start being prepared is given up before it reaches Chromium; a
   * start sent, or a cast running, is stopped without waiting (a page under a dialog answers
   * nothing else, and Chromium takes a session's commands in order).
   */
  private stopCast(bound: Bound, why: string): void {
    const state = bound.state;
    const told = state.told;
    bound.attempt?.abandon.abort();
    bound.attempt = null;
    if (told.state === "sent" || told.state === "running") {
      void this.ledger
        .use(bound.id, () => bound.cdp.send("Page.stopScreencast"))
        .catch(() => undefined);
      this.diagnose({ stage: "cast-stop", reason: why });
    }
    if (bound.held !== null) acknowledgeFrame(bound.cdp, bound.held);
    bound.held = null;
    state.told = { state: "none" };
    state.shown = false;
    state.setAside = 0;
    state.misfit = false;
    state.startWhy = why;
    this.endOwnFrameWait(bound);
  }

  private endOwnFrameWait(bound: Bound): void {
    if (bound.ownFrameTimer) clearTimeout(bound.ownFrameTimer);
    bound.ownFrameTimer = null;
    bound.otherSizeWithStart = false;
    bound.state.otherSizeFirst = false;
  }

  /**
   * Keeps the tab drawing while it is streamed, except while its paint is waited out; a pause
   * ends that wait, and the next stream starts its backoff afresh.
   */
  private keepRendering(facts: CastFacts): void {
    const bound = this.bound;
    if (!bound) return;
    if (!facts.streaming || facts.closed) {
      this.endPaintWait(bound);
      bound.paintDelay = paintRetryInitialMs;
    }
    const keep = facts.streaming && !facts.closed && !bound.state.paint;
    if (keep) bound.releaseRendering ??= bound.cdp.retainRendering?.() ?? null;
    else {
      bound.releaseRendering?.();
      bound.releaseRendering = null;
    }
  }

  private endPaintWait(bound: Bound): void {
    if (bound.paintTimer) clearTimeout(bound.paintTimer);
    bound.paintTimer = null;
    bound.state.paint = null;
  }

  /**
   * Prepares and sends a start: the page's paint first, then, inside the page's geometry lock, a
   * look at the facts as they are (a start the facts no longer want is not sent), and the start.
   * Resolves once the start is sent, or came to nothing: the pass waits for no answer, and goes
   * on to wait on it as a fact.
   */
  private beginStart(bound: Bound, why: string): Promise<void> {
    const attempt: Attempt = { abandon: new AbortController() };
    const handedOff = Promise.withResolvers<void>();
    bound.attempt = attempt;
    bound.state.told = { state: "preparing" };
    const signal = AbortSignal.any([this.lifecycle.signal, attempt.abandon.signal]);
    const current = () => bound.attempt === attempt && this.bound === bound;
    let sentAt: Refusal | null = null;
    const send = async (): Promise<"answered" | "not-now"> => {
      if (signal.aborted || !current()) return "not-now";
      const facts = this.readFacts();
      const want = wanted(facts);
      if (
        facts.tab?.binding !== bound.binding ||
        want.kind !== "cast" ||
        !canTakeStart(facts.tab, bound.state.refusal).ok
      )
        return "not-now";
      const key = want.key;
      // Chromium takes a session's commands in order: from here the start waits on Chromium.
      handedOff.resolve();
      if (key.sizesView) {
        await bound.cdp.send("Emulation.setVisibleSize", {
          height: key.size.height,
          width: key.size.width,
        });
        if (signal.aborted || !current()) return "not-now";
      }
      const castId = ++this.castId;
      sentAt = {
        document: facts.tab.document,
        finished: facts.tab.navigation?.finished ?? null,
        loading: facts.tab.loading,
        why: "",
      };
      this.diagnose({
        stage: "cast-start",
        reason: why,
        castId,
        geometryRevision: key.geometryRevision,
        ...(key.captureRevision === null ? {} : { captureRevision: key.captureRevision }),
      });
      bound.held = null;
      bound.otherSizeWithStart = false;
      bound.state.told = { key, state: "sent" };
      const answer = bound.cdp.send("Page.startScreencast", {
        everyNthFrame: 1,
        format: "jpeg",
        maxHeight: key.raster.height,
        maxWidth: key.raster.width,
        quality: this.frameQuality,
      });
      handedOff.resolve();
      await answer;
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
          bound.attempt = null;
          const state = bound.state;
          const told = state.told;
          if (outcome === "answered" && told.state === "sent") {
            state.told = { key: told.key, state: "running" };
            state.refusal = null;
            this.endPaintWait(bound);
            bound.paintDelay = paintRetryInitialMs;
            const held = bound.held;
            bound.held = null;
            if (held !== null) this.onFrame(bound, held);
            else if (bound.otherSizeWithStart && !state.shown) {
              // Only a frame of another size came with it: its own gets a time, then a repair.
              state.otherSizeFirst = true;
              const timer = setTimeout(() => {
                if (bound.ownFrameTimer !== timer) return;
                bound.ownFrameTimer = null;
                if (state.otherSizeFirst && !state.shown) {
                  state.otherSizeFirst = false;
                  state.misfit = true;
                }
                this.requestPass();
              }, ownFrameWaitMs);
              timer.unref();
              bound.ownFrameTimer = timer;
            }
          } else {
            state.told = { state: "none" };
            if (bound.held !== null) acknowledgeFrame(bound.cdp, bound.held);
            bound.held = null;
          }
        },
        (error: unknown) => {
          if (!current()) return;
          bound.attempt = null;
          const state = bound.state;
          state.told = { state: "none" };
          if (bound.held !== null) acknowledgeFrame(bound.cdp, bound.held);
          bound.held = null;
          if (signal.aborted) return;
          if (error instanceof BrowserPaintTimeoutError) {
            const want = wanted(this.readFacts());
            if (want.kind === "cast") {
              const paint = {
                captureRevision: want.key.captureRevision,
                geometryRevision: want.key.geometryRevision,
                size: want.key.size,
              };
              state.paint = paint;
              const timer = setTimeout(() => {
                if (bound.paintTimer !== timer) return;
                bound.paintTimer = null;
                if (state.paint === paint) state.paint = null;
                this.requestPass();
              }, bound.paintDelay);
              timer.unref();
              bound.paintTimer = timer;
            }
            bound.paintDelay = Math.min(bound.paintDelay * 2, paintRetryMaxMs);
            state.startWhy = "paint-retry";
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
   * Records what the page could not take a start for, from what it was when the start was sent:
   * the next start waits for a fact that bears on it. A refusal outside any navigation is told to
   * the caller whose change led to it; the tab stays bound either way.
   */
  private refused(bound: Bound, error: unknown, sentAt: Refusal | null): void {
    const facts = this.readFacts();
    const tab = facts.tab?.binding === bound.binding ? facts.tab : null;
    const why = error instanceof Error ? error.message : String(error);
    const at = sentAt ?? {
      document: tab?.document ?? null,
      finished: tab?.navigation?.finished ?? null,
      loading: tab?.loading ?? false,
      why,
    };
    bound.state.refusal = { ...at, why };
    bound.state.startWhy = "refusal released";
    const navigating =
      !!tab &&
      (at.loading ||
        tab.loading ||
        tab.navigation?.pending === true ||
        tab.document !== at.document ||
        (tab.navigation?.finished ?? 0) !== (at.finished ?? 0));
    this.diagnose({ stage: navigating ? "cast-deferred" : "cast-refused", reason: why });
    if (!navigating) this.failure = error;
  }

  /** Stops the cast, asks the page to draw its surface again, then lets the pass start it. */
  private beginRepair(bound: Bound): Promise<void> {
    const state = bound.state;
    // A frame that did not fit counts against the cast; a view a closed tab may have moved does not.
    const byFrame = state.misfit;
    const why = state.redraw && !byFrame ? "a tab closed" : "raster-mismatch";
    this.stopCast(bound, why);
    state.redraw = false;
    if (byFrame) {
      if (bound.page.capture) state.repaired = true;
      state.unpictured += 1;
    }
    const attempt: Attempt = { abandon: new AbortController() };
    bound.attempt = attempt;
    state.told = { state: "preparing" };
    this.diagnose({ stage: "cast-repair", reason: `${state.unpictured}` });
    return (bound.page.invalidateSurface?.() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        if (bound.attempt !== attempt || this.bound !== bound) return;
        bound.attempt = null;
        state.told = { state: "none" };
      })
      .finally(() => this.requestPass());
  }

  private onFrame(bound: Bound, parameters: unknown): void {
    const session = screencastSessionSchema.safeParse(parameters);
    if (!session.success) return;
    const event = parseScreencastFrame(parameters);
    if (!event) {
      this.diagnose({ stage: "capture-discard", reason: "Invalid screencast metadata." });
      acknowledgeFrame(bound.cdp, parameters);
      return;
    }
    const told = bound.state.told;
    if (this.bound !== bound || this.closed) {
      acknowledgeFrame(bound.cdp, parameters);
      return;
    }
    if (told.state === "sent") {
      // A frame that comes with a start, of what that start asked for, is its picture: it waits
      // for the answer.
      if (this.streaming && fitsRegion(event.geometry, told.key.region)) {
        if (bound.held !== null) acknowledgeFrame(bound.cdp, bound.held);
        bound.held = parameters;
        this.diagnose({ stage: "capture-held" });
        return;
      }
      // One of another size, on a page the follow view sized itself before this start, shows the
      // view is not at that size: it asks for a repair. Elsewhere it is what the page last drew
      // before it was shown, and the start's own frames follow it.
      if (told.key.sizesView) this.misfit(bound, `viewport ${describe(event.geometry)}`, told.key);
      else bound.otherSizeWithStart = true;
      acknowledgeFrame(bound.cdp, parameters);
      return;
    }
    if (told.state !== "running") {
      acknowledgeFrame(bound.cdp, parameters);
      return;
    }
    try {
      this.judge(bound, told, event);
    } catch (error) {
      this.diagnose({
        stage: "capture-discard",
        reason: error instanceof Error ? error.message : "Undecodable browser frame.",
      });
    } finally {
      acknowledgeFrame(bound.cdp, parameters);
    }
  }

  /** Shows a frame of the running cast, or sets it aside: a pass then decides what that asks for. */
  private judge(
    bound: Bound,
    told: Extract<Told, { state: "running" }>,
    event: CdpScreencastFrame,
  ): void {
    const state = bound.state;
    const facts = this.readFacts();
    const want = wanted(facts);
    let key = told.key;
    const fit =
      want.kind === "cast" && facts.tab?.binding === bound.binding ? fits(key, want.key) : false;
    if (!fit || want.kind !== "cast") {
      state.setAside += 1;
      this.requestPass();
      return;
    }
    if (fit === "new-document") {
      key = { ...key, document: want.key.document, geometryRevision: want.key.geometryRevision };
      state.told = { key, state: "running" };
      state.shown = false;
      this.diagnose({ stage: "cast-kept", geometryRevision: key.geometryRevision });
    }
    // Chromium can deliver a picture of another size than the page's: one made before the latest
    // resize, or the window's, when Chrome put the view back at that size as another tab closed.
    // The frame's device size is the whole viewport, a scrollbar included; one pixel more is the
    // desktop app redrawing a page that sat undrawn.
    if (!fitsRegion(event.geometry, key.region)) {
      this.misfit(bound, `viewport ${describe(event.geometry)}`, key);
      return;
    }
    const received = performance.now();
    const data = Buffer.from(event.data, "base64");
    const raster = readImageDimensions(data, "jpeg");
    if (!raster || !browserFrameFits(raster.width, raster.height)) {
      throw new BrowserRuntimeError("internal", "Chromium returned an invalid browser frame.");
    }
    // Chromium can also label such a picture with the page's size; its shape gives it away.
    if (
      !rasterShowsSize(raster, key.region) ||
      (key.expectedRaster &&
        (Math.abs(raster.width - key.expectedRaster.width) > 1 ||
          Math.abs(raster.height - key.expectedRaster.height) > 1))
    ) {
      this.misfit(bound, `raster ${raster.width}x${raster.height}`, key);
      return;
    }
    state.shown = true;
    state.misfit = false;
    this.endOwnFrameWait(bound);
    state.setAside = 0;
    state.unpictured = 0;
    state.repaired = false;
    bound.pageScale = event.pageScale;
    this.ledger.recordPageScale(bound.id, event.pageScale);
    const capture = key.captureRevision === null ? undefined : this.captureOf(bound, key);
    this.lastPictures.set(bound.id, {
      capture,
      data,
      geometry: key.size,
      raster,
      revision: key.geometryRevision,
    });
    this.enqueueFrame(bound.id, data, raster, key.size, key.geometryRevision, capture);
    this.diagnose({
      stage: "capture-admit",
      frameId: this.frameId,
      bytes: data.byteLength,
      durationMs: performance.now() - received,
      geometryRevision: key.geometryRevision,
    });
  }

  private captureOf(bound: Bound, key: CastKey): BrowserCaptureDescriptor | undefined {
    const capture = bound.page.capture?.read();
    return capture && capture.revision === key.captureRevision
      ? captureDescriptor(capture)
      : undefined;
  }

  /** A frame that does not picture the region it was cast for: the next pass repairs the view. */
  private misfit(bound: Bound, what: string, key: CastKey): void {
    this.diagnose({
      stage: "capture-discard",
      reason: `${what}, expected ${key.region.width}x${key.region.height}`,
    });
    // The view is not at the size it is cast at, whatever was shown before.
    bound.state.misfit = true;
    bound.state.shown = false;
    this.requestPass();
  }

  private enqueueFrame(
    surfaceId: BrowserSurfaceId,
    data: Buffer,
    parsed: PageSize,
    geometry: PageSize,
    revision: number,
    capture?: BrowserCaptureDescriptor,
  ): void {
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
      return;
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

/** Whether a frame of `geometry` pictures `region`, within the pixel a scrollbar can add. */
function fitsRegion(geometry: PageSize | null, region: PageSize): boolean {
  return (
    !!geometry &&
    Math.abs(geometry.width - region.width) <= 1 &&
    Math.abs(geometry.height - region.height) <= 1
  );
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
