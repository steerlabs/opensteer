import type { WebSocketClient } from "@opensteer/client/host";

export type HostFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export interface HostAuthorization {
  /** The header the next request should carry, refreshed if it has to be. */
  current(): Promise<string | null>;
  /** The header the last request obtained, for a socket that cannot await. */
  cached(): string | null;
}

/**
 * One deployment's authorization header, read once per request and remembered.
 *
 * A WebSocket is opened synchronously — the constructor takes its headers and
 * returns — so a socket cannot await a token refresh. It carries what the most
 * recent request obtained instead, which is sound because the client always
 * loads over HTTP before it subscribes, and a stale header is answered by the
 * Host with a 401 that ends the socket rather than by a silent downgrade.
 */
export function createHostAuthorization(load: () => Promise<string | null>): HostAuthorization {
  let remembered: string | null = null;
  return {
    cached: () => remembered,
    current: async () => {
      remembered = await load();
      return remembered;
    },
  };
}

export interface HostNetwork {
  readonly fetch: HostFetch;
  readonly webSocketFactory: (url: string) => WebSocketClient;
}

/**
 * The Host transport for one attached Deployment.
 *
 * Every request and socket carries this Deployment's credential and nothing
 * else, and only when it is addressed to the origin the resolver selected for
 * this attachment — the Host's verified canonical origin, or the separately
 * signed Personal access route. The fence is here rather than in the caller
 * because this is the last place a credential and a destination are both in
 * hand: whatever builds the URL, a credential leaves the phone only towards
 * the one origin this attachment resolved to.
 *
 * Redirects are refused for the same reason. The next hop of a redirect is a
 * destination nothing has judged, and a phone's fetch would carry the
 * `Authorization` header into it, so a redirect is reported as a failure
 * rather than followed. Cookies are refused explicitly too: a phone has one
 * process-wide cookie jar, and a Host session must never be authenticated by
 * something the app did not deliberately attach.
 */
export function createHostNetwork(options: {
  readonly authorization: HostAuthorization;
  readonly fetch: HostFetch;
  /** The attachment's resolved origin: every destination is judged against it. */
  readonly origin: string;
  readonly openWebSocket: (
    url: string,
    headers: Readonly<Record<string, string>>,
  ) => WebSocketClient;
}): HostNetwork {
  const fence = (destination: string): void => {
    if (!isSameHostDestination(options.origin, destination)) {
      throw new Error(
        "This request was addressed outside the deployment this phone is attached to.",
      );
    }
  };

  return {
    fetch: async (input, init) => {
      fence(destinationOf(input));
      const authorization = await options.authorization.current();
      const headers = new Headers(init?.headers);
      if (authorization !== null) headers.set("authorization", authorization);
      const response = await options.fetch(input, {
        ...init,
        credentials: "omit",
        headers,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("This deployment redirected a request this app will not follow.");
      }
      return response;
    },

    webSocketFactory: (url) => {
      fence(url);
      const authorization = options.authorization.cached();
      return options.openWebSocket(
        url,
        authorization === null ? {} : { Authorization: authorization },
      );
    },
  };
}

/** The URL a `fetch` argument names, whichever of its three forms it takes. */
function destinationOf(input: URL | RequestInfo): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

/**
 * Whether `destination` addresses exactly `origin`. A socket is the same
 * destination as its origin under the scheme the WebSocket protocol upgrades
 * to, and nothing else is: a different host, a different port, or a plaintext
 * scheme under an HTTPS origin is a different place.
 */
export function isSameHostDestination(origin: string, destination: string): boolean {
  let expected: URL;
  let target: URL;
  try {
    expected = new URL(origin);
    target = new URL(destination);
  } catch {
    return false;
  }
  const schemes =
    expected.protocol === "https:"
      ? ["https:", "wss:"]
      : expected.protocol === "http:"
        ? ["http:", "ws:"]
        : [expected.protocol];
  return schemes.includes(target.protocol) && target.host === expected.host;
}
