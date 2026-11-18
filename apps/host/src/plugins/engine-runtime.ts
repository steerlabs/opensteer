import {
  pluginDetailPreview,
  pluginScheduleApprovalsPageMax,
  type PluginResourceCategory,
} from "@opensteer/protocol";
import { CurrentPluginRequest } from "./engine-authority.js";
import { projectDirectLocalTools } from "./local-tool-results.js";
import { agentDefinitions, detailSection, detailPreview, previewOutput } from "./engine-detail.js";
import {
  backgroundResourceChanges,
  engineOAuthAttempt,
  scheduledRunPage,
  workflowRunPage,
} from "./engine-storage.js";
import { pluginNamespace } from "./provider-names.js";
import { folderSkills } from "apps/skills";
import { oauthReviewDigest } from "./oauth-review.js";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import {
  Option,
  Result,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
  Scope,
  Schema,
} from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  createPluginEngine,
  toEffectRuntime,
  runtimeAdapter,
  makePluginEngineStorage,
  OwnerId,
  AppId,
  AccountId,
  AccountConnectionId,
  OAuthClientId,
  OAuthAttemptId,
  OAuthClientChoice,
  OAuthClientInputs,
  OAuthBrokerFailed,
  OAuthAttemptRecord,
  FirstPartyOAuthClient,
  aesGcmCredentials,
  type OAuthOptions,
  AppAccounts,
  VersionId,
  ProviderId,
  SourceFiles,
  publicFileKey,
  CurrentActor,
  ToolApprovalTtlMs,
  RepositoryHost,
  WorkflowHost,
  httpEventSender,
  EventAccessRevoked,
  ScheduleInputs,
  StartWorkflow,
  WorkflowApp,
  WorkflowTarget,
  webhookCallback,
  WebhookTarget,
  CompleteWebhookSetup,
  WebhookSetupView,
  RuntimeProtocolFailed,
  type PluginEngine,
} from "@opensteer/plugin-engine-sdk/core";
import { filesystemBlobStore, workerdApps } from "@opensteer/plugin-engine-sdk/node";
import { filesystemRepositories } from "@opensteer/plugin-source";
import { markdownRefusals } from "@opensteer/plugin-engine-sdk/markdown";
import { memoryRegistry } from "@opensteer/plugin-engine-sdk/testing";
import {
  startScheduleWorker,
  ScheduleAccessRevoked,
  deliverEvents,
} from "@opensteer/plugin-engine-sdk/scheduling";
import { createCatalog, officialCatalogUrl } from "@opensteer/plugin-engine-catalog";
import { graphqlAppSource, openapiAppSource } from "@opensteer/plugin-engine-app-templates";
import { safeHttpClient } from "@opensteer/plugin-engine-utils/safe-fetch";
import { defaultUrlPolicy } from "@opensteer/plugin-engine-utils/url-policy";
import {
  makeExecutions,
  executeProgram,
  callTools,
  searchCatalog,
  describeCatalog,
  skills,
  SearchInput,
  SkillsInput,
  InteractionId,
  type McpExecutionResult,
} from "@opensteer/plugin-engine-mcp";
import { engineAccounts, migrateEngineProduct } from "./engine-accounts.js";
import { compositeBackend, withLocalBlockers, type EngineHostCallbacks } from "./engine-backend.js";
import { catalogPage } from "./catalog-page.js";
import { enginePages } from "./engine-pages.js";
import {
  operations,
  callbackOperations,
  PluginServiceError,
  PluginBrokerError,
  executionResultBytes,
  directMcpResultBytes,
  interactionBytes,
  jsonBytes,
  pluginResultTooLarge,
  pluginCallerSubject,
  type EngineInit,
  type PluginCaller,
  type PluginExecution,
  type PluginOperation,
  type PluginCallback,
} from "./engine-protocol.js";
import { z } from "zod";
import {
  ElicitationResponse,
  WorkflowFailure,
  type ElicitationHandler,
  type HostContext,
} from "apps/contracts";

const packagedSkills = (files: Schema.Schema.Type<typeof SourceFiles>) =>
  Effect.tryPromise({
    try: () =>
      folderSkills({
        files: files
          .filter((file) => file.path.startsWith("skills/"))
          .map((file) => {
            if (!("content" in file) || "encoding" in file)
              throw new PluginServiceError("invalid", "Skill resources must be UTF-8 text");
            return { path: file.path, content: file.content };
          }),
      }),
    catch: (error) => (error instanceof Error ? error : new Error("Invalid plugin skill source")),
  });

