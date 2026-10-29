export class DesktopAppOriginPolicy {
  allowsNavigation(value: string): boolean {
    const url = parseUrl(value);
    return url !== null && isDesktopAppUrl(url);
  }

  /**
   * Whether `value` is this app's origin. Electron serializes one origin both
   * with a trailing slash (`app://opensteer/`, permission checks) and without
   * (`app://opensteer`, device permissions), so origins are compared parsed.
   */
  isAppOrigin(value: string): boolean {
    const url = parseUrl(value);
    return (
      url !== null &&
      isDesktopAppUrl(url) &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.search &&
      !url.hash
    );
  }

  allowsNetworkRequest(value: string): boolean {
    const url = parseUrl(value);
    if (!url) return false;
    if (isDesktopAppUrl(url)) return true;
    if (url.protocol === "blob:") {
      const embedded = parseUrl(url.href.slice("blob:".length));
      return embedded !== null && isDesktopAppUrl(embedded);
    }
    return url.protocol === "data:";
  }
}

export class HostOriginPolicy {
  readonly #origin: string;

  constructor(hostUrl: URL) {
    if (hostUrl.protocol !== "https:" && hostUrl.protocol !== "http:") {
      throw new Error("A desktop Host origin must use HTTP or HTTPS.");
    }
    this.#origin = hostUrl.origin;
  }

  allowsNavigation(value: string): boolean {
    const url = parseUrl(value);
    return (
      url !== null &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === this.#origin
    );
  }

  allowsNetworkRequest(value: string): boolean {
    const url = parseUrl(value);
    if (!url) return false;
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin === this.#origin;
    if (url.protocol === "wss:" || url.protocol === "ws:") {
      const equivalent = new URL(url.href);
      equivalent.protocol = url.protocol === "wss:" ? "https:" : "http:";
      return equivalent.origin === this.#origin;
    }
    if (url.protocol === "blob:") return url.origin === this.#origin;
    return url.protocol === "data:";
  }
}

/** Exact HTTP(S) authority for one main-process service session. */
export class ServiceOriginPolicy {
  readonly #origin: string;

  constructor(serviceUrl: URL) {
    if (serviceUrl.protocol !== "https:" && serviceUrl.protocol !== "http:") {
      throw new Error("A desktop service origin must use HTTP or HTTPS.");
    }
    if (serviceUrl.username || serviceUrl.password) {
      throw new Error("A desktop service origin cannot contain credentials.");
    }
    this.#origin = serviceUrl.origin;
  }

  allowsNetworkRequest(value: string): boolean {
    const url = parseUrl(value);
    return (
      url !== null &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === this.#origin
    );
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isDesktopAppUrl(url: URL): boolean {
  return (
    url.protocol === "app:" &&
    url.hostname === "opensteer" &&
    !url.port &&
    !url.username &&
    !url.password
  );
}
