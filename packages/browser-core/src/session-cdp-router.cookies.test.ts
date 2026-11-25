import { describe, expect, it, vi } from "vitest";
import { ThisHomeAddressSet } from "@opensteer/shared/homeAddress";
import * as portable from "./portable-session-cdp-router.js";
import {
  SessionCdpRouter,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpEvent,
  type CdpParameters,
} from "./session-cdp-router.js";

// Read as a namespace so the router's production shapes below run (and fail) where the list is absent.
const homeCookieCarriers: ReadonlySet<string> =
  (portable as { homeCookieCarriers?: ReadonlySet<string> }).homeCookieCarriers ?? new Set();
const withoutHomeCookieValues = (method: string, value: unknown, set: ThisHomeAddressSet) =>
  (
    portable as {
      withoutHomeCookieValues?: (m: string, v: unknown, s: ThisHomeAddressSet) => unknown;
    }
  ).withoutHomeCookieValues?.(method, value, set) ?? value;

const home = { origins: ["https://home.example.com"], loopbackPorts: [4310] };
const secret = "HOME_SECRET";
const homeCookies = [
  { name: "opensteer.session", value: secret, domain: "127.0.0.1" },
  { name: "__Host-opensteer.session", value: secret, domain: "home.example.com" },
  { name: "opensteer.admission", value: secret, domain: "localhost" },
];
const theirs = { name: "theirs", value: "kept", domain: "127.0.0.1" };
const cookieHeader = `theirs=kept; opensteer.session=${secret}; __Host-opensteer.session=${secret}`;
const setCookie = `opensteer.session=${secret}; Path=/; HttpOnly\ntheirs=kept; Path=/`;
const headersText = `GET / HTTP/1.1\r\nHost: localhost:5173\r\nCookie: ${cookieHeader}\r\n\r\n`;
const responseText = `HTTP/1.1 200 OK\r\nSet-Cookie: opensteer.session=${secret}; Path=/\r\nSet-Cookie: theirs=kept\r\n\r\n`;

/**
 * Each carrier as a browser gives it: the Home's cookie in every place that method can hold one,
 * beside a cookie of the page's own that must stay.
 */
const samples: Record<string, CdpParameters> = {
  "Network.getCookies": { cookies: [...homeCookies, theirs] },
  "Network.getAllCookies": { cookies: [...homeCookies, theirs] },
  "Storage.getCookies": { cookies: [...homeCookies, theirs] },
  "Page.getCookies": { cookies: [...homeCookies, theirs] },
  "Network.loadNetworkResource": {
    resource: { success: true, headers: { "Set-Cookie": setCookie, etag: "kept" } },
  },
  "Network.requestWillBeSent": {
    requestId: "1",
    request: { url: "http://localhost:5173/", headers: { Cookie: cookieHeader } },
  },
  "Network.requestWillBeSentExtraInfo": {
    requestId: "1",
    headers: { cookie: cookieHeader },
    associatedCookies: [
      ...homeCookies.map((cookie) => ({ blockedReasons: [], cookie })),
      { blockedReasons: [], cookie: theirs },
    ],
  },
  "Network.responseReceived": {
    requestId: "1",
    response: {
      url: "http://localhost:5173/",
      headers: { "set-cookie": setCookie },
      requestHeaders: { Cookie: cookieHeader },
      headersText: responseText,
      requestHeadersText: headersText,
    },
  },
  "Network.responseReceivedExtraInfo": {
    requestId: "1",
    headers: { "Set-Cookie": setCookie },
    headersText: responseText,
    blockedCookies: [
      { blockedReasons: [], cookieLine: `opensteer.session=${secret}; Path=/` },
      { blockedReasons: [], cookieLine: "theirs=kept" },
    ],
    exemptedCookies: [
      { exemptionReason: "x", cookie: homeCookies[0] },
      { exemptionReason: "x", cookie: theirs },
    ],
  },
  "Network.responseReceivedEarlyHints": { requestId: "1", headers: { "set-cookie": setCookie } },
  "Network.webSocketWillSendHandshakeRequest": {
    requestId: "1",
    request: { headers: { Cookie: cookieHeader } },
  },
  "Network.webSocketHandshakeResponseReceived": {
    requestId: "1",
    response: {
      headers: { "Set-Cookie": setCookie },
      requestHeaders: { Cookie: cookieHeader },
      headersText: responseText,
      requestHeadersText: headersText,
    },
  },
  "Network.requestIntercepted": {
    interceptionId: "1",
    request: { headers: { Cookie: cookieHeader } },
    responseHeaders: { "Set-Cookie": setCookie },
  },
  "Fetch.requestPaused": {
    requestId: "1",
    request: { headers: { Cookie: cookieHeader } },
    responseHeaders: [
      { name: "Set-Cookie", value: setCookie },
      { name: "content-type", value: "text/html" },
    ],
  },
  "Fetch.authRequired": { requestId: "1", request: { headers: { cookie: cookieHeader } } },
  "Audits.issueAdded": {
    issue: {
      code: "CookieIssue",
      details: {
        cookieIssueDetails: {
          cookie: { name: "opensteer.session", domain: "127.0.0.1", path: "/" },
          rawCookieLine: `opensteer.session=${secret}; Path=/`,
        },
      },
    },
  },
};

