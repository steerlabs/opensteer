import { OpensteerError, type BrowserSourceId, type UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { createBrowserSessionId, type BrowserSessionId } from "@opensteer/protocol";
import {
  type BrowserSourceTabPart,
  type BrowserSourceTabShared,
  type BrowserSourceTabUnshared,
} from "@opensteer/browser-source-wire/frames";
import {
  boundedJsonSize,
  SessionCdpRouter,
  type StandardCdpAttachment,
} from "@opensteer/browser-runtime-core";
import {
  BrowserUseCdpError,
  type BrowserUseBudget,
  type BrowserUseCall,
  type BrowserUsePort,
  type BrowserUseTarget,
} from "../browser-use/browser-repl-service.js";
import { ChromeTabBackend } from "./chrome-tab-backend.js";
import {
  StandardCdpTickets,
  standardCdpConnectPrefix,
  type CdpAuthority,
  type StandardCdpTicketClaims,
} from "./standard-cdp-tickets.js";
import { routerStandardTransport } from "./standard-cdp-transport.js";

type SourceFrame =
  | BrowserSourceTabPart<"tab.event" | "tab.result">
  | BrowserSourceTabShared
  | BrowserSourceTabUnshared;
type ChromeSource = {
  readonly sourceId: BrowserSourceId;
  readonly ownerId: UserId;
  readonly name: string;
  readonly backend: ChromeTabBackend;
  readonly router: SessionCdpRouter;
  readonly shares: Map<string, Share>;
};
type Share = {
  info: BrowserSourceTabShared;
  readonly source: ChromeSource;
  readonly group: Group;
  readonly clients: Set<StandardCdpAttachment>;
};
type Group = {
  readonly root: string;
  readonly sessionId: BrowserSessionId;
  readonly clients: Set<StandardCdpAttachment>;
  binding?: string;
};

export interface ChromeSharedTab {
  readonly tabId: string;
  readonly sourceId: BrowserSourceId;
  readonly chromeName: string;
  readonly title: string;
  readonly url: string;
  readonly occupiedBy: string | null;
}

type ReplTarget = BrowserUseTarget & {
  readonly client: StandardCdpAttachment;
  readonly share: Share;
};

const forbidden = (message: string) => new OpensteerError({ code: "forbidden", message });
const unavailable = () => forbidden("This Chrome tab is no longer shared.");
const maxSharesPerChrome = 64;

export async function admitOwnChromeTabBinding(
  store: Pick<OpensteerStore, "admitExecution">,
  authority: CdpAuthority,
): Promise<void> {
  const execution = await store.admitExecution({
    ownerUserId: authority.ownerId,
    subject: { kind: "binding", bindingId: authority.agentBindingId },
  });
  if (execution.agentConnection || execution.mode !== "full-access")
    throw forbidden(
      "Shared Chrome tabs are available to the person's own agents with full access.",
    );
  if (execution.runId && !execution.runMode) throw forbidden("This agent task has ended.");
}

export class ChromeSharedTabs {
  readonly standardCdpTickets = new StandardCdpTickets();
  readonly #sources = new Map<BrowserSourceId, ChromeSource>();
  readonly #shares = new Map<string, Share>();
  readonly #admit: (authority: CdpAuthority) => Promise<void>;

  constructor(store: Pick<OpensteerStore, "admitExecution">) {
    this.#admit = (authority) => admitOwnChromeTabBinding(store, authority);
  }

  connectSource(options: {
    sourceId: BrowserSourceId;
    ownerId: UserId;
    name: string;
    write: (frame: BrowserSourceTabPart<"tab.command">) => boolean;
    fail: () => void;
  }): { receive(frame: SourceFrame): void; close(): void } {
    this.closeForSource(options.sourceId);
    const backend = new ChromeTabBackend(options.write, options.fail);
    const source: ChromeSource = {
      ...options,
      backend,
      router: new SessionCdpRouter(backend),
      shares: new Map(),
    };
    this.#sources.set(options.sourceId, source);
    return {
      receive: (frame) => {
        if (this.#sources.get(source.sourceId) !== source) return;
        if (frame.type === "tab.shared") this.#share(source, frame);
        else if (frame.type === "tab.unshared") this.#unshare(source, frame.shareId);
        else backend.read(frame);
      },
      close: () => {
        if (this.#sources.get(source.sourceId) === source) this.closeForSource(source.sourceId);
      },
    };
  }

  async listForBinding(authority: CdpAuthority): Promise<readonly ChromeSharedTab[]> {
    await this.#authorize(authority);
    return [...this.#shares.values()]
      .filter((share) => share.source.ownerId === authority.ownerId)
      .map(({ info, source, group }) => ({
        tabId: info.shareId,
        sourceId: source.sourceId,
        chromeName: source.name,
        title: info.title,
        url: info.url,
        occupiedBy: group.binding ?? null,
      }));
  }

  async issueStandardCdpTicket(input: {
    readonly authority: CdpAuthority;
    readonly tabId: string;
    readonly ttl?: number;
  }): Promise<{ readonly ticket: string; readonly path: string; readonly mode: "session" }> {
    const share = this.#shares.get(input.tabId);
    await this.#requireAccess(input.authority, share);
    const { source, info, group } = share!;
    const ticket = this.standardCdpTickets.issue({
      ...input,
      browserSessionId: group.sessionId,
      mode: "session",
      sharedChromeTab: { sourceId: source.sourceId, tabId: info.shareId },
      facts: {
        profileId: null,
        profileBindingId: null,
        runtimeId: source.sourceId,
        placementKey: info.shareId,
        grantRevision: null,
        agentConnectionId: null,
      },
    });
    return { ticket, path: `${standardCdpConnectPrefix}${ticket}`, mode: "session" };
  }

  async attachStandardCdpForAgent(claims: StandardCdpTicketClaims, signal: AbortSignal) {
    const named = claims.sharedChromeTab;
    const share = named && this.#shares.get(named.tabId);
    if (
      !share ||
      share.source.sourceId !== named.sourceId ||
      share.group.sessionId !== claims.browserSessionId
    )
      throw unavailable();
    const verify = () => this.#requireAccess(claims.authority, share);
    await verify();
    signal.throwIfAborted();
    const overflow = new AbortController();
    const client = this.#open(share, claims.authority.agentBindingId, () => overflow.abort(1013));
    const life = AbortSignal.any([signal, overflow.signal, client.signal]);
    const close = () => client.close();
    life.addEventListener("abort", close, { once: true });
    return { ...routerStandardTransport(client, "session", life), reauthorize: verify };
  }

  browserUsePort(
    authorityForContext: (contextKey: string) => Promise<CdpAuthority>,
  ): BrowserUsePort<ReplTarget> {
    const openPages = new Map<string, Map<string, ReplTarget>>();
    const access = async (call: BrowserUseCall, share?: Share) => {
      call.signal.throwIfAborted();
      const authority = await authorityForContext(call.contextKey);
      if (share) await this.#requireAccess(authority, share);
      call.signal.throwIfAborted();
      return authority;
    };
    return {
      listPages: async (call) => {
        const list = await this.listForBinding(await access(call));
        const pages = list.map((tab) => ({
          tabId: tab.tabId,
          url: tab.url,
          title: tab.title,
          profile: `Chrome · ${tab.chromeName}`,
        }));
        this.#serialize(pages, call);
        return pages;
      },
      openPage: async (tabId, call) => {
        const share = this.#shares.get(tabId);
        if (!share) throw unavailable();
        const authority = await access(call, share);
        const entries = openPages.get(call.contextKey) ?? new Map<string, ReplTarget>();
        const existing = entries.get(tabId);
        if (existing) return existing;
        const client = this.#open(share, authority.agentBindingId);
        try {
          const target = (await client.send({
            method: "Target.attachToTarget",
            parameters: { targetId: share.info.targetId, flatten: true },
          })) as { sessionId: string };
          call.signal.throwIfAborted();
          const opened = {
            tabId,
            targetId: share.info.targetId,
            sessionId: target.sessionId,
            client,
            share,
          };
          const current = entries.get(tabId);
          if (current) {
            client.close();
            return current;
          }
          entries.set(tabId, opened);
          openPages.set(call.contextKey, entries);
          client.signal.addEventListener(
            "abort",
            () => {
              entries.delete(tabId);
              if (!entries.size) openPages.delete(call.contextKey);
            },
            { once: true },
          );
          return opened;
        } catch (error) {
          client.close();
          throw error;
        }
      },
      newPage: async () => {
        throw forbidden("A shared Chrome tab cannot create a new tab.");
      },
      command: async (target, method, params, sessionId, call) => {
        await access(call, target.share);
        this.#serialize(params ?? {}, call);
        try {
          const result = await target.client.send({
            method,
            ...(params ? { parameters: params } : {}),
            sessionId: sessionId ?? target.sessionId,
            replyBudget: {
              maxBytes: call.maxBytes,
              maxDepth: call.maxDepth,
              maxEntries: call.maxEntries,
            },
          });
          call.signal.throwIfAborted();
          return this.#serialize(result ?? null, call);
        } catch (error) {
          if (call.signal.aborted) throw call.signal.reason;
          if (error instanceof BrowserUseCdpError) throw error;
          throw new Error("Shared Chrome command failed.", { cause: error });
        }
      },
      release: (target) => target.client.close(),
      subscribe: (target, onEvent, onEnd, budget) => {
        const remove = target.client.onEvent((event) => {
          try {
            onEvent({
              method: event.method,
              paramsJson: this.#serialize(event.parameters, budget),
              ...(event.sessionId ? { sessionId: event.sessionId } : {}),
            });
          } catch {
            target.client.close();
          }
        });
        target.client.signal.addEventListener("abort", onEnd, { once: true });
        if (target.client.signal.aborted) onEnd();
        return () => {
          remove();
          target.client.signal.removeEventListener("abort", onEnd);
          target.client.close();
        };
      },
    };
  }

  closeForBinding(agentBindingId: string, _reason: string): void {
    this.standardCdpTickets.revoke(agentBindingId);
    for (const { source, group, info } of this.#shares.values()) {
      if (group.binding !== agentBindingId || group.root !== info.shareId) continue;
      source.backend.stopSharing(group.root);
      this.#unshare(source, group.root);
    }
  }

  closeForSource(sourceId: BrowserSourceId): void {
    const source = this.#sources.get(sourceId);
    if (!source) return;
    this.#sources.delete(sourceId);
    for (const share of source.shares.values()) {
      if (share.info.shareId === share.group.root) source.backend.stopSharing(share.info.shareId);
      this.#unshare(source, share.info.shareId);
    }
    source.backend.close();
    void source.router.close();
  }

  close(): void {
    for (const id of this.#sources.keys()) this.closeForSource(id);
  }

  async #authorize(authority: CdpAuthority): Promise<void> {
    if (authority.expiresAt !== undefined && authority.expiresAt <= Date.now()) throw unavailable();
    await this.#admit(authority);
  }

  async #requireAccess(authority: CdpAuthority, expected: Share | undefined): Promise<void> {
    if (!expected || expected.source.ownerId !== authority.ownerId) throw unavailable();
    await this.#authorize(authority);
    if (this.#shares.get(expected.info.shareId) !== expected) throw unavailable();
    if (expected.group.binding && expected.group.binding !== authority.agentBindingId)
      throw forbidden("Another agent is using this shared Chrome tab.");
  }

  #open(share: Share, binding: string, onOverflow?: () => void): StandardCdpAttachment {
    const { source, group } = share;
    if (this.#shares.get(share.info.shareId) !== share) throw unavailable();
    if (group.binding && group.binding !== binding)
      throw forbidden("Another agent is using this shared Chrome tab.");
    const client = source.router.openStandardClient(group.sessionId, {
      wholeContext: false,
      ...(onOverflow ? { onOverflow } : {}),
    });
    group.binding = binding;
    group.clients.add(client);
    share.clients.add(client);
    client.signal.addEventListener(
      "abort",
      () => {
        group.clients.delete(client);
        share.clients.delete(client);
        if (!group.clients.size) delete group.binding;
      },
      { once: true },
    );
    return client;
  }

  #share(source: ChromeSource, info: BrowserSourceTabShared): void {
    const old = this.#shares.get(info.shareId);
    if (old) {
      if (
        old.source !== source ||
        old.info.targetId !== info.targetId ||
        old.info.openerShareId !== info.openerShareId
      )
        throw unavailable();
      old.info = info;
      source.backend.update(info);
      return;
    }
    if (source.shares.size >= maxSharesPerChrome) throw forbidden("Too many shared Chrome tabs.");
    const opener = info.openerShareId ? source.shares.get(info.openerShareId) : undefined;
    if (info.openerShareId && !opener) return;
    const group = opener?.group ?? {
      root: info.shareId,
      sessionId: createBrowserSessionId(),
      clients: new Set<StandardCdpAttachment>(),
    };
    if (!opener)
      source.router.registerSession(group.sessionId, info.targetId, async () => false, "/");
    const share = { info, group, source, clients: new Set<StandardCdpAttachment>() };
    source.shares.set(info.shareId, share);
    this.#shares.set(info.shareId, share);
    source.backend.update(info);
  }

  #unshare(source: ChromeSource, tabId: string): void {
    const share = source.shares.get(tabId);
    if (!share) return;
    source.shares.delete(tabId);
    this.#shares.delete(tabId);
    for (const client of share.clients) client.close();
    if (share.group.root === tabId) void source.router.unregisterSession(share.group.sessionId);
    for (const child of source.shares.values())
      if (child.info.openerShareId === tabId) this.#unshare(source, child.info.shareId);
    source.backend.remove(tabId);
  }

  #serialize(value: unknown, budget: BrowserUseBudget): string {
    if (boundedJsonSize(value, budget) === undefined)
      throw new BrowserUseCdpError(-32000, "Chrome CDP exceeded the REPL message budget.");
    return JSON.stringify(value);
  }
}
