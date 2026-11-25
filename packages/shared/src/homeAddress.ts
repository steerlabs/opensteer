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
      // The host with its port, and alone: `home.example.com.:8443` holds only the latter.
      needles.add(new URL(origin).host);
      needles.add(new URL(origin).hostname);
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
    // A fully qualified spelling (`home.example.com.`) names the same host.
    const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
    if (this.#origins.has(`${scheme}//${hostname}${url.port ? `:${url.port}` : ""}`)) return true;
    return this.#ports.has(port) && isLoopbackUrlHostname(url.hostname);
  }

  /**
   * Regular expressions (RE2 syntax, for a browser's request rules) that match a request URL, in
   * the canonical form a browser gives one, exactly when it is one of this Home's addresses over
   * http(s) or ws(s): each origin, and every loopback spelling on each of the Home's ports. Built
   * from the same loopback list as this test, so a browser blocks what the predicate refuses.
   */
  requestPatterns(): string[] {
    const userinfo = "(?:[^/?#@]*@)?";
    const end = "(?:[/?#]|$)";
    const patterns: string[] = [];
    for (const origin of this.#origins) {
      const url = new URL(origin);
      const secure = url.protocol === "https:";
      const schemes = secure ? "(?:https|wss)" : "(?:http|ws)";
      const port = url.port ? `:${url.port}` : `(?::${secure ? 443 : 80})?`;
      patterns.push(`^${schemes}://${userinfo}${escapeRegex(url.hostname)}\\.?${port}${end}`);
    }
    // One pattern per spelling: a browser compiles each rule's pattern within a small budget.
    for (const port of this.#ports)
      for (const spelling of loopbackSpellings) {
        const host = `${spelling}\\.?`;
        patterns.push(`^(?:https?|wss?)://${userinfo}${host}:${port}${end}`);
        if (port === 80) patterns.push(`^(?:http|ws)://${userinfo}${host}${end}`);
        if (port === 443) patterns.push(`^(?:https|wss)://${userinfo}${host}${end}`);
      }
    return patterns;
  }
}

/**
 * Every spelling of a loopback host as a browser serializes it: `localhost` and its subdomains,
 * `127.0.0.0/8`, `[::1]`, an IPv4-mapped loopback address, the unspecified addresses a browser
 * connects to locally, each with or without a trailing dot. The one list the predicate and the
 * request patterns share.
 */
const loopbackSpellings = [
  "localhost",
  "(?:[a-z0-9-]+\\.)+localhost",
  "127\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}",
  "0\\.0\\.0\\.0",
  "\\[::1\\]",
  "\\[::\\]",
  "\\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\\]",
  "\\[::ffff:0:0\\]",
];
const loopbackHostname = new RegExp(`^(?:${loopbackSpellings.join("|")})\\.?$`, "u");

/**
 * A URL on this machine's loopback, whatever its port: what the Home's own session cookie reaches
 * on a Mac, where cookies are kept by host and not by port (M4). On a Cloud Computer or a Linux
 * Home that cookie is `__Host-` on the canonical HTTPS origin and reaches no other host.
 */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
    return loopbackHostname.test(url.hostname);
  } catch {
    return false;
  }
}

/** Request patterns (RE2) for every loopback spelling on any port, from the same list. */
export function loopbackRequestPatterns(): string[] {
  return loopbackSpellings.map(
    (spelling) => `^(?:https?|wss?)://(?:[^/?#@]*@)?${spelling}\\.?(?::[0-9]+)?(?:[/?#]|$)`,
  );
}

/**
 * The Home's own cookies, by name: its session (`opensteer.session`, `__Host-opensteer.session`),
 * its sign-in admission, its app gateway's, an integration authorization's binding, and the
 * identity library's own.
 */
export function isHomeCookieName(name: string): boolean {
  return /^(?:__Host-|__Secure-)?(?:opensteer|better-auth)[._-]/u.test(name.trim());
}

/** A Cookie header without the Home's own cookies; the page's other cookies stay. */
export function withoutHomeCookies(header: string): string {
  return header
    .split(";")
    .filter((pair) => !isHomeCookieName(pair.split("=", 1)[0] ?? ""))
    .map((pair) => pair.trim())
    .filter(Boolean)
    .join("; ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const loopbackNeedles = ["localhost", "127.", "[::1]", "[::ffff:", "0.0.0.0", "[::]"];

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
 * IPv4-mapped loopback address, and the unspecified addresses a browser connects to locally
 * (`[::ffff:0:0]` among them), with or without a trailing dot.
 */
function isLoopbackUrlHostname(hostname: string): boolean {
  return loopbackHostname.test(hostname);
}
