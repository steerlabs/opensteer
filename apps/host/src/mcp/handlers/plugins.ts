import { pluginCaller } from "../../plugins/plugin-authority.js";
import { pluginTargetBlocked } from "../../plugins/target-blocked.js";
import { requestResult } from "../request-result.js";
import { requestPendingGuidance } from "@opensteer/shared/requestGuidance";
import type { PluginCaller } from "../../plugins/engine-protocol.js";
import { z } from "zod";
import { OpensteerError, type Blocked, type UserId } from "@opensteer/core";
import type { OpensteerStore, PluginAgentStore } from "@opensteer/database";
import type { AgentToolHandlers, ToolCall } from "./types.js";
import { requireRun } from "../operations.js";
import type { AgentCaller } from "../agent-caller.js";
import type { PluginService } from "../../plugins/plugin-service.js";
import type { PluginAuthority } from "../../plugins/plugin-authority.js";
import type { PluginExecutions } from "../../plugins/plugin-executions.js";
import type { LocalProviders } from "../../plugins/local-providers.js";
import { operations, type PluginConsent, type PluginInput } from "../../plugins/engine-protocol.js";
import { keysetPage } from "../../plugins/keyset-page.js";
import { engineInstallReceipt } from "../../plugins/engine-storage.js";
import { pluginNamespace } from "../../plugins/provider-names.js";

