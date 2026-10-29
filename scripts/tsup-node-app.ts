import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import type { Options } from "tsup";

// Packaging contract: Node apps use nodeApp to bundle workspace packages and
// libraries. Workspace TypeScript imports become app output, where pnpm's strict
// isolation resolves only the app's declared dependencies. Default externalising
// would leave imports that crash at runtime; keep externals explicit, justified
// and declared as direct app dependencies, and verify emitted imports each build.
// Reserve `optional` for guarded requires or runtime-provided modules, never
// missing dependencies. The sandboxed Electron preload bundles everything except
// `electron`.

const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export interface NodeAppOptions extends Omit<Options, "external" | "noExternal"> {
  /**
   * Packages that must not be bundled. Each entry carries its reason inline and
   * must be a direct dependency of the app.
   */
  readonly external?: readonly string[];
  /**
   * Bare imports the output may keep although the package is not installed with
   * the app: a guarded optional require, or a module the execution runtime
   * supplies. Each entry carries its reason inline.
   */
  readonly optional?: readonly string[];
}

export function nodeApp(options: NodeAppOptions): Options {
  const { external = [], optional = [], ...rest } = options;
  const appDirectory = process.cwd();
  const manifest = readManifest(appDirectory);
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));

  const undeclared = external.filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new Error(
      `${manifest.name}: external packages must be declared in dependencies (pnpm deploy --prod prunes everything else). Add: ${undeclared.join(", ")}`,
    );
  }

  return {
    // Bundled CommonJS keeps calling `require`, and esbuild's ESM output has
    // none, so its shim throws on the first `require("events")`. Give the
    // module a real one instead of externalising every CJS library.
    banner: {
      js: [
        `import { createRequire as __createRequire } from "node:module";`,
        `const require = __createRequire(import.meta.url);`,
      ].join("\n"),
    },
    clean: true,
    format: ["esm"],
    sourcemap: true,
    // Node 24 is the engines floor and the container's runtime.
    target: "node24",
    ...rest,
    external: [...external, ...optional],
    // tsup externalises every production dependency by default; this overrides
    // that for everything except the explicit lists above.
    noExternal: [bundleEverythingExcept([...external, ...optional])],
    esbuildPlugins: [
      ...(rest.esbuildPlugins ?? []),
      declaredImportsOnly(manifest.name, new Set([...declared, ...optional])),
    ],
  };
}

function bundleEverythingExcept(external: readonly string[]): RegExp {
  if (external.length === 0) return /.*/u;
  const alternatives = external.map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`^(?!(?:${alternatives.join("|")})(?:$|/))`, "u");
}

function declaredImportsOnly(
  appName: string,
  allowed: ReadonlySet<string>,
): NonNullable<Options["esbuildPlugins"]>[number] {
  return {
    name: "opensteer-packaging-contract",
    setup(build) {
      build.onEnd((result) => {
        const offenders = new Map<string, Set<string>>();
        for (const [outputPath, output] of Object.entries(result.metafile?.outputs ?? {})) {
          for (const imported of output.imports) {
            if (!imported.external) continue;
            const specifier = imported.path;
            if (specifier.startsWith(".") || path.isAbsolute(specifier)) continue;
            if (nodeBuiltins.has(specifier)) continue;
            const packageName = specifier.startsWith("@")
              ? specifier.split("/").slice(0, 2).join("/")
              : specifier.split("/")[0];
            if (!packageName || allowed.has(packageName)) continue;
            const files = offenders.get(packageName) ?? new Set<string>();
            files.add(outputPath);
            offenders.set(packageName, files);
          }
        }
        if (offenders.size === 0) return;
        const details = [...offenders]
          .map(([packageName, files]) => `${packageName} (${[...files].join(", ")})`)
          .join("; ");
        throw new Error(
          `${appName} emits imports it cannot resolve at runtime: ${details}. Bundle them, or declare them in this app's package.json dependencies.`,
        );
      });
    },
  };
}

function readManifest(appDirectory: string): {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
} {
  const manifestPath = path.join(appDirectory, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("name" in manifest) ||
    typeof manifest.name !== "string"
  ) {
    throw new Error(`${manifestPath} has no package name`);
  }
  return manifest as { readonly name: string; readonly dependencies?: Record<string, string> };
}
