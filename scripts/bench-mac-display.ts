// Opt-in, offscreen only. OUT reuses the production-source-hashed Swift binary.
// OPENSTEER_MAC_BENCH_SCENARIO=lan,4g,weak-cell,edge,handover,mixed
// OPENSTEER_MAC_BENCH_FPS=60 OPENSTEER_MAC_BENCH_DURATION=20
// OPENSTEER_MAC_BENCH_OUT=<scratch directory> OPENSTEER_MAC_BENCH_LEGACY=1
import { spawn } from "node:child_process";

if (process.platform !== "darwin")
  throw new Error("Mac display benchmark requires macOS VideoToolbox");
const child = spawn(
  "pnpm",
  ["exec", "vitest", "run", "--config", "scripts/mac-display.vitest.config.ts"],
  {
    stdio: "inherit",
    env: process.env,
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
