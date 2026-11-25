import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabId } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient, type WebSocketClient } from "./host-session-client.js";
import { browserViewerGraceMs, type ClientLifecycle } from "./lifecycle.js";

/** A browser viewer socket the Home would count while it is open. */
class ViewerSocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (event: never) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  /** The Home admits the viewer, as it does with its first snapshot. */
  admit(sessionId: string) {
    this.readyState = 1;
    for (const listener of this.listeners.get("open") ?? []) listener({} as never);
    for (const listener of this.listeners.get("message") ?? [])
      listener({
        data: JSON.stringify({
          type: "browser.snapshot",
          sessionId,
          state: "ready",
          access: "read-write",
          targetedStreamingVersion: 1,
          dialog: null,
          surfaces: [],
        }),
      } as never);
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    // As a real socket, its close event comes after the call that closed it.
    void Promise.resolve().then(() => {
      for (const listener of this.listeners.get("close") ?? []) listener({ code, reason } as never);
    });
  }
}

/** A platform whose visibility and network the test sets, as a browser tab or an app reports them. */
function platform(visible = true) {
  const foreground = new Set<() => void>();
  const background = new Set<() => void>();
  const network = new Set<(state: "online" | "offline", path: "changed" | "same") => void>();
  const freeze = new Set<() => void>();
  const resume = new Set<() => void>();
  let state = { visible, online: true };
  const lifecycle: ClientLifecycle = {
    getSnapshot: () => ({
      network: state.online ? "online" : "offline",
      visibility: state.visible ? "foreground" : "background",
    }),
    onForeground: (listener) => {
      foreground.add(listener);
      return () => foreground.delete(listener);
    },
    onBackground: (listener) => {
      background.add(listener);
      return () => background.delete(listener);
    },
    onNetworkChange: (listener) => {
      network.add(listener);
      return () => network.delete(listener);
    },
    onFreeze: (listener) => {
      freeze.add(listener);
      return () => freeze.delete(listener);
    },
    onResume: (listener) => {
      resume.add(listener);
      return () => resume.delete(listener);
    },
  };
  return {
    lifecycle,
    show(next: boolean) {
      if (state.visible === next) return;
      state = { ...state, visible: next };
      for (const listener of next ? foreground : background) listener();
    },
    online(next: boolean) {
      state = { ...state, online: next };
      for (const listener of network) listener(next ? "online" : "offline", "changed");
    },
    /** A handover to another network: still online, every socket suspect. */
    handover() {
      for (const listener of network) listener("online", "changed");
    },
    /** The platform stops the page's timers; the handler runs first. */
    freeze() {
      for (const listener of freeze) listener();
    },
    /** The page runs again, seen or not as its visibility says. */
    resume(visible: boolean) {
      state = { ...state, visible };
      for (const listener of resume) listener();
      for (const listener of visible ? foreground : background) listener();
    },
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

/** A Home with a page this client opened, and the viewer sockets the client has open to it. */
async function viewing(visible = true) {
  const seed = new MockHostClient({ latencyMs: 0 });
  await seed.load();
  const page = [...seed.getSnapshot().tabs.rows.values()].find((tab) => tab.kind === "page")!;
  const host = new MockPersonalHost(seed);
  const device = platform(visible);
  const sockets: ViewerSocket[] = [];
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: ["browser-target-control-v1"],
    fetch: host.fetch,
    lifecycle: device.lifecycle,
    webSocketFactory: (url) => {
      if (!url.includes("/browser-sessions/")) return host.connect();
      const socket = new ViewerSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  cleanups.push(() => {
    client.dispose();
    host.dispose();
  });
  await client.load();
  await vi.waitFor(() => expect(client.getSnapshot().tabs.rows.has(page.tabId)).toBe(true));
  const viewer = await client.activateTab(page.tabId as TabId);
  if (viewer.kind !== "page") throw new Error("Expected a page viewer");
  const open = () => sockets.filter((socket) => socket.readyState !== 3);
  return { client, device, page, sessionId: viewer.sessionId, sockets, open };
}

describe("a client is a browser viewer only while the person can see the picture", () => {
  it("keeps its viewers through a hidden spell shorter than the grace", async () => {
    const { client, device, page, sessionId, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId);
    client.retainBrowserWatch(sessionId, page.tabId);
    expect(open()).toHaveLength(2);
    vi.useFakeTimers();
    device.show(false);
    vi.advanceTimersByTime(browserViewerGraceMs - 1);
    expect(open(), "flipping to another tab and back must not drop the picture").toHaveLength(2);
    device.show(true);
    vi.advanceTimersByTime(browserViewerGraceMs * 10);
    expect(open()).toHaveLength(2);
  });

  it("lets go of every viewer once hidden past the grace, and only its viewers", async () => {
    const { client, device, page, sessionId, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId);
    client.retainBrowserWatch(sessionId, page.tabId);
    // A pictureless control socket is a viewer to the Home too: it holds the browser awake.
    client.retainBrowserViewer(sessionId, page.tabId, { picture: false });
    expect(open()).toHaveLength(2);
    vi.useFakeTimers();
    device.show(false);
    vi.advanceTimersByTime(browserViewerGraceMs);
    expect(open(), "a hidden client stays a viewer and keeps the browser awake").toHaveLength(0);
    // The tab list, titles and the task stream stay with the client while it is hidden.
    expect(client.getSnapshot().tabs.rows.has(page.tabId)).toBe(true);
    expect(client.getSnapshot().session).toBe("authenticated");
  });

  it("attaches again the moment the picture can be seen", async () => {
    const { client, device, page, sessionId, sockets, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId);
    vi.useFakeTimers();
    device.show(false);
    vi.advanceTimersByTime(browserViewerGraceMs);
    expect(open()).toHaveLength(0);
    device.show(true);
    expect(open()).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    // A second hidden spell starts its own grace.
    device.show(false);
    vi.advanceTimersByTime(browserViewerGraceMs - 1);
    expect(open()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(open()).toHaveLength(0);
  });

  it("lets go of a control socket without a picture too: the Home counts it as a viewer", async () => {
    const { client, device, page, sessionId, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId, { picture: false });
    expect(open()).toHaveLength(1);
    vi.useFakeTimers();
    device.show(false);
    vi.advanceTimersByTime(browserViewerGraceMs - 1);
    expect(open()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(open(), "a hidden client's pictureless socket keeps the browser awake").toHaveLength(0);
    device.show(true);
    expect(open()).toHaveLength(1);
  });

  it("leaves a person typing alone: a seen viewer stays, and a short look away keeps it admitted", async () => {
    const { client, device, page, sessionId, sockets, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId);
    sockets[0]!.admit(sessionId);
    const admitted = () => client.browserViewerState(sessionId, page.tabId).admitted === true;
    expect(admitted()).toBe(true);
    vi.useFakeTimers();
    vi.advanceTimersByTime(browserViewerGraceMs * 10);
    expect(open()).toHaveLength(1);
    expect(admitted()).toBe(true);
    device.show(false);
    vi.advanceTimersByTime(browserViewerGraceMs / 2);
    device.show(true);
    // The same socket, still admitted: typing goes on where it was.
    expect(sockets).toHaveLength(1);
    expect(admitted()).toBe(true);
    client.sendBrowserCommand(sessionId, { type: "input.cancel", surfaceId: page.tabId });
    expect(sockets[0]!.sent.some((raw) => JSON.parse(raw).type === "input.cancel")).toBe(true);
  });

  it("attaches nothing new while unseen: a network blip inside the grace brings no viewer back", async () => {
    const { client, device, page, sessionId, sockets, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId);
    expect(open()).toHaveLength(1);
    vi.useFakeTimers();
    device.show(false);
    vi.advanceTimersByTime(browserViewerGraceMs / 3);
    device.online(false);
    expect(open()).toHaveLength(0);
    device.online(true);
    vi.advanceTimersByTime(browserViewerGraceMs / 3);
    expect(open(), "a reconnect while nobody can see the picture").toHaveLength(0);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(browserViewerGraceMs * 10);
    expect(sockets).toHaveLength(1);
    device.show(true);
    expect(open()).toHaveLength(1);
  });

  it("attaches nothing new while unseen: a network handover or a new hold inside the grace", async () => {
    const { client, device, page, sessionId, sockets, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId);
    vi.useFakeTimers();
    device.show(false);
    vi.advanceTimersByTime(browserViewerGraceMs / 3);
    // A new hold, such as a live card mounting, while the page is hidden.
    client.retainBrowserWatch(sessionId, page.tabId);
    expect(sockets, "a viewer opened while nobody can see it").toHaveLength(1);
    // The sockets on the old path are suspect: they go, and nothing replaces them unseen.
    device.handover();
    expect(open()).toHaveLength(0);
    expect(sockets).toHaveLength(1);
    device.show(true);
    expect(open()).toHaveLength(2);
  });

  it("lets go at once when the page is frozen, whose timers would never let it go", async () => {
    const { client, device, page, sessionId, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId);
    client.retainBrowserWatch(sessionId, page.tabId);
    vi.useFakeTimers();
    device.show(false);
    device.freeze();
    expect(open(), "a frozen page keeps its sockets, and the Home its browser").toHaveLength(0);
    // Resumed but still hidden: nothing to keep, nothing attached.
    device.resume(false);
    vi.advanceTimersByTime(browserViewerGraceMs * 2);
    expect(open()).toHaveLength(0);
    device.resume(true);
    expect(open()).toHaveLength(2);
  });

  it("lets go at once when a visible page is frozen, and attaches again when it resumes seen", async () => {
    const { client, device, page, sessionId, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId);
    device.freeze();
    expect(open()).toHaveLength(0);
    device.resume(true);
    expect(open()).toHaveLength(1);
  });

  it("still lets go at once when the network is lost, visible or not", async () => {
    const { client, device, page, sessionId, open } = await viewing();
    client.retainBrowserViewer(sessionId, page.tabId);
    vi.useFakeTimers();
    device.show(false);
    device.online(false);
    expect(open()).toHaveLength(0);
  });
});
