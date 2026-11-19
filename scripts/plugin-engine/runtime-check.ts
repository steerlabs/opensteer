import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Deferred, Effect, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Digest, SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../packages/plugin-engine/database/src/pglite.ts";
import {
  createPluginEngine,
  makePluginEngineStorage,
  OwnerId,
  ToolName,
} from "@opensteer/plugin-engine-sdk/core";
import { markdownRefusals } from "@opensteer/plugin-engine-sdk/markdown";
import { memoryRegistry } from "@opensteer/plugin-engine-sdk/testing";
import { nativeRepositories, systemGit } from "@opensteer/plugin-engine-app-source/node";
import { filesystemBlobStore, workerdApps } from "@opensteer/plugin-engine-sdk/node";
import { createAppRuntime } from "@opensteer/plugin-engine-sdk";
import type { PluginEngine } from "@opensteer/plugin-engine-sdk/core";

export function ownedRuntimeProcesses() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent, rss, ...command] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        parent: Number(parent),
        rssKiB: Number(rss),
        command: command.join(" "),
      };
    });
  const owned = new Set([process.pid]);
  for (let size = -1; size !== owned.size;) {
    size = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  }
  return rows.filter(
    (row) => row.pid !== process.pid && owned.has(row.pid) && /(?:^|\/)workerd$/.test(row.command),
  );
}

export const startRuntimeCheck = (options: {
  directory: string;
  engine?: Effect.Effect<PluginEngine>;
  registry?: string;
  selfOrigin?: { origin: string; address: string };
}) =>
  Effect.gen(function* () {
    const blobs = filesystemBlobStore({ directory: join(options.directory, "blobs") });
    const started = performance.now();
    const runtime = yield* workerdApps({
      directory: join(options.directory, "runtime"),
      blobs,
      pluginEngine: options.engine ?? Effect.never,
      encryptionKey: Redacted.make("a1".repeat(32)),
      ...(options.registry === undefined ? {} : { npmRegistry: options.registry }),
      ...(options.selfOrigin === undefined ? {} : { selfOrigin: options.selfOrigin }),
    });
    return {
      ...runtime,
      blobs,
      coldStartMs: performance.now() - started,
      idle: ownedRuntimeProcesses(),
    };
  });

export async function catalogCheck() {
  const { officialCatalogUrl: feed } = await import("@opensteer/plugin-engine-catalog");
  const get = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  const { Schema } = await import("effect");
  const { CodeFiles } = await import("@opensteer/plugin-engine-sdk");
  const { CatalogFeed, CatalogFeedSource } =
    await import("@opensteer/plugin-engine-catalog/contracts");
  const catalog = Schema.decodeUnknownSync(CatalogFeed)(await get(feed));
  const entry =
    catalog.apps.find((app) => app.id === process.argv[2]) ??
    catalog.apps.find((app) => app.auth.length === 0) ??
    catalog.apps[0];
  if (!entry) throw new Error("Empty public catalog");
  const source = Schema.decodeUnknownSync(CatalogFeedSource)(
    await get(new URL(entry.source, feed).href),
  );
  const codeFiles = Schema.decodeUnknownSync(CodeFiles)(source.files);
  const manifest = codeFiles.find((file) => file.path === "package.json");
  const metadata = Schema.decodeUnknownSync(
    Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
  )(JSON.parse(manifest?.content ?? "{}"));
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-catalog-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sqlContext = yield* Layer.build(pgliteLayer());
          const database = yield* makePluginEngineStorage({ provider: "postgresql" }).pipe(
            Effect.provideService(
              SqlClient.SqlClient,
              Context.get(sqlContext, SqlClient.SqlClient),
            ),
          );
          yield* database.migrate;
          const ready = yield* Deferred.make<PluginEngine>();
          const runtime = yield* startRuntimeCheck({ directory, engine: Deferred.await(ready) });
          const engine = yield* createPluginEngine({
            database,
            secret: Redacted.make("a1".repeat(32)),
            origin: "https://catalog-check.invalid",
            git: nativeRepositories(join(directory, "repositories"), systemGit),
            markdown: markdownRefusals,
            blobs: runtime.blobs,
            runtime: runtime.runtime,
            workflows: runtime.workflows,
            registry: memoryRegistry(),
          });
          yield* Deferred.succeed(ready, engine);
          const owner = OwnerId.make("catalog-check");
          const created = yield* engine.apps.create({
            owner,
            name: entry.name,
            files: source.files,
          });
          const app = createAppRuntime({ runtime: runtime.runtime, blobs: runtime.blobs });
          const start = performance.now();
          const deployed = yield* engine.apps.deploy({
            owner,
            app: created.id,
            files: source.files,
          });
          const built = { build: deployed.version.build, requirements: deployed.app.requirements };
          const buildMs = performance.now() - start;
          const tools =
            entry.auth.length === 0
              ? yield* Effect.tryPromise(() =>
                  app.inspect({
                    app: deployed.app.id,
                    build: built.build,
                    accounts: { app: {}, user: {} },
                  }),
                )
              : undefined;
          const probe =
            entry.id === "aiwyntax" &&
            tools?.tools.some((tool) => tool.name === "generate_uuid_v5" && tool.readOnly);
          const toolCall = probe
            ? yield* engine.tools.call({
                app: deployed.app.id,
                tool: ToolName.make("generate_uuid_v5"),
                input: {
                  source_uuid: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
                  namespace: "opensteer-plugin-engine-check",
                },
              })
            : undefined;
          if (
            toolCall !== undefined &&
            (toolCall.status !== "completed" ||
              (toolCall.value !== null &&
                typeof toolCall.value === "object" &&
                "isError" in toolCall.value &&
                toolCall.value.isError === true))
          )
            throw new Error("Public catalog probe failed");
          const binary = runtime.idle[0]?.command;
          const binaryBytes =
            binary === undefined
              ? undefined
              : yield* Effect.promise(() => stat(binary).then((info) => info.size));
          console.log(
            JSON.stringify(
              {
                catalogId: entry.id,
                package: source.package,
                frameworkVersion: metadata.dependencies.apps,
                buildMs,
                binaryBytes,
                coldStartMs: runtime.coldStartMs,
                idle: runtime.idle,
                loaded: ownedRuntimeProcesses(),
                app: deployed.app.id,
                version: deployed.version.id,
                build: built.build,
                accounts: built.requirements.accounts,
                tools: tools?.tools.map((tool) => tool.name),
                toolCall,
              },
              null,
              2,
            ),
          );
          console.log(
            entry.auth.length
              ? "Loaded; stopped before account linking."
              : toolCall === undefined
                ? "Installed and loaded without an account."
                : "Installed, loaded, and called without an account.",
          );
        }),
      ).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provide([Digest.layerWebCrypto, SecureRandom.layerWebCrypto]),
        Effect.timeout("120 seconds"),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
