// The bench's root half, on a root-only Unix socket: what the relay user may not do itself.
// One JSON command per connection. Test infrastructure only; never installed on a real host.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

const [socketPath, relayUser] = process.argv.slice(2);
const agentCgroup = "/sys/fs/cgroup/system.slice/opensteer-pool-agent.service/guests";
const config = "/etc/opensteer-pool/agent.json";

function processes(directory) {
  if (!existsSync(directory)) return 0;
  let count = readFileSync(join(directory, "cgroup.procs"), "utf8")
    .split("\n")
    .filter(Boolean).length;
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isDirectory()) count += processes(join(directory, entry.name));
  return count;
}

function probe(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1500 });
    const done = (result) => {
      socket.destroy();
      resolve({ result });
    };
    socket.once("connect", () => done("connected"));
    socket.once("timeout", () => done("timeout"));
    socket.once("error", (error) => done(error.code ?? "error"));
  });
}

async function run(command) {
  switch (command.cmd) {
    case "drop":
      execFileSync("sync");
      writeFileSync("/proc/sys/vm/drop_caches", "3\n");
      return { ok: true };
    case "arm":
      writeFileSync("/run/opensteer-pool/test-crash-at", `${command.point}\n`, { mode: 0o600 });
      execFileSync("systemctl", ["restart", "opensteer-pool-agent.service"]);
      return { ok: true };
    case "configure": {
      const value = JSON.parse(readFileSync(config, "utf8"));
      value.saveAfterSeconds = command.saveAfterSeconds;
      writeFileSync(config, JSON.stringify(value, null, 2), { mode: 0o600 });
      rmSync("/run/opensteer-pool/test-crash-at", { force: true });
      execFileSync("systemctl", ["restart", "opensteer-pool-agent.service"]);
      return { ok: true };
    }
    case "writers": {
      const key = createHash("sha256").update(command.slotId).digest("hex").slice(0, 24);
      return { count: processes(join(agentCgroup, key)) };
    }
    case "probe":
      return probe(command.host, command.port);
    case "facts": {
      const route = execFileSync("ip", ["-4", "route", "get", "1.1.1.1"], { encoding: "utf8" });
      return { hostAddress: route.match(/ src ([0-9.]+)/u)?.[1] };
    }
    default:
      return { error: "unknown command" };
  }
}

rmSync(socketPath, { force: true });
const server = createServer((socket) => {
  let text = "";
  socket.on("data", async (chunk) => {
    text += chunk.toString("utf8");
    if (!text.includes("\n")) return;
    const answer = await run(JSON.parse(text)).catch((error) => ({ error: String(error) }));
    socket.end(JSON.stringify(answer));
  });
});
// The socket is created mode 0600, then given to the relay user alone.
process.umask(0o177);
server.listen(socketPath, () => {
  execFileSync("chown", [relayUser, socketPath]);
  process.stdout.write("root-helper ready\n");
});
