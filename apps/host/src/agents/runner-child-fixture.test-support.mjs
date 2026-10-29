import { spawn } from "node:child_process";

const scenario = process.argv[2];
process.on("SIGTERM", () => undefined);
if (scenario === "orphan" || scenario === "detached") {
  const descendant = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: "ignore", detached: scenario === "detached" },
  );
  descendant.once("spawn", () => {
    process.send({ descendant: descendant.pid }, () => process.exit(0));
  });
} else {
  process.on("message", (message) => {
    if (message === "probe") process.send({ observed: true });
    // Deliberately ignore close, including before the ready message.
  });
  process.send(scenario === "before-ready" ? { observed: true } : "ready");
  setInterval(() => {}, 1000);
}
