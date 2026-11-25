/**
 * The addresses of one Home, as data. The Host is the authority for them (`apps/host`
 * `home-addresses.ts`): the Home's canonical origin, its current remote route's origin, and the
 * loopback ports it listens on itself. Any loopback host on one of those ports is this Home; a
 * loopback address on any other port (a Run's dev server) is not.
 */
export interface ThisHomeAddresses {
  readonly origins: readonly string[];
  readonly loopbackPorts: readonly number[];
}

/** No address is this Home's: what a browser holds before the Home has told it. */
export const noHomeAddresses: ThisHomeAddresses = Object.freeze({
  origins: Object.freeze([]),
  loopbackPorts: Object.freeze([]),
});

/**
 * The one test for "this is an address of this Home". A URL or origin that parses (per WHATWG URL
 * rules) to one of the Home's origins, or to a loopback host on one of its own ports, including
 * inside `view-source:`, `blob:` and `filesystem:` wrappers. A tab an agent drives may not be on
 * such an address; rule 1 decides it (`resource-access.ts` `authorizePageAddress`) and every
 * browser asks this same test at its doors, listed in `ThisHomeAddressSet`.
 */
export function isThisHomeAddress(value: unknown, home: ThisHomeAddresses): boolean {
  return new ThisHomeAddressSet(home).includes(value);
}

/**
 * One Home's addresses, prepared once so the test is cheap where it runs often.
 *
 * Doors where a tab an agent drives meets it (the same doors as an extension's page, listed at
 * `isExtensionUrl`):
 * 1. The Home: rule 1's `authorizePageAddress` (for any agent's work, a connected agent's or the
 *    person's own agent's), called by `tab-authority.ts` for every page target and tab open, and by
 *    `chrome-shared-tabs.ts` for a shared Chrome tab's listing and every command to it.
 * 2. The router (`portable-session-cdp-router.ts`): an agent's `Page.navigate`,
 *    `Target.createTarget` and history navigation are refused as an unsafe address; a target on a
 *    Home address is not listed, attached or named; a channel whose main frame commits one ends.
 * 3. The runtime's own commands (`controller.ts`): `Opensteer.listTabs`, `resumeTab`, the fills
 *    and the agent's picture answer as for a tab that is not there.
 * 4. The browsers: Electron (`electron-browser-launcher.ts`) refuses an agent-controlled page's
 *    navigation, frame navigation, redirect and window open to a Home address and sends no cookie
 *    from it to one (`browser-session-policy.ts`); the Chrome extension (`tab-debugger.ts`) does
 *    not debug a shared tab on one and keeps a session rule per shared tab that blocks requests
 *    to the Home's origins.
 */
export class ThisHomeAddressSet {
  readonly #origins: ReadonlySet<string>;
  readonly #ports: ReadonlySet<number>;
  /** Substrings one of the Home's addresses must contain, in a browser's canonical form. */
  readonly #needles: readonly string[];

  constructor(home: ThisHomeAddresses) {
    const origins = new Set<string>();
    const needles = new Set<string>();
    for (const value of home.origins) {
      const origin = canonicalOrigin(value);
      if (!origin) continue;
      origins.add(origin);
      needles.add(new URL(origin).host);
    }
    const ports = new Set(home.loopbackPorts.filter((port) => Number.isInteger(port) && port > 0));
    for (const port of ports) {
      if (port === 80 || port === 443) for (const host of loopbackNeedles) needles.add(host);
      else needles.add(`:${port}`);
    }
    this.#origins = origins;
    this.#ports = ports;
    this.#needles = [...needles];
  }

  /** No address is this Home's. */
  get empty(): boolean {
    return this.#needles.length === 0;
  }

  /** The Home's origins, normalized; what a browser blocks requests to. */
  get origins(): readonly string[] {
    return [...this.#origins];
  }

  /** The loopback ports that are this Home's. */
  get loopbackPorts(): readonly number[] {
    return [...this.#ports];
  }

  /** The data form, for the wire. */
  toJSON(): ThisHomeAddresses {
    return { origins: this.origins, loopbackPorts: this.loopbackPorts };
  }

  /** Any address, as an agent or a page wrote it: always parsed. */
  includes(value: unknown): boolean {
    if (this.empty || typeof value !== "string") return false;
    return this.#matches(value, 0);
  }

  /**
   * An address in the canonical form a browser reports (a target's, frame's or tab's URL): parsed
   * only when it could be one, so the person's own agents pay one string scan on these paths.
   */
  includesReported(value: unknown): boolean {
    if (this.empty || typeof value !== "string") return false;
    const lower = value.toLowerCase();
    if (!this.#needles.some((needle) => lower.includes(needle))) return false;
    return this.#matches(value, 0);
  }

  #matches(value: string, depth: number): boolean {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (
      depth < 4 &&
      (url.protocol === "view-source:" ||
        url.protocol === "blob:" ||
        url.protocol === "filesystem:")
    )
      return this.#matches(url.pathname, depth + 1);
    const scheme =
      url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
    if (scheme !== "http:" && scheme !== "https:") return false;
    const port = url.port ? Number(url.port) : scheme === "https:" ? 443 : 80;
    if (this.#origins.has(`${scheme}//${url.host}`)) return true;
    return this.#ports.has(port) && isLoopbackUrlHostname(url.hostname);
  }
}

const loopbackNeedles = ["localhost", "127.", "[::1]", "[::ffff:7f", "0.0.0.0", "[::]"];

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * A hostname as WHATWG URL serializes it (lower case, IPv4 in dotted decimal, IPv6 compressed in
 * brackets) that reaches this machine: `localhost` and its subdomains, `127.0.0.0/8`, `[::1]`, an
 * IPv4-mapped loopback address, and the unspecified addresses a browser connects to locally.
 */
function isLoopbackUrlHostname(hostname: string): boolean {
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "[::]" || host === "0.0.0.0") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)) return true;
  return /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(host);
}
