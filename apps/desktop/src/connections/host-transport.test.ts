import type { DesktopHostWebSocketEvent } from "@opensteer/protocol/desktop";
import { createId, type DeploymentId, type HostInstanceId } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { describe, expect, it, vi } from "vitest";
import {
  DeploymentCatalogSchema,
  DeploymentConnectionSchema,
  type DeploymentCatalog,
  type HostCredentialProvider,
  type HostNetwork,
  type HostNetworkRequest,
  type HostNetworkSocketEvents,
} from "@opensteer/client/connections";
import { testDiscoveryEnvelope } from "@opensteer/client/test-support";
import type { HostSessionRecovery } from "@opensteer/client/auth";
import { DesktopAccessProjection } from "./access-projection.js";
import { DesktopHostTransport } from "./host-transport.js";
import type {
  PersonalHostRuntimeRecord,
  PersonalHostRuntimeSource,
} from "../supervisor/personal-host-runtime.js";
import { testPersonalHostRuntime } from "../supervisor/personal-host-runtime-test-support.js";
import { DesktopLocalRunnerTargetResolver } from "../supervisor/local-runner-authority.js";

describe("DesktopHostTransport", () => {
  it.each([false, true])(
    "bounds silence while buffering a slow desktop response; stall: %s",
    async (stall) => {
      vi.useFakeTimers();
      try {
        const selected = deployment("Home", "https://home.connect.opensteer.test");
        let body!: ReadableStreamDefaultController<Uint8Array>;
        let signal: AbortSignal | undefined;
        const transport = desktopHostTransport({
          catalog: catalogStore([selected], selected.authority.document.deploymentId),
          network: {
            openWebSocket: () => socket(),
            request: async (input) => {
              signal = input.signal;
              return new Response(
                new ReadableStream({
                  start(controller) {
                    body = controller;
                  },
                }),
              );
            },
          },
        });
        const pending = transport.request({
          headers: {},
          method: "GET",
          path: "/v1/rpc/auth.config",
        });
        const outcome = pending.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        for (let index = 0; index < 3; index++) {
          await vi.advanceTimersByTimeAsync(19_000);
          body.enqueue(new TextEncoder().encode(" "));
          await vi.advanceTimersByTimeAsync(0);
        }
        if (stall) {
          await vi.advanceTimersByTimeAsync(20_000);
          expect(await outcome).toMatchObject({ code: "timed-out", retryable: true });
          expect(signal?.aborted).toBe(true);
        } else {
          body.close();
          await expect(pending).resolves.toMatchObject({ body: "   ", status: 200 });
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("F5 correlates surfaces privately across sockets without persisting raw identifiers", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const log = vi.fn();
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      log,
      network: { openWebSocket: () => socket(), request: async () => new Response("{}") },
    });
    const sessionId = "bsn_00000000-0000-4000-8000-000000000001";
    const raw = "https://private.test/?access_token=PRIVATE-VALUE";
    try {
      const first = await transport.openWebSocket(
        7,
        { path: `/v1/browser-sessions/${sessionId}/connect` },
        vi.fn(),
      );
      const second = await transport.openWebSocket(
        7,
        { path: `/v1/browser-sessions/${sessionId}/connect?mode=watch` },
        vi.fn(),
      );
      for (const { connectionId } of [first, second])
        transport.sendWebSocket(7, {
          connectionId,
          type: "text",
          data: JSON.stringify({ type: "stream.subscribe", surfaceId: raw }),
        });
      const records = log.mock.calls
        .filter(([event]) => event === "desktop.host-socket.target")
        .map(([, fields]) => fields as Record<string, string>);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private\.test|access_token|PRIVATE-VALUE/,
      );
      expect(records).toHaveLength(2);
      expect(records[0]!.surfaceCorrelationId).toMatch(/^surface_[a-f0-9]{64}$/);
      expect(records[0]!.surfaceCorrelationId).toBe(records[1]!.surfaceCorrelationId);
      transport.sendWebSocket(7, {
        connectionId: first.connectionId,
        type: "text",
        data: JSON.stringify({ type: "stream.subscribe", surfaceId: "different" }),
      });
      const latest = log.mock.calls.at(-1)![1] as Record<string, string>;
      expect(latest.surfaceCorrelationId).not.toBe(records[0]!.surfaceCorrelationId);
      transport.closeAllSockets();
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private\.test|access_token|PRIVATE-VALUE/,
      );
    } finally {
      transport.closeAllSockets();
    }
  });
  it("persists realtime schema failure metadata before forwarding without payloads or credentials", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const log = vi.fn();
    let events: HostNetworkSocketEvents | undefined;
    const received = vi.fn();
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      log,
      network: {
        openWebSocket: (_input, value) => {
          events = value;
          return socket();
        },
        request: async () => new Response("{}"),
      },
    });
    await transport.openWebSocket(7, { path: "/v1/realtime" }, received);
    try {
      const data = JSON.stringify({
        type: "host.events",
        events: [{ type: "run.started", data: { status: "os_secret_PRIVATE-FRAME" } }],
      });
      events!.message(data);
      expect(log).toHaveBeenCalledWith(
        "desktop.host-socket.frame-unrecognized",
        expect.objectContaining({
          envelopeType: "host.events",
          apiEpoch: hostApiVersion,
          bytes: new TextEncoder().encode(data).byteLength,
          issuePaths: expect.stringContaining("events.[]."),
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/os_secret|PRIVATE-FRAME/);
      expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: "text", data }));
    } finally {
      transport.closeAllSockets();
    }
  });
  it("correlates watch socket lifecycle without logging its IPC capability, query or arbitrary reason", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const log = vi.fn();
    let events: HostNetworkSocketEvents | undefined;
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      log,
      network: {
        openWebSocket: (_input, value) => {
          events = value;
          return socket();
        },
        request: async () => new Response("{}"),
      },
    });
    const sessionId = "bsn_00000000-0000-4000-8000-000000000001";
    const { connectionId } = await transport.openWebSocket(
      7,
      {
        path: `/v1/browser-sessions/${sessionId}/connect?mode=watch&token=PRIVATE-TICKET&surfaceId=PRIVATE-SURFACE`,
      },
      vi.fn(),
    );
    events!.open();
    transport.sendWebSocket(7, {
      connectionId,
      type: "text",
      data: JSON.stringify({ type: "stream.subscribe", surfaceId: "surface-diagnostics" }),
    });
    events!.close(4002, "PRIVATE-REASON os_secret_DO_NOT_LOG");
    expect(log.mock.calls.map(([event]) => event)).toEqual([
      "desktop.host-socket.opened",
      "desktop.host-socket.target",
      "desktop.host-socket.closed",
    ]);
    const opened = log.mock.calls[0]![1];
    transport.closeAllSockets();
    const closed = log.mock.calls[2]![1];
    expect(opened).toMatchObject({
      kind: "browser",
      mode: "watch",
      sessionId,
      socketId: expect.any(String),
    });
    expect(closed).toMatchObject({
      ...opened,
      surfaceCorrelationId: expect.stringMatching(/^surface_[a-f0-9]{64}$/),
      code: 4002,
      reason: "other",
      initiator: "network",
      lifetimeMs: expect.any(Number),
    });
    expect(opened.socketId).not.toBe(connectionId);
    expect(log.mock.calls[1]).toEqual([
      "desktop.host-socket.target",
      { ...opened, surfaceCorrelationId: closed.surfaceCorrelationId },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /PRIVATE-|os_secret|desktop_host_socket_|surface-diagnostics/,
    );
  });
  it.each([
    { initiator: "renderer", code: undefined, expected: 1_005, reason: "", networkCode: undefined },
    {
      initiator: "renderer",
      code: 4_002,
      expected: 4_002,
      reason: "Invalid frame",
      networkCode: 4_002,
    },
    {
      initiator: "deployment-changed",
      expected: 4_001,
      reason: "Deployment changed",
      networkCode: 4_001,
    },
    { initiator: "owner-gone", expected: 1_000, reason: "Client closed", networkCode: 1_000 },
    { initiator: "network", expected: 1_001, reason: "Host stopped", networkCode: undefined },
  ])(
    "delivers one terminal close for $initiator ($expected)",
    async ({ initiator, code, expected, reason, networkCode }) => {
      const selected = deployment("Home", "https://home.connect.opensteer.test");
      const networkSocket = socket();
      let events: HostNetworkSocketEvents | null = null;
      const received: DesktopHostWebSocketEvent[] = [];
      const log = vi.fn();
      const transport = desktopHostTransport({
        catalog: catalogStore([selected], selected.authority.document.deploymentId),
        log,
        network: {
          openWebSocket: vi.fn((_input, value) => {
            events = value;
            return networkSocket;
          }),
          request: vi.fn(async () => new Response("{}")),
        },
      });
      const { connectionId } = await transport.openWebSocket(7, { path: "/v1/realtime" }, (event) =>
        received.push(event),
      );
      events!.open();
      received.length = 0;
      if (initiator === "renderer")
        transport.closeWebSocket(7, {
          connectionId,
          ...(code === undefined ? {} : { code }),
          ...(reason ? { reason } : {}),
        });
      else if (initiator === "deployment-changed") transport.closeAllSockets();
      else if (initiator === "owner-gone") transport.closeSocketsForOwner(7);
      else events!.close(expected, reason);
      expect(received).toEqual([{ connectionId, type: "close", code: expected, reason }]);
      events!.open();
      events!.message("late");
      events!.error("late");
      events!.close(1_006, "late");
      transport.closeAllSockets();
      transport.closeSocketsForOwner(7);
      expect(received).toHaveLength(1);
      if (initiator === "network") expect(networkSocket.close).not.toHaveBeenCalled();
      else
        expect(networkSocket.close).toHaveBeenCalledExactlyOnceWith(
          networkCode,
          initiator === "renderer" && !reason ? undefined : reason,
        );
      expect(() =>
        transport.sendWebSocket(7, { connectionId, type: "text", data: "late" }),
      ).toThrow("belongs to another owner");
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[0]).toEqual([
        "desktop.host-socket.opened",
        {
          kind: "realtime",
          socketId: expect.stringMatching(/^host_socket_/),
        },
      ]);
      expect(log.mock.calls[1]).toEqual([
        "desktop.host-socket.closed",
        {
          kind: "realtime",
          socketId: log.mock.calls[0]![1].socketId,
          code: expected,
          reason,
          initiator,
          lifetimeMs: expect.any(Number),
        },
      ]);
      expect(log.mock.calls[1]![1].lifetimeMs).toBeGreaterThanOrEqual(0);
    },
  );

  it.each(["before-bind", "after-bind"])(
    "ends a socket when generation moves %s during open",
    async (timing) => {
      const selected = deployment("Home", "https://home.connect.opensteer.test");
      const networkSocket = socket();
      let events: HostNetworkSocketEvents | null = null;
      const transport = desktopHostTransport({
        catalog: catalogStore([selected], selected.authority.document.deploymentId),
        network: {
          openWebSocket: vi.fn((_input, value) => {
            events = value;
            return networkSocket;
          }),
          request: vi.fn(async () => new Response("{}")),
        },
      });
      const openSocket = transport.openSocket.bind(transport);
      vi.spyOn(transport, "openSocket").mockImplementation(async (input, bind) => {
        if (timing === "before-bind") transport.closeAllSockets();
        const network = await openSocket(input, bind);
        if (timing === "after-bind") transport.closeAllSockets();
        return network;
      });
      const received = vi.fn();
      const { connectionId } = await transport.openWebSocket(7, { path: "/v1/realtime" }, received);
      expect(received).toHaveBeenCalledExactlyOnceWith({
        connectionId,
        type: "close",
        code: 4_001,
        reason: "Deployment changed",
      });
      events!.open();
      events!.message("late");
      events!.error("late");
      events!.close(1_006, "late");
      expect(received).toHaveBeenCalledOnce();
      expect(networkSocket.close).toHaveBeenCalledExactlyOnceWith(4_001, "Deployment changed");
      expect(() => transport.closeWebSocket(7, { connectionId })).toThrow(
        "belongs to another owner",
      );
    },
  );

  it("rejects an open failure without emitting a socket event", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const received = vi.fn();
    const log = vi.fn();
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      log,
      network: {
        openWebSocket: vi.fn(() => {
          throw new Error("Network unavailable");
        }),
        request: vi.fn(async () => new Response("{}")),
      },
    });
    await expect(transport.openWebSocket(7, { path: "/v1/realtime" }, received)).rejects.toThrow(
      "Network unavailable",
    );
    transport.closeAllSockets();
    expect(received).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("ends an unavailable consumer even when terminal delivery and logging throw", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const networkSocket = socket();
    let events: HostNetworkSocketEvents | null = null;
    const received = vi.fn((_event: DesktopHostWebSocketEvent) => {
      throw new Error("Renderer destroyed");
    });
    const log = vi.fn(() => {
      throw new Error("Logger unavailable");
    });
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      log,
      network: {
        openWebSocket: vi.fn((_input, value) => {
          events = value;
          return networkSocket;
        }),
        request: vi.fn(async () => new Response("{}")),
      },
    });
    const { connectionId } = await transport.openWebSocket(7, { path: "/v1/realtime" }, received);
    expect(() => events!.open()).not.toThrow();
    expect(received.mock.calls.map(([event]) => event.type)).toEqual(["open", "error", "close"]);
    expect(networkSocket.close).toHaveBeenCalledExactlyOnceWith(4_011, "Client unavailable");
    events!.close(1_006, "late");
    expect(received).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(
      "desktop.host-socket.closed",
      expect.objectContaining({ initiator: "undeliverable", code: 4_011 }),
    );
    expect(() => transport.closeWebSocket(7, { connectionId })).toThrow("belongs to another owner");
  });

  it.each([
    ["/v1/browser-sessions/bsn_00000000-0000-4000-8000-000000000001/connect?mode=watch", "browser"],
    ["/v1/computer-use/sessions/cus_display/display", "display"],
    ["/v1/computer-use/views/cuv_display/2/display", "display"],
    ["/v1/other", "other"],
  ])("logs bounded closure diagnostics for %s", async (path, kind) => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    let events: HostNetworkSocketEvents | null = null;
    const log = vi.fn();
    const received = vi.fn();
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      log,
      network: {
        openWebSocket: vi.fn((_input, value) => {
          events = value;
          return socket();
        }),
        request: vi.fn(async () => new Response("{}")),
      },
    });
    await transport.openWebSocket(7, { path }, received);
    events!.close(1_000, "stop\n" + "😀".repeat(1_000));
    const reason = "stop " + "😀".repeat(248);
    expect(log).toHaveBeenCalledExactlyOnceWith("desktop.host-socket.closed", {
      kind,
      socketId: expect.stringMatching(/^host_socket_/),
      ...(kind === "browser"
        ? { mode: "watch", sessionId: "bsn_00000000-0000-4000-8000-000000000001" }
        : {}),
      code: 1_000,
      reason: "other",
      initiator: "network",
      lifetimeMs: expect.any(Number),
    });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: "close", reason }));
  });

  it("observes per-socket admission and synchronous explicit/owner/all closure", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const sockets: HostNetworkSocketEvents[] = [];
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      network: {
        openWebSocket: vi.fn((_input, events) => {
          sockets.push(events);
          return socket();
        }),
        request: vi.fn(async () => new Response("{}")),
      },
    });
    const observed: unknown[] = [];
    transport.observeBrowserSockets((event) => observed.push(event));
    transport.observeBrowserSockets((event) => {
      if (event.type === "closed") throw new Error("Observer unavailable");
    });
    const sessionId = "bsn_00000000-0000-4000-8000-000000000001";
    const path = `/v1/browser-sessions/${sessionId}/connect`;
    const first = await transport.openWebSocket(7, { path }, vi.fn());
    const second = await transport.openWebSocket(7, { path }, vi.fn());
    await transport.openWebSocket(8, { path: `${path}?mode=watch` }, vi.fn());
    const snapshot = JSON.stringify({
      access: "full-control",
      dialog: null,
      sessionId,
      state: "ready",
      surfaces: [
        { active: true, id: "page-navigation", title: "Page", url: "https://example.com/" },
      ],
      type: "browser.snapshot",
    });
    sockets[0]!.message('{"type":"browser.snapshot"}');
    expect(observed).toHaveLength(0);
    sockets[0]!.message(snapshot);
    sockets[0]!.message(snapshot);
    sockets[1]!.message(snapshot);
    sockets[2]!.message(snapshot);
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({
      connectionId: first.connectionId,
      ownerId: 7,
      sessionId,
      mode: "control",
      type: "admitted",
    });
    transport.closeWebSocket(7, { connectionId: first.connectionId });
    expect(observed.at(-1)).toMatchObject({ connectionId: first.connectionId, type: "closed" });
    transport.closeSocketsForOwner(7);
    expect(observed.at(-1)).toMatchObject({ connectionId: second.connectionId, type: "closed" });
    transport.closeAllSockets();
    expect(observed.at(-1)).toMatchObject({ connectionId: second.connectionId, type: "closed" });
    sockets[0]!.close(1006, "late");
    expect(observed).toHaveLength(4);
  });

  it("routes bounded requests only through the selected catalog Host", async () => {
    const first = deployment("Home", "https://home.connect.opensteer.test");
    const second = deployment("Cloud", "https://cloud.opensteer.test");
    const catalog = catalogStore([first, second], first.authority.document.deploymentId);
    const requests: HostNetworkRequest[] = [];
    const network: HostNetwork = {
      openWebSocket: vi.fn(() => socket()),
      request: vi.fn(async (input) => {
        requests.push(input);
        return new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }),
    };
    const transport = desktopHostTransport({
      catalog,
      credentials: {
        authorizationHeader: async (connection) =>
          connection.authority.document.deploymentId === first.authority.document.deploymentId
            ? "Bearer main-process-only"
            : null,
      },
      network,
    });

    await expect(transport.selection()).resolves.toMatchObject({
      deployments: [
        { id: first.authority.document.deploymentId, name: "Home" },
        { id: second.authority.document.deploymentId, name: "Cloud" },
      ],
      selectedDeploymentId: first.authority.document.deploymentId,
    });
    await expect(
      transport.request({
        headers: { accept: "application/json", idempotencyKey: "workspace:test" },
        method: "POST",
        path: "/v1/workspaces?source=desktop",
      }),
    ).resolves.toEqual({
      body: '{"ok":true}',
      headers: { contentType: "application/json" },
      status: 200,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: "Bearer main-process-only",
      canonicalOrigin: first.authority.document.canonicalOrigin,
      deploymentId: first.authority.document.deploymentId,
      url: `${first.authority.document.canonicalOrigin}/v1/workspaces?source=desktop`,
    });
    await expect(
      transport.request({ headers: {}, method: "GET", path: "https://attacker.test/v1/bootstrap" }),
    ).rejects.toThrow();
  });

  it("uses an explicitly selected verified direct route without an implicit fallback", async () => {
    const canonical = deployment("Home", "https://home.connect.opensteer.test");
    const directOrigin = "https://home.tailnet.test";
    const selected = DeploymentConnectionSchema.parse({
      ...canonical,
      endpoints: [
        ...canonical.endpoints,
        {
          kind: "direct",
          origin: directOrigin,
          verifiedAt: "2026-08-11T10:00:00.000Z",
        },
      ],
      preferredEndpointOrigin: directOrigin,
    });
    const catalog = catalogStore([selected], selected.authority.document.deploymentId);
    const requests: HostNetworkRequest[] = [];
    const transport = desktopHostTransport({
      catalog,
      network: {
        openWebSocket: vi.fn(() => socket()),
        request: vi.fn(async (input) => {
          requests.push(input);
          return new Response("{}");
        }),
      },
    });

    await expect(transport.selection()).resolves.toMatchObject({
      deployments: [
        {
          activeOrigin: directOrigin,
          routes: [
            expect.objectContaining({ kind: "canonical", selected: false }),
            expect.objectContaining({ kind: "direct", origin: directOrigin, selected: true }),
          ],
        },
      ],
    });
    await transport.request({ headers: {}, method: "GET", path: "/v1/bootstrap" });
    expect(requests.at(-1)?.url).toBe(`${directOrigin}/v1/bootstrap`);
    await expect(transport.integrationAuthorizationOrigin()).resolves.toBe(
      canonical.authority.document.canonicalOrigin,
    );

    await transport.setRoute({
      deploymentId: selected.authority.document.deploymentId,
      origin: null,
    });
    await transport.request({ headers: {}, method: "GET", path: "/v1/bootstrap" });
    expect(requests.at(-1)?.url).toBe(
      `${canonical.authority.document.canonicalOrigin}/v1/bootstrap`,
    );
  });

  it("does not pretend a remote Personal route is its loopback OAuth authority", async () => {
    const selected = {
      ...deployment("Remote Personal", "http://127.0.0.1:4310"),
      endpoints: [
        {
          kind: "direct" as const,
          origin: "https://personal.connect.opensteer.test",
          verifiedAt: "2026-08-11T10:00:00.000Z",
        },
      ],
      kind: "personal" as const,
      reachability: "routed" as const,
      personalAccessRoute: {
        document: {
          route: {
            generation: 1,
            kind: "connect",
            origin: "https://personal.connect.opensteer.test",
          },
        },
      } as never,
      preferredEndpointOrigin: "https://personal.connect.opensteer.test",
    };
    const transport = desktopHostTransport({
      catalog: {
        load: async () => ({
          deployments: [selected],
          revision: 1,
          schemaVersion: 4,
          selectedDeploymentId: selected.authority.document.deploymentId,
          updatedAt: "2026-08-11T10:00:00.000Z",
        }),
      } as never,
      network: {
        openWebSocket: vi.fn(() => socket()),
        request: vi.fn(async () => new Response("{}")),
      },
    });

    await expect(transport.integrationAuthorizationOrigin()).rejects.toThrow(
      "computer that hosts this Personal Opensteer",
    );
  });

  it("resolves a local Runner target from its verified catalog route independently of selection", async () => {
    const canonical = deployment("Cloud", "https://cloud.opensteer.test");
    const directOrigin = "https://cloud.tailnet.test";
    const selected = DeploymentConnectionSchema.parse({
      ...canonical,
      endpoints: [
        ...canonical.endpoints,
        { kind: "direct", origin: directOrigin, verifiedAt: "2026-08-11T10:00:00.000Z" },
      ],
      preferredEndpointOrigin: directOrigin,
    });
    const catalog = catalogStore([selected], selected.authority.document.deploymentId);
    const targets = new DesktopLocalRunnerTargetResolver({
      catalog,
      supervisedDeploymentId: async () => null,
    });

    const target = await targets.resolve(selected.authority.document.deploymentId);
    expect(target).toMatchObject({
      deploymentId: selected.authority.document.deploymentId,
      hostUrl: directOrigin,
    });
    await expect(targets.isCurrent(target)).resolves.toBe(true);
    await expect(targets.resolve(createId("deployment"))).rejects.toThrow("no longer available");

    await catalog.setPreferredEndpoint({
      deploymentId: selected.authority.document.deploymentId,
      origin: null,
    });
    await expect(targets.isCurrent(target)).resolves.toBe(false);
    await expect(targets.resolve(selected.authority.document.deploymentId)).resolves.toMatchObject({
      hostUrl: selected.authority.document.canonicalOrigin,
    });
  });

  it("fails closed without selection and never accepts arbitrary Host paths", async () => {
    const transport = desktopHostTransport({
      catalog: catalogStore([], null),
      network: {
        openWebSocket: vi.fn(() => socket()),
        request: vi.fn(async () => new Response("{}")),
      },
    });

    await expect(
      transport.request({ headers: {}, method: "GET", path: "/v1/bootstrap" }),
    ).rejects.toThrow("Select an Opensteer deployment");
    await expect(
      transport.request({ headers: {}, method: "GET", path: "/internal/secrets" }),
    ).rejects.toThrow();
    await expect(
      transport.request({ headers: {}, method: "GET", path: "/v1/%252e%252e/internal" }),
    ).rejects.toThrow();
    await expect(
      transport.request({
        headers: { authorization: "Bearer renderer" },
        method: "GET",
        path: "/v1/bootstrap",
      }),
    ).rejects.toThrow();
  });

  it.each(["/v1/realtime", "/v1/computer-use/sessions/cus_display/display"])(
    "binds %s sockets to one renderer and closes them when Deployment selection changes",
    async (path) => {
      const first = deployment("Home", "https://home.connect.opensteer.test");
      const second = deployment("Cloud", "https://cloud.opensteer.test");
      const catalog = catalogStore([first, second], first.authority.document.deploymentId);
      const networkSocket = socket();
      let events: HostNetworkSocketEvents | null = null;
      const transport = desktopHostTransport({
        catalog,
        network: {
          openWebSocket: vi.fn((_input, value) => {
            events = value;
            return networkSocket;
          }),
          request: vi.fn(async () => new Response("{}")),
        },
      });
      const received: unknown[] = [];
      const opened = await transport.openWebSocket(7, { path }, (event) => received.push(event));
      events!.open();
      events!.message("hello");
      expect(received).toEqual([
        { connectionId: opened.connectionId, type: "open" },
        { connectionId: opened.connectionId, data: "hello", type: "text" },
      ]);
      transport.sendWebSocket(7, {
        connectionId: opened.connectionId,
        data: "subscribe",
        type: "text",
      });
      expect(networkSocket.send).toHaveBeenCalledWith("subscribe");
      expect(() =>
        transport.sendWebSocket(8, {
          connectionId: opened.connectionId,
          data: "steal",
          type: "text",
        }),
      ).toThrow("belongs to another owner");

      await expect(transport.select({ deploymentId: createId("deployment") })).rejects.toThrow(
        "unknown Deployment",
      );
      expect(networkSocket.close).not.toHaveBeenCalled();
      await transport.select({ deploymentId: second.authority.document.deploymentId });
      expect(networkSocket.close).toHaveBeenCalledWith(4_001, "Deployment changed");
      await expect(transport.selection()).resolves.toMatchObject({
        selectedDeploymentId: second.authority.document.deploymentId,
      });
    },
  );

  it("closes old sockets when Account reconciliation removes the selected authority", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const catalog = catalogStore([selected], selected.authority.document.deploymentId);
    const networkSocket = socket();
    const transport = desktopHostTransport({
      catalog,
      network: {
        openWebSocket: vi.fn(() => networkSocket),
        request: vi.fn(async () => new Response("{}")),
      },
    });
    await transport.selection();
    await transport.openWebSocket(7, { path: "/v1/realtime" }, vi.fn());

    catalog.replace([], null);
    await expect(transport.selection()).resolves.toMatchObject({
      deployments: [],
      selectedDeploymentId: null,
    });
    expect(networkSocket.close).toHaveBeenCalledWith(4_001, "Deployment changed");
  });

  it("closes old sockets when the Host restarts under the selected route", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const catalog = catalogStore([selected], selected.authority.document.deploymentId);
    const networkSocket = socket();
    const transport = desktopHostTransport({
      catalog,
      network: {
        openWebSocket: vi.fn(() => networkSocket),
        request: vi.fn(async () => new Response("{}")),
      },
    });
    await transport.selection();
    await transport.openWebSocket(7, { path: "/v1/realtime" }, vi.fn());
    const before = transport.currentKey();
    // A new Host instance behind the same origin is a different Host, and the
    // one fence has to notice that without an endpoint list to compare.
    const restarted = DeploymentConnectionSchema.parse({
      ...selected,
      authority: testDiscoveryEnvelope({
        ...selected.authority.document,
        hostInstanceId: createId("hostInstance"),
      }),
    });
    catalog.replace([restarted], restarted.authority.document.deploymentId);
    await transport.selection();

    expect(transport.currentKey()).not.toBe(before);
    expect(networkSocket.close).toHaveBeenCalledWith(4_001, "Deployment changed");
  });

  /**
   * The regression this phase exists to fix: at the keyboard of the computer
   * that hosts a Personal Deployment, the attachment is `owner` and provider
   * consent opens on that Host's own loopback origin.
   */
  it("resolves the supervised Personal Host as its owner and originates OAuth on loopback", async () => {
    const canonicalOrigin = "http://127.0.0.1:43110";
    const personal = DeploymentConnectionSchema.parse({
      ...deployment("Mac mini", canonicalOrigin),
      authority: testDiscoveryEnvelope({
        canonicalOrigin,
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
        hostKey: { algorithm: "Ed25519" },
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
      }),
      bootstrapMethods: [],
      endpoints: [
        { kind: "canonical", origin: canonicalOrigin, verifiedAt: "2026-08-11T10:00:00.000Z" },
      ],
      kind: "personal",
    });
    const deploymentId = personal.authority.document.deploymentId;
    const transport = desktopHostTransport({
      catalog: catalogStore([personal], deploymentId),
      localRuntime: runtimeSource(
        testPersonalHostRuntime({
          discovery: personal.authority.document,
          localOrigin: canonicalOrigin,
          observedAt: "2026-08-11T10:00:00.000Z",
          ownership: "desktop-personal-host-supervisor",
          state: "ready",
          verification: "signed-loopback-discovery",
        }),
      ),
      network: {
        openWebSocket: vi.fn(() => socket()),
        request: vi.fn(async () => new Response("{}")),
      },
      supervisedDeploymentId: deploymentId,
    });

    await expect(transport.selection()).resolves.toMatchObject({
      deployments: [{ access: "owner", activeOrigin: canonicalOrigin, onThisComputer: true }],
    });
    await expect(transport.integrationAuthorizationOrigin()).resolves.toBe(canonicalOrigin);
  });

  it("closes an untrusted Host socket instead of throwing malformed frames into main", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const networkSocket = socket();
    let events: HostNetworkSocketEvents | null = null;
    const received: unknown[] = [];
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      network: {
        openWebSocket: vi.fn((_input, value) => {
          events = value;
          return networkSocket;
        }),
        request: vi.fn(async () => new Response("{}")),
      },
    });

    await transport.openWebSocket(7, { path: "/v1/realtime" }, (event) => received.push(event));
    expect(() => events!.message("😀".repeat(300_000))).not.toThrow();
    expect(networkSocket.close).toHaveBeenCalledWith(4_002, "Invalid Host frame");
    expect(received).toEqual([
      expect.objectContaining({ message: "The Host sent an invalid frame.", type: "error" }),
      expect.objectContaining({ code: 4_002, reason: "Invalid Host frame", type: "close" }),
    ]);
    events!.message("late");
    events!.error("late");
    events!.open();
    events!.close(1_006, "late");
    expect(received).toHaveLength(2);
  });

  it("replays each request once only after unified recovery confirms success", async () => {
    const fixture = cloudFixture();

    const [first, second] = await Promise.all([
      fixture.transport.request({ headers: {}, method: "GET", path: "/v1/bootstrap" }),
      fixture.transport.request({ headers: {}, method: "GET", path: "/v1/workspaces" }),
    ]);

    expect(first).toMatchObject({ body: '{"ok":true}', status: 200 });
    expect(second).toMatchObject({ body: '{"ok":true}', status: 200 });
    expect(fixture.recoverUnauthorized).toHaveBeenCalledTimes(2);
    expect(fixture.hostRequests).toEqual([
      "/v1/bootstrap",
      "/v1/workspaces",
      "/v1/bootstrap",
      "/v1/workspaces",
    ]);
  });

  it("gives session recovery its own time after reading a refusal", async () => {
    vi.useFakeTimers();
    try {
      const selected = deployment("Home", "https://home.connect.opensteer.test");
      let requests = 0;
      const recoverUnauthorized = vi.fn(
        () => new Promise<"recovered">((resolve) => setTimeout(() => resolve("recovered"), 25_000)),
      );
      const transport = desktopHostTransport({
        catalog: catalogStore([selected], selected.authority.document.deploymentId),
        network: {
          openWebSocket: () => socket(),
          request: async () =>
            ++requests === 1
              ? new Response('{"error":"unauthorized"}', { status: 401 })
              : new Response('{"ok":true}'),
        },
        sessions: { recoverUnauthorized },
      });
      const pending = transport.request({
        headers: {},
        method: "GET",
        path: "/v1/rpc/auth.config",
      });
      const outcome = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await outcome).toMatchObject({ body: '{"ok":true}', status: 200 });
      expect(recoverUnauthorized).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a refused Host response untouched instead of retrying it", async () => {
    const fixture = cloudFixture({ redemptionStatus: 403 });

    await expect(
      fixture.transport.request({ headers: {}, method: "GET", path: "/v1/bootstrap" }),
    ).resolves.toMatchObject({ body: '{"error":"unauthorized"}', status: 401 });
    await expect(
      fixture.transport.request({ headers: {}, method: "GET", path: "/v1/bootstrap" }),
    ).resolves.toMatchObject({ status: 401 });

    expect(fixture.recoverUnauthorized).toHaveBeenCalledTimes(2);
    expect(fixture.hostRequests).toEqual(["/v1/bootstrap", "/v1/bootstrap"]);
  });

  it("does not treat an ambiguous WebSocket failure as authentication evidence", async () => {
    const selected = DeploymentConnectionSchema.parse({
      ...deployment("Cloud", "https://cloud.opensteer.test"),
      kind: "self-hosted",
    });
    let events: HostNetworkSocketEvents | null = null;
    const recoverUnauthorized = vi.fn(async () => "recovered" as const);
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      network: {
        openWebSocket: vi.fn((_input, value) => {
          events = value;
          return socket();
        }),
        request: vi.fn(async () => new Response("{}")),
      },
      sessions: { recoverUnauthorized },
    });

    await transport.openWebSocket(3, { path: "/v1/realtime" }, () => undefined);
    events!.close(1_006, "");
    expect(recoverUnauthorized).not.toHaveBeenCalled();

    const owned = await transport.openWebSocket(3, { path: "/v1/realtime" }, () => undefined);
    transport.closeWebSocket(3, { connectionId: owned.connectionId });
    events!.close(1_000, "");
    expect(recoverUnauthorized).not.toHaveBeenCalled();
  });

  it("never spends an Account grant for a Deployment that owns its authorization", async () => {
    const fixture = cloudFixture({ kind: "self-hosted" });

    await expect(
      fixture.transport.request({ headers: {}, method: "GET", path: "/v1/bootstrap" }),
    ).resolves.toMatchObject({ status: 401 });

    expect(fixture.recoverUnauthorized).toHaveBeenCalledOnce();
    expect(fixture.hostRequests).toEqual(["/v1/bootstrap"]);
  });
});

