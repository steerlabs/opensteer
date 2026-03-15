import { createBrowserCoreError } from "@opensteer/browser-core";
import WebSocket from "ws";
import type { RawData } from "ws";

type EventHandler = (params: Record<string, unknown>) => void;
type CloseHandler = (error?: Error) => void;

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export const PAGE_CDP_METHOD_ALLOWLIST = new Set<string>([
  "DOM.enable",
  "DOM.getAttributes",
  "DOM.getContentQuads",
  "DOM.getDocument",
  "DOM.getNodeForLocation",
  "DOM.getOuterHTML",
  "DOM.pushNodesByBackendIdsToFrontend",
  "DOMSnapshot.captureSnapshot",
  "DOMStorage.disable",
  "DOMStorage.enable",
  "DOMStorage.getDOMStorageItems",
  "Emulation.getScreenInfos",
  "IndexedDB.requestData",
  "IndexedDB.requestDatabase",
  "IndexedDB.requestDatabaseNames",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Runtime.evaluate",
  "Storage.getStorageKey",
]);

export const BROWSER_CDP_METHOD_ALLOWLIST = new Set<string>([
  "Storage.getCookies",
  "Target.getTargets",
]);

export function assertAllowedCdpMethod(method: string, allowedMethods: ReadonlySet<string>): void {
  if (allowedMethods.has(method)) {
    return;
  }

  throw createBrowserCoreError(
    "operation-failed",
    `CDP method ${method} is not permitted by the ABP inspector sandbox`,
    {
      details: {
        method,
      },
    },
  );
}

export class CdpClient {
  private readonly socket: WebSocket;
  private readonly allowedMethods: ReadonlySet<string>;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private nextId = 0;
  private readonly opened: Promise<void>;
  private readonly closed: Promise<void>;
  private closedError: Error | undefined;

  private constructor(url: string, allowedMethods: ReadonlySet<string>) {
    this.allowedMethods = allowedMethods;
    this.socket = new WebSocket(url);
    this.socket.on("message", (data: RawData) => {
      this.handleMessage(typeof data === "string" ? data : data.toString("utf8"));
    });

    this.opened = new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", (error: Error) => reject(error));
    });

    this.closed = new Promise<void>((resolve) => {
      this.socket.once("close", () => {
        this.flushPending(this.closedError ?? new Error("CDP socket closed"));
        for (const handler of this.closeHandlers) {
          handler(this.closedError);
        }
        resolve();
      });
      this.socket.once("error", (error: Error) => {
        this.closedError = error;
      });
    });
  }

  static async connect(input: {
    readonly url: string;
    readonly allowedMethods: ReadonlySet<string>;
  }): Promise<CdpClient> {
    const client = new CdpClient(input.url, input.allowedMethods);
    await client.opened;
    return client;
  }

  on(method: string, handler: EventHandler): () => void {
    const handlers = this.eventHandlers.get(method) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      const current = this.eventHandlers.get(method);
      if (!current) {
        return;
      }
      current.delete(handler);
      if (current.size === 0) {
        this.eventHandlers.delete(method);
      }
    };
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  async send<TResult>(method: string, params: Record<string, unknown> = {}): Promise<TResult> {
    assertAllowedCdpMethod(method, this.allowedMethods);
    await this.opened;

    if (this.closedError) {
      throw this.closedError;
    }

    const id = ++this.nextId;
    const payload = JSON.stringify({
      id,
      method,
      params,
    });

    const result = new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
      });
    });

    this.socket.send(payload);
    return result;
  }

  async close(): Promise<void> {
    if (
      this.socket.readyState === WebSocket.CLOSED ||
      this.socket.readyState === WebSocket.CLOSING
    ) {
      await this.closed;
      return;
    }

    this.socket.close();
    await this.closed;
  }

  private handleMessage(message: string): void {
    const parsed = JSON.parse(message) as {
      readonly id?: number;
      readonly method?: string;
      readonly params?: Record<string, unknown>;
      readonly result?: unknown;
      readonly error?: {
        readonly code?: number;
        readonly message?: string;
      };
    };

    if (parsed.id !== undefined) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(
          new Error(parsed.error.message ?? `CDP command ${String(parsed.id)} failed`),
        );
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (!parsed.method) {
      return;
    }

    for (const handler of this.eventHandlers.get(parsed.method) ?? []) {
      handler(parsed.params ?? {});
    }
  }

  private flushPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
