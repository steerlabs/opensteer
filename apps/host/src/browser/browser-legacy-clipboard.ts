import { randomUUID } from "node:crypto";
import {
  BrowserServerMessageSchema,
  type BrowserServerMessage,
  type BrowserSurfaceId,
} from "@opensteer/protocol";
import { editingClipboardPartMaxBytes } from "@opensteer/protocol/editing";

type LegacyData = Extract<BrowserServerMessage, { type: "clipboard.data" }>;
interface PendingCopy {
  readonly operationId: string;
  readonly surfaceId: BrowserSurfaceId;
  readonly outcome: "copied" | "cut";
  readonly timer: ReturnType<typeof setTimeout>;
  data?: {
    readonly total: number;
    readonly plainOffset: number;
    readonly plain: Buffer;
    received: number;
    index: number;
  };
}

/** One bounded native result for a baseline controller; a newer copy supersedes it. */
export class LegacyBrowserClipboard {
  readonly #consumerToken: string;
  readonly #maxBytes: number;
  #pending: PendingCopy | undefined;

  constructor(consumerToken: string, maxBytes: number) {
    this.#consumerToken = consumerToken;
    this.#maxBytes = maxBytes;
  }

  begin(surfaceId: BrowserSurfaceId, outcome: "copied" | "cut"): string {
    this.close();
    const operationId = randomUUID();
    const timer = setTimeout(() => this.close(), 5000);
    timer.unref();
    this.#pending = { operationId, surfaceId, outcome, timer };
    return operationId;
  }

  read(message: BrowserServerMessage): LegacyData | null {
    const pending = this.#pending;
    if (!pending) return null;
    if (message.type === "clipboard.result" && message.operationId === pending.operationId) {
      if (
        message.surfaceId !== pending.surfaceId ||
        message.outcome !== pending.outcome ||
        pending.data
      ) {
        this.close();
        return null;
      }
      let total = 0,
        plainOffset = 0,
        size: number | undefined;
      for (const item of message.items ?? []) {
        if (item.type === "text/plain") {
          if (size !== undefined) {
            this.close();
            return null;
          }
          size = item.size;
          plainOffset = total;
        }
        total += item.size;
      }
      if (!size || size > this.#maxBytes) {
        this.close();
        return null;
      }
      pending.data = { total, plainOffset, plain: Buffer.alloc(size), received: 0, index: 0 };
      return null;
    }
    if (message.type !== "clipboard.part" || message.part.operationId !== pending.operationId)
      return null;
    const data = pending.data;
    const bytes = Buffer.from(message.part.data, "base64");
    if (
      !data ||
      message.part.index !== data.index ||
      bytes.length !== Math.min(editingClipboardPartMaxBytes, data.total - data.received) ||
      bytes.toString("base64") !== message.part.data
    ) {
      this.close();
      return null;
    }
    const start = Math.max(data.received, data.plainOffset);
    const end = Math.min(data.received + bytes.length, data.plainOffset + data.plain.length);
    if (end > start)
      bytes.copy(data.plain, start - data.plainOffset, start - data.received, end - data.received);
    data.received += bytes.length;
    data.index++;
    if (data.received !== data.total) return null;
    this.close();
    try {
      const projected: LegacyData = {
        type: "clipboard.data",
        surfaceId: pending.surfaceId,
        consumerToken: this.#consumerToken,
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.plain),
      };
      return BrowserServerMessageSchema.safeParse(projected).success &&
        Buffer.byteLength(JSON.stringify(projected)) <= this.#maxBytes
        ? projected
        : null;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.#pending) clearTimeout(this.#pending.timer);
    this.#pending = undefined;
  }
}
