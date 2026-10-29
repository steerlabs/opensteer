import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { createBrowserSessionId } from "@opensteer/protocol";
import {
  acceptUpgrade,
  allClosed,
  connectionRefused,
  holdHttpConnections,
  holdRefusedConnection,
  holdUpgradedConnection,
  observeClose,
  settleWithin,
  webSocketUpgradeRequest,
  writeTransportCloseReport,
  type HeldConnection,
} from "@opensteer/shared/test-support/httpServer";
import WebSocket, { WebSocketServer } from "ws";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BrowserCdpRelay } from "./browser-cdp-relay.js";

const servers: WebSocketServer[] = [];
const heldHosts: Array<() => void> = [];
const developmentTransport = {
  deploymentShape: {
    defaultWorkspaceBacking: "local-directory",
    kind: "server" as const,
  },
  mode: "development",
} as const;
const productionCloudTransport = {
  deploymentShape: {
    defaultWorkspaceBacking: "portablefs",
    kind: "server" as const,
  },
  mode: "production",
} as const;
const productionPersonalTransport = {
  deploymentShape: {
    defaultWorkspaceBacking: "local-directory",
    kind: "personal" as const,
  },
  mode: "production",
} as const;

afterEach(async () => {
  for (const close of heldHosts.splice(0)) close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("BrowserCdpRelay", () => {
  it("serves a production Personal deployment over its co-located loopback Host", async () => {
    const upstream = await fakeCdpServer((request) => ({ echoed: request.method }));
    const relay = new BrowserCdpRelay({
      plan: { token: "run-capability-secret", url: upstream.url },
      transport: productionPersonalTransport,
    });
    const url = await relay.start();
    const sessionId = createBrowserSessionId();
    const client = new (await import("ws")).default(`${url}/${sessionId}`);
    try {
      await once(client, "open");
      client.send(JSON.stringify({ id: 7, method: "Browser.getVersion" }));
      const [raw] = (await once(client, "message")) as [Buffer];
      expect(JSON.parse(raw.toString())).toEqual({
        id: 7,
        result: { echoed: "Browser.getVersion" },
      });
      expect(upstream.authorization()).toBe("Bearer run-capability-secret");
      expect(upstream.paths()).toEqual([`/internal/v1/browser-cdp/${sessionId}`]);
      expect(new URL(url).hostname).toBe("127.0.0.1");
      expect(url).not.toContain("run-capability-secret");
    } finally {
      client.close();
      await relay.close();
    }
  });

  it("gives every client its own upstream bound to the session it names", async () => {
    const upstream = await fakeCdpServer((request) => ({ echoed: request.method }));
    const relay = new BrowserCdpRelay({
      plan: { token: "run-capability-secret", url: upstream.url },
      transport: developmentTransport,
    });
    const url = await relay.start();
    const first = createBrowserSessionId();
    const second = createBrowserSessionId();
    try {
      await requestCdp(`${url}/${first}`, 1, "Page.getFrameTree");
      await requestCdp(`${url}/${second}`, 2, "Runtime.enable");
      await requestCdp(`${url}/${first}`, 3, "Runtime.enable");
      expect(upstream.paths()).toEqual(
        [first, second, first].map((sessionId) => `/internal/v1/browser-cdp/${sessionId}`),
      );
      await expect(requestCdp(`${url}/not-a-session`, 4, "Runtime.enable")).rejects.toThrow();
      await expect(requestCdp(url, 5, "Runtime.enable")).rejects.toThrow();
    } finally {
      await relay.close();
    }
  });

  it("requires WSS only when production traffic leaves loopback", async () => {
    const upstream = await fakeCdpServer(() => ({}));
    expect(
      () =>
        new BrowserCdpRelay({
          plan: { token: "run-capability-secret", url: upstream.url },
          transport: productionCloudTransport,
        }),
    ).not.toThrow();
    expect(
      () =>
        new BrowserCdpRelay({
          plan: {
            token: "run-capability-secret",
            url: "http://host.example/internal/v1/browser-cdp",
          },
          transport: productionPersonalTransport,
        }),
    ).toThrow("must use WSS");
  });

  it("runs the provider-free Browser Harness code-generation workflow against standard CDP", async () => {
    const fills: FakeCdpRequest[] = [];
    const upstream = await fakeCdpServer((request) => {
      if (request.method === "Opensteer.fillLogin") {
        fills.push(request);
        return { status: request.params?.field === "password" ? "filled" : "no-field" };
      }
      if (request.method === "Target.getTargets") {
        return {
          rootTargetId: "target-1",
          targetInfos: [
            { targetId: "target-1", title: "Example", type: "page", url: "https://example.test/" },
          ],
        };
      }
      if (request.method === "Target.attachToTarget") return { sessionId: "cdp-session-1" };
      if (request.method === "Target.getTargetInfo") {
        return {
          targetInfo: {
            surfaceId: "surface-example",
            targetId: "target-1",
            title: "Example",
            type: "page",
            url: "https://example.test/",
          },
        };
      }
      if (request.method === "Runtime.evaluate") {
        return {
          result: {
            type: "object",
            value: { title: "Example", url: "https://example.test/", w: 1280 },
          },
        };
      }
      return {};
    });
    const script = fileURLToPath(
      new URL("../../browser-harness/browser-harness.mjs", import.meta.url),
    );
    const sessionId = createBrowserSessionId();
    const output = await runBrowserHarness(
      script,
      "console.log(JSON.stringify(await pageInfo()));\n",
      upstream.url.replace(/^http/u, "ws"),
      sessionId,
    );
    expect(upstream.paths()).toEqual([`/internal/v1/browser-cdp/${sessionId}`]);
    expect(JSON.parse(output.trim())).toEqual({
      surfaceId: "surface-example",
      targetId: "target-1",
      title: "Example",
      url: "https://example.test/",
      w: 1280,
    });
    await expect(
      runBrowserHarness(
        script,
        `console.log(await fillLogin("lgn_${"a".repeat(32)}", "password"))`,
        upstream.url.replace(/^http/u, "ws"),
        sessionId,
      ),
    ).resolves.toBe("filled\n");
    await expect(
      runBrowserHarness(
        script,
        `await fillLogin("lgn_${"a".repeat(32)}", "username")`,
        upstream.url.replace(/^http/u, "ws"),
        sessionId,
      ),
    ).rejects.toThrow("fillLogin no-field: Focus an editable field of the requested kind.");
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      sessionId: "cdp-session-1",
      params: { loginRef: `lgn_${"a".repeat(32)}`, field: "password" },
    });
    await expect(runBrowserHarnessVersion(script)).resolves.toBe("0.5.0-opensteer\n");
  });

  it("keeps every Browser Harness key helper on the page without native OS key codes", async () => {
    const requests: FakeCdpRequest[] = [];
    const upstream = await fakeCdpServer((request) => {
      requests.push(request);
      if (request.method === "Target.getTargets")
        return {
          rootTargetId: "target-1",
          targetInfos: [{ targetId: "target-1", type: "page", url: "https://example.test/" }],
        };
      if (request.method === "Target.attachToTarget") return { sessionId: "page-1" };
      if (request.method === "Runtime.evaluate") return { result: { value: true } };
      return {};
    });
    const script = fileURLToPath(
      new URL("../../browser-harness/browser-harness.mjs", import.meta.url),
    );
    await runBrowserHarness(
      script,
      `
      for (const key of ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Backspace", "Enter", "Escape", "Tab"]) await pressKey(key);
      await pressKey("q");
      await pressKey("l", { modifiers: 4 });
      await pressKey("ArrowLeft", { modifiers: 8 });
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.type("aé");
      await typeText("typed");
    `,
      upstream.url.replace(/^http/u, "ws"),
      createBrowserSessionId(),
    );
    const keys = requests.filter((request) => request.method === "Input.dispatchKeyEvent");
    // Down and up for each key, plus down and up for each held modifier.
    expect(keys).toHaveLength(32);
    for (const event of keys)
      expect(event.params, JSON.stringify(event.params)).not.toHaveProperty("nativeVirtualKeyCode");
    expect(keys.find((event) => event.params?.key === "Enter")?.params).toMatchObject({
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
      type: "keyDown",
    });
    // Printable keys carry their text on keyDown, as in Playwright.
    expect(keys.filter((event) => event.params?.type === "char")).toEqual([]);
    expect(keys.find((event) => event.params?.key === "q")?.params).toMatchObject({
      text: "q",
      modifiers: 0,
      type: "keyDown",
    });
    expect(keys.find((event) => event.params?.key === "l")?.params).toMatchObject({
      modifiers: 4,
      type: "rawKeyDown",
    });
    expect(
      keys.find((event) => event.params?.key === "Tab" && event.params?.modifiers === 8)?.params,
    ).toMatchObject({ code: "Tab", type: "rawKeyDown" });
    expect(requests.filter((request) => request.method === "Input.insertText")).toEqual([
      expect.objectContaining({ params: { text: "é" } }),
      expect.objectContaining({ params: { text: "typed" } }),
    ]);
  });

  it("sends Meta editing commands from Browser Harness while preserving explicit overrides", async () => {
    const requests: FakeCdpRequest[] = [];
    const upstream = await fakeCdpServer((request) => {
      requests.push(request);
      if (request.method === "Target.getTargets")
        return {
          rootTargetId: "target-1",
          targetInfos: [{ targetId: "target-1", type: "page", url: "https://example.test/" }],
        };
      if (request.method === "Target.attachToTarget") return { sessionId: "page-1" };
      // macOS Chromium edits through commands; other platforms use their own keys.
      if (request.method === "Browser.getVersion")
        return {
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        };
      return {};
    });
    const script = fileURLToPath(
      new URL("../../browser-harness/browser-harness.mjs", import.meta.url),
    );
    await runBrowserHarness(
      script,
      `
      await pressKey("a", { modifiers: 4 });
      await pressKey("c", { modifiers: 4 });
      await pressKey("x", { modifiers: 4 });
      await pressKey("v", { modifiers: 4 });
      await pressKey("z", { modifiers: 4 });
      await pressKey("z", { modifiers: 12 });
      await pressKey("ArrowRight", { modifiers: 12 });
      await pressKey("Backspace", { modifiers: 4 });
      await pressKey("c", { modifiers: 4, commands: [] });
      await pressKey("c", { modifiers: 4, commands: ["deleteBackward"] });
    `,
      upstream.url.replace(/^http/u, "ws"),
      createBrowserSessionId(),
    );
    const keys = requests.filter((request) => request.method === "Input.dispatchKeyEvent");
    const modifierKeys = ["Meta", "Shift"];
    const downs = keys.filter(
      (event) => event.params?.type === "keyDown" || event.params?.type === "rawKeyDown",
    );
    for (const event of downs.filter((event) => modifierKeys.includes(String(event.params?.key))))
      expect(event.params).not.toHaveProperty("commands");
    expect(
      downs
        .filter((event) => !modifierKeys.includes(String(event.params?.key)))
        .map((event) => event.params?.commands),
    ).toEqual([
      ["selectAll"],
      ["copy"],
      ["cut"],
      ["paste"],
      ["undo"],
      ["redo"],
      ["moveToRightEndOfLineAndModifySelection"],
      ["deleteToBeginningOfLine"],
      [],
      ["deleteBackward"],
    ]);
    for (const event of keys.filter((event) => event.params?.type === "keyUp"))
      expect(event.params).not.toHaveProperty("commands");
    for (const event of keys) expect(event.params).not.toHaveProperty("nativeVirtualKeyCode");
  });

  it("requires an explicit target for multi-tab actions while keeping discovery available", async () => {
    const requests: FakeCdpRequest[] = [];
    const upstream = await fakeCdpServer((request) => {
      requests.push(request);
      if (request.method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              targetId: "viewed-tab",
              surfaceId: "human-surface",
              title: "Human",
              type: "page",
              url: "https://human.test",
            },
            { targetId: "agent-tab", title: "Agent", type: "page", url: "https://agent.test" },
          ],
        };
      }
      if (request.method === "Target.attachToTarget") return { sessionId: "agent-cdp" };
      if (request.method === "Runtime.evaluate") return { result: { value: "agent-page" } };
      return {};
    });
    const script = fileURLToPath(
      new URL("../../browser-harness/browser-harness.mjs", import.meta.url),
    );
    const sessionId = createBrowserSessionId();
    const url = upstream.url.replace(/^http/u, "ws");
    const listed = await runBrowserHarness(
      script,
      "console.log(JSON.stringify(await listTabs()))",
      url,
      sessionId,
    );
    expect(JSON.parse(listed)).toHaveLength(2);
    expect(JSON.parse(listed)[0]).toMatchObject({
      targetId: "viewed-tab",
      surfaceId: "human-surface",
    });
    await expect(runBrowserHarness(script, "await pageInfo()", url, sessionId)).rejects.toThrow(
      "Choose a tab",
    );
    expect(requests.filter((request) => request.method === "Target.attachToTarget")).toEqual([]);
    await expect(
      runBrowserHarness(
        script,
        "console.log(await js('location.href'))",
        url,
        sessionId,
        "agent-tab",
      ),
    ).resolves.toBe("agent-page\n");
    expect(
      requests.find((request) => request.method === "Target.attachToTarget")?.params,
    ).toMatchObject({ targetId: "agent-tab" });
    expect(requests.some((request) => request.method === "Target.activateTarget")).toBe(false);
  });

  it("fails on a closed explicit tab without choosing or creating another", async () => {
    const requests: FakeCdpRequest[] = [];
    const upstream = await fakeCdpServer((request) => {
      requests.push(request);
      if (request.method === "Target.getTargets") {
        return {
          targetInfos: [
            { targetId: "other-tab", title: "Other", type: "page", url: "https://other.test" },
          ],
        };
      }
      return {};
    });
    const script = fileURLToPath(
      new URL("../../browser-harness/browser-harness.mjs", import.meta.url),
    );
    await expect(
      runBrowserHarness(
        script,
        "await ensureRealTab()",
        upstream.url.replace(/^http/u, "ws"),
        createBrowserSessionId(),
        "closed-tab",
      ),
    ).rejects.toThrow("closed-tab");
    expect(
      requests.some(
        (request) =>
          request.method === "Target.createTarget" || request.method === "Runtime.evaluate",
      ),
    ).toBe(false);
  });

  it("does not replace a closed initial tab with a different sole page", async () => {
    const requests: FakeCdpRequest[] = [];
    const upstream = await fakeCdpServer((request) => {
      requests.push(request);
      if (request.method === "Target.getTargets")
        return {
          rootTargetId: "initial-tab",
          targetInfos: [
            {
              targetId: "replacement-tab",
              title: "Replacement",
              type: "page",
              url: "https://other.test",
            },
          ],
        };
      return {};
    });
    const script = fileURLToPath(
      new URL("../../browser-harness/browser-harness.mjs", import.meta.url),
    );
    await expect(
      runBrowserHarness(
        script,
        "await pageInfo()",
        upstream.url.replace(/^http/u, "ws"),
        createBrowserSessionId(),
      ),
    ).rejects.toThrow("initial tab is closed");
    expect(requests.some((request) => request.method === "Target.attachToTarget")).toBe(false);
  });
});

