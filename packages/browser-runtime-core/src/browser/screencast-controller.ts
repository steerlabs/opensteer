import { z } from "zod";
import { browserFrameFits, browserFrameLimits } from "@opensteer/browser-core";
import type {
  BrowserCaptureDescriptor,
  BrowserDialog,
  BrowserSurfaceId,
} from "@opensteer/protocol/browser";
import { AsyncMutex } from "../async.js";
import { BrowserRuntimeError } from "../errors.js";
import type { LatestFrameStream } from "../stream/latest-frame-stream.js";
import { rasterShowsSize, readImageDimensions } from "../stream/frame.js";
import type { CdpSession, PageCapture } from "./backend.js";
import type {
  PageSize,
  SurfaceBinding,
  SurfaceLedger,
  SurfaceLedgerEvent,
} from "./surface-ledger.js";

interface CdpScreencastFrame {
  data: string;
  geometry: PageSize | null;
  /** How far Chromium zooms the page into the picture, as for a mobile page with no viewport. */
  pageScale: number;
  sessionId: number;
}

interface ActiveCast {
  capture: PageCapture | null;
  castAbort: AbortController | null;
  castId: number;
  unsubscribeCapture: (() => void) | null;
  restartQueued: boolean;
  repairAttempted: boolean;
  releaseRendering: (() => void) | null;
  geometryRevision: number;
  raster: PageSize | null;
  casting: boolean;
  awaitingNavigation: boolean;
  cdp: CdpSession;
  /** The page zoom of the latest picture shown, which input on it undoes. */
  pageScale: number;
  onFrame: (parameters: unknown) => void;
  /** A repair of the view is queued and has not started. */
  repairQueued: boolean;
  surfaceId: BrowserSurfaceId;
}

