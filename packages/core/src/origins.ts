/**
 * The one place Opensteer decides what "this computer" and "a bare origin"
 * mean.
 *
 * Both predicates gate real safety boundaries — whether plaintext HTTP is
 * acceptable, whether an OAuth redirect may target a local listener, whether a
 * signed Deployment origin is canonical — so they are defined once and shared
 * rather than re-derived per call site. Nothing here touches Node built-ins:
 * the browser bundle imports this module too.
 */

const loopbackIpv4Prefix = 127;
const ipv4MappedIpv6Marker = 0xffff;
const ipv6GroupCount = 8;
const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;
const ipv6GroupPattern = /^[0-9a-f]{1,4}$/u;

/**
 * Whether a URL hostname resolves to the computer running this code.
 *
 * Loopback is the whole `127.0.0.0/8` block, not just `127.0.0.1`; `::1` and
 * its IPv4-mapped spelling; and the reserved `localhost` name including the
 * `.localhost` subdomains RFC 6761 pins to loopback. Bracketed IPv6 literals,
 * a fully-qualified trailing dot, and uppercase all normalize away first, so
 * `[::1]`, `LOCALHOST.` and `localhost` are one answer rather than three.
 *
 * IPv6 is compared as eight parsed groups rather than as text, because `::1`
 * and `0:0:0:0:0:0:0:1` are the same address and a configured bind address may
 * be written either way.
 *
 * The wildcard bind address `0.0.0.0` is deliberately *not* loopback: a
 * listener bound to it accepts connections from every interface.
 */
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

/** Production Runner traffic may be plaintext only when it never leaves loopback. */
export function allowsPlaintextRunnerTransport(
  mode: "development" | "production",
  url: URL,
): boolean {
  return mode !== "production" || isLoopbackHostname(url.hostname);
}

function isLoopbackIpv4(address: string): boolean {
  const octets = ipv4Pattern.exec(address)?.slice(1).map(Number);
  if (!octets) return false;
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === loopbackIpv4Prefix;
}

/**
 * The eight 16-bit groups of an IPv6 literal, or undefined when the text is
 * not one. A trailing dotted-quad (`::ffff:127.0.0.1`) becomes the final two
 * groups, which is what makes the IPv4-mapped range comparable to plain IPv4.
 */
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

/**
 * Whether an absolute URL is already exactly its own origin: an HTTP(S) URL
 * with no credentials, port-normalized host, `/` path, and no query or
 * fragment. `https://host` is bare; `https://host/x`, `https://u:p@host` and
 * `https://host/?a=1` are not.
 */
export function isBareOrigin(value: URL | string): boolean {
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

/**
 * Whether a transport may carry plaintext: HTTPS always, HTTP only when the
 * peer is this same computer.
 */
export function isSecureOrLoopbackOrigin(value: URL | string): boolean {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHostname(url.hostname);
}

/**
 * Normalize a service endpoint to its bare origin, refusing anything that is
 * not an uncredentialed HTTPS origin — or an HTTP loopback origin, which
 * exists so a native app can talk to a Host on the same computer.
 *
 * `label` names the setting in the failure so an operator learns which value
 * was wrong, not merely that something was.
 */
export function bareServiceOrigin(value: URL | string, label = "Origin"): string {
  const raw = String(value);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new TypeError(`${label} must be an absolute URL.`, { cause: error });
  }
  if (!isBareOrigin(url)) {
    throw new TypeError(`${label} must be a bare origin.`);
  }
  if (!isSecureOrLoopbackOrigin(url)) {
    throw new TypeError(`${label} must use HTTPS or HTTP loopback.`);
  }
  return url.origin;
}
