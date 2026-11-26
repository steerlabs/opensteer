import { agentGrantAllows, BrowserProfileIdSchema, refused, TabIdSchema } from "@opensteer/core";
import { executionAccess, selectedGrantOf, type OpensteerStore } from "@opensteer/database";
import type { ChromeSharedTabs } from "../browser/chrome-shared-tabs.js";
import type { PooledBrowserSend } from "../agent-sessions/agent-session-service.js";
import type { BrowserService } from "../browser/browser-service.js";
import type { CdpAuthority } from "../browser/standard-cdp-tickets.js";
import type { BrowserBindingTabActor } from "../tabs/ports.js";
import type { TabService } from "../tabs/tab-service.js";
import { BrowserReplService, type BrowserUsePort } from "./browser-repl-service.js";
import { createBrowserUsePort, type BrowserUseTabAccess } from "./browser-use-port.js";

type Services = {
  sharedChromeTabs?: Pick<ChromeSharedTabs, "browserUsePort">;
  browser: Pick<
    BrowserService,
    | "attachCdpForAgent"
    | "flushPendingTabDescriptors"
    | "listAgentProfiles"
    | "detachAgentSessionsForBinding"
    | "tabOccupants"
    | "browserBindingEnded"
  > &
    Partial<Pick<BrowserService, "pooledScriptPageWitness">>;
  store: Pick<OpensteerStore, "admitExecution">;
  tabs: Pick<TabService, "browserScriptPages" | "bindBrowserScript" | "open">;
  workerEntry?: URL;
};
type ManagedTarget = Awaited<ReturnType<ReturnType<typeof createBrowserUsePort>["openPage"]>>;
type SharedTarget = Awaited<ReturnType<ReturnType<ChromeSharedTabs["browserUsePort"]>["openPage"]>>;
type Target = ManagedTarget | (SharedTarget & { port: BrowserUsePort<SharedTarget> });

function tabAccess(
  { browser, store, tabs }: Services,
  authority: CdpAuthority,
): BrowserUseTabAccess {
  const actorFor = async (signal: AbortSignal, browserSend?: PooledBrowserSend) => {
    signal.throwIfAborted();
    if (authority.expiresAt !== undefined && authority.expiresAt <= Date.now())
      throw refused("forbidden", "Browser authority expired.");
    const execution = await store.admitExecution({
      ownerUserId: authority.ownerId,
      subject: { kind: "binding", bindingId: authority.agentBindingId },
    });
    signal.throwIfAborted();
    if (!execution.threadId || executionAccess(execution) !== "read-write")
      throw refused("forbidden", "Browser scripts require read-write access for this task.");
    return {
      execution,
      actor: {
        kind: "browser-binding",
        authority,
        threadId: execution.threadId,
        signal,
        ...(browserSend ? { browserSend } : {}),
      } satisfies BrowserBindingTabActor,
    };
  };
  const bind = async (actor: BrowserBindingTabActor, tabId: string) => ({
    binding: await tabs.bindBrowserScript(actor, TabIdSchema.parse(tabId)),
    threadId: actor.threadId,
  });
  return {
    async *pages(call) {
      const { actor, execution } = await actorFor(call.signal, call.browserSend);
      await browser.flushPendingTabDescriptors();
      for await (const row of tabs.browserScriptPages(actor)) {
        if (!row.url || (execution.agentConnection && !row.profileId)) continue;
        if (
          row.pageBinding &&
          browser
            .tabOccupants(authority.ownerId, row.pageBinding.sessionId, row.id)
            .some(({ threadId, holding }) => holding && threadId !== actor.threadId)
        )
          continue;
        yield {
          tabId: row.id,
          url: row.url,
          title: row.title,
          profile: row.profileName ?? "Guest",
        };
      }
    },
    async bind(tabId, signal, browserSend) {
      const { actor, execution } = await actorFor(signal, browserSend);
      await browser.flushPendingTabDescriptors();
      return {
        binding: await tabs.bindBrowserScript(actor, TabIdSchema.parse(tabId), {
          savedProfileOnly: execution.agentConnection !== null,
        }),
        threadId: actor.threadId,
      };
    },
    async open(input, key, signal, browserSend) {
      const { execution, actor } = await actorFor(signal, browserSend);
      const grant = selectedGrantOf(execution);
      const requested = BrowserProfileIdSchema.safeParse(input.profileId).data;
      if (input.profileId !== undefined && !requested)
        throw refused("bad_request", "Use a browser profile ID for profileId.");
      const profiles = await browser.listAgentProfiles(authority.ownerId);
      const granted = profiles.filter(
        ({ id }) =>
          (!requested || requested === id) &&
          (!grant ||
            agentGrantAllows(grant, { kind: "browser-profile", profileId: id }, "read-write")),
      );
      if (!granted.length)
        throw refused("forbidden", "No granted browser profile matches this request.");
      if (granted.length > 1)
        throw refused(
          "bad_request",
          "More than one granted browser profile is available.",
          "Pass the intended profile ID to newPage(url, { profileId }).",
        );
      const { tab } = await tabs.open(
        actor,
        { kind: "page", profileId: granted[0]!.id, url: input.url },
        key,
      );
      return bind(actor, tab.tabId);
    },
  };
}

