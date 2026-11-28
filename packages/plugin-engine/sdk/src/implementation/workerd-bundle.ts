/** Bundle only trusted runtime/framework source on the host. Authored code compiles inside workerd. */
import { build } from "esbuild";
import { Effect, FileSystem, Path, Schema } from "effect";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";
import type { ModuleFile } from "./workerd-artifact.ts";

const SourceMapJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const frameworkModule = "plugin-engine-framework";

export const writeWorkerdHostBundle = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
    const root = file + ".modules";
    const maps: Record<string, unknown> = {};
    const writeWorker = (kind: "runtime" | "compiler", entry: string) =>
      Effect.gen(function* () {
        const directory = path.join(root, kind);
        yield* fs.makeDirectory(directory, { recursive: true });
        const compiled = yield* Effect.tryPromise(() =>
          build({
            // esbuild resolves .js to .ts in a checkout.
            entryPoints: { main: path.join(source, entry) },
            outdir: directory,
            bundle: true,
            format: "esm",
            platform: "browser",
            conditions: ["workerd"],
            target: "es2022",
            write: false,
            external: ["cloudflare:*", frameworkModule],
            loader: { ".wasm": "copy" },
            sourcemap: "external",
            sourcesContent: false,
          }),
        );
        const modules: ModuleFile[] = [];
        for (const output of compiled.outputFiles) {
          const name = path.basename(output.path);
          if (name.endsWith(".map")) {
            const map = yield* Schema.decodeUnknownEffect(SourceMapJson)(output.text);
            maps[`${kind}/${name.slice(0, -4)}`] = {
              ...map,
              sourceRoot: `${path.relative(path.dirname(path.resolve(file)), directory)}/`,
            };
          } else {
            yield* fs.writeFile(output.path, output.contents);
            modules.push({ name, type: name.endsWith(".wasm") ? "Wasm" : "ESModule" });
          }
        }
        return modules.sort((a, b) =>
          a.name === "main.js" ? -1 : b.name === "main.js" ? 1 : a.name.localeCompare(b.name),
        );
      });
    const runtime = yield* writeWorker("runtime", "workerd-entry.js");
    const compiler = yield* writeWorker("compiler", "workerd-compiler.js");
    const framework = yield* path.fromFileUrl(new URL(import.meta.resolve("apps/runtime.json")));
    yield* fs.copyFile(framework, path.join(root, "compiler", frameworkModule));
    compiler.push({ name: frameworkModule, type: "Text" });
    yield* fs.writeFileString(`${file}.map`, JSON.stringify(maps));
    yield* fs.writeFileString(file, JSON.stringify({ runtime, compiler }));
  }).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));
