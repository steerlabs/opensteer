import { z } from "zod";
import type { CdpSession } from "./backend.js";

const attached = z.object({ sessionId: z.string(), targetInfo: z.object({ type: z.string() }) });
const detached = z.object({ sessionId: z.string() });
const received = z.object({ sessionId: z.string(), message: z.string() });
const envelope = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** The platform channel alone attaches OOPIFs; none of these sessions reach agent CDP. */
export class FrameCdpSessions {
  readonly #parent: CdpSession;
  readonly #children = new Map<string, FrameCdpSession>();
  readonly #opened: (session: CdpSession) => void;
  readonly #ended: (session: CdpSession) => void;
  #closed = false;
  constructor(
    parent: CdpSession,
    opened: (session: CdpSession) => void,
    ended: (session: CdpSession) => void,
  ) {
    this.#parent = parent;
    this.#opened = opened;
    this.#ended = ended;
    parent.on("Target.attachedToTarget", this.#attached);
    parent.on("Target.detachedFromTarget", this.#detached);
    parent.on("Target.receivedMessageFromTarget", this.#received);
  }
  start(): Promise<unknown> {
    return this.#parent.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    });
  }
  #attached = (value: unknown): void => {
    const event = attached.safeParse(value);
    if (
      !event.success ||
      event.data.targetInfo.type !== "iframe" ||
      this.#closed ||
      this.#children.has(event.data.sessionId)
    )
      return;
    if (this.#children.size >= 64) {
      void this.#parent
        .send("Target.detachFromTarget", { sessionId: event.data.sessionId })
        .catch(() => undefined);
      return;
    }
    const session = new FrameCdpSession(this.#parent, event.data.sessionId);
    this.#children.set(event.data.sessionId, session);
    this.#opened(session);
  };
  #detached = (value: unknown): void => {
    const event = detached.safeParse(value);
    if (!event.success) return;
    const child = this.#children.get(event.data.sessionId);
    if (!child) return;
    this.#children.delete(event.data.sessionId);
    child.ended();
    this.#ended(child);
  };
  #received = (value: unknown): void => {
    const event = received.safeParse(value);
    if (!event.success) return;
    this.#children.get(event.data.sessionId)?.receive(event.data.message);
  };
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#parent.off("Target.attachedToTarget", this.#attached);
    this.#parent.off("Target.detachedFromTarget", this.#detached);
    this.#parent.off("Target.receivedMessageFromTarget", this.#received);
    for (const child of this.#children.values()) {
      child.ended();
      this.#ended(child);
    }
    this.#children.clear();
    void this.#parent
      .send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: false,
      })
      .catch(() => undefined);
  }
}

class FrameCdpSession implements CdpSession {
  readonly #parent: CdpSession;
  readonly #id: string;
  readonly #listeners = new Map<string, Set<(parameters: unknown) => void>>();
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #sequence = 0;
  #closed = false;
  constructor(parent: CdpSession, id: string) {
    this.#parent = parent;
    this.#id = id;
  }
  on(event: string, listener: (parameters: unknown) => void): void {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener);
  }
  off(event: string, listener: (parameters: unknown) => void): void {
    this.#listeners.get(event)?.delete(listener);
  }
  onEvent(listener: (method: string, parameters: Record<string, unknown>) => void): () => void {
    const bridge = (value: unknown) => {
      const event = z
        .object({ method: z.string(), params: z.record(z.string(), z.unknown()) })
        .parse(value);
      listener(event.method, event.params);
    };
    this.on("*", bridge);
    return () => this.off("*", bridge);
  }
  send<Result = unknown>(method: string, parameters?: Record<string, unknown>): Promise<Result> {
    if (this.#closed) return Promise.reject(new Error("The frame CDP session ended."));
    const id = ++this.#sequence;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    void this.#parent
      .send("Target.sendMessageToTarget", {
        sessionId: this.#id,
        message: JSON.stringify({ id, method, params: parameters }),
      })
      .catch((error) => {
        this.#pending
          .get(id)
          ?.reject(error instanceof Error ? error : new Error("Frame CDP send failed."));
        this.#pending.delete(id);
      });
    return response as Promise<Result>;
  }
  receive(message: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return;
    }
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.id !== undefined) {
      const pending = this.#pending.get(event.id);
      this.#pending.delete(event.id);
      if (event.error) pending?.reject(new Error(event.error.message));
      else pending?.resolve(event.result);
    } else if (event.method) {
      for (const listener of this.#listeners.get(event.method) ?? []) listener(event.params ?? {});
      for (const listener of this.#listeners.get("*") ?? [])
        listener({ method: event.method, params: event.params ?? {} });
    }
  }
  ended(): void {
    this.#closed = true;
    for (const pending of this.#pending.values())
      pending.reject(new Error("The frame CDP session ended."));
    this.#pending.clear();
    this.#listeners.clear();
  }
  close(): Promise<void> {
    this.ended();
    return this.#parent
      .send("Target.detachFromTarget", { sessionId: this.#id })
      .then(() => undefined)
      .catch(() => undefined);
  }
  detach(): Promise<void> {
    return this.close();
  }
}
