import { randomUUID } from "node:crypto";
import { BrowserCursorSchema, type BrowserCursor } from "@opensteer/protocol/browser";
import type { CdpSession } from "./backend.js";

export interface NativePageCursor {
  read(): BrowserCursor;
  /** Null means native input or another actor made attribution uncertain. */
  subscribe(listener: (cursor: BrowserCursor | null) => void): () => void;
}
export interface CursorPoint {
  consumerToken: string;
  cursorSequence: number;
  documentId: string;
  geometryRevision: number;
  captureRevision: number;
  x: number;
  y: number;
}
export type CursorHint = Omit<CursorPoint, "x" | "y"> & { cursor: BrowserCursor };

/** One coalesced observation per page, independent of its mutation lane. */
export class PageCursorHints {
  readonly #world = `opensteer-cursor-${randomUUID()}`;
  #point: CursorPoint | null = null;
  #pointSequence = 0;
  #context: Promise<number> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #held = false;
  #pauses = 0;
  #closed = false;
  #lastQuery = -Infinity;
  readonly #unsubscribe: (() => void) | undefined;
  readonly cdp: CdpSession;
  readonly publish: (hint: CursorHint) => void;
  readonly native: NativePageCursor | undefined;
  constructor(cdp: CdpSession, publish: (hint: CursorHint) => void, native?: NativePageCursor) {
    this.cdp = cdp;
    this.publish = publish;
    this.native = native;
    cdp.on("Page.frameNavigated", this.#navigated);
    cdp.on("Page.navigatedWithinDocument", this.#navigated);
    cdp.on("Runtime.executionContextsCleared", this.#navigated);
    this.#unsubscribe = native?.subscribe((cursor) => {
      if (cursor === null) this.invalidate();
      else this.#schedule();
    });
  }
  point(point: CursorPoint, held = false): () => void {
    this.#point = point;
    this.#pointSequence = point.cursorSequence;
    this.#held = held;
    if (!held) this.#schedule();
    return () => {
      if (this.#point !== point) return;
      this.#held = false;
      this.#schedule();
    };
  }
  refresh(consumerToken: string, sequence: number, pointSequence: number): void {
    if (
      this.#held ||
      this.#pauses > 0 ||
      this.#pointSequence !== pointSequence ||
      this.#point?.consumerToken !== consumerToken ||
      sequence < this.#point.cursorSequence
    )
      return;
    // A refresh advances only this controller's point; it never creates one.
    if (sequence !== this.#point.cursorSequence)
      this.#point = { ...this.#point, cursorSequence: sequence };
    this.#schedule();
  }
  pause(): () => void {
    this.#pauses++;
    if (this.#point) {
      this.#point = { ...this.#point };
      this.#publish(this.#point, "default");
    }
    return () => {
      this.#pauses--;
      this.#schedule();
    };
  }
  invalidateOther(consumerToken: string): void {
    if (this.#point && this.#point.consumerToken !== consumerToken) this.invalidate();
  }
  invalidate(consumerToken?: string): void {
    if (consumerToken && this.#point?.consumerToken !== consumerToken) return;
    const point = this.#point;
    this.#point = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (point && !this.#closed) this.#publish(point, "default");
  }
  close(): void {
    this.#closed = true;
    this.invalidate();
    this.#unsubscribe?.();
    this.cdp.off("Page.frameNavigated", this.#navigated);
    this.cdp.off("Page.navigatedWithinDocument", this.#navigated);
    this.cdp.off("Runtime.executionContextsCleared", this.#navigated);
  }
  readonly #navigated = (): void => {
    this.#context = null;
    this.invalidate();
  };
  #schedule(): void {
    if (
      this.#closed ||
      !this.#point ||
      this.#held ||
      this.#pauses > 0 ||
      this.#running ||
      this.#timer
    )
      return;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        void this.#query();
      },
      Math.max(0, 100 - (performance.now() - this.#lastQuery)),
    );
  }
  #publish(point: CursorPoint, cursor: BrowserCursor): void {
    const { x: _x, y: _y, ...fence } = point;
    this.publish({ ...fence, cursor });
  }
  async #query(): Promise<void> {
    const point = this.#point;
    if (!point || this.#held || this.#pauses > 0 || this.#closed) return;
    this.#lastQuery = performance.now();
    this.#running = true;
    // A stalled renderer never gets a second concurrent query. Its late answer
    // is fenced, while the viewer can already return to its default cursor.
    const deadline = setTimeout(() => {
      if (this.#point === point) this.invalidate();
    }, 500);
    try {
      let cursor: BrowserCursor;
      if (this.native) cursor = this.native.read();
      else {
        this.#context ??= this.cdp
          .send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree")
          .then((tree) =>
            this.cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
              frameId: tree.frameTree.frame.id,
              worldName: this.#world,
            }),
          )
          .then((result) => result.executionContextId);
        const contextId = await this.#context;
        if (this.#point !== point || this.#closed) return;
        const result = await this.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
          contextId,
          expression: cursorQuerySource(point.x, point.y),
          returnByValue: true,
          silent: true,
        });
        cursor = BrowserCursorSchema.safeParse(result.result?.value).data ?? "default";
      }
      if (this.#point === point && !this.#closed) this.#publish(point, cursor);
    } catch {
      this.#context = null;
      if (this.#point === point && !this.#closed) this.#publish(point, "default");
    } finally {
      clearTimeout(deadline);
      this.#running = false;
      if (this.#point !== point) this.#schedule();
    }
  }
}

/** A conservative root-document hit test; inaccessible frames and custom images use default. */
export function cursorQuerySource(x: number, y: number): string {
  return `(() => {
    const x = ${JSON.stringify(x)}, y = ${JSON.stringify(y)};
    const allowed = ${JSON.stringify(BrowserCursorSchema.options)};
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    if (!element || element.tagName === 'IFRAME' || element.tagName === 'OBJECT') return 'default';
    const cursor = getComputedStyle(element).cursor;
    if (cursor !== 'auto') return allowed.includes(cursor) ? cursor : 'default';
    if (element.closest(':disabled, [inert]')) return 'default';
    if (element.closest('a[href], area[href]')) return 'pointer';
    if (element.isContentEditable || element.closest('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"]')) return 'text';
    if (getComputedStyle(element).userSelect === 'none') return 'default';
    const caret = document.caretRangeFromPoint?.(x, y);
    if (caret?.startContainer.nodeType === 3) {
      const node = caret.startContainer, offset = caret.startOffset;
      const range = document.createRange();
      range.setStart(node, Math.max(0, offset - 1));
      range.setEnd(node, Math.min(node.length, offset + 1));
      for (const rect of range.getClientRects())
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return 'text';
    }
    return 'default';
  })()`;
}

export function normalizeElectronCursor(type: string): BrowserCursor {
  const names: Record<string, BrowserCursor> = {
    pointer: "default",
    hand: "pointer",
    ibeam: "text",
    verticaltext: "vertical-text",
    eastresize: "e-resize",
    northresize: "n-resize",
    northeastresize: "ne-resize",
    northwestresize: "nw-resize",
    southresize: "s-resize",
    southeastresize: "se-resize",
    southwestresize: "sw-resize",
    westresize: "w-resize",
    northsouthresize: "ns-resize",
    eastwestresize: "ew-resize",
    northeastsouthwestresize: "nesw-resize",
    northwestsoutheastresize: "nwse-resize",
    columnresize: "col-resize",
    rowresize: "row-resize",
    nodrop: "no-drop",
    notallowed: "not-allowed",
    zoomin: "zoom-in",
    zoomout: "zoom-out",
  };
  const key = type.replaceAll("-", "");
  return Object.hasOwn(names, key)
    ? names[key]!
    : (BrowserCursorSchema.safeParse(type).data ?? "default");
}
