import { Effect, Schema } from "effect";
import {
  AppId,
  AppSlug,
  VersionId,
  Tool,
  ToolSearchListing,
  ElicitationFailed,
  invocationAccounts,
  type OwnerId,
  type PluginEngine,
  type ToolSearchInput,
  type ToolSearchPage,
} from "@opensteer/plugin-engine-sdk/core";
import { CurrentMcpExecution, type McpBackend } from "@opensteer/plugin-engine-mcp";
import { GrantId, restrictMcpBackend, type Grant } from "@opensteer/plugin-engine-mcp-auth";
import type { engineAccounts } from "./engine-accounts.js";
import {
  JsonSchema,
  PluginServiceError,
  type PluginCaller,
  type PluginHostProvider,
  type PluginAuthorizationResult,
  type PluginJson,
} from "./engine-protocol.js";

export interface EngineHostCallbacks {
  authorize(input: {
    operation: string;
    plugin?: string;
    tool?: string;
    execution?: string;
  }): Effect.Effect<PluginAuthorizationResult, Error>;
  providers(): Effect.Effect<PluginHostProvider[], Error>;
  call(input: {
    execution: string;
    plugin: string;
    tool: string;
    input: PluginJson;
  }): Effect.Effect<PluginJson, Error>;
}
export function compositeBackend(
  engine: PluginEngine,
  accounts: ReturnType<typeof engineAccounts>,
  owner: OwnerId,
  context: PluginCaller,
  host: EngineHostCallbacks,
): McpBackend<Error> {
  const checked = (operation: string, plugin?: string, tool?: string) =>
    Effect.gen(function* () {
      const execution = yield* CurrentMcpExecution;
      const permission = yield* host.authorize({
        operation,
        ...(plugin === undefined ? {} : { plugin }),
        ...(tool === undefined ? {} : { tool }),
        ...(execution === undefined ? {} : { execution }),
      });
      if (!permission.allowed)
        return yield* Effect.fail(
          new PluginServiceError("forbidden", "Plugin operation is not authorized"),
        );
      return permission;
    });
  const provider = (app: string) =>
    Effect.map(host.providers(), (providers) => providers.find((provider) => provider.id === app));
  const version = (provider: PluginHostProvider) => VersionId.make(provider.version);
  const hostTools = (provider: PluginHostProvider) =>
    provider.tools.map((tool) =>
      Schema.decodeUnknownSync(Tool)({ ...tool, app: provider.id, version: provider.version }),
    );
  const selected = (input: { app: AppId; version?: VersionId | undefined }) =>
    Effect.map(accounts.accounts(input.app, input.version), (accounts) => ({ ...input, accounts }));
  const userLinks = (app: AppId, version?: VersionId) =>
    engine.apps.get({ app, owner }).pipe(
      Effect.flatMap((app) => accounts.resolved(app, version)),
      Effect.map((links) => links.userLinks),
    );
  const searchHost = (
    input: ToolSearchInput,
    providers: readonly PluginHostProvider[],
  ): ToolSearchPage => {
    const words = input.query.toLowerCase().split(/\W+/u).filter(Boolean);
    const items = input.targets.flatMap((target, index) => {
      const provider = providers.find((item) => item.id === target.app);
      if (!provider) return [];
      return hostTools(provider)
        .filter(
          (tool) =>
            (!target.below ||
              tool.name === target.below ||
              tool.name.startsWith(target.below + ".")) &&
            target.scopes.every(
              (scope) =>
                (!scope.readOnly || tool.readOnly === true) &&
                (scope.names.length === 0 || scope.names.includes(tool.name)),
            ) &&
            words.every((word) =>
              [tool.name, tool.description ?? "", provider.name, ...target.labels]
                .join(" ")
                .toLowerCase()
                .includes(word),
            ),
        )
        .map((tool) => ({ target: index, also: [], tool }));
    });
    return { items, remaining: 0, missing: [] };
  };
  const raw: McpBackend<Error> = {
    listApps: (input) =>
      Effect.gen(function* () {
        yield* checked("listApps");
        const installed = yield* engine.apps.list({
          owner,
          ...(input?.ids === undefined ? {} : { ids: input.ids }),
        });
        const providers = (yield* host.providers()).filter(
          (entry) => input?.ids === undefined || input.ids.includes(AppId.make(entry.id)),
        );
        if (
          providers.some((entry) =>
            installed.some((app) => app.id === entry.id || app.slug === entry.slug),
          )
        )
          return yield* Effect.fail(
            new PluginServiceError(
              "invalid",
              "Host provider namespace conflicts with an installed plugin",
            ),
          );
        return [
          ...installed,
          ...providers.map((entry) => ({
            id: AppId.make(entry.id),
            name: entry.name,
            slug: AppSlug.make(entry.slug),
            activeVersion: version(entry),
          })),
        ];
      }),
    listAccounts: (input) =>
      Effect.gen(function* () {
        yield* checked("listAccounts", input.app);
        return (yield* provider(input.app)) ? {} : yield* userLinks(input.app, input.version);
      }),
    listTools: (input, options) =>
      Effect.gen(function* () {
        yield* checked("listTools", input.app);
        const local = yield* provider(input.app);
        if (local)
          return {
            version: version(local),
            accounts: { app: {}, user: {} },
            items: hostTools(local),
            routers: [],
          };
        return yield* engine.tools.list(
          { ...input, accounts: yield* accounts.accounts(input.app, input.version) },
          options,
        );
      }),
    searchableTools: (input, options) =>
      Effect.gen(function* () {
        yield* checked("searchableTools", input.app);
        const local = yield* provider(input.app);
        if (local)
          return {
            listing: ToolSearchListing.make(`host:${local.id}:${local.version}`),
            version: version(local),
            accounts: { app: {}, user: {} },
            routers: [],
          };
        return yield* engine.tools.searchable(
          { ...input, accounts: yield* accounts.accounts(input.app, input.version) },
          options,
        );
      }),
    searchTools: (input) =>
      Effect.gen(function* () {
        yield* checked("searchTools");
        const providers = yield* host.providers();
        const remoteTargets = input.targets
          .map((target, index) => ({ target, index }))
          .filter(({ target }) => !providers.some((provider) => provider.id === target.app));
        const remote = remoteTargets.length
          ? yield* engine.tools.search({
              ...input,
              targets: remoteTargets.map(({ target }) => target),
              offset: 0,
              limit: input.offset + input.limit,
            })
          : { items: [], remaining: 0, missing: [] };
        const local = searchHost(input, providers);
        const all = [
          ...remote.items.map((item) => ({
            ...item,
            target: remoteTargets[item.target]!.index,
            also: item.also.map((index) => remoteTargets[index]!.index),
          })),
          ...local.items,
        ];
        return {
          items: all.slice(input.offset, input.offset + input.limit),
          remaining: Math.max(0, all.length + remote.remaining - input.offset - input.limit),
          missing: remote.missing.map((index) => remoteTargets[index]!.index),
        };
      }),
    callTool: (input, options) =>
      Effect.gen(function* () {
        yield* checked("callTool", input.app, input.tool);
        const local = yield* provider(input.app);
        if (local) {
          const current = hostTools(local).find((tool) => tool.name === input.tool);
          if (
            !current ||
            (input.version !== undefined && input.version !== local.version) ||
            (input.kind !== undefined &&
              input.kind !== (current.readOnly === true ? "query" : "mutation"))
          )
            return yield* Effect.fail(
              new PluginServiceError(
                "invalid",
                "Host tool changed; discover it again before calling",
              ),
            );
          const execution = yield* CurrentMcpExecution;
          if (!execution)
            return yield* Effect.fail(
              new PluginServiceError("invalid", "Host tool call has no execution identity"),
            );
          return {
            status: "completed",
            value: yield* host.call({
              execution,
              plugin: input.app,
              tool: input.tool,
              input: JsonSchema.parse(input.input ?? null),
            }),
          };
        }
        return yield* engine.tools.call(
          { ...input, accounts: yield* accounts.accounts(input.app, input.version) },
          options,
        );
      }),
    resumeInvocation: (pending, response, options) =>
      Effect.gen(function* () {
        yield* checked("resumeInvocation", pending.invocation.app, pending.invocation.tool);
        // Revalidate the reviewed account selection through the current product adapter too.
        const current = yield* accounts.accounts(
          pending.invocation.app,
          pending.invocation.version,
        );
        if (JSON.stringify(current) !== JSON.stringify(invocationAccounts(pending.invocation)))
          return yield* Effect.fail(
            new PluginServiceError(
              "consent-changed",
              "Linked accounts changed while approval was pending",
            ),
          );
        return yield* engine.tools.resume({ requestId: pending.requestId, response }, options);
      }),
    authorizeElicitation: (input) =>
      checked("authorizeElicitation", input.app, input.tool).pipe(
        Effect.asVoid,
        Effect.mapError(() => new ElicitationFailed({ reason: "forbidden" })),
      ),
    listSkills: (input, options) =>
      Effect.gen(function* () {
        yield* checked("listSkills", input.app);
        const selection = yield* selected(input);
        return yield* engine.skills.list({ ...input, accounts: selection.accounts }, options);
      }),
    readSkill: (input) =>
      Effect.gen(function* () {
        yield* checked("readSkill", input.app);
        return yield* engine.skills.read({
          ...input,
          accounts: yield* accounts.accounts(input.app, input.version),
        });
      }),
    findEventSubscription: (input) =>
      checked("findEventSubscription").pipe(
        Effect.andThen(engine.events.find({ ...input, principal: context.caller })),
      ),
    subscribeEvent: ({ key, target, ...input }) =>
      checked("subscribeEvent").pipe(
        Effect.andThen(
          engine.events.subscribe({
            ...input,
            target: target.app === null ? { owner, app: null, event: null } : target,
            key: { ...key, principal: context.caller },
            subject: context.caller,
          }),
        ),
      ),
    unsubscribeEvent: ({ key }) =>
      checked("unsubscribeEvent").pipe(
        Effect.andThen(engine.events.unsubscribe({ ...key, principal: context.caller })),
      ),
  };
  const grant = Effect.gen(function* () {
    const allowed = yield* checked("grant");
    const grants = allowed.grants;
    return {
      id: GrantId.make(context.caller),
      target: { kind: "mcp", mode: context.mode === "automatic" ? "automatic" : "model" },
      policy:
        grants === undefined
          ? { kind: "all" }
          : {
              kind: "tools",
              approval: "client",
              apps: Object.entries(grants)
                .filter(([, access]) => access !== "off")
                .map(([app, access]) => ({
                  app: AppId.make(app),
                  tools: { kind: access === "read-only" ? "readOnly" : "all" },
                })),
            },
    } satisfies Grant;
  });
  return restrictMcpBackend(raw, grant);
}
