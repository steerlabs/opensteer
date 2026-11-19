import { Effect, Schema } from "effect";
import {
  AppBusy,
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
/** A plugin that is not served until its version change finishes, and why it is still waiting. */
export interface Updating {
  readonly reason: string;
  readonly attempts: number;
  /** When the next attempt may start, in epoch milliseconds. */
  readonly retryAt: number;
}

const rebuilding = "It is being rebuilt for this version of Opensteer.";
const completing = "Its new version is saved and activates once its data has been updated for it.";
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
          : error._tag === "PluginBusy" || error._tag === "AppBusy"
            ? "It was busy running work."
            : error._tag === "VersionPending"
              ? "Its data did not answer while it was updated."
              : `The plugin engine could not finish it (${String(error._tag)}).`
      : "The plugin engine could not finish it."
  ).slice(0, 2_000);

/**
 * Every change to which version of an installed plugin is active: installing, deploying,
 * activating, rebuilding and removing it, and finishing a change that was interrupted. Each is
 * one protocol (`DeployOptions.commit`): a deploy builds first, outside any lock; then, holding
 * the plugin alone (`PluginGate.change`), it saves the complete new version as pending, migrates
 * the plugin's database and activates the version. Only the active version ever runs, so nothing
 * of the version that was active runs against the migrated database.
 *
 * A change whose migration's outcome is unknown, or whose activation failed, leaves its version
 * pending. The plugin is then not served (`updating`) until the same steps complete it, which this
 * engine tries again with backoff, and which the next engine tries at its start. Whatever made it
 * active, an activated version clears the plugin's rebuild failure, and `published` tells the
 * Host, which makes what it keeps beside the active version follow.
 *
 * Installed plugins whose active build links a framework other than the Host's, as there are right
 * after an upgrade, are not served either until they are rebuilt: `run` rebuilds them one at a
 * time from the source of the active version, rewritten with the upstream-name rules, with the
 * packages its build installed. A rebuild failure that did not judge the source (a registry,
 * memory, storage) keeps the old version active and the plugin updating, and is tried again. A
 * source that does not build is recorded with its diagnostic and leaves the plugin with no active
 * version, the state of a plugin whose build failed.
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
  /** Whether any plugin waits, each time that changes. */
  readonly waiting?: (any: boolean) => void;
}) => {
  const { engine, owner, framework, store, gate } = input;
  const updating = new Map<AppId, Updating>();
  /** Plugins whose change waits to be completed, rather than rebuilt. */
  const pendingChanges = new Set<AppId>();
  /** Resolved when a plugin starts waiting, so the loop looks again. */
  let wake = Promise.withResolvers<void>();
  const changed = () => {
    input.waiting?.(updating.size > 0);
    wake.resolve();
  };
  const settle = (app: AppId) => {
    pendingChanges.delete(app);
    if (updating.delete(app)) changed();
  };
  const stale = (build: BuildId) =>
    input.linkedFramework(build).pipe(Effect.map((linked) => linked?.sha256 !== framework.sha256));

  /** What follows every activation, whoever made it, outside the plugin's hold. */
  const promoted = (app: AppId) =>
    Effect.gen(function* () {
      settle(app);
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
  /** The plugin's change saved a version it did not activate: serve nothing until it is. */
  const awaitCompletion = (app: AppId, reason = completing) =>
    Effect.sync(() => {
      pendingChanges.add(app);
      const current = updating.get(app);
      updating.set(app, {
        reason,
        attempts: current?.attempts ?? 0,
        retryAt: current?.retryAt ?? 0,
      });
      changed();
    });
  /** Whether the plugin's change left a pending version behind. */
  const leftPending = (app: AppId) =>
    engine.apps.pending({ owner }).pipe(
      Effect.map((pending) => pending.some((entry) => entry.app === app)),
      Effect.orElseSucceed(() => true),
    );
  /**
   * A version change's commit (see `DeployOptions.commit`): it holds the plugin alone, after its
   * running executions finish, or fails with `PluginBusy` having changed nothing. One that ends
   * with its version still pending, however it ends, leaves the plugin updating until it is
   * completed.
   */
  /** Hold the plugin alone for `work`, or fail with `AppBusy` having run none of it. */
  const alone = <A, E, R>(app: AppId, work: Effect.Effect<A, E, R>) =>
    gate
      .change(app, work)
      .pipe(Effect.catchTag("PluginBusy", () => Effect.fail(new AppBusy({ app }))));
  const commit = <A, E, R>(
    app: AppId,
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AppBusy, R> =>
    alone(app, work).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : leftPending(app).pipe(
              Effect.flatMap((pending) => (pending ? awaitCompletion(app) : Effect.void)),
            ),
      ),
      Effect.tap(() => promoted(app)),
    );

  /**
   * Build a stored version's source, rewritten, as the plugin's new active version, expecting the
   * active version the caller read. Its build installs the packages that version's did.
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
        { rebuildOf: version, commit },
      );
    });

  /** Complete a plugin's pending change, holding it alone. */
  const complete = (id: AppId) =>
    Effect.gen(function* () {
      const pending = (yield* engine.apps.pending({ owner })).find((entry) => entry.app === id);
      if (pending === undefined) return settle(id);
      // Only the change holds the plugin; what follows activation runs once it is released.
      const done = yield* engine.apps
        .complete({ owner, app: id, version: pending.version }, { commit: alone })
        .pipe(Effect.result);
      if (done._tag === "Success") {
        yield* promoted(id);
        return yield* Effect.logInfo("Plugin version change completed").pipe(
          Effect.annotateLogs({ plugin: id, version: pending.version }),
        );
      }
      // A migration that did not commit deleted the version: the plugin keeps what was active.
      if (Schema.is(VersionBuildFailed)(done.failure)) {
        settle(id);
        return yield* Effect.logWarning(
          "A pending plugin version did not migrate; it is removed",
        ).pipe(Effect.annotateLogs({ plugin: id, reason: describe(done.failure) }));
      }
      return yield* Effect.fail(done.failure);
    });

  /** One rebuild of one plugin; only its commit holds the plugin. */
  const rebuildAttempt = (id: AppId) =>
    Effect.gen(function* () {
      const app = yield* engine.apps
        .get({ app: id, owner })
        .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));
      if (app === undefined || app.activeVersion === null) return settle(id);
      const active = yield* engine.apps.version({ app: id, owner, version: app.activeVersion });
      // The owner may have changed it since it was found.
      if (!(yield* stale(active.build))) return settle(id);
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
      settle(id);
      // What the Host keeps beside the active version follows: there is none now.
      yield* input.published(id);
      yield* Effect.logWarning("Plugin source does not build for the Host's framework").pipe(
        Effect.annotateLogs({ ...annotations, stage: failure.stage ?? "unknown" }),
      );
    });

  const attempt = (id: AppId) =>
    (pendingChanges.has(id) ? complete(id) : rebuildAttempt(id)).pipe(
      Effect.catch((error: unknown) =>
        Effect.gen(function* () {
          if (!updating.has(id)) return;
          const attempts = (updating.get(id)?.attempts ?? 0) + 1;
          const retryAt = Date.now() + backoff(attempts);
          updating.set(id, {
            reason: `${pendingChanges.has(id) ? completing : rebuilding} It could not finish and is tried again: ${describe(error)}`,
            attempts,
            retryAt,
          });
          yield* Effect.logWarning("Plugin version change will be tried again").pipe(
            Effect.annotateLogs({ plugin: id, attempts, reason: describe(error) }),
          );
        }),
      ),
    );

  return {
    /** Why the plugin is not served yet, or nothing when it is served. */
    updating: (app: string): Updating | undefined => updating.get(app as AppId),
    /** The plugins not served until their change finishes. */
    held: (): ReadonlyArray<AppId> => [...updating.keys()],
    /** Whether any plugin still waits. */
    pending: () => updating.size > 0,
    /**
     * Find the plugins whose change waits: a pending version, or a build for another framework.
     * Before the engine serves anything; it runs no plugin code.
     */
    scan: Effect.gen(function* () {
      for (const { app } of yield* engine.apps.pending({ owner })) {
        pendingChanges.add(app);
        updating.set(app, { reason: completing, attempts: 0, retryAt: 0 });
      }
      for (const app of yield* engine.apps.list({ owner })) {
        const version = app.activeVersion;
        if (version === null || updating.has(app.id)) continue;
        // A version that cannot be read now waits too: its first attempt reads it again.
        const waits = yield* engine.apps.version({ app: app.id, owner, version }).pipe(
          Effect.flatMap((active) => stale(active.build)),
          Effect.orElseSucceed(() => true),
        );
        if (waits) updating.set(app.id, { reason: rebuilding, attempts: 0, retryAt: 0 });
      }
      changed();
    }),
    /**
     * For the engine's life: finish every waiting plugin's change, one at a time, sleeping until
     * the next is due or another starts waiting.
     */
    run: Effect.gen(function* () {
      for (;;) {
        // Taken before the pass, so a plugin that starts waiting during it wakes the loop again.
        const signal = Promise.withResolvers<void>();
        wake = signal;
        for (const [id, state] of updating)
          if (state.retryAt <= Date.now()) yield* attempt(id);
        const due = [...updating.values()].map(({ retryAt }) => retryAt);
        const next = due.length === 0 ? undefined : Math.max(0, Math.min(...due) - Date.now());
        if (next === 0) continue;
        yield* Effect.raceFirst(
          Effect.promise(() => signal.promise),
          next === undefined ? Effect.never : Effect.sleep(next),
        );
      }
    }),
    /** The commit of a deploy into a plugin (see `DeployOptions.commit`). */
    commit,
    /**
     * Activate a stored version: its source is deployed again as a new version, through the same
     * change as any deploy, so its migrations are checked against the plugin's database. A failure
     * leaves the active version as it was. Returns the plugin with the version that became active.
     */
    activate: (app: AppId, version: VersionId) =>
      Effect.gen(function* () {
        const current = yield* engine.apps.get({ app, owner });
        return (yield* rebuild(current, version)).app;
      }),
    /** Remove a plugin with everything the engine keeps for it. */
    remove: (app: AppId) =>
      gate.change(
        app,
        engine.apps.remove({ app, owner }).pipe(
          Effect.tap(() => Effect.sync(() => settle(app))),
          Effect.tap(() => store.cleared(app)),
        ),
      ),
  };
};
