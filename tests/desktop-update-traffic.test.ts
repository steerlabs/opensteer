import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureCounters, captureFilter } from "../scripts/public-download/traffic-policy.js";

test("offline BPF retains DNS, client TLS fragments, HTTP and SYN while excluding ZIP responses", () => {
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
    const filtered = spawnSync("/usr/sbin/tcpdump", ["-r", input, "-w", "-", captureFilter]);
    expect(filtered.status, filtered.stderr.toString()).toBe(0);
    let count = 0;
    for (let offset = 24; offset < filtered.stdout.length; count++)
      offset += 16 + filtered.stdout.readUInt32LE(offset + 8);
    expect(count).toBe(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each capture must expose an explicit drop counter, including failure counts", () => {
  const log = "100 packets captured\n120 packets received by filter\n0 packets dropped by kernel\n";
  expect(captureCounters(log)).toEqual({ captured: 100, received: 120, dropped: 0 });
  expect(captureCounters(log.replace("0 packets dropped", "5269 packets dropped")).dropped).toBe(
    5269,
  );
  expect(() => captureCounters("100 packets captured")).toThrow();
});
