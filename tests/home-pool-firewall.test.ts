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

// Only the Host (its own uid on a Cloud Computer) reaches the pool; the Runner's shells do not.
const allow =
  "-A OPENSTEER-HOME -d 10.128.0.0/20 -p tcp -m owner --uid-owner 10002 -m multiport --dports 7310,7312 -j RETURN";

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
  const refresh = () =>
    spawnSync("bash", ["-c", 'source "$1"; refresh_pool_network', "r", join(home, "common.sh")], {
      encoding: "utf8",
      env: { ...process.env, OPENSTEER_HOME_DIR: directory, PATH: `${work}:${process.env.PATH}` },
    });
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

it("gives the Host its own uid on a Cloud Computer, which alone the pool rule lets out", () => {
  const overlay = readFileSync(join(home, "compose.browser-pool.yaml"), "utf8");
  expect(overlay).toMatch(/^ {2}host:\n(?: {4}.*\n)*? {4}user: "10002:10002"$/mu);
  expect(readFileSync(join(home, "firewall.sh"), "utf8")).toContain("pool_owner=10002");
  // The Host's data moves to its uid before it starts (rule 6: moved, never wiped).
  const directory = mkdtempSync(join(work, "home-"));
  writeFileSync(join(directory, "browser-pool"), "");
  writeFileSync(
    join(work, "docker"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${work}/docker.log"\n`,
    {
      mode: 0o755,
    },
  );
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; compose() { printf \'{"volumes":{"host-data":{"name":"set_host-data"}},"services":{"host":{"image":"example.test/host@sha256:aa"}}}\'; }; own_host_data',
      "own",
      join(home, "common.sh"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, OPENSTEER_HOME_DIR: directory, PATH: `${work}:${process.env.PATH}` },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const log = readFileSync(join(work, "docker.log"), "utf8");
  expect(log).toContain("run --rm --network none --user 0:0");
  expect(log).toContain("set_host-data");
  expect(log).toContain("10002:10002");
  // A self-hosted Home is left exactly as it is.
  rmSync(join(work, "docker.log"));
  rmSync(join(directory, "browser-pool"));
  expect(
    spawnSync("bash", ["-c", 'source "$1"; own_host_data', "own", join(home, "common.sh")], {
      env: { ...process.env, OPENSTEER_HOME_DIR: directory, PATH: `${work}:${process.env.PATH}` },
    }).status,
  ).toBe(0);
  expect(existsSync(join(work, "docker.log"))).toBe(false);
});

it("reuses a saved boot answer only when it still holds what a pooled Home needs", () => {
  const directory = mkdtempSync(join(work, "home-"));
  const usable = (answer: object) => {
    writeFileSync(join(directory, "result.json"), JSON.stringify(answer));
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
  expect(usable({ browserPool: true, browserPoolNetwork: network })).toBe(0);
  // Saved by an install before this release: fetched again rather than installed without a path
  // to its browser.
  expect(usable({ browserPool: true })).not.toBe(0);
  expect(
    usable({ browserPool: true, browserPoolNetwork: { ...network, cidr: "0.0.0.0/0" } }),
  ).not.toBe(0);
  expect(usable({})).toBe(0);
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
