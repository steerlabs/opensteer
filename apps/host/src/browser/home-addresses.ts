import { isLoopbackHostname } from "@opensteer/core";
import { ThisHomeAddressSet } from "@opensteer/shared/homeAddress";

/**
 * The addresses of this Home, which the Host alone decides: its canonical origin, its current
 * remote route's origin, and loopback on the ports this Host listens on itself (a loopback
 * address on any other port is a dev server, not this Home). Rule 1 (`authorizePageAddress`)
 * keeps a tab an agent drives off them; sign-in admission (`sign-in-admission.ts`) refuses their
 * sites; every browser runtime holds them as its own state, sent before a route takes effect
 * (`BrowserService.pushHomeAddresses`).
 *
 * `current()` reads nothing: the route is held from the last `refresh()`, which runs at startup,
 * and from `prepare`/`publish` around every change of the route
 * (`PersonalRemoteAccessService.configure`), so the hot paths
 * of the person's own agents issue no statement for it.
 */
export class HomeAddressBook {
  readonly #canonicalOrigin: string;
  readonly #loopbackPorts: readonly number[];
  readonly #readRoute: () => Promise<string | null>;
  #route: string | null = null;
  #incoming: string | null = null;
  #set: ThisHomeAddressSet;

  constructor(options: {
    readonly canonicalOrigin: URL;
    readonly listenPort: number;
    readonly readRoute: () => Promise<string | null>;
  }) {
    this.#canonicalOrigin = options.canonicalOrigin.origin;
    const ports = new Set([options.listenPort]);
    if (isLoopbackHostname(options.canonicalOrigin.hostname))
      ports.add(
        Number(options.canonicalOrigin.port) ||
          (options.canonicalOrigin.protocol === "https:" ? 443 : 80),
      );
    this.#loopbackPorts = [...ports];
    this.#readRoute = options.readRoute;
    this.#set = this.#build();
  }

  /** The set as last read. */
  current(): ThisHomeAddressSet {
    return this.#set;
  }

  /** Reads the route now and keeps the set it gives: at startup, when nothing else has it. */
  async refresh(): Promise<ThisHomeAddressSet> {
    this.publish(await this.#readRoute());
    return this.#set;
  }

  /**
   * A route about to be committed: until it is, or the change is given up, the set holds both the
   * current route and that one, so the browsers can be told before the new route takes effect.
   * Returns whether the set changed.
   */
  prepare(routeOrigin: string | null): boolean {
    return this.#change(() => {
      this.#incoming = routeOrigin;
    });
  }

  /** The change that `prepare` announced was not committed. Returns whether the set changed. */
  abandon(): boolean {
    return this.#change(() => {
      this.#incoming = null;
    });
  }

  /**
   * The route a committed change left (null: Remote access off). Returns whether the set changed,
   * so the browsers can be told.
   */
  publish(routeOrigin: string | null): boolean {
    return this.#change(() => {
      this.#route = routeOrigin;
      this.#incoming = null;
    });
  }

  #change(apply: () => void): boolean {
    const before = JSON.stringify(this.#set);
    apply();
    const next = this.#build();
    if (JSON.stringify(next) === before) return false;
    this.#set = next;
    return true;
  }

  #build(): ThisHomeAddressSet {
    return new ThisHomeAddressSet({
      origins: [
        this.#canonicalOrigin,
        ...[this.#route, this.#incoming].filter((origin): origin is string => !!origin),
      ],
      loopbackPorts: this.#loopbackPorts,
    });
  }
}

/** The one function that gives this Home's address set from what the Host knows of itself. */
export function thisHomeAddresses(input: {
  readonly canonicalOrigin: string;
  readonly routeOrigin: string | null | undefined;
  readonly loopbackPorts: readonly number[];
}): ThisHomeAddressSet {
  return new ThisHomeAddressSet({
    origins: [input.canonicalOrigin, ...(input.routeOrigin ? [input.routeOrigin] : [])],
    loopbackPorts: input.loopbackPorts,
  });
}
