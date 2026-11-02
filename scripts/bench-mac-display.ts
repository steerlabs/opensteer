// Opt-in, offscreen only. Reuse OUT to reuse the source/parameter-hashed content cache.
// OPENSTEER_MAC_BENCH_SCENARIO=lan,4g,weak-cell,edge,handover,mixed
// OPENSTEER_MAC_BENCH_FPS=30,60 DURATION=20 OUT=<scratch directory>
// All variables use the OPENSTEER_MAC_BENCH_ prefix; PROFILE=baseline|main,
// GOP=6 (frames), RUNG=2 (0..4 => .75/1.5/3/6/12 Mbps).
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
