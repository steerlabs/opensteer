import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, ipcMain, powerMonitor, protocol, systemPreferences } from "electron";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { MockHostClient, MockPersonalHost } from "@opensteer/client/mock";
import { BrowserServerMessageSchema, BrowserSurfaceIdSchema } from "@opensteer/protocol";
import type { CdpSession } from "@opensteer/browser-runtime-core";
import { DesktopLocalVisibility } from "../src/app/local-visibility.js";
import { desktopWebPreferences } from "../src/app/electron-window.js";
import { registerDesktopBridge } from "../src/bridge/registration.js";
import type { DesktopBridgeOptions } from "../src/bridge/context.js";
import {
  bridgeMockPersonalRealtime,
  handleMockPersonalRpc,
} from "./test-support/mock-personal-host-server.js";

/** Native lifecycle → real preload → shared client sockets and OwnerView effects. */
export async function idleLifecyclePhase(platform: CdpSession, directory: string): Promise<void> {
  const mock = new MockHostClient({ latencyMs: 0 });
  await mock.load();
  const pageTab = [...mock.getSnapshot().tabs.rows.values()].find((tab) => tab.kind === "page");
  assert(pageTab, "MockHostClient has no page tab for idle lifecycle smoke.");
  const activated = await mock.activateTab(pageTab.tabId);
  assert(activated.kind === "page", "Expected MockHostClient page viewer.");
  const sessionId = activated.sessionId;
  const surfaceId = BrowserSurfaceIdSchema.parse(pageTab.tabId);
  const personalHost = new MockPersonalHost(mock);
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("access-control-allow-origin", "app://opensteer");
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader(
        "access-control-allow-headers",
        request.headers["access-control-request-headers"] ?? "content-type",
      );
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }
      if (await handleMockPersonalRpc(personalHost, request, response)) return;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: false,
          error: { code: "not_found", message: "Outside smoke", retryable: false },
        }),
      );
    })().catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets = new WebSocketServer({ noServer: true });
  const subscriptions = new Set<string>();
  let opened = 0;
  let stopping = false;
  server.on("upgrade", (request, socket, head) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    if (request.url?.startsWith("/v1/realtime")) {
      sockets.handleUpgrade(request, socket, head, (ws) => {
        bridgeMockPersonalRealtime(personalHost, ws);
      });
      return;
    }
    if (!request.url?.includes("/browser-sessions/")) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
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
            surfaces: [{ active: true, id: surfaceId, title: "Idle smoke", url: "about:blank" }],
          }),
        ),
      );
      ws.on("message", (raw) => {
        if (JSON.parse(raw.toString()).type === "stream.subscribe") subscriptions.add(key);
      });
      ws.on("close", () => subscriptions.delete(key));
    });
  });
  const notifications = new Map<string, () => void>();
  const visibility = new DesktopLocalVisibility(
    powerMonitor,
    {
      subscribeWorkspaceNotification: (name, callback) => {
        notifications.set(name ?? "", () => callback(name ?? "", {}, ""));
        return systemPreferences.subscribeWorkspaceNotification(name, callback);
      },
      unsubscribeWorkspaceNotification: (id) =>
        systemPreferences.unsubscribeWorkspaceNotification(id),
    },
    process.platform,
  );
  const subscribe = () => () => undefined;
  const bridgeToken = "idle-smoke-capability-0123456789abcdef";
  const unregister = registerDesktopBridge({
    localVisibility: visibility,
    bridgeToken,
    ipcMain,
    downloads: { subscribe, snapshot: () => ({ downloads: [] }) },
    access: { subscribe },
    runner: { subscribe },
    personalRemote: { subscribe },
    passwords: { subscribe, signIns: { subscribe }, signInWindows: { subscribe } },
  } as unknown as DesktopBridgeOptions);
  // Only this fixture's content policy allows its loopback Host. The shipped
  // app policy remains exercised by the full browser and transport smokes.
  protocol.handle("app", async (request) => {
    const script = new URL(request.url).pathname === "/idle.js";
    return new Response(
      script
        ? await readFile(path.join(import.meta.dirname, "idle-renderer-smoke.global.js"))
        : '<!doctype html><meta charset="utf-8"><script type="module" src="/idle.js"></script>',
      {
        headers: {
          "content-type": script ? "text/javascript" : "text/html",
          "content-security-policy": `default-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src ${origin} ${origin.replace("http:", "ws:")}`,
        },
      },
    );
  });
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: {
      ...desktopWebPreferences(
        { mode: "production" },
        bridgeToken,
        path.join(import.meta.dirname, "desktop-preload.cjs"),
      ),
      backgroundThrottling: false,
    },
  });
  window.webContents.on("console-message", (event) => {
    process.stdout.write(`renderer: ${event.message}\n`);
  });
  window.webContents.on("preload-error", (_event, _path, error) => {
    process.stderr.write(`preload: ${error.stack}\n`);
  });
  const records: unknown[] = [];
  const snapshotSchema = z.object({
    visible: z.boolean(),
    captures: z.number(),
    openDisplays: z.number(),
    retains: z.number(),
    releases: z.number(),
    renewals: z.number(),
    finderRetains: z.number(),
    finderReleases: z.number(),
    events: z.array(z.string()),
  });
  const snapshot = async (
    name: string,
    ready: (state: z.infer<typeof snapshotSchema>) => boolean = () => true,
  ) => {
    const deadline = performance.now() + 5_000;
    let state;
    do {
      state = snapshotSchema.parse(
        await window.webContents.executeJavaScript("window.idleLifecycleSmoke.snapshot()"),
      );
      if (ready(state)) break;
      assert(performance.now() < deadline, `${name} did not settle`);
      await delay(25);
    } while (!ready(state));
    const record = {
      name,
      ...state,
      subscriptions: [...subscriptions],
      opened,
      at: performance.now(),
      rendererPid: window.webContents.getOSProcessId(),
      cpu: app
        .getAppMetrics()
        .map(({ pid, type, cpu }) => ({ pid, type, cumulativeCPUUsage: cpu.cumulativeCPUUsage })),
    };
    records.push(record);
    return record;
  };
  let remoteFrames = 0;
  let passed = false;
  const frame = (parameters: unknown) => {
    const parsed = z.object({ sessionId: z.number() }).parse(parameters);
    remoteFrames++;
    void platform.send("Page.screencastFrameAck", { sessionId: parsed.sessionId });
  };
  try {
    powerMonitor.emit("lock-screen");
    await window.loadURL("app://opensteer/");
    const started = z
      .object({ ok: z.boolean(), message: z.string().optional() })
      .parse(
        await window.webContents.executeJavaScript(
          `(async () => { try { await window.idleLifecycleSmoke.start(${JSON.stringify(origin)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(surfaceId)}); return { ok: true }; } catch (error) { return { ok: false, message: String(error.stack ?? error) }; } })()`,
        ),
      );
    assert(started.ok, started.message ?? "Lifecycle renderer setup failed.");
    const initiallyLocked = await snapshot("initially-locked");
    assert.equal(initiallyLocked.visible, false);
    assert.equal(initiallyLocked.subscriptions.length, 0);
    assert.equal(initiallyLocked.captures, 0);
    powerMonitor.emit("unlock-screen");
    const visible = await snapshot(
      "unlocked-visible",
      (s) =>
        subscriptions.size === 2 &&
        s.captures > 0 &&
        s.retains > s.releases &&
        s.openDisplays > 0 &&
        s.finderRetains > s.finderReleases,
    );
    assert.equal(visible.subscriptions.length, 2);
    assert(visible.captures > 0 && visible.retains > visible.releases);
    assert(visible.openDisplays > 0);
    assert(visible.finderRetains > visible.finderReleases);
    powerMonitor.emit("lock-screen");
    const locked = await snapshot(
      "simulated-lock",
      (s) =>
        !s.visible && subscriptions.size === 0 && s.retains === s.releases && s.openDisplays === 0,
    );
    assert.equal(locked.visible, false);
    assert.equal(locked.subscriptions.length, 0);
    assert.equal(locked.retains, locked.releases);
    // Hiding pauses every picture socket; the views keep their holds and last pictures.
    assert.equal(locked.openDisplays, 0);
    assert(locked.finderRetains > locked.finderReleases);
    // Longer than the real owner-view renewal period: no fake clock.
    await delay(31_000);
    const quiet = await snapshot("locked-past-renewal");
    assert.equal(quiet.captures, locked.captures);
    assert.equal(quiet.openDisplays, 0);
    assert.equal(quiet.renewals, locked.renewals);
    platform.on("Page.screencastFrame", frame);
    await platform.send("Page.startScreencast", { format: "jpeg", quality: 50 });
    const frameDeadline = performance.now() + 1_000;
    while (remoteFrames === 0 && performance.now() < frameDeadline) await delay(25);
    assert(
      remoteFrames > 0,
      "An independent remote/agent consumer got no frames while locally locked.",
    );
    await platform.send("Page.stopScreencast");
    powerMonitor.emit("unlock-screen");
    const unlocked = await snapshot(
      "unlock",
      (s) =>
        s.visible && s.captures > quiet.captures && s.openDisplays > 0 && subscriptions.size === 2,
    );
    assert(unlocked.visible && unlocked.captures > quiet.captures);
    assert(unlocked.openDisplays > 0);
    assert.equal(unlocked.subscriptions.length, 2);
    notifications.get("NSWorkspaceScreensDidSleepNotification")?.();
    powerMonitor.emit("unlock-screen");
    const asleep = await snapshot(
      "display-asleep-after-unlock",
      (s) => !s.visible && subscriptions.size === 0,
    );
    assert.equal(asleep.visible, false);
    assert.equal(asleep.subscriptions.length, 0);
    notifications.get("NSWorkspaceScreensDidWakeNotification")?.();
    const awake = await snapshot("display-wake", (s) => s.visible);
    assert(awake.visible);
    await window.webContents.executeJavaScript("window.idleLifecycleSmoke.documentVisible(false)");
    powerMonitor.emit("lock-screen");
    powerMonitor.emit("unlock-screen");
    const hidden = await snapshot(
      "hidden-document-after-unlock",
      (s) => !s.visible && subscriptions.size === 0 && s.openDisplays === 0,
    );
    assert.equal(hidden.visible, false);
    assert.equal(hidden.subscriptions.length, 0);
    assert.equal(hidden.openDisplays, 0);
    await window.webContents.executeJavaScript("window.idleLifecycleSmoke.documentVisible(true)");
    powerMonitor.emit("suspend");
    const suspended = await snapshot(
      "system-suspend",
      (s) => subscriptions.size === 0 && s.openDisplays === 0,
    );
    assert.equal(suspended.subscriptions.length, 0);
    assert.equal(suspended.openDisplays, 0);
    powerMonitor.emit("resume");
    const resumed = await snapshot("system-resume", (s) => s.visible && subscriptions.size === 2);
    assert(resumed.visible);
    assert.equal(resumed.subscriptions.length, 2);
    passed = true;
  } finally {
    await writeFile(
      path.join(directory, "electron-local-visibility.json"),
      JSON.stringify(
        {
          passed,
          simulatedNativeEvents: true,
          ownerViewHost: "MockHostClient fixture; real OwnerView and renewal timers",
          remoteFrames,
          records,
        },
        null,
        2,
      ) + "\n",
    );

    process.stdout.write("idle-lifecycle: assertions complete; disposing renderer\n");
    stopping = true;
    platform.off("Page.screencastFrame", frame);
    if (!window.isDestroyed()) {
      await window.webContents
        .executeJavaScript("window.idleLifecycleSmoke?.stop()")
        .catch(() => undefined);
      window.destroy();
    }
    process.stdout.write("idle-lifecycle: renderer disposed; closing transports\n");
    unregister();
    visibility.dispose();
    protocol.unhandle("app");
    // Renderer disposal can leave an HTTP keepalive or an upgrade in flight.
    // Stop admission before draining sockets, then close every fixture transport.
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    personalHost.dispose();
    server.closeAllConnections();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await serverClosed;
    process.stdout.write("idle-lifecycle: transports closed\n");
  }
}
