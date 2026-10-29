import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the Runner's own declared `@earendil-works/pi-coding-agent` dependency
 * put the engine's entry script.
 *
 * Pi is published as JavaScript rather than as a platform binary, so this is a
 * script the Runner runs with the Node interpreter it has already verified,
 * never an executable of its own. The package publishes no `./package.json`
 * export, so the path is anchored on `./rpc-entry`, which sits beside the CLI
 * entry in `dist/bundle`; `import.meta.resolve` is what reads it, because the
 * package declares only an `import` condition for that subpath.
 */
export function packagedPiExecutable(): string {
  const rpcEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
  return join(dirname(rpcEntry), "cli.js");
}
