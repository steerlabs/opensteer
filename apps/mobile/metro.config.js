import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(import.meta.dirname);

// babel-preset-expo inlines every `process.env.EXPO_PUBLIC_*` value into a
// production bundle, but Metro keys its transform cache on source and
// transformer settings, not on those values. Without them in the key, a Release
// build reuses modules transformed for an earlier one with different values, and
// a build made without mock mode ships the mock configuration a previous build
// inlined.
config.cacheVersion = JSON.stringify([
  config.cacheVersion,
  Object.entries(process.env)
    .filter(([name]) => name.startsWith("EXPO_PUBLIC_"))
    .sort(([left], [right]) => (left < right ? -1 : 1)),
]);

// The workspace packages this app consumes are TypeScript source written under
// NodeNext, where a relative import spells the emitted JavaScript name. Metro
// resolves an exported `.ts` entry but not that substitution, so it is taught
// here rather than by rewriting the repository's 700-odd source files. Existing
// JavaScript still wins, and a genuinely missing module still fails.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (/^\.\.?\//.test(moduleName) && /\.jsx?$/.test(moduleName)) {
    const target = resolve(dirname(context.originModulePath), moduleName);

    if (!existsSync(target)) {
      const stem = moduleName.replace(/\.jsx?$/, "");
      const suffixes = platform === null ? ["native", ""] : [platform, "native", ""];
      const extensions = moduleName.endsWith(".jsx") ? ["tsx"] : ["ts", "tsx"];
      const hasSource = suffixes.some((suffix) =>
        extensions.some((extension) =>
          existsSync(
            resolve(
              dirname(context.originModulePath),
              `${stem}.${suffix ? `${suffix}.` : ""}${extension}`,
            ),
          ),
        ),
      );
      if (hasSource) {
        // Leave extension selection to Metro: passing a concrete .tsx file
        // bypasses its .ios/.android/.native priority and can ship the wrong UI.
        return context.resolveRequest(context, stem, platform);
      }
    }
  }

  return context.resolveRequest(context, moduleName, platform);
};

export default config;
