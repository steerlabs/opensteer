import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";
import path from "node:path";
export function containmentRules(peer: string, peerPort: number, local: string) {
  assert(isIP(peer) && isIP(local), "Invalid SSH control address");
  assert(
    Number.isInteger(peerPort) && peerPort > 0 && peerPort <= 65535,
    "Invalid SSH controller port",
  );
  // Only the already occupied SSH four-tuple is allowed off loopback. A local
  // proxy cannot use it to open another external connection.
  return `set block-policy drop
set skip on lo0
block drop log all label "opensteer-egress-deny"
pass in quick on en0 proto tcp from ${peer} port ${peerPort} to ${local} port 22 flags any keep state
pass out quick on en0 proto tcp from ${local} port 22 to ${peer} port ${peerPort} flags any keep state
`;
}
type Run = (
  exe: string,
  args: string[],
  allowFailure?: boolean,
) => { code: number | null; output: string };
export function containGuest(out: string, run: Run) {
  assert(existsSync("/Volumes/My Shared Files/inputs"), "Guest only");
  const connection = process.env.SSH_CONNECTION?.split(" ");
  assert(connection?.length === 4 && connection[3] === "22", "SSH control connection required");
  const peer = connection[0]!,
    peerPort = Number(connection[1]),
    local = connection[2]!;
  const rules = containmentRules(peer, peerPort, local),
    file = path.join(out, "pf.conf");
  writeFileSync(file, rules, { mode: 0o600 });
  const proxies = run("scutil", ["--proxy"]).output;
  assert(
    !/(?:HTTPEnable|HTTPSEnable|SOCKSEnable|ProxyAutoConfigEnable|ProxyAutoDiscoveryEnable)\s*:\s*1/u.test(
      proxies,
    ),
    "Guest proxy settings must be disabled",
  );
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    const value = spawnSync("launchctl", ["getenv", key], { encoding: "utf8", timeout: 5000 });
    assert(!process.env[key] && !value.stdout?.trim(), `Proxy environment must be absent: ${key}`);
  }
  assert.match(
    run("sudo", ["-n", "pfctl", "-s", "info"]).output,
    /Status: Disabled/u,
    "Require fresh guest with PF disabled",
  );
  const stop = () => {
    run("sudo", ["-n", "pfctl", "-d"]);
    run("sudo", ["-n", "pfctl", "-F", "all"]);
    run("sudo", ["-n", "pfctl", "-f", "/etc/pf.conf"]);
  };
  try {
    run("sudo", ["-n", "pfctl", "-f", file]);
    run("sudo", ["-n", "pfctl", "-F", "states"]);
    run("sudo", ["-n", "pfctl", "-e"]);
    const observed = run("sudo", ["-n", "pfctl", "-sr"]).output;
    assert(
      observed.includes('label "opensteer-egress-deny"') && observed.includes("block drop log all"),
    );
    const count = () => {
      const row = run("sudo", ["-n", "pfctl", "-s", "labels"])
        .output.split("\n")
        .find((l) => l.startsWith("opensteer-egress-deny "));
      assert(row, "PF deny label must be observable");
      const n = Number(row.split(/\s+/u)[2]);
      assert(Number.isSafeInteger(n) && n >= 0);
      return n;
    };
    const before = count();
    const control = run(
      "curl",
      [
        "-q",
        "--noproxy",
        "*",
        "--interface",
        "en0",
        "-kfsS",
        "--connect-timeout",
        "2",
        "--max-time",
        "3",
        "https://1.1.1.1",
      ],
      true,
    );
    const after = count();
    assert(
      control.code !== 0 && after > before,
      "External IPv4 control must increment PF's deny counter",
    );
    const status = run("sudo", ["-n", "pfctl", "-s", "info"]).output;
    assert.match(status, /Status: Enabled/u);
    const evidence = {
      enabled: true,
      peer,
      peerPort,
      local,
      rules,
      observed,
      status,
      proxies,
      externalControl: { before, after, exitCode: control.code },
      addressPolicy:
        "Only loopback; the existing SSH four-tuple are the sole non-loopback exception. All other IPv4, IPv6, UDP, DNS and proxy egress is blocked.",
    };
    writeFileSync(path.join(out, "containment.json"), JSON.stringify(evidence, null, 2));
    return () => {
      try {
        assert.match(run("sudo", ["-n", "pfctl", "-s", "info"]).output, /Status: Enabled/u);
        assert.equal(
          run("sudo", ["-n", "pfctl", "-sr"]).output,
          observed,
          "Containment rules changed during measurement",
        );
        writeFileSync(
          path.join(out, "containment-final.json"),
          JSON.stringify({ passed: true, denyPackets: count() }, null, 2),
        );
      } finally {
        stop();
      }
    };
  } catch (error) {
    stop();
    throw error;
  }
}
