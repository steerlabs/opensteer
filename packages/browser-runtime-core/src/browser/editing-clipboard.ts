import { randomUUID } from "node:crypto";
import {
  editingClipboardMaxBytes,
  editingClipboardMaxItems,
  editingClipboardPartMaxBytes,
  editingClipboardPartCount,
  type EditingClipboardItem,
} from "@opensteer/protocol/editing";
import type { BrowserClientMessage, BrowserServerMessage } from "@opensteer/protocol/browser";
import { AsyncMutex } from "../async.js";
import type {
  BrowserPage,
  EngineClipboard,
  EngineClipboardItem,
  EngineClipboardScope,
} from "./backend.js";

type Paste = Extract<BrowserClientMessage, { type: "clipboard.paste-data" }>;
interface StagedPaste {
  readonly message: Paste;
  readonly chunks: Buffer[];
  readonly ready: Promise<readonly EngineClipboardItem[] | null>;
  readonly resolve: (items: readonly EngineClipboardItem[] | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  bytes: number;
  complete: boolean;
  failed: boolean;
}

/** Bounded per-controller operations; their promises occupy their original surface-lane position. */
export class ClipboardParts {
  readonly #operations = new Map<string, StagedPaste>();
  readonly #report: (message: Paste, outcome: "too-large" | "stale") => Promise<void>;
  #reserved = 0;
  constructor(report: (message: Paste, outcome: "too-large" | "stale") => Promise<void>) {
    this.#report = report;
  }
  #key(producer: string | undefined, operation: string): string {
    return `${producer ?? ""}:${operation}`;
  }

  stage(message: Paste): boolean {
    const bytes = message.items.reduce((sum, item) => sum + item.size, 0);
    const key = this.#key(message.producerId, message.operationId);
    if (this.#operations.has(key)) {
      this.#fail(key, "too-large");
      return false;
    }
    if (this.#operations.size >= 4 || this.#reserved + bytes > 2 * editingClipboardMaxBytes) {
      void this.#report(message, "too-large").catch(() => undefined);
      return false;
    }
    const { promise, resolve } = Promise.withResolvers<readonly EngineClipboardItem[] | null>();
    const timer = setTimeout(() => this.#fail(key, "stale"), 5_000);
    timer.unref();
    this.#reserved += bytes;
    this.#operations.set(key, {
      message,
      chunks: [],
      bytes: 0,
      ready: promise,
      resolve,
      timer,
      complete: false,
      failed: false,
    });
    return true;
  }

  part(message: Extract<BrowserClientMessage, { type: "clipboard.part" }>): void {
    const key = this.#key(message.producerId, message.part.operationId);
    const stage = this.#operations.get(key);
    if (!stage || stage.failed || stage.complete) return;
    const bytes = Buffer.from(message.part.data, "base64");
    const expected = stage.message.items.reduce((sum, item) => sum + item.size, 0);
    const index = stage.chunks.length;
    if (
      message.part.index !== index ||
      bytes.length > editingClipboardPartMaxBytes ||
      bytes.toString("base64") !== message.part.data ||
      stage.bytes + bytes.length > expected ||
      (index < editingClipboardPartCount(stage.message.items) - 1 &&
        bytes.length !== editingClipboardPartMaxBytes)
    ) {
      this.#fail(key, "too-large");
      return;
    }
    stage.bytes += bytes.length;
    stage.chunks.push(bytes);
    if (stage.chunks.length !== editingClipboardPartCount(stage.message.items)) return;
    if (stage.bytes !== expected) {
      this.#fail(key, "too-large");
      return;
    }
    const data = Buffer.concat(stage.chunks);
    let offset = 0;
    const items = stage.message.items.map((item) => {
      const result = {
        type: item.type,
        ...(item.name ? { name: item.name } : {}),
        bytes: data.subarray(offset, offset + item.size),
      };
      offset += item.size;
      return result;
    });
    clearTimeout(stage.timer);
    stage.complete = true;
    stage.resolve(items);
  }

  async take(message: Paste): Promise<readonly EngineClipboardItem[] | null> {
    const key = this.#key(message.producerId, message.operationId);
    const stage = this.#operations.get(key);
    if (!stage) return null;
    try {
      return await stage.ready;
    } finally {
      this.#remove(key);
    }
  }

  reject(producer: string | undefined, operationId: string): void {
    this.#fail(this.#key(producer, operationId), "too-large");
  }

  discard(message: Paste): void {
    const key = this.#key(message.producerId, message.operationId);
    this.#operations.get(key)?.resolve(null);
    this.#remove(key);
  }
  cancel(producer?: string): void {
    for (const [key, stage] of this.#operations)
      if (producer === undefined || stage.message.producerId === producer) this.#fail(key, "stale");
  }
  #fail(key: string, outcome: "too-large" | "stale"): void {
    const stage = this.#operations.get(key);
    if (!stage || stage.failed) return;
    stage.failed = true;
    stage.resolve(null);
    void this.#report(stage.message, outcome).catch(() => undefined);
    // Keep the resolved slot until its lane entry consumes it.
    clearTimeout(stage.timer);
    stage.chunks.length = 0;
  }
  #remove(key: string): void {
    const stage = this.#operations.get(key);
    if (!stage) return;
    clearTimeout(stage.timer);
    this.#reserved -= stage.message.items.reduce((sum, item) => sum + item.size, 0);
    this.#operations.delete(key);
  }
}

