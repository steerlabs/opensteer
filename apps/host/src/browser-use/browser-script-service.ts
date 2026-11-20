import { agentGrantAllows, BrowserProfileIdSchema, refused, TabIdSchema } from "@opensteer/core";
import { executionAccess, selectedGrantOf, type OpensteerStore } from "@opensteer/database";
import type { BrowserService } from "../browser/browser-service.js";
import type { CdpAuthority } from "../browser/standard-cdp-tickets.js";
import type { BrowserBindingTabActor } from "../tabs/ports.js";
import type { TabService } from "../tabs/tab-service.js";
import { BrowserReplService, type BrowserUsePort } from "./browser-repl-service.js";
import { createBrowserUsePort, type BrowserUseTabAccess } from "./browser-use-port.js";

type Services = {
  browser: Pick<
    BrowserService,
    | "attachCdpForAgent"
    | "flushPendingTabDescriptors"
    | "listAgentProfiles"
    | "detachAgentSessionsForBinding"
    | "tabOccupants"
    | "browserBindingEnded"
  >;
  store: Pick<OpensteerStore, "admitExecution">;
  tabs: Pick<TabService, "browserScriptPages" | "bindBrowserScript" | "open">;
};
type Target = Awaited<ReturnType<ReturnType<typeof createBrowserUsePort>["openPage"]>>;

function tabAccess(
  { browser, store, tabs }: Services,
  authority: CdpAuthority,
): BrowserUseTabAccess {
  const actorFor = async (signal: AbortSignal) => {
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
      } satisfies BrowserBindingTabActor,
    };
  };
  const bind = async (actor: BrowserBindingTabActor, tabId: string) => ({
    binding: await tabs.bindBrowserScript(actor, TabIdSchema.parse(tabId)),
    threadId: actor.threadId,
  });
  return {
    async *pages(call) {
      const { actor } = await actorFor(call.signal);
      await browser.flushPendingTabDescriptors();
      for await (const row of tabs.browserScriptPages(actor)) {
        if (!row.url) continue;
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
    async bind(tabId, signal) {
      const { actor } = await actorFor(signal);
      await browser.flushPendingTabDescriptors();
      return bind(actor, tabId);
    },
    async open(input, key, signal) {
      const { execution, actor } = await actorFor(signal);
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
  readonly #ports = new Map<string, BrowserUsePort<Target>>();
  readonly #repl: BrowserReplService<Target>;
  #closed = false;

  constructor(services: Services) {
    this.#services = services;
    const byContext = (key: string) => {
      const port = this.#ports.get(key);
      if (!port) throw refused("forbidden", "This browser task has ended.");
      return port;
    };
    this.#repl = new BrowserReplService({
      port: {
        listPages: (call) => byContext(call.contextKey).listPages(call),
        openPage: (tabId, call) => byContext(call.contextKey).openPage(tabId, call),
        newPage: (input, call) => byContext(call.contextKey).newPage(input, call),
        command: (target, method, params, sessionId, call) =>
          byContext(call.contextKey).command(target, method, params, sessionId, call),
        subscribe: (target, onEvent, onEnd, budget) =>
          target.port.subscribe(target, onEvent, onEnd, budget),
      },
    });
  }

  async runBrowserScript({
    authority,
    contextKey,
    code,
    signal,
  }: {
    authority: CdpAuthority;
    contextKey: string;
    code: string;
    signal?: AbortSignal;
  }) {
    signal?.throwIfAborted();
    if (this.#closed) throw refused("conflict", "The browser script service has closed.");
    if (contextKey.length > 256) throw refused("bad_request", "Browser context key is too long.");
    const { agentBindingId, ownerId } = authority;
    if (authority.expiresAt !== undefined && authority.expiresAt <= Date.now())
      throw refused("forbidden", "Browser authority expired.");
    await this.#services.store.admitExecution({
      ownerUserId: ownerId,
      subject: { kind: "binding", bindingId: agentBindingId },
    });
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
      throw refused("forbidden", "This browser binding is unavailable.");
    const key = JSON.stringify([
      agentBindingId,
      ownerId,
      contextKey,
      authority.environmentId,
      authority.expiresAt,
    ]);
    if (!this.#ports.has(key)) {
      if (binding.contexts.size >= 16)
        throw refused("resource_exhausted", "Too many browser contexts for this task.");
      this.#ports.set(
        key,
        createBrowserUsePort({
          authority,
          browser: this.#services.browser,
          tabs: tabAccess(this.#services, authority),
        }),
      );
      binding.contexts.add(key);
    }
    return this.#repl.execute(
      key,
      code,
      callSignal ? AbortSignal.any([callSignal, binding.lifetime.signal]) : binding.lifetime.signal,
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
      }
    }
    await this.#services.browser.detachAgentSessionsForBinding(agentBindingId);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const binding of this.#bindings.values()) binding.lifetime.abort();
    this.#bindings.clear();
    this.#ports.clear();
    await this.#repl.close();
  }
}
