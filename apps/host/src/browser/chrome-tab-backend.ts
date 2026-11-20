import { randomUUID } from "node:crypto";
import {
  BrowserSourceTabAssembly,
  BrowserSourceTabEventSchema,
  BrowserSourceTabResultSchema,
  browserSourceTabBufferedBytes,
  browserSourceTabPending,
  browserSourceTabParts,
  type BrowserSourceTabCommand,
  type BrowserSourceTabEvent,
  type BrowserSourceTabPart,
  type BrowserSourceTabResult,
  type BrowserSourceTabShared,
} from "@opensteer/browser-source-wire/frames";
import {
  SessionCdpRouterError,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpParameters,
} from "@opensteer/browser-runtime-core";
import { z } from "zod";

type Listener = (method: string, parameters: CdpParameters) => void;
type Reply = {
  readonly shareId: string;
  readonly attachmentId: string;
  readonly bytes: number;
  readonly completed: PromiseWithResolvers<BrowserSourceTabResult>;
  readonly timer: ReturnType<typeof setTimeout>;
};

type Tab = {
  info: BrowserSourceTabShared;
  readonly channels: Set<LogicalChannel>;
  readonly children: Map<string, { parent?: string; info: CdpParameters }>;
  readonly contexts: Map<string, Map<number, CdpParameters>>;
  readonly runtimeEnables: Map<string, Promise<CdpParameters>>;
  attachmentId?: string;
};
type LogicalChannel = {
  readonly listeners: Set<Listener>;
  readonly runtime: Set<string>;
  readonly autoAttach: Set<string>;
};
const root = "";
const record = z.record(z.string(), z.unknown());
const nestedMessage = z.object({
  id: z.number().int(),
  method: z.string(),
  params: record.optional(),
});
const geometry =
  /^(?:Emulation\.(?:set|clear)DeviceMetricsOverride|Emulation\.setVisibleSize|Emulation\.setPageScaleFactor|Emulation\.resetPageScaleFactor|Page\.setViewport|Page\.setDeviceMetricsOverride)$/u;

export class ChromeTabBackend implements BrowserCdpBackend {
  readonly allowsProfileCookieReads = true;
  readonly #tabs = new Map<string, Tab>();
  readonly #listeners = new Set<Listener>();
  readonly #pending = new Map<string, Reply>();
  readonly #assembly = new BrowserSourceTabAssembly();
  readonly #write: (frame: BrowserSourceTabPart<"tab.command">) => boolean;
  readonly #fail: () => void;
  #pendingBytes = 0;

  constructor(write: (frame: BrowserSourceTabPart<"tab.command">) => boolean, fail: () => void) {
    this.#write = write;
    this.#fail = fail;
  }

  assertScope(method: string): void {
    if (
      geometry.test(method) ||
      method === "DOM.setFileInputFiles" ||
      method === "Page.startScreencast" ||
      method === "Target.createTarget" ||
      method === "Target.closeTarget" ||
      method === "Page.close"
    )
      throw new SessionCdpRouterError(
        "forbidden",
        `${method} is unavailable on a shared Chrome tab.`,
      );
  }

