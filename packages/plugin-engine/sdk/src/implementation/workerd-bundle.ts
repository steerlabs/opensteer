/** Bundle only trusted runtime/framework source on the host. Authored code compiles inside workerd. */
import { build } from "esbuild";
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { Module } from "@alchemy.run/cloudflare-runtime/core";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";
import { PublishedAppFramework } from "../contracts/worker-build.ts";
import { frameworkIdentity } from "./worker-build-storage.ts";

const HostBundle = Schema.mutable(
  Schema.Array(
    Schema.Union([
      Schema.Struct({
        name: Schema.String,
        type: Schema.Literals(["ESModule", "CommonJsModule", "Text", "Json", "PythonModule"]),
        content: Schema.String,
      }),
      Schema.Struct({
        name: Schema.String,
        type: Schema.Literals(["Data", "Wasm"]),
        content: Schema.Uint8ArrayFromBase64,
      }),
    ]),
  ),
);

const SourceMapJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

/**
 * Serialize a build artifact for installation or reuse by isolated processes from the same build.
 * Beside it, `<file>.map` holds each JavaScript module's source map, by module name, which E2E
 * coverage reads (see `e2e/coverage.ts`). The modules carry no source map reference, so they are
 * the modules `bundleWorkerdHost` builds.
 */
export const writeWorkerdHostBundle = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { modules, maps } = yield* buildWorkerdHost(true);
    const contents = yield* Schema.encodeEffect(Schema.fromJsonString(HostBundle))(modules);
    yield* fs.writeFileString(file, contents);
    // Source paths in each map resolve from the map file's directory.
    const sourceRoot = `${path.relative(path.dirname(path.resolve(file)), maps.directory)}/`;
    yield* fs.writeFileString(
      `${file}.map`,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(maps.files).map(([name, map]) => [name, { ...map, sourceRoot }]),
        ),
      ),
    );
  });

/** Load an explicitly prepared host artifact, or compile source for an ordinary development launch. */
export const workerdHostModules = Effect.gen(function* () {
  const file = yield* Config.String("PLUGIN_ENGINE_WORKER_BUNDLE").pipe(Config.option);
  if (Option.isNone(file)) return yield* bundleWorkerdHost;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(file.value)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HostBundle))));
}).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));

/**
 * The Host's framework, `apps/runtime.json`, as a Text module of the trusted host bundle. Every
 * plugin build links this framework, whatever `apps` version its `package.json` names; it is never
 * fetched from a registry. Declared for the entry in framework-module.d.ts.
 */
const frameworkModule = "plugin-engine-framework";

/** The framework a trusted host bundle gives every build, identified as a build that links it records it. */
export const hostFramework = (modules: ReadonlyArray<Module>) =>
  Effect.gen(function* () {
    const module = modules.find((candidate) => candidate.name === frameworkModule);
    if (module?.type !== "Text") return yield* new RuntimeBuildFailed({ stage: "compile" });
    const framework = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PublishedAppFramework),
    )(module.content).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));
    return yield* frameworkIdentity({ version: framework.version, modules: framework.server });
  });

/** Build the trusted Worker entry point, and with `sourceMap` each JavaScript module's map. */
const buildWorkerdHost = (sourceMap: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
    const outdir = path.join(directory, ".runtime-host");
    const compiled = yield* Effect.tryPromise(() =>
      build({
        // esbuild resolves .js to .ts in a checkout; installed packages contain the emitted .js.
        entryPoints: { main: path.join(directory, "workerd-entry.js") },
        outdir,
        bundle: true,
        format: "esm",
        platform: "browser",
        conditions: ["workerd"],
        target: "es2022",
        write: false,
        external: ["cloudflare:*", frameworkModule],
        loader: { ".wasm": "copy" },
        // An external map adds no reference to the module, so the module is unchanged.
        ...(sourceMap ? { sourcemap: "external" as const, sourcesContent: false } : {}),
      }),
    );
    const maps: Record<string, { readonly [key: string]: unknown }> = {};
    const modules: Module[] = [];
    for (const file of compiled.outputFiles) {
      const name = path.relative(outdir, file.path).split(path.sep).join("/");
      if (name.endsWith(".map"))
        maps[name.slice(0, -".map".length)] = yield* Schema.decodeUnknownEffect(SourceMapJson)(
          file.text,
        );
      else
        modules.push({
          name,
          ...(file.path.endsWith(".wasm")
            ? { type: "Wasm" as const, content: file.contents }
            : { type: "ESModule" as const, content: file.text }),
        });
    }
    modules.push({
      name: frameworkModule,
      type: "Text",
      content: yield* fs.readFileString(
        yield* path.fromFileUrl(new URL(import.meta.resolve("apps/runtime.json"))),
      ),
    });
    modules.sort((a, b) =>
      a.name === "main.js" ? -1 : b.name === "main.js" ? 1 : a.name.localeCompare(b.name),
    );
    return { modules, maps: { directory: outdir, files: maps } };
  }).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));

/** Build the trusted Worker entry point for this installation. */
export const bundleWorkerdHost = buildWorkerdHost(false).pipe(Effect.map(({ modules }) => modules));
