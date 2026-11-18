import { qualifyEngineStorage } from "../apps/host/src/plugins/engine-storage.js";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Redacted, Scope, Schema } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";
import { FetchHttpClient, HttpClient } from "effect/http";
import { httpsOnlyUrlPolicy } from "../vendor/plugin-engine/utils/src/url-policy.ts";
import {
  createPluginEngine,
  makePluginEngineStorage,
  OwnerId,
  ToolName,
  SourceFiles,
  StorageHost,
  AuthMethodName,
  RepositoryHost,
  HttpUrl,
  FirstPartyOAuthClient,
  OAuthBrokerFailed,
  type BrokeredOAuthAttempt,
  type BrokeredOAuthResult,
  type OAuthBrokerPort,
  type PluginEngine,
} from "@opensteer/plugin-engine-sdk/core";
import { markdownRefusals } from "@opensteer/plugin-engine-sdk/markdown";
import { filesystemRepositories } from "@opensteer/plugin-source";
import { memoryRegistry } from "@opensteer/plugin-engine-sdk/testing";
import { makeExecutions, type McpBackend } from "@opensteer/plugin-engine-mcp";
import { executeProgram } from "../vendor/plugin-engine/mcp/src/implementation/execute.ts";
import {
  startRuntimeCheck,
  ownedRuntimeProcesses,
} from "../scripts/plugin-engine/runtime-check.ts";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import type { ScheduleDispatcher } from "../vendor/plugin-engine/sdk/src/contracts/scheduler.ts";
import { withTimeout } from "@opensteer/shared/withTimeout";
import framework from "../vendor/plugin-engine/apps/package.json" with { type: "json" };

const fixtureSource = (revision: number) => `
import { defineApp, query, mutation, router, object, number, userInterval } from "apps";
import { always } from "apps/operations/approval";
const reviewed = mutation({ input: object({ amount: number() }), approval: always() }, async ({ sql }, { amount }) => sql.exec("UPDATE counter SET value = value + ? RETURNING value", amount).one().value);
export default defineApp({}, { tools: router({
  read: query({ input: object({}) }, async ({ sql }) => ({ value: sql.exec("SELECT value FROM counter").one().value, revision: ${revision} })),
  add: mutation({ input: object({ amount: number() }) }, async ({ sql }, { amount }) => sql.exec("UPDATE counter SET value = value + ? RETURNING value", amount).one().value),
  reviewed,
}), schedules: { reviewed: userInterval({ minutes: 1 }, reviewed, { amount: 7 }) } });`;
const credentialSource = `
import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Fixture service", hosts: ["api.fixture.invalid"], auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, { tools: router({
  probe: query({ input: object({}) }, async (ctx) => {
    const token = ctx.user.accounts.service.fields.token;
    const response = await ctx.fetch("https://api.fixture.invalid/secret", { headers: { authorization: "Bearer " + token } });
    let blocked;
    try { const refused = await ctx.fetch("https://other.fixture.invalid/secret", { headers: { authorization: "Bearer " + token } }); blocked = await refused.text(); }
    catch (error) { blocked = error.message; }
    return { token, echo: await response.text(), blocked };
  }),
}) });`;

const brokeredSource = (extraHost = false) => `
import { defineApp, defineProvider, oauth2, object, query, router } from "apps";
const service = defineProvider({ name: "Broker fixture", hosts: ["api.fixture.invalid"${extraHost ? ', "other.fixture.invalid"' : ""}], auth: {
  oauth: oauth2({ authorizationUrl: "https://provider.fixture.invalid/authorize", tokenUrl: "https://provider.fixture.invalid/token", scopes: ["read"] }),
} });
export default defineApp({ user: { accounts: { service } } }, { tools: router({
  probe: query({ input: object({}) }, async (ctx) => {
    const token = ctx.user.accounts.service.fields.access_token;
    const response = await ctx.fetch("https://api.fixture.invalid/secret", { headers: { authorization: "Bearer " + token } });
    let blocked;
    try { const refused = await ctx.fetch("https://other.fixture.invalid/secret", { headers: { authorization: "Bearer " + token } }); blocked = await refused.text(); }
    catch (error) { blocked = error.message; }
    return { token, echo: await response.text(), blocked };
  }),
}) });`;

