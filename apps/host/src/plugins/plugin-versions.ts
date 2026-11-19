import { Effect, Schema } from "effect";
import {
  SourceFiles,
  VersionBuildFailed,
  type App,
  type AppId,
  type BuildId,
  type OwnerId,
  type PluginEngine,
  type VersionId,
} from "@opensteer/plugin-engine-sdk/core";
import { rewriteUpstreamSource } from "@opensteer/plugin-engine-catalog";
import type { PluginGate } from "./plugin-gate.js";

/** A framework as a stored build records it. */
export interface Framework {
  readonly version: string;
  readonly sha256: string;
}
/** Why a plugin's rebuild cannot succeed, kept for its owner with the version that failed. */
export interface RebuildFailure {
  readonly version: VersionId;
  readonly message: string;
}
/** The rebuild failures the Host keeps beside each plugin. */
export interface VersionStore {
  readonly failed: (app: AppId, failure: RebuildFailure) => Effect.Effect<void, Error>;
  readonly cleared: (app: AppId) => Effect.Effect<void, Error>;
}
/** A plugin that is not served until it is rebuilt, and why it is still waiting. */
export interface Updating {
  readonly reason: string;
  readonly attempts: number;
  /** When the next attempt may start, in epoch milliseconds. */
  readonly retryAt: number;
}

const rebuilding = "It is being rebuilt for this version of Opensteer.";
/** Five seconds after the first failure, doubling to at most ten minutes. */
const backoff = (attempts: number) => Math.min(5_000 * 2 ** (attempts - 1), 600_000);
/** A build failure that judged the source; any other failure may pass on a later attempt. */
const judged = (error: unknown): error is VersionBuildFailed =>
  Schema.is(VersionBuildFailed)(error) && error.retryable !== true;
const describe = (error: unknown) =>
  (Schema.is(VersionBuildFailed)(error)
    ? error.message
    : error !== null && typeof error === "object" && "_tag" in error
      ? error._tag === "BuildMemoryExceeded"
        ? "Its build ran out of memory."
        : error._tag === "StorageError"
          ? "The plugin store did not answer."
          : `The plugin engine could not finish it (${String(error._tag)}).`
      : "The plugin engine could not finish it."
  ).slice(0, 2_000);

/**
 * Every change to which version of an installed plugin is active: deploying, activating and
 * removing it, and rebuilding it after an upgrade. A deploy builds first, outside any lock; its
 * commit (`commit`) then runs as the plugin's only change (`PluginGate.change`) with its execution
 * held (`PluginGate.hold`): the engine checks that the version it expects is still active,
 * migrates the plugin's database and promotes the new version, so the version that was active
 * never runs against the migrated database. A change that finds another version active fails
 * before it migrates anything. Whatever made it active, a promoted version clears the plugin's
 * rebuild state and failure, and `published` tells the Host, which makes what it keeps beside the
 * active version follow; its author was recorded with the promotion.
 *
 * Installed plugins whose active build links a framework other than the Host's, as there are
 * right after an upgrade, are not served at all until they are rebuilt: `updating` names them for
 * their owner and the scheduler, and the runtime runs none of their builds. `run` rebuilds them
 * one at a time from the source of the active version, rewritten with the upstream-name rules, as
 * that version's rebuild (`rebuiltFrom`), so work saved for it continues on the new one. The deploy
 * migrates the plugin's database and activates the new version; its accounts, links, settings,
 * schedules and data stay.
 *
 * A rebuild failure that did not judge the source (a registry, memory, storage) keeps the old
 * version active and the plugin updating, and is tried again with backoff while the engine runs
 * and at its next start. A source that does not build is recorded with its diagnostic and leaves
 * the plugin with no active version, the state of a plugin whose build failed.
 */
