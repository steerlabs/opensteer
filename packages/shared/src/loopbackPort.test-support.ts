/**
 * Failure modes considered before implementation:
 * - Automatic TCP source-port selection steals a released ephemeral port.
 * - Concurrent callers/processes select the same port before either TCP listen.
 * - An existing TCP or UDP service already owns a candidate.
 * - Unsupported OS, unreadable/malformed ephemeral range, or exhausted candidates:
 *   fail closed rather than fall back to ephemeral allocation.
 * - Bind/close errors must release a failed claim; process death must release claims.
 * - An unrelated explicit TCP bind (or OS range change) can still race the later
 *   listen. A number-only API cannot reserve TCP ownership through that handoff.
 *
 * Design review: a UDP bind is a kernel-owned cross-process claim, independent
 * of TCP, so it can stay held through the fixture's TCP listen without changing
 * production contracts. No stale-file recovery or platform-specific lock needed.
 */
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { isNodeError } from "./nodeError.js";

const claims = new Set<Socket>();
let ephemeralRange: readonly [number, number] | undefined;

function readEphemeralRange(): readonly [number, number] {
  if (ephemeralRange) return ephemeralRange;
  let text: string;
  if (process.platform === "linux") {
    text = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8");
  } else if (process.platform === "darwin") {
    text = execFileSync(
      "sysctl",
      ["-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"],
      { encoding: "utf8" },
    );
  } else {
    throw new Error(`Test loopback port allocation is unsupported on ${process.platform}`);
  }
  const values = text.trim().split(/\s+/u).map(Number);
  const [first, last] = values;
  if (
    values.length !== 2 ||
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first! < 1 ||
    last! > 65535 ||
    first! > last!
  ) {
    throw new Error(`Invalid OS ephemeral port range: ${JSON.stringify(text)}`);
  }
  ephemeralRange = [first!, last!];
  return ephemeralRange;
}

/**
 * Claim a non-ephemeral loopback port for a fixture that must know its origin
 * before listening. Claims last for this process, including after TCP teardown:
 * reusing a number would reintroduce delayed-listen and TIME_WAIT collisions.
 * UDP sockets are unreferenced; process exit releases them even after a crash.
 */
export async function freePort(): Promise<number> {
  const [first, last] = readEphemeralRange();
  const minimum = 1024;
  const count = 65536 - minimum;
  const start = randomInt(count);
  for (let offset = 0; offset < count; offset++) {
    const port = minimum + ((start + offset) % count);
    if (port >= first && port <= last) continue;
    const claim = createSocket("udp4");
    const probe = createServer();
    let retained = false;
    try {
      await new Promise<void>((resolve, reject) => {
        claim.once("error", reject);
        claim.bind({ port, address: "127.0.0.1", exclusive: true }, resolve);
      });
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
      claim.unref();
      claims.add(claim);
      retained = true;
      return port;
    } catch (error) {
      if (!isNodeError(error) || !["EADDRINUSE", "EACCES"].includes(error.code ?? "")) throw error;
    } finally {
      if (!retained) claim.close();
    }
  }
  throw new Error("No bindable non-ephemeral loopback test ports remain");
}
