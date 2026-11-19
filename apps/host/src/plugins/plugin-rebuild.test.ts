import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  OwnerId,
  StorageError,
  VersionBuildFailed,
  type AppId,
  type VersionId,
  type BuildId,
  type PluginEngine,
} from "@opensteer/plugin-engine-sdk/core";
import names from "../../../../packages/plugin-engine/upstream-names.json" with { type: "json" };
import { pluginRebuilds, type RebuildFailure } from "./plugin-rebuild.js";

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
 * An engine with one app per entry: the framework of its active build and how a deploy of it ends.
 * A deploy that succeeds makes a version on the Host's framework active.
 */
function engine(
  apps: Record<string, { framework: typeof host; deploy?: Effect.Effect<never, unknown> }>,
) {
  const active = new Map(Object.keys(apps).map((id) => [id, `version-${id}`]));
  const frameworks = new Map(
    Object.entries(apps).map(([id, { framework }]) => [`build-version-${id}`, framework]),
  );
  const deployed: { app: string; files: unknown }[] = [];
  const deactivated: string[] = [];
  const activated: string[] = [];
  const failures = new Map<string, RebuildFailure>();
  const claims: string[] = [];
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
      deploy: ({ app, files }: { app: string; files: unknown }) => {
        deployed.push({ app, files });
        const outcome = apps[app]!.deploy;
        if (outcome) return outcome;
        const version = `rebuilt-${app}-${deployed.length}`;
        frameworks.set(`build-${version}`, host);
        active.set(app, version);
        return Effect.succeed({ app: { id: app, activeVersion: version } });
      },
      activate: ({ app, version }: { app: string; version: string }) =>
        Effect.sync(() => {
          activated.push(version);
          active.set(app, version);
          return { id: app, activeVersion: version };
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
  const rebuilds = pluginRebuilds({
    // SAFETY: the rebuilds call only the app operations above.
    engine: fake as unknown as PluginEngine,
    owner,
    framework: host,
    linkedFramework: (build: BuildId) => Effect.succeed(frameworks.get(build)),
    store: {
      claim: (app, work) => Effect.sync(() => claims.push(app)).pipe(Effect.andThen(work)),
      failed: (app, failure) => Effect.sync(() => void failures.set(app, failure)),
      cleared: (app) => Effect.sync(() => void failures.delete(app)),
    },
  });
  const pass = () =>
    Effect.runPromise(
      rebuilds.scan.pipe(Effect.andThen(rebuilds.run.pipe(Effect.timeout(1)))),
    ).catch(() => undefined);
  return { rebuilds, pass, deployed, deactivated, activated, failures, claims, active, frameworks };
}

test("rebuilds only plugins built for another framework, from rewritten source", async () => {
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

test("an attempt reads the active version again under the plugin's claim", async () => {
  const fixture = engine({ stale: { framework: earlier } });
  await Effect.runPromise(fixture.rebuilds.scan);
  // Another engine rebuilt it while this one waited for the claim.
  fixture.active.set("stale", "elsewhere");
  fixture.frameworks.set("build-elsewhere", host);
  await Effect.runPromise(fixture.rebuilds.run);
  expect(fixture.claims).toEqual(["stale"]);
  expect(fixture.deployed).toEqual([]);
  expect(fixture.rebuilds.pending()).toBe(false);
});

test("activating a version built for another framework rebuilds it first", async () => {
  const fixture = engine({ stale: { framework: earlier } });
  await Effect.runPromise(fixture.rebuilds.scan);
  await Effect.runPromise(fixture.rebuilds.run);
  const rebuilt = fixture.active.get("stale")!;
  // Rolling back to the version from before the upgrade never activates its old build.
  await Effect.runPromise(
    fixture.rebuilds.activate("stale" as AppId, "version-stale" as VersionId),
  );
  expect(fixture.activated).toEqual([]);
  expect(fixture.deployed).toHaveLength(2);
  // Activating a version already on the Host's framework activates it as it is.
  await Effect.runPromise(fixture.rebuilds.activate("stale" as AppId, rebuilt as VersionId));
  expect(fixture.activated).toEqual([rebuilt]);
});
