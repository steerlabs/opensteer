// A Cloud Computer's Home reaches its browser's pool host, and nothing else private: its pod
// firewall allows TCP to the pool network on the agent and relay ports only, before it rejects
// every private range (deploy/home/firewall.sh).
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const home = join(import.meta.dirname, "../deploy/home");
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "opensteer-pool-firewall-"));
  // Stands in for nsenter: no rule is installed yet, and each restore is recorded.
  writeFileSync(
    join(work, "nsenter"),
    `#!/usr/bin/env bash
set -eu
shift 3
tool=$1
case " $* " in
  *" -C "*) exit 1 ;;
  *" -S "*) exit 1 ;;
esac
cat > "${work}/$tool"
`,
  );
  chmodSync(join(work, "nsenter"), 0o755);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** Runs firewall.sh apply for namespace 1234 and returns the IPv4 rules it would install. */
function apply(...pool: string[]) {
  const result = spawnSync("bash", [join(home, "firewall.sh"), "1234", "apply", "false", ...pool], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${work}:${process.env.PATH}` },
  });
  const restored = join(work, "iptables-restore");
  return {
    status: result.status,
    stderr: result.stderr,
    rules: existsSync(restored)
      ? readFileSync(restored, "utf8")
          .split("\n")
          .filter((line) => line.startsWith("-A OPENSTEER-HOME"))
      : [],
  };
}

// The pod reaches the pool network on its two ports and nowhere else private.
const allow = "-A OPENSTEER-HOME -d 10.128.0.0/20 -p tcp -m multiport --dports 7310,7312 -j RETURN";

it("allows exactly the pool network on the agent and relay ports, before the private rejects", () => {
  const { status, rules } = apply("10.128.0.0/20", "7310,7312");
  expect(status).toBe(0);
  expect(rules.filter((rule) => rule.endsWith("-j RETURN") && rule.includes(" -d "))).toEqual([
    "-A OPENSTEER-HOME -d 127.0.0.0/8 -o lo -j RETURN",
    allow,
  ]);
  const allowed = rules.indexOf(allow);
  const firstPrivateReject = rules.indexOf("-A OPENSTEER-HOME -d 10.0.0.0/8 -j REJECT");
  expect(allowed).toBeGreaterThan(
    rules.indexOf("-A OPENSTEER-HOME -p tcp -m multiport --dports 25,465,587 -j REJECT"),
  );
  expect(allowed).toBeLessThan(firstPrivateReject);
  // Every private range is still rejected after it.
  for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"])
    expect(rules).toContain(`-A OPENSTEER-HOME -d ${range} -j REJECT`);
});

it("allows nothing private when the boot answer gave no pool network", () => {
  const { status, rules } = apply();
  expect(status).toBe(0);
  expect(rules.filter((rule) => rule.includes("--dports 7310"))).toEqual([]);
  expect(rules.filter((rule) => rule.endsWith("-j RETURN") && rule.includes(" -d "))).toEqual([
    "-A OPENSTEER-HOME -d 127.0.0.0/8 -o lo -j RETURN",
  ]);
});

it("refuses a malformed or wider pool network or port, and installs nothing", () => {
  for (const pool of [
    ["0.0.0.0/0", "7310,7312"],
    ["8.8.8.0/24", "7310,7312"],
    ["10.0.0.0/7", "7310,7312"],
    ["172.0.0.0/8", "7310,7312"],
    ["10.128.0.1/20", "7310,7312"],
    ["10.256.0.0/16", "7310,7312"],
    ["10.128.0.0/20 ", "7310,7312"],
    ["10.128.0.0/20", "7310"],
    ["10.128.0.0/20", "7310,7310"],
    ["10.128.0.0/20", "0,7312"],
    ["10.128.0.0/20", "7310,65536"],
    ["10.128.0.0/20", "7310,7312,22"],
    ["10.128.0.0/20", "07310,7312"],
    ["10.128.0.0/20"],
  ]) {
    const { status, rules } = apply(...pool);
    expect(status, pool.join(" ")).not.toBe(0);
    expect(rules, pool.join(" ")).toEqual([]);
  }
});

/** `save_pool_network` from common.sh on this boot answer; the file it leaves, or its failure. */
function savedPoolNetwork(answer: object): { status: number | null; saved?: string } {
  const directory = mkdtempSync(join(work, "home-"));
  writeFileSync(join(directory, "boot.json"), JSON.stringify(answer));
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; save_pool_network "$2"',
      "save",
      join(home, "common.sh"),
      join(directory, "boot.json"),
    ],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: directory } },
  );
  const file = join(directory, "pool-network");
  return {
    status: result.status,
    ...(existsSync(file) ? { saved: readFileSync(file, "utf8") } : {}),
  };
}

it("keeps the boot answer's pool network for the firewall, and refuses a malformed one", () => {
  const network = { cidr: "10.128.0.0/20", agentPort: 7310, relayPort: 7312 };
  expect(savedPoolNetwork({ browserPool: true, browserPoolNetwork: network })).toEqual({
    status: 0,
    saved: "10.128.0.0/20 7310,7312\n",
  });
  // Review C1: a pooled Home without its pool network would have no path to its browser, for
  // good (the network is saved only at install). Earlier this was accepted; it is now refused.
  expect(savedPoolNetwork({ browserPool: true }).status).not.toBe(0);
  expect(savedPoolNetwork({ browserPool: true }).saved).toBeUndefined();
  // firewall.sh's own check runs here too: a wider network never reaches the file.
  expect(
    savedPoolNetwork({ browserPool: true, browserPoolNetwork: { ...network, cidr: "8.8.8.0/24" } })
      .saved,
  ).toBeUndefined();
  // Only a pooled Home reaches the pool.
  expect(savedPoolNetwork({ browserPoolNetwork: network })).toEqual({ status: 0 });
  for (const bad of [
    { ...network, cidr: "10.128.0.0/20; reboot" },
    { ...network, agentPort: "7310" },
    { ...network, relayPort: 7312.5 },
  ])
    expect(savedPoolNetwork({ browserPool: true, browserPoolNetwork: bad }).saved).toBeUndefined();
});

it("passes the saved pool network to the firewall on both apply and check", () => {
  const directory = mkdtempSync(join(work, "home-"));
  writeFileSync(join(directory, "firewall.sh"), '#!/usr/bin/env bash\nprintf "%s\\n" "$*"\n');
  chmodSync(join(directory, "firewall.sh"), 0o755);
  const run = () =>
    execFileSync(
      "bash",
      [
        "-c",
        'source "$1"; apply_firewall 1234; check_firewall 1234',
        "fw",
        join(home, "common.sh"),
      ],
      { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: directory } },
    );
  expect(run()).toBe("1234 apply false\n1234 check false\n");
  writeFileSync(join(directory, "pool-network"), "10.128.0.0/20 7310,7312\n");
  // Review C2: a pool network left behind opens nothing on a Home that is not a pooled one.
  expect(run()).toBe("1234 apply false\n1234 check false\n");
  writeFileSync(join(directory, "browser-pool"), "");
  expect(run()).toBe(
    "1234 apply false 10.128.0.0/20 7310,7312\n1234 check false 10.128.0.0/20 7310,7312\n",
  );
});

it("removes the saved pool network when the Home is uninstalled", () => {
  const directory = mkdtempSync(join(work, "home-"));
  for (const file of ["pool-network", "browser-pool", "config.env"])
    writeFileSync(join(directory, file), "");
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; remove_home_files', "rm", join(home, "common.sh")],
    { encoding: "utf8", env: { ...process.env, OPENSTEER_HOME_DIR: directory } },
  );
  expect(result.status).toBe(0);
  for (const file of ["pool-network", "browser-pool", "config.env"])
    expect(existsSync(join(directory, file)), file).toBe(false);
});

it("follows the pool network its account gives now, checked as at boot", () => {
  const directory = mkdtempSync(join(work, "home-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets", "oidc_client_secret"), `ocs_${"A".repeat(43)}`);
  for (const marker of ["managed", "browser-pool"]) writeFileSync(join(directory, marker), "");
  writeFileSync(
    join(directory, "config.env"),
    [
      "OPENSTEER_HOME_ACCOUNT_ORIGIN='https://account.example.test'",
      "OPENSTEER_HOME_MANAGED_ID='cc_00000000-0000-4000-8000-000000000001'",
      "OPENSTEER_HOME_OIDC_CLIENT_ID='occ_00000000-0000-4000-8000-000000000002'",
      "",
    ].join("\n"),
  );
  writeFileSync(join(directory, "pool-network"), "10.128.0.0/20 7310,7312\n");
  const answer = (value: object | null) =>
    writeFileSync(
      join(work, "curl"),
      `#!/usr/bin/env bash
cat > /dev/null # curl --config - reads its credentials from stdin
out='' url=''
while (($#)); do case $1 in --output) out=$2; shift 2 ;; --) url=$2; shift 2 ;; *) shift ;; esac; done
printf '%s\\n' "$url" > "${work}/asked"
${value === null ? "exit 7" : `printf '%s' '${JSON.stringify(value)}' > "$out"; printf 200`}
`,
      { mode: 0o755 },
    );
  // Each ask here is a fresh one (the next test holds the five-minute rule).
  const refresh = () =>
    spawnSync(
      "bash",
      [
        "-c",
        'rm -f -- "$OPENSTEER_HOME_DIR/pool-network-asked"; source "$1"; refresh_pool_network',
        "r",
        join(home, "common.sh"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, OPENSTEER_HOME_DIR: directory, PATH: `${work}:${process.env.PATH}` },
      },
    );
  const saved = () => readFileSync(join(directory, "pool-network"), "utf8");
  // Unchanged: nothing to apply.
  answer({ browserPoolNetwork: { cidr: "10.128.0.0/20", agentPort: 7310, relayPort: 7312 } });
  expect(refresh()).toMatchObject({ status: 1, stderr: "" });
  expect(readFileSync(join(work, "asked"), "utf8")).toBe(
    "https://account.example.test/v1/cloud-computers/cc_00000000-0000-4000-8000-000000000001/pool-network\n",
  );
  // Changed: saved, and the caller re-applies the firewall (status 0).
  answer({ browserPoolNetwork: { cidr: "10.130.0.0/20", agentPort: 7320, relayPort: 7322 } });
  expect(refresh().status).toBe(0);
  expect(saved()).toBe("10.130.0.0/20 7320,7322\n");
  // Wider, malformed or missing: kept as it was, and said so.
  for (const bad of [
    { browserPoolNetwork: { cidr: "0.0.0.0/0", agentPort: 7310, relayPort: 7312 } },
    { browserPoolNetwork: { cidr: "10.128.0.0/20", agentPort: 7310, relayPort: 7310 } },
    {},
  ]) {
    answer(bad);
    const result = refresh();
    expect(result.status, JSON.stringify(bad)).toBe(1);
    expect(result.stderr, JSON.stringify(bad)).toContain("failed the checks");
    expect(saved()).toBe("10.130.0.0/20 7320,7322\n");
  }
  answer(null);
  expect(refresh()).toMatchObject({ status: 1 });
  expect(refresh().stderr).toContain("did not answer");
  expect(saved()).toBe("10.130.0.0/20 7320,7322\n");
  // Maintenance re-applies the firewall when it changed.
  expect(readFileSync(join(home, "opensteer-home"), "utf8")).toMatch(
    /refresh_pool_network[^\n]*\n?[^\n]*apply_firewall/u,
  );
});

/** A pooled managed Home's directory, and a curl stand-in that counts the account's answers. */
function pooledHome(): { directory: string; asks: () => string[] } {
  const directory = mkdtempSync(join(work, "home-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets", "oidc_client_secret"), `ocs_${"A".repeat(43)}`);
  for (const marker of ["managed", "browser-pool"]) writeFileSync(join(directory, marker), "");
  writeFileSync(
    join(directory, "config.env"),
    [
      "OPENSTEER_HOME_ACCOUNT_ORIGIN='https://account.example.test'",
      "OPENSTEER_HOME_MANAGED_ID='cc_00000000-0000-4000-8000-000000000001'",
      "OPENSTEER_HOME_OIDC_CLIENT_ID='occ_00000000-0000-4000-8000-000000000002'",
      "",
    ].join("\n"),
  );
  writeFileSync(join(directory, "pool-network"), "10.128.0.0/20 7310,7312\n");
  const log = join(directory, "asked.log");
  writeFileSync(
    join(work, "curl"),
    `#!/usr/bin/env bash
cat > /dev/null
out='' url=''
while (($#)); do case $1 in --output) out=$2; shift 2 ;; --) url=$2; shift 2 ;; *) shift ;; esac; done
printf '%s\\n' "\${url##*/}" >> "${log}"
case \${url##*/} in
  pool-network) printf '%s' '{"browserPoolNetwork":{"cidr":"10.128.0.0/20","agentPort":7310,"relayPort":7312}}' > "$out" ;;
  *) printf '{}' > "$out" ;;
esac
printf 200
`,
    { mode: 0o755 },
  );
  const asks = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { directory, asks };
}

const inHome = (directory: string, script: string) =>
  spawnSync(
    "bash",
    [
      "-c",
      `source "$1"; source "$2"; ${script}`,
      "m",
      join(home, "common.sh"),
      join(home, "managed-egress.sh"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, OPENSTEER_HOME_DIR: directory, PATH: `${work}:${process.env.PATH}` },
    },
  );

it("asks its account for the pool network after a start and then at most once every five minutes", () => {
  const { directory, asks } = pooledHome();
  expect(inHome(directory, "refresh_pool_network").status).toBe(1);
  expect(asks()).toEqual(["pool-network"]);
  // A pass while the last ask is fresh asks nothing (four passes a minute, every Home).
  for (let pass = 0; pass < 3; pass++)
    expect(inHome(directory, "refresh_pool_network").status).toBe(1);
  expect(asks()).toEqual(["pool-network"]);
  // Five minutes on, it asks again.
  const stale = new Date(Date.now() - 6 * 60_000);
  utimesSync(join(directory, "pool-network-asked"), stale, stale);
  inHome(directory, "refresh_pool_network");
  expect(asks()).toEqual(["pool-network", "pool-network"]);
  // A start (boot, update, restore, a restart by maintenance) forgets the last ask.
  expect(readFileSync(join(home, "common.sh"), "utf8")).toMatch(
    /^start_pod\(\) \{\n(?:.*\n)*?\s*rm -f -- "\$home_dir\/pool-network-asked"\n/mu,
  );
});

it("asks its account for no egress on a pooled Home, whose browser leaves from the pool host", () => {
  const { directory, asks } = pooledHome();
  expect(inHome(directory, "maintain_managed_egress").status).toBe(0);
  expect(asks()).toEqual([]);
  // A managed Home whose browser runs on it still asks until its egress is set.
  rmSync(join(directory, "browser-pool"));
  expect(inHome(directory, "maintain_managed_egress").status).toBe(0);
  expect(asks()).toEqual(["egress"]);
});

it("reads the pod for a maintenance pass with two docker calls, as Compose would list it", () => {
  const { directory } = pooledHome();
  const calls = join(directory, "docker.log");
  const pod = (lines: string[]) =>
    writeFileSync(
      join(work, "docker"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${calls}"
case $1 in
  ps) printf '%s\\n' ${lines.map((_, index) => `c${index}`).join(" ")} ;;
  inspect) printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")} ;;
esac
`,
      { mode: 0o755 },
    );
  const healthy = [
    "postgres running healthy 11",
    "host running healthy 12",
    "gateway running healthy 13",
    "runner running healthy 14",
    "channel-runtime running healthy 15",
  ];
  const check = () =>
    inHome(directory, 's=$(pod_snapshot) && snapshot_host_pid "$s" && pod_healthy "$s"');
  pod(healthy);
  expect(check()).toMatchObject({ status: 0, stdout: "12\n" });
  // Compose's own project name (compose.yaml), its own containers only, and nothing else run.
  expect(readFileSync(calls, "utf8").split("\n")[0]).toBe(
    "ps -aq --filter label=com.docker.compose.project=opensteer-home --filter label=com.docker.compose.oneoff=False",
  );
  expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
  writeFileSync(
    join(directory, "config.env"),
    `${readFileSync(join(directory, "config.env"), "utf8")}COMPOSE_PROJECT_NAME='home-b'\n`,
  );
  rmSync(calls);
  check();
  expect(readFileSync(calls, "utf8")).toContain("label=com.docker.compose.project=home-b ");
  // Not healthy: one service unhealthy, starting, stopped or missing, or one more than runs here.
  for (const pod_ of [
    healthy.map((line) => line.replace("runner running healthy", "runner running unhealthy")),
    healthy.map((line) => line.replace("gateway running healthy", "gateway running starting")),
    healthy.map((line) => line.replace("postgres running healthy", "postgres exited none")),
    healthy.slice(1),
    [...healthy, "browser-runtime running healthy 16"],
  ]) {
    pod(pod_);
    expect(check().status, pod_.join(", ")).not.toBe(0);
  }
  // A Host that is not running has no PID to check the firewall against.
  pod(healthy.map((line) => line.replace("host running healthy 12", "host exited none 0")));
  expect(inHome(directory, 'snapshot_host_pid "$(pod_snapshot)"').status).toBe(1);
  // The maintenance pass reads the pod once, not through a Compose CLI.
  const command = readFileSync(join(home, "opensteer-home"), "utf8");
  const maintain = command.slice(command.indexOf("  maintain)"), command.indexOf("  stop)"));
  expect(maintain).toContain("snapshot=$(pod_snapshot)");
  expect(maintain).not.toMatch(/compose ps|host_pid\)\s*\|\|/u);
});

it("reuses a saved boot answer only when it still holds what a pooled Home needs", () => {
  const directory = mkdtempSync(join(work, "home-"));
  const usable = (answer: object | string) => {
    writeFileSync(
      join(directory, "result.json"),
      typeof answer === "string" ? answer : JSON.stringify(answer),
    );
    return spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; usable_boot_answer "$2"',
        "boot",
        join(home, "common.sh"),
        join(directory, "result.json"),
      ],
      { env: { ...process.env, OPENSTEER_HOME_DIR: directory } },
    ).status;
  };
  const network = { cidr: "10.128.0.0/20", agentPort: 7310, relayPort: 7312 };
  // What the installer reads from the answer after this check: the release and the credentials.
  const complete = {
    release: { version: "0.1.0" },
    setupCodeDigest: "digest",
    backup: { repository: "s3:r", password: "p", accessKeyId: "a", secretAccessKey: "s" },
    accountOrigin: "https://account.example.test",
    managedHome: {
      cloudComputerId: "cc_00000000-0000-4000-8000-000000000000",
      generation: 1,
      oidc: { clientId: "occ_x", clientSecret: "secret" },
    },
  };
  expect(usable({ ...complete, browserPool: true, browserPoolNetwork: network })).toBe(0);
  expect(usable(complete)).toBe(0);
  // Saved by an install before this release: fetched again rather than installed without a path
  // to its browser.
  expect(usable({ ...complete, browserPool: true })).not.toBe(0);
  expect(
    usable({
      ...complete,
      browserPool: true,
      browserPoolNetwork: { ...network, cidr: "0.0.0.0/0" },
    }),
  ).not.toBe(0);
  // A file cut short, or an answer without what the installer reads next, is asked for again.
  expect(usable(JSON.stringify(complete).slice(0, 40))).not.toBe(0);
  expect(usable("[]")).not.toBe(0);
  const { release: _release, ...withoutRelease } = complete;
  expect(usable(withoutRelease)).not.toBe(0);
  expect(usable({ ...complete, backup: { ...complete.backup, password: null } })).not.toBe(0);
  expect(
    usable({ ...complete, managedHome: { ...complete.managedHome, oidc: { clientId: "occ_x" } } }),
  ).not.toBe(0);
  expect(usable({})).not.toBe(0);
  expect(readFileSync(join(home, "install.sh"), "utf8")).toMatch(
    /usable_boot_answer "\$result" \|\| rm -f -- "\$result"/u,
  );
});

it("purges the files an interrupted feed, configuration or pool network change left behind", () => {
  const directory = mkdtempSync(join(work, "home-"));
  const left = ["feed.AbC123", "config.env.AbC123", "pool-network.AbC123"];
  for (const file of left) writeFileSync(join(directory, file), "");
  expect(
    spawnSync("bash", ["-c", 'source "$1"; remove_home_files', "rm", join(home, "common.sh")], {
      env: { ...process.env, OPENSTEER_HOME_DIR: directory },
    }).status,
  ).toBe(0);
  for (const file of left) expect(existsSync(join(directory, file)), file).toBe(false);
});