interface ScreencastControllerOptions {
  surfaceId?: BrowserSurfaceId;
  frameQuality?: number;
  frames: LatestFrameStream;
  ledger: SurfaceLedger;
  onDialogChanged(dialog: BrowserDialog | null): void;
  onError?(error: BrowserRuntimeError): void;
}

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
    if (this.active) record.surfaceId = this.active.surfaceId;
    if (this.diagnostics.length === 256) this.diagnostics.shift();
    this.diagnostics.push(record);
    if (process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1")
      console.info(JSON.stringify({ browserCapture: true, ...record }));
  }
  private readonly surfaceId: BrowserSurfaceId | undefined;
  private active: ActiveCast | null = null;
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
  private readonly mutex = new AsyncMutex();
  /** The page the latest surface list sent to viewers shows. */
  private shownToViewers: BrowserSurfaceId | null = null;
  private readonly onDialogChanged: (dialog: BrowserDialog | null) => void;
  private streaming = false;
  private captureRegions = false;
  private rasterDemand = 2;
  private unsupportedCapture: number | null = null;
  private readonly onError: ScreencastControllerOptions["onError"];
  private unsubscribe: (() => void) | null = null;

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
    if (this.active) this.showRetainedPicture(this.active);
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
    await this.rebind(false);
    if (this.surfaceId) this.publishDialog();
  }

  /**
   * Starts or pauses the picture of the page already bound. Pausing keeps the
   * page bound, so a dialog open there stays the person's to answer. Neither
   * waits for Chromium to stop: a page under a dialog answers nothing else.
   */
  setStreaming(streaming: boolean, captureRegions = this.captureRegions): Promise<void> {
    this.captureRegions = captureRegions;
    if (this.closed) throw new BrowserRuntimeError("conflict", "The browser stream is closed.");
    if (this.streaming === streaming) return Promise.resolve();
    const previous = this.streaming;
    this.streaming = streaming;
    if (!streaming) this.active?.castAbort?.abort();
    return this.mutex.run(async () => {
      const active = this.active;
      if (this.closed || !active) return;
      if (this.streaming) active.releaseRendering ??= active.cdp.retainRendering?.() ?? null;
      else {
        active.releaseRendering?.();
        active.releaseRendering = null;
      }
      if (active.casting === this.streaming) return;
      if (!this.streaming) {
        active.casting = false;
        void active.cdp.send("Page.stopScreencast").catch(() => undefined);
        return;
      }
      try {
        await this.castActive(active, "subscribe");
      } catch (error) {
        if (this.streaming === streaming) this.streaming = previous;
        if (!this.streaming) {
          active.releaseRendering?.();
          active.releaseRendering = null;
        }
        throw error;
      }
    });
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
    const active = this.active;
    if (!active || active.surfaceId !== surfaceId) return null;
    const binding = this.ledger.binding(surfaceId);
    const geometry = this.ledger.viewportOf(surfaceId);
    const port = binding?.page.capture;
    const capture = port?.read();
    if (
      port &&
      (!capture ||
        (captureRevision === undefined
          ? !sameSize(capture, geometry)
          : !active.capture ||
            capture.revision !== active.capture.revision ||
            captureRevision !== capture.revision ||
            geometryRevision !== active.geometryRevision) ||
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
      x: (x * (capture?.width ?? geometry.width)) / active.pageScale,
      y: (y * (capture?.height ?? geometry.height)) / active.pageScale,
    };
  }

  /** Changes capture resolution without changing the surface's input geometry. */
  setRasterDemand(density: 0.75 | 1 | 1.25 | 1.5 | 2): Promise<void> {
    if (this.closed) throw new BrowserRuntimeError("conflict", "The browser stream is closed.");
    if (this.rasterDemand === density) return Promise.resolve();
    this.rasterDemand = density;
    this.active?.castAbort?.abort();
    return this.mutex.run(async () => {
      const active = this.active;
      if (this.closed || !active || !this.streaming) return;
      active.castAbort?.abort();
      if (active.casting) {
        active.casting = false;
        void active.cdp.send("Page.stopScreencast").catch(() => undefined);
      }
      await this.castActive(active, "raster-demand");
    });
  }

  /**
   * Shows a page's new size after a write changed it. Each page has its own
   * size, so a write to a page the viewer is not watching changes nothing here.
   */
  viewportChanged(surfaceId: BrowserSurfaceId): Promise<void> {
    const queued = this.active;
    if (!queued || queued.restartQueued) return Promise.resolve();
    queued.restartQueued = true;
    return this.mutex.run(async () => {
      queued.restartQueued = false;
      const active = this.active;
      if (
        !active ||
        active !== queued ||
        active.surfaceId !== surfaceId ||
        !this.streaming ||
        (active.casting &&
          active.geometryRevision === this.ledger.binding(surfaceId)?.surface.geometryRevision &&
          active.capture?.revision ===
            this.ledger.binding(surfaceId)?.page.capture?.read()?.revision)
      )
        return;
      if (!active.casting) {
        await this.castActive(active, "geometry");
        return;
      }
      // Chromium can apply device metrics without producing another frame for
      // an otherwise static page, and the raster bound follows the size.
      // Restarting the cast does both, so the viewer never stays on old pixels.
      active.casting = false;
      // Chromium takes a session's commands in order, so the stop lands before
      // the start without waiting on a page that may not answer.
      void active.cdp.send("Page.stopScreencast").catch(() => undefined);
      await this.castActive(active, "geometry");
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.abort();
    this.active?.castAbort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frames.close();
    this.lastPictures.clear();
    await this.mutex.run(async () => this.stopActive());
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
    this.releaseActive();
  }

  private handleLedgerEvent(event: SurfaceLedgerEvent): void {
    if (event.type === "closed") {
      this.abort();
      return;
    }
    if (event.type === "dialog-event" || event.type === "geometry") return;
    const binding = this.surfaceId ? this.ledger.binding(this.surfaceId) : this.ledger.active();
    if (this.active && this.active.surfaceId !== binding?.surface.id)
      this.active.castAbort?.abort();
    if (event.type === "resized") {
      void this.viewportChanged(event.surfaceId).catch(() => undefined);
      return;
    }
    if (
      event.type === "changed" &&
      this.active?.surfaceId === event.surface.id &&
      this.active.castAbort &&
      event.surface.loading
    )
      this.active.awaitingNavigation = true;
    // Published as the event arrives, before the surface list that follows
    // it, so a viewer never shows one page's dialog over another page.
    this.publishDialog();
    if (
      event.type === "changed" &&
      event.change !== "closed" &&
      this.active?.surfaceId === event.surface.id &&
      (this.active.geometryRevision !== event.surface.geometryRevision ||
        (this.active.awaitingNavigation && !event.surface.loading))
    ) {
      // Navigation can replace the only pending picture before its geometry
      // notice lands; a fresh cast guarantees a frame for the new document.
      void this.viewportChanged(event.surface.id).catch(() => undefined);
    }
    if (event.type === "dialog") {
      const active = this.active;
      if (active?.surfaceId === event.surfaceId && !this.ledger.dialogOpen(event.surfaceId)) {
        void this.mutex
          .run(() => this.castActive(active, "dialog-recovery"))
          .catch(() => undefined);
      }
      return;
    }
    if (event.type === "changed" && event.change === "closed") {
      this.lastPictures.delete(event.surface.id);
    }
    if (event.type === "snapshot") {
      for (const surfaceId of this.lastPictures.keys()) {
        if (!event.surfaces.some((surface) => surface.id === surfaceId)) {
          this.lastPictures.delete(surfaceId);
        }
      }
    }
    if (
      event.type === "snapshot" ||
      event.surface.id === this.surfaceId ||
      event.surface.active ||
      event.change === "closed"
    ) {
      void this.rebind(false).catch(() => undefined);
    }
    // When a tab closes, headless Chrome shows the tab that remains at its
    // window's size again, whichever of the two the person was watching.
    if (
      event.type === "changed" &&
      event.change === "closed" &&
      this.active &&
      !this.ledger.binding(this.active.surfaceId)?.page.capture
    ) {
      this.resizeView(this.active);
    }
  }

  private rebind(force: boolean): Promise<void> {
    return this.mutex.run(async () => {
      if (this.closed) return;
      const binding = this.surfaceId ? this.ledger.binding(this.surfaceId) : this.ledger.active();
      if (!force && binding && this.active?.surfaceId === binding.surface.id) return;
      this.stopActive();
      if (!binding || this.closed) return;
      await this.startActive(binding);
    });
  }

  private async startActive(binding: SurfaceBinding): Promise<void> {
    const active: ActiveCast = {
      releaseRendering: this.streaming ? (binding.cdp.retainRendering?.() ?? null) : null,
      geometryRevision: -1,
      capture: null,
      castAbort: null,
      castId: 0,
      unsubscribeCapture: null,
      restartQueued: false,
      repairAttempted: false,
      raster: null,
      casting: false,
      awaitingNavigation: false,
      cdp: binding.cdp,
      pageScale: 1,
      onFrame: (parameters) => {
        void this.handleFrame(binding.surface.id, binding.cdp, parameters).catch(
          (error: unknown) => {
            if (this.closed || this.active !== active || !active.casting) return;
            this.diagnose({
              stage: "capture-discard",
              reason: error instanceof Error ? error.message : "Undecodable browser frame.",
            });
          },
        );
      },
      repairQueued: false,
      surfaceId: binding.surface.id,
    };
    this.active = active;
    active.unsubscribeCapture =
      binding.page.capture?.subscribe(() => {
        if (this.active !== active) return;
        active.castAbort?.abort();
        void this.viewportChanged(active.surfaceId).catch((error: unknown) => {
          if (this.closed || !this.streaming || this.active !== active) return;
          const failure =
            error instanceof BrowserRuntimeError
              ? error
              : new BrowserRuntimeError("internal", "The browser capture could not be updated.", {
                  cause: error,
                });
          this.diagnose({
            stage: "capture-update-error",
            castId: active.castId,
            ...(active.capture ? { captureRevision: active.capture.revision } : {}),
            geometryRevision: active.geometryRevision,
            reason: error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
          this.onError?.(failure);
        });
      }) ?? null;
    binding.cdp.on("Page.screencastFrame", active.onFrame);
    try {
      // The ledger enabled Page on this session when it registered the page.
      await this.castActive(active, "rebind");
    } catch (error) {
      if (this.active === active) this.stopActive();
      throw error;
    }
  }

  /** Unbinds the page. Its stop is not awaited: a page under a dialog answers nothing else. */
  private stopActive(): void {
    const active = this.releaseActive();
    if (active?.casting) void active.cdp.send("Page.stopScreencast").catch(() => undefined);
  }

  private releaseActive(): ActiveCast | null {
    const active = this.active;
    this.active = null;
    if (!active) return null;
    active.castAbort?.abort();
    active.unsubscribeCapture?.();
    active.releaseRendering?.();
    active.releaseRendering = null;
    active.cdp.off("Page.screencastFrame", active.onFrame);
    return active;
  }

  private async handleFrame(
    surfaceId: BrowserSurfaceId,
    source: CdpSession,
    parameters: unknown,
  ): Promise<void> {
    const session = screencastSessionSchema.safeParse(parameters);
    if (!session.success) return;
    try {
      const event = parseScreencastFrame(parameters);
      if (!event) {
        this.diagnose({ stage: "capture-discard", reason: "Invalid screencast metadata." });
        return;
      }
      const active = this.active;
      if (
        !this.streaming ||
        !active?.casting ||
        active.surfaceId !== surfaceId ||
        active.cdp !== source
      )
        return;
      const port = this.ledger.binding(surfaceId)?.page.capture;
      if (port && (!active.capture || port.read()?.revision !== active.capture.revision)) return;
      // A bounds change can paint at the new CSS size before its old cast
      // has restarted with the new raster bound. Those pixels still belong
      // to the previous geometry, even when their aspect ratio now matches.
      if (active.geometryRevision !== this.ledger.binding(surfaceId)?.surface.geometryRevision)
        return;
      const geometry = this.ledger.viewportOf(surfaceId);
      if (!geometry) return;
      const region = active.capture ?? geometry;
      // Chromium can deliver a picture of another size than the page's: one
      // made before the latest resize, or the window's, when Chrome put the
      // view back at that size as another tab closed. Old pixels never get new
      // input geometry, and a page with nothing new to draw may send no other
      // picture, so each such picture asks for the view to be sized again. The
      // frame's device size is the whole viewport, a scrollbar included; one
      // pixel more is the desktop app redrawing a page that sat undrawn.
      if (!event.geometry) return;
      if (
        Math.abs(event.geometry.width - region.width) > 1 ||
        Math.abs(event.geometry.height - region.height) > 1
      ) {
        this.diagnose({
          stage: "capture-discard",
          reason: `viewport ${event.geometry.width}x${event.geometry.height}, expected ${geometry.width}x${geometry.height}`,
        });
        this.resizeView(active);
        return;
      }
      const received = performance.now();
      const data = Buffer.from(event.data, "base64");
      const raster = readImageDimensions(data, "jpeg");
      if (!raster || !browserFrameFits(raster.width, raster.height)) {
        throw new BrowserRuntimeError("internal", "Chromium returned an invalid browser frame.");
      }
      // Chromium can also label such a picture with the page's size; its
      // shape gives it away.
      if (
        !rasterShowsSize(raster, region) ||
        (active.raster &&
          (Math.abs(raster.width - active.raster.width) > 1 ||
            Math.abs(raster.height - active.raster.height) > 1))
      ) {
        this.diagnose({
          stage: "capture-discard",
          reason: `raster ${raster.width}x${raster.height}, expected ${active.raster?.width}x${active.raster?.height} for ${geometry.width}x${geometry.height}`,
        });
        this.resizeView(active);
        return;
      }
      active.repairAttempted = false;
      active.pageScale = event.pageScale;
      this.ledger.recordPageScale(surfaceId, event.pageScale);
      this.lastPictures.set(surfaceId, {
        data,
        geometry,
        raster,
        revision: active.geometryRevision,
        capture: active.capture ? captureDescriptor(active.capture) : undefined,
      });
      this.enqueueFrame(
        surfaceId,
        data,
        raster,
        geometry,
        active.geometryRevision,
        active.capture ? captureDescriptor(active.capture) : undefined,
      );
      this.diagnose({
        stage: "capture-admit",
        frameId: this.frameId,
        bytes: data.byteLength,
        durationMs: performance.now() - received,
        geometryRevision: active.geometryRevision,
      });
    } finally {
      await source
        .send("Page.screencastFrameAck", { sessionId: session.data.sessionId })
        .catch(() => undefined);
    }
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
   * Starts picturing the bound page while the person streams it. A page under
   * a JavaScript dialog answers no command until the dialog closes, so its
   * cast starts then and the stream never waits on it. Runs under the mutex.
   */
  private async castActive(active: ActiveCast, reason: string): Promise<void> {
    if (this.closed || this.active !== active || !this.streaming || active.casting) return;
    if (this.ledger.dialogOpen(active.surfaceId)) {
      this.showRetainedPicture(active);
      return;
    }
    const page = this.ledger.binding(active.surfaceId)?.page;
    if (page?.capture && !page.capture.read()) return;
    active.awaitingNavigation = false;
    const castAbort = new AbortController();
    active.castAbort = castAbort;
    active.castId = ++this.castId;
    const canceled = AbortSignal.any([this.lifecycle.signal, castAbort.signal]);
    try {
      try {
        if (page?.settleRendering) await page.settleRendering(canceled);
      } catch (error) {
        if (canceled.aborted) return;
        throw error;
      }
      if (this.closed || this.active !== active || !this.streaming || canceled.aborted) return;
      const start = async () => {
        if (canceled.aborted || this.closed || this.active !== active || !this.streaming) return;
        const size = this.ledger.viewportOf(active.surfaceId);
        if (!size) return;
        const capture = page?.capture?.read() ?? null;
        if (
          page?.capture &&
          (!capture || capture.width > size.width || capture.height > size.height)
        )
          return;
        const surface = this.ledger.binding(active.surfaceId)?.surface;
        const documentId = surface?.documentId;
        active.awaitingNavigation = surface?.loading === true;
        active.capture = capture;
        active.geometryRevision =
          this.ledger.binding(active.surfaceId)?.surface.geometryRevision ?? 0;
        const region = capture ?? size;
        const raster = screencastRaster(
          region,
          Math.min(this.rasterDemand, capture?.rasterScale ?? 2),
        );
        this.diagnose({
          stage: "cast-start",
          reason,
          geometryRevision: active.geometryRevision,
          castId: active.castId,
          ...(capture ? { captureRevision: capture.revision } : {}),
        });
        try {
          // CDP aspect-fits within these integer limits. Rounding the limiting
          // edge can shorten the other edge by several pixels on tall pages.
          const scale = Math.min(raster.width / region.width, raster.height / region.height);
          active.raster = capture
            ? {
                width: Math.max(1, Math.floor(region.width * scale)),
                height: Math.max(1, Math.floor(region.height * scale)),
              }
            : null;
          if (!capture && !page?.applyGeometry) {
            active.casting = true;
            await active.cdp.send("Emulation.setVisibleSize", {
              height: size.height,
              width: size.width,
            });
          }
          await active.cdp.send("Page.startScreencast", {
            everyNthFrame: 1,
            format: "jpeg",
            maxHeight: raster.height,
            maxWidth: raster.width,
            quality: this.frameQuality,
          });
          active.casting = !page?.capture || page.capture.read()?.revision === capture?.revision;
          active.awaitingNavigation = false;
        } catch (error) {
          active.casting = false;
          const surface = this.ledger.binding(active.surfaceId)?.surface;
          if (
            surface &&
            (active.awaitingNavigation || surface.loading || surface.documentId !== documentId)
          ) {
            // Navigation can retire the renderer while its cast starts.
            // Keep demand until a document commits or its navigation stops.
            active.awaitingNavigation = true;
            this.diagnose({
              stage: "cast-deferred",
              reason: "navigation",
              castId: active.castId,
              geometryRevision: active.geometryRevision,
            });
            return;
          }
          throw error;
        }
      };
      if (page?.capture) await this.ledger.withGeometry(active.surfaceId, start);
      else await start();
    } catch (error) {
      if (canceled.aborted || this.active !== active || active.castAbort !== castAbort) return;
      throw error;
    } finally {
      if (active.castAbort === castAbort) active.castAbort = null;
    }
  }

  /**
   * Shows the bound page's latest picture again while its dialog keeps it
   * from drawing. Viewers take a picture only of the page a list told them
   * is shown, and input reaches only the page the stream is bound to, so it
   * waits for both: the list or the binding, whichever comes last, sends it.
   */
  private showRetainedPicture(active: ActiveCast): void {
    if (this.closed || !this.streaming || this.active !== active) return;
    if (
      (!this.surfaceId && active.surfaceId !== this.shownToViewers) ||
      !this.ledger.dialogOpen(active.surfaceId)
    ) {
      return;
    }
    const last = this.lastPictures.get(active.surfaceId);
    const size = this.ledger.viewportOf(active.surfaceId);
    if (
      last &&
      size &&
      sameSize(last.geometry, size) &&
      last.revision === (this.ledger.binding(active.surfaceId)?.surface.geometryRevision ?? 0)
    ) {
      this.enqueueFrame(
        active.surfaceId,
        last.data,
        last.raster,
        last.geometry,
        last.revision,
        last.capture,
      );
    }
  }

  /**
   * Chromium can reattach a surviving native view at the window size after
   * another tab closes, independently of its emulated layout. No CDP event
   * reports that compositor change: the frame's dimensions reveal it. A
   * repair reconciles declared engine geometry and restarts the cast. Native
   * discrepancies get one repair; a persistent mismatch is a capture error. Requests made
   * while one is queued join it; the repair takes its request before sending
   * anything, so a picture that still mismatches once it has started, even
   * before Chromium answers its start, asks for the next one.
   */
  private resizeView(active: ActiveCast): void {
    if (active.repairQueued) return;
    const native = !!this.ledger.binding(active.surfaceId)?.page.capture;
    if (native && active.repairAttempted) {
      active.casting = false;
      void active.cdp.send("Page.stopScreencast").catch(() => undefined);
      this.onError?.(
        new BrowserRuntimeError(
          "internal",
          "The browser capture does not match its declared region.",
          {
            reason: "browser-capture-mismatch",
          },
        ),
      );
      return;
    }
    if (native) active.repairAttempted = true;
    active.repairQueued = true;
    void this.mutex
      .run(async () => {
        active.repairQueued = false;
        if (
          this.closed ||
          this.active !== active ||
          !this.streaming ||
          !active.casting ||
          !this.ledger.viewportOf(active.surfaceId)
        ) {
          return;
        }
        active.casting = false;
        void active.cdp.send("Page.stopScreencast").catch(() => undefined);
        const page = this.ledger.binding(active.surfaceId)?.page;
        if (page?.invalidateSurface) await page.invalidateSurface();
        await this.castActive(active, "raster-mismatch");
      })
      .catch(() => undefined);
  }
}

function sameSize(left: PageSize, right: PageSize | null): boolean {
  return left.width === right?.width && left.height === right.height;
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
  const { data, sessionId, metadata } = parsed.data;
  return {
    data,
    sessionId,
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
