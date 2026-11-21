// The bench's root half, on a root-only Unix socket: what the relay user may not do itself.
// One JSON command per connection. Test infrastructure only; never installed on a real host.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

const [socketPath, relayUser] = process.argv.slice(2);
const agentCgroup = "/sys/fs/cgroup/system.slice/opensteer-pool-agent.service/guests";
const config = "/etc/opensteer-pool/agent.json";

/** The proxies' slice's cgroup: systemd nests a slice by the dashes in its name. */
function egressSliceCgroup() {
  const group = spawnSync(
    "systemctl",
    ["show", "-p", "ControlGroup", "--value", "opensteer-pool-egress.slice"],
    {
      encoding: "utf8",
    },
  ).stdout.trim();
  return join(
    "/sys/fs/cgroup",
    group || "opensteer.slice/opensteer-pool.slice/opensteer-pool-egress.slice",
  );
}

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
    case "make-profile": {
      // As the bench's own guests have theirs (run-gcp.sh): a formatted 1 GiB ext4.
      const file = `/var/lib/opensteer-pool/profiles/${command.name}.ext4`;
      if (!existsSync(file)) {
        execFileSync("truncate", ["-s", "1G", file]);
        execFileSync("mkfs.ext4", ["-q", "-F", "-m", "0", file]);
      }
      return { ok: true };
    }
    case "slot-number": {
      // The driver's own record of which number a slot holds.
      const numbers = JSON.parse(readFileSync("/var/lib/opensteer-pool/driver/slots.json", "utf8"));
      return { index: numbers[command.slotId] ?? null };
    }
    case "egress-socket": {
      // Round F, E2: a slot's proxy socket taken down, so its next start must define it again.
      spawnSync("systemctl", [command.action, `opensteer-pool-egress-${command.index}.socket`]);
      return { ok: true };
    }
    case "egress-unit": {
      // What systemd holds for one slot number: its socket's state and its proxy's settings.
      const show = (name, property) =>
        spawnSync("systemctl", ["show", "-p", property, "--value", name], {
          encoding: "utf8",
        }).stdout.trim();
      const listed = spawnSync(
        "systemctl",
        [
          "list-units",
          `opensteer-pool-egress-${command.index}.*`,
          "--all",
          "--plain",
          "--no-legend",
        ],
        { encoding: "utf8" },
      ).stdout.trim();
      const upstream = show(`opensteer-pool-egress-${command.index}.service`, "Environment")
        .split(" ")
        .find((entry) => entry.startsWith("OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL="));
      return {
        socket: show(`opensteer-pool-egress-${command.index}.socket`, "ActiveState"),
        listed: listed
          ? listed.split("\n").map((line) => line.split(/\s+/u).slice(0, 4).join(" "))
          : [],
        upstream: upstream?.slice("OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL=".length) ?? null,
      };
    }
    case "slow-tool": {
      // Round F: a one-shot slow host tool, for E1 and E2 on a host. The wrapper sits in
      // /usr/local/sbin, first on the agent's tool path, ignores SIGTERM (standing for a request
      // PID 1 already took) and then runs the real tool. Removed again with `remove: true`.
      const wrappers = {
        "systemd-run": `#!/bin/bash
flag=/run/opensteer-pool-bench/slow-systemd-run
if mv "$flag" "$flag.used" 2>/dev/null; then trap '' TERM; date +%s%3N >> "$flag.used"; sleep "$(head -1 "$flag.used")"; fi
exec /usr/bin/systemd-run "$@"
`,
        systemctl: `#!/bin/bash
flag=/run/opensteer-pool-bench/slow-systemctl-stop
if [[ "$1" == stop && -f $flag && "$2" == "$(cut -d' ' -f1 "$flag")" ]] && mv "$flag" "$flag.used" 2>/dev/null; then trap '' TERM; date +%s%3N >> "$flag.used"; sleep "$(head -1 "$flag.used" | cut -d' ' -f2)"; fi
exec /usr/bin/systemctl "$@"
`,
      };
      if (command.remove) {
        for (const name of Object.keys(wrappers))
          rmSync(`/usr/local/sbin/${name}`, { force: true });
        for (const flag of ["slow-systemd-run", "slow-systemctl-stop"]) {
          rmSync(`/run/opensteer-pool-bench/${flag}`, { force: true });
          rmSync(`/run/opensteer-pool-bench/${flag}.used`, { force: true });
        }
        return { ok: true };
      }
      if (command.used) {
        const file = `/run/opensteer-pool-bench/${command.used}.used`;
        return { used: existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : null };
      }
      mkdirSync("/run/opensteer-pool-bench", { recursive: true, mode: 0o700 });
      for (const [name, text] of Object.entries(wrappers))
        writeFileSync(`/usr/local/sbin/${name}`, text, { mode: 0o755 });
      if (command.tool === "systemd-run")
        writeFileSync("/run/opensteer-pool-bench/slow-systemd-run", `${command.seconds}\n`);
      if (command.tool === "systemctl-stop")
        writeFileSync(
          "/run/opensteer-pool-bench/slow-systemctl-stop",
          `${command.unit} ${command.seconds}\n`,
        );
      return { ok: true };
    }
    case "capacity-events": {
      // Round F, E4: whether the kernel killed anything in the guests' group or the proxies'
      // slice (memory.events counts a cgroup and everything below it).
      const events = (file) =>
        existsSync(file)
          ? Object.fromEntries(
              readFileSync(file, "utf8")
                .trim()
                .split("\n")
                .map((line) => line.split(" "))
                .map(([k, v]) => [k, Number(v)]),
            )
          : null;
      const failed = spawnSync(
        "systemctl",
        ["list-units", "opensteer-pool-egress-*", "--state=failed", "--plain", "--no-legend"],
        { encoding: "utf8" },
      ).stdout.trim();
      return {
        guests: events(join(agentCgroup, "memory.events")),
        slice: events(join(egressSliceCgroup(), "memory.events")),
        failedProxies: failed ? failed.split("\n").length : 0,
        vmms: processes(agentCgroup),
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
        // The ceiling in force, as the kernel has it: quota and period in microseconds.
        sliceCpuMax: readFileSync(join(egressSliceCgroup(), "cpu.max"), "utf8").trim(),
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