/*
 * Ways a relay can outlive the Run it served:
 * - an idle, half-sent or never-used HTTP connection keeps its listener's
 *   close waiting;
 * - a client that never answers a WebSocket close keeps it waiting, even
 *   once its pair has left the relay's set after the Host refused it;
 * - the Host connection of a client is still opening, or never answers a
 *   close, and is left behind under the ended Run's token;
 * - a second close returns while the first is still ending connections;
 * - a warm engine going idle leaves its connections half-closed, or a new
 *   one opens before the next Run;
 * - a client is cut off at the Run's end without being told why;
 * - a refused upgrade is answered and left for its peer to end, and a peer
 *   that never does keeps the close waiting;
 * - a close while the relay is starting leaves it listening.
 */
describe("BrowserCdpRelay shutdown", () => {
  const cases: Record<string, unknown>[] = [];

  afterAll(async () => {
    await writeTransportCloseReport("browser-cdp-relay", cases);
  });

  it("ends both sides of every connection at once when it closes, however far each got", async () => {
    const opened = createBrowserSessionId();
    const opening = createBrowserSessionId();
    const refused = createBrowserSessionId();
    const host = await heldCdpHost((sessionId) =>
      sessionId === opening ? "never answers" : sessionId === refused ? "refuses" : "holds",
    );
    const relay = new BrowserCdpRelay({
      plan: { token: "run-capability-secret", url: host.url },
      transport: developmentTransport,
    });
    const url = new URL(await relay.start());
    const port = Number(url.port);
    // A client that never answers anything, whose Host connection is open.
    const silent = await holdUpgradedConnection(port, `${url.pathname}/${opened}`);
    // A client whose Host connection is still waiting for the Host.
    const waiting = new WebSocket(`${url.href}/${opening}`);
    await once(waiting, "open");
    const waitingClosed = closeOf(waiting);
    // A client the Host refused: the relay tells it why, and it never answers.
    const turnedAway = await holdUpgradedConnection(port, `${url.pathname}/${refused}`);
    await waitUntil(() => turnedAway.closeFrameReceived());
    await waitUntil(() => host.sockets.length === 3 && host.sockets[0]!.upgraded);
    const held = await holdHttpConnections(port);
    const hostConnectionsBefore = host.sockets.length;

    const settled: string[] = [];
    const first = relay.close().then(() => void settled.push("first"));
    const second = relay.close().then(() => void settled.push("second"));
    const [firstClose, secondClose] = await Promise.all([
      observeClose(first),
      observeClose(second),
    ]);
    const clients = [silent, turnedAway, ...held];
    const everyClientClosed = await allClosed(clients);
    const waitingCode = await observeClose(waitingClosed).then(() => waitingClosed);
    const everyHostConnectionClosed = await allClosed(host.sockets);
    const listenerRefused = await connectionRefused(port);
    cases.push({
      name: "close ends every pair, open, opening or already closing",
      firstClose,
      secondClose,
      settledOrder: settled,
      clients: clients.map((connection) => connection.report()),
      waitingClientClose: waitingCode,
      hostConnections: host.sockets.map((socket) => socket.report()),
      hostConnectionsOpenedAfterClose: host.sockets.length - hostConnectionsBefore,
      listenerRefused,
    });

    expect(firstClose.settled).toBe("closed");
    expect(secondClose.settled).toBe("closed");
    expect(settled).toEqual(["first", "second"]);
    expect(everyClientClosed).toBe(true);
    expect(waitingCode).toEqual({ code: 1001, reason: "Run ended" });
    expect(everyHostConnectionClosed).toBe(true);
    expect(host.sockets.length).toBe(hostConnectionsBefore);
    expect(listenerRefused).toBe(true);
  }, 30_000);

  it("cuts both sides of a connection at once when a warm engine goes idle, and opens none until it resumes", async () => {
    const host = await heldCdpHost(() => "holds");
    const relay = new BrowserCdpRelay({
      plan: { token: "run-capability-secret", url: host.url },
      transport: developmentTransport,
    });
    const url = new URL(await relay.start());
    const port = Number(url.port);
    try {
      const silent = await holdUpgradedConnection(
        port,
        `${url.pathname}/${createBrowserSessionId()}`,
      );
      const healthy = new WebSocket(`${url.href}/${createBrowserSessionId()}`);
      await once(healthy, "open");
      const healthyClosed = closeOf(healthy);
      await waitUntil(
        () => host.sockets.length === 2 && host.sockets.every((socket) => socket.upgraded),
      );

      relay.suspend();
      const clientClosed = await allClosed([silent]);
      const hostClosed = await allClosed(host.sockets);
      const healthyClose = await healthyClosed;
      const refusedWhileIdle = await rejectedUpgradeStatus(
        `${url.href}/${createBrowserSessionId()}`,
      );
      const hostConnectionsWhileIdle = host.sockets.length;
      relay.resume();
      const next = new WebSocket(`${url.href}/${createBrowserSessionId()}`);
      await once(next, "open");
      await waitUntil(() => host.sockets.length === 3);
      next.terminate();
      cases.push({
        name: "suspend cuts both sides and admits nothing until resume",
        client: silent.report(),
        clientClosed,
        hostClosed,
        healthyClientClose: healthyClose,
        refusedWhileIdle,
        hostConnectionsWhileIdle,
        hostConnections: host.sockets.map((socket) => socket.report()),
      });

      expect(clientClosed).toBe(true);
      expect(hostClosed).toBe(true);
      expect(healthyClose).toEqual({ code: 1001, reason: "Run ended" });
      expect(refusedWhileIdle).toBe(403);
      expect(hostConnectionsWhileIdle).toBe(2);
    } finally {
      await relay.close();
    }
  }, 30_000);

  it("refuses an upgrade it will not serve, idle or not, without waiting on the peer that sent it", async () => {
    const relay = new BrowserCdpRelay({
      plan: { token: "run-capability-secret", url: "http://127.0.0.1:9/internal/v1/browser-cdp" },
      transport: developmentTransport,
    });
    const url = new URL(await relay.start());
    const port = Number(url.port);
    const session = () => `${url.pathname}/${createBrowserSessionId()}`;
    const refused = [
      {
        name: "unknown path",
        ...(await holdRefusedConnection(port, webSocketUpgradeRequest(port, "/devtools/other"))),
      },
      {
        name: "malformed handshake",
        ...(await holdRefusedConnection(
          port,
          webSocketUpgradeRequest(port, session(), {}, { key: false }),
        )),
      },
    ];
    relay.suspend();
    refused.push({
      name: "idle between Runs",
      ...(await holdRefusedConnection(port, webSocketUpgradeRequest(port, session()))),
    });
    try {
      const closed = await observeClose(relay.close());
      const peersStillHolding = refused.every(({ connection }) => !connection.isClosed());
      cases.push({
        name: "refused upgrades whose peers never end the connection",
        refusals: refused.map(({ connection, name, status }) => ({
          name,
          status,
          ...connection.report(),
        })),
        close: closed,
        peersStillHolding,
      });

      expect(refused.map(({ status }) => status)).toEqual([
        "HTTP/1.1 404 Not Found",
        "HTTP/1.1 400 Bad Request",
        "HTTP/1.1 403 Forbidden",
      ]);
      expect(closed.settled).toBe("closed");
      expect(peersStillHolding).toBe(true);
    } finally {
      for (const { connection } of refused) connection.destroy();
    }
  }, 30_000);

  it("stops listening when it is closed while still starting", async () => {
    const relay = new BrowserCdpRelay({
      plan: { token: "run-capability-secret", url: "http://127.0.0.1:9/internal/v1/browser-cdp" },
      transport: developmentTransport,
    });
    const starting = settleWithin(relay.start());
    const closing = observeClose(relay.close());
    const [started, observed] = await Promise.all([starting, closing]);
    const listenerRefused =
      started.settled !== "fulfilled" ||
      (await connectionRefused(Number(new URL(started.value).port)));
    cases.push({ name: "close during startup", started, close: observed, listenerRefused });

    expect(started.settled).not.toBe("still waiting");
    expect(observed.settled).toBe("closed");
    expect(listenerRefused).toBe(true);
  }, 30_000);
});

