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
import {
  createPluginEngine,
  makePluginEngineStorage,
  OwnerId,
  ToolName,
  SourceFiles,
  AuthMethodName,
  RepositoryHost,
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
import { withTimeout } from "@opensteer/shared/withTimeout";
import framework from "../vendor/plugin-engine/apps/package.json" with { type: "json" };

const fixtureSource = (revision: number) => `
import { defineApp, query, mutation, router, object, number } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, { tools: router({
  read: query({ input: object({}) }, async ({ sql }) => ({ value: sql.exec("SELECT value FROM counter").one().value, revision: ${revision} })),
  add: mutation({ input: object({ amount: number() }) }, async ({ sql }, { amount }) => sql.exec("UPDATE counter SET value = value + ? RETURNING value", amount).one().value),
  reviewed: mutation({ input: object({ amount: number() }), approval: always() }, async ({ sql }, { amount }) => sql.exec("UPDATE counter SET value = value + ? RETURNING value", amount).one().value),
}) });`;
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

test("runs isolated plugin versions, codemode and approval resume beside Host tables with sealed credentials", async (context) => {
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
  const services = Layer.mergeAll(
    NodeServices.layer,
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
  const engine = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`CREATE SCHEMA ${schema}`);
      const database = yield* makePluginEngineStorage({ provider: "postgresql" });
      yield* database.migrate;
      const ready = yield* Deferred.make<PluginEngine>();
      const workerd = yield* startRuntimeCheck({
        directory,
        registry: origin,
        engine: Deferred.await(ready),
        selfOrigin: { origin: "https://api.fixture.invalid", address: `127.0.0.1:${address.port}` },
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
      });
      yield* Deferred.succeed(ready, engine);
      return engine;
    }).pipe(Effect.timeout("15 seconds")),
  );
  const owner = OwnerId.make("fixture-owner");
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
  if (pending.status !== "approval-required") throw new Error("Reviewed mutation did not pause");
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
  await run(engine.apps.activate({ app, version: v1.version.id, expectedVersion: v2.version.id }));
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
});
