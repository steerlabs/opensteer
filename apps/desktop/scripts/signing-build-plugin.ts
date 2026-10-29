import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "esbuild";

const { writePlatformSigningConstants } = createRequire(import.meta.url)(
  "./signing-input.cjs",
) as typeof import("./signing-input.cjs");

/** onStart also runs on rebuilds; loading a cached config cannot retain a prior signer. */
export function signingBuildPlugin(): Plugin {
  return {
    name: "opensteer-current-signing-input",
    setup(build) {
      let source: string | undefined;
      build.onStart(() => {
        source = writePlatformSigningConstants(
          path.resolve(process.cwd(), "build/generated"),
          process.env,
          process.env.OPENSTEER_DESKTOP_TARGET_OS ?? process.platform,
        ).typescript;
      });
      build.onLoad({ filter: /[/\\]signed-helpers[/\\]signing-build\.ts$/ }, () => {
        if (source === undefined) throw Error("Signing input must be selected before bundling");
        return { contents: source, loader: "ts" };
      });
    },
  };
}
