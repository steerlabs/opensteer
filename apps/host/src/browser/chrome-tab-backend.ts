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
  decodeNestedCdpMessage,
  invalidNestedMessageRefusal,
  SessionCdpRouterError,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpParameters,
} from "@opensteer/browser-runtime-core";
import { z } from "zod";
import {
  ThisHomeAddressSet,
  isHomeSessionCookieName,
  isLoopbackUrl,
  noHomeAddresses,
  type ThisHomeAddresses,
} from "@opensteer/shared/homeAddress";

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

export class ChromeTabReplyLost extends Error {
  constructor() {
    super("Chrome did not confirm the command outcome.");
  }
}

export class ChromeTabBackend implements BrowserCdpBackend {
  readonly allowsProfileCookieReads = true;
  readonly #tabs = new Map<string, Tab>();
  readonly #listeners = new Set<Listener>();
  readonly #pending = new Map<string, Reply>();
  readonly #detachFailures = new Set<string>();
  readonly #assembly = new BrowserSourceTabAssembly();
  readonly #write: (frame: BrowserSourceTabPart<"tab.command">) => boolean;
  readonly #fail: () => void;
  #pendingBytes = 0;

  /** This Home's addresses as they are now, sent with the command that starts an attachment. */
  readonly #homeAddresses: () => ThisHomeAddresses;

  constructor(
    write: (frame: BrowserSourceTabPart<"tab.command">) => boolean,
    fail: () => void,
    homeAddresses: () => ThisHomeAddresses = () => noHomeAddresses,
  ) {
    this.#write = write;
    this.#fail = fail;
    this.#homeAddresses = homeAddresses;
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

  detachedCleanly(shareId: string): boolean {
    return !this.#detachFailures.delete(shareId);
  }

  close(): void {
    for (const id of this.#tabs.keys()) this.remove(id);
    for (const [id, pending] of this.#pending) {
      this.#endReply(id, pending);
      pending.completed.reject(new ChromeTabReplyLost());
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
          }).catch(() => {
            if (this.#tabs.get(tab.info.shareId) === tab)
              this.#detachFailures.add(tab.info.shareId);
          });
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
      // The one decoder every guard uses: a message that is not a JSON string is refused.
      const decoded = decodeNestedCdpMessage(params.message);
      if (!decoded) throw new SessionCdpRouterError("bad_command", invalidNestedMessageRefusal);
      const request = nestedMessage.parse(decoded);
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
    // The person's own Chrome holds the Home's real cookie (G3): no agent writes, overwrites,
    // deletes or reads it, nor loads the Home's address with it.
    const home = new ThisHomeAddressSet(this.#homeAddresses());
    refuseHomeCookieWork(method, params, home);
    const result = await this.#sendCdp(tab, session, method, params);
    return homeCookieReads.has(method) ? withoutHomeCookieObjects(result, home) : result;
  }

  #sendCdp(tab: Tab, session: string, method: string, params: CdpParameters) {
    const starts = tab.attachmentId === undefined;
    const attachmentId = (tab.attachmentId ??= randomUUID());
    const home = starts ? this.#homeAddresses() : undefined;
    return this.#request({
      action: "cdp",
      shareId: tab.info.shareId,
      attachmentId,
      requestId: randomUUID(),
      method,
      params,
      ...(session ? { sessionId: session } : {}),
      // A new attachment carries this Home's addresses as they are then (D2).
      ...(home && (home.origins.length || home.loopbackPorts.length)
        ? { homeAddresses: { origins: [...home.origins], loopbackPorts: [...home.loopbackPorts] } }
        : {}),
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
        completed.reject(new ChromeTabReplyLost());
      }, 30_000),
    };
    this.#pendingBytes += bytes.length;
    this.#pending.set(command.requestId, pending);
    try {
      for (const frame of browserSourceTabParts("tab.command", bytes))
        if (!this.#write(frame)) throw new ChromeTabReplyLost();
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
      pending.completed.reject(new ChromeTabReplyLost());
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

const homeCookieReads = new Set([
  "Network.getCookies",
  "Network.getAllCookies",
  "Storage.getCookies",
  "Page.getCookies",
]);

/**
 * A cookie of this Home's, by the Home's addresses: on one of its origins' hosts, or, for a Home on
 * this computer's loopback (where every local site shares the host), one of its session cookies.
 */
function isHomeCookie(name: string, domain: string, home: ThisHomeAddressSet): boolean {
  const host = domain.replace(/^\./u, "").replace(/\.$/u, "").toLowerCase();
  const loopback = isLoopbackUrl(
    `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}/`,
  );
  if (loopback) return home.loopbackPorts.length > 0 && isHomeSessionCookieName(name);
  return home.origins.some((origin) => new URL(origin).hostname === host);
}

function refused(method: string): SessionCdpRouterError {
  return new SessionCdpRouterError("forbidden", `${method} is unavailable on a shared Chrome tab.`);
}

/**
 * A cookie write, overwrite or delete aimed at the Home's own cookies is refused, and so is a
 * clear-everything call, which would take them along; so is a credentialed load of the Home.
 */
function refuseHomeCookieWork(
  method: string,
  params: CdpParameters,
  home: ThisHomeAddressSet,
): void {
  if (home.empty) return;
  const aimsAtHome = (cookie: unknown) => {
    if (cookie === null || typeof cookie !== "object") return false;
    const { name, domain, url } = cookie as Record<string, unknown>;
    if (typeof url === "string" && home.includes(url)) return true;
    const host = typeof domain === "string" ? domain : typeof url === "string" ? safeHost(url) : "";
    return isHomeCookie(typeof name === "string" ? name : "", host, home);
  };
  switch (method) {
    case "Network.clearBrowserCookies":
    case "Storage.clearCookies":
      throw refused(method);
    case "Network.setCookie":
    case "Network.deleteCookies":
      if (aimsAtHome(params)) throw refused(method);
      return;
    case "Page.deleteCookie":
      if (typeof params.url === "string" && home.includes(params.url)) throw refused(method);
      return;
    case "Network.setCookies":
    case "Storage.setCookies":
      if (Array.isArray(params.cookies) && params.cookies.some(aimsAtHome)) throw refused(method);
      return;
    case "Network.loadNetworkResource":
      if (home.includes(params.url)) throw refused(method);
      return;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** A cookie read without the Home's own cookies, chosen by the Home's addresses. */
function withoutHomeCookieObjects(result: unknown, home: ThisHomeAddressSet): unknown {
  if (home.empty || result === null || typeof result !== "object") return result;
  const cookies = (result as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return result;
  return {
    ...result,
    cookies: cookies.filter((cookie) => {
      const { name, domain } = (cookie ?? {}) as { name?: unknown; domain?: unknown };
      return !(
        typeof name === "string" &&
        typeof domain === "string" &&
        isHomeCookie(name, domain, home)
      );
    }),
  };
}
