import { Deferred, Effect, Fiber } from "effect";
import { expect, test, vi } from "vitest";
import {
  OwnerId,
  StorageError,
  VersionBuildFailed,
  type AppId,
  type VersionId,
  type BuildId,
  type DeployOptions,
  type PluginEngine,
} from "@opensteer/plugin-engine-sdk/core";
import names from "../../../../packages/plugin-engine/upstream-names.json" with { type: "json" };
import { pluginGate } from "./plugin-gate.js";
import { pluginVersions, type RebuildFailure } from "./plugin-versions.js";

const owner = OwnerId.make("owner");
const host = { version: "host", sha256: "a".repeat(64) };
const earlier = { version: "earlier", sha256: "b".repeat(64) };
const route = names.rules.find((rule) => rule.scope === "route-path")!;
const failed = (stage: "dependencies" | "compile", retryable?: true) =>
  Effect.fail(
    new VersionBuildFailed({
      owner,
      name: "Plugin",
      reason: stage,
      stage,
      message: `${stage} failed`,
      ...(retryable ? { retryable } : {}),
    }),
  );

/**
 * An engine with one app per entry: the framework of its active build, how a deploy of it ends,
 * and what its build waits for. A deploy builds, then runs its commit, which checks the version it
 * expects is still active and makes a version on the Host's framework active.
 */
function engine(
  apps: Record<
    string,
    {
      framework: typeof host;
      deploy?: Effect.Effect<never, unknown>;
      build?: Effect.Effect<void>;
    }
  >,
) {
  const active = new Map(Object.keys(apps).map((id) => [id, `version-${id}`]));
  const frameworks = new Map(
    Object.entries(apps).map(([id, { framework }]) => [`build-version-${id}`, framework]),
  );
  const deployed: { app: string; files: unknown; rebuiltFrom: string | undefined }[] = [];
  const deactivated: string[] = [];
  const activated: string[] = [];
  const failures = new Map<string, RebuildFailure>();
  /** Commits run, and versions published, in order. */
  const log: string[] = [];
  const published: string[] = [];
  const removed: string[] = [];
  const expected: unknown[] = [];
  const fake = {
    apps: {
      list: () =>
        Effect.succeed(
          [...active].map(([id, version]) => ({ id, name: id, activeVersion: version })),
        ),
      get: ({ app }: { app: string }) =>
        Effect.succeed({ id: app, name: app, activeVersion: active.get(app) ?? null }),
      version: ({ version }: { version: string }) =>
        Effect.succeed({ id: version, build: `build-${version}` }),
      source: () =>
        Effect.succeed({
          files: [
            { path: "index.ts", content: `fetch("${route.from}version");` },
            { path: "package.json", content: "{}" },
          ],
        }),
      deployWith: (
        {
          app,
          files,
          expectedVersion,
        }: { app: string; files: unknown; expectedVersion?: string | null },
        options: DeployOptions,
      ) =>
        Effect.gen(function* () {
          deployed.push({ app, files, rebuiltFrom: options.rebuiltFrom });
          expected.push(expectedVersion);
          if (apps[app]!.build) yield* apps[app]!.build;
          log.push(`built:${app}`);
          const outcome = apps[app]!.deploy;
          if (outcome) return yield* outcome;
          const commit = options.commit ?? ((_app, work) => work);
          return yield* commit(
            app as AppId,
            Effect.gen(function* () {
              log.push(`commit:${app}`);
              if (active.get(app) !== expectedVersion)
                return yield* Effect.fail({ _tag: "AppVersionChanged" as const });
              const version = `rebuilt-${app}-${deployed.length}`;
              frameworks.set(`build-${version}`, host);
              active.set(app, version);
              return { app: { id: app, activeVersion: version }, version: { id: version } };
            }),
          );
        }),
      activate: ({
        app,
        version,
        expectedVersion,
      }: {
        app: string;
        version: string;
        expectedVersion?: string | null;
      }) =>
        Effect.sync(() => {
          expected.push(expectedVersion);
          activated.push(version);
          active.set(app, version);
          return { id: app, activeVersion: version };
        }),
      remove: ({ app }: { app: string }) =>
        Effect.sync(() => {
          removed.push(app);
          active.delete(app);
          return { app };
        }),
      deactivate: ({ app, expectedVersion }: { app: string; expectedVersion: string }) =>
        Effect.sync(() => {
          if (active.get(app) !== expectedVersion) return false;
          deactivated.push(app);
          active.delete(app);
          return true;
        }),
    },
  };
  const gate = pluginGate();
  const rebuilds = pluginVersions({
    // SAFETY: the rebuilds call only the app operations above.
    engine: fake as unknown as PluginEngine,
    owner,
    framework: host,
    linkedFramework: (build: BuildId) => Effect.succeed(frameworks.get(build)),
    store: {
      failed: (app, failure) => Effect.sync(() => void failures.set(app, failure)),
      cleared: (app) => Effect.sync(() => void failures.delete(app)),
    },
    gate,
    published: (plugin) =>
      Effect.sync(() => {
        published.push(plugin);
        log.push(`published:${plugin}`);
      }),
  });
  const pass = () =>
    Effect.runPromise(
      rebuilds.scan.pipe(Effect.andThen(rebuilds.run.pipe(Effect.timeout(1)))),
    ).catch(() => undefined);
  return {
    rebuilds,
    gate,
    pass,
    deployed,
    deactivated,
    activated,
    failures,
    log,
    published,
    removed,
    expected,
    active,
    frameworks,
  };
}

