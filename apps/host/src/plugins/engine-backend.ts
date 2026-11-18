import {
  isLocalProviderId,
  localNamespace,
  localToolPath,
  pluginNamespace,
} from "./provider-names.js";
import type { Blocked } from "@opensteer/core";
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
import { UserFacingError } from "@opensteer/plugin-engine-utils/user-facing-error";
import type { ElicitationHandler } from "apps/contracts";
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
  type HostToolResult,
} from "./engine-protocol.js";

/**
 * A device or local-server tool's own refusal or failure. Its text is written by the Host for the
 * agent (offline computer, missing approval, unconfirmed write), never a service's raw reply.
 */
export const HostToolFailed = UserFacingError.define({
  tag: "HostToolFailed",
  status: 422,
  fields: { explanation: Schema.String },
  presentation: ({ explanation }) => ({
    title: "Local tool unavailable",
    description: explanation,
    recovery: { action: "Follow the explanation.", instructions: explanation },
    retryable: false,
  }),
  recorded: () => "Host tool failed",
});
const hostFailure = (error: Error) =>
  error instanceof PluginServiceError && error.code === "tool"
    ? new HostToolFailed({ explanation: error.message })
    : error;

export interface EngineHostCallbacks {
  authorize(input: {
    operation: string;
    plugin?: string;
    tool?: string;
    execution?: string;
  }): Effect.Effect<PluginAuthorizationResult, Error>;
  providers(): Effect.Effect<PluginHostProvider[], Error>;
  call(
    input: {
      execution: string;
      plugin: string;
      tool: string;
      input: PluginJson;
    },
    elicitation: ElicitationHandler | undefined,
  ): Effect.Effect<HostToolResult, Error>;
}
export function compositeBackend(
  engine: PluginEngine,
  accounts: ReturnType<typeof engineAccounts>,
  owner: OwnerId,
  context: PluginCaller,
  host: EngineHostCallbacks,
  direct = false,
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
    isLocalProviderId(app)
      ? Effect.map(host.providers(), (providers) =>
          providers.find((provider) => provider.id === app),
        )
      : Effect.succeed(undefined);
  // An unavailable provider lists nothing; its sentence reaches the agent as the namespace's reason.
  const available = (local: PluginHostProvider) =>
    local.unavailable === undefined
      ? Effect.succeed(local)
      : Effect.fail(new HostToolFailed({ explanation: local.unavailable }));
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
      if (!provider || provider.unavailable) return [];
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
        const providers =
          input?.ids?.some(isLocalProviderId) === false
            ? []
            : (yield* host.providers()).filter(
                (entry) => input?.ids === undefined || input.ids.includes(AppId.make(entry.id)),
              );
        return [
          ...installed.map((app) => ({ ...app, slug: AppSlug.make(pluginNamespace(app.slug)) })),
          ...providers.map((entry) => ({
            id: AppId.make(entry.id),
            name: entry.name,
            slug: AppSlug.make(localNamespace(entry.slug, entry.id)),
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
        if (local) {
          if (!direct) yield* available(local);
          return {
            version: version(local),
            accounts: { app: {}, user: {} },
            items: hostTools(local),
            routers: [],
          };
        }
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
          return yield* available(local).pipe(
            Effect.as({
              listing: ToolSearchListing.make(`host:${local.id}:${local.version}`),
              version: version(local),
              accounts: { app: {}, user: {} },
              routers: [],
            }),
          );
        return yield* engine.tools.searchable(
          { ...input, accounts: yield* accounts.accounts(input.app, input.version) },
          options,
        );
      }),
    searchTools: (input) =>
      Effect.gen(function* () {
        yield* checked("searchTools");
        const providers = input.targets.some(({ app }) => isLocalProviderId(app))
          ? yield* host.providers()
          : [];
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
          if (!direct) yield* available(local);
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
          const result = yield* host
            .call(
              {
                execution,
                plugin: input.app,
                tool: input.tool,
                input: JsonSchema.parse(input.input ?? null),
              },
              options?.elicitation,
            )
            .pipe(Effect.mapError(hostFailure));
          switch (result.kind) {
            case "blocked":
              if (!direct)
                return yield* new HostToolFailed({
                  explanation: `${result.blocked.message} ${result.blocked.next}`,
                });
              return { status: "completed", value: result, toolError: true };
            case "mcp":
              return {
                status: "completed",
                value: JsonSchema.parse(direct ? result : result.result),
                ...(result.result.isError ? { toolError: true as const } : {}),
              };
            case "value":
              return { status: "completed", value: direct ? result : result.value };
          }
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
        const catalog = yield* engine.skills.list(
          { ...input, accounts: selection.accounts },
          options,
        );
        return {
          ...catalog,
          app: { ...catalog.app, slug: AppSlug.make(pluginNamespace(catalog.app.slug)) },
        };
      }),
    readSkill: (input) =>
      Effect.gen(function* () {
        yield* checked("readSkill", input.app);
        const document = yield* engine.skills.read({
          ...input,
          accounts: yield* accounts.accounts(input.app, input.version),
        });
        return {
          ...document,
          app: { ...document.app, slug: AppSlug.make(pluginNamespace(document.app.slug)) },
        };
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
  const grant = (ids?: readonly AppId[]) =>
    Effect.gen(function* () {
      const allowed = yield* checked("grant");
      const grants = allowed.grants;
      const apps =
        grants === undefined
          ? []
          : (ids ?? [
              ...(yield* engine.apps.list({ owner })).map((app) => app.id),
              ...(yield* host.providers()).map((provider) => AppId.make(provider.id)),
            ]);
      return {
        id: GrantId.make(context.caller),
        target: { kind: "mcp", mode: context.mode === "automatic" ? "automatic" : "model" },
        policy:
          grants === undefined
            ? { kind: "all" }
            : {
                kind: "tools",
                approval: "client",
                apps: apps
                  .map((app) => [app, grants[app] ?? "all"] as const)
                  .filter(([, access]) => access !== "off")
                  .map(([app, access]) => ({
                    app: AppId.make(app),
                    tools: { kind: access === "read-only" ? "readOnly" : "all" },
                  })),
              },
      } satisfies Grant;
    });
  // A named operation already has the ids its live setting applies to.
  const restricted = (ids?: readonly AppId[]) => restrictMcpBackend(raw, grant(ids));
  const named = (id: AppId) => restricted([id]);
  return {
    ...restricted(),
    listApps: (input) => restricted(input?.ids).listApps(input),
    listAccounts: (input) => named(input.app).listAccounts(input),
    listTools: (input, options) => named(input.app).listTools(input, options),
    searchableTools: (input, options) => named(input.app).searchableTools(input, options),
    searchTools: (input) => restricted(input.targets.map(({ app }) => app)).searchTools(input),
    callTool: (input, options) => named(input.app).callTool(input, options),
    resumeInvocation: (pending, response, options) =>
      named(pending.invocation.app).resumeInvocation(pending, response, options),
    authorizeElicitation: (input) => named(input.app).authorizeElicitation(input),
    listSkills: (input, options) => named(input.app).listSkills(input, options),
    readSkill: (input) => named(input.app).readSkill(input),
  };
}

export function withLocalBlockers<
  Result extends {
    readonly items: readonly { readonly path: string }[];
    readonly unavailableApps?: readonly { readonly app: string }[];
  },
>(result: Result, providers: readonly PluginHostProvider[]) {
  const appBlockers = new Map<string, Blocked>();
  const toolBlockers = new Map<string, Blocked>();
  for (const provider of providers) {
    if (provider.blocked) appBlockers.set(provider.id, provider.blocked);
    const namespace = localNamespace(provider.slug, provider.id);
    for (const [name, blocked] of Object.entries(provider.toolBlockers ?? {}))
      toolBlockers.set(localToolPath(namespace, name), blocked);
  }
  return {
    ...result,
    items: result.items.map((item) => {
      const blocked = toolBlockers.get(item.path);
      return blocked ? { ...item, blocked } : item;
    }),
    ...(result.unavailableApps
      ? {
          unavailableApps: result.unavailableApps.map((app) => {
            const blocked = appBlockers.get(app.app);
            return blocked ? { ...app, blocked } : app;
          }),
        }
      : {}),
  };
}
