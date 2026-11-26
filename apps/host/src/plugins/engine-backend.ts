import {
  isLocalProviderId,
  localNamespace,
  localToolPath,
  pluginNamespace,
} from "./provider-names.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
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
  type ToolListOptions,
} from "@opensteer/plugin-engine-sdk/core";
import { UserFacingError } from "@opensteer/plugin-engine-utils/user-facing-error";
import type { ElicitationHandler } from "apps/contracts";
import { CurrentMcpExecution, type McpBackend, type McpTool } from "@opensteer/plugin-engine-mcp";
import { GrantId, restrictMcpBackend, type Grant } from "@opensteer/plugin-engine-mcp-auth";
import { pluginAccessBlocked } from "./target-blocked.js";
import type { engineAccounts } from "./engine-accounts.js";
import {
  JsonSchema,
  PluginServiceError,
  type PluginCaller,
  type PluginHostProvider,
  type PluginExecutionTarget,
  type PluginAuthorizationResult,
  type PluginJson,
  type HostToolResult,
} from "./engine-protocol.js";

/**
 * A device or local-server tool's own refusal or failure. Its text is written by the Host for the
 * agent (offline computer, missing approval, unconfirmed write), never a service's raw reply. The
 * explanation is the description and the next step the recovery, each said once; a refusal keeps
 * the Host's code, as a direct call reports it.
 */