export class BrowserScriptService {
  readonly #services: Services;
  readonly #bindings = new Map<
    string,
    { ownerId: CdpAuthority["ownerId"]; lifetime: AbortController; contexts: Set<string> }
  >();
  readonly #ports = new Map<
    string,
    BrowserUsePort<ManagedTarget> | { shared: true; value: BrowserUsePort<SharedTarget> }
  >();
  readonly #repl: BrowserReplService<Target>;
  /** The connection's grant revision each context last ran under (null: no connection). */
  readonly #revisions = new Map<string, number | null>();
  #closed = false;

  constructor(services: Services) {
    this.#services = services;
    const byContext = (key: string) => {
      const port = this.#ports.get(key);
      if (!port) throw refused("forbidden", "This browser task has ended.");
      return port;
    };
    this.#repl = new BrowserReplService({
      ...(services.workerEntry ? { workerEntry: services.workerEntry } : {}),
      port: {
        listPages: (call) => {
          const port = byContext(call.contextKey);
          return ("shared" in port ? port.value : port).listPages(call);
        },
        openPage: async (tabId, call) => {
          const port = byContext(call.contextKey);
          if ("shared" in port)
            return { ...(await port.value.openPage(tabId, call)), port: port.value };
          return port.openPage(tabId, call);
        },
        newPage: async (input, call) => {
          const port = byContext(call.contextKey);
          if ("shared" in port)
            throw refused("forbidden", "A shared Chrome tab cannot create a new tab.");
          return port.newPage(input, call);
        },
        command: (target, method, params, sessionId, call) => {
          byContext(call.contextKey);
          if ("share" in target)
            return target.port.command(target, method, params, sessionId, call);
          return target.port.command(target, method, params, sessionId, call);
        },
        rebind: (target, call) => {
          byContext(call.contextKey);
          if ("share" in target || !target.port.rebind)
            throw refused("conflict", "This browser page is stale.");
          return target.port.rebind(target, call);
        },
        release: (target) => {
          if ("share" in target) target.port.release?.(target);
          else target.port.release?.(target);
        },
        subscribe: (target, onEvent, onEnd, budget) =>
          "share" in target
            ? target.port.subscribe(target, onEvent, onEnd, budget)
            : target.port.subscribe(target, onEvent, onEnd, budget),
      },
    });
  }

  async runBrowserScript({
    authority,
    sharedChromeTabId,
    contextKey,
    code,
    signal,
    recheck,
    browserSend,
  }: {
    authority: CdpAuthority;
    sharedChromeTabId?: string;
    contextKey: string;
    code: string;
    signal?: AbortSignal;
    recheck?: () => Promise<void>;
    browserSend?: PooledBrowserSend;
  }) {
    signal?.throwIfAborted();
    if (this.#closed) throw refused("conflict", "The browser script service has closed.");
    if (contextKey.length > 256) throw refused("bad_request", "Browser context key is too long.");
    const { agentBindingId, ownerId } = authority;
    if (authority.expiresAt !== undefined && authority.expiresAt <= Date.now())
      throw refused("forbidden", "Browser authority expired.");
    const execution = await this.#services.store.admitExecution({
      ownerUserId: ownerId,
      subject: { kind: "binding", bindingId: agentBindingId },
    });
    const grantRevision = execution.agentConnection?.grantRevision ?? null;
    const callSignal =
      authority.expiresAt === undefined
        ? signal
        : AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(
              Math.max(1, Math.min(2 ** 31 - 1, authority.expiresAt - Date.now())),
            ),
          ]);
    callSignal?.throwIfAborted();
    if (this.#closed || this.#services.browser.browserBindingEnded(agentBindingId))
      throw refused("forbidden", "This browser task has ended.");
    let binding = this.#bindings.get(agentBindingId);
    if (!binding) {
      binding = { ownerId, lifetime: new AbortController(), contexts: new Set() };
      this.#bindings.set(agentBindingId, binding);
    }
    if (binding.ownerId !== ownerId)
      throw refused("forbidden", "Browser access for this task is unavailable.");
    const key = JSON.stringify([
      agentBindingId,
      ownerId,
      contextKey,
      authority.environmentId,
      authority.expiresAt,
      sharedChromeTabId,
    ]);
    if (!this.#ports.has(key)) {
      if (binding.contexts.size >= 16)
        throw refused("resource_exhausted", "Too many browser contexts for this task.");
      if (sharedChromeTabId === undefined) {
        this.#ports.set(
          key,
          createBrowserUsePort({
            authority,
            browser: this.#services.browser,
            tabs: tabAccess(this.#services, authority),
          }),
        );
      } else {
        const port = this.#services.sharedChromeTabs?.browserUsePort(
          async () => authority,
          sharedChromeTabId,
        );
        if (!port) throw refused("forbidden", "This Chrome tab is no longer shared.");
        this.#ports.set(key, { shared: true, value: port });
      }
      binding.contexts.add(key);
    }
    // No handle survives a grant change, and nothing is kept to decide later: a context that
    // last ran under another revision of its connection's grant is disposed before this call, as
    // ten idle minutes dispose it (its handles, events, globals; the tabs stay open). This call
    // runs in a fresh one, where pages() and openPage decide every tab again. The revision is
    // the one this call's admission read. A call still running in it is refused below as busy,
    // and the context is decided again at the next call.
    if (!this.#repl.busy(key)) {
      if (this.#revisions.has(key) && this.#revisions.get(key) !== grantRevision)
        this.#repl.disposeContext(key);
      this.#revisions.set(key, grantRevision);
    }
    return this.#repl.execute(
      key,
      code,
      callSignal ? AbortSignal.any([callSignal, binding.lifetime.signal]) : binding.lifetime.signal,
      JSON.stringify([ownerId, agentBindingId]),
      recheck,
      browserSend,
    );
  }

  async closeBrowserScriptsForBinding(agentBindingId: string): Promise<void> {
    const binding = this.#bindings.get(agentBindingId);
    if (binding) {
      binding.lifetime.abort();
      this.#bindings.delete(agentBindingId);
      for (const key of binding.contexts) {
        this.#repl.disposeContext(key);
        this.#ports.delete(key);
        this.#revisions.delete(key);
      }
    }
    await this.#services.browser.detachAgentSessionsForBinding(agentBindingId);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const binding of this.#bindings.values()) binding.lifetime.abort();
    this.#bindings.clear();
    this.#ports.clear();
    this.#revisions.clear();
    await this.#repl.close();
  }
}
