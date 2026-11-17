import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import {
  Option,
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
  makePluginEngineStorage,
  OwnerId,
  AppId,
  AccountId,
  AppAccounts,
  VersionId,
  ProviderId,
  SourceFiles,
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
  ListWorkflowRuns,
  webhookCallback,
  WebhookDefinitionsInput,
  WebhookTarget,
  LinkWebhookSource,
  CompleteWebhookSetup,
  type PluginEngine,
} from "@opensteer/plugin-engine-sdk/core";
import { filesystemBlobStore, workerdApps } from "@opensteer/plugin-engine-sdk/node";
import { filesystemRepositories } from "@opensteer/plugin-source";
import { markdownRefusals } from "@opensteer/plugin-engine-sdk/markdown";
import { memoryRegistry } from "@opensteer/plugin-engine-sdk/testing";
import { startScheduleWorker, deliverEvents } from "@opensteer/plugin-engine-sdk/scheduling";
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
import { compositeBackend } from "./engine-backend.js";
import { catalogPage } from "./catalog-page.js";
import { enginePages } from "./engine-pages.js";
import {
  operations,
  callbackOperations,
  PluginServiceError,
  JsonSchema,
  type EngineInit,
  type PluginCaller,
  type PluginExecution,
  type PluginOperation,
  type PluginCallback,
} from "./engine-protocol.js";
import type { z } from "zod";
import { ElicitationResponse } from "apps/contracts";

