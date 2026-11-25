import { once } from "node:events";
import { createServer } from "node:http";
import {
  browserViewerGraceMs,
  HttpHostClient,
  type ClientLifecycle,
  type WebSocketClient,
} from "@opensteer/client/host";
import { MockHostClient, MockPersonalHost } from "@opensteer/client/mock";
import type { TabId } from "@opensteer/core";
import { BrowserServerMessageSchema, BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { bridgeMockPersonalRealtime, handleMockPersonalRpc } from "./mock-personal-host-server.js";

function nodeWebSocketFactory(url: string): WebSocketClient {
  return new WebSocket(url) as unknown as WebSocketClient;
}

describe("mock personal host HTTP + WS fixture bridge", () => {
  it("synchronizes an aliased runtime surfaceId, binds its browser session, and opens its viewer socket", async () => {
    const mock = new MockHostClient({ latencyMs: 0 });
    await mock.load();
    const expectedSessionId = mock.getSnapshot().browserSessions[0]!.id;
    const mockPageTab = [...mock.getSnapshot().tabs.rows.values()].find(
      (tab) => tab.kind === "page",
    )!;
    const runtimeSurfaceId = BrowserSurfaceIdSchema.parse(
      "surface_11111111-1111-4111-8111-111111111111",
    );
    const alias = { pageTabAlias: { from: mockPageTab.tabId, to: runtimeSurfaceId } };
    const personalHost = new MockPersonalHost(mock);
    const wss = new WebSocketServer({ noServer: true });
    let subscribedSurface: string | null = null;
    const server = createServer((request, response) => {
      void handleMockPersonalRpc(personalHost, request, response, alias).then((handled) => {
        if (!handled) {
          response.statusCode = 404;
          response.end();
        }
      });
    });
    server.on("upgrade", (request, socket, head) => {
      if (request.url?.startsWith("/v1/realtime")) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          bridgeMockPersonalRealtime(personalHost, ws, alias);
        });
        return;
      }
      if (request.url?.includes("/browser-sessions/")) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.send(
            JSON.stringify(
              BrowserServerMessageSchema.parse({
                type: "browser.snapshot",
                sessionId: expectedSessionId,
                state: "ready",
                access: "read-write",
                dialog: null,
                targetedStreamingVersion: 1,
                surfaces: [
                  { active: true, id: runtimeSurfaceId, title: "Baseline", url: "about:blank" },
                ],
              }),
            ),
          );
          ws.on("message", (raw) => {
            const parsed = JSON.parse(raw.toString()) as { type?: string; surfaceId?: string };
            if (parsed.type === "stream.subscribe") subscribedSurface = parsed.surfaceId ?? null;
          });
        });
        return;
      }
      socket.destroy();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = new HttpHostClient({
      baseUrl: origin,
      capabilities: [],
      webSocketFactory: nodeWebSocketFactory,
    });
    try {
      await client.load();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for page tab")), 5_000);
        const check = () => {
          if (client.getSnapshot().tabs.rows.has(runtimeSurfaceId as unknown as TabId)) {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        };
        const unsubscribe = client.subscribe(check);
        check();
      });
      await client.activateTab(runtimeSurfaceId as unknown as TabId);
      expect(client.getSnapshot().browserSessions.map((s) => s.id)).toContain(expectedSessionId);
      const release = client.retainBrowserViewer(expectedSessionId, runtimeSurfaceId);
      await vi.waitFor(() => expect(subscribedSurface).toBe(runtimeSurfaceId), { timeout: 5_000 });
      release();
    } finally {
      client.dispose();
      personalHost.dispose();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("opens and pauses browser viewer/watch sockets across lock/unlock for electron-idle-lifecycle-smoke", async () => {
    const mock = new MockHostClient({ latencyMs: 0 });
    await mock.load();
    const pageTab = [...mock.getSnapshot().tabs.rows.values()].find((tab) => tab.kind === "page")!;
    const activated = await mock.activateTab(pageTab.tabId);
    if (activated.kind !== "page") throw new Error("Expected page viewer");
    const sessionId = activated.sessionId;
    const surfaceId = BrowserSurfaceIdSchema.parse(pageTab.tabId);
    const personalHost = new MockPersonalHost(mock);
    const wss = new WebSocketServer({ noServer: true });
    const subscriptions = new Set<string>();
    let opened = 0;
    const server = createServer((request, response) => {
      void handleMockPersonalRpc(personalHost, request, response).then((handled) => {
        if (!handled) {
          response.statusCode = 404;
          response.end();
        }
      });
    });
    server.on("upgrade", (request, socket, head) => {
      if (request.url?.startsWith("/v1/realtime")) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          bridgeMockPersonalRealtime(personalHost, ws);
        });
        return;
      }
      if (request.url?.includes("/browser-sessions/")) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          const key = `${++opened}:${request.url?.includes("mode=watch") ? "watch" : "control"}`;
          ws.send(
            JSON.stringify(
              BrowserServerMessageSchema.parse({
                type: "browser.snapshot",
                sessionId,
                state: "ready",
                access: "read-write",
                dialog: null,
                targetedStreamingVersion: 1,
                surfaces: [
                  { active: true, id: surfaceId, title: "Idle smoke", url: "about:blank" },
                ],
              }),
            ),
          );
          ws.on("message", (raw) => {
            if (JSON.parse(raw.toString()).type === "stream.subscribe") subscriptions.add(key);
          });
          ws.on("close", () => subscriptions.delete(key));
        });
        return;
      }
      socket.destroy();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const origin = `http://127.0.0.1:${address.port}`;

    let visible = false;
    const foregroundListeners = new Set<() => void>();
    const backgroundListeners = new Set<() => void>();
    const lifecycle: ClientLifecycle = {
      getSnapshot: () => ({
        network: "online",
        visibility: visible ? "foreground" : "background",
      }),
      onForeground: (listener) => {
        foregroundListeners.add(listener);
        return () => foregroundListeners.delete(listener);
      },
      onBackground: (listener) => {
        backgroundListeners.add(listener);
        return () => backgroundListeners.delete(listener);
      },
      onNetworkChange: () => () => undefined,
    };
    const setVisible = (next: boolean) => {
      visible = next;
      for (const listener of next ? foregroundListeners : backgroundListeners) listener();
    };

    const viewerSockets: WebSocketClient[] = [];
    const client = new HttpHostClient({
      baseUrl: origin,
      capabilities: [],
      lifecycle,
      webSocketFactory: (url) => {
        const socket = nodeWebSocketFactory(url);
        if (url.includes("/browser-sessions/")) viewerSockets.push(socket);
        return socket;
      },
    });
    let activatedSurface = false;
    const stopBind = client.subscribe(() => {
      if (activatedSurface) return;
      const snapshot = client.getSnapshot();
      if (
        snapshot.session === "authenticated" &&
        snapshot.tabs.rows.has(surfaceId as unknown as TabId)
      ) {
        activatedSurface = true;
        void client.activateTab(surfaceId as unknown as TabId);
      }
    });
    try {
      await client.load();
      const releaseControl = client.retainBrowserViewer(sessionId, surfaceId);
      const releaseWatch = client.retainBrowserWatch(sessionId, surfaceId);
      expect(subscriptions.size).toBe(0);

      setVisible(true);
      await vi.waitFor(() => expect(subscriptions.size).toBe(2), { timeout: 5_000 });

      // Hidden, the client stays a viewer for the grace, then lets go of both sockets.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        setVisible(false);
        vi.advanceTimersByTime(browserViewerGraceMs - 1);
        // The client's own sockets: closing one changes its state at once.
        expect(viewerSockets.filter((socket) => socket.readyState === 1)).toHaveLength(2);
        vi.advanceTimersByTime(1);
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(subscriptions.size).toBe(0), { timeout: 5_000 });

      setVisible(true);
      await vi.waitFor(() => expect(subscriptions.size).toBe(2), { timeout: 5_000 });

      releaseControl();
      releaseWatch();
    } finally {
      stopBind();
      client.dispose();
      personalHost.dispose();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
