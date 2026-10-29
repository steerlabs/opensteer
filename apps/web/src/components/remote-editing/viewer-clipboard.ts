import type { EditingClipboardPayloadItem } from "@opensteer/client/editing";

export interface ClipboardArm {
  readonly done: Promise<boolean>;
  resolve(items: readonly EditingClipboardPayloadItem[]): void;
  reject(): void;
}
export type NativeViewerClipboardWrite = (
  items: readonly EditingClipboardPayloadItem[],
) => Promise<void>;

/** Promises are handed to the browser while the gesture is still on its stack. */
export class ViewerClipboard {
  readonly #onError: (message: string) => void;
  readonly #native: NativeViewerClipboardWrite | undefined;
  readonly #arms = new Set<ClipboardArm>();
  #activation: { arm: ClipboardArm; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(onError: (message: string) => void, native?: NativeViewerClipboardWrite) {
    this.#onError = onError;
    this.#native = native;
  }
  arm(_reason: "copy" | "cut" | "activation"): ClipboardArm {
    let resolve!: (items: readonly EditingClipboardPayloadItem[]) => void;
    let reject!: (reason: Error) => void;
    let canceled = false;
    let settled = false;
    const payload = new Promise<readonly EditingClipboardPayloadItem[]>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let write: Promise<void>;
    if (this.#native) write = payload.then((items) => this.#native!(items));
    else {
      const plain = payload.then((items) => this.#blob(items, "text/plain"));
      const html = payload.then((items) => this.#blob(items, "text/html"));
      // Some browsers throw before consuming a ClipboardItem's promises.
      void plain.catch(() => false);
      void html.catch(() => false);
      try {
        if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write)
          throw new Error("This browser cannot write a remote clipboard from a gesture.");
        write = navigator.clipboard.write([
          new ClipboardItem({ "text/plain": plain, "text/html": html }),
        ]);
      } catch (error) {
        write = Promise.reject(error);
      }
    }
    const done = write
      .then(
        () => true,
        (error) => {
          if (!canceled)
            this.#onError(
              error instanceof Error ? error.message : "The local clipboard could not be written.",
            );
          return false;
        },
      )
      .finally(() => this.#arms.delete(arm));
    const arm: ClipboardArm = {
      done,
      resolve: (items) => {
        if (settled) return;
        settled = true;
        if (!items.some((item) => item.type === "text/plain" || item.type === "text/html")) {
          canceled = true;
          reject(new Error("The clipboard has no text representation."));
          this.#onError("Copy Image from streamed pages is not supported. Copy text instead.");
          return;
        }
        resolve(items);
      },
      reject: () => {
        if (settled) return;
        settled = true;
        canceled = true;
        reject(new Error("No remote clipboard data was produced."));
      },
    };
    // Native writes and unsupported web APIs still observe the payload rejection.
    void payload.catch(() => false);
    this.#arms.add(arm);
    return arm;
  }
  #blob(items: readonly EditingClipboardPayloadItem[], type: "text/plain" | "text/html"): Blob {
    const item = items.find((item) => item.type === type);
    if (item) return new Blob([new Uint8Array(item.bytes)], { type });
    if (type === "text/html") {
      const text = items.find((item) => item.type === "text/plain");
      if (text) {
        const escaped = new TextDecoder()
          .decode(text.bytes)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        return new Blob([`<pre>${escaped}</pre>`], { type });
      }
    }
    return new Blob([], { type });
  }
  armActivation(): void {
    this.#clearActivation();
    const arm = this.arm("activation");
    const timer = setTimeout(() => this.#clearActivation(), 500);
    this.#activation = { arm, timer };
  }
  #clearActivation(): void {
    if (!this.#activation) return;
    clearTimeout(this.#activation.timer);
    this.#activation.arm.reject();
    this.#activation = null;
  }
  async written(items: readonly EditingClipboardPayloadItem[]): Promise<void> {
    const activation = this.#activation;
    if (activation) {
      clearTimeout(activation.timer);
      this.#activation = null;
      activation.arm.resolve(items);
      await activation.arm.done;
    } else await this.write(items);
  }
  async write(items: readonly EditingClipboardPayloadItem[]): Promise<void> {
    if (!items.some((item) => item.type === "text/plain" || item.type === "text/html"))
      throw new Error("Copy Image from streamed pages is not supported. Copy text instead.");
    if (this.#native) return this.#native(items);
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write)
      throw new Error("This browser cannot write the remote clipboard.");
    const representations: Record<string, Blob> = {};
    for (const item of items)
      if (item.type === "text/plain" || item.type === "text/html")
        representations[item.type] = new Blob([new Uint8Array(item.bytes)], { type: item.type });
    if (!Object.keys(representations).length)
      throw new Error("The remote clipboard has no supported text representation.");
    await navigator.clipboard.write([new ClipboardItem(representations)]);
  }
  dispose(): void {
    this.#clearActivation();
    for (const arm of this.#arms) arm.reject();
    this.#arms.clear();
  }
}
