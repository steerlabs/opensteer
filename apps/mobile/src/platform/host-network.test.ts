import type { WebSocketClient } from "@opensteer/client/host";
import { describe, expect, it } from "vitest";
import {
  createHostAuthorization,
  createHostNetwork,
  isSameHostDestination,
  type HostFetch,
} from "./host-network.js";

const socket = {} as WebSocketClient;
const origin = "https://host.example.com";

const network = (tokens: (string | null)[], answer?: () => Response) => {
  const requests: { init: RequestInit | undefined; input: unknown }[] = [];
  const sockets: { headers: Readonly<Record<string, string>>; url: string }[] = [];
  const fetch: HostFetch = async (input, init) => {
    requests.push({ init, input });
    return answer?.() ?? new Response("{}");
  };
  let index = 0;
  const authorization = createHostAuthorization(async () => tokens[index++] ?? null);
  return {
    host: createHostNetwork({
      authorization,
      fetch,
      openWebSocket: (url, headers) => {
        sockets.push({ headers, url });
        return socket;
      },
      origin,
    }),
    requests,
    sockets,
  };
};

describe("createHostNetwork", () => {
  it("carries the deployment's credential on every request", async () => {
    const { host, requests } = network(["Bearer first", "Bearer second"]);

    await host.fetch("https://host.example.com/v1/rpc/auth.session");
    await host.fetch("https://host.example.com/v1/rpc/auth.session");

    expect(requests.map(({ init }) => new Headers(init?.headers).get("authorization"))).toEqual([
      "Bearer first",
      "Bearer second",
    ]);
  });

  it("refuses the phone's shared cookie jar", async () => {
    const { host, requests } = network(["Bearer token"]);

    await host.fetch("https://host.example.com/v1/rpc/auth.session");

    expect(requests[0]?.init?.credentials).toBe("omit");
  });

  it("sends no header when the deployment has no credential", async () => {
    const { host, requests } = network([null]);

    await host.fetch("https://host.example.com/.well-known/opensteer");

    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBeNull();
  });

  it("opens a socket with the header the last request obtained", async () => {
    const { host, sockets } = network(["PersonalRemote abc.def"]);
    await host.fetch("https://host.example.com/v1/rpc/auth.session");

    host.webSocketFactory("wss://host.example.com/v1/realtime");

    expect(sockets).toEqual([
      {
        headers: { Authorization: "PersonalRemote abc.def" },
        url: "wss://host.example.com/v1/realtime",
      },
    ]);
  });

  it("opens an unauthenticated socket rather than inventing a header", () => {
    const { host, sockets } = network([]);

    host.webSocketFactory("wss://host.example.com/v1/realtime");

    expect(sockets[0]?.headers).toEqual({});
  });

  it("sends nothing at all to a destination outside the attachment's origin", async () => {
    const { host, requests } = network(["Bearer token", "Bearer token"]);

    await expect(host.fetch("https://elsewhere.example.com/v1/rpc/auth.session")).rejects.toThrow(
      /outside the deployment/u,
    );
    await expect(host.fetch("https://host.example.com.evil.test/v1/rpc")).rejects.toThrow(
      /outside the deployment/u,
    );
    await expect(host.fetch("http://host.example.com/v1/rpc")).rejects.toThrow(
      /outside the deployment/u,
    );

    expect(requests).toEqual([]);
  });

  it("refuses to open a socket outside the attachment's origin", () => {
    const { host, sockets } = network(["Bearer token"]);

    expect(() => host.webSocketFactory("wss://elsewhere.example.com/v1/realtime")).toThrow(
      /outside the deployment/u,
    );
    expect(() => host.webSocketFactory("ws://host.example.com/v1/realtime")).toThrow(
      /outside the deployment/u,
    );
    expect(sockets).toEqual([]);
  });

  it("never follows a redirect with a credential attached", async () => {
    const { host, requests } = network(
      ["Bearer token"],
      () => new Response(null, { headers: { location: "https://elsewhere.test/" }, status: 302 }),
    );

    await expect(host.fetch("https://host.example.com/v1/rpc/auth.session")).rejects.toThrow(
      /redirected a request/u,
    );
    expect(requests[0]?.init?.redirect).toBe("manual");
  });
});

describe("isSameHostDestination", () => {
  it("accepts the origin itself and the socket scheme it upgrades to", () => {
    expect(isSameHostDestination(origin, "https://host.example.com/v1/rpc")).toBe(true);
    expect(isSameHostDestination(origin, "wss://host.example.com/v1/realtime")).toBe(true);
    expect(isSameHostDestination("http://127.0.0.1:7777", "ws://127.0.0.1:7777/v1")).toBe(true);
  });

  it("refuses a different host, port, scheme, or an unreadable URL", () => {
    expect(isSameHostDestination(origin, "https://host.example.com:8443/v1")).toBe(false);
    expect(isSameHostDestination(origin, "https://other.example.com/v1")).toBe(false);
    expect(isSameHostDestination(origin, "http://host.example.com/v1")).toBe(false);
    expect(isSameHostDestination(origin, "ws://host.example.com/v1")).toBe(false);
    expect(isSameHostDestination(origin, "not a url")).toBe(false);
  });
});
