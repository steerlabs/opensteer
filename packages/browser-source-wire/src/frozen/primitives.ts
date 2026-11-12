/**
 * Frozen while wire-4 extensions are supported (docs/browser-sessions.md#chrome-sign-ins):
 * exact copies of the `@opensteer/core` and `@opensteer/shared` definitions the
 * shipped documents and frames are checked with. Never change them here; a
 * change in core does not change what a shipped extension accepts.
 */
import { z } from "zod";

type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type BrowserSourceId = Brand<string, "BrowserSourceId">;
export type DeploymentId = Brand<string, "DeploymentId">;
export type HostInstanceId = Brand<string, "HostInstanceId">;

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function idSchema<Id extends string>(prefix: string): z.ZodType<Id> {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${uuidPattern}$`, "i"))
    .transform((value) => value as Id);
}

export const BrowserSourceIdSchema = idSchema<BrowserSourceId>("bsr");
export const DeploymentIdSchema = idSchema<DeploymentId>("dep");
export const HostInstanceIdSchema = idSchema<HostInstanceId>("hst");

export const IsoDateTimeSchema = z
  .string()
  .regex(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/,
  )
  .meta({ format: "date-time" });

export const DeploymentKindSchema = z.enum(["personal", "team"]);
export type DeploymentKind = z.infer<typeof DeploymentKindSchema>;
export const DeploymentShapeSchema = z.strictObject({ kind: DeploymentKindSchema });

export const CanonicalOriginSchema = z
  .url()
  .refine((value) => isBareOrigin(value) && new URL(value).origin === value, {
    message: "Canonical origin must be a normalized, uncredentialed HTTP(S) origin",
  });

function isBareOrigin(value: URL | string): boolean {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.pathname === "/" || url.pathname === "")
  );
}

const loopbackIpv4Prefix = 127;
const ipv4MappedIpv6Marker = 0xffff;
const ipv6GroupCount = 8;
const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;
const ipv6GroupPattern = /^[0-9a-f]{1,4}$/u;

/** Core's loopback rule: `127.0.0.0/8`, `::1` in any spelling, and `localhost` with its subdomains. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname
    .replace(/\.$/u, "")
    .replace(/^\[|\]$/gu, "")
    .toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return host !== ".localhost";
  const groups = ipv6Groups(host);
  if (groups) {
    if (groups.every((group, index) => group === (index === ipv6GroupCount - 1 ? 1 : 0))) {
      return true;
    }
    const mapped =
      groups.slice(0, 5).every((group) => group === 0) && groups[5] === ipv4MappedIpv6Marker;
    return mapped && groups[6]! >>> 8 === loopbackIpv4Prefix;
  }
  return isLoopbackIpv4(host);
}

function isLoopbackIpv4(address: string): boolean {
  const octets = ipv4Pattern.exec(address)?.slice(1).map(Number);
  if (!octets) return false;
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === loopbackIpv4Prefix;
}

function ipv6Groups(address: string): readonly number[] | undefined {
  if (!address.includes(":")) return undefined;
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const head = parseIpv6Groups(halves[0]!);
  const tail = halves.length === 2 ? parseIpv6Groups(halves[1]!) : [];
  if (!head || !tail) return undefined;
  const filled = ipv6GroupCount - head.length - tail.length;
  if (halves.length === 2 ? filled < 1 : filled !== 0) return undefined;
  return [...head, ...Array.from({ length: halves.length === 2 ? filled : 0 }, () => 0), ...tail];
}

function parseIpv6Groups(half: string): number[] | undefined {
  if (half === "") return [];
  const parts = half.split(":");
  const dotted = parts[parts.length - 1]!.includes(".");
  const quad = dotted ? ipv4Pattern.exec(parts.pop()!)?.slice(1).map(Number) : undefined;
  if (dotted && (!quad || quad.some((octet) => octet < 0 || octet > 255))) return undefined;
  const groups: number[] = [];
  for (const part of parts) {
    if (!ipv6GroupPattern.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  if (quad) groups.push((quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!);
  return groups.length <= ipv6GroupCount ? groups : undefined;
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const digits = new Map([...alphabet].map((character, value) => [character, value]));

/** Strict unpadded base64url: throws unless `value` is the one canonical spelling of its bytes. */
export function decodeBase64Url(value: string): Uint8Array {
  if (value.length % 4 === 1) {
    throw new TypeError("base64url input has an impossible length");
  }
  const bytes = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    const digit = digits.get(character);
    if (digit === undefined) {
      throw new TypeError("base64url input is outside the unpadded base64url alphabet");
    }
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (accumulator >> bits) & 0xff;
      offset += 1;
    }
  }
  if ((accumulator & ((1 << bits) - 1)) !== 0) {
    throw new TypeError("base64url input has non-zero trailing bits");
  }
  return bytes;
}
