// This leader never executes a workload until its parent confirms durable registration.
const { spawn } = require("node:child_process");
const { createConnection } = require("node:net");
const { createInterface } = require("node:readline");
let accepted = false;
let stoppingLegacy = false;
const stop = (graceful = false) => {
  if (!accepted) process.exit(0);
  if (graceful && process.env.OPENSTEER_LEGACY_GRACEFUL_STOP === "1") {
    stoppingLegacy = true;
    return;
  }
  // A registered wrapper only signals its own, still-live process group.
  process.kill(-process.pid, "SIGKILL");
};
process.on("disconnect", () => stop());
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => stop(true));
process.on("message", (message) => {
  if (accepted || message?.type !== "go") return;
  accepted = true;
  const child = spawn("/bin/bash", ["-c", process.argv[2]], {
    stdio: ["ignore", 1, 2, "pipe"],
    env: process.env,
  });
  const reports = createInterface({ input: child.stdio[3] });
  reports.on("line", (line) => {
    if (!message.socketPath) {
      child.stdio[3].write(JSON.stringify({ ok: false, error: "No registered app bridge" }) + "\n");
      return;
    }
    const socket = createConnection(message.socketPath);
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token: message.token, claim: JSON.parse(line) }) + "\n"),
    );
    let reply = "";
    socket.on("data", (data) => {
      reply += data.toString();
    });
    socket.on("end", () => child.stdio[3].write(reply));
    socket.on("error", (error) =>
      child.stdio[3].write(JSON.stringify({ ok: false, error: String(error) }) + "\n"),
    );
  });
  child.on("error", () => {
    process.send?.({ type: "result", code: 1 });
  });
  child.on("exit", (code) => {
    process.send?.({ type: "result", code: code ?? 1 });
    if (stoppingLegacy) process.exit(code ?? 1);
  });
});
process.send?.({ type: "waiting" });
