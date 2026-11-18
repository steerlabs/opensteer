import { Effect, Schema } from "effect";
import {
  SourceFiles,
  type BuildId,
  type OwnerId,
  type PluginEngine,
} from "@opensteer/plugin-engine-sdk/core";
import { rewriteUpstreamSource } from "@opensteer/plugin-engine-catalog";

/** A framework as a stored build records it. */
interface Framework {
  readonly version: string;
  readonly sha256: string;
}

/**
 * Rebuild every installed plugin whose active build links a framework other than the Host's, from
 * the source of its active version rewritten with the upstream-name rules, one at a time. The new
 * version activates as an ordinary deploy does, so accounts, links, settings, schedules and the
 * plugin's data stay; the old build serves until then. A plugin rebuilt already links the Host's
 * framework and is skipped, so a pass that stopped part way resumes where it was and a later pass
 * is a no-op. A source that does not build is left installed with no active version, the state of
 * a plugin whose last build failed. A failure a later pass can get past (a package the registry did
 * not serve, memory, storage) keeps the old build until the next start.
 */
export const rebuildInstalledPlugins = (input: {
  readonly engine: PluginEngine;
  readonly owner: OwnerId;
  readonly framework: Framework;
  readonly linkedFramework: (build: BuildId) => Effect.Effect<Framework | undefined>;
}) =>
  Effect.gen(function* () {
    const { engine, owner, framework } = input;
    let rebuilt = 0;
    for (const app of yield* engine.apps.list({ owner })) {
      const activeVersion = app.activeVersion;
      if (activeVersion === null) continue;
      yield* Effect.gen(function* () {
        const active = yield* engine.apps.version({ app: app.id, owner, version: activeVersion });
        const linked = yield* input.linkedFramework(active.build);
        if (linked?.sha256 === framework.sha256) return;
        const started = performance.now();
        const source = yield* engine.apps.source({ app: app.id, owner, version: active.id });
        const files = Schema.decodeUnknownSync(SourceFiles)(
          rewriteUpstreamSource(source.files).files,
        );
        const annotations = { plugin: app.id, from: linked?.version ?? "inlined" };
        yield* engine.apps.deploy({ owner, app: app.id, files }).pipe(
          Effect.tap(() => {
            rebuilt += 1;
            return Effect.logInfo("Plugin rebuilt for the Host's framework").pipe(
              Effect.annotateLogs({ ...annotations, ms: Math.round(performance.now() - started) }),
            );
          }),
          Effect.catchTag("VersionBuildFailed", (error) =>
            Effect.gen(function* () {
              if (error.stage === "dependencies") return yield* error;
              yield* engine.apps.deactivate({ owner, app: app.id });
              yield* Effect.logWarning(
                "Plugin could not be rebuilt for the Host's framework; it needs reinstalling",
              ).pipe(Effect.annotateLogs({ ...annotations, reason: error.message }));
            }),
          ),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Plugin rebuild will be retried at the next start").pipe(
            Effect.annotateLogs({ plugin: app.id, reason: String(error) }),
          ),
        ),
      );
    }
    return rebuilt;
  }).pipe(Effect.withSpan("plugins.rebuild"));