type Callback = <K extends PluginCallback>(
  operation: K,
  input: z.infer<(typeof callbackOperations)[K]["input"]>,
) => Effect.Effect<z.infer<(typeof callbackOperations)[K]["output"]>, Error>;
export async function startEngine(
  config: EngineInit,
  callback: Callback,
  report: (execution: PluginExecution) => void,
  phase: (name: string) => void = () => {},
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
        const database = yield* sql.reserve.pipe(
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
            callback("authorize", {
              caller: config.owner,
              mode: "automatic",
              operation: "background",
              plugin,
            }).pipe(
              Effect.flatMap((permission) =>
                permission.allowed && permission.grants?.[plugin] !== "off"
                  ? Effect.void
                  : Effect.fail(new PluginServiceError("forbidden", "Plugin is disabled")),
              ),
            ),
        });
        phase("sdk");
        const hostScope = yield* Scope.Scope;
        const engine = yield* createPluginEngine({
          database,
          secret: Redacted.make(config.secret),
          origin: config.origin,
          // Source backend construction point: replace this adapter to remove the system git dependency.
          git: filesystemRepositories(join(config.directory, "repositories")),
          markdown: markdownRefusals,
          hooks: accountAdapter.hooks,
          blobs,
          runtime: local.runtime,
          workflows: local.workflows,
          registry: memoryRegistry(),
          cache: { durable: local.declarations },
          background: (work) => Effect.forkIn(work, hostScope).pipe(Effect.as(true)),
          oauth: { httpClient: egress.client, clientName: "Opensteer", urlPolicy: egress.policy },
          events: {
            sender: httpEventSender(egress),
            authorize: (target) =>
              callback(
                "eventAuthorize",
                JsonSchema.parse(JSON.parse(JSON.stringify(target))) as Record<
                  string,
                  z.infer<typeof JsonSchema>
                >,
              ).pipe(
                Effect.flatMap((allowed) =>
                  allowed ? Effect.void : Effect.fail(new EventAccessRevoked()),
                ),
              ),
          },
        });
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
        const scheduler = yield* startScheduleWorker(engine, () => Effect.void, {
          runner: "host",
          concurrency: 2,
          pollMilliseconds: 1000,
        });
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
              }
            },
          },
        );
        const pages = enginePages(engine, local.runtime, blobs, database, accountAdapter);
        return { engine, owner, accountAdapter, scheduler, catalog, manager, executions, pages };
      }),
    );
    const { engine, owner, accountAdapter, catalog, manager, executions } = composed;
    const startupMs = performance.now() - started;
    const authorize = (context: PluginCaller, operation: string, plugin?: string) =>
      callback("authorize", {
        ...context,
        operation,
        ...(plugin === undefined ? {} : { plugin }),
      }).pipe(
        Effect.flatMap((result) =>
          result.allowed
            ? Effect.void
            : Effect.fail(
                new PluginServiceError("forbidden", "Plugin operation is not authorized"),
              ),
        ),
      );
    const backend = (context: PluginCaller, execution?: string) =>
      compositeBackend(engine, accountAdapter, owner, context, {
        authorize: (input) =>
          callback("authorize", {
            ...context,
            ...input,
            ...(execution === undefined ? {} : { execution }),
          }),
        providers: () => callback("providers", context),
        call: (input) =>
          callback("providerCall", {
            ...context,
            ...input,
            ...(execution === undefined ? {} : { execution }),
          }),
      });
    const update = (record: { view: PluginExecution }, value: Partial<PluginExecution>) => {
      record.view = { ...record.view, ...value };
      report(record.view);
      return record.view;
    };
    const completed = (record: { view: PluginExecution }, result: McpExecutionResult) => {
      const pending = result.status === "approval-required" || result.status === "input-required";
      return update(record, {
        state: pending ? "waiting" : "completed",
        interaction: pending ? JSON.parse(JSON.stringify(result)) : null,
        result: operations.execute.output.shape.result.parse(JSON.parse(JSON.stringify(result))),
      });
    };
    const perform = (
      operation: PluginOperation,
      raw: unknown,
      context: PluginCaller,
      signal: AbortSignal,
    ): Effect.Effect<unknown, Error, Scope.Scope> =>
      Effect.gen(function* () {
        yield* authorize(context, operation);
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
          case "list":
            return yield* engine.apps.list({ owner });
          case "install": {
            const input = operations.install.input.parse(raw);
            let files: Schema.Schema.Type<typeof SourceFiles>;
            let name: string | undefined;
            let app: AppId | undefined;
            if (input.kind === "files") {
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
              files = (yield* graphqlAppSource({ name: input.name, url: input.url, methods: {} }))
                .files;
              name = input.name;
            } else {
              const client = yield* safeHttpClient(defaultUrlPolicy);
              const response = yield* client.get(input.url);
              const document = yield* response.json;
              files = (yield* openapiAppSource({
                name: input.name,
                document: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
                  document,
                ),
                methods: {},
                allowedOrigins: [new URL(input.url).origin],
              })).files;
              name = input.name;
            }
            return yield* engine.apps
              .deploy({
                owner,
                ...(app === undefined ? { name: name ?? "Plugin" } : { app }),
                files,
              })
              .pipe(
                Effect.map((result) => ({
                  status: "installed",
                  plugin: result.app,
                  version: result.version,
                })),
                Effect.catchTags({
                  VersionBuildFailed: (error) => Effect.succeed({ status: "build-error", error }),
                  BuildMemoryExceeded: (error) => Effect.succeed({ status: "build-error", error }),
                }),
              );
          }
          case "detail": {
            const app = AppId.make(operations.detail.input.parse(raw).plugin);
            const plugin = yield* engine.apps.get({ app, owner });
            const selected = yield* accountAdapter.accounts(app).pipe(Effect.option);
            const read = <A, E>(effect: Effect.Effect<A, E>) =>
              effect.pipe(Effect.catch(() => Effect.succeed(null)));
            return {
              plugin,
              links: yield* accountAdapter.links(app),
              versions: yield* engine.apps.versions({ app, owner }),
              schedules: yield* engine.schedules.list({ app, owner }),
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
            };
          }
          case "export": {
            const input = operations.export.input.parse(raw);
            const source = yield* engine.apps.source({
              app: AppId.make(input.plugin),
              owner,
              ...(input.version === undefined ? {} : { version: VersionId.make(input.version) }),
            });
            return source.files;
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
            return yield* engine.managedAccounts.add({
              owner,
              provider: ProviderId.make(input.provider),
              method: input.method,
              fields: Redacted.make(input.fields),
              ...(input.label === undefined ? {} : { label: input.label }),
            });
          }
          case "removeAccount":
            return yield* engine.accounts.remove({
              owner,
              account: Schema.decodeUnknownSync(AccountId)(
                operations.removeAccount.input.parse(raw).account,
              ),
            });
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
          case "search":
            return yield* searchCatalog(
              backend(context),
              Schema.decodeUnknownSync(SearchInput)(raw),
            );
          case "describe":
            return yield* describeCatalog(backend(context), operations.describe.input.parse(raw));
          case "skills":
            return yield* skills(Schema.decodeUnknownSync(SkillsInput)(raw), backend(context));
          case "skillFiles": {
            const app = AppId.make(operations.skillFiles.input.parse(raw).plugin);
            const bundle = yield* engine.skills.bundle({
              app,
              accounts: yield* accountAdapter.accounts(app),
            });
            const files = bundle.skills.flatMap((skill) =>
              skill.files.map((file) => ({
                path: `${skill.name}/${file.path}`,
                content: file.content,
              })),
            );
            return {
              plugin: app,
              version: bundle.version,
              digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
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
                    manager.execute(
                      context.caller,
                      backend(context, id),
                      program,
                      "result",
                      context.mode === "automatic" ? "client" : "ask",
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
              return completed(record, result);
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
              yield* backend(context).authorizeElicitation(
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
              return completed(
                record,
                yield* Effect.tryPromise({
                  try: () =>
                    run(
                      manager.resume(context.caller, backend(context, record.view.id), {
                        requestId,
                        response,
                      }),
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
      }).pipe(Effect.provideService(CurrentActor, owner));
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
          return decode(ScheduleInputs.configure).pipe(Effect.flatMap(engine.schedules.configure));
        case "schedules.update":
          return decode(ScheduleInputs.update).pipe(Effect.flatMap(engine.schedules.update));
        case "schedules.remove":
          return decode(ScheduleInputs.remove).pipe(Effect.flatMap(engine.schedules.remove));
        case "schedules.runNow":
          return decode(ScheduleInputs.runNow).pipe(Effect.flatMap(engine.schedules.runNow));
        case "schedules.runs":
          return decode(ScheduleInputs.runs).pipe(Effect.flatMap(engine.schedules.runs));
        case "schedules.approval":
          return decode(ScheduleInputs.approval).pipe(Effect.flatMap(engine.schedules.approval));
        case "schedules.answer":
          return decode(ScheduleInputs.answer).pipe(Effect.flatMap(engine.schedules.answer));
        case "workflows.list":
          return linked(WorkflowApp, engine.apps.workflows.list);
        case "workflowRuns.start":
          return linked(StartWorkflow, engine.apps.workflowRuns.start);
        case "workflowRuns.list":
          return decode(ListWorkflowRuns).pipe(Effect.flatMap(engine.apps.workflowRuns.list));
        case "workflowRuns.get":
          return decode(WorkflowTarget).pipe(Effect.flatMap(engine.apps.workflowRuns.get));
        case "workflowRuns.stop":
          return decode(WorkflowTarget).pipe(Effect.flatMap(engine.apps.workflowRuns.terminate));
        case "webhooks.definitions":
          return linked(WebhookDefinitionsInput, engine.webhooks.definitions);
        case "webhooks.list":
          return decode(WorkflowApp).pipe(Effect.flatMap(engine.webhooks.list));
        case "webhooks.sources":
          return decode(WorkflowApp).pipe(Effect.flatMap(engine.webhooks.sources));
        case "webhooks.link":
          return decode(LinkWebhookSource).pipe(Effect.flatMap(engine.webhooks.link));
        case "webhooks.unlink":
          return decode(LinkWebhookSource).pipe(Effect.flatMap(engine.webhooks.unlink));
        case "webhooks.remove":
          return decode(WebhookTarget).pipe(Effect.flatMap(engine.webhooks.remove));
        case "webhooks.confirmRemoval":
          return decode(WebhookTarget).pipe(Effect.flatMap(engine.webhooks.confirmRemoval));
        case "webhookSetup.read":
          return decode(WebhookTarget).pipe(Effect.flatMap(engine.webhookSetup.read));
        case "webhookSetup.complete":
          return decode(CompleteWebhookSetup).pipe(Effect.flatMap(engine.webhookSetup.complete));
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