function files(source: string, database = false) {
  return Schema.decodeUnknownSync(SourceFiles)([
    { path: "index.ts", content: source },
    {
      path: "package.json",
      content: JSON.stringify({
        name: "fixture-plugin",
        private: true,
        type: "module",
        dependencies: { apps: framework.version },
      }),
    },
    ...(database
      ? [
          {
            path: "migrations/0001_counter.sql",
            content:
              "CREATE TABLE counter (value INTEGER NOT NULL); INSERT INTO counter VALUES (0);",
          },
        ]
      : []),
  ]);
}

const fixtureFlows = [
  "versions, codemode and sealed credentials",
  "brokered OAuth",
  "live schedule approvals",
  "scheduler authorization failures",
] as const;

test.for(fixtureFlows)(
  "runs %s in a private engine beside the Host tables",
  async (flow, context) => {
    const clone = await cloneTestDatabase("host");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-engine-test-"));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const archive = join(directory, "framework.tgz");
    await cp(resolve("vendor/plugin-engine/apps/dist"), join(directory, "package"), {
      recursive: true,
    });
    execFileSync("tar", ["--format=ustar", "-czf", archive, "-C", directory, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const tarball = await readFile(archive);
    const observed: string[] = [];
    let origin = "";
    const server = createServer((request, response) => {
      if (request.url === "/apps") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: "apps",
            "dist-tags": { latest: framework.version },
            versions: {
              [framework.version]: {
                name: "apps",
                version: framework.version,
                dist: { tarball: origin + "/framework.tgz" },
              },
            },
          }),
        );
      } else if (request.url === "/framework.tgz") {
        response.end(tarball);
      } else if (request.url === "/secret") {
        observed.push(request.headers.authorization ?? "");
        response.setHeader("content-type", "text/plain");
        response.end(request.headers.authorization);
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    context.onTestFinished(async () => {
      server.closeAllConnections();
      await withTimeout(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        3_000,
        { timeoutError: () => new Error("Fixture HTTP server did not close") },
      );
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await withTimeout(listening, 3_000, {
      timeoutError: () => new Error("Fixture registry did not listen"),
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture registry has no TCP address");
    origin = `http://127.0.0.1:${address.port}`;
    const scope = Scope.makeUnsafe();
    const schema = "plugin_fixture";
    const oauthRequests: string[] = [];
    const services = Layer.mergeAll(
      NodeServices.layer,
      FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (
              url.hostname === "direct.fixture.invalid" ||
              url.hostname === "provider.fixture.invalid"
            ) {
              oauthRequests.push(url.pathname);
              if (url.pathname === "/revoke") return Response.json({});
              if (url.pathname === "/token")
                return Response.json({
                  access_token: "direct-fixture-access",
                  token_type: "Bearer",
                  refresh_token: "direct-refresh",
                  expires_in: 3600,
                  scope: "read",
                });
              throw new Error("Unexpected fixture OAuth request");
            }
            if (url.hostname === "127.0.0.1") return globalThis.fetch(input, init);
            throw new Error("OAuth fixture attempted external network access");
          }),
        ),
      ),
      Digest.layerWebCrypto,
      SecureRandom.layerWebCrypto,
      PgClient.layer({
        url: Redacted.make(clone.url),
        startupParameters: { search_path: schema, timezone: "UTC" },
        maxConnections: 4,
      }),
    );
    const runtime = ManagedRuntime.make(services);
    const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof services> | Scope.Scope>) =>
      runtime.runPromise(
        effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.timeout("20 seconds")),
      );
    await ownTestDatabaseProducer(clone.url, async () => ({
      close: async () => {
        try {
          await runtime.runPromise(Scope.close(scope, Exit.void));
        } finally {
          await runtime.dispose();
        }
      },
    }));
    const engineSql = await run(SqlClient.SqlClient);
    const brokerAttempts = new Map<string, BrokeredOAuthAttempt>();
    const acknowledged: string[] = [];
    const revoked: string[] = [];
    let refreshed = 0;
    let heldRefresh:
      { readonly resultId: string; readonly result: BrokeredOAuthResult } | undefined;
    let accountLinkGeneration = "g".repeat(43);
    let alteredResult: ((value: BrokeredOAuthResult) => BrokeredOAuthResult) | undefined;
    let excessScope = false;
    const broker: OAuthBrokerPort = {
      start: ({ binding }) =>
        Effect.sync(() => {
          const attemptId = `attempt-${brokerAttempts.size + 1}`;
          brokerAttempts.set(attemptId, {
            attemptId,
            binding: { ...binding, accountLinkGeneration },
          });
          return {
            attemptId,
            authorizationUrl: `https://accounts.fixture.invalid/launch/${attemptId}`,
            expiresAt: Date.now() + 60_000,
            accountLinkGeneration,
          };
        }),
      pull: (attempt) =>
        Effect.sync(() => {
          const result: BrokeredOAuthResult = {
            ...attempt,
            tokens: {
              accessToken: "broker-access-expired",
              refreshToken: "broker-refresh",
              tokenType: "Bearer",
              grantedScopes: excessScope ? ["read", "admin"] : ["read"],
              expiresAt: Date.now() - 1_000,
            },
          };
          return Redacted.make(alteredResult ? alteredResult(result) : result);
        }),
      acknowledge: ({ kind, resultId }) =>
        Effect.gen(function* () {
          const rows = yield* engineSql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM plugin_fixture.plugin_engine_oauth_grants`;
          expect(
            rows[0]?.count,
            "ACK must run after the account transaction committed",
          ).toBeGreaterThan(0);
          acknowledged.push(`${kind}:${resultId}`);
        }).pipe(Effect.mapError(() => new OAuthBrokerFailed({ reason: "unavailable" }))),
      refresh: (attempt) =>
        Effect.gen(function* () {
          expect(Redacted.value(attempt.refreshToken)).toBe("broker-refresh");
          if (heldRefresh === undefined) {
            refreshed++;
            heldRefresh = {
              resultId: attempt.resultId,
              result: {
                ...attempt,
                tokens: {
                  accessToken: "broker-access-renewed",
                  refreshToken: "broker-refresh-rotated",
                  tokenType: "Bearer",
                  grantedScopes: ["read"],
                  expiresAt: Date.now() + 3_600_000,
                },
              },
            };
            return yield* new OAuthBrokerFailed({ reason: "unavailable" });
          }
          expect(
            attempt.resultId,
            "A lost refresh response must resume the same broker transaction",
          ).toBe(heldRefresh.resultId);
          return Redacted.make(heldRefresh.result);
        }),
      revoke: ({ attemptId, tokens }) =>
        Effect.sync(() => {
          expect(Redacted.value(tokens).refreshToken).toBe("broker-refresh-rotated");
          revoked.push(attemptId);
        }),
      validate: (binding) =>
        binding.accountLinkGeneration === accountLinkGeneration
          ? Effect.void
          : Effect.fail(new OAuthBrokerFailed({ reason: "binding_changed" })),
    };
    const brokerClient =
      flow === "brokered OAuth"
        ? Schema.decodeUnknownSync(FirstPartyOAuthClient)({
            id: "broker-fixture",
            label: "Fixture sign-in",
            server: {
              authorizationUrl: "https://provider.fixture.invalid/authorize",
              tokenUrl: "https://provider.fixture.invalid/token",
              revocationUrl: "https://provider.fixture.invalid/revoke",
            },
            broker: {
              provider: "fixture",
              revision: 7,
              redirectUri: "https://accounts.fixture.invalid/v1/oauth-broker/callback/fixture",
            },
            defaultScopes: ["read"],
            allowedScopes: ["read"],
            placement: { hosts: ["api.fixture.invalid"] },
          })
        : undefined;
    const engine = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE SCHEMA ${schema}`);
        const database = yield* makePluginEngineStorage({ provider: "postgresql" });
        yield* database.migrate;
        yield* qualifyEngineStorage(sql);
        const ready = yield* Deferred.make<PluginEngine>();
        const workerd = yield* startRuntimeCheck({
          directory,
          registry: origin,
          engine: Deferred.await(ready),
          selfOrigin: {
            origin: "https://api.fixture.invalid",
            address: `127.0.0.1:${address.port}`,
          },
        });
        console.log("Plugin runtime", { coldStartMs: workerd.coldStartMs, idle: workerd.idle });
        const engine = yield* createPluginEngine({
          database,
          secret: Redacted.make("a1".repeat(32)),
          origin: "https://fixture.invalid",
          git: filesystemRepositories(join(directory, "repositories")),
          markdown: markdownRefusals,
          blobs: workerd.blobs,
          runtime: workerd.runtime,
          workflows: workerd.workflows,
          registry: memoryRegistry(),
          ...(brokerClient === undefined
            ? {}
            : {
                oauth: {
                  httpClient: yield* HttpClient.HttpClient,
                  clientName: "Fixture",
                  urlPolicy: httpsOnlyUrlPolicy,
                  firstPartyClients: [
                    brokerClient,
                    Schema.decodeUnknownSync(FirstPartyOAuthClient)({
                      id: "direct-fixture",
                      label: "Direct fixture",
                      server: {
                        authorizationUrl: "https://direct.fixture.invalid/authorize",
                        tokenUrl: "https://direct.fixture.invalid/token",
                        revocationUrl: "https://direct.fixture.invalid/revoke",
                      },
                      clientId: "direct-client",
                      clientSecret: "direct-secret",
                      tokenEndpointAuthMethod: "client_secret_post",
                      defaultScopes: ["read"],
                      placement: { hosts: ["api.fixture.invalid"] },
                    }),
                  ],
                  broker,
                },
              }),
        });
        yield* Deferred.succeed(ready, engine);
        return engine;
      }).pipe(Effect.timeout("15 seconds")),
    );
    const owner = OwnerId.make("fixture-owner");
    if (flow === "live schedule approvals" || flow === "scheduler authorization failures") {
      const {
        app: { id: app },
      } = await run(
        engine.apps.deploy({
          owner,
          name: "Schedule fixture",
          files: files(fixtureSource(1), true),
        }),
      );
      const target = { app, owner, name: "reviewed", actor: owner };
      const configure = (approvalMode: "automatic" | "browser", enabled = true) =>
        run(engine.schedules.configure({ ...target, enabled, approvalMode }));
      const forceDue = () =>
        run(engineSql<{ next_at: Date }>`UPDATE plugin_engine_schedules
        SET next_at = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE app = ${app} RETURNING next_at`);
      const list = () => run(engine.schedules.runs({ app, owner }));
      const tick = (authorize: Parameters<ScheduleDispatcher["tick"]>[0]["authorize"]) =>
        run(
          engine.scheduler.tick({
            runner: "fixture",
            maxCandidates: 1,
            execute: (work) => work,
            authorize,
          }),
        );
      if (flow === "live schedule approvals") {
        for (const enabled of [true, false]) {
          await configure("automatic");
          await forceDue();
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const started = tick(({ phase }) =>
            phase === "resume"
              ? Effect.promise(async () => {
                  entered.resolve();
                  await withTimeout(release.promise, 5_000, {
                    timeoutError: () => new Error("Schedule preparation was not released"),
                  });
                })
              : Effect.void,
          );
          void started.catch(() => {});
          try {
            await withTimeout(entered.promise, 5_000, {
              timeoutError: () => new Error("Schedule did not reach automatic approval"),
            });
            await configure("browser", enabled);
          } finally {
            release.resolve();
            await started;
          }
          const pending = (await list())[0]!;
          expect(pending.status).toBe(enabled ? "awaiting-approval" : "cancelled");
          if (enabled) {
            await run(engine.schedules.answer({ owner, run: pending.id, action: "decline" }));
            await tick(() => Effect.void);
          }
        }
      } else {
        await configure("browser");
        const [due] = await forceDue();
        const unavailable = () => Effect.fail(new Error("Host authorization query unavailable"));
        await tick(unavailable);
        expect.soft((await run(engine.schedules.copy(target))).nextAt).toEqual(due?.next_at);
        expect(await list()).toEqual([]);
        await forceDue();
        await tick(() => Effect.void);
        const [pending] = await list();
        expect(pending?.status).toBe("awaiting-approval");
        await run(engine.schedules.answer({ owner, run: pending!.id, action: "accept" }));
        await tick(unavailable);
        expect((await list())[0]?.status).toBe("ready");
        await tick(() => Effect.void);
        expect((await list())[0]?.status).toBe("succeeded");
      }
      const result = await run(engine.tools.call({ app, tool: ToolName.make("read"), input: {} }));
      expect(result).toMatchObject({
        value: { value: flow === "live schedule approvals" ? 0 : 7 },
      });
      return;
    }
    if (flow !== "brokered OAuth") {
      const v1 = await run(
        engine.apps.deploy({ owner, name: "Fixture", files: files(fixtureSource(1), true) }),
      );
      const app = v1.app.id;
      const call = (tool: string, input: Schema.Json = {}) =>
        run(engine.tools.call({ app, tool: ToolName.make(tool), input }));
      expect(await call("read")).toMatchObject({
        status: "completed",
        value: { value: 0, revision: 1 },
      });
      expect(await call("add", { amount: 2 })).toMatchObject({ status: "completed", value: 2 });
      const backend: McpBackend<Error> = {
        listApps: () => engine.apps.list({ owner }),
        listAccounts: () => Effect.succeed({}),
        listTools: engine.tools.list,
        searchableTools: engine.tools.searchable,
        searchTools: engine.tools.search,
        callTool: engine.tools.call,
        resumeInvocation: (request, response, options) =>
          engine.tools.resume({ requestId: request.requestId, response }, options),
        authorizeElicitation: () => Effect.void,
        listSkills: engine.skills.list,
        readSkill: engine.skills.read,
        findEventSubscription: () => Effect.succeed(null),
        subscribeEvent: () => Effect.die("No event subscriptions in this fixture"),
        unsubscribeEvent: () => Effect.void,
      };
      const executions = await run(makeExecutions({ timeoutMs: 5_000, maxToolCalls: 10 }));
      const chained = await run(
        executions.execute(
          "fixture-run",
          backend,
          executeProgram(
            "const first = await tools.fixture.add({ amount: 3 }); return await tools.fixture.add({ amount: first });",
          ),
          "result",
        ),
      );
      expect(chained).toMatchObject({ status: "completed", execution: { ok: true, value: 10 } });
      const pending = await run(
        executions.execute(
          "fixture-run",
          backend,
          executeProgram("return await tools.fixture.reviewed({ amount: 7 });"),
          "result",
        ),
      );
      expect(pending.status).toBe("approval-required");
      if (pending.status !== "approval-required")
        throw new Error("Reviewed mutation did not pause");
      expect(await call("read")).toMatchObject({ value: { value: 10 } });
      const resumed = await run(
        executions.resume("fixture-run", backend, {
          requestId: pending.requestId,
          response: { action: "accept" },
        }),
      );
      expect(resumed, JSON.stringify(resumed)).toMatchObject({
        status: "completed",
        execution: { ok: true, value: 17 },
      });
      // The second version is saved to the app's Git source first and deployed from that commit.
      const workspace = await run(engine.apps.workspace({ app }));
      const saved = await run(
        engine.apps.commit({
          app,
          expected: workspace.revision.commit,
          files: files(fixtureSource(2), true),
          message: "Revision 2",
        }),
      );
      const v2 = await run(engine.apps.deploy({ owner, app, commit: saved.revision.commit }));
      expect(await call("read")).toMatchObject({ value: { value: 17, revision: 2 } });
      expect((await run(engine.apps.history({ app }))).map((entry) => entry.message)).toEqual([
        "Revision 2",
        "Create app",
      ]);
      expect(
        await run(engine.apps.revision({ app, commit: workspace.revision.commit })),
      ).toContainEqual({ path: "index.ts", content: fixtureSource(1) });
      await run(
        engine.apps.activate({ app, version: v1.version.id, expectedVersion: v2.version.id }),
      );
      expect(await call("read")).toMatchObject({ value: { value: 17, revision: 1 } });
      // An app whose repository creation was interrupted, leaving a partial folder, is recovered.
      const interrupted = await run(
        engine.apps.create({ owner, name: "Pending", files: files(fixtureSource(3)) }),
      );
      await mkdir(join(directory, "repositories", `${interrupted.code}.git`, "objects"), {
        recursive: true,
      });
      await run(engine[RepositoryHost].recover);
      expect((await run(engine.apps.workspace({ app: interrupted.id }))).files).toContainEqual({
        path: "index.ts",
        content: fixtureSource(3),
      });
      const secured = await run(
        engine.apps.deploy({ owner, name: "Secured", files: files(credentialSource) }),
      );
      const provider = secured.app.requirements.accounts.service?.provider;
      if (!provider) throw new Error("Credential fixture did not declare its provider");
      const secret = "test-secret-only-for-declared-host";
      const account = await run(
        engine.managedAccounts.add({
          owner,
          provider,
          method: AuthMethodName.make("key"),
          fields: Redacted.make({ token: secret }),
        }),
      );
      const probed = await run(
        engine.tools.call({
          app: secured.app.id,
          tool: ToolName.make("probe"),
          input: {},
          accounts: { app: {}, user: { service: [account.id] } },
        }),
      );
      expect(observed).toEqual([`Bearer ${secret}`]);
      expect(JSON.stringify(probed)).not.toContain(secret);
      expect(probed).toMatchObject({
        status: "completed",
        value: {
          token: expect.stringMatching(/^oscred/),
          echo: expect.stringContaining("oscred"),
          blocked: expect.stringContaining("other.fixture.invalid"),
        },
      });
    } else {
      const brokered = await run(
        engine.apps.deploy({ owner, name: "Brokered", files: files(brokeredSource()) }),
      );
      const target = { app: brokered.app.id, requirement: "service" };
      const connect = async () => {
        const connection = await run(engine.accountConnections.create({ owner, target }));
        const started = await run(
          engine.accountConnections.startOAuth({
            owner,
            connection: connection.id,
            method: AuthMethodName.make("oauth"),
            redirectUri: HttpUrl.make("https://host.fixture.invalid/callback"),
          }),
        );
        expect(started).toMatchObject({
          status: "redirect",
          authorizationUrl: expect.stringContaining("https://accounts.fixture.invalid/launch/"),
          redirectUri: "https://accounts.fixture.invalid/v1/oauth-broker/callback/fixture",
        });
        if (started.status !== "redirect" || !started.brokerAttemptId)
          throw new Error("Broker did not start");
        return { owner, connection: connection.id, attemptId: started.brokerAttemptId };
      };
      const pendingBroker = await connect();
      await expect(
        run(
          engine[StorageHost].transaction(
            engine.managedAccounts.completeBrokeredOAuth(pendingBroker),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "OAuthCompletionFailed", reason: "oauth_unavailable" });
      expect(acknowledged).toEqual([]);
      const connected = await run(engine.managedAccounts.completeBrokeredOAuth(pendingBroker));
      expect(acknowledged).toEqual([`authorization:${pendingBroker.attemptId}`]);
      await expect(
        run(
          engine.tools.call({
            app: brokered.app.id,
            tool: ToolName.make("probe"),
            input: {},
            accounts: { app: {}, user: { service: [connected.id] } },
          }),
        ),
      ).rejects.toMatchObject({ _tag: "OAuthRenewalFailed", reason: "service_unavailable" });
      expect(acknowledged).toEqual([`authorization:${pendingBroker.attemptId}`]);
      const brokerCall = await run(
        engine.tools.call({
          app: brokered.app.id,
          tool: ToolName.make("probe"),
          input: {},
          accounts: { app: {}, user: { service: [connected.id] } },
        }),
      );
      expect(brokerCall, JSON.stringify(brokerCall)).toMatchObject({ status: "completed" });
      expect(refreshed).toBe(1);
      expect(acknowledged[1]).toMatch(/^refresh:/u);
      expect(observed).toEqual(["Bearer broker-access-renewed"]);
      expect(observed).not.toContain("Bearer broker-access-expired");
      expect(JSON.stringify(brokerCall)).not.toContain("broker-access");
      expect(brokerCall).toMatchObject({
        status: "completed",
        value: {
          token: expect.stringMatching(/^oscred/u),
          blocked: expect.stringContaining("other.fixture.invalid"),
        },
      });
      await run(engine.accounts.remove({ owner, account: connected.id }));
      expect(revoked).toEqual([pendingBroker.attemptId]);
      expect(await run(engine.accounts.list({ owner, provider: connected.provider }))).toEqual([]);
      const rejectedBroker = await connect();
      excessScope = true;
      await expect(
        run(engine.managedAccounts.completeBrokeredOAuth(rejectedBroker)),
      ).rejects.toMatchObject({ _tag: "OAuthCompletionFailed", reason: "scope_exceeded" });
      excessScope = false;
      expect(acknowledged).toHaveLength(2);
      for (const change of [
        { provider: "other" },
        { revision: 8 },
        { scopes: ["admin"] },
        { redirectUri: "https://other.fixture.invalid/callback" },
        { accountLinkGeneration: "h".repeat(43) },
        { requirementDigest: "changed" },
        { clientDigest: "changed" },
      ]) {
        const attempt = await connect();
        alteredResult = (value) => ({ ...value, binding: { ...value.binding, ...change } });
        await expect(
          run(engine.managedAccounts.completeBrokeredOAuth(attempt)),
        ).rejects.toMatchObject({
          _tag: "OAuthCompletionFailed",
          reason: "incompatible_response",
        });
      }
      alteredResult = undefined;
      const staleLink = await connect();
      accountLinkGeneration = "h".repeat(43);
      await expect(
        run(engine.managedAccounts.completeBrokeredOAuth(staleLink)),
      ).rejects.toMatchObject({
        _tag: "OAuthCompletionFailed",
        reason: "client_unavailable",
      });
      const changedRequirement = await connect();
      await run(
        engine.apps.deploy({ owner, app: brokered.app.id, files: files(brokeredSource(true)) }),
      );
      await expect(
        run(engine.managedAccounts.completeBrokeredOAuth(changedRequirement)),
      ).rejects.toMatchObject({ _tag: "AccountConnectionTargetChanged" });
      expect(await run(engine.accounts.list({ owner, provider: connected.provider }))).toEqual([]);
      expect(acknowledged).toHaveLength(2);
      await run(
        engine.apps.deploy({ owner, app: brokered.app.id, files: files(brokeredSource()) }),
      );
      const reviewedEarlier = await run(engine.accountConnections.create({ owner, target }));
      await run(
        engine.apps.deploy({ owner, app: brokered.app.id, files: files(brokeredSource(true)) }),
      );
      await expect(
        run(
          engine.accountConnections.startOAuth({
            owner,
            connection: reviewedEarlier.id,
            method: AuthMethodName.make("oauth"),
            redirectUri: HttpUrl.make("https://host.fixture.invalid/callback"),
          }),
        ),
      ).rejects.toMatchObject({ _tag: "AccountConnectionTargetChanged" });
      for (const kind of ["first-party", "custom"] as const) {
        const source =
          kind === "first-party"
            ? brokeredSource().replaceAll("provider.fixture.invalid", "direct.fixture.invalid")
            : brokeredSource();
        const app = await run(
          engine.apps.deploy({ owner, name: `OAuth ${kind}`, files: files(source) }),
        );
        const connection = await run(
          engine.accountConnections.create({
            owner,
            target: { app: app.app.id, requirement: "service" },
          }),
        );
        const started = await run(
          engine.accountConnections.startOAuth({
            owner,
            connection: connection.id,
            method: AuthMethodName.make("oauth"),
            redirectUri: HttpUrl.make("https://host.fixture.invalid/callback"),
            ...(kind === "custom"
              ? {
                  client: {
                    clientId: "custom-client",
                    clientSecret: Redacted.make("custom-secret"),
                  },
                }
              : {}),
          }),
        );
        if (started.status !== "redirect") throw new Error("Ordinary OAuth did not start");
        expect(started.brokerAttemptId).toBeUndefined();
        const callback = new URL(started.redirectUri);
        callback.search = new URLSearchParams({
          code: "fixture-code",
          state: new URL(started.authorizationUrl).searchParams.get("state")!,
        }).toString();
        const saved = await run(
          engine.accountConnections.completeOAuth({
            owner,
            connection: connection.id,
            callbackUrl: Redacted.make(HttpUrl.make(callback.href)),
          }),
        );
        expect(saved.owner).toBe(owner);
        await run(engine.accounts.remove({ owner, account: saved.id }));
      }
      expect(oauthRequests).toEqual(["/token", "/revoke", "/token"]);
    }
    const tables = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          table_schema: string;
        }>`SELECT table_schema FROM information_schema.tables WHERE table_schema = ${schema}`;
      }),
    );
    expect(tables.length).toBeGreaterThan(10);
    console.log("Plugin runtime after plugin", ownedRuntimeProcesses());
  },
);
