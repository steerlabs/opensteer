// TypeScript 7 is a Go program, and Go takes its working directory from $PWD,
// so a checkout reached through a symlink would compile its files under two names.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const typescript = dirname(require.resolve("typescript/package.json"));
const directory = realpathSync(process.cwd());
const result = spawnSync(
  process.execPath,
  [
    join(typescript, require("typescript/package.json").bin.tsc),
    "-p",
    "tsconfig.tests.json",
    "--noEmit",
  ],
  { cwd: directory, env: { ...process.env, PWD: directory }, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