type Callback = <K extends PluginCallback>(
  operation: K,
  input: z.infer<(typeof callbackOperations)[K]["input"]>,
  elicitation?: ElicitationHandler,
) => Effect.Effect<z.infer<(typeof callbackOperations)[K]["output"]>, Error>;
export async function startEngine(
  config: EngineInit,
  callback: Callback,
  report: (execution: PluginExecution) => void,
  phase: (name: string) => void = () => {},
  changed: (categories: PluginResourceCategory[]) => void = () => {},
) {
  const started = performance.now();
  const scope = Scope.makeUnsafe();
  const services = Layer.mergeAll(
    NodeServices.layer,
    Digest.layerWebCrypto,
    SecureRandom.layerWebCrypto,
    PgClient.layer({
      url: Redacted.make(config.databaseUrl),
      startupParameters: { search_path: "plugin_engine", timezone: "UTC" },
      maxConnections: 6,
    }),
  );
  const managed = ManagedRuntime.make(services);
  const run = <A, E, R extends Layer.Success<typeof services> | Scope.Scope>(
    effect: Effect.Effect<A, E, R>,
    signal?: AbortSignal,
  ) =>
    managed.runPromise(
      effect.pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(ToolApprovalTtlMs, config.limits.interactionTtlMs),
        Effect.provideService(CurrentActor, config.owner),
      ),
      signal === undefined ? undefined : { signal },
    );
  const close = async () => {
    try {
      await managed.runPromise(Scope.close(scope, Exit.void));
    } finally {
      await managed.dispose();
    }
  };
  try {
    const composed = await run(
      Effect.gen(function* () {
        phase("database");
        const sql = yield* SqlClient.SqlClient;
        // The reserved connection holds this session lock across the SDK's own migration transactions.
        const storedDatabase = yield* sql.reserve.pipe(
          Effect.flatMap((connection) =>
            Effect.acquireUseRelease(
              connection.execute("SELECT pg_advisory_lock(735158023)", [], undefined),
              () =>
                Effect.gen(function* () {
                  yield* sql.unsafe("CREATE SCHEMA IF NOT EXISTS plugin_engine");
                  const database = yield* makePluginEngineStorage({ provider: "postgresql" });
                  phase("migrations");
                  yield* database.migrate;
                  phase("product-migrations");
                  yield* migrateEngineProduct(sql);
                  return database;
                }),
              () =>
                connection
                  .execute("SELECT pg_advisory_unlock(735158023)", [], undefined)
                  .pipe(Effect.orDie),
            ),
          ),
          Effect.scoped,
        );
        const database = { ...storedDatabase, reactivity: { ...storedDatabase.reactivity } };
        phase("runtime");
        const owner = OwnerId.make(config.owner);
        const ready = yield* Deferred.make<PluginEngine>();
        const egress = {
          policy: defaultUrlPolicy,
          client: yield* safeHttpClient(defaultUrlPolicy),
        };
        const blobs = filesystemBlobStore({ directory: join(config.directory, "builds") });
        // A personal computer keeps fewer idle plugin isolates than the engine's server defaults
        // (64 loaded, five idle minutes); each holds its own heap in workerd.
        process.env.PLUGIN_ENGINE_APP_WORKERS ??= "16";
        process.env.PLUGIN_ENGINE_APP_WORKER_IDLE_SECONDS ??= "120";
        const local = yield* workerdApps({
          directory: join(config.directory, "workerd"),
          blobs,
          pluginEngine: Deferred.await(ready),
          encryptionKey: Redacted.make(config.secret),
          ...(config.npmRegistry === undefined ? {} : { npmRegistry: config.npmRegistry }),
          ...(config.selfOrigin === undefined ? {} : { selfOrigin: config.selfOrigin }),
        });
        const accountAdapter = engineAccounts({
          sql,
          engine: Deferred.await(ready),
          owner,
          blobs,
          authorizeBackground: (plugin) =>
            Effect.flatMap(CurrentPluginRequest, (request) =>
              callback("authorize", {
                caller: config.owner,
                mode: "automatic",
                operation: request ? "resolve" : "background",
                plugin,
              }),
            ).pipe(
              Effect.flatMap((permission) =>
                permission.allowed
                  ? Effect.void
                  : Effect.fail(
                      new PluginServiceError("forbidden", "Plugin access does not allow this work"),
                    ),
              ),
            ),
        });
        phase("sdk");
        const hostScope = yield* Scope.Scope;
        const repositories = filesystemRepositories(join(config.directory, "repositories"));
        let oauthConfiguration = {
          clients: [],
        } as import("./engine-protocol.js").PluginOAuthConfiguration;
        const configureOAuth = (linked: boolean) =>
          callback("oauthConfiguration", { linked }).pipe(
            Effect.tap((configuration) =>
              Effect.sync(() => {
                oauthConfiguration = configuration;
              }),
            ),
          );
        const brokerCall = <K extends import("./engine-protocol.js").PluginBrokerOperation>(
          operation: K,
          input: import("./engine-protocol.js").PluginBrokerInput<K>,
        ) =>
          callback(operation, input).pipe(
            Effect.mapError(
              (error) =>
                new OAuthBrokerFailed({
                  reason: error instanceof PluginBrokerError ? error.reason : "unavailable",
                }),
            ),
          );
        const oauth: OAuthOptions = {
          httpClient: egress.client,
          clientName: "Opensteer",
          urlPolicy: egress.policy,
          get firstPartyClients() {
            return oauthConfiguration.clients.map((client) =>
              Schema.decodeUnknownSync(FirstPartyOAuthClient)(client),
            );
          },
          get clientMetadataUrl() {
            return (
              oauthConfiguration.metadataUrl ??
              new URL("/v1/plugin-oauth/client-metadata.json", config.origin).href
            );
          },
          get clientMetadataRedirectUri() {
            return (
              oauthConfiguration.metadataRedirectUri ??
              new URL("/v1/plugin-oauth/callback", config.origin).href
            );
          },
          broker: {
            start: (input) =>
              brokerCall("oauthStart", {
                connection: input.connection,
                owner: input.owner,
                binding: { ...input.binding, scopes: [...input.binding.scopes] },
              }),
            pull: (input) =>
              brokerCall("oauthPull", {
                attemptId: input.attemptId,
                binding: { ...input.binding, scopes: [...input.binding.scopes] },
              }).pipe(Effect.map(Redacted.make)),
            refresh: (input) =>
              brokerCall("oauthRefresh", {
                attemptId: input.attemptId,
                resultId: input.resultId,
                binding: { ...input.binding, scopes: [...input.binding.scopes] },
                refreshToken: Redacted.value(input.refreshToken),
                grantedScopes: [...input.grantedScopes],
              }).pipe(Effect.map(Redacted.make)),
            acknowledge: (input) =>
              brokerCall("oauthAcknowledge", {
                attemptId: input.attemptId,
                resultId: input.resultId,
                kind: input.kind,
                binding: { ...input.binding, scopes: [...input.binding.scopes] },
              }).pipe(Effect.asVoid),
            revoke: (input) =>
              brokerCall("oauthRevoke", {
                attemptId: input.attemptId,
                binding: { ...input.binding, scopes: [...input.binding.scopes] },
                tokens: {
                  ...Redacted.value(input.tokens),
                  grantedScopes: [...Redacted.value(input.tokens).grantedScopes],
                },
              }).pipe(Effect.asVoid),
            validate: (binding) => accountAdapter.validateBinding(binding.accountLinkGeneration),
          },
        };
        yield* configureOAuth(true).pipe(Effect.catch(() => Effect.void));
        const credentialAdapter = yield* aesGcmCredentials(
          Redacted.make(config.secret),
          globalThis.crypto,
        );
        const check = (
          input: import("./engine-protocol.js").PluginAuthorization,
          refusal: () => Error = () =>
            new PluginServiceError("forbidden", "Plugin authority changed before dispatch"),
        ) =>
          callback("authorize", input).pipe(
            Effect.flatMap(({ allowed }) => (allowed ? Effect.void : Effect.fail(refusal()))),
          );
        const standing = (plugin: string, refusal?: () => Error) =>
          check(
            { caller: config.owner, mode: "automatic", operation: "background", plugin },
            refusal,
          );
        const beforeResourceWrite = (
          plugin: string,
          action: "deploy" | "activate" | "schedule" | "workflow",
        ) =>
          Effect.gen(function* () {
            const request = yield* CurrentPluginRequest;
            if (request && request.context.caller !== config.owner) {
              return yield* check({
                ...request.context,
                operation: request.operation,
                ...(action === "workflow" ? { write: true } : {}),
                ...(action !== "deploy" || request.plugin ? { plugin } : {}),
              });
            }
            if (action === "workflow") yield* standing(plugin);
          }).pipe(Effect.orDie);
        const nativeRuntime = toEffectRuntime(local.runtime, blobs);
        const dispatch = <A, E, R>(
          input: { app: string } & HostContext,
          write: boolean,
          work: Effect.Effect<A, E, R>,
        ) =>
          Effect.gen(function* () {
            const request = yield* CurrentPluginRequest;
            yield* (
              request
                ? check({
                    ...request.context,
                    operation: request.operation,
                    plugin: input.app,
                    write,
                    ...(request.execution ? { execution: request.execution } : {}),
                  })
                : standing(input.app)
            ).pipe(Effect.mapError(() => new RuntimeProtocolFailed({ reason: "unrecognized" })));
            yield* accountAdapter
              .recheckLinks(input.app, Redacted.value(input.accounts))
              .pipe(Effect.mapError(() => new RuntimeProtocolFailed({ reason: "unrecognized" })));
            return yield* work;
          });
        const runtime = runtimeAdapter({
          ...nativeRuntime,
          call: (input) => dispatch(input, input.kind !== "query", nativeRuntime.call(input)),
          query: (input) => dispatch(input, false, nativeRuntime.query(input)),
          mutate: (input) => dispatch(input, true, nativeRuntime.mutate(input)),
          webhook: (input) => dispatch(input, true, nativeRuntime.webhook(input)),
          workflow: (input) =>
            dispatch(input, input.command.operation !== "workflows", nativeRuntime.workflow(input)),
        });
        const engine = yield* createPluginEngine({
          database,
          secret: Redacted.make(config.secret),
          webhookCallbackPath: (app, subscription) => `/hooks/v1/plugins/${app}/${subscription}`,
          webhookOrigin: () =>
            callback("webhookOrigin", {}).pipe(Effect.map((origin) => origin ?? undefined)),
          git: repositories,
          markdown: markdownRefusals,
          hooks: {
            ...accountAdapter.hooks,
            beforeResourceWrite,
            appRemoving: (app) =>
              Effect.flatMap(CurrentPluginRequest, (request) =>
                request && request.context.caller !== config.owner
                  ? check({ ...request.context, operation: "remove", plugin: app }).pipe(
                      Effect.orDie,
                    )
                  : Effect.void,
              ),
            scheduleApprovalDefault: Effect.map(CurrentPluginRequest, (request) =>
              request?.operation.startsWith("resources")
                ? ("browser" as const)
                : ("automatic" as const),
            ),
            workflowContextResolved: (app, context) =>
              accountAdapter
                .recheckLinks(app, Redacted.value(context.accounts))
                .pipe(Effect.andThen(standing(app))),
          },
          blobs,
          runtime,
          workflows: {
            ...local.workflows,
            start: (run) =>
              Deferred.await(ready).pipe(
                Effect.flatMap((engine) => engine[WorkflowHost].get(run)),
                Effect.flatMap(({ app }) =>
                  standing(app).pipe(
                    Effect.mapError(
                      () => new WorkflowFailure({ reason: "credentials", retryable: false }),
                    ),
                  ),
                ),
                Effect.andThen(local.workflows.start(run)),
              ),
            terminate: (run) =>
              Effect.flatMap(CurrentPluginRequest, (request) =>
                request && request.context.caller !== config.owner && request.plugin
                  ? check({
                      ...request.context,
                      operation: request.operation,
                      plugin: request.plugin,
                    }).pipe(
                      Effect.mapError(
                        () => new WorkflowFailure({ reason: "unavailable", retryable: false }),
                      ),
                    )
                  : Effect.void,
              ).pipe(Effect.andThen(local.workflows.terminate(run))),
          },
          registry: memoryRegistry(),
          cache: { durable: local.declarations },
          background: (work) =>
            Effect.forkIn(
              work.pipe(Effect.provideService(CurrentPluginRequest, undefined)),
              hostScope,
            ).pipe(Effect.as(true)),
          oauth,
          events: {
            sender: httpEventSender(egress),
            // No Opensteer surface subscribes to plugin events yet.
            authorize: () => Effect.fail(new EventAccessRevoked()),
          },
        });
        yield* Effect.forkScoped(backgroundResourceChanges(database, changed));
        yield* Deferred.succeed(ready, engine);
        phase("recovery");
        yield* engine[RepositoryHost].recover;
        yield* Effect.forkScoped(
          engine[RepositoryHost].recover.pipe(
            Effect.catch(() => Effect.void),
            Effect.repeat(Schedule.spaced("10 seconds")),
          ),
        );
        yield* Effect.forkScoped(
          engine[WorkflowHost].reconcile.pipe(
            Effect.catch(() => Effect.void),
            Effect.repeat(Schedule.spaced("5 seconds")),
          ),
        );
        const scheduler = yield* startScheduleWorker(
          engine,
          ({ app }) => standing(app, () => new ScheduleAccessRevoked()),
          { runner: "host", concurrency: 2, pollMilliseconds: 1000 },
        );
        yield* Effect.forkScoped(deliverEvents(engine));
        phase("catalog");
        const catalog = createCatalog({ egress, feedUrl: config.catalogUrl ?? officialCatalogUrl });
        const executions = new Map<
          string,
          {
            view: PluginExecution;
            context: PluginCaller;
            controller: AbortController;
            driving: boolean;
            direct: boolean;
          }
        >();
        const manager = yield* makeExecutions(
          {
            timeoutMs: config.limits.timeoutMs,
            maxToolCalls: config.limits.maxToolCalls,
            interactionTtlMs: config.limits.interactionTtlMs,
          },
          Effect.void,
          {
            issued: () => {},
            read: () => undefined,
            ended: (id, end) => {
              const record = [...executions.values()].find(
                (record) => record.view.interaction?.requestId === id,
              );
              if (record && end === "expired") {
                record.view = {
                  ...record.view,
                  state: "expired",
                  interaction: null,
                  reason: "Interaction expired",
                };
                report(record.view);
                executions.delete(record.view.id);
              }
            },
          },
        );
        const pages = enginePages(engine, local.runtime, blobs, database, accountAdapter);
        return {
          configureOAuth,
          credentialAdapter,
          sql,
          engine,
          owner,
          accountAdapter,
          scheduler,
          catalog,
          manager,
          executions,
          pages,
          blobs,
        };
      }),
    );
    const { engine, owner, accountAdapter, catalog, manager, executions, blobs } = composed;
    const startupMs = performance.now() - started;
    const authorize = (
      context: PluginCaller,
      operation: string,
      plugin?: string,
      execution?: string,
    ) =>
      callback("authorize", {
        ...context,
        operation,
        ...(plugin === undefined ? {} : { plugin }),
        ...(execution === undefined ? {} : { execution }),
      }).pipe(
        Effect.flatMap((result) =>
          result.allowed
            ? Effect.succeed(result)
            : Effect.fail(
                new PluginServiceError("forbidden", "Plugin operation is not authorized"),
              ),
        ),
      );
    const backend = (
      context: PluginCaller,
      execution?: string,
      direct = false,
      providers: EngineHostCallbacks["providers"] = () => callback("providers", context),
    ) =>
      compositeBackend(
        engine,
        accountAdapter,
        owner,
        context,
        {
          authorize: (input) =>
            callback("authorize", {
              ...context,
              ...input,
              ...(execution === undefined ? {} : { execution }),
            }),
          providers,
          call: (input, elicitation) =>
            callback(
              "providerCall",
              {
                ...context,
                ...input,
                ...(execution === undefined ? {} : { execution }),
              },
              elicitation,
            ),
        },
        direct,
      );
    const update = (record: { view: PluginExecution }, value: Partial<PluginExecution>) => {
      record.view = { ...record.view, ...value };
      if (!["running", "waiting", "answered", "completed"].includes(record.view.state))
        delete record.view.result;
      report(record.view);
      if (!["running", "waiting", "answered"].includes(record.view.state))
        executions.delete(record.view.id);
      return record.view;
    };
    const completed = (
      record: { view: PluginExecution; direct: boolean },
      result: McpExecutionResult,
    ) =>
      Effect.gen(function* () {
        const pending = result.status === "approval-required" || result.status === "input-required";
        const presented = record.direct && !pending ? projectDirectLocalTools(result) : result;
        const sizeLimit = pending
          ? interactionBytes
          : z.object({ hostPresentation: z.literal("mcp") }).safeParse(presented).success
            ? directMcpResultBytes
            : executionResultBytes;
        if (jsonBytes(presented) > sizeLimit) {
          if (pending)
            yield* manager.discard(
              record.view.caller,
              Schema.decodeUnknownSync(InteractionId)(result.requestId),
            );
          return update(record, {
            state: "failed",
            interaction: null,
            reason: pluginResultTooLarge,
          });
        }
        return update(record, {
          state: pending ? "waiting" : "completed",
          interaction: pending ? JSON.parse(JSON.stringify(result)) : null,
          result: operations.execute.output.shape.result.parse(
            JSON.parse(JSON.stringify(presented)),
          ),
        });
      });
    const perform = (
      operation: PluginOperation,
      raw: unknown,
      context: PluginCaller,
      signal: AbortSignal,
    ): Effect.Effect<unknown, Error, Scope.Scope> => {
      const fields = z
        .object({
          pluginId: z.string().optional(),
          plugin: z.string().optional(),
          execution: z.string().optional(),
        })
        .parse(raw);
      const plugin = fields.pluginId ?? fields.plugin;
      const change =
        operation === "resourcesUpdate"
          ? operations.resourcesUpdate.input.parse(raw).change
          : undefined;
      const stop =
        change?.action === "workflow.stop" ||
        change?.action === "webhook.remove" ||
        (change?.action === "schedule.configure" && !change.enabled);
      const authorityOperation = stop ? "resourcesStop" : operation;
      return Effect.gen(function* () {
        const permission = yield* authorize(context, authorityOperation, plugin, fields.execution);
        switch (operation) {
          case "health":
            return { pid: process.pid, rss: process.memoryUsage().rss, startupMs };
          case "catalogList": {
            const listing = yield* catalog.list;
            return {
              ...catalogPage(listing.apps, operations.catalogList.input.parse(raw)),
              feed: listing.feed,
            };
          }
          case "catalogDetail": {
            const input = operations.catalogDetail.input.parse(raw);
            const entry = (yield* catalog.list).apps.find((entry) => entry.id === input.id);
            if (!entry)
              return yield* Effect.fail(
                new PluginServiceError("invalid", "Catalog entry not found"),
              );
            return entry;
          }
          case "list": {
            const permission = yield* callback("authorize", { ...context, operation: "list" });
            return (yield* engine.apps.list({ owner }))
              .filter((app) => permission.grants?.[app.id] !== "off")
              .map((app) => ({ ...app, slug: pluginNamespace(app.slug) }));
          }
          case "installed": {
            const input = operations.installed.input.parse(raw);
            const plugins = yield* engine.apps.list({ owner });
            const wanted = input.plugins ? new Set(input.plugins) : null;
            return yield* Effect.forEach(
              wanted ? plugins.filter(({ id }) => wanted.has(id)) : plugins,
              (plugin) =>
                Effect.gen(function* () {
                  const metadata = yield* accountAdapter.metadata(plugin);
                  const versions = input.versions
                    ? yield* engine.apps.versions({ app: plugin.id, owner })
                    : undefined;
                  return {
                    plugin: { ...plugin, slug: pluginNamespace(plugin.slug) },
                    ...metadata,
                    ...(versions
                      ? {
                          versions: versions
                            .slice(0, pluginDetailPreview.versions)
                            .map(({ id, createdAt }) => ({
                              id,
                              createdAt: createdAt.toISOString(),
                            })),
                          versionCount: versions.length,
                        }
                      : {}),
                  };
                }),
            );
          }
          case "scheduleApprovals": {
            const input = operations.scheduleApprovals.input.parse(raw);
            const page = yield* scheduledRunPage(composed.sql, {
              app: input.plugin,
              owner,
              limit: pluginScheduleApprovalsPageMax,
              pending: true,
              ...(input.cursor ? { cursor: input.cursor } : {}),
            });
            return { ...page, next: page.next ?? null };
          }
          case "install": {
            const input = operations.install.input.parse(raw);
            const installed = yield* accountAdapter.once(
              input.key,
              "plugin",
              Effect.gen(function* () {
                let files: Schema.Schema.Type<typeof SourceFiles>;
                let name: string | undefined;
                let app: AppId | undefined;
                if (input.kind === "files") {
                  if (!Schema.is(SourceFiles)(input.files))
                    return {
                      status: "build-error" as const,
                      error: {
                        code: "invalid-source",
                        message:
                          "Plugin source requires unique relative paths and index.ts. Code must be UTF-8 text; binary files belong under ui/public/.",
                      },
                    };
                  files = Schema.decodeUnknownSync(SourceFiles)(input.files);
                  name = input.name;
                  app = input.plugin === undefined ? undefined : AppId.make(input.plugin);
                } else if (input.kind === "catalog") {
                  const prepared = yield* catalog.prepare({ entry: input.id });
                  files = prepared.files;
                  name = (yield* catalog.list).apps.find((entry) => entry.id === input.id)?.name;
                } else if (input.kind === "mcp") {
                  files = (yield* catalog.custom({ ...input, kind: "mcp" })).files;
                  name = input.name;
                } else if (input.kind === "graphql") {
                  files = (yield* graphqlAppSource({
                    name: input.name,
                    url: input.url,
                    methods: {},
                  })).files;
                  name = input.name;
                } else {
                  const client = yield* safeHttpClient(defaultUrlPolicy);
                  const response = yield* client.get(input.url);
                  const document = yield* response.json;
                  files = (yield* openapiAppSource({
                    name: input.name,
                    document: Schema.decodeUnknownSync(
                      Schema.Record(Schema.String, Schema.Unknown),
                    )(document),
                    methods: {},
                    allowedOrigins: [new URL(input.url).origin],
                  })).files;
                  name = input.name;
                }
                const validSkills = yield* packagedSkills(files).pipe(Effect.result);
                if (Result.isFailure(validSkills))
                  return {
                    status: "build-error" as const,
                    error: { code: "invalid-skills", message: validSkills.failure.message },
                  };
                return yield* engine.apps
                  .deploy({
                    owner,
                    ...(app === undefined ? { name: name ?? "Plugin" } : { app }),
                    files,
                  })
                  .pipe(
                    Effect.map((result) => ({
                      status: "installed" as const,
                      plugin: result.app,
                      version: result.version,
                      origin: input.kind,
                    })),
                    Effect.catchTags({
                      VersionBuildFailed: (error) =>
                        Effect.succeed({ status: "build-error" as const, error }),
                      BuildMemoryExceeded: (error) =>
                        Effect.succeed({ status: "build-error" as const, error }),
                    }),
                  );
              }),
              (receipt) => Effect.try(() => operations.install.output.parse(receipt.result)),
              input.kind,
            );
            const result = operations.install.output.parse(JSON.parse(JSON.stringify(installed)));
            return result.status === "installed"
              ? {
                  ...result,
                  plugin: { ...result.plugin, slug: pluginNamespace(result.plugin.slug) },
                }
              : result;
          }
          case "detail": {
            const app = AppId.make(operations.detail.input.parse(raw).plugin);
            const plugin = yield* engine.apps.get({ app, owner });
            const selected = yield* accountAdapter.accounts(app).pipe(Effect.option);
            const read = <A, E>(effect: Effect.Effect<A, E>) =>
              effect.pipe(Effect.catch(() => Effect.succeed(null)));
            return detailPreview({
              plugin: { ...plugin, slug: pluginNamespace(plugin.slug) },
              ...(yield* accountAdapter.metadata(plugin)),
              versions: yield* engine.apps.versions({ app, owner }),
              schedules: Option.isSome(selected)
                ? ((yield* read(
                    engine.schedules.definitions({
                      app,
                      owner,
                      actor: owner,
                      accounts: selected.value,
                    }),
                  )) ?? [])
                : [],
              webhooks: yield* engine.webhooks.list({ app }),
              workflows: Option.isSome(selected)
                ? yield* read(engine.apps.workflows.list({ app, accounts: selected.value }))
                : null,
              tools: Option.isSome(selected)
                ? yield* read(engine.tools.index({ app, accounts: selected.value }))
                : null,
              skills: Option.isSome(selected)
                ? yield* read(engine.skills.list({ app, accounts: selected.value }))
                : null,
              hasPage: (yield* engine.apps.source({ app: plugin.id, owner })).files.some(
                (file) => file.path === "ui/index.html",
              ),
            });
          }
          case "detailSection": {
            const input = operations.detailSection.input.parse(raw);
            const app = AppId.make(input.plugin);
            const plugin = yield* engine.apps.get({ app, owner });
            const accounts =
              input.section === "versions" ? undefined : yield* accountAdapter.accounts(app);
            return detailSection(
              {
                plugin,
                tools:
                  input.section === "tools" ? yield* engine.tools.index({ app, accounts }) : null,
                skills:
                  input.section === "skills" ? yield* engine.skills.list({ app, accounts }) : null,
                versions:
                  input.section === "versions" ? yield* engine.apps.versions({ app, owner }) : [],
              },
              input.section,
              input.cursor,
            );
          }
          case "export": {
            const input = operations.export.input.parse(raw);
            const source = yield* engine.apps.source({
              app: AppId.make(input.plugin),
              owner,
              ...(input.version === undefined ? {} : { version: VersionId.make(input.version) }),
            });
            const size = source.files.reduce(
              (total, file) =>
                total +
                ("object" in file
                  ? file.size
                  : Buffer.byteLength(file.content, "encoding" in file ? "base64" : "utf8")),
              0,
            );
            if (size > 24 * 1024 * 1024)
              return yield* Effect.fail(
                new PluginServiceError("invalid", "Plugin source exceeds the 24 MiB export limit"),
              );
            return yield* Effect.forEach(source.files, (file) =>
              "object" in file
                ? blobs.get(publicFileKey(source.code, file.object)).pipe(
                    Effect.flatMap((found) =>
                      Option.isSome(found) && found.value.length === file.size
                        ? Effect.succeed(found.value)
                        : Effect.fail(
                            new PluginServiceError(
                              "invalid",
                              "Plugin asset is unavailable; export cannot preserve all source files",
                            ),
                          ),
                    ),
                    Effect.map((bytes) => ({
                      path: file.path,
                      content: Buffer.from(bytes).toString("base64"),
                      encoding: "base64" as const,
                    })),
                  )
                : Effect.succeed(file),
            );
          }
          case "versions":
            return yield* engine.apps.versions({
              app: AppId.make(operations.versions.input.parse(raw).plugin),
              owner,
            });
          case "activate": {
            const input = operations.activate.input.parse(raw);
            return yield* engine.apps.activate({
              app: AppId.make(input.plugin),
              version: VersionId.make(input.version),
              owner,
            });
          }
          case "remove":
            return yield* engine.apps.remove({
              app: AppId.make(operations.remove.input.parse(raw).plugin),
              owner,
            });
          case "accounts":
            return yield* engine.accounts.list({ owner });
          case "createApiKeyAccount": {
            const input = operations.createApiKeyAccount.input.parse(raw);
            return yield* accountAdapter.once(
              input.key,
              "account",
              engine.managedAccounts.add({
                owner,
                provider: ProviderId.make(input.provider),
                method: input.method,
                fields: Redacted.make(input.fields),
                ...(input.label === undefined ? {} : { label: input.label }),
              }),
              (receipt) =>
                Effect.try(() => operations.createApiKeyAccount.output.parse(receipt.result)),
            );
          }
          case "removeAccount":
            return yield* accountAdapter.removeAccount(
              Schema.decodeUnknownSync(AccountId)(
                operations.removeAccount.input.parse(raw).account,
              ),
            );
          case "reviewAccountLink":
            return yield* accountAdapter.review(operations.reviewAccountLink.input.parse(raw));
          case "linkAccount": {
            const result = yield* accountAdapter.link(operations.linkAccount.input.parse(raw));
            yield* composed.scheduler.wakeWebhookSources;
            return result;
          }
          case "unlinkAccount":
            yield* accountAdapter.unlink(operations.unlinkAccount.input.parse(raw));
            yield* composed.scheduler.wakeWebhookSources;
            return null;
          case "pinOAuth":
            return yield* accountAdapter.pinConnection(operations.pinOAuth.input.parse(raw));
          case "prepareOAuth":
            return yield* accountAdapter.prepare(operations.prepareOAuth.input.parse(raw));
          case "oauthMethods": {
            const input = operations.oauthMethods.input.parse(raw);
            yield* composed.configureOAuth(input.linked);
            const connection = yield* engine.accountConnections.get({
              connection: AccountConnectionId.make(input.connection),
              owner,
            });
            const methods = [];
            for (const [method, definition] of Object.entries(
              connection.provider.definition.auth,
            )) {
              if (definition.type !== "oauth2") {
                methods.push({
                  method,
                  oneClick: false,
                  setup: { ...definition, kind: "secrets", scopes: [] },
                });
                continue;
              }
              const setup = yield* engine.accountConnections.oauthSetup({
                owner,
                provider: connection.provider.id,
                method,
                redirectUri: input.redirectUri,
              });
              const clients =
                setup.grant === "authorization_code"
                  ? yield* engine.oauthClients.list({ owner, issuer: setup.issuer })
                  : [];
              methods.push({
                method,
                oneClick: setup.firstParty !== undefined,
                setup: { ...setup, kind: "oauth2", clients },
              });
            }
            return methods;
          }
          case "startOAuth": {
            const input = operations.startOAuth.input.parse(raw);
            const configuration = yield* composed.configureOAuth(input.linked);
            if (oauthReviewDigest(configuration) !== input.configurationDigest)
              return yield* Effect.fail(
                new PluginServiceError(
                  "consent-changed",
                  "OAuth client configuration changed since review",
                ),
              );
            yield* accountAdapter.reviewedConnection(input.connection, input.consent);
            const result = yield* engine.accountConnections.startOAuth({
              connection: AccountConnectionId.make(input.connection),
              owner,
              method: input.method,
              redirectUri: input.redirectUri,
              ...(input.client
                ? { client: Schema.decodeUnknownSync(OAuthClientChoice)(input.client) }
                : {}),
            });
            if (result.status !== "redirect" || result.brokerAttemptId) return result;
            const rows = yield* engineOAuthAttempt(composed.sql, input.connection);
            const row = rows[0];
            if (!row)
              return yield* Effect.fail(
                new PluginServiceError("engine", "OAuth preparation is unavailable"),
              );
            const decrypted = yield* composed.credentialAdapter.decrypt(
              OAuthAttemptId.make(row.id),
              Redacted.make(row.encrypted),
            );
            const attempt = yield* Schema.decodeUnknownEffect(OAuthAttemptRecord)(
              Redacted.value(decrypted),
            );
            if (!("server" in attempt))
              return yield* Effect.fail(
                new PluginServiceError("engine", "OAuth relay is unavailable"),
              );
            const connection = yield* engine.accountConnections.get({
              connection: AccountConnectionId.make(input.connection),
              owner,
            });
            const method = connection.provider.definition.auth[input.method];
            const separator = method?.type === "oauth2" ? (method.scopeSeparator ?? " ") : " ";
            return {
              ...result,
              relay: {
                clientId: attempt.client.client_id,
                issuer: attempt.server.issuer_derived ? null : attempt.server.issuer,
                authorizationEndpoint: attempt.server.authorization_endpoint,
                authorizationResponseIssuerParameterSupported:
                  attempt.server.authorization_response_iss_parameter_supported ?? false,
                usesPkce: new URL(result.authorizationUrl).searchParams.has("code_challenge"),
                scopeSeparator: separator,
              },
              scopes: (new URL(result.authorizationUrl).searchParams.get("scope") ?? "")
                .split(separator)
                .filter(Boolean),
            };
          }
          case "completeOAuth": {
            const input = operations.completeOAuth.input.parse(raw);
            const connection = AccountConnectionId.make(input.connection);
            return input.attemptId
              ? yield* engine.managedAccounts.completeBrokeredOAuth({
                  connection,
                  owner,
                  attemptId: input.attemptId,
                })
              : yield* engine.accountConnections.completeOAuth({
                  connection,
                  owner,
                  callbackUrl: Redacted.make(input.callbackUrl ?? ""),
                });
          }
          case "cancelOAuth":
            return yield* engine.accountConnections.cancel({
              connection: AccountConnectionId.make(
                operations.cancelOAuth.input.parse(raw).connection,
              ),
              owner,
            });
          case "oauthStatus":
            return yield* engine.accountConnections.get({
              connection: AccountConnectionId.make(
                operations.oauthStatus.input.parse(raw).connection,
              ),
              owner,
            });
          case "saveOAuthApp": {
            const input = operations.saveOAuthApp.input.parse(raw);
            return yield* accountAdapter.once(
              input.key,
              "oauth-client",
              engine.oauthClients.register(
                Schema.decodeUnknownSync(OAuthClientInputs.register)({ ...input, owner }),
              ),
              (receipt) => Effect.try(() => operations.saveOAuthApp.output.parse(receipt.result)),
            );
          }
          case "removeOAuthApp":
            return yield* engine.oauthClients.remove({
              client: OAuthClientId.make(operations.removeOAuthApp.input.parse(raw).client),
              owner,
            });
          case "search":
          case "describe": {
            // The catalog and its blocker projection share this response's inventory.
            const providers = yield* Effect.cached(callback("providers", context));
            const discovery = backend(context, undefined, false, () => providers);
            const result =
              operation === "search"
                ? yield* searchCatalog(discovery, Schema.decodeUnknownSync(SearchInput)(raw))
                : yield* describeCatalog(discovery, operations.describe.input.parse(raw));
            return withLocalBlockers(result, yield* providers);
          }
          case "skills":
            return yield* skills(Schema.decodeUnknownSync(SkillsInput)(raw), backend(context));
          case "skillFiles": {
            const app = AppId.make(operations.skillFiles.input.parse(raw).plugin);
            const plugin = yield* engine.apps.get({ app, owner });
            if (!plugin.activeVersion)
              return yield* Effect.fail(
                new PluginServiceError("invalid", "Plugin is not deployed"),
              );
            const source = yield* engine.apps.source({
              app,
              owner,
              version: plugin.activeVersion,
            });
            const skills = yield* packagedSkills(source.files);
            const files = skills.flatMap((skill) =>
              skill.files.map((file) => ({
                path: `${skill.name}/${file.path}`,
                content: file.content,
              })),
            );
            return {
              plugin: app,
              slug: pluginNamespace(plugin.slug),
              version: plugin.activeVersion,
              hasPage: source.files.some((file) => file.path === "ui/index.html"),
              files,
            };
          }
          case "call":
          case "execute": {
            const id = randomUUID();
            const controller = new AbortController();
            const record = {
              view: {
                id,
                caller: context.caller,
                state: "running" as const,
                interaction: null,
              } as PluginExecution,
              context,
              controller,
              driving: true,
              direct: operation === "call",
            };
            executions.set(id, record);
            report(record.view);
            const abort = () => controller.abort();
            signal.addEventListener("abort", abort, { once: true });
            try {
              const program =
                operation === "call"
                  ? callTools(operations.call.input.parse(raw))
                  : executeProgram(operations.execute.input.parse(raw).code);
              const result = yield* Effect.tryPromise({
                try: () =>
                  run(
                    manager
                      .execute(
                        context.caller,
                        backend(context, id, record.direct),
                        program,
                        "result",
                        context.mode === "automatic" ? "client" : "ask",
                      )
                      .pipe(
                        Effect.provideService(CurrentPluginRequest, {
                          context,
                          operation: "call",
                          execution: id,
                        }),
                      ),
                    controller.signal,
                  ),
                catch: (error) =>
                  error instanceof Error ? error : new Error("Plugin execution failed"),
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    controller.abort();
                    update(record, { state: "cancelled", interaction: null });
                  }),
                ),
                Effect.tapError(() =>
                  Effect.sync(() => {
                    update(record, {
                      state: controller.signal.aborted ? "cancelled" : "failed",
                      interaction: null,
                    });
                  }),
                ),
              );
              return yield* completed(record, result);
            } finally {
              record.driving = false;
              signal.removeEventListener("abort", abort);
            }
          }
          case "executions":
            return [...executions.values()]
              .filter((record) => record.context.caller === context.caller)
              .map((record) => record.view);
          case "answer":
          case "resume":
          case "cancel": {
            const input =
              operation === "answer"
                ? operations.answer.input.parse(raw)
                : operations.resume.input.parse(raw);
            const record = executions.get(input.execution);
            if (
              !record ||
              record.context.caller !== context.caller ||
              record.context.mode !== context.mode
            )
              return yield* Effect.fail(
                new PluginServiceError("invalid", "Execution is unavailable to this caller"),
              );
            if (operation === "cancel") {
              record.controller.abort();
              if (record.view.interaction)
                yield* manager.discard(
                  context.caller,
                  Schema.decodeUnknownSync(InteractionId)(record.view.interaction.requestId),
                );
              return update(record, { state: "cancelled", interaction: null });
            }
            if (record.driving)
              return yield* Effect.fail(
                new PluginServiceError("invalid", "Execution already has a driver"),
              );
            const interaction = record.view.interaction;
            if (!interaction)
              return yield* Effect.fail(
                new PluginServiceError("invalid", "Execution has no open interaction"),
              );
            const requestId = Schema.decodeUnknownSync(InteractionId)(interaction.requestId);
            const pending = yield* manager.pendingInteraction(context.caller, requestId);
            if (pending)
              yield* backend(context, record.view.id, record.direct).authorizeElicitation(
                pending.status === "approval-required"
                  ? { app: pending.invocation.app, tool: pending.invocation.tool }
                  : pending.tool,
              );
            if (operation === "answer") {
              const answered = yield* manager.answerInBrowser(
                context.caller,
                requestId,
                Schema.decodeUnknownSync(ElicitationResponse)(
                  operations.answer.input.parse(raw).response,
                ),
              );
              return answered.status === "answered"
                ? update(record, { state: "answered" })
                : update(record, { state: "expired", interaction: null });
            }
            const response = yield* manager.browserAnswer(context.caller, requestId, 0);
            if (!response)
              return yield* Effect.fail(
                new PluginServiceError("invalid", "The interaction has not been answered"),
              );
            record.driving = true;
            const abort = () => record.controller.abort();
            signal.addEventListener("abort", abort, { once: true });
            try {
              return yield* completed(
                record,
                yield* Effect.tryPromise({
                  try: () =>
                    run(
                      manager
                        .resume(context.caller, backend(context, record.view.id, record.direct), {
                          requestId,
                          response,
                        })
                        .pipe(
                          Effect.provideService(CurrentPluginRequest, {
                            context,
                            operation: "resume",
                            execution: record.view.id,
                          }),
                        ),
                      record.controller.signal,
                    ),
                  catch: (error) =>
                    error instanceof Error ? error : new Error("Plugin resume failed"),
                }),
              );
            } finally {
              record.driving = false;
              signal.removeEventListener("abort", abort);
            }
          }
          case "resourcesRead": {
            const input = operations.resourcesRead.input.parse(raw);
            const app = AppId.make(input.pluginId);
            yield* engine.apps.get({ app, owner });
            // Definitions come once, with the first page; later pages carry history alone.
            const definitions = (operation: "workflows.list" | "schedules.definitions") =>
              input.cursor
                ? Effect.succeed({})
                : manage({ operation, input: { app } }).pipe(
                    Effect.map((value) => ({ definitions: agentDefinitions(value) })),
                    Effect.catch(() => Effect.succeed({ definitions: null })),
                  );
            const cursor = input.cursor ? { cursor: input.cursor } : {};
            if (input.resource === "workflows") {
              const page = yield* workflowRunPage(composed.sql, { app, limit: 10, ...cursor });
              return {
                items: yield* Effect.forEach(page.runs, (run) =>
                  input.outputs &&
                  permission.grants?.[app] !== "off" &&
                  (run.status === "complete" || run.status === "errored")
                    ? engine.apps.workflowRuns
                        .get({
                          app,
                          run: Schema.decodeUnknownSync(WorkflowTarget.fields.run)(run.id),
                        })
                        .pipe(Effect.map(previewOutput))
                    : Effect.succeed(run),
                ),
                ...(page.next ? { next: page.next } : {}),
                ...(yield* definitions("workflows.list")),
              };
            }
            if (input.resource === "webhooks") return yield* engine.webhooks.list({ app });
            const page = yield* scheduledRunPage(composed.sql, {
              app,
              owner,
              limit: 20,
              ...cursor,
            });
            return {
              ...(yield* definitions("schedules.definitions")),
              ...(input.cursor ? {} : { schedules: yield* engine.schedules.list({ app, owner }) }),
              runs: page.runs,
              ...(page.next ? { next: page.next } : {}),
            };
          }
          case "resourcesUpdate": {
            const parsed = operations.resourcesUpdate.input.parse(raw);
            const app = parsed.pluginId;
            const input = parsed.change;
            switch (input.action) {
              case "schedule.configure":
                return yield* manage({
                  operation: "schedules.configure",
                  input: {
                    app,
                    name: input.schedule,
                    enabled: input.enabled,
                    key: parsed.key ?? null,
                  },
                });
              case "schedule.run":
                return yield* accountAdapter.committed(
                  parsed.key,
                  "schedule-run",
                  manage({
                    operation: "schedules.runNow",
                    input: { app, name: input.schedule, copy: input.scheduleId },
                  }),
                );
              case "workflow.start":
                return yield* manage({
                  operation: "workflowRuns.start",
                  input: {
                    app,
                    workflow: input.workflow,
                    input: input.input,
                    key: createHash("sha256")
                      .update(JSON.stringify([pluginCallerSubject(context.caller), app, input.key]))
                      .digest("hex"),
                  },
                });
              case "workflow.stop":
                return yield* manage({
                  operation: "workflowRuns.stop",
                  input: { app, run: input.runId },
                });
              case "webhook.remove":
                return yield* manage({
                  operation: "webhooks.remove",
                  input: { app, subscription: input.webhookId },
                });
            }
          }
          case "manage":
            return yield* manage(operations.manage.input.parse(raw));
          case "page":
            return yield* composed.pages(raw);
          case "webhook": {
            const input = operations.webhook.input.parse(raw);
            const incoming = HttpServerRequest.fromWeb(
              new Request(input.request.url, {
                method: input.request.method,
                headers: input.request.headers,
                ...(input.request.method === "GET" || input.request.method === "HEAD"
                  ? {}
                  : { body: Buffer.from(input.request.body, "base64") }),
              }),
            );
            const response = yield* webhookCallback(engine).pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, incoming),
              Effect.provideService(HttpRouter.RouteContext, {
                route: HttpRouter.route("*", "*", HttpServerResponse.empty()),
                params: { appId: input.plugin, subscriptionId: input.subscription },
              }),
            );
            return HttpServerResponse.toWeb(response);
          }
        }
      }).pipe(
        Effect.provideService(CurrentActor, owner),
        Effect.provideService(CurrentPluginRequest, {
          context,
          operation: authorityOperation,
          ...(plugin === undefined ? {} : { plugin }),
        }),
      );
    };
    const manage = (
      input: z.infer<typeof operations.manage.input>,
    ): Effect.Effect<unknown, Error> => {
      const data = {
        ...input.input,
        owner,
        ...(input.input.actor === undefined && input.input.scope !== "user"
          ? {}
          : { actor: owner }),
      };
      const decode = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownEffect(schema)(data);
      const linked = <I extends { app: AppId; version?: VersionId | undefined }, A, E>(
        schema: Schema.Codec<I, unknown>,
        fn: (
          input: I & { accounts: Schema.Schema.Type<typeof AppAccounts> },
        ) => Effect.Effect<A, E>,
      ) =>
        decode(schema).pipe(
          Effect.flatMap((input) =>
            accountAdapter
              .accounts(input.app, input.version)
              .pipe(Effect.flatMap((accounts) => fn({ ...input, accounts }))),
          ),
        );
      switch (input.operation) {
        case "schedules.definitions":
          return linked(ScheduleInputs.definitions, (data) =>
            engine.schedules.definitions({ ...data, actor: owner }),
          );
        case "schedules.list":
          return decode(ScheduleInputs.list).pipe(Effect.flatMap(engine.schedules.list));
        case "schedules.configure":
          return accountAdapter.committed(
            typeof input.input.key === "string" ? input.input.key : undefined,
            "schedule-configuration",
            Effect.gen(function* () {
              const app = AppId.make(String(input.input.app));
              const saved = (yield* engine.schedules.list({ app, owner })).find(
                (schedule) =>
                  schedule.name === input.input.name &&
                  (schedule.actor === null || schedule.actor === owner),
              );
              if (saved)
                return yield* engine.schedules.update({
                  app,
                  name: saved.name,
                  copy: saved.id,
                  owner,
                  enabled: input.input.enabled === true,
                  ...(input.input.approvalMode === undefined
                    ? {}
                    : {
                        approvalMode: Schema.decodeUnknownSync(
                          ScheduleInputs.configure.fields.approvalMode,
                        )(input.input.approvalMode),
                      }),
                });
              const definitions = yield* engine.schedules.definitions({
                app,
                actor: owner,
                accounts: yield* accountAdapter.accounts(app),
              });
              const declaration = definitions.find(
                (schedule) => schedule.name === input.input.name,
              );
              if (!declaration)
                return yield* Effect.fail(
                  new PluginServiceError("invalid", "Plugin does not declare this schedule"),
                );
              return yield* Schema.decodeUnknownEffect(ScheduleInputs.configure)({
                ...data,
                ...(declaration.scope === "app" ? {} : { actor: owner }),
              }).pipe(Effect.flatMap(engine.schedules.configure));
            }),
          );
        case "schedules.runNow":
          return decode(ScheduleInputs.runNow).pipe(Effect.flatMap(engine.schedules.runNow));
        case "schedules.runs":
          return scheduledRunPage(composed.sql, {
            app: String(input.input.app),
            owner,
            limit: z.coerce.number().int().min(1).max(100).catch(50).parse(input.input.limit),
            pending: input.input.pending === true,
          }).pipe(Effect.map((page) => page.runs));
        case "schedules.approval":
          return decode(ScheduleInputs.approval).pipe(Effect.flatMap(engine.schedules.approval));
        case "schedules.answer":
          return decode(ScheduleInputs.answer).pipe(Effect.flatMap(engine.schedules.answer));
        case "workflows.list":
          return linked(WorkflowApp, engine.apps.workflows.list);
        case "workflowRuns.start":
          return linked(StartWorkflow, engine.apps.workflowRuns.start);
        case "workflowRuns.list":
          return Effect.gen(function* () {
            const app = AppId.make(String(input.input.app));
            yield* engine.apps.get({ app, owner });
            const page = yield* workflowRunPage(composed.sql, input.input);
            return {
              items: yield* Effect.forEach(page.runs, (run) =>
                engine.apps.workflowRuns
                  .get({ app, run: Schema.decodeUnknownSync(WorkflowTarget.fields.run)(run.id) })
                  .pipe(
                    Effect.map((run) =>
                      run.status === "complete" ? { ...run, output: null } : run,
                    ),
                  ),
              ),
              ...(page.next ? { next: page.next } : {}),
            };
          });
        case "workflowRuns.get":
          return decode(WorkflowTarget).pipe(Effect.flatMap(engine.apps.workflowRuns.get));
        case "workflowRuns.stop":
          return decode(WorkflowTarget).pipe(Effect.flatMap(engine.apps.workflowRuns.terminate));
        case "webhooks.remove":
          return decode(WebhookTarget).pipe(Effect.flatMap(engine.webhooks.remove));
        case "webhooks.confirmRemoval":
          return decode(WebhookTarget).pipe(Effect.flatMap(engine.webhooks.confirmRemoval));
        case "webhookSetup.read":
          return decode(WebhookTarget).pipe(
            Effect.flatMap(engine.webhookSetup.read),
            Effect.flatMap(Schema.encodeEffect(WebhookSetupView)),
          );
        case "webhookSetup.complete":
          return decode(CompleteWebhookSetup).pipe(
            Effect.flatMap(engine.webhookSetup.complete),
            Effect.tap(() => composed.scheduler.wakeWebhookSources),
          );
      }
    };
    return {
      startupMs,
      close,
      request: (
        operation: PluginOperation,
        input: unknown,
        context: PluginCaller,
        signal: AbortSignal,
      ) => run(perform(operation, input, context, signal), signal),
      pages: composed.pages,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
