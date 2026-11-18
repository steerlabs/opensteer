/** Retain npm WASM assets for static compilation by Worker Loader. */
import type { InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { Path } from "effect";
import type { Plugin } from "esbuild";

/** The bundler installs binary assets before running this plugin. Browser builds use their own asset policy. */
export const wasmBuild = (filesystem: InMemoryFileSystem, path: Path.Path) => {
  const modules: Record<string, { wasm: Uint8Array }> = {};
  const plugin: Plugin = {
    name: "pluginEngine-wasm",
    setup(build) {
      const entries = build.initialOptions.entryPoints;
      if (!Array.isArray(entries) || entries[0] !== "__plugin_engine_worker.ts") return;
      build.onResolve({ filter: /\.wasm$/ }, (args) => {
        const resolved = args.path.startsWith(".")
          ? path.normalize(path.join(path.dirname(args.importer), args.path))
          : `node_modules/${args.path}`;
        const bytes = filesystem.readBinary(resolved);
        if (bytes === null) return { errors: [{ text: "WASM dependency asset is missing." }] };
        const name = `__plugin_engine_wasm/${resolved}`;
        modules[name] = { wasm: bytes };
        return { path: `./${name}`, external: true };
      });
    },
  };
  return { modules, plugin };
};
