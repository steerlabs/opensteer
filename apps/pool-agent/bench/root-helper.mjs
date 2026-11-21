// The bench's root half, on a root-only Unix socket: what the relay user may not do itself.
// One JSON command per connection. Test infrastructure only; never installed on a real host.
import { execFile, execFileSync, spawnSync } from "node:child_process";
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
    case "record-immutable": {
      // Review S2 on a host: the slot's journal record cannot be replaced, so the next write fails.
      const key = createHash("sha256").update(command.slotId).digest("hex");
      const file = `/var/lib/opensteer-pool/journal/slot-${key}.json`;
      execFileSync("chattr", [command.on ? "+i" : "-i", file]);
      return { ok: true };
    }
    case "vmm-pids": {
      const key = createHash("sha256").update(command.slotId).digest("hex").slice(0, 24);
      const pids = [];
      const walk = (directory) => {
        if (!existsSync(directory)) return;
        for (const pid of readFileSync(join(directory, "cgroup.procs"), "utf8")
          .split("\n")
          .filter(Boolean))
          pids.push(pid);
        for (const entry of readdirSync(directory, { withFileTypes: true }))
          if (entry.isDirectory()) walk(join(directory, entry.name));
      };
      walk(join(agentCgroup, key));
      return { pids };
    }
    case "memory-events": {
      const key = createHash("sha256").update(command.slotId).digest("hex").slice(0, 24);
      const text = readFileSync(join(agentCgroup, key, "memory.events"), "utf8");
      return Object.fromEntries(
        text
          .trim()
          .split("\n")
          .map((line) => line.split(" "))
          .map(([k, v]) => [k, Number(v)]),
      );
    }
    case "agent-events": {
      const text = execFileSync(
        "journalctl",
        ["-u", "opensteer-pool-agent", "--since", command.since, "-o", "cat", "--no-pager"],
        { encoding: "utf8" },
      );
      return {
        lines: text
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .slice(-400),
      };
    }
    case "egress-log": {
      // Round 4, item 2: what the slots' proxies refused (driver.egressLog), and their starts.
      const text = spawnSync(
        "journalctl",
        [
          "-u",
          "opensteer-pool-egress-*",
          "--since",
          command.since,
          "-o",
          "short-unix",
          "--no-pager",
        ],
        { encoding: "utf8" },
      ).stdout;
      return { lines: text.trim().split("\n").filter(Boolean).slice(-40) };
    }
    case "agent-state":
      // `is-active` exits non-zero for every state but active; its answer is still the state.
      return {
        state: spawnSync("systemctl", ["is-active", "opensteer-pool-agent"], {
          encoding: "utf8",
        }).stdout.trim(),
      };
    case "agent": {
      for (const action of command.actions)
        execFileSync("systemctl", [action, "opensteer-pool-agent"]);
      return { ok: true };
    }
    case "agent-restart-timed": {
      const started = performance.now();
      execFileSync("systemctl", ["restart", "opensteer-pool-agent"]);
      for (;;) {
        const up = await probe("127.0.0.1", 7310);
        if (up.result === "connected") return { ms: performance.now() - started };
        if (performance.now() - started > 300_000) return { ms: null };
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    case "array": {
      if (command.mount)
        execFileSync("mount", [
          "-o",
          "noatime,nosuid",
          "/dev/mapper/osp-saved",
          "/srv/opensteer-pool",
        ]);
      else execFileSync("umount", ["/srv/opensteer-pool"]);
      return { ok: true };
    }
    case "nft-flush":
      execFileSync("nft", ["flush", "ruleset"]);
      return { ok: true };
    case "nft-tables":
      return {
        tables: execFileSync("nft", ["list", "tables"], { encoding: "utf8" }).trim().split("\n"),
      };
    case "nft-reload":
      execFileSync("systemctl", ["restart", "nftables"]);
      return {
        tables: execFileSync("nft", ["list", "tables"], { encoding: "utf8" }).trim().split("\n"),
      };
    case "proxy-probe":
      // Asynchronous, so probes sent together run together (re-check finding 9).
      return new Promise((resolve) =>
        execFile(
          "ip",
          [
            "netns",
            "exec",
            `osp${command.index}`,
            "nc",
            "-z",
            "-w",
            "1",
            command.host,
            String(command.port),
          ],
          (error) => resolve({ result: error ? "blocked" : "connected" }),
        ),
      );
    case "make-profiles": {
      for (let index = command.from; index < command.to; index += 1) {
        const file = `/var/lib/opensteer-pool/profiles/bench-${index}.ext4`;
        if (!existsSync(file)) execFileSync("truncate", ["-s", "256M", file]);
      }
      return { ok: true };
    }
    case "agent-restarts": {
      const show = (property) =>
        spawnSync("systemctl", ["show", "-p", property, "--value", "opensteer-pool-agent"], {
          encoding: "utf8",
        }).stdout.trim();
      return { restarts: Number(show("NRestarts")), state: show("ActiveState") };
    }
    case "kvm-pit": {
      const file = "/run/opensteer-pool/kvm-pit.json";
      const events = spawnSync(
        "journalctl",
        ["-u", "opensteer-pool-agent", "-b", "-o", "cat", "--no-pager", "--grep", "kvm-pit"],
        { encoding: "utf8" },
      )
        .stdout.trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .slice(-3);
      return { state: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null, events };
    }
    case "boot-agent-ready": {
      // From the agent's first start in this boot to its "agent.ready", in the journal's own times.
      const lines = spawnSync(
        "journalctl",
        ["-u", "opensteer-pool-agent", "-b", "-o", "json", "--no-pager"],
        { encoding: "utf8" },
      )
        .stdout.trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const started = lines.find((line) => /Started/u.test(line.MESSAGE ?? ""));
      const ready = lines.find((line) => /"agent.ready"/u.test(line.MESSAGE ?? ""));
      const failed = lines.filter((line) =>
        /"agent.failed"|"agent.fatal"/u.test(line.MESSAGE ?? ""),
      );
      const at = (line) => (line ? Number(line.__REALTIME_TIMESTAMP) / 1000 : null);
      return {
        agent_start_to_ready_ms: started && ready ? Math.round(at(ready) - at(started)) : null,
        ready_line: ready?.MESSAGE ?? null,
        failures_this_boot: failed.length,
        uptime_s: Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]),
      };
    }
    case "proxy-usage": {
      // Round D, D1: what one slot's proxy holds now: established connections and memory.
      const established = spawnSync(
        "ip",
        [
          "netns",
          "exec",
          `osp${command.index}`,
          "ss",
          "-Htn",
          "state",
          "established",
          "( sport = :3128 )",
        ],
        { encoding: "utf8" },
      ).stdout.trim();
      const memory = spawnSync(
        "systemctl",
        [
          "show",
          "-p",
          "MemoryCurrent",
          "--value",
          `opensteer-pool-egress-${command.index}.service`,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
      return {
        connections: established ? established.split("\n").length : 0,
        memory: /^\d+$/u.test(memory) ? Number(memory) : null,
      };
    }
    case "proxy-unit": {
      // Round E, E3: the properties the results claim for a slot's proxy unit and its slice,
      // read from systemd, and the host's cores the slice's CPU ceiling is chosen from.
      const read = (name, properties) =>
        Object.fromEntries(
          spawnSync("systemctl", ["show", name, ...properties.map((p) => `--property=${p}`)], {
            encoding: "utf8",
          })
            .stdout.trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        );
      return {
        unit: read(`opensteer-pool-egress-${command.index}.service`, [
          "StartLimitIntervalUSec",
          "StartLimitBurst",
          "MemoryMax",
          "CPUQuotaPerSecUSec",
          "TasksMax",
          "Slice",
        ]),
        slice: read("opensteer-pool-egress.slice", ["MemoryMax", "CPUQuotaPerSecUSec"]),
        cores: Number(spawnSync("nproc", [], { encoding: "utf8" }).stdout.trim()),
      };
    }
    case "proxy-crash-loop": {
      // Round D, D1: the slot's proxy is killed whenever it runs, for command.seconds; systemd's
      // start limit must stop restarting it. PID 1's CPU time across the loop is reported.
      const unit = `opensteer-pool-egress-${command.index}.service`;
      const show = (property, name = unit) =>
        spawnSync("systemctl", ["show", "-p", property, "--value", name], {
          encoding: "utf8",
        }).stdout.trim();
      const pid1 = () => {
        const fields = readFileSync("/proc/1/stat", "utf8").split(") ")[1].split(" ");
        return (Number(fields[11]) + Number(fields[12])) * 10;
      };
      const cpuBefore = pid1();
      const started = performance.now();
      let kills = 0;
      spawnSync("systemctl", ["start", unit]);
      while (performance.now() - started < command.seconds * 1000) {
        const pid = Number(show("MainPID"));
        if (pid > 0) {
          spawnSync("kill", ["-9", String(pid)]);
          kills += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        kills,
        service: show("ActiveState"),
        result: show("Result"),
        socket: show("ActiveState", `opensteer-pool-egress-${command.index}.socket`),
        pid1_cpu_ms: pid1() - cpuBefore,
        seconds: command.seconds,
      };
    }
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
  socket.on("data", (chunk) => {
    text += chunk.toString("utf8");
    if (!text.includes("\n")) return;
    void run(JSON.parse(text))
      .catch((error) => ({ error: String(error) }))
      .then((answer) => socket.end(JSON.stringify(answer)));
  });
});
// The socket is created mode 0600, then given to the relay user alone.
process.umask(0o177);
server.listen(socketPath, () => {
  execFileSync("chown", [relayUser, socketPath]);
  process.stdout.write("root-helper ready\n");
});
