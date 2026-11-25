// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { browserViewerGraceMs, HttpHostClient, type WebSocketClient } from "@opensteer/client/host";
import { MockHostClient, MockPersonalHost } from "@opensteer/client/mock";
import type { TabId } from "@opensteer/core";
import { browserClientLifecycle } from "./browser-lifecycle.js";

/** A browser viewer socket the Home counts while it is open. */
class ViewerSocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  addEventListener(type: string, listener: (event: never) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  send() {}
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    void Promise.resolve().then(() => {
      for (const listener of this.listeners.get("close") ?? []) listener({ code, reason } as never);
    });
  }
}

let hidden = false;
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => (hidden ? "hidden" : "visible"),
});
const setHidden = (next: boolean) => {
  hidden = next;
  document.dispatchEvent(new Event("visibilitychange"));
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  setHidden(false);
});

it("lets go of the page's viewer once the Home's tab is hidden past the grace, and takes it again when shown", async () => {
  const seed = new MockHostClient({ latencyMs: 0 });
  await seed.load();
  const page = [...seed.getSnapshot().tabs.rows.values()].find((tab) => tab.kind === "page")!;
  const host = new MockPersonalHost(seed);
  const sockets: ViewerSocket[] = [];
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    fetch: host.fetch,
    lifecycle: browserClientLifecycle(),
    webSocketFactory: (url) => {
      if (!url.includes("/browser-sessions/")) return host.connect();
      const socket = new ViewerSocket();
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
  // The browser panel's own hold: the picture and its controls.
  client.retainBrowserViewer(viewer.sessionId, page.tabId);
  expect(open()).toHaveLength(1);

  vi.useFakeTimers();
  // Flipping to another tab and back reconnects nothing.
  setHidden(true);
  vi.advanceTimersByTime(browserViewerGraceMs - 1);
  setHidden(false);
  vi.advanceTimersByTime(browserViewerGraceMs);
  expect(open()).toHaveLength(1);
  expect(sockets).toHaveLength(1);

  // Left in a background tab: past the grace the Home no longer counts it as a viewer.
  setHidden(true);
  vi.advanceTimersByTime(browserViewerGraceMs);
  expect(open()).toHaveLength(0);
  // Only the viewer goes: the tab list stays.
  expect(client.getSnapshot().tabs.rows.has(page.tabId)).toBe(true);

  setHidden(false);
  expect(open()).toHaveLength(1);
});
