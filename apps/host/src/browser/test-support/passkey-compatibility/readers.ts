import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { buildSync, stop } from "esbuild";

interface Reader {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}
// Frozen pre-routing strict readers; these two wire contracts were unchanged
// between the pre-routing base and the previous release. Fixtures keep this
// proof independent of rebases, Git history and the moving piece-2 branch.
function previousReaders(file: string): Record<string, Reader> {
  const source = readFileSync(new URL(`./${file}.txt`, import.meta.url), "utf8");
  const built = buildSync({
    stdin: {
      contents: source,
      resolveDir: resolve("packages/protocol/src"),
      sourcefile: file,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  runInNewContext(built.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process,
    Buffer,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  return module.exports as Record<string, Reader>;
}
export const previousBrowser = previousReaders("browser.ts");
export const previousAuxiliary = previousReaders("runner-auxiliary.ts");
await stop();
