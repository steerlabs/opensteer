import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  integrationBundleSpec,
  integrationBuildRefused,
  integrationManifestSchema,
  snapshotIntegrationInputs,
  type IntegrationBundleKind,
} from "@opensteer/shared/test-support/integrationRunnerBuild";
import { runnerExternals } from "./runner-build-options.js";

export {
  integrationBundleEntry,
  type IntegrationBundleKind,
} from "@opensteer/shared/test-support/integrationRunnerBuild";

const metafileSchema = z.object({
  inputs: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), z.unknown()),
});

async function configurationInputs(root: string, app: string, sources: readonly string[]) {
  const paths = new Set([
    join(root, "package.json"),
    join(root, "pnpm-lock.yaml"),
    join(root, "pnpm-workspace.yaml"),
    join(root, "tsconfig.base.json"),
    join(root, "scripts/tsup-node-app.ts"),
    join(root, "scripts/runner-build-options.ts"),
  ]);
  // Package exports/type and each enclosing tsconfig affect resolution even
  // though esbuild's runtime-input metafile does not list them.
  for (const source of [app, ...sources]) {
    for (let directory = source === app ? app : dirname(source); ; directory = dirname(directory)) {
      paths.add(join(directory, "package.json"));
      paths.add(join(directory, "tsconfig.json"));
      if (directory === root || dirname(directory) === directory) break;
    }
  }
  const existing = await Promise.all(
    [...paths].map(async (path) => {
      try {
        await access(path);
        return path;
      } catch {
        return undefined;
      }
    }),
  );
  return existing.filter((path) => path !== undefined);
}

export async function invalidateIntegrationBundles(root: string): Promise<void> {
  await Promise.all(
    (["recovery", "desktop"] as const).map((kind) =>
      rm(integrationBundleSpec(root, kind).manifest, { force: true }),
    ),
  );
}

/** Resolve inputs without publishing outputs, then snapshot before the certified build. */
export async function prepareIntegrationBundle(
  root: string,
  kind: IntegrationBundleKind,
  signal?: AbortSignal,
): Promise<{ readonly publish: () => Promise<void> }> {
  root = resolve(root);
  const spec = integrationBundleSpec(root, kind);
  await rm(spec.manifest, { force: true });
  signal?.throwIfAborted();
  const configs = spec.configs.map((file) => join(spec.app, file));
  const initial = await snapshotIntegrationInputs([
    ...configs,
    ...(await configurationInputs(root, spec.app, [])),
  ]);
  // The analysis uses the same entry points, resolution config and externals
  // as tsup. Including build configs discovers their own local imports too.
  const { context } = await import("esbuild");
  const analysis = await context({
    absWorkingDir: spec.app,
    entryPoints: [...spec.sources, ...spec.configs],
    external: [...runnerExternals, "electron", "tsup", "esbuild"],
    bundle: true,
    platform: "node",
    target: "node24",
    mainFields: ["module", "main"],
    format: "esm",
    splitting: true,
    outdir: spec.output,
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const cancel = () => {
    void analysis.cancel();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let sources: string[];
  try {
    signal?.throwIfAborted();
    const result = await analysis.rebuild();
    sources = Object.keys(result.metafile!.inputs).map((file) => resolve(spec.app, file));
  } finally {
    signal?.removeEventListener("abort", cancel);
    await analysis.dispose();
  }
  const inputs = await snapshotIntegrationInputs([
    ...sources,
    ...configs,
    ...(await configurationInputs(root, spec.app, sources)),
  ]);
  for (const [path, hash] of Object.entries(initial))
    if (inputs[path] !== hash)
      throw integrationBuildRefused(kind, "inputs changed during build preparation");
  signal?.throwIfAborted();
  return {
    async publish() {
      signal?.throwIfAborted();
      const after = await snapshotIntegrationInputs(Object.keys(inputs));
      if (JSON.stringify(inputs) !== JSON.stringify(after))
        throw integrationBuildRefused(kind, "inputs changed during build");
      const metadata = metafileSchema.parse(
        JSON.parse(await readFile(join(spec.output, "metafile-esm.json"), "utf8")),
      );
      if (
        kind === "recovery" &&
        Object.keys(metadata.inputs).some(
          (file) => resolve(spec.app, file) === join(spec.app, "src/main.ts"),
        )
      )
        throw integrationBuildRefused(kind, "includes the incidental CLI entry");
      for (const file of Object.keys(metadata.inputs))
        if (!inputs[resolve(spec.app, file)])
          throw integrationBuildRefused(kind, "inputs changed during build resolution");
      const outputs = await snapshotIntegrationInputs(
        Object.keys(metadata.outputs).map((file) => resolve(spec.app, file)),
      );
      if (!outputs[spec.entry]) throw integrationBuildRefused(kind, "is missing its built entry");
      const manifest = integrationManifestSchema.parse({
        version: 1,
        root,
        kind,
        entry: spec.entry,
        inputs,
        outputs,
      });
      await mkdir(spec.output, { recursive: true });
      const temporary = `${spec.manifest}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(manifest) + "\n");
        signal?.throwIfAborted();
        await rename(temporary, spec.manifest);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
