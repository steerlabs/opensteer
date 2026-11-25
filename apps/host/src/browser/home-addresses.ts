import { isLoopbackHostname } from "@opensteer/core";
import { ThisHomeAddressSet } from "@opensteer/shared/homeAddress";

/**
 * The addresses of this Home, which the Host alone decides: its canonical origin, its current
 * remote route's origin, and loopback on the ports this Host listens on itself (a loopback
 * address on any other port is a dev server, not this Home). Rule 1 (`authorizePageAddress`)
 * keeps a tab an agent drives off them; sign-in admission (`sign-in-admission.ts`) refuses their
 * sites; every attach ticket carries them to the browser (`browser-ticket.ts`).
 *
 * `current()` reads nothing: the route is held from the last `refresh()`, which runs at startup
 * and after every change of the route (`PersonalRemoteAccessService.configure`), so the hot paths
 * of the person's own agents issue no statement for it.
 */
export class HomeAddressBook {
  readonly #canonicalOrigin: string;
  readonly #loopbackPorts: readonly number[];
  readonly #readRoute: () => Promise<string | null>;
  #route: string | null = null;
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

  /** Reads the route now and keeps the set it gives. */
  async refresh(): Promise<ThisHomeAddressSet> {
    this.#route = await this.#readRoute();
    this.#set = this.#build();
    return this.#set;
  }

  #build(): ThisHomeAddressSet {
    return thisHomeAddresses({
      canonicalOrigin: this.#canonicalOrigin,
      routeOrigin: this.#route,
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
