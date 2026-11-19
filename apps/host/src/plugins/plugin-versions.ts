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
  type VersionMetadata,
} from "@opensteer/plugin-engine-sdk/core";
import { rewriteUpstreamSource } from "@opensteer/plugin-engine-catalog";

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
/** Where version changes coordinate across engine processes, and what failed for good. */
export interface VersionStore {
  /**
   * Run `work` holding the plugin's version fence, which one operation of one engine process holds
   * at a time. Every change to which version of a plugin is active, and so to its database, runs
   * under it.
   */
  readonly fence: <A, E>(app: AppId, work: Effect.Effect<A, E>) => Effect.Effect<A, E | Error>;
  readonly failed: (app: AppId, failure: RebuildFailure) => Effect.Effect<void, Error>;
  readonly cleared: (app: AppId) => Effect.Effect<void, Error>;
}
/**
 * A version that became a plugin's active one. `from` is the stored version whose source it was
 * rebuilt from, whose author it inherits; null when it is that version, or new source.
 */
export interface Published {
  readonly plugin: AppId;
  readonly version: VersionId;
  readonly from: VersionId | null;
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
 * removing it, and rebuilding it after an upgrade. Each runs under the plugin's version fence and
 * expects the active version it read there, so of two concurrent changes the second sees the
 * first; a deploy that finds another version active fails before it migrates the plugin's
 * database. A version that becomes active is published one way, whoever activated it: the
 * rebuild failure is cleared and `published` refreshes what the Host keeps beside the version.
 *
 * Installed plugins whose active build links a framework other than the Host's, as there are
 * right after an upgrade, are not served at all until they are rebuilt: `updating` names them, and
 * the engine admits no call, page, schedule occurrence, workflow step or webhook for them. `run`
 * rebuilds them one at a time from the source of the active version, rewritten with the
 * upstream-name rules; the deploy builds it, then migrates the plugin's database and activates the
 * new version, so its accounts, links, settings, schedules and data stay.
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
  readonly published: (version: Published) => Effect.Effect<void, Error>;
}) => {
  const { engine, owner, framework, store } = input;
  const updating = new Map<AppId, Updating>();
  const stale = (build: BuildId) =>
    input.linkedFramework(build).pipe(Effect.map((linked) => linked?.sha256 !== framework.sha256));

  /** The one way a version becomes visible as the plugin's active one. */
  const publish = (version: Published) =>
    Effect.gen(function* () {
      updating.delete(version.plugin);
      yield* store.cleared(version.plugin);
      yield* input.published(version);
    });
  /** Publish a deploy's version when it became the active one. */
  const publishDeployed = (
    deployed: {
      readonly app: Pick<App, "id" | "activeVersion">;
      readonly version: Pick<VersionMetadata, "id">;
    },
    from: VersionId | null,
  ) =>
    deployed.app.activeVersion === deployed.version.id
      ? publish({ plugin: deployed.app.id, version: deployed.version.id, from })
      : Effect.void;

  /**
   * Build a stored version's source, rewritten, as the plugin's new active version, expecting the
   * active version the caller read under the fence.
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
      return yield* engine.apps.deploy({
        owner,
        app: app.id,
        files: files.value,
        expectedVersion: app.activeVersion,
      });
    });

  /** One attempt at one plugin, under its fence. */
  const attempt = (id: AppId) =>
    store
      .fence(
        id,
        Effect.gen(function* () {
          const app = yield* engine.apps
            .get({ app: id, owner })
            .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));
          if (app === undefined || app.activeVersion === null) return updating.delete(id);
          const active = yield* engine.apps.version({ app: id, owner, version: app.activeVersion });
          // Another engine, or the owner, may have changed it while this one waited for the fence.
          if (!(yield* stale(active.build))) return updating.delete(id);
          const started = performance.now();
          const built = yield* rebuild(app, active.id).pipe(Effect.result);
          const annotations = { plugin: id, ms: Math.round(performance.now() - started) };
          if (built._tag === "Success") {
            // The new version is served from here on; what the Host keeps beside it follows.
            yield* publishDeployed(built.success, active.id).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Publishing a rebuilt plugin version failed").pipe(
                  Effect.annotateLogs({ plugin: id, reason: describe(error) }),
                ),
              ),
            );
            updating.delete(id);
            return yield* Effect.logInfo("Plugin rebuilt for the Host's framework").pipe(
              Effect.annotateLogs(annotations),
            );
          }
          if (!judged(built.failure)) return yield* Effect.fail(built.failure);
          yield* store.failed(id, { version: active.id, message: built.failure.message });
          yield* engine.apps.deactivate({ owner, app: id, expectedVersion: active.id });
          updating.delete(id);
          yield* Effect.logWarning("Plugin source does not build for the Host's framework").pipe(
            Effect.annotateLogs({ ...annotations, stage: built.failure.stage ?? "unknown" }),
          );
        }),
      )
      .pipe(
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
    /**
     * Install source as a plugin's new version: `work` deploys or copies it, into `app` when it
     * names an installed plugin, which then runs under that plugin's fence.
     */
    install: <
      W extends Effect.Effect<
        {
          readonly app: Pick<App, "id" | "activeVersion">;
          readonly version: Pick<VersionMetadata, "id">;
        },
        unknown
      >,
    >(
      work: W,
      app?: AppId,
    ): Effect.Effect<Effect.Success<W>, Effect.Error<W> | Error> => {
      // SAFETY: W is an Effect of that success and error, as its constraint says.
      const typed = work as unknown as Effect.Effect<Effect.Success<W>, Effect.Error<W>>;
      const published = typed.pipe(Effect.tap((deployed) => publishDeployed(deployed, null)));
      return app === undefined ? published : store.fence(app, published);
    },
    /**
     * Activate a stored version. One built for another framework is never activated as it is: its
     * source is rebuilt for the Host's framework, and the new version activates. A failure leaves
     * the active version as it was. Returns the plugin with the version that became active.
     */
    activate: (app: AppId, version: VersionId) =>
      store.fence(
        app,
        Effect.gen(function* () {
          const current = yield* engine.apps.get({ app, owner });
          const stored = yield* engine.apps.version({ app, owner, version });
          if (!(yield* stale(stored.build))) {
            const activated = yield* engine.apps.activate({
              app,
              owner,
              version,
              expectedVersion: current.activeVersion,
            });
            yield* publish({ plugin: app, version, from: null });
            return activated;
          }
          const rebuilt = yield* rebuild(current, version);
          yield* publishDeployed(rebuilt, version);
          return rebuilt.app;
        }),
      ),
    /** Remove a plugin with everything the engine keeps for it. */
    remove: (app: AppId) =>
      store.fence(
        app,
        engine.apps.remove({ app, owner }).pipe(
          Effect.tap(() => Effect.sync(() => updating.delete(app))),
          Effect.tap(() => store.cleared(app)),
        ),
      ),
  };
};
