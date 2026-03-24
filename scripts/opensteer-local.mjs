import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const cliScriptPath = path.join(repoRoot, "packages", "opensteer", "src", "cli", "bin.ts");
const tsconfigPath = path.join(repoRoot, "tsconfig.json");
const invocationCwd = process.env.INIT_CWD || process.cwd();
const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve("tsx", { paths: [repoRoot] });
const rawArgs = process.argv.slice(2);
const forwardedArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

const child = spawn(
  process.execPath,
  ["--import", tsxLoaderPath, cliScriptPath, ...forwardedArgs],
  {
    cwd: invocationCwd,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH ?? tsconfigPath,
    },
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
