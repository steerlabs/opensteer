import { Deferred, Effect, Schema } from "effect";
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
/** Where rebuilds coordinate across engine processes and keep what failed for good. */
export interface RebuildStore {
  /** Run `work` holding the plugin's rebuild claim, which one engine process holds at a time. */
  readonly claim: <A, E>(app: AppId, work: Effect.Effect<A, E>) => Effect.Effect<A, E | Error>;
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
 * Installed plugins whose active build links a framework other than the Host's, as there are
 * right after an upgrade. Such a plugin is not served at all until it is rebuilt: `updating`
 * names it, and the engine admits no call, page, schedule occurrence, workflow step or webhook for
 * it. `run` rebuilds them one at a time from the source of the active version, rewritten with the
 * upstream-name rules; the deploy builds it, then migrates the plugin's database and activates the
 * new version, so its accounts, links, settings, schedules and data stay. Nothing of the plugin
 * runs meanwhile, so nothing in flight needs protecting.
 *
 * Each attempt holds the plugin's claim and reads its active version again first, so two engines
 * rebuild it once. A failure that did not judge the source (a registry, memory, storage) keeps the
 * old version active and the plugin updating, and is tried again with backoff while the engine
 * runs and at its next start. A source that does not build is recorded with its diagnostic and
 * leaves the plugin with no active version, the state of a plugin whose build failed.
 */
export const pluginRebuilds = (input: {
  readonly engine: PluginEngine;
  readonly owner: OwnerId;
  readonly framework: Framework;
  readonly linkedFramework: (build: BuildId) => Effect.Effect<Framework | undefined>;
  readonly store: RebuildStore;
}) => {
  const { engine, owner, framework, store } = input;
  const updating = new Map<AppId, Updating>();
  let wake = Deferred.makeUnsafe<void>();
  const stale = (build: BuildId) =>
    input.linkedFramework(build).pipe(Effect.map((linked) => linked?.sha256 !== framework.sha256));

  /** Build a stored version's source, rewritten, as the plugin's new active version. */
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
      return yield* engine.apps.deploy({ owner, app: app.id, files: files.value });
    });

  /** One attempt at one plugin, under its claim. */
  const attempt = (id: AppId) =>
    store
      .claim(
        id,
        Effect.gen(function* () {
          const app = yield* engine.apps
            .get({ app: id, owner })
            .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));
          if (app === undefined || app.activeVersion === null) return updating.delete(id);
          const active = yield* engine.apps.version({ app: id, owner, version: app.activeVersion });
          // Another engine, or the owner, may have rebuilt it while this one waited for the claim.
          if (!(yield* stale(active.build))) return updating.delete(id);
          const started = performance.now();
          const built = yield* rebuild(app, active.id).pipe(Effect.result);
          const annotations = { plugin: id, ms: Math.round(performance.now() - started) };
          if (built._tag === "Success") {
            updating.delete(id);
            yield* store.cleared(id);
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
        yield* Effect.raceFirst(Effect.sleep(Math.max(0, next - Date.now())), Deferred.await(wake));
        wake = Deferred.makeUnsafe<void>();
      }
    }),
    /** Look at a plugin again now: its owner deployed, activated or removed a version. */
    changed: (app: string) =>
      Effect.sync(() => {
        const state = updating.get(app as AppId);
        if (state === undefined) return;
        updating.set(app as AppId, { ...state, retryAt: 0 });
        Deferred.doneUnsafe(wake, Effect.void);
      }),
    /**
     * Activate a stored version. One built for another framework is never activated as it is: its
     * source is rebuilt for the Host's framework first, under the plugin's claim, and the new
     * version activates. A failure leaves the active version as it was.
     */
    activate: (app: AppId, version: VersionId) =>
      Effect.gen(function* () {
        const stored = yield* engine.apps.version({ app, owner, version });
        if (!(yield* stale(stored.build)))
          return yield* engine.apps.activate({ app, owner, version });
        const rebuilt = yield* store.claim(
          app,
          Effect.gen(function* () {
            return yield* rebuild(yield* engine.apps.get({ app, owner }), version);
          }),
        );
        updating.delete(app);
        yield* store.cleared(app);
        return rebuilt.app;
      }),
  };
};
