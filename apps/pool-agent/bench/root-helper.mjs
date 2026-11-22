// The bench's root half, on a root-only Unix socket: what the relay user may not do itself.
// One JSON command per connection. Test infrastructure only; never installed on a real host.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

const [socketPath, relayUser] = process.argv.slice(2);
const agentCgroup = "/sys/fs/cgroup/system.slice/opensteer-pool-agent.service/guests";
const config = "/etc/opensteer-pool/agent.json";

/** Round H: where the agent derives a slot's profile (profiles.ts). */
function profileOf(slotId) {
  return `/var/lib/opensteer-pool/profiles/slot-${createHash("sha256").update(slotId).digest("hex")}.ext4`;
}

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
    case "profile-file": {
      // Round H: the profile the agent made for a slot, where the agent's derivation puts it.
      const file = profileOf(command.slotId);
      if (!existsSync(file)) return { exists: false, file };
      const info = statSync(file);
      const type = spawnSync("blkid", ["-o", "value", "-s", "TYPE", file], { encoding: "utf8" });
      return {
        exists: true,
        file,
        apparentBytes: info.size,
        allocatedBytes: info.blocks * 512,
        mode: (info.mode & 0o777).toString(8),
        uid: info.uid,
        type: type.stdout.trim(),
      };
    }
    case "profile-marker": {
      // Round H: a file inside the profile's own filesystem, written and read without mounting.
      const file = profileOf(command.slotId);
      if (command.action === "write") {
        const marker = `/run/opensteer-run-marker-${process.pid}`;
        writeFileSync(marker, `${command.text}\n`);
        // The guest was ended by a kill: its journal is replayed first, or the next mount's
        // replay would roll the directory back past the marker.
        spawnSync("e2fsck", ["-fy", file], { encoding: "utf8" });
        const out = spawnSync("debugfs", ["-w", "-R", `write ${marker} run-marker`, file], {
          encoding: "utf8",
        });
        rmSync(marker, { force: true });
        return { status: out.status };
      }
      // A guest is ended by a kill: its journal is replayed first, as its next mount would.
      const fsck = spawnSync("e2fsck", ["-fy", file], { encoding: "utf8" });
      const out = spawnSync("debugfs", ["-R", "cat run-marker", file], { encoding: "utf8" });
      return { text: out.stdout.trim(), fsck: fsck.status };
    }
    case "profiles-mount": {
      const out = spawnSync(
        "findmnt",
        ["-n", "-o", "SOURCE,FSTYPE,SIZE,TARGET", "-T", "/var/lib/opensteer-pool/profiles"],
        { encoding: "utf8" },
      );
      return { mount: out.stdout.trim() };
    }
    case "mkfs-time": {
      // Round H, item (e): mkfs.ext4 as the agent runs it, on a sparse file of the size asked for,
      // on the profiles' filesystem.
      const file = `/var/lib/opensteer-pool/profiles/.run-mkfs-${command.sizeMib}`;
      execFileSync("truncate", ["-s", `${command.sizeMib}M`, file]);
      const started = performance.now();
      execFileSync("mkfs.ext4", ["-q", "-F", "-m", "0", file]);
      const ms = Math.round(performance.now() - started);
      const allocatedBytes = statSync(file).blocks * 512;
      rmSync(file, { force: true });
      return { sizeMib: command.sizeMib, ms, allocatedBytes };
    }
    case "standins": {
      // Round H, item (d): a stand-in account service on the host's loopback and a stand-in
      // upstream on the bench's upstream address, both with certificates from a root that only
      // this run's instance trusts (put in its system store). Never a real account.
      const dir = "/run/opensteer-run-standins";
      execFileSync("install", ["-d", "-m", "0700", dir]);
      const openssl = (args) => execFileSync("openssl", args, { stdio: "ignore" });
      if (!existsSync(`${dir}/root.pem`))
        openssl([
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=opensteer run root",
          "-addext",
          "basicConstraints=critical,CA:true",
          "-addext",
          "keyUsage=critical,keyCertSign",
          "-keyout",
          `${dir}/root.key`,
          "-out",
          `${dir}/root.pem`,
        ]);
      const ca = (name, san) => {
        openssl([
          "req",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-subj",
          `/CN=${name}`,
          "-keyout",
          `${dir}/${name}.key`,
          "-out",
          `${dir}/${name}.csr`,
        ]);
        writeFileSync(`${dir}/${name}.ext`, `subjectAltName=${san}\nbasicConstraints=CA:false\n`);
        openssl([
          "x509",
          "-req",
          "-in",
          `${dir}/${name}.csr`,
          "-CA",
          `${dir}/root.pem`,
          "-CAkey",
          `${dir}/root.key`,
          "-CAcreateserial",
          "-days",
          "1",
          "-extfile",
          `${dir}/${name}.ext`,
          "-out",
          `${dir}/${name}.pem`,
        ]);
      };
      ca("account", "IP:127.0.0.1");
      ca("upstream", "IP:192.0.43.10");
      execFileSync("install", [
        "-m",
        "0644",
        `${dir}/root.pem`,
        "/usr/local/share/ca-certificates/opensteer-run-root.crt",
      ]);
      execFileSync("update-ca-certificates");
      const assigned = Object.fromEntries(
        command.assigned.map((slotId) => [
          slotId,
          {
            url: "https://192.0.43.10:8443",
            username: `run-${slotId}`,
            password: createHash("sha256").update(`${slotId}${Math.random()}`).digest("base64url"),
          },
        ]),
      );
      const hostId = JSON.parse(readFileSync(config, "utf8")).admin.hostId;
      writeFileSync(
        `${dir}/account.json`,
        JSON.stringify({
          key: `${dir}/account.key`,
          cert: `${dir}/account.pem`,
          port: 9443,
          hostId,
          hostKeyPub: "/etc/opensteer-pool/host-key.pub",
          assigned,
          log: `${dir}/account.log`,
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        `${dir}/upstream.json`,
        JSON.stringify({
          key: `${dir}/upstream.key`,
          cert: `${dir}/upstream.pem`,
          port: 8443,
          address: "192.0.43.10",
          forwardPort: 3128,
          assigned,
          log: `${dir}/upstream.log`,
        }),
        { mode: 0o600 },
      );
      // The bench's own upstream holds 192.0.43.10:8443; the stand-in takes its place.
      spawnSync("systemctl", ["stop", "pool-bench-upstream.service"]);
      const node = "/opt/opensteer-pool/node/bin/node";
      const bench = "/opt/pool-src/apps/pool-agent/bench";
      for (const [unit, script, file] of [
        ["run-account-standin", "account-standin.mjs", "account.json"],
        ["run-upstream-standin", "upstream-standin.mjs", "upstream.json"],
      ]) {
        spawnSync("systemctl", ["stop", `${unit}.service`]);
        execFileSync("systemd-run", [
          `--unit=${unit}.service`,
          "--collect",
          node,
          `${bench}/${script}`,
          `${dir}/${file}`,
        ]);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { origin: "https://127.0.0.1:9443", assigned: Object.keys(assigned) };
    }
    case "standin-log": {
      const file = `/run/opensteer-run-standins/${command.which}.log`;
      return {
        lines: existsSync(file)
          ? readFileSync(file, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [],
      };
    }
    case "pull-mode": {
      // Round H, item (d): the agent requires an upstream and pulls each slot's from the
      // stand-in account service, into a root-only credentials root of its own.
      const value = JSON.parse(readFileSync(config, "utf8"));
      if (command.off) {
        delete value.driver.requireEgressUpstream;
        delete value.driver.egress.accountOrigin;
        value.driver.credentialsRoot = "/etc/opensteer-pool-bench";
      } else {
        value.driver.requireEgressUpstream = true;
        value.driver.egress.accountOrigin = command.origin;
        value.driver.credentialsRoot = "/etc/opensteer-pool/credentials";
      }
      writeFileSync(config, JSON.stringify(value, null, 2), { mode: 0o600 });
      execFileSync("systemctl", ["restart", "opensteer-pool-agent.service"]);
      return { ok: true };
    }
    case "credentials-info": {
      const root = "/etc/opensteer-pool/credentials";
      const base = `slot-${createHash("sha256").update(command.slotId).digest("hex")}`;
      const files = Object.fromEntries(
        ["url", "username", "password"].map((kind) => {
          const file = `${root}/${base}.${kind}`;
          if (!existsSync(file)) return [kind, null];
          const info = statSync(file);
          return [kind, { mode: (info.mode & 0o777).toString(8), uid: info.uid }];
        }),
      );
      const dir = existsSync(root) ? (statSync(root).mode & 0o777).toString(8) : null;
      const url = files.url ? readFileSync(`${root}/${base}.url`, "utf8") : null;
      // Never the password itself: a digest, to see that it changed.
      const passwordSha = files.password
        ? createHash("sha256")
            .update(readFileSync(`${root}/${base}.password`))
            .digest("hex")
            .slice(0, 16)
        : null;
      return { dir, files, url, passwordSha };
    }
    case "credentials-remove": {
      // Round H, item (d): the slot's pulled credentials taken away, and its proxy process ended
      // so its next start reads them again.
      const root = "/etc/opensteer-pool/credentials";
      const base = `slot-${createHash("sha256").update(command.slotId).digest("hex")}`;
      for (const kind of ["url", "username", "password"])
        rmSync(`${root}/${base}.${kind}`, { force: true });
      // Round I: `stop: false` leaves a running proxy as it is, to show what removal alone does.
      if (command.stop !== false)
        spawnSync("systemctl", ["stop", `opensteer-pool-egress-${command.index}.service`]);
      return { ok: true };
    }
    case "bench-credentials": {
      // The bench's own upstream credentials are shared by its slots, and since round G a
      // delete removes a slot's files once no other live slot names them: the bench keeps a
      // copy across its own cleanup of an earlier run's slots.
      const dir = "/etc/opensteer-pool-bench";
      const copy = "/var/lib/opensteer-pool-bench/credentials-copy";
      const names = ["upstream-username", "upstream-password", "upstream-ca.pem"];
      if (command.action === "save") {
        execFileSync("install", ["-d", "-m", "0700", copy]);
        for (const name of names)
          if (existsSync(`${dir}/${name}`))
            execFileSync("cp", ["-p", `${dir}/${name}`, `${copy}/${name}`]);
      } else {
        for (const name of names)
          if (!existsSync(`${dir}/${name}`) && existsSync(`${copy}/${name}`))
            execFileSync("cp", ["-p", `${copy}/${name}`, `${dir}/${name}`]);
      }
      return { present: names.filter((name) => existsSync(`${dir}/${name}`)).length };
    }
    case "cross-read": {
      // Round I, run 8: one slot's proxy user tries to read another slot's credentials, in
      // credentialsRoot and in its running proxy's /run/credentials.
      const root = "/etc/opensteer-pool/credentials";
      const base = `slot-${createHash("sha256").update(command.slotId).digest("hex")}`;
      const uid = String(300000 + command.fromIndex);
      const attempt = (file) => {
        const out = spawnSync(
          "setpriv",
          ["--reuid", uid, "--regid", uid, "--clear-groups", "--no-new-privs", "cat", file],
          { encoding: "utf8" },
        );
        return out.status === 0 ? "read" : (out.stderr.trim().split(": ").at(-1) ?? "refused");
      };
      const asRoot = (file) => (existsSync(file) ? "present" : "absent");
      const files = [
        `${root}/${base}.password`,
        `${root}/${base}.username`,
        `/run/credentials/opensteer-pool-egress-${command.toIndex}.service/password`,
      ];
      return {
        tried: files.map((file) => ({
          file: file.replace(/slot-[0-9a-f]{64}/u, "slot-<other>"),
          asProxyUser: attempt(file),
          forRoot: asRoot(file),
        })),
      };
    }
    case "standins-rotate": {
      // Round I, run 8: the account stand-in gives the slot a new password; the upstream
      // stand-in accepts only the new one.
      const dir = "/run/opensteer-run-standins";
      for (const name of ["account.json", "upstream.json"]) {
        const value = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
        value.assigned[command.slotId].password = createHash("sha256")
          .update(`${command.slotId}${Math.random()}`)
          .digest("base64url");
        if (name === "upstream.json") {
          const account = JSON.parse(readFileSync(`${dir}/account.json`, "utf8"));
          value.assigned[command.slotId].password = account.assigned[command.slotId].password;
        }
        writeFileSync(`${dir}/${name}`, JSON.stringify(value), { mode: 0o600 });
      }
      for (const unit of ["run-account-standin", "run-upstream-standin"])
        spawnSync("systemctl", ["restart", `${unit}.service`]);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { ok: true };
    }
    case "proxy-request": {
      // Round H, item (d): an HTTPS request through a slot's proxy from inside its namespace.
      const out = spawnSync(
        "ip",
        [
          "netns",
          "exec",
          `osp${command.index}`,
          "curl",
          "-s",
          "-o",
          "/dev/null",
          "-m",
          "8",
          "-w",
          "%{http_connect} %{http_code}",
          "-x",
          "http://172.16.0.1:3128",
          "https://example.com/",
        ],
        { encoding: "utf8" },
      );
      return { status: out.status, result: out.stdout.trim() };
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
        // Round H: whether the unit requires an upstream.
        required: show(`opensteer-pool-egress-${command.index}.service`, "Environment").includes(
          "OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED=true",
        ),
        service: show(`opensteer-pool-egress-${command.index}.service`, "ActiveState"),
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
      // The helper's umask would leave them unexecutable, and the tool path would skip them.
      for (const [name, text] of Object.entries(wrappers)) {
        writeFileSync(`/usr/local/sbin/${name}`, text);
        execFileSync("chmod", ["0755", `/usr/local/sbin/${name}`]);
      }
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
