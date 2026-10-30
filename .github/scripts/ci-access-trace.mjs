/**
 * Records what Vitest workers, and the processes their tests start, read from
 * disk, list, copy and launch, so ci-native-access.mjs can prove the iphone task's
 * inputs cover them. Loaded with NODE_OPTIONS=--import. It stays silent unless
 * CI_ACCESS_TRACE names the JSONL file to append to, and in Vitest's main process,
 * whose test discovery lists the whole checkout: only workers start with VITEST set.
 */
import fs from "node:fs";
import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
  // Replaces owner[name], and the form util.promisify makes of it, with one that
  // notes its arguments first.
  const intercept = (owner, name, note) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      note(args);
      return Reflect.apply(original, this, args);
    };
    const { [promisify.custom]: custom, ...descriptors } =
      Object.getOwnPropertyDescriptors(original);
    Object.defineProperties(wrapped, descriptors);
    if (typeof custom?.value === "function")
      Object.defineProperty(wrapped, promisify.custom, {
        value(...args) {
          note(args);
          return Reflect.apply(custom.value, this, args);
        },
      });
    owner[name] = wrapped;
  };
  const wrap = (owner, name, kind) => intercept(owner, name, ([target]) => record(kind, target));
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
  for (const name of ["copyFileSync", "copyFile", "cpSync", "cp"]) wrap(fs, name, "copy");
  for (const name of ["readFile", "open", "stat", "lstat", "access"])
    wrap(fs.promises, name, "read");
  for (const name of ["readdir", "opendir"]) wrap(fs.promises, name, "list");
  for (const name of ["copyFile", "cp"]) wrap(fs.promises, name, "copy");

  // spawn(command, [args], [options]) and its siblings: the program, every word of
  // its arguments, and the directory they are relative to. A shell splits words itself.
  const launch = (name, shell) =>
    intercept(childProcess, name, ([command, ...rest]) => {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      const options = rest.find(
        (value) => value && typeof value === "object" && !Array.isArray(value),
      );
      const cwd = options?.cwd ?? process.cwd();
      const kind = shell || options?.shell ? "shell" : "exec";
      record(kind, command, cwd);
      for (const arg of args) record(kind, arg, cwd);
    });
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"])
    launch(name, false);
  for (const name of ["exec", "execSync"]) launch(name, true);
  syncBuiltinESMExports();

  // Modules a started process loads natively, such as a script run through tsx.
  registerHooks?.({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) record("read", new URL(url));
      return nextLoad(url, context);
    },
  });
}