function cloudFixture(
  options: {
    readonly kind?: "self-hosted" | "self-hosted";
    readonly redemptionStatus?: number;
  } = {},
) {
  const canonicalOrigin = "https://cloud.opensteer.test";
  const selected = DeploymentConnectionSchema.parse({
    ...deployment("Cloud", canonicalOrigin),
    kind: options.kind ?? "self-hosted",
  });
  const hostRequests: string[] = [];
  let sessionActive = false;
  const recoverUnauthorized = vi.fn(async () => {
    if (options.kind === "self-hosted") return "unsupported" as const;
    if (options.redemptionStatus !== undefined) return "blocked" as const;
    sessionActive = true;
    return "recovered" as const;
  });
  const transport = desktopHostTransport({
    catalog: catalogStore([selected], selected.authority.document.deploymentId),
    network: {
      openWebSocket: vi.fn(() => socket()),
      request: vi.fn(async (input: HostNetworkRequest) => {
        hostRequests.push(input.request.path);
        return sessionActive
          ? new Response('{"ok":true}', {
              headers: { "content-type": "application/json" },
              status: 200,
            })
          : new Response('{"error":"unauthorized"}', {
              headers: { "content-type": "application/json" },
              status: 401,
            });
      }),
    },
    sessions: { recoverUnauthorized },
  });
  return { hostRequests, recoverUnauthorized, selected, transport };
}

