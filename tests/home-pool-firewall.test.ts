// A Cloud Computer's Home reaches its browser's pool host, and nothing else private: its pod
// firewall allows TCP to the pool network on the agent and relay ports only, before it rejects
// every private range (deploy/home/firewall.sh).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  expect(savedPoolNetwork({ browserPool: true })).toEqual({ status: 0 });
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
  expect(run()).toBe(
    "1234 apply false 10.128.0.0/20 7310,7312\n1234 check false 10.128.0.0/20 7310,7312\n",
  );
});