const coordinators = new WeakMap<EngineClipboard, EngineClipboardCoordinator>();
export function engineClipboardCoordinator(engine: EngineClipboard): EngineClipboardCoordinator {
  let coordinator = coordinators.get(engine);
  if (!coordinator) {
    coordinator = new EngineClipboardCoordinator(engine);
    coordinators.set(engine, coordinator);
  }
  return coordinator;
}

/** The browser process owns one scope even when a profile has several controllers. */
class EngineClipboardCoordinator {
  readonly #engine: EngineClipboard;
  readonly #mutex = new AsyncMutex();
  #agents = 0;
  #operation: { valid: boolean } | null = null;
  #active: {
    scope: EngineClipboardScope;
    valid: boolean;
    page: BrowserPage;
    publish: (items: readonly EngineClipboardItem[]) => Promise<void>;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  constructor(engine: EngineClipboard) {
    this.#engine = engine;
  }
  invalidate(): void {
    if (this.#active) this.#active.valid = false;
    if (this.#operation) this.#operation.valid = false;
  }
  agentStarted(): () => void {
    this.#agents++;
    this.invalidate();
    let ended = false;
    return () => {
      if (!ended) {
        ended = true;
        this.#agents--;
      }
    };
  }
  finish(): Promise<void> {
    return this.#mutex.run(() => this.#finish());
  }
  async #finish(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    clearTimeout(active.timer);
    const items = await active.scope.close();
    if (active.valid && !active.page.isClosed() && items?.length) await active.publish(items);
  }
  begin(
    page: BrowserPage,
    publish: (items: readonly EngineClipboardItem[]) => Promise<void>,
  ): Promise<void> {
    return this.#mutex.run(async () => {
      await this.#finish();
      if (page.isClosed()) return;
      const scope = await this.#engine.open(page, null);
      const timer = setTimeout(() => void this.finish().catch(() => undefined), 500);
      timer.unref();
      this.#active = { scope, valid: this.#agents === 0, page, publish, timer };
    });
  }
  run<T>(
    page: BrowserPage,
    input: readonly EngineClipboardItem[] | null,
    action: () => Promise<T>,
  ): Promise<{ result: T; written: readonly EngineClipboardItem[] | null }> {
    return this.#mutex.run(async () => {
      await this.#finish();
      if (page.isClosed()) throw new Error("The clipboard page closed.");
      if (this.#agents > 0) throw new Error("An agent command prevents clipboard attribution.");
      const operation = { valid: true };
      this.#operation = operation;
      let scope: EngineClipboardScope | null = null;
      let written: readonly EngineClipboardItem[] | null = null;
      try {
        scope = await this.#engine.open(page, input);
        const result = await action();
        written = await scope.close();
        return { result, written: operation.valid ? written : null };
      } finally {
        this.#operation = null;
        if (written === null) await scope?.close();
      }
    });
  }
}

export async function publishClipboardItems(
  message: Extract<BrowserServerMessage, { type: "clipboard.result" | "clipboard.written" }>,
  items: readonly EngineClipboardItem[] | null,
  send: (message: BrowserServerMessage) => Promise<void>,
): Promise<void> {
  const size = items?.reduce((sum, item) => sum + item.bytes.length, 0) ?? 0;
  if (!items?.length || size === 0) {
    if (message.type === "clipboard.result") await send({ ...message, outcome: "empty" });
    return;
  }
  if (size > editingClipboardMaxBytes || items.length > editingClipboardMaxItems) {
    await send({
      type: "clipboard.result",
      operationId: message.operationId,
      surfaceId: message.surfaceId,
      ...(message.consumerToken ? { consumerToken: message.consumerToken } : {}),
      outcome: "too-large",
    });
    return;
  }
  const descriptors: EditingClipboardItem[] = items.map((item) => ({
    type: item.type,
    size: item.bytes.length,
    ...(item.name ? { name: item.name } : {}),
  }));
  await send({ ...message, items: descriptors });
  const bytes = Buffer.concat(items.map((item) => Buffer.from(item.bytes)));
  for (let index = 0; index < editingClipboardPartCount(descriptors); index++)
    await send({
      type: "clipboard.part",
      ...(message.consumerToken ? { consumerToken: message.consumerToken } : {}),
      part: {
        operationId: message.operationId,
        index,
        data: bytes
          .subarray(
            index * editingClipboardPartMaxBytes,
            (index + 1) * editingClipboardPartMaxBytes,
          )
          .toString("base64"),
      },
    });
}

export function pageClipboardWrite(
  surfaceId: Extract<BrowserServerMessage, { type: "clipboard.written" }>["surfaceId"],
  consumerToken: string,
): Extract<BrowserServerMessage, { type: "clipboard.written" }> {
  return {
    type: "clipboard.written",
    surfaceId,
    consumerToken,
    operationId: randomUUID(),
    items: [],
  };
}