test("rebuilds only plugins built for another framework, from rewritten source, as their rebuild", async () => {
  const fixture = engine({ current: { framework: host }, stale: { framework: earlier } });
  await Effect.runPromise(fixture.rebuilds.scan);
  expect(fixture.rebuilds.updating("stale")).toMatchObject({ attempts: 0 });
  expect(fixture.rebuilds.updating("current")).toBeUndefined();
  await Effect.runPromise(fixture.rebuilds.run);
  expect(fixture.deployed).toEqual([
    {
      app: "stale",
      files: [
        { path: "index.ts", content: `fetch("${route.to}version");` },
        { path: "package.json", content: "{}" },
      ],
      // Work saved for the version it was rebuilt from continues on it.
      rebuiltFrom: "version-stale",
    },
  ]);
  expect(fixture.rebuilds.pending()).toBe(false);
  // A later start finds every plugin on the Host's framework and builds nothing.
  await Effect.runPromise(fixture.rebuilds.scan);
  expect(fixture.rebuilds.pending()).toBe(false);
});

test("a failure that did not judge the source keeps the plugin, updating, with its old version", async () => {
  const fixture = engine({
    offline: { framework: earlier, deploy: failed("dependencies", true) },
    storage: { framework: earlier, deploy: Effect.fail(new StorageError()) },
  });
  await fixture.pass();
  expect(fixture.deactivated).toEqual([]);
  expect(fixture.failures.size).toBe(0);
  expect([...fixture.active]).toEqual([
    ["offline", "version-offline"],
    ["storage", "version-storage"],
  ]);
  expect(fixture.rebuilds.updating("offline")).toMatchObject({
    attempts: 1,
    reason: expect.stringContaining("dependencies failed"),
  });
  expect(fixture.rebuilds.updating("storage")!.retryAt).toBeGreaterThan(Date.now());
});

test("a source that does not build ends with no active version and its diagnostic kept", async () => {
  const fixture = engine({
    broken: { framework: earlier, deploy: failed("compile") },
    fine: { framework: earlier },
  });
  await fixture.pass();
  expect(fixture.deactivated).toEqual(["broken"]);
  expect(fixture.failures.get("broken")).toEqual({
    version: "version-broken",
    message: "compile failed",
  });
  expect(fixture.rebuilds.pending()).toBe(false);
});

test("an attempt reads the active version again before it builds", async () => {
  const fixture = engine({ stale: { framework: earlier } });
  await Effect.runPromise(fixture.rebuilds.scan);
  // The owner deployed another version since the scan.
  fixture.active.set("stale", "elsewhere");
  fixture.frameworks.set("build-elsewhere", host);
  await Effect.runPromise(fixture.rebuilds.run);
  expect(fixture.deployed).toEqual([]);
  expect(fixture.rebuilds.pending()).toBe(false);
});

test("a rebuild whose version was changed while it built commits nothing and reads it again", async () => {
  const building = Effect.runSync(Deferred.make<void>());
  const fixture = engine({ stale: { framework: earlier, build: Deferred.await(building) } });
  await Effect.runPromise(fixture.rebuilds.scan);
  const run = Effect.runFork(fixture.rebuilds.run);
  await until(() => fixture.deployed.length === 1);
  // The owner deploys other source for the Host's framework while the rebuild builds.
  fixture.active.set("stale", "owner");
  fixture.frameworks.set("build-owner", host);
  Effect.runSync(Deferred.succeed(building, undefined));
  await Effect.runPromise(Fiber.join(run));
  expect(fixture.log).toEqual(["built:stale", "commit:stale"]);
  expect(fixture.active.get("stale")).toBe("owner");
  expect(fixture.published).toEqual([]);
  expect(fixture.rebuilds.pending()).toBe(false);
});

