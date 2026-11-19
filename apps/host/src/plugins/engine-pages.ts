import { Effect, Option, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { appDocument, appAsset, appFile, assetPath, storedAppFile } from "apps/ui/serving";
import * as routes from "apps/ui/contracts";
import {
  AppId,
  VersionId,
  toEffectRuntime,
  type PluginEngine,
  type PluginEngineDatabase,
  type BlobStorage,
  type AppRuntime,
  type BuildId,
} from "@opensteer/plugin-engine-sdk/core";
import type { engineAccounts } from "./engine-accounts.js";
import { DispatchRefusals } from "./engine-authority.js";
import { operations, PluginServiceError } from "./engine-protocol.js";

export function enginePages(
  engine: PluginEngine,
  appRuntime: AppRuntime,
  blobs: BlobStorage,
  database: PluginEngineDatabase,
  accounts: ReturnType<typeof engineAccounts>,
  /** The runtime's check that a build may run; a page and its assets are served only if so. */
  admit: (input: { readonly app: string; readonly build: BuildId }) => Effect.Effect<void, Error>,
) {
  const native = toEffectRuntime(appRuntime, blobs);
  return (raw: unknown) =>
    Effect.gen(function* () {
      const input = operations.page.input.parse(raw);
      const app = AppId.make(input.plugin);
      const incoming = HttpServerRequest.fromWeb(
        new Request(input.request.url, {
          method: input.request.method,
          headers: input.request.headers,
          ...(input.request.method === "GET" || input.request.method === "HEAD"
            ? {}
            : { body: Buffer.from(input.request.body, "base64") }),
        }),
      );
      const read = engine.apps.get({ app });
      const target = yield* read;
      if (!target.activeVersion)
        return yield* Effect.fail(new PluginServiceError("invalid", "Plugin is not deployed"));
      const current = yield* engine.apps.version({ app, version: target.activeVersion });
      const path = new URL(input.request.url).pathname;
      const asset = (build: typeof current.build, path: string) =>
        native.asset === undefined
          ? Effect.succeed(undefined)
          : native
              .asset({ build, path })
              .pipe(
                Effect.map((asset) =>
                  asset === undefined || "body" in asset
                    ? asset
                    : storedAppFile(
                        { contentType: asset.contentType, size: asset.size, etag: asset.object },
                        (range) =>
                          asset.read(range).pipe(Effect.map((body) => Option.some({ body }))),
                      ),
                ),
              );
      const response = Effect.gen(function* () {
        if (path === routes.versionPath) {
          if (incoming.method !== "GET") return HttpServerResponse.empty({ status: 405 });
          yield* accounts.standing(app);
          return HttpServerResponse.stream(
            database.reactivity.subscribe(read).pipe(
              Stream.map(
                ({ value }) =>
                  `event: version\ndata: ${JSON.stringify({ version: value.activeVersion, deployment: value.activeVersion })}\n\n`,
              ),
              Stream.merge(
                Stream.tick("15 seconds").pipe(
                  Stream.drop(1),
                  Stream.map(() => ": heartbeat\n\n"),
                ),
              ),
              Stream.mapEffect((frame) => accounts.standing(app).pipe(Effect.as(frame))),
              Stream.catch(() => Stream.make("event: revoked\ndata: {}\n\n")),
              Stream.encodeText,
            ),
            { contentType: "text/event-stream", headers: { "x-accel-buffering": "no" } },
          );
        }
        if (path.startsWith(routes.assetsPath)) {
          const [version, ...rest] = path.slice(routes.assetsPath.length).split("/");
          const retained = yield* engine.apps.version({
            app,
            version: Schema.decodeUnknownSync(VersionId)(version),
          });
          yield* admit({ app, build: retained.build });
          const selected = Option.getOrUndefined(assetPath(rest.join("/")));
          return yield* appAsset(
            selected === undefined ? undefined : yield* asset(retained.build, selected),
            retained.build,
            rest.join("/"),
          );
        }
        // Everything else serves the active version's build, or calls it: only one that may run.
        yield* admit({ app, build: current.build });
        if ([routes.queryPath, routes.mutatePath, routes.subscribePath].includes(path)) {
          if (incoming.method !== "POST") return HttpServerResponse.empty({ status: 405 });
          yield* accounts.standing(app);
          const body = yield* incoming.json;
          const payload = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ version: VersionId, name: Schema.String, input: Schema.Json }),
          )(body);
          if (payload.version !== target.activeVersion)
            return HttpServerResponse.jsonUnsafe({ reason: "version-changed" }, { status: 409 });
          const selection = { app, ...payload, accounts: yield* accounts.accounts(app) };
          if (path === routes.queryPath)
            return HttpServerResponse.jsonUnsafe(yield* engine.appData.query(selection));
          if (path === routes.mutatePath)
            return HttpServerResponse.jsonUnsafe(yield* engine.appData.mutate(selection));
          const stream = yield* engine.appData.subscribe(selection);
          return HttpServerResponse.stream(
            stream.pipe(
              Stream.map(({ value }) => ({ type: "snapshot" as const, value })),
              Stream.merge(
                Stream.tick("15 seconds").pipe(
                  Stream.drop(1),
                  Stream.map(() => ({ type: "heartbeat" as const })),
                ),
              ),
              Stream.mapEffect((frame) =>
                accounts.standing(app).pipe(Effect.as(`data: ${JSON.stringify(frame)}\n\n`)),
              ),
              Stream.encodeText,
            ),
            { contentType: "text/event-stream" },
          );
        }
        const file = yield* appFile({
          origin: new URL(input.request.url).origin,
          asset: (path) => asset(current.build, path),
        });
        if (Option.isSome(file)) return file.value;
        return yield* appDocument({
          version: current.id,
          accountIds: (yield* accounts.accounts(app)).user,
          asset: (path) => asset(current.build, path),
        });
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, incoming));
      return HttpServerResponse.toWeb(
        yield* response.pipe(
          // A build that may not run is answered by the page operation, which reads why.
          Effect.catch((error) =>
            Effect.flatMap(DispatchRefusals, (cell) =>
              cell?.refusal !== undefined
                ? Effect.fail(error)
                : Effect.succeed(
                    HttpServerResponse.jsonUnsafe(
                      { _tag: "UiFailed", reason: "operation_failed" },
                      { status: 422 },
                    ),
                  ),
            ),
          ),
        ),
      );
    });
}