function deployment(name: string, canonicalOrigin: string) {
  const now = "2026-08-11T10:00:00.000Z";
  return DeploymentConnectionSchema.parse({
    authority: testDiscoveryEnvelope({
      canonicalOrigin,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance") as HostInstanceId,
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
    }),
    bootstrapMethods: ["password"],
    createdAt: now,
    endpoints: [{ kind: "canonical", origin: canonicalOrigin, verifiedAt: now }],
    kind: "self-hosted",
    lastUsedAt: null,
    name,
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: now,
  });
}

function catalogStore(
  deployments: DeploymentCatalog["deployments"],
  selectedDeploymentId: DeploymentId | null,
) {
  let catalog = DeploymentCatalogSchema.parse({
    deployments,
    revision: deployments.length ? 1 : 0,
    schemaVersion: 4,
    selectedDeploymentId,
    updatedAt: deployments.length ? "2026-08-11T10:00:00.000Z" : null,
  });
  return {
    load: async () => catalog,
    subscribe: () => () => undefined,
    replace: (
      nextDeployments: DeploymentCatalog["deployments"],
      nextSelectedDeploymentId: DeploymentId | null,
    ) => {
      catalog = DeploymentCatalogSchema.parse({
        deployments: nextDeployments,
        revision: catalog.revision + 1,
        schemaVersion: 4,
        selectedDeploymentId: nextSelectedDeploymentId,
        updatedAt: "2026-08-11T10:02:00.000Z",
      });
    },
    select: async (deploymentId: DeploymentId | string) => {
      if (
        !catalog.deployments.some(
          ({ authority }) => authority.document.deploymentId === deploymentId,
        )
      ) {
        throw new Error("Cannot select unknown Deployment");
      }
      catalog = DeploymentCatalogSchema.parse({
        ...catalog,
        revision: catalog.revision + 1,
        selectedDeploymentId: deploymentId,
        updatedAt: "2026-08-11T10:01:00.000Z",
      });
      return catalog;
    },
    setPreferredEndpoint: async (input: {
      readonly deploymentId: DeploymentId | string;
      readonly origin: string | null;
    }) => {
      const index = catalog.deployments.findIndex(
        ({ authority }) => authority.document.deploymentId === input.deploymentId,
      );
      if (index === -1) throw new Error("Cannot select a route for an unknown Deployment.");
      const deployments = [...catalog.deployments];
      deployments[index] = DeploymentConnectionSchema.parse({
        ...deployments[index],
        preferredEndpointOrigin: input.origin,
        updatedAt: "2026-08-11T10:03:00.000Z",
      });
      catalog = DeploymentCatalogSchema.parse({
        ...catalog,
        deployments,
        revision: catalog.revision + 1,
        updatedAt: "2026-08-11T10:03:00.000Z",
      });
      return catalog;
    },
  };
}

