import { createRequire } from "node:module";
import type * as TypeScript from "typescript-5";

let compiler: typeof TypeScript | undefined;

/**
 * Codemode's Node `#transpile`, bundled in its place so the JavaScript TypeScript compiler (about
 * 75 MiB resident) loads with the first agent program instead of with the engine process.
 */
export const transpile = (source: string): { outputText: string; error?: string } => {
  compiler ??= createRequire(import.meta.url)("typescript-5") as typeof TypeScript;
  const transpiled = compiler.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: compiler.ScriptTarget.ESNext,
      module: compiler.ModuleKind.ESNext,
    },
  });
  const diagnostic = transpiled.diagnostics?.find(
    (item) => item.category === compiler?.DiagnosticCategory.Error,
  );
  return diagnostic
    ? {
        outputText: transpiled.outputText,
        error: compiler.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      }
    : { outputText: transpiled.outputText };
};
