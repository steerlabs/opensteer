import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureCounters, captureFilter } from "../scripts/public-download/traffic-policy.js";

// The capture filter is libpcap syntax; prove it with a real tcpdump wherever one is installed.
const tcpdump = spawnSync("sh", ["-c", "command -v tcpdump"], { encoding: "utf8" }).stdout.trim();

test.skipIf(!tcpdump)(
  "offline BPF retains DNS, client TLS fragments, HTTP and SYN while excluding ZIP responses",
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opensteer-traffic-filter-"));
    const packet = (source: number, destination: number, ipv6 = false, udp = false) => {
      const ethernet = Buffer.alloc(14);
      ethernet.writeUInt16BE(ipv6 ? 0x86dd : 0x0800, 12);
      const payload = Buffer.alloc(80, 0x42),
        transport = Buffer.alloc(udp ? 8 : 20);
      transport.writeUInt16BE(source, 0);
      transport.writeUInt16BE(destination, 2);
      if (udp) transport.writeUInt16BE(8 + payload.length, 4);
      else {
        transport[12] = 0x50;
        transport[13] = 0x18;
      }
      const ip = Buffer.alloc(ipv6 ? 40 : 20);
      if (ipv6) {
        ip[0] = 0x60;
        ip.writeUInt16BE(transport.length + payload.length, 4);
        ip[6] = udp ? 17 : 6;
        ip[23] = 1;
        ip[39] = 2;
      } else {
        ip[0] = 0x45;
        ip.writeUInt16BE(20 + transport.length + payload.length, 2);
        ip[9] = udp ? 17 : 6;
        ip[12] = 10;
        ip[16] = 11;
      }
      return Buffer.concat([ethernet, ip, transport, payload]);
    };
    const packets = [
      packet(50000, 443),
      packet(50000, 443, true),
      packet(50000, 80),
      packet(50000, 53, false, true),
      packet(443, 50000),
      packet(443, 50000, true),
    ];
    const header = Buffer.alloc(24);
    header.writeUInt32LE(0xa1b2c3d4);
    header.writeUInt16LE(2, 4);
    header.writeUInt16LE(4, 6);
    header.writeUInt32LE(65535, 16);
    header.writeUInt32LE(1, 20);
    const records = packets.map((bytes, index) => {
      const record = Buffer.alloc(16);
      record.writeUInt32LE(index, 0);
      record.writeUInt32LE(bytes.length, 8);
      record.writeUInt32LE(bytes.length, 12);
      return Buffer.concat([record, bytes]);
    });
    try {
      const input = path.join(dir, "input.pcap");
      writeFileSync(input, Buffer.concat([header, ...records]));
      const filtered = spawnSync(tcpdump, ["-r", input, "-w", "-", captureFilter]);
      expect(filtered.error).toBeUndefined();
      expect(filtered.status, filtered.stderr.toString()).toBe(0);
      let count = 0;
      for (let offset = 24; offset < filtered.stdout.length; count++)
        offset += 16 + filtered.stdout.readUInt32LE(offset + 8);
      expect(count).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("each capture must expose an explicit drop counter, including failure counts", () => {
  const log = "100 packets captured\n120 packets received by filter\n0 packets dropped by kernel\n";
  expect(captureCounters(log)).toEqual({ captured: 100, received: 120, dropped: 0 });
  expect(captureCounters(log.replace("0 packets dropped", "5269 packets dropped")).dropped).toBe(
    5269,
  );
  expect(() => captureCounters("100 packets captured")).toThrow();
});

import { containmentRules } from "../scripts/public-download/containment.js";
import { validateMirrorRequests } from "../scripts/public-download/update-traffic.js";
test("PF blocks both IP families and proxies with only loopback and the SSH controller exception", () => {
  const rules = containmentRules("192.168.64.1", 50000, "192.168.64.2");
  expect(rules).toContain('block drop log all label "opensteer-egress-deny"');
  expect(rules).toContain("set skip on lo0");
  expect(rules.split("\n").filter((r) => r.startsWith("pass"))).toEqual([
    "pass in quick on en0 proto tcp from 192.168.64.1 port 50000 to 192.168.64.2 port 22 flags any keep state",
    "pass out quick on en0 proto tcp from 192.168.64.2 port 22 to 192.168.64.1 port 50000 flags any keep state",
  ]);
  expect(() => containmentRules("1.2.3.4\npass all", 50000, "192.168.64.2")).toThrow();
});
test("observed public-provider requests require loopback addresses, no token/API and real metadata plus ZIP delivery", () => {
  const base = {
    host: "github.com",
    localAddress: "127.0.0.1",
    remoteAddress: "127.0.0.1",
    authenticated: false,
  };
  const rows = [
    { ...base, path: "/steerlabs/opensteer/releases.atom" },
    { ...base, path: "/steerlabs/opensteer/releases/latest", accept: "application/json" },
    { ...base, path: "/steerlabs/opensteer/releases/download/desktop-v1.0.1/latest-mac.yml" },
    { transferComplete: "/desktop-v1.0.1/Opensteer-mac-arm64.zip" },
  ];
  const log = (events: unknown[]) => events.map((r) => JSON.stringify(r)).join("\n");
  expect(validateMirrorRequests(log(rows), "stable").passed).toBe(true);
  for (const change of [
    { host: "api.github.com" },
    { authenticated: true },
    { remoteAddress: "8.8.8.8" },
    { localAddress: "2001:db8::1" },
  ])
    expect(() =>
      validateMirrorRequests(log([{ ...rows[0], ...change }, ...rows.slice(1)]), "stable"),
    ).toThrow();
  expect(() => validateMirrorRequests(log(rows.slice(0, -1)), "stable")).toThrow();
  expect(() =>
    validateMirrorRequests(log([...rows, { tlsSni: "api.github.com" }]), "stable"),
  ).toThrow();
  expect(() => validateMirrorRequests(log([]), "stable")).toThrow();
});
