import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

/**
 * The active pnpm, run as the JavaScript entrypoint pnpm names in `npm_execpath`
 * with this Node. Spawning a `pnpm` shim instead would need a shell on Windows.
 */
export function pnpmInvocation(environment: NodeJS.ProcessEnv): readonly [string, string] {
  const entrypoint = environment.npm_execpath?.trim();
  if (
    !entrypoint ||
    !isAbsolute(entrypoint) ||
    !/^pnpm\.[cm]?js$/u.test(basename(entrypoint)) ||
    !isRegularFile(entrypoint)
  )
    throw new Error(
      "Run this through pnpm (for example `pnpm dev`): npm_execpath does not name pnpm's JavaScript entrypoint. Run corepack enable from this repository.",
    );
  return [process.execPath, entrypoint];
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