describe("an agent reads no Home cookie through any CDP door (item 7)", () => {
  const set = new ThisHomeAddressSet(home);

  it("has a sample for every carrier and a carrier for every sample", () => {
    expect(Object.keys(samples).sort()).toEqual([...homeCookieCarriers].sort());
  });

  for (const method of Object.keys(samples))
    it(`${method} carries no Home cookie and keeps the page's own`, () => {
      const sample = samples[method]!;
      expect(JSON.stringify(sample)).toContain(secret);
      const scrubbed = JSON.stringify(withoutHomeCookieValues(method, sample, set));
      expect(scrubbed).not.toContain(secret);
      if (method !== "Audits.issueAdded") expect(scrubbed).toContain("kept");
    });

  it("leaves a non-carrier alone without looking at it", () => {
    const value = { headers: { Cookie: cookieHeader } };
    expect(withoutHomeCookieValues("Runtime.evaluate", value, set)).toBe(value);
  });
});

class Channel implements CdpChannel {
  readonly listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  close(): Promise<void> {
    return Promise.resolve();
  }
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async send(method: string): Promise<unknown> {
    return samples[method] ?? {};
  }
  emit(method: string, parameters: CdpParameters): void {
    for (const listener of this.listeners) listener(method, parameters);
  }
}

class Backend implements BrowserCdpBackend {
  dedicatedContext = true;
  allowsProfileCookieReads = false;
  readonly channels = new Map<string, Channel>();
  readonly listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  setAgentControlled(): void {}
  attach(targetId: string): Promise<CdpChannel> {
    const channel = new Channel();
    this.channels.set(targetId, channel);
    return Promise.resolve(channel);
  }
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(method: string, parameters?: CdpParameters): Promise<unknown> {
    if (method === "Target.getTargets")
      return Promise.resolve({
        targetInfos: [{ targetId: "seed", type: "page", url: "http://localhost:5173/" }],
      });
    if (method === "Target.getTargetInfo")
      return Promise.resolve({
        targetInfo: { targetId: parameters?.targetId, type: "page", url: "http://localhost:5173/" },
      });
    return Promise.resolve(samples[method] ?? {});
  }
}

function setup() {
  const backend = new Backend();
  const router = new SessionCdpRouter(backend);
  router.registerSession("s", "seed", async () => true, "/files/s");
  router.setHomeAddresses(home);
  return { backend, router };
}

describe("in the router's production call shapes (item 7)", () => {
  for (const method of ["Storage.getCookies", "Network.getAllCookies"])
    it(`a Run's relay reads no Home cookie with ${method} on the session's root`, async () => {
      const { router } = setup();
      const read = await router.send("s", { method, relayId: crypto.randomUUID() });
      expect(JSON.stringify(read)).not.toContain(secret);
      expect(JSON.stringify(read)).toContain("kept");
    });

  it("a Run's script reads no Home cookie with Storage.getCookies", async () => {
    const { router } = setup();
    router.openScriptAttachment(
      "s",
      "script",
      "seed",
      { maxBytes: 1_000_000, maxDepth: 32, maxEntries: 16_384 },
      () => undefined,
    );
    const read = await router.send("s", {
      method: "Storage.getCookies",
      scriptAttachmentId: "script",
    });
    expect(JSON.stringify(read)).not.toContain(secret);
  });

  it("an agent's page session hears no Home cookie in a request's headers or a nested reply", async () => {
    const { backend, router } = setup();
    const events: CdpEvent[] = [];
    router.onEvent("s", (event) => events.push(event));
    const relayId = crypto.randomUUID();
    (router as { openRelay?: (s: string, r: string) => void }).openRelay?.("s", relayId);
    const { sessionId } = (await router.send("s", {
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
      relayId,
    })) as { sessionId: string };
    for (const method of [
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceivedExtraInfo",
      "Network.webSocketWillSendHandshakeRequest",
    ])
      backend.channels.get("seed")!.emit(method, samples[method]!);
    await router.send("s", {
      method: "Target.sendMessageToTarget",
      parameters: {
        sessionId,
        message: JSON.stringify({ id: 1, method: "Network.getCookies", params: {} }),
      },
      relayId,
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.method === "Target.receivedMessageFromTarget")).toBe(
        true,
      ),
    );
    expect(events.some((event) => event.method === "Network.requestWillBeSentExtraInfo")).toBe(
      true,
    );
    expect(events.some((event) => event.method === "Target.receivedMessageFromTarget")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});
