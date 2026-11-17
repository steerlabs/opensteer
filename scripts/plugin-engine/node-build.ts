import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

export const pluginEngineExternals = ["workerd", "typescript-5", "ws"];

/** The wrapper's dynamic imports must resolve in its own package after bundling. */
export const pluginEngineBuildPlugin: Plugin = {
  name: "plugin-runtime-imports",
  setup(build) {
    build.onResolve({ filter: /^@effect\/platform-bun(?:\/|$)/ }, (args) => ({
      path: args.path,
      external: true,
    }));
    build.onResolve({ filter: /^#transpile$/ }, (args) =>
      args.importer.includes("@opencode-ai/codemode")
        ? {
            path: fileURLToPath(
              new URL("../../apps/host/src/plugins/codemode-transpile.ts", import.meta.url),
            ),
          }
        : undefined,
    );
    build.onResolve({ filter: /^typescript$/ }, () => ({ path: "typescript-5", external: true }));
    build.onResolve({ filter: /^jsonc-parser$/ }, (args) =>
      build.resolve("jsonc-parser/lib/esm/main.js", {
        kind: args.kind,
        resolveDir: args.resolveDir,
      }),
    );
    build.onLoad(
      { filter: /cloudflare-runtime\/dist\/core\/node\/internal\/internal-worker\.mjs$/ },
      async (args) => {
        // Refuse dependency drift instead of silently losing the runtime's worker resources.
        const original = await readFile(args.path, "utf8");
        if (!original.includes("(specifier) => import(specifier)"))
          throw new Error("Plugin runtime worker loader changed; review its packaged resources");
        return {
          contents: `import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const runtimeRequire = createRequire(createRequire(import.meta.url).resolve("@alchemy.run/cloudflare-runtime/package.json"));
export const loadInternalWorker = (specifier) => import(pathToFileURL(runtimeRequire.resolve(specifier)).href);`,
          loader: "js",
        };
      },
    );
  },
};