export const HostToolFailed = UserFacingError.define({
  tag: "HostToolFailed",
  status: 422,
  fields: {
    explanation: Schema.String,
    next: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  },
  code: ({ reason }) => reason ?? "HostToolFailed",
  presentation: ({ explanation, next }) => ({
    title: "Local tool unavailable",
    description: explanation,
    recovery:
      next === undefined
        ? { action: "Follow the message.", instructions: "Do what the message says." }
        : { action: "Follow the next step.", instructions: next },
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
    version?: string;
    write?: boolean;
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
export const accountSelectionDigest = (accounts: unknown) =>
  createHash("sha256").update(canonicalJson(accounts)).digest("hex");

export function compositeBackend(
  engine: PluginEngine,
  accounts: ReturnType<typeof engineAccounts>,
  owner: OwnerId,
  context: PluginCaller,
  host: EngineHostCallbacks,
  direct = false,
  publishedOnly = false,
  recordTarget?: (target: PluginExecutionTarget) => void,
) {
  const namespaces = new Map<string, string>();
  /** What keeps each app, as this backend last listed it. */
  const appBlockers = new Map<string, Blocked>();
  const retained = new Map<string, readonly Tool[]>();
  /**
   * A tool that cannot be called now is listed as it is, with one marker saying why, which the
   * engine shows wherever discovery lists it: plugin_search, plugin_describe and a program's own
   * tools.search alike, and with which it resolves a call to it. What keeps its whole app (the
   * person's Off, or what keeps a local provider) is said once, on the app (see listApps); a tool
   * carries only what keeps it alone (Read-only for a write, one operation's own blocker), also
   * while its app is kept for another reason: a call is about that one operation.
   */
  const projectTool = (
    tool: Tool,
    access: "all" | "read-only" | "off" | undefined,
    local?: PluginHostProvider,
  ): McpTool => {
    if (access === "off") return tool;
    const blocked =
      pluginAccessBlocked(access, tool.readOnly !== true) ?? local?.toolBlockers?.[tool.name];
    return blocked && !(local?.blocked && canonicalJson(blocked) === canonicalJson(local.blocked))
      ? { ...tool, blocked }
      : tool;
  };

  const permissionFor = (
    operation: string,
    plugin?: string,
    tool?: string,
    facts?: { version?: string | undefined; write?: boolean },
  ) =>
    Effect.flatMap(CurrentMcpExecution, (execution) =>
      host.authorize({
        operation,
        ...(plugin === undefined ? {} : { plugin }),
        ...(tool === undefined ? {} : { tool }),
        ...(facts?.version === undefined ? {} : { version: facts.version }),
        ...(facts?.write === undefined ? {} : { write: facts.write }),
        ...(execution === undefined ? {} : { execution }),
      }),
    );
  const forbidden = () => new PluginServiceError("forbidden", "Plugin operation is not authorized");
  const checked = (operation: string, plugin?: string, tool?: string) =>
    permissionFor(operation, plugin, tool).pipe(
      Effect.flatMap((permission) =>
        permission.allowed ? Effect.succeed(permission) : Effect.fail(forbidden()),
      ),
    );
  const provider = (app: string) =>
    isLocalProviderId(app)
      ? Effect.map(host.providers(), (providers) =>
          providers.find((provider) => provider.id === app),
        )
      : Effect.succeed(undefined);
  const version = (provider: PluginHostProvider) => VersionId.make(provider.version);
  const hostTools = (provider: PluginHostProvider) =>
    provider.tools.map((tool) =>
      Schema.decodeUnknownSync(Tool)({ ...tool, app: provider.id, version: provider.version }),
    );
  /**
   * A call the Host refuses: a direct call answers with the blocker as its value; inside a program
   * the call fails with the Host's code, message and next step, so the program cannot read a
   * refusal as a result.
   */
  const refused = (blocked: Blocked) =>
    direct
      ? Effect.succeed({
          status: "completed" as const,
          value: { kind: "blocked" as const, blocked },
          toolError: true as const,
        })
      : Effect.fail(
          new HostToolFailed({
            explanation: blocked.message,
            next: blocked.next,
            reason: blocked.code,
          }),
        );
  const wrapDirectResult = <T extends { status: string }>(result: T): T =>
    direct && result.status === "completed" && "value" in result
      ? { ...result, value: { kind: "value", value: result.value } }
      : result;
  const selected = (input: { app: AppId; version?: VersionId | undefined }) =>
    Effect.map(accounts.accounts(input.app, input.version), (accounts) => ({ ...input, accounts }));
  const userLinks = (app: AppId, version?: VersionId) =>
    engine.apps.get({ app, owner }).pipe(
      Effect.flatMap((app) => accounts.resolved(app, version)),
      Effect.map((links) => links.userLinks),
    );
  const listCloud = (
    input: Parameters<McpBackend<Error>["listTools"]>[0],
    options: ToolListOptions | undefined,
    off: boolean,
  ) =>
    Effect.gen(function* () {
      const selection = yield* accounts.accounts(input.app, input.version);
      return yield* engine.tools.list(
        { ...input, accounts: selection },
        off ? { ...options, storedOnly: true } : options,
      );
    });
  const searchHost = (
    input: ToolSearchInput,
    providers: ReadonlyMap<string, { name: string; tools: readonly Tool[] }>,
  ): ToolSearchPage => {
    const words = input.query.toLowerCase().split(/\W+/u).filter(Boolean);
    const items = input.targets.flatMap((target, index) => {
      const provider = providers.get(target.app);
      if (!provider) return [];
      return provider.tools
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
        const { grants, visible } = yield* checked("listApps");
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
        const listing = [
          ...installed.map((app) => ({ ...app, slug: AppSlug.make(pluginNamespace(app.slug)) })),
          ...providers.map((entry) => ({
            id: AppId.make(entry.id),
            name: entry.name,
            slug: AppSlug.make(localNamespace(entry.slug, entry.id)),
            activeVersion: version(entry),
          })),
        ];
        // A selected grant is never told what else the person installed.
        return listing
          .filter((app) => !visible || visible.includes(app.id))
          .map((app) => {
            namespaces.set(app.id, app.slug);
            // The person's setting first, then what keeps a local provider.
            const blocked =
              pluginAccessBlocked(grants?.[app.id], false) ??
              providers.find((entry) => entry.id === app.id)?.blocked;
            if (blocked) appBlockers.set(app.id, blocked);
            else appBlockers.delete(app.id);
            return blocked ? { ...app, blocked } : app;
          });
      }),
    listAccounts: (input) =>
      Effect.gen(function* () {
        const { grants } = yield* checked("listAccounts", input.app);
        return grants?.[input.app] === "off" || (yield* provider(input.app))
          ? {}
          : yield* userLinks(input.app, input.version);
      }),
    listTools: (input, options) =>
      Effect.gen(function* () {
        const { grants } = yield* checked("listTools", input.app);
        const access = grants?.[input.app];
        const local = yield* provider(input.app);
        if (local)
          return {
            version: version(local),
            accounts: { app: {}, user: {} },
            items: hostTools(local).map((tool) => projectTool(tool, access, local)),
            routers: [],
          };
        const page = yield* listCloud(input, options, publishedOnly || access === "off");
        return {
          ...page,
          items: page.items.map((tool) => projectTool(tool, access)),
        };
      }),
    searchableTools: (input, options) =>
      Effect.gen(function* () {
        const { grants } = yield* checked("searchableTools", input.app);
        const local = yield* provider(input.app);
        if (local)
          return {
            listing: ToolSearchListing.make(`host:${local.id}:${local.version}`),
            version: version(local),
            accounts: { app: {}, user: {} },
            routers: [],
          };
        if (publishedOnly || grants?.[input.app] === "off") {
          const page = yield* listCloud(input, { unboundedPages: true }, true);
          retained.set(input.app, page.items);
          return {
            ...page,
            listing: ToolSearchListing.make(`host:${input.app}:${page.version}`),
          };
        }
        return yield* engine.tools.searchable(
          { ...input, accounts: yield* accounts.accounts(input.app, input.version) },
          options,
        );
      }),
    searchTools: (input) =>
      Effect.gen(function* () {
        const { grants } = yield* checked("searchTools");
        const providers = input.targets.some(({ app }) => isLocalProviderId(app))
          ? yield* host.providers()
          : [];
        const remoteTargets = input.targets
          .map((target, index) => ({ target, index }))
          .filter(
            ({ target }) => !isLocalProviderId(target.app) && !target.listing.startsWith("host:"),
          );
        const remote = remoteTargets.length
          ? yield* engine.tools.search({
              ...input,
              targets: remoteTargets.map(({ target }) => target),
              offset: 0,
              limit: input.offset + input.limit,
            })
          : { items: [], remaining: 0, missing: [] };
        const hostCatalog = new Map(
          providers.map((entry) => [
            entry.id,
            {
              name: entry.name,
              tools: hostTools(entry).map((tool) => projectTool(tool, grants?.[entry.id], entry)),
            },
          ]),
        );
        for (const [app, tools] of retained)
          hostCatalog.set(app, {
            name: namespaces.get(app) ?? app,
            // The person may have changed this plugin's access since the listing was kept.
            tools: tools.map((tool) => projectTool(tool, grants?.[app])),
          });
        const local = searchHost(input, hostCatalog);
        const all = [
          ...remote.items.map((item) => ({
            ...item,
            tool: projectTool(item.tool, grants?.[item.tool.app]),
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
        const permission = yield* permissionFor("callTool", input.app, input.tool, {
          version: input.version,
        });
        const blocked = pluginAccessBlocked(permission.grants?.[input.app], input.kind !== "query");
        if (blocked) return yield* refused(blocked);
        if (!permission.allowed) return yield* Effect.fail(forbidden());
        const local = yield* provider(input.app);
        if (local) {
          const current = hostTools(local).find((tool) => tool.name === input.tool);
          if (
            !current ||
            ((permission.pinnedVersion ?? input.version) !== undefined &&
              (permission.pinnedVersion ?? input.version) !== local.version) ||
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
          recordTarget?.({
            plugin: input.app,
            version: local.version,
            write: current.readOnly !== true,
          });
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
              return yield* refused(result.blocked);
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
        const pinned = permission.pinnedVersion;
        if (pinned && (yield* engine.apps.get({ app: input.app, owner })).activeVersion !== pinned)
          return yield* Effect.fail(
            new PluginServiceError("invalid", "The plugin changed after review"),
          );
        const version = pinned ? VersionId.make(pinned) : input.version;
        const selectedVersion =
          version ??
          (recordTarget ? (yield* engine.apps.get({ app: input.app, owner })).activeVersion : null);
        const selection = yield* accounts.accounts(input.app, selectedVersion ?? version);
        if (selectedVersion)
          recordTarget?.({
            plugin: input.app,
            version: selectedVersion,
            write: input.kind !== "query",
            accountSelection: accountSelectionDigest(selection),
          });
        return yield* engine.tools
          .call(
            {
              ...input,
              ...(selectedVersion === null ? {} : { version: selectedVersion }),
              accounts: selection,
            },
            options,
          )
          .pipe(Effect.map(wrapDirectResult));
      }),
    resumeInvocation: (pending, response, options) =>
      Effect.gen(function* () {
        const { app, tool, version } = pending.invocation;
        const permission = yield* permissionFor("resumeInvocation", app, tool, {
          version,
          write: pending.invocation.kind !== "query",
        });
        if (!permission.allowed) return yield* Effect.fail(forbidden());
        if (
          permission.pinnedVersion &&
          (yield* engine.apps.get({ app, owner })).activeVersion !== permission.pinnedVersion
        )
          return yield* Effect.fail(
            new PluginServiceError("invalid", "The plugin changed after review"),
          );
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
        recordTarget?.({
          plugin: app,
          version,
          write: pending.invocation.kind !== "query",
          accountSelection: accountSelectionDigest(current),
        });
        return yield* engine.tools
          .resume({ requestId: pending.requestId, response }, options)
          .pipe(Effect.map(wrapDirectResult));
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
          publishedOnly ? { publishedOnly: true } : options,
        );
        return {
          ...catalog,
          app: { ...catalog.app, slug: AppSlug.make(pluginNamespace(catalog.app.slug)) },
        };
      }),
    readSkill: (input) =>
      Effect.gen(function* () {
        yield* checked("readSkill", input.app);
        const document = yield* engine.skills.read(
          { ...input, accounts: yield* accounts.accounts(input.app, input.version) },
          publishedOnly ? { publishedOnly: true } : undefined,
        );
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
      const visible = allowed.visible;
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
                  .filter((app) => visible === undefined || visible.includes(app))
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
  const backend: McpBackend<Error> = {
    ...restricted(),
    listApps: raw.listApps,
    listAccounts: raw.listAccounts,
    listTools: raw.listTools,
    searchableTools: raw.searchableTools,
    searchTools: raw.searchTools,
    callTool: raw.callTool,
    resumeInvocation: (pending, response, options) =>
      named(pending.invocation.app).resumeInvocation(pending, response, options),
    authorizeElicitation: (input) => named(input.app).authorizeElicitation(input),
    listSkills: (input, options) => named(input.app).listSkills(input, options),
    readSkill: (input) => named(input.app).readSkill(input),
  };
  return {
    ...backend,
    /** What keeps the app a direct call's path names, when it is the person's setting. */
    blockedNamespace: (path: string) => {
      for (const [app, blocked] of appBlockers) {
        const namespace = namespaces.get(app);
        if (blocked.code !== "access_denied" || !namespace) continue;
        const root = localToolPath(namespace);
        if (path.startsWith(root + ".") || path.startsWith(root + "[")) return blocked;
      }
      return undefined;
    },
  };
}
