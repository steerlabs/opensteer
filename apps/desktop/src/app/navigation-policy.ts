import { isAppNavigation, isAppOriginUrl } from "@opensteer/shared/appFrame";
import { isPublishedAppUrl } from "./published-app-protocol.js";

/** A lookup that finishes after a re-attachment speaks for nothing. */
export async function attachedHostOrigin(transport: {
  current(): Promise<{ readonly resolved: { readonly key: string; readonly origin: string } }>;
  currentKey(): string | null;
}): Promise<string | null> {
  try {
    const { resolved } = await transport.current();
    return resolved.key === transport.currentKey() ? resolved.origin : null;
  } catch {
    return null;
  }
}

export class DesktopAppOriginPolicy {
  #host: URL | null = null;

  setAttachedHost(value: string | null): void {
    this.#host = value ? parseUrl(value) : null;
  }

  isPublishedApp(value: string): boolean {
    return isPublishedAppUrl(value) || this.isAttachedApp(value);
  }

  isAttachedApp(value: string): boolean {
    const app = parseUrl(value);
    const host = this.#host;
    if (!app || !host || !isAppOriginUrl(value) || app.username || app.password) return false;
    if (host.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname))
      return (
        app.protocol === "http:" &&
        app.port === host.port &&
        /^[a-z2-7]{26}\.localhost$/u.test(app.hostname)
      );
    const connect =
      /^connect-([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.(.+)$/u.exec(
        host.hostname,
      );
    if (!connect || host.protocol !== "https:") return false;
    const deployment = connect.slice(1, 6).join("");
    return (
      app.protocol === "https:" &&
      app.port === host.port &&
      app.hostname.slice(26) === `-${deployment}.${connect[6]}`
    );
  }

  allowsNavigation(value: string, source?: string): boolean {
    const url = parseUrl(value);
    return (
      url !== null &&
      (isDesktopAppUrl(url) ||
        (!!source &&
          this.isPublishedApp(source) &&
          this.isPublishedApp(value) &&
          isAppNavigation(value, source)))
    );
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

  allowsNetworkRequest(
    value: string,
    frame?: {
      readonly url: string;
      readonly resourceType: string;
      readonly initiatorOrigin?: string;
    },
  ): boolean {
    const url = parseUrl(value);
    if (!url) return false;
    if (isDesktopAppUrl(url) || isPublishedAppUrl(value)) return true;
    if (isAppOriginUrl(value) && !this.isAttachedApp(value)) return false;
    if (frame?.resourceType === "subFrame" && this.isAttachedApp(value)) return true;
    if (frame?.resourceType === "mainFrame") return false;
    const source = frame?.initiatorOrigin ?? frame?.url;
    if (
      source &&
      this.isAttachedApp(source) &&
      ["http:", "https:", "ws:", "wss:", "blob:", "data:"].includes(url.protocol)
    )
      return true;
    if (
      url.protocol === "https:" &&
      frame &&
      isPublishedAppUrl(frame.url) &&
      ["script", "stylesheet", "image", "font", "media"].includes(frame.resourceType)
    )
      return true;
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
