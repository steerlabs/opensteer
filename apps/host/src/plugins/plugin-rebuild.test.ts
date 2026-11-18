import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  OwnerId,
  StorageError,
  VersionBuildFailed,
  type BuildId,
  type PluginEngine,
} from "@opensteer/plugin-engine-sdk/core";
import names from "../../../../packages/plugin-engine/upstream-names.json" with { type: "json" };
import { rebuildInstalledPlugins } from "./plugin-rebuild.js";

const owner = OwnerId.make("owner");
const host = { version: "host", sha256: "a".repeat(64) };
const earlier = { version: "earlier", sha256: "b".repeat(64) };
const route = names.rules.find((rule) => rule.scope === "route-path")!;

/** An engine with one app per entry: its active build's framework and how its rebuild ends. */
function engine(
  apps: Record<string, { framework: typeof host; deploy?: Effect.Effect<never, unknown> }>,
) {
  const deployed: { app: string; files: unknown }[] = [];
  const deactivated: string[] = [];
  const fake = {
    apps: {
      list: () =>
        Effect.succeed(Object.keys(apps).map((id) => ({ id, activeVersion: `version-${id}` }))),
      version: ({ app }: { app: string }) =>
        Effect.succeed({ id: `version-${app}`, build: `build-${app}` }),
      source: () =>
        Effect.succeed({
          files: [
            { path: "index.ts", content: `fetch("${route.from}version");` },
            { path: "package.json", content: "{}" },
          ],
        }),
      deploy: ({ app, files }: { app: string; files: unknown }) => {
        deployed.push({ app, files });
        return apps[app]!.deploy ?? Effect.succeed({});
      },
      deactivate: ({ app }: { app: string }) =>
        Effect.sync(() => {
          deactivated.push(app);
        }),
    },
  };
  const run = () =>
    Effect.runPromise(
      rebuildInstalledPlugins({
        // SAFETY: the pass calls only the app operations above.
        engine: fake as unknown as PluginEngine,
        owner,
        framework: host,
        linkedFramework: (build: BuildId) =>
          Effect.succeed(apps[build.slice("build-".length)]!.framework),
      }),
    );
  return { run, deployed, deactivated };
}
const failed = (stage: "dependencies" | "compile") =>
  Effect.fail(
    new VersionBuildFailed({ owner, name: "Plugin", reason: stage, stage, message: stage }),
  );

test("rebuilds only plugins built for another framework, from rewritten source", async () => {
  const { run, deployed, deactivated } = engine({
    current: { framework: host },
    stale: { framework: earlier },
  });
  expect(await run()).toBe(1);
  expect(deployed).toEqual([
    {
      app: "stale",
      files: [
        { path: "index.ts", content: `fetch("${route.to}version");` },
        { path: "package.json", content: "{}" },
      ],
    },
  ]);
  expect(deactivated).toEqual([]);
});

test("leaves a plugin whose source does not build with no active version, and keeps going", async () => {
  const { run, deployed, deactivated } = engine({
    broken: { framework: earlier, deploy: failed("compile") },
    offline: { framework: earlier, deploy: failed("dependencies") },
    storage: { framework: earlier, deploy: Effect.fail(new StorageError()) },
    fine: { framework: earlier },
  });
  expect(await run()).toBe(1);
  expect(deployed.map(({ app }) => app)).toEqual(["broken", "offline", "storage", "fine"]);
  // A package the registry did not serve, or storage, may work at the next start.
  expect(deactivated).toEqual(["broken"]);
});
