import { PhoneDisplayDecoder } from "../phone-display-media.js";
import type { BrowserVideoFrame } from "@opensteer/client/host";
import { browserVideoFrameView } from "@opensteer/client/host/browser-video";
import type {
  BrowserFrameStore,
  BrowserFrameView,
  BrowserRasterDemand,
} from "@opensteer/client/host";
import {
  browserFrameContentRect,
  browserFrameCornerRadii,
  browserRasterDensity,
} from "@opensteer/shared/browserPresentation";
import { observeResize } from "@opensteer/shared/resizeObserver";

interface CanvasTarget {
  readonly allowUpscale: boolean;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly source: BrowserFrameStore;
  readonly presented: (frame: BrowserFrameView) => void;
  readonly demand: BrowserRasterDemand | null;
  active: boolean;
}
interface Picture {
  readonly frame: BrowserFrameView;
  readonly key: string;
  readonly received: number;
  readonly receipts: Map<string, () => void>;
}
interface PresentationDiagnostic {
  readonly stage: "decode" | "draw" | "discard" | "failure";
  readonly frameId: number;
  readonly bytes: number;
  readonly durationMs: number;
}
const scopes = new WeakMap<object, Map<string, BrowserPicturePresenter>>();
const drawn = new WeakMap<HTMLCanvasElement, BrowserFrameView>();
const bindings = new WeakMap<
  HTMLCanvasElement,
  {
    readonly scope: object;
    readonly surfaceId: string;
    readonly invalidation: string | number | undefined;
  }
>();
export interface BrowserCanvasOptions {
  readonly acceleration?: HardwareAcceleration;
  readonly preservePixels?: boolean;
  /** Inactive presenters observe authorization only, without decoding or frame credit. */
  readonly active?: boolean;
}
export const browserPicturePresentedEvent = "browser-picture-presented";
export function drawnBrowserFrame(canvas: HTMLCanvasElement | null): BrowserFrameView | null {
  return canvas ? (drawn.get(canvas) ?? null) : null;
}

/** Retained by exact authorised client/session/target, shared by Control and Watch. */
export function attachBrowserCanvas(
  source: BrowserFrameStore,
  sessionId: string,
  surfaceId: string,
  targeted: boolean,
  canvas: HTMLCanvasElement,
  presented: (frame: BrowserFrameView) => void,
  allowUpscale = false,
  options: BrowserCanvasOptions = {},
): () => void {
  if (source.video?.selected())
    return attachBrowserVideoCanvas(
      source,
      sessionId,
      surfaceId,
      canvas,
      presented,
      allowUpscale,
      options,
    );
  const scope = source.scope ?? source;
  let targets = scopes.get(scope);
  if (!targets) {
    targets = new Map();
    scopes.set(scope, targets);
  }
  const key = JSON.stringify([sessionId, surfaceId]);
  let presenter = targets.get(key);
  if (!presenter) {
    presenter = new BrowserPicturePresenter(surfaceId);
    targets.set(key, presenter);
  }
  const detach = presenter.attach(
    source,
    sessionId,
    targeted,
    canvas,
    presented,
    allowUpscale,
    options,
  );
  const current = presenter;
  return () => {
    detach();
    // React can replace a canvas in the same turn. Keep the in-flight decode
    // through that handoff, then release the bitmap if demand really ended.
    queueMicrotask(() => {
      if (!current.size && targets.get(key) === current) {
        current.dispose();
        targets.delete(key);
      }
    });
  };
}

class BrowserPicturePresenter {
  readonly #surfaceId: string;
  readonly #targets = new Set<CanvasTarget>();
  readonly diagnostics: PresentationDiagnostic[] = [];
  #decoding: Picture | null = null;
  #pending: Picture | null = null;
  #current: { picture: Picture; bitmap: ImageBitmap } | null = null;
  #scheduled: number | null = null;
  #ready: { picture: Picture; bitmap: ImageBitmap } | null = null;
  #disposed = false;
  #generation = 0;
  #revision = -1;
  #captureRevision = -1;
  #latestId = -1;
  constructor(surfaceId: string) {
    this.#surfaceId = surfaceId;
  }
  get size(): number {
    return this.#targets.size;
  }