interface HostSocket extends Pick<HeldConnection, "closed" | "isClosed"> {
  readonly upgraded: boolean;
  report(): Record<string, unknown>;
}

/**
 * A Host that answers the relay's connections the way the session's
 * behaviour says and then never answers a close frame. A connection closes
 * here only once the relay ends its side.
 */
async function heldCdpHost(
  behaviour: (sessionId: string) => "holds" | "never answers" | "refuses",
): Promise<{ readonly sockets: HostSocket[]; readonly url: string }> {
  const sockets: HostSocket[] = [];
  const accepted = new Set<Socket>();
  const server = createServer((request, response) => {
    if (
      ignoreForeignTestRequest(request, response, (path) =>
        path.startsWith("/internal/v1/browser-cdp/"),
      )
    )
      return;
    expect.fail(`Expected a WebSocket upgrade on ${request.url}`);
  });
  server.on("upgrade", (request, transport) => {
    expect(request.url).toMatch(/^\/internal\/v1\/browser-cdp\//u);
    const socket = transport as Socket;
    // The raw fixture ended both halves when its client ended; HTTP upgrades default to half-open.
    socket.allowHalfOpen = false;
    accepted.add(socket);
    const started = performance.now();
    const events: { afterMs: number; event: string }[] = [];
    const note = (event: string) =>
      events.push({ afterMs: Math.round(performance.now() - started), event });
    const path = request.url ?? "";
    let upgraded = false;
    let closed = false;
    note("accepted");
    socket.on("data", (chunk: Buffer) => note(`received ${chunk.byteLength} bytes`));
    socket.on("end", () => note("ended by relay"));
    socket.on("error", (error: NodeJS.ErrnoException) => note(`error ${error.code ?? ""}`));
    const closedPromise = new Promise<void>((resolve) =>
      socket.once("close", () => {
        closed = true;
        accepted.delete(socket);
        note("closed");
        resolve();
      }),
    );
    sockets.push({
      closed: closedPromise,
      isClosed: () => closed,
      get upgraded() {
        return upgraded;
      },
      report: () => ({ path, upgraded, closed, events: [...events] }),
    });
    const answer = behaviour(path.split("/").at(-1) ?? "");
    note(`upgrade requested: ${answer}`);
    if (answer === "never answers") return;
    if (answer === "refuses") {
      socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    upgraded = acceptUpgrade(
      socket,
      `sec-websocket-key: ${request.headers["sec-websocket-key"]}\r\n`,
    );
    note("upgraded");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await probeTestServer(server);
  heldHosts.push(() => {
    for (const socket of accepted) socket.destroy();
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake Host did not bind");
  return { sockets, url: `http://127.0.0.1:${address.port}/internal/v1/browser-cdp` };
}

function closeOf(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

function rejectedUpgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    client.once("open", () => {
      client.terminate();
      reject(new Error("The relay accepted a connection it should have refused."));
    });
    client.once("error", reject);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for relay test state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface FakeCdpRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

async function fakeCdpServer(resultFor: (request: FakeCdpRequest) => unknown): Promise<{
  readonly url: string;
  authorization(): string | undefined;
  paths(): readonly string[];
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake CDP server did not bind");
  let authorization: string | undefined;
  const paths: string[] = [];
  server.on("connection", (socket, request) => {
    paths.push(request.url ?? "");
    authorization = request.headers.authorization;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as FakeCdpRequest;
      socket.send(JSON.stringify({ id: message.id, result: resultFor(message) }));
    });
  });
  return {
    authorization: () => authorization,
    paths: () => [...paths],
    url: `http://127.0.0.1:${address.port}/internal/v1/browser-cdp`,
  };
}

async function requestCdp(url: string, id: number, method: string): Promise<void> {
  const client = new (await import("ws")).default(url);
  await once(client, "open");
  client.send(JSON.stringify({ id, method }));
  await once(client, "message");
  client.close();
  await once(client, "close");
}

function runBrowserHarness(
  script: string,
  code: string,
  cdpUrl: string,
  sessionId: string,
  targetId?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      script,
      ["--session", sessionId, ...(targetId ? ["--tab", targetId] : [])],
      {
        env: { ...process.env, OPENSTEER_BROWSER_CDP_WS: cdpUrl },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (codeValue) => {
      if (codeValue === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else
        reject(new Error(Buffer.concat(stderr).toString("utf8") || `harness exited ${codeValue}`));
    });
    child.stdin.end(code);
  });
}

function runBrowserHarnessVersion(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, ["--version"], {
      env: { ...process.env, OPENSTEER_BROWSER_CDP_WS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (codeValue) => {
      if (codeValue === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else
        reject(new Error(Buffer.concat(stderr).toString("utf8") || `harness exited ${codeValue}`));
    });
  });
}
