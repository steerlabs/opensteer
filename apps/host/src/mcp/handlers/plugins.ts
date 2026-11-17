import { z } from "zod";
import { OpensteerError, type UserId } from "@opensteer/core";
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
    ) => Promise<void>;
    publish: (event: import("@opensteer/core").AgentEvent) => void;
    notify: () => void;
    /** Tells the owner's clients their plugins changed. */
    changed?: (owner: UserId) => void;
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
          ...(provider.unavailable ? { unavailable: provider.unavailable } : {}),
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
          const versions = z
            .array(z.object({ id: z.string().min(1), createdAt: z.string() }).passthrough())
            .catch([])
            .parse(detail.versions)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          return {
            id: plugin.id,
            name: plugin.name,
            slug: plugin.slug,
            activeVersion: plugin.activeVersion,
            versions: versions
              .slice(0, c.input.pluginId ? 200 : 10)
              .map((version) => ({ id: version.id, active: version.id === plugin.activeVersion })),
            versionCount: versions.length,
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
      cursor: page.cursor,
    };
  }
  async install(c: ToolCall<"opensteer_plugin_install">) {
    const context = this.options.authority.admit(c.caller);
    await this.options.authority.assert(context, "install", c.input.pluginId);
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
      key: JSON.stringify([
        c.caller.userId,
        c.caller.key,
        "opensteer_plugin_install",
        c.operationKey,
      ]),
    });
    await c.checkLive?.();
    const result = await this.options.service.install(input, context, c.signal);
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
  async export(c: ToolCall<"opensteer_plugin_export">) {
    const context = this.options.authority.admit(c.caller);
    const files = await this.options.service.export(
      { plugin: c.input.pluginId, ...(c.input.versionId ? { version: c.input.versionId } : {}) },
      context,
      c.signal,
    );
    await c.checkLive?.();
    await this.options.exportFiles(c.caller, c.input.directory, { kind: "files", files });
    return {
      directory: c.input.directory,
      files: files.length,
      next: `Edit the draft, then call opensteer_plugin_install with source:folder and pluginId:${c.input.pluginId}.`,
    };
  }
  async accountRequest(c: ToolCall<"plugin_account_request">) {
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
    const provenance = (await this.options.settings.settings(caller.userId)).find(
      (s) => s.pluginId === target.plugin,
    );
    const author =
      (detail.plugin.activeVersion
        ? provenance?.versionAuthors[detail.plugin.activeVersion]
        : undefined) ?? "agent";
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
    return {
      status: created.request.status,
      requestId: created.request.id,
      next: "Waiting on the person in Needs you to connect or link an account. Do not collect credentials or repeat the Request; continue other work.",
    };
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
    return {
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
        o.service.resourcesRead(c.input, o.authority.admit(c.caller), c.signal),
      opensteer_plugin_resource_update: async (c) => {
        await c.checkLive?.();
        const result = await o.service.resourcesUpdate(
          c.input,
          o.authority.admit(c.caller),
          c.signal,
        );
        o.changed?.(c.caller.userId);
        return result;
      },
      plugin_search: (c) => o.service.search(c.input, o.authority.admit(c.caller), c.signal),
      plugin_describe: (c) => o.service.describe(c.input, o.authority.admit(c.caller), c.signal),
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
        o.changed?.(c.caller.userId);
        return { ok: true };
      },
      plugin_account_request: (c) => this.accountRequest(c),
    };
  }
}
