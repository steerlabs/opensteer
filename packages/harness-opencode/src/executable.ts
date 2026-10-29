import { createRequire } from "node:module";

/**
 * OpenCode spells the operating system its own way in the platform package
 * names, and `win32` is not one of them.
 */
const opencodePlatforms = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
} as const;

/**
 * Where the Runner's own declared `opencode-ai` dependency put the engine.
 *
 * `opencode-ai` is a stub whose `bin/opencode.exe` is only filled in by a
 * postinstall script that hardlinks the matching platform package — and that
 * script reaches for `npm install` when it cannot resolve one. Nothing here
 * runs it: the platform package is an optional dependency pinned to the same
 * version, so the binary is resolved straight out of it, exactly the way the
 * Codex driver resolves its own platform package.
 *
 * The `-baseline` variants are for x64 processors without AVX2 and are not
 * selected: picking one would mean probing the CPU, and the plain build is
 * what every distribution stages and version-asserts.
 */
export function packagedOpencodeExecutable(): string {
  const architecture = process.arch;
  const platform = process.platform;
  if (
    (architecture !== "arm64" && architecture !== "x64") ||
    (platform !== "darwin" && platform !== "linux" && platform !== "win32")
  ) {
    throw new Error(`OpenCode does not provide a binary for ${platform}-${architecture}`);
  }

  const localRequire = createRequire(import.meta.url);
  const opencodeRequire = createRequire(localRequire.resolve("opencode-ai/package.json"));
  const base = `opencode-${opencodePlatforms[platform]}-${architecture}`;
  const binary = platform === "win32" ? "opencode.exe" : "opencode";
  // A musl machine has no glibc build to fall back on, and a glibc machine
  // cannot run the musl one, so the two are tried in the order this machine's
  // libc makes likely rather than treated as interchangeable.
  const packages =
    platform === "linux" && usesMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`];

  let resolveError: unknown;
  for (const packageName of packages) {
    try {
      return opencodeRequire.resolve(`${packageName}/bin/${binary}`);
    } catch (error) {
      resolveError = error;
    }
  }
  throw resolveError;
}

function usesMusl(): boolean {
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime === undefined;
}
