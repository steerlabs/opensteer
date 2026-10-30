import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function captureTraffic(out: string) {
  assert(existsSync("/Volumes/My Shared Files/inputs"), "Guest only");
  const run = (exe: string, args: string[]) => {
    const r = spawnSync(exe, args, { encoding: "utf8", timeout: 600_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  run("brew", ["install", "wireshark"]);
  writeFileSync(path.join(out, "dns-configuration.txt"), run("scutil", ["--dns"]));
  const profiles = run("sudo", ["profiles", "show", "-type", "configuration"]);
  writeFileSync(path.join(out, "profiles.txt"), profiles);
  assert(
    !/DNSSettings|DNSProtocol|DNSOverHTTPS|DNSOverTLS/iu.test(profiles),
    "Guest must have no encrypted DNS configuration profile",
  );
  run("sudo", ["dscacheutil", "-flushcache"]);
  run("sudo", ["killall", "-HUP", "mDNSResponder"]);
  const children: ChildProcess[] = [];
  const captureLogs: string[] = [];
  // Parse only after clean shutdown, so buffered pcap writes retain every packet
  // without forcing a disk flush for each packet during local ZIP transfers.
  for (const iface of ["en0", "lo0"]) {
    const child = spawn(
      "sudo",
      [
        "-n",
        "tcpdump",
        "-i",
        iface,
        "-B",
        "32768",
        "-s",
        "8192",
        "-w",
        path.join(out, `${iface}.pcap`),
        "port 53 or port 80 or port 443 or port 853 or host 127.0.0.2",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.on("data", (b) => {
      captureLogs.push(String(b));
      process.stderr.write(b);
    });
    children.push(child);
  }
  await delay(1500);
  assert(
    children.every((c) => c.exitCode === null),
    "Packet capture must start before launch",
  );
  return async (since = 0) => {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      const ended = new Promise<void>((resolve) => child.once("close", () => resolve()));
      spawnSync("sudo", ["pkill", "-INT", "-P", String(child.pid)]);
      child.kill("SIGINT");
      await ended;
    }
    const captureLog = captureLogs.join("");
    writeFileSync(path.join(out, "capture.log"), captureLog);
    const dropCounts = [...captureLog.matchAll(/(\d+) packets dropped by kernel/gu)].map((x) =>
      Number(x[1]),
    );
    assert(
      dropCounts.length === 2 && dropCounts.every((x) => x === 0),
      "Both packet captures must stop with zero packet loss",
    );
    const records = [];
    for (const iface of ["en0", "lo0"]) {
      const text = run("tshark", [
        "-r",
        path.join(out, `${iface}.pcap`),
        "-T",
        "fields",
        "-E",
        "separator=|",
        "-e",
        "frame.time_epoch",
        "-e",
        "ip.src",
        "-e",
        "ip.dst",
        "-e",
        "dns.qry.name",
        "-e",
        "http.host",
        "-e",
        "tls.handshake.extensions_server_name",
      ]);
      writeFileSync(path.join(out, `${iface}-hosts.tsv`), text);
      records.push(...text.split("\n").filter(Boolean));
    }
    const controls = records.filter((line) => Number(line.split("|")[0]) < since);
    const positiveControl = {
      dns: controls.some((x) => x.split("|")[3]?.includes("opensteer.com")),
      http: controls.some((x) => x.split("|")[4]?.includes("opensteer.com")),
      tls: controls.some((x) => x.split("|")[5]?.includes("opensteer.com")),
    };
    assert(
      Object.values(positiveControl).every(Boolean),
      "DNS, HTTP Host and TLS SNI positive controls must all be captured",
    );
    const forbidden = records
      .filter((line) => Number(line.split("|")[0]) >= since)
      .filter(
        (line) =>
          line.split("|")[2] === "127.0.0.2" ||
          /(?:^|[|,])[^|,]*opensteer\.com(?:[|,]|$)/iu.test(line),
      );
    writeFileSync(
      path.join(out, "traffic.json"),
      JSON.stringify(
        { records, forbidden, positiveControl, passed: forbidden.length === 0 },
        null,
        2,
      ),
    );
    return { records, forbidden };
  };
}