test("a build holds nothing; only its commit holds the plugin, with its execution", async () => {
  const building = Effect.runSync(Deferred.make<void>());
  const fixture = engine({
    slow: { framework: earlier, build: Deferred.await(building) },
    other: { framework: earlier },
  });
  await Effect.runPromise(fixture.rebuilds.scan);
  const run = Effect.runFork(fixture.rebuilds.run);
  await until(() => fixture.deployed.length === 1);
  // While the slow plugin builds, its own execution and changes, and every other plugin's, go on.
  expect(await Effect.runPromise(fixture.gate.run("slow", Effect.succeed("ran")))).toBe("ran");
  expect(await Effect.runPromise(fixture.gate.change("slow", Effect.succeed("changed")))).toBe(
    "changed",
  );
  await Effect.runPromise(
    fixture.rebuilds.activate("other" as AppId, "version-other" as VersionId),
  );
  expect(fixture.log).toEqual(["built:other", "commit:other", "published:other"]);
  // An execution of the slow plugin that runs when its commit starts is waited for, and none
  // starts until the commit ends.
  const executing = Effect.runSync(Deferred.make<void>());
  const execution = Effect.runFork(
    fixture.gate.run(
      "slow",
      Effect.sync(() => fixture.log.push("execution")).pipe(
        Effect.andThen(Deferred.await(executing)),
        Effect.andThen(Effect.sync(() => fixture.log.push("execution done"))),
      ),
    ),
  );
  await until(() => fixture.log.includes("execution"));
  Effect.runSync(Deferred.succeed(building, undefined));
  // Once built, its commit waits for the execution.
  await until(() => fixture.log.includes("built:slow"));
  expect(fixture.log).not.toContain("commit:slow");
  Effect.runSync(Deferred.succeed(executing, undefined));
  await Effect.runPromise(Fiber.join(execution));
  await Effect.runPromise(Fiber.join(run));
  expect(fixture.log.slice(3)).toEqual([
    "execution",
    "built:slow",
    "execution done",
    "commit:slow",
    "published:slow",
  ]);
});

test("activating a version built for another framework rebuilds it first", async () => {
  const fixture = engine({ stale: { framework: earlier } });
  await Effect.runPromise(fixture.rebuilds.scan);
  await Effect.runPromise(fixture.rebuilds.run);
  const rebuilt = fixture.active.get("stale")!;
  // Rolling back to the version from before the upgrade never activates its old build: it is
  // rebuilt, as that version's rebuild, and expects the version active when it read it.
  const activated = await Effect.runPromise(
    fixture.rebuilds.activate("stale" as AppId, "version-stale" as VersionId),
  );
  expect(fixture.activated).toEqual([]);
  expect(fixture.deployed.map(({ rebuiltFrom }) => rebuiltFrom)).toEqual([
    "version-stale",
    "version-stale",
  ]);
  expect(fixture.expected.at(-1)).toBe(rebuilt);
  expect(activated).toMatchObject({ activeVersion: fixture.active.get("stale") });
  // Activating a version already on the Host's framework activates it as it is.
  await Effect.runPromise(fixture.rebuilds.activate("stale" as AppId, rebuilt as VersionId));
  expect(fixture.activated).toEqual([rebuilt]);
  expect(fixture.published).toEqual(["stale", "stale", "stale"]);
});

test("a rebuild expects the version it read, and its promotion clears the plugin's state", async () => {
  const fixture = engine({ stale: { framework: earlier } });
  fixture.failures.set("stale", { version: "version-stale" as VersionId, message: "earlier" });
  await Effect.runPromise(fixture.rebuilds.scan);
  expect(fixture.rebuilds.held()).toEqual(["stale"]);
  await Effect.runPromise(fixture.rebuilds.run);
  expect(fixture.expected).toEqual(["version-stale"]);
  expect(fixture.published).toEqual(["stale"]);
  expect(fixture.failures.size).toBe(0);
  expect(fixture.rebuilds.held()).toEqual([]);
});

test("removing a plugin is its only change and forgets its rebuild", async () => {
  const fixture = engine({ gone: { framework: earlier } });
  await Effect.runPromise(fixture.rebuilds.scan);
  await Effect.runPromise(fixture.rebuilds.remove("gone" as AppId));
  expect(fixture.removed).toEqual(["gone"]);
  expect(fixture.rebuilds.held()).toEqual([]);
});

/** Wait until `done` holds. */
const until = (done: () => boolean) => vi.waitFor(() => expect(done()).toBe(true));
