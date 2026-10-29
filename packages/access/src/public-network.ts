import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { OpensteerError } from "@opensteer/core";

export interface ResolvedPublicAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export function tlsServerName(hostname: string): string | undefined {
  const normalized =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(normalized) === 0 ? normalized : undefined;
}

export async function resolvePublicAddress(hostname: string): Promise<ResolvedPublicAddress> {
  const normalizedHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const literalFamily = isIP(normalizedHostname);
  let addresses: readonly { readonly address: string; readonly family: number }[];
  try {
    addresses = literalFamily
      ? [{ address: normalizedHostname, family: literalFamily as 4 | 6 }]
      : await lookup(normalizedHostname, { all: true, verbatim: true });
  } catch (error) {
    throw new OpensteerError({
      cause: error,
      code: "forbidden",
      message: "Egress destination did not resolve to a public address",
    });
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address.address))) {
    throw denied("Egress destination resolved to a non-public address");
  }
  const selected = addresses[0];
  if (!selected) throw denied("Egress destination did not resolve");
  return { address: selected.address, family: selected.family as 4 | 6 };
}

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6 || address.includes("%")) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes || (bytes[0]! & 0xe0) !== 0x20) return false;
  return ![
    ["2001:0000::", 32],
    ["2001:0002::", 48],
    ["2001:0010::", 28],
    ["2001:0020::", 28],
    ["2001:0db8::", 32],
    ["2002::", 16],
    ["3ffe::", 16],
  ].some(([network, prefix]) => ipv6SubnetContains(network as string, prefix as number, bytes));
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a = 0, b = 0, c = 0] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6SubnetContains(network: string, prefix: number, address: Uint8Array): boolean {
  const networkBytes = ipv6Bytes(network);
  if (!networkBytes) return false;
  const wholeBytes = Math.floor(prefix / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (networkBytes[index] !== address[index]) return false;
  }
  const remainingBits = prefix % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (networkBytes[wholeBytes]! & mask) === (address[wholeBytes]! & mask);
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  if (isIP(address) !== 6 || address.includes("%")) return undefined;
  let normalized = address.toLowerCase();
  const dottedIndex = normalized.lastIndexOf(":");
  if (normalized.includes(".") && dottedIndex >= 0) {
    const dotted = normalized
      .slice(dottedIndex + 1)
      .split(".")
      .map(Number);
    if (dotted.length !== 4) return undefined;
    normalized = `${normalized.slice(0, dottedIndex)}:${((dotted[0]! << 8) | dotted[1]!).toString(16)}:${((dotted[2]! << 8) | dotted[3]!).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return undefined;
  const output = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return undefined;
    output[index * 2] = value >> 8;
    output[index * 2 + 1] = value & 0xff;
  }
  return output;
}

function denied(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}