  update(info: BrowserSourceTabShared): void {
    const tab = this.#tabs.get(info.shareId);
    if (tab) tab.info = info;
    else
      this.#tabs.set(info.shareId, {
        info,
        channels: new Set(),
        children: new Map(),
        contexts: new Map(),
        runtimeEnables: new Map(),
      });
    this.#emit(tab ? "Target.targetInfoChanged" : "Target.targetCreated", {
      targetInfo: this.#info(this.#tabs.get(info.shareId)!),
    });
  }

  remove(shareId: string): void {
    const tab = this.#tabs.get(shareId);
    if (!tab) return;
    this.#tabs.delete(shareId);
    this.#finishReplies(shareId, tab.attachmentId);
    tab.channels.clear();
    this.#emit("Target.targetDestroyed", { targetId: tab.info.targetId });
  }

  stopSharing(shareId: string): void {
    const tab = this.#tabs.get(shareId);
    if (!tab) return;
    void this.#request({
      action: "unshare",
      shareId,
      attachmentId: tab.attachmentId ?? randomUUID(),
      requestId: randomUUID(),
    }).catch(() => undefined);
  }

  close(): void {
    for (const id of this.#tabs.keys()) this.remove(id);
    for (const [id, pending] of this.#pending) {
      this.#endReply(id, pending);
      pending.completed.reject(new Error("Chrome disconnected."));
    }
    this.#listeners.clear();
  }

  read(frame: BrowserSourceTabPart<"tab.event" | "tab.result">): void {
    const message = this.#assembly.read(frame);
    if (message === undefined) return;
    if (frame.type === "tab.event") {
      this.#event(BrowserSourceTabEventSchema.parse(message));
      return;
    }
    const result = BrowserSourceTabResultSchema.parse(message);
    const pending = this.#pending.get(result.requestId);
    if (pending?.shareId !== result.shareId || pending.attachmentId !== result.attachmentId) return;
    this.#endReply(result.requestId, pending);
    pending.completed.resolve(result);
  }

  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(method: string, parameters: CdpParameters = {}): Promise<unknown> {
    this.assertScope(method);
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: [...this.#tabs.values()].map((tab) => this.#info(tab)) };
      case "Target.getTargetInfo":
        return { targetInfo: this.#info(this.#requireTab(String(parameters.targetId))) };
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Browser.getVersion": {
        const version = this.#tabs.values().next().value?.info.browserVersion;
        const product = version ? `Chrome/${version}` : "Chrome";
        return {
          protocolVersion: "1.3",
          product,
          revision: "",
          userAgent: product,
          jsVersion: "",
        };
      }
      case "Target.activateTarget":
        this.#requireTab(String(parameters.targetId));
        return {};
      default:
        throw new SessionCdpRouterError(
          "forbidden",
          `${method} is unavailable on a shared Chrome tab.`,
        );
    }
  }

  async attach(
    targetId: string,
    _waitForPage?: boolean,
    signal?: AbortSignal,
  ): Promise<CdpChannel> {
    signal?.throwIfAborted();
    const tab = this.#requireTab(targetId);
    const logical: LogicalChannel = {
      listeners: new Set(),
      runtime: new Set(),
      autoAttach: new Set(),
    };
    tab.channels.add(logical);
    return {
      close: async () => {
        if (!tab.channels.delete(logical)) return;
        logical.listeners.clear();
        if (tab.channels.size === 0 && tab.attachmentId) {
          const attachmentId = tab.attachmentId;
          delete tab.attachmentId;
          tab.contexts.clear();
          tab.runtimeEnables.clear();
          tab.children.clear();
          this.#finishReplies(tab.info.shareId, attachmentId);
          await this.#request({
            action: "detach",
            shareId: tab.info.shareId,
            attachmentId,
            requestId: randomUUID(),
          }).catch(() => undefined);
        }
      },
      onEvent: (listener) => {
        logical.listeners.add(listener);
        return () => logical.listeners.delete(listener);
      },
      send: (method, params) => this.#command(tab, logical, root, method, params ?? {}),
    };
  }

  #info(tab: Tab): CdpParameters {
    const { targetId, openerShareId, title, url } = tab.info;
    const openerId = openerShareId ? this.#tabs.get(openerShareId)?.info.targetId : undefined;
    return {
      targetId,
      type: "page",
      title,
      url,
      attached: !!tab.attachmentId,
      canAccessOpener: false,
      ...(openerId ? { openerId } : {}),
    };
  }

  #requireTab(targetId: string): Tab {
    const tab = [...this.#tabs.values()].find((entry) => entry.info.targetId === targetId);
    if (!tab) throw new SessionCdpRouterError("not_found", "This Chrome tab is no longer shared.");
    return tab;
  }

  #emit(method: string, params: CdpParameters): void {
    for (const listen of this.#listeners) listen(method, params);
  }

  async #command(
    tab: Tab,
    logical: LogicalChannel,
    session: string,
    method: string,
    params: CdpParameters,
  ): Promise<unknown> {
    if (!tab.channels.has(logical)) throw new Error("Chrome debugger channel closed.");
    this.assertScope(method);
    if (method === "Target.sendMessageToTarget") {
      const child = String(params.sessionId);
      if ((tab.children.get(child)?.parent ?? root) !== session || !tab.children.has(child))
        throw new Error("Chrome debugger child is unavailable.");
      const request = nestedMessage.parse(JSON.parse(String(params.message)));
      const payload = await this.#command(
        tab,
        logical,
        child,
        request.method,
        request.params ?? {},
      ).then(
        (result) => ({ id: request.id, result }),
        (error: unknown) => ({
          id: request.id,
          error: { message: error instanceof Error ? error.message : "Chrome CDP failed" },
        }),
      );
      this.#deliver(tab, logical, session, "Target.receivedMessageFromTarget", {
        sessionId: child,
        message: JSON.stringify(payload),
      });
      return {};
    }
    if (method === "Target.detachFromTarget") return {};
    if (session && !tab.children.has(session)) throw new Error("Chrome debugger child closed.");
    if (method === "Runtime.enable") {
      const pending = tab.runtimeEnables.get(session);
      if (logical.runtime.has(session)) return pending ?? {};
      const current = [...(tab.contexts.get(session)?.values() ?? [])];
      logical.runtime.add(session);
      for (const context of current)
        this.#deliver(tab, logical, session, "Runtime.executionContextCreated", context);
      if (
        [...tab.channels].some(
          (candidate) => candidate !== logical && candidate.runtime.has(session),
        )
      )
        return pending ?? {};
      const work = this.#sendCdp(tab, session, method, params);
      tab.runtimeEnables.set(session, work);
      try {
        return await work;
      } catch (error) {
        if (tab.runtimeEnables.get(session) === work)
          for (const channel of tab.channels) channel.runtime.delete(session);
        throw error;
      } finally {
        if (tab.runtimeEnables.get(session) === work) tab.runtimeEnables.delete(session);
      }
    } else if (method === "Runtime.disable") {
      logical.runtime.delete(session);
      if ([...tab.channels].some((candidate) => candidate.runtime.has(session))) return {};
    } else if (method === "Target.setAutoAttach") {
      if (params.autoAttach === true) {
        if (logical.autoAttach.has(session)) return {};
        logical.autoAttach.add(session);
        for (const child of tab.children.values()) {
          if ((child.parent ?? root) === session)
            this.#deliver(tab, logical, session, "Target.attachedToTarget", {
              ...child.info,
              waitingForDebugger: false,
            });
        }
        if (
          [...tab.channels].some(
            (candidate) => candidate !== logical && candidate.autoAttach.has(session),
          )
        )
          return {};
      } else {
        logical.autoAttach.delete(session);
        for (const [id, child] of tab.children) {
          if ((child.parent ?? root) === session)
            this.#deliver(tab, logical, session, "Target.detachedFromTarget", { sessionId: id });
        }
        if ([...tab.channels].some((candidate) => candidate.autoAttach.has(session))) return {};
      }
      params = {
        autoAttach: params.autoAttach === true,
        flatten: true,
        waitForDebuggerOnStart: false,
        ...(params.autoAttach === true
          ? {
              filter: [
                { type: "iframe", exclude: false },
                { type: "worker", exclude: false },
                { exclude: true },
              ],
            }
          : {}),
      };
    }
    return this.#sendCdp(tab, session, method, params);
  }

  #sendCdp(tab: Tab, session: string, method: string, params: CdpParameters) {
    const attachmentId = (tab.attachmentId ??= randomUUID());
    return this.#request({
      action: "cdp",
      shareId: tab.info.shareId,
      attachmentId,
      requestId: randomUUID(),
      method,
      params,
      ...(session ? { sessionId: session } : {}),
    });
  }

  async #request(command: BrowserSourceTabCommand): Promise<CdpParameters> {
    const bytes = Buffer.from(JSON.stringify(command));
    if (
      this.#pending.size >= browserSourceTabPending ||
      this.#pendingBytes + bytes.length > browserSourceTabBufferedBytes
    ) {
      this.#fail();
      throw new Error("Chrome debugger transport overloaded.");
    }
    const completed = Promise.withResolvers<BrowserSourceTabResult>();
    const pending: Reply = {
      shareId: command.shareId,
      attachmentId: command.attachmentId,
      bytes: bytes.length,
      completed,
      timer: setTimeout(() => {
        this.#endReply(command.requestId, pending);
        completed.reject(new Error("Chrome debugger did not answer."));
      }, 30_000),
    };
    this.#pendingBytes += bytes.length;
    this.#pending.set(command.requestId, pending);
    try {
      for (const frame of browserSourceTabParts("tab.command", bytes))
        if (!this.#write(frame)) throw new Error("Chrome debugger connection closed.");
      const reply = await completed.promise;
      if (!reply.ok) throw new Error(reply.error);
      return reply.result;
    } finally {
      this.#endReply(command.requestId, pending);
    }
  }

  #endReply(id: string, pending: Reply): void {
    if (this.#pending.delete(id)) this.#pendingBytes -= pending.bytes;
    clearTimeout(pending.timer);
  }

  #finishReplies(shareId: string, attachmentId: string | undefined): void {
    for (const [id, pending] of this.#pending) {
      if (pending.shareId !== shareId || pending.attachmentId !== attachmentId) continue;
      this.#endReply(id, pending);
      pending.completed.reject(new Error("Chrome debugger detached."));
    }
  }

  #event(event: BrowserSourceTabEvent): void {
    const tab = this.#tabs.get(event.shareId);
    if (!tab || event.attachmentId !== tab.attachmentId) return;
    const session = event.sessionId ?? root;
    if (session && !tab.children.has(session)) return;
    const { method, params } = event;
    if (method === "Target.attachedToTarget") {
      const id = params.sessionId;
      const info = record.safeParse(params.targetInfo);
      if (
        typeof id !== "string" ||
        !info.success ||
        !["iframe", "worker"].includes(String(info.data.type))
      )
        return;
      if (!tab.children.has(id) && tab.children.size >= 1024) {
        this.#fail();
        return;
      }
      tab.children.set(id, { ...(session ? { parent: session } : {}), info: params });
    } else if (method === "Runtime.executionContextCreated") {
      const context = record.safeParse(params.context);
      if (context.success && typeof context.data.id === "number") {
        const contexts = tab.contexts.get(session) ?? new Map();
        if (!contexts.has(context.data.id) && contexts.size >= 1024) {
          this.#fail();
          return;
        }
        contexts.set(context.data.id, params);
        tab.contexts.set(session, contexts);
      }
    } else if (method === "Runtime.executionContextsCleared") {
      tab.contexts.delete(session);
    } else if (
      method === "Runtime.executionContextDestroyed" &&
      typeof params.executionContextId === "number"
    ) {
      tab.contexts.get(session)?.delete(params.executionContextId);
    }
    for (const logical of tab.channels) {
      if (method.startsWith("Target.") && !logical.autoAttach.has(session)) continue;
      if (method.startsWith("Runtime.executionContext") && !logical.runtime.has(session)) continue;
      this.#deliver(tab, logical, session, method, params);
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string")
      this.#forgetChild(tab, params.sessionId);
  }

  #forgetChild(tab: Tab, session: string): void {
    tab.children.delete(session);
    tab.contexts.delete(session);
    for (const logical of tab.channels) {
      logical.runtime.delete(session);
      logical.autoAttach.delete(session);
    }
    for (const [child, facts] of tab.children)
      if (facts.parent === session) this.#forgetChild(tab, child);
  }

  #deliver(
    tab: Tab,
    logical: LogicalChannel,
    session: string,
    method: string,
    params: CdpParameters,
  ): void {
    if (!session) {
      for (const listener of logical.listeners) listener(method, params);
      return;
    }
    const child = tab.children.get(session);
    if (child)
      this.#deliver(tab, logical, child.parent ?? root, "Target.receivedMessageFromTarget", {
        sessionId: session,
        message: JSON.stringify({ method, params }),
      });
  }
}