export class PluginToolHandlers {
  readonly options: {
    service: PluginService;
    /** Device data apps and local servers, which list beside plugins. */
    localProviders?: Pick<LocalProviders, "providers">;
    authority: PluginAuthority;
    executions: PluginExecutions;
    store: OpensteerStore;
    settings: PluginAgentStore;
    folder: (
      caller: AgentCaller,
      directory: string,
    ) => Promise<Extract<PluginInput<"install">, { kind: "files" }>>;
    exportFiles: (
      caller: AgentCaller,
      directory: string,
      files: PluginInput<"install"> & { kind: "files" },
      authorize: () => Promise<void>,
      signal?: AbortSignal,
    ) => Promise<void>;
    publish: (event: import("@opensteer/core").AgentEvent) => void;
    notify: () => void;
    /** Tells the owner's clients their plugins changed. */
    changed?: (owner: UserId) => void;
    removed?: (plugin: string) => void;
  };
  constructor(options: PluginToolHandlers["options"]) {
    this.options = options;
  }
  /**
   * What an agent sees of its plugins, small enough for its context with many installed: local
   * tools counted (plugin_search finds their tools), plugins a page at a time with their newest
   * versions, and one plugin with every kept version when it asks by id.
   */
  async list(c: ToolCall<"opensteer_plugin_list">) {
    const context = this.options.authority.admit(c.caller);
    const first = !c.input.cursor && !c.input.pluginId;
    const settings = await this.options.settings.settings(c.caller.userId);
    const [plugins, local] = await Promise.all([
      this.options.service.list({}, context, c.signal),
      first ? (this.options.localProviders?.providers(context) ?? []) : [],
    ]);
    const access = (id: string) => settings.find((s) => s.pluginId === id)?.access ?? "all";
    const page = c.input.pluginId
      ? { items: plugins.filter(({ id }) => id === c.input.pluginId), cursor: null }
      : keysetPage(plugins, (plugin) => `${plugin.slug}\u0000${plugin.id}`, {
          scope: "agent-plugins",
          cursor: c.input.cursor,
          max: 25,
        });
    let versionCursor: string | null = null;
    return {
      // An agent sees one list: local tools are addressed as tools.<slug> like plugins.
      local: local
        .filter(({ id }) => access(id) !== "off")
        .slice(0, 100)
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          slug: provider.slug,
          access: access(provider.id) as "all" | "read-only",
          status: provider.unavailable ? "unavailable" : "active",
          ...(provider.unavailable
            ? {
                unavailable: provider.unavailable,
                blocked: provider.blocked,
              }
            : {}),
          toolCount: provider.tools.length,
          readOnlyToolCount: provider.tools.filter(({ readOnly }) => readOnly === true).length,
        })),
      plugins: await Promise.all(
        page.items.map(async (plugin) => {
          const detail = await this.options.service.detail(
            { plugin: plugin.id },
            { caller: "personal", mode: "automatic" },
            c.signal,
          );
          const versionPage = c.input.pluginId
            ? await this.options.service.detailSection(
                {
                  plugin: plugin.id,
                  section: "versions",
                  ...(c.input.cursor ? { cursor: c.input.cursor } : {}),
                },
                { caller: "personal", mode: "automatic" },
                c.signal,
              )
            : undefined;
          if (versionPage) versionCursor = versionPage.cursor;
          const versions = z
            .array(z.object({ id: z.string().min(1), createdAt: z.string() }).passthrough())
            .catch([])
            .parse(versionPage?.items ?? detail.versions)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          const missingAccount = Object.entries(detail.plugin.requirements.accounts).some(
            ([requirement, { scope }]) =>
              !detail.links.some(
                (link) => link.requirement === requirement && link.scope === scope,
              ),
          );
          const blocked = !plugin.activeVersion
            ? {
                code: "unavailable",
                message: `${plugin.name} has no active version.`,
                next: "The person can choose an active version in Plugins; continue without it until then.",
              }
            : missingAccount
              ? pluginTargetBlocked({
                  id: plugin.id,
                  name: plugin.name,
                  reason: `${plugin.name} has no active version.`,
                  requirements: detail.plugin.requirements.accounts,
                  links: z
                    .array(z.object({ requirement: z.string(), scope: z.enum(["app", "user"]) }))
                    .parse(detail.links),
                  canRequestAccount: c.caller.kind === "run",
                })
              : undefined;
          return {
            ...(blocked ? { blocked } : {}),
            id: plugin.id,
            name: plugin.name,
            slug: plugin.slug,
            activeVersion: plugin.activeVersion,
            versions: versions
              .slice(0, c.input.pluginId ? 200 : 10)
              .map((version) => ({ id: version.id, active: version.id === plugin.activeVersion })),
            versionCount: detail.versionCount,
            requirements: Object.fromEntries(
              Object.entries(detail.plugin.requirements.accounts).map(([name, r]) => [
                name,
                { scope: r.scope, provider: r.provider },
              ]),
            ),
            access: access(plugin.id) as "all" | "read-only",
            links: detail.links
              .slice(0, 100)
              .map(({ requirement, scope, account }) => ({ requirement, scope, account })),
            status: plugin.activeVersion ? "active" : "unavailable",
          };
        }),
      ),
      cursor: c.input.pluginId ? versionCursor : page.cursor,
    };
  }
  async discoveryResult<
    T extends {
      unavailableApps?:
        | readonly { app: string; name: string; reason: string; blocked?: Blocked | undefined }[]
        | undefined;
    },
  >(context: PluginCaller, result: T) {
    const unavailable = result.unavailableApps;
    if (!unavailable?.length) return result;
    return {
      ...result,
      unavailableApps: await Promise.all(
        unavailable.map(async (entry) => {
          if (entry.blocked) return entry;
          const detail = await this.options.service
            .detail({ plugin: entry.app }, { caller: "personal", mode: "automatic" })
            .catch(() => null);
          return {
            ...entry,
            blocked: pluginTargetBlocked({
              id: entry.app,
              name: entry.name,
              reason: entry.reason,
              canRequestAccount: this.options.authority.caller(context.caller)?.kind === "run",
              requirements: detail?.plugin.requirements.accounts ?? {},
              links: z
                .array(z.object({ requirement: z.string(), scope: z.enum(["app", "user"]) }))
                .parse(detail?.links ?? []),
            }),
          };
        }),
      ),
    };
  }
  async install(c: ToolCall<"opensteer_plugin_install">) {
    const context = this.options.authority.admit(c.caller);
    await this.options.authority.assert(context, "install", c.input.pluginId);
    const i = c.input;
    const key = JSON.stringify([
      c.caller.userId,
      c.caller.key,
      "opensteer_plugin_install",
      c.operationKey,
    ]);
    // A repeat answers from its receipt before the folder is read, so a moved draft cannot hide it.
    const receipt =
      i.source === "folder" ? await engineInstallReceipt(this.options.store.database, key) : null;
    const result = receipt
      ? installedView(operations.install.output.parse(receipt))
      : await this.#install(c, context, key);
    if (result.status === "installed")
      await this.options.settings.recordInstall(
        c.caller.userId,
        result.plugin.id,
        result.version.id,
        i.source === "catalog" ? "catalog" : "agent",
      );
    if (result.status === "installed") this.options.changed?.(c.caller.userId);
    return {
      ...result,
      ...(result.status === "build-error"
        ? {
            next: "Fix the reported source/build errors in the draft folder and call opensteer_plugin_install again. No new version became active.",
          }
        : {}),
    };
  }
  async #install(
    c: ToolCall<"opensteer_plugin_install">,
    context: ReturnType<PluginAuthority["admit"]>,
    key: string,
  ) {
    const i = c.input;
    const input = operations.install.input.parse({
      ...(i.source === "folder"
        ? {
            ...(await this.options.folder(c.caller, z.string().min(1).parse(i.directory))),
            ...(i.pluginId ? { plugin: i.pluginId } : {}),
            ...(i.name ? { name: i.name } : {}),
          }
        : i.source === "catalog"
          ? { kind: "catalog", id: i.catalogId }
          : { kind: i.source, url: i.url, name: i.name }),
      key,
    });
    await c.checkLive?.();
    return this.options.service.install(input, context, c.signal);
  }
  async export(c: ToolCall<"opensteer_plugin_export">) {
    const context = this.options.authority.admit(c.caller);
    const files = await this.options.service.export(
      { plugin: c.input.pluginId, ...(c.input.versionId ? { version: c.input.versionId } : {}) },
      context,
      c.signal,
    );
    await this.options.exportFiles(
      c.caller,
      c.input.directory,
      { kind: "files", files },
      async () => {
        await c.checkLive?.();
        await this.options.authority.assert(context, "export", c.input.pluginId);
      },
      c.signal,
    );
    return {
      directory: c.input.directory,
      files: files.length,
      next: `Edit the draft, then call opensteer_plugin_install with source:folder and pluginId:${c.input.pluginId}.`,
    };
  }
  async #accountRequest(c: ToolCall<"plugin_account_request">) {
    const caller = requireRun(c.caller);
    const context = this.options.authority.admit(caller);
    await this.options.authority.assert(context, "account-request", c.input.pluginId);
    const target = {
      plugin: c.input.pluginId,
      requirement: c.input.requirement,
      scope: c.input.scope,
    };
    const owner = { caller: "personal", mode: "automatic" as const };
    const consent = await this.options.service.reviewAccountLink(target, owner, c.signal);
    const detail = await this.options.service.detail({ plugin: target.plugin }, owner, c.signal);
    const version = detail.plugin.activeVersion;
    const author =
      (version
        ? (
            await this.options.settings.versionAuthors(caller.userId, [
              { pluginId: target.plugin, version },
            ])
          ).get(`${target.plugin}\u0000${version}`)
        : undefined) ?? "agent";
    await this.options.authority.assert(context, "account-request", target.plugin);
    const created = await this.options.store.requests.create({
      callId: `plugin-account:${c.operationKey}`,
      kind: "plugin.account",
      mode: "durable",
      originatingRunId: caller.claims.runId,
      originatingThreadId: caller.thread.id,
      requestedBy: caller.userId,
      requiredActor: "owner",
      payload: { kind: "plugin.account", ...target, consent },
      presentation: {
        kind: "external",
        title: `Connect ${detail.plugin.name}`.slice(0, 240),
        detail: `${c.input.reason}\nLinking trusts this plugin's code. Setup runs with the account before tool approval.`,
        subject: { kind: "plugin.account", id: target.plugin },
        plugin: {
          plugin: { id: target.plugin, name: detail.plugin.name.slice(0, 240), author },
          decision: {
            kind: "account",
            requirement: target.requirement,
            scope: target.scope,
            consent,
          },
        },
      },
    });
    for (const event of created.events) this.options.publish(event);
    return requestResult(
      created.request,
      created.request.status === "pending"
        ? requestPendingGuidance
        : created.request.status === "fulfilled"
          ? "The request was fulfilled. Use plugin_search to check the plugin's current tools."
          : "The request is closed. Continue without this account.",
      created.replayed,
    );
  }
  /** Called after a person-reviewed link commits, including an OAuth completion. */
  async accountLinked(input: {
    owner: UserId;
    plugin: string;
    requirement: string;
    scope: "app" | "user";
    consent: PluginConsent;
    settlementSessionId?: string;
  }) {
    const current = await this.options.service.reviewAccountLink(
      { plugin: input.plugin, requirement: input.requirement, scope: input.scope },
      {
        caller: "personal",
        mode: "automatic",
      },
    );
    if (current.digest !== input.consent.digest)
      throw new OpensteerError({
        code: "conflict",
        message: "Plugin consent changed; review the account link again.",
      });
    const detail = await this.options.service.detail(
      { plugin: input.plugin },
      { caller: "personal", mode: "automatic" },
    );
    if (
      !detail.links.some(
        (link) =>
          link.requirement === input.requirement &&
          link.scope === input.scope &&
          link.consent !== null &&
          typeof link.consent === "object" &&
          !Array.isArray(link.consent) &&
          link.consent.digest === current.digest,
      )
    )
      return;
    const pending = await this.options.store.database
      .selectFrom("requests")
      .select("id")
      .where("kind", "=", "plugin.account")
      .where("status", "=", "pending")
      .where("requestedBy", "=", input.owner)
      .execute();
    for (const row of pending) {
      const request = await this.options.store.requests.get(row.id);
      const p = request?.payload;
      if (
        p?.kind !== "plugin.account" ||
        p.plugin !== input.plugin ||
        p.requirement !== input.requirement ||
        p.scope !== input.scope ||
        p.consent.digest !== input.consent.digest
      )
        continue;
      const result = await this.options.store.requests.settlePluginRequest({
        requestId: row.id,
        resolvedBy: input.owner,
        decision: "fulfilled",
        ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
      });
      for (const event of result.events) this.options.publish(event);
    }
    this.options.notify();
    this.options.changed?.(input.owner);
  }
  handlers(): Partial<AgentToolHandlers> {
    const o = this.options;
    const handlers: Partial<AgentToolHandlers> = {
      opensteer_plugin_catalog: async (c) => {
        const page = await o.service.catalogList(
          { ...c.input, limit: c.input.limit ?? 20 },
          o.authority.admit(c.caller),
          c.signal,
        );
        return {
          items: page.items.map((entry) => ({
            id: entry.id,
            name: entry.name.slice(0, 120),
            description: entry.description.split("\n")[0]!.slice(0, 300),
            accounts: entry.auth
              .slice(0, 8)
              .map((method) =>
                String(method.label ?? method.method ?? method.kind ?? "Account").slice(0, 80),
              ),
          })),
          cursor: page.cursor,
        };
      },
      plugin_skills: (c) => o.service.skills(c.input, o.authority.admit(c.caller), c.signal),
      plugin_resources: (c) =>
        o.service.resourcesRead(
          { ...c.input, outputs: c.caller.kind !== "connection" },
          o.authority.admit(c.caller),
          c.signal,
        ),
      opensteer_plugin_resource_update: async (c) => {
        await c.checkLive?.();
        const result = await o.service.resourcesUpdate(
          {
            ...c.input,
            key: JSON.stringify([c.caller.userId, pluginCaller(c.caller).caller, c.operationKey]),
          },
          o.authority.admit(c.caller),
          c.signal,
        );
        o.changed?.(c.caller.userId);
        return result;
      },
      plugin_search: async (c) => {
        const context = o.authority.admit(c.caller);
        return this.discoveryResult(context, await o.service.search(c.input, context, c.signal));
      },
      plugin_describe: async (c) => {
        const context = o.authority.admit(c.caller);
        return this.discoveryResult(context, await o.service.describe(c.input, context, c.signal));
      },
      plugin_call: (c) => o.executions.execute(c.caller, "call", c.input, c.signal),
      plugin_execute: (c) => o.executions.execute(c.caller, "execute", c.input, c.signal),
      plugin_resume: (c) => o.executions.resume(c.caller, c.input.executionId, c.signal),
      opensteer_plugin_list: (c) => this.list(c),
      opensteer_plugin_install: (c) => this.install(c),
      opensteer_plugin_export: (c) => this.export(c),
      opensteer_plugin_activate: async (c) => {
        await o.service.activate(
          { plugin: c.input.pluginId, version: c.input.versionId },
          o.authority.admit(c.caller),
          c.signal,
        );
        await o.settings.recordActivation(c.caller.userId, c.input.pluginId, c.input.versionId);
        o.changed?.(c.caller.userId);
        return { ok: true };
      },
      opensteer_plugin_remove: async (c) => {
        await o.service.remove({ plugin: c.input.pluginId }, o.authority.admit(c.caller), c.signal);
        await o.executions.cancelPlugin(c.caller.userId, c.input.pluginId);
        o.removed?.(c.input.pluginId);
        o.changed?.(c.caller.userId);
        return { ok: true };
      },
      plugin_account_request: (c) => this.#accountRequest(c),
    };
    const scope = <K extends keyof AgentToolHandlers>(name: K) => {
      const handler = handlers[name] as ((c: ToolCall<K>) => Promise<unknown>) | undefined;
      if (handler)
        handlers[name] = ((c: ToolCall<K>) =>
          o.authority.scoped(c.caller, () => handler(c))) as AgentToolHandlers[K];
    };
    for (const name of Object.keys(handlers) as (keyof AgentToolHandlers)[]) scope(name);
    return handlers;
  }
}

/** A saved install result as the engine answers it, with the plugin's namespaced slug. */
function installedView(result: z.infer<typeof operations.install.output>) {
  return result.status === "installed"
    ? { ...result, plugin: { ...result.plugin, slug: pluginNamespace(result.plugin.slug) } }
    : result;
}