export const pluginVersions = (input: {
  readonly engine: PluginEngine;
  readonly owner: OwnerId;
  readonly framework: Framework;
  readonly linkedFramework: (build: BuildId) => Effect.Effect<Framework | undefined>;
  readonly store: VersionStore;
  readonly gate: PluginGate;
  /** A version of `plugin` became active; never fails the change. */
  readonly published: (plugin: AppId) => Effect.Effect<void>;
}) => {
  const { engine, owner, framework, store, gate } = input;
  const updating = new Map<AppId, Updating>();
  const stale = (build: BuildId) =>
    input.linkedFramework(build).pipe(Effect.map((linked) => linked?.sha256 !== framework.sha256));

  /** What follows every promotion, whoever made it. */
  const promoted = (app: AppId) =>
    Effect.gen(function* () {
      updating.delete(app);
      yield* store
        .cleared(app)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Clearing a plugin's rebuild failure failed").pipe(
              Effect.annotateLogs({ plugin: app, reason: describe(error) }),
            ),
          ),
        );
      yield* input.published(app);
    });
  /**
   * A deploy's commit: the plugin's only change, with its execution held while the plugin's
   * database migrates and the new version is promoted.
   */
  const commit = <A, E, R>(app: AppId, work: Effect.Effect<A, E, R>) =>
    gate.change(app, gate.hold(app, work)).pipe(Effect.tap(() => promoted(app)));

  /**
   * Build a stored version's source, rewritten, as its rebuild and the plugin's new active
   * version, expecting the active version the caller read.
   */
  const rebuild = (app: App, version: VersionId) =>
    Effect.gen(function* () {
      const source = yield* engine.apps.source({ app: app.id, owner, version });
      const rewritten = rewriteUpstreamSource(source.files);
      const files = Schema.decodeUnknownOption(SourceFiles)(rewritten.files);
      if (rewritten.problems.length > 0 || files._tag === "None") {
        const message = `App build failed at the source stage: ${rewritten.problems.join(" ") || "the rewritten source files are invalid."}`;
        return yield* new VersionBuildFailed({
          owner,
          name: app.name,
          reason: message,
          stage: "source",
          message,
        });
      }
      return yield* engine.apps.deployWith(
        { owner, app: app.id, files: files.value, expectedVersion: app.activeVersion },
        { rebuiltFrom: version, commit },
      );
    });

  /** One attempt at one plugin; only its commit holds the plugin. */
  const attempt = (id: AppId) =>
    Effect.gen(function* () {
      const app = yield* engine.apps
        .get({ app: id, owner })
        .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));
      if (app === undefined || app.activeVersion === null) return updating.delete(id);
      const active = yield* engine.apps.version({ app: id, owner, version: app.activeVersion });
      // The owner may have changed it since it was found.
      if (!(yield* stale(active.build))) return updating.delete(id);
      const started = performance.now();
      const built = yield* rebuild(app, active.id).pipe(Effect.result);
      const annotations = { plugin: id, ms: Math.round(performance.now() - started) };
      if (built._tag === "Success")
        return yield* Effect.logInfo("Plugin rebuilt for the Host's framework").pipe(
          Effect.annotateLogs(annotations),
        );
      // Another version became active while this one built; the next attempt reads it.
      if (built.failure._tag === "AppVersionChanged") return;
      if (!judged(built.failure)) return yield* Effect.fail(built.failure);
      const failure = built.failure;
      yield* gate.change(
        id,
        Effect.gen(function* () {
          yield* store.failed(id, { version: active.id, message: failure.message });
          yield* engine.apps.deactivate({ owner, app: id, expectedVersion: active.id });
        }),
      );
      updating.delete(id);
      yield* Effect.logWarning("Plugin source does not build for the Host's framework").pipe(
        Effect.annotateLogs({ ...annotations, stage: failure.stage ?? "unknown" }),
      );
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.gen(function* () {
          const attempts = (updating.get(id)?.attempts ?? 0) + 1;
          const retryAt = Date.now() + backoff(attempts);
          updating.set(id, {
            reason: `Its rebuild could not finish and is tried again: ${describe(error)}`,
            attempts,
            retryAt,
          });
          yield* Effect.logWarning("Plugin rebuild will be tried again").pipe(
            Effect.annotateLogs({ plugin: id, attempts, reason: describe(error) }),
          );
        }),
      ),
    );

  return {
    /** Why the plugin is not served yet, or nothing when it is served. */
    updating: (app: string): Updating | undefined => updating.get(app as AppId),
    /** The plugins not served until they are rebuilt. */
    held: (): ReadonlyArray<AppId> => [...updating.keys()],
    /** Whether any plugin still waits for its rebuild. */
    pending: () => updating.size > 0,
    /** Find the plugins built for another framework; before the engine serves anything. */
    scan: Effect.gen(function* () {
      for (const app of yield* engine.apps.list({ owner })) {
        const version = app.activeVersion;
        if (version === null) continue;
        // A version that cannot be read now waits too: its first attempt reads it again.
        const waits = yield* engine.apps.version({ app: app.id, owner, version }).pipe(
          Effect.flatMap((active) => stale(active.build)),
          Effect.orElseSucceed(() => true),
        );
        if (waits) updating.set(app.id, { reason: rebuilding, attempts: 0, retryAt: 0 });
      }
    }),
    /** Rebuild every waiting plugin, one at a time, until none waits. */
    run: Effect.gen(function* () {
      while (updating.size > 0) {
        for (const [id, state] of updating) if (state.retryAt <= Date.now()) yield* attempt(id);
        if (updating.size === 0) break;
        const next = Math.min(...[...updating.values()].map(({ retryAt }) => retryAt));
        yield* Effect.sleep(Math.max(0, next - Date.now()));
      }
    }),
    /** The commit of a deploy into a plugin (see `DeployOptions.commit`). */
    commit,
    /**
     * Activate a stored version. One built for another framework is never activated as it is: its
     * source is rebuilt for the Host's framework, and the new version activates. A failure leaves
     * the active version as it was. Returns the plugin with the version that became active.
     */
    activate: (app: AppId, version: VersionId) =>
      Effect.gen(function* () {
        const current = yield* engine.apps.get({ app, owner });
        const stored = yield* engine.apps.version({ app, owner, version });
        // An activation migrates nothing, so it holds no execution: the plugin's schedules are
        // reconciled against the version it activates, which runs it.
        if (!(yield* stale(stored.build)))
          return yield* gate
            .change(
              app,
              engine.apps.activate({ app, owner, version, expectedVersion: current.activeVersion }),
            )
            .pipe(Effect.tap(() => promoted(app)));
        return (yield* rebuild(current, version)).app;
      }),
    /** Remove a plugin with everything the engine keeps for it. */
    remove: (app: AppId) =>
      gate.change(
        app,
        engine.apps.remove({ app, owner }).pipe(
          Effect.tap(() => Effect.sync(() => updating.delete(app))),
          Effect.tap(() => store.cleared(app)),
        ),
      ),
  };
};
