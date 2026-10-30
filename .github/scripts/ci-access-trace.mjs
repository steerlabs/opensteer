/**
 * Records what Vitest workers, and the processes their tests start, read from
 * disk, list and launch, so ci-native-access.mjs can prove the iphone task's
 * inputs cover them. Loaded with NODE_OPTIONS=--import. It stays silent unless
 * CI_ACCESS_TRACE names the JSONL file to append to, and in Vitest's main process,
 * whose test discovery lists the whole checkout: only workers start with VITEST set.
 */
import fs from "node:fs";
import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const trace = process.env.CI_ACCESS_TRACE;
if (trace && process.env.VITEST === "true") {
  // Bound before any wrapping, so the trace never records or recurses into itself.
  const append = fs.appendFileSync;
  const record = (kind, target, cwd = process.cwd()) => {
    try {
      const path =
        typeof target === "string"
          ? target
          : target instanceof URL
            ? target.protocol === "file:"
              ? fileURLToPath(target)
              : undefined
            : Buffer.isBuffer(target)
              ? target.toString()
              : undefined;
      if (path) append(trace, JSON.stringify({ kind, path, cwd: String(cwd) }) + "\n");
    } catch {
      // Observation never changes the observed code's behavior.
    }
  };
  const wrap = (owner, name, kind) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    const wrapped = function (target, ...rest) {
      record(kind, target);
      return Reflect.apply(original, this, [target, ...rest]);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    owner[name] = wrapped;
  };
  for (const name of [
    "readFileSync",
    "readFile",
    "openSync",
    "open",
    "createReadStream",
    "existsSync",
    "exists",
    "statSync",
    "stat",
    "lstatSync",
    "lstat",
    "accessSync",
    "access",
  ])
    wrap(fs, name, "read");
  for (const name of ["readdirSync", "readdir", "opendirSync", "opendir"]) wrap(fs, name, "list");
  for (const name of ["readFile", "open", "stat", "lstat", "access"])
    wrap(fs.promises, name, "read");
  for (const name of ["readdir", "opendir"]) wrap(fs.promises, name, "list");

  // spawn(command, [args], [options]) and its siblings: the program, every word of
  // its arguments, and the directory they are relative to.
  const launch = (name, kind) => {
    const original = childProcess[name];
    const wrapped = function (command, ...rest) {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      const options = rest.find(
        (value) => value && typeof value === "object" && !Array.isArray(value),
      );
      const cwd = options?.cwd ?? process.cwd();
      record(kind, command, cwd);
      for (const arg of args) record(kind, arg, cwd);
      return Reflect.apply(original, this, [command, ...rest]);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    childProcess[name] = wrapped;
  };
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"])
    launch(name, "exec");
  for (const name of ["exec", "execSync"]) launch(name, "shell");
  syncBuiltinESMExports();

  // Modules a started process loads natively, such as a script run through tsx.
  registerHooks?.({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) record("read", new URL(url));
      return nextLoad(url, context);
    },
  });
}