function desktopHostTransport(options: {
  readonly catalog: Pick<
    DesktopHostTransportCatalog,
    "load" | "select" | "setPreferredEndpoint" | "subscribe"
  >;
  readonly credentials?: HostCredentialProvider;
  readonly localRuntime?: PersonalHostRuntimeSource;
  readonly network: HostNetwork;
  readonly log?: (event: string, fields: Record<string, string | number | boolean>) => void;
  readonly sessions?: HostSessionRecovery;
  readonly supervisedDeploymentId?: DeploymentId;
}): DesktopHostTransport {
  const localRuntime = options.localRuntime ?? { current: async () => null };
  return new DesktopHostTransport({
    catalog: options.catalog,
    ...(options.credentials ? { credentials: options.credentials } : {}),
    localRuntime,
    network: options.network,
    ...(options.log ? { log: options.log } : {}),
    projection: new DesktopAccessProjection({
      catalog: options.catalog,
      localRuntime,
      supervisedDeploymentId: async () => options.supervisedDeploymentId ?? null,
    }),
    ...(options.sessions ? { sessions: options.sessions } : {}),
  });
}

type DesktopHostTransportCatalog = ConstructorParameters<typeof DesktopHostTransport>[0]["catalog"];

function runtimeSource(runtime: PersonalHostRuntimeRecord): PersonalHostRuntimeSource {
  return { current: async () => runtime };
}

function socket() {
  return {
    close: vi.fn((code?: number) => {
      if (code !== undefined && code !== 1_000 && (code < 3_000 || code > 4_999)) {
        throw new TypeError("Invalid WHATWG WebSocket client close code");
      }
    }),
    send: vi.fn(),
  };
}
