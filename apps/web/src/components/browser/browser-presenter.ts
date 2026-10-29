import type { BrowserFrameStore, BrowserFrameView } from "@opensteer/client/host";
import { browserFrameContentRect, browserCropCue } from "@opensteer/shared/browserPresentation";
import { observeResize } from "@opensteer/shared/resizeObserver";

interface CanvasTarget {
  readonly allowUpscale: boolean;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly source: BrowserFrameStore;
  readonly presented: (frame: BrowserFrameView) => void;
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
): () => void {
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
  const detach = presenter.attach(source, sessionId, targeted, canvas, presented, allowUpscale);
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
      active: true,
    };
    this.#targets.add(target);
    const read = () => {
      const frame = source.get(sessionId, targeted ? this.#surfaceId : undefined);
      const token = frame?.header.watchToken;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (token) source.accept?.(sessionId, targeted ? this.#surfaceId : undefined, token);
      };
      target.active = frame?.header.surfaceId === this.#surfaceId;
      if (!target.active || !frame) {
        drawn.delete(canvas);
        layoutBrowserCanvas(canvas, null);
        context.clearRect(0, 0, canvas.width, canvas.height);
        canvas.dispatchEvent(new Event(browserPicturePresentedEvent, { bubbles: true }));
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
    const stopResize = observeResize([canvas.parentElement ?? canvas], () => {
      const frame = drawn.get(canvas);
      if (frame) layoutBrowserCanvas(canvas, frame, target.allowUpscale);
    });
    read();
    return () => {
      unsubscribe();
      stopResize();
      this.#targets.delete(target);
      drawn.delete(canvas);
      layoutBrowserCanvas(canvas, null);
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
            (picture.frame.header.geometryRevision !== undefined &&
              picture.frame.header.geometryRevision !== this.#revision) ||
            (picture.frame.header.capture?.revision ?? -1) !== this.#captureRevision ||
            bitmap.width !== picture.frame.header.rasterWidth ||
            bitmap.height !== picture.frame.header.rasterHeight
          ) {
            bitmap.close();
            this.#settle(picture);
            this.#decoding = null;
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
            this.#decoding = null;
            this.#decode();
          });
        },
        () => {
          this.#diagnose("failure", picture, performance.now() - started);
          this.#settle(picture);
          this.#decoding = null;
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
      layoutBrowserCanvas(canvas, frame, target.allowUpscale);
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
    if (this.#ready) {
      if (this.#scheduled !== null) cancelAnimationFrame(this.#scheduled);
      this.#scheduled = null;
      this.#ready.bitmap.close();
      this.#settle(this.#ready.picture);
      this.#ready = null;
      this.#decoding = null;
    }
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
    if (this.#decoding) this.#settle(this.#decoding);
    // A scheduled callback owns its bitmap and closes it even after disposal.
  }
}

function layoutBrowserCanvas(
  canvas: HTMLCanvasElement,
  frame: BrowserFrameView | null,
  allowUpscale = false,
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
  stage.style.setProperty(
    "--browser-region-radius",
    `${header.capture ? browserCropCue.radius : 0}px`,
  );
  stage.dataset.croppedRight = String(region.width < header.viewportWidth && !!header.capture);
  stage.dataset.croppedBottom = String(region.height < header.viewportHeight && !!header.capture);
  const rect = browserFrameContentRect(
    { left: 0, top: 0, width: stage.clientWidth, height: stage.clientHeight },
    header.rasterWidth,
    header.rasterHeight,
    header.capture,
    "top",
    allowUpscale,
  );
  if (!rect) return;
  for (const [key, value] of Object.entries(rect))
    stage.style.setProperty(`--browser-frame-${key}`, `${value}px`);
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