  attach(
    source: BrowserFrameStore,
    sessionId: string,
    targeted: boolean,
    canvas: HTMLCanvasElement,
    presented: (frame: BrowserFrameView) => void,
    allowUpscale: boolean,
    options: BrowserCanvasOptions,
  ): () => void {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      const discard = () => {
        const frame = source.get(sessionId, targeted ? this.#surfaceId : undefined);
        if (frame?.header.watchToken)
          source.accept?.(
            sessionId,
            targeted ? this.#surfaceId : undefined,
            frame.header.watchToken,
          );
      };
      const unsubscribe = source.subscribe(
        sessionId,
        discard,
        targeted ? this.#surfaceId : undefined,
      );
      discard();
      return unsubscribe;
    }
    let reported: BrowserFrameView | null = null;
    const target: CanvasTarget = {
      allowUpscale,
      canvas,
      context,
      source,
      presented: (frame) => {
        reported = frame;
        presented(frame);
      },
      demand:
        targeted && options.active !== false
          ? (source.rasterDemand?.(sessionId, this.#surfaceId) ?? null)
          : null,
      active: true,
    };
    this.#targets.add(target);
    const read = () => {
      const binding = {
        scope: source.scope ?? source,
        surfaceId: this.#surfaceId,
        invalidation: source.invalidationKey?.(sessionId, this.#surfaceId),
      };
      const previous = bindings.get(canvas);
      const invalidated =
        previous &&
        (previous.scope !== binding.scope ||
          previous.surfaceId !== binding.surfaceId ||
          previous.invalidation !== binding.invalidation);
      bindings.set(canvas, binding);
      if (invalidated) {
        drawn.delete(canvas);
        layoutBrowserCanvas(canvas, null);
        context.clearRect(0, 0, canvas.width, canvas.height);
        canvas.dispatchEvent(new Event(browserPicturePresentedEvent, { bubbles: true }));
        this.#invalidate();
      }
      if (options.active === false) {
        target.active = false;
        return;
      }
      const frame = source.get(sessionId, targeted ? this.#surfaceId : undefined);
      const token = frame?.header.watchToken;
      if (token) source.claim?.(sessionId, targeted ? this.#surfaceId : undefined, token);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (token) source.accept?.(sessionId, targeted ? this.#surfaceId : undefined, token);
      };
      target.active = frame?.header.surfaceId === this.#surfaceId;
      if (!target.active || !frame) {
        if (!options.preservePixels) {
          drawn.delete(canvas);
          layoutBrowserCanvas(canvas, null);
          context.clearRect(0, 0, canvas.width, canvas.height);
          canvas.dispatchEvent(new Event(browserPicturePresentedEvent, { bubbles: true }));
        }
        settle();
        if (![...this.#targets].some((entry) => entry.active)) this.#invalidate();
        return;
      }
      this.#receive(frame, token ? `${targeted ? "target" : "legacy"}:${token}` : "", settle);
      if (this.#current && pictureKey(frame) === this.#current.picture.key) {
        this.#draw(target, this.#current);
        // A replay of the picture already drawn is this delivery's picture too.
        if (drawn.get(canvas) && reported !== frame) {
          reported = frame;
          presented(frame);
        }
      }
    };
    const unsubscribe = source.subscribe(sessionId, read, targeted ? this.#surfaceId : undefined);
    const relayout = () => {
      const frame = drawn.get(canvas);
      if (frame) layoutBrowserCanvas(canvas, frame, target.allowUpscale, target.demand);
    };
    const stopResize = observeResize([canvas.parentElement ?? canvas], relayout);
    const stopDensity = target.demand ? observeDevicePixelRatio(relayout) : () => undefined;
    read();
    return () => {
      unsubscribe();
      stopResize();
      stopDensity();
      target.demand?.release();
      this.#targets.delete(target);
      if (!options.preservePixels) {
        drawn.delete(canvas);
        bindings.delete(canvas);
        layoutBrowserCanvas(canvas, null);
      }
      // This subscription deliberately discards every receipt it still owns.
      const frame = source.get(sessionId, targeted ? this.#surfaceId : undefined);
      if (frame?.header.watchToken)
        source.accept?.(sessionId, targeted ? this.#surfaceId : undefined, frame.header.watchToken);
      canvas.dispatchEvent(new Event(browserPicturePresentedEvent, { bubbles: true }));
    };
  }

  #receive(frame: BrowserFrameView, receiptKey: string, settle: () => void): void {
    const revision = frame.header.geometryRevision ?? 0;
    const captureRevision = frame.header.capture?.revision ?? -1;
    if (
      (revision === this.#revision && captureRevision < this.#captureRevision) ||
      revision < this.#revision ||
      (revision === this.#revision && frame.header.frameId < this.#latestId)
    ) {
      settle();
      return;
    }
    if (revision > this.#revision || captureRevision > this.#captureRevision) {
      this.#revision = revision;
      this.#captureRevision = captureRevision;
      if (this.#pending) this.#settle(this.#pending);
      this.#pending = null;
    }
    const key = pictureKey(frame);
    const matching = [this.#decoding, this.#pending, this.#current?.picture].find(
      (picture) => picture?.key === key,
    );
    if (matching) {
      if (this.#current?.picture === matching) settle();
      else matching.receipts.set(receiptKey, settle);
      return;
    }
    this.#latestId = frame.header.frameId;
    const picture: Picture = {
      frame,
      key,
      received: performance.now(),
      receipts: new Map([[receiptKey, settle]]),
    };
    if (this.#pending) {
      this.#diagnose("discard", this.#pending, 0);
      this.#settle(this.#pending);
    }
    this.#pending = picture;
    this.#decode();
  }

  #decode(): void {
    if (this.#disposed || this.#decoding || this.#scheduled !== null || !this.#pending) return;
    const picture = this.#pending;
    const generation = this.#generation;
    this.#pending = null;
    this.#decoding = picture;
    const started = performance.now();
    const bytes =
      picture.frame.data instanceof Uint8Array
        ? picture.frame.data
        : new Uint8Array(picture.frame.data);
    void Promise.resolve()
      .then(() =>
        createImageBitmap(new Blob([bytes], { type: `image/${picture.frame.header.encoding}` })),
      )
      .then(
        (bitmap) => {
          this.#diagnose("decode", picture, performance.now() - started);
          if (
            this.#disposed ||
            generation !== this.#generation ||
            (picture.frame.header.geometryRevision !== undefined &&
              picture.frame.header.geometryRevision !== this.#revision) ||
            (picture.frame.header.capture?.revision ?? -1) !== this.#captureRevision ||
            bitmap.width !== picture.frame.header.rasterWidth ||
            bitmap.height !== picture.frame.header.rasterHeight
          ) {
            bitmap.close();
            this.#settle(picture);
            if (this.#decoding === picture) this.#decoding = null;
            this.#decode();
            return;
          }
          this.#ready = { picture, bitmap };
          // Finish this same-geometry picture even if newer bytes arrived, avoiding starvation.
          this.#scheduled = requestAnimationFrame(() => {
            this.#scheduled = null;
            this.#ready = null;
            if (
              this.#disposed ||
              generation !== this.#generation ||
              (picture.frame.header.geometryRevision ?? 0) !== this.#revision ||
              (picture.frame.header.capture?.revision ?? -1) !== this.#captureRevision
            ) {
              bitmap.close();
              this.#settle(picture);
            } else {
              const previous = this.#current;
              const current = { picture, bitmap };
              this.#current = current;
              for (const target of this.#targets)
                if (target.active && !this.#disposed) this.#draw(target, current);
              this.#settle(picture);
              previous?.bitmap.close();
            }
            if (this.#decoding === picture) this.#decoding = null;
            this.#decode();
          });
        },
        () => {
          this.#diagnose("failure", picture, performance.now() - started);
          this.#settle(picture);
          if (this.#decoding === picture) this.#decoding = null;
          this.#decode();
        },
      );
  }

  #draw(target: CanvasTarget, current: { picture: Picture; bitmap: ImageBitmap }): void {
    const { canvas, context } = target;
    const { frame } = current.picture;
    const previous = drawn.get(canvas);
    if (previous && pictureKey(previous) === current.picture.key) return;
    const started = performance.now();
    try {
      if (canvas.width !== current.bitmap.width) canvas.width = current.bitmap.width;
      if (canvas.height !== current.bitmap.height) canvas.height = current.bitmap.height;
      context.drawImage(current.bitmap, 0, 0);
      layoutBrowserCanvas(canvas, frame, target.allowUpscale, target.demand);
      drawn.set(canvas, frame);
      target.presented(frame);
      canvas.dispatchEvent(new Event(browserPicturePresentedEvent, { bubbles: true }));
      this.#diagnose("draw", current.picture, performance.now() - started);
    } catch {
      drawn.delete(canvas);
      this.#diagnose("failure", current.picture, performance.now() - started);
    }
  }
  #settle(picture: Picture): void {
    for (const settle of picture.receipts.values()) settle();
    picture.receipts.clear();
  }
  #diagnose(stage: PresentationDiagnostic["stage"], picture: Picture, durationMs: number): void {
    if (this.diagnostics.length === 256) this.diagnostics.shift();
    this.diagnostics.push({
      stage,
      frameId: picture.frame.header.frameId,
      bytes: picture.frame.data.byteLength,
      durationMs,
    });
    performance.measure(`browser.picture.${stage}`, {
      start: performance.now() - durationMs,
      end: performance.now(),
      detail: {
        frameId: picture.frame.header.frameId,
        geometryRevision: picture.frame.header.geometryRevision,
        bytes: picture.frame.data.byteLength,
        creditAgeMs: performance.now() - picture.received,
      },
    });
    // User Timing is a bounded diagnostic buffer, not a history of page activity.
    performance.clearMeasures(`browser.picture.${stage}`);
  }
  #invalidate(): void {
    this.#generation++;
    if (this.#ready) {
      if (this.#scheduled !== null) cancelAnimationFrame(this.#scheduled);
      this.#scheduled = null;
      this.#ready.bitmap.close();
      this.#settle(this.#ready.picture);
      this.#ready = null;
      this.#decoding = null;
    }
    if (this.#decoding) this.#settle(this.#decoding);
    this.#decoding = null;
    this.#current?.bitmap.close();
    this.#current = null;
    if (this.#pending) this.#settle(this.#pending);
    this.#pending = null;
    this.#revision = -1;
    this.#captureRevision = -1;
    this.#latestId = -1;
  }
  dispose(): void {
    this.#disposed = true;
    this.#invalidate();
    // A scheduled callback owns its bitmap and closes it even after disposal.
  }
}

/** Calls back whenever this display's device pixel ratio changes, such as moving to another screen. */
function observeDevicePixelRatio(changed: () => void): () => void {
  let query: MediaQueryList | null = null;
  const listen = () => {
    query?.removeEventListener("change", onChange);
    query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    query.addEventListener("change", onChange);
  };
  const onChange = () => {
    listen();
    changed();
  };
  listen();
  return () => query?.removeEventListener("change", onChange);
}

function layoutBrowserCanvas(
  canvas: HTMLCanvasElement,
  frame: BrowserFrameView | null,
  allowUpscale = false,
  demand: BrowserRasterDemand | null = null,
): void {
  const stage = canvas.parentElement;
  if (!stage) return;
  if (!frame) {
    delete stage.dataset.croppedRight;
    delete stage.dataset.croppedBottom;
    for (const key of ["left", "top", "width", "height", "aspect"])
      stage.style.removeProperty(`--browser-frame-${key}`);
    stage.style.removeProperty("--browser-region-radius");
    return;
  }
  const { header } = frame;
  const region = header.capture ?? { width: header.rasterWidth, height: header.rasterHeight };
  stage.style.setProperty("--browser-frame-aspect", `${region.width} / ${region.height}`);
  stage.dataset.croppedRight = String(region.width < header.viewportWidth && !!header.capture);
  stage.dataset.croppedBottom = String(region.height < header.viewportHeight && !!header.capture);
  const box = { left: 0, top: 0, width: stage.clientWidth, height: stage.clientHeight };
  const rect = browserFrameContentRect(
    box,
    header.rasterWidth,
    header.rasterHeight,
    header.capture,
    "top",
    allowUpscale,
  );
  if (!rect) return;
  for (const [key, value] of Object.entries(rect))
    stage.style.setProperty(`--browser-frame-${key}`, `${value}px`);
  stage.style.setProperty(
    "--browser-region-radius",
    browserFrameCornerRadii(box, rect)
      .map((radius) => `${radius}px`)
      .join(" "),
  );
  // The page is laid out in CSS pixels; ask for enough raster to fill what is shown.
  demand?.update(
    browserRasterDensity(
      rect.width,
      header.capture?.width ?? header.viewportWidth,
      devicePixelRatio,
    ),
  );
}

function pictureKey(frame: BrowserFrameView): string {
  const h = frame.header;
  return JSON.stringify([
    h.surfaceId,
    h.geometryRevision,
    h.capture,
    h.frameId,
    h.encoding,
    h.rasterWidth,
    h.rasterHeight,
  ]);
}

/** H.264 has its own presented record; input never reads last-received or React metadata. */
const videoDecoderStats = new WeakMap<HTMLCanvasElement, PhoneDisplayDecoder["stats"]>();
export function browserVideoDecoderStats(canvas: HTMLCanvasElement) {
  return videoDecoderStats.get(canvas) ?? null;
}
const drawnVideo = new WeakMap<
  HTMLCanvasElement,
  {
    header: import("@opensteer/protocol").BrowserVideoFrameHeader;
    rect: { left: number; top: number; width: number; height: number };
  }
>();
export function sampleBrowserVideo(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const shown = drawnVideo.get(canvas);
  if (!shown) return null;
  const { header } = shown;
  const rect = canvas.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    clientX < rect.left ||
    clientY < rect.top ||
    clientX >= rect.right ||
    clientY >= rect.bottom
  )
    return null;
  if (
    rect.left !== shown.rect.left ||
    rect.top !== shown.rect.top ||
    rect.width !== shown.rect.width ||
    rect.height !== shown.rect.height
  )
    return null;
  const crop = header.presentation.rasterCrop;
  return {
    header,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    point: {
      x: crop.x + ((clientX - rect.left) * crop.width) / rect.width,
      y: crop.y + ((clientY - rect.top) * crop.height) / rect.height,
    },
  };
}
function attachBrowserVideoCanvas(
  source: BrowserFrameStore,
  sessionId: string,
  surfaceId: string,
  canvas: HTMLCanvasElement,
  presented: (frame: BrowserFrameView) => void,
  allowUpscale: boolean,
  options: BrowserCanvasOptions,
): () => void {
  const video = source.video!;
  let disposed = false;
  let recoveries = 0;
  let decoder: PhoneDisplayDecoder<BrowserVideoFrame> | null = null;
  let waiting: BrowserVideoFrame[] = [];
  let latest: { picture: VideoFrame; frame: BrowserVideoFrame } | null = null;
  let scheduled: number | null = null;
  const clear = () => {
    decoder?.reset();
    latest?.picture.close();
    latest = null;
    for (const frame of waiting) frame.done();
    waiting = [];
    drawnVideo.delete(canvas);
    drawn.delete(canvas);
    if (scheduled !== null) cancelAnimationFrame(scheduled);
    scheduled = null;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  };
  const draw = () => {
    scheduled = null;
    if (disposed || !latest) return;
    const { header } = latest.frame;
    const crop = header.presentation.rasterCrop;
    canvas.width = crop.width;
    canvas.height = crop.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    context.drawImage(
      latest.picture,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    );
    const view = browserVideoFrameView(surfaceId, header);
    // Canvas pixels and their input identity change in this same synchronous operation.
    layoutBrowserCanvas(canvas, view, allowUpscale);
    const stage = canvas.parentElement;
    if (stage)
      video.budget(
        sessionId,
        surfaceId,
        stage.clientWidth * devicePixelRatio,
        stage.clientHeight * devicePixelRatio,
      );
    const rect = canvas.getBoundingClientRect();
    drawnVideo.set(canvas, {
      header,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    });
    drawn.set(canvas, view);
    recoveries = 0;
    video.presented(sessionId, surfaceId, header);
    presented(view);
    canvas.dispatchEvent(new Event(browserPicturePresentedEvent, { bubbles: true }));
  };
  const unframe = video.onFrame(sessionId, surfaceId, (frame) => {
    if (disposed || options.active === false) {
      frame.done();
      return;
    }
    if (decoder) decoder.push(frame);
    else if (waiting.length < 4) waiting.push(frame);
    else {
      frame.done();
      for (const pending of waiting) pending.done();
      waiting = [];
      video.keyframe(sessionId, surfaceId);
    }
  });
  const unstate = source.subscribe(
    sessionId,
    () => {
      const state = video.state(sessionId, surfaceId);
      if (state?.state === "stopped" || state?.state === "failed") clear();
    },
    surfaceId,
  );
  // Browser hardware decoders can buffer a lone AU despite optimizeForLatency.
  // Select a low-delay decoder before admission; never feed fake wake-up frames.
  const selected = options.acceleration ?? "prefer-software";
  const supported =
    typeof VideoDecoder === "undefined"
      ? Promise.resolve(null)
      : VideoDecoder.isConfigSupported({
          codec: "avc1.42C01F",
          hardwareAcceleration: selected,
          optimizeForLatency: true,
        }).then(
          (result) => (result.supported ? selected : null),
          () => null,
        );
  void supported.then((acceleration) => {
    if (disposed) return;
    if (acceleration === null) {
      clear();
      video.failed(sessionId, surfaceId, "unsupported");
      return;
    }
    decoder = new PhoneDisplayDecoder<BrowserVideoFrame>({
      acceleration,
      onLost: () => {
        if (++recoveries >= 3) {
          clear();
          video.failed(sessionId, surfaceId, "decoder");
        } else video.keyframe(sessionId, surfaceId);
      },
      onPicture: (picture, frame) => {
        if (disposed || frame.replayed) {
          picture.close();
          return;
        }
        latest?.picture.close();
        latest = { picture, frame };
        scheduled ??= requestAnimationFrame(draw);
      },
    });
    videoDecoderStats.set(canvas, decoder.stats);
    for (const frame of waiting) decoder.push(frame);
    waiting = [];
  });
  const resize = observeResize([canvas.parentElement ?? canvas], () => {
    if (latest) scheduled ??= requestAnimationFrame(draw);
  });
  return () => {
    disposed = true;
    unframe();
    unstate();
    resize();
    clear();
    decoder?.close();
  };
}
