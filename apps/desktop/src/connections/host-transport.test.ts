import { TeamRuntimeOwner } from "@opensteer/client/team";
import { bootstrapDiagnosticHeader } from "@opensteer/shared/bootstrapDiagnostics";
import { HostTransport as SharedHostTransport } from "@opensteer/client/connections";
import {
  createDesktopHostFetch,
  desktopHostUploadConcurrency,
} from "../../../web/src/desktop/desktop-host-transport.js";
import { readComputerFacts } from "../../../web/src/desktop/computer-facts.js";
import type { DeploymentAccessDeployment } from "@opensteer/protocol/desktop";
import {
  desktopHostRequestIdHeader,
  desktopHostTransportErrorHeader,
  type DesktopHostWebSocketEvent,
} from "@opensteer/protocol/desktop";
import { createId, type DeploymentId, type HostInstanceId } from "@opensteer/core";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import { describe, expect, it, vi } from "vitest";
import { createHttpHostApiClient } from "@opensteer/client/host-api";
import {
  DeploymentCatalogSchema,
  DeploymentConnectionSchema,
  type DeploymentCatalog,
  type HostCredentialProvider,
  type HostNetwork,
  type HostNetworkRequest,
  type HostNetworkSocketEvents,
} from "@opensteer/client/connections";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testDiscoveryEnvelope,
  testHostAuthorityKeys,
} from "@opensteer/client/test-support";
import type { HostSessionRecovery } from "@opensteer/client/auth";
import { DesktopAccessProjection } from "./access-projection.js";
import { DesktopHostTransport } from "./host-transport.js";
import { forwardHostRoute } from "../app/host-route.js";
import type {
  PersonalHostRuntimeRecord,
  PersonalHostRuntimeSource,
} from "../supervisor/personal-host-runtime.js";
import { testPersonalHostRuntime } from "../supervisor/personal-host-runtime-test-support.js";
import { DesktopLocalRunnerTargetResolver } from "../supervisor/local-runner-authority.js";

describe("DesktopHostTransport", () => {
  it("preserves a 401 through the renderer route when its body stalls", async () => {
    vi.useFakeTimers();
    const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
    const id = selected.authority.document.deploymentId;
    const sessionEnded = vi.fn();
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], id),
      sessions: { sessionEnded, recoverUnauthorized: async () => "blocked" },
      network: {
        openWebSocket: () => socket(),
        request: async () => new Response(new ReadableStream({ start() {} }), { status: 401 }),
      },
    });
    try {
      const onAuthenticationRequired = vi.fn();
      const rpc = createHttpHostApiClient({
        baseUrl: new URL(routeOrigin),
        fetch: hostFetch(transport, id),
        onAuthenticationRequired,
      });
      const answer = rpc["auth.config"]({});
      await vi.advanceTimersByTimeAsync(0);
      expect(sessionEnded).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await answer).toMatchObject({
        ok: false,
        error: {
          code: "unauthorized",
          reason: "sign-in-required",
          provenance: "host",
          retryable: false,
        },
      });
      expect(onAuthenticationRequired).toHaveBeenCalledWith("auth.config");
    } finally {
      transport.dispose();
      vi.useRealTimers();
    }
  });

  it("ends a team response mid-body when its Account owner retires", async () => {
    const team = deployment("Team", "https://team.example");
    const id = team.authority.document.deploymentId;
    const owner = new TeamRuntimeOwner(null);
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const transport = desktopHostTransport({
      catalog: catalogStore([team], id),
      credentials: { teamRuntime: () => owner, authorizationHeader: async () => "Bearer team" },
      network: {
        openWebSocket: () => socket(),
        request: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                body = controller;
              },
            }),
          ),
      },
    });
    try {
      const response = await hostFetch(transport, id)(`${routeOrigin}/v1/team/files/test/original`);
      const reader = response.body!.getReader();
      body.enqueue(new TextEncoder().encode("first"));
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
      owner.retire();
      body.enqueue(new TextEncoder().encode("private"));
      await expect(reader.read()).rejects.toThrow("The Account identity changed.");
    } finally {
      transport.dispose();
    }
  });

  it("sends an upload under the Account it arrived with, never one that replaced it mid-body", async () => {
    const team = deployment("Team", "https://team.example");
    const id = team.authority.document.deploymentId;
    let owner = new TeamRuntimeOwner(null);
    let account = "Bearer original";
    const request = vi.fn(async () => Response.json({}));
    const transport = desktopHostTransport({
      catalog: catalogStore([team], id),
      credentials: { teamRuntime: () => owner, authorizationHeader: async () => account },
      network: { openWebSocket: () => socket(), request },
    });
    let upload!: ReadableStreamDefaultController<Uint8Array>;
    const reading = Promise.withResolvers<void>();
    // Pulled only once main is reading the body, so the Account changes mid-upload.
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          upload = controller;
        },
        pull: () => reading.resolve(),
      },
      { highWaterMark: 0 },
    );
    try {
      const pending = forwardHostRoute(
        Object.assign(
          new Request(`app://opensteer/host/${id}/v1/team/files/upload/channel_1`, {
            body,
            duplex: "half",
            headers: {
              "content-type": "application/octet-stream",
              [desktopHostRequestIdHeader]: crypto.randomUUID(),
            },
            method: "POST",
          } as RequestInit),
          { initiatorOrigin: "app://opensteer" },
        ),
        transport,
      );
      await reading.promise;
      upload.enqueue(new TextEncoder().encode("first part"));
      owner.retire();
      owner = new TeamRuntimeOwner(null);
      account = "Bearer replacement";
      upload.enqueue(new TextEncoder().encode("rest"));
      upload.close();
      const response = await pending;
      expect(response.headers.get(desktopHostTransportErrorHeader)).toBe("deployment-changed");
      expect(request).not.toHaveBeenCalled();
    } finally {
      transport.dispose();
    }
  });

  it.each([
    ["desktop", "credential"],
    ["shared", "credential"],
    ["desktop", "response"],
    ["shared", "response"],
  ])("fences initial %s resolution at %s", async (surface, stage) => {
    const team = deployment("Team", "https://team.example");
    const catalog = catalogStore([team], team.authority.document.deploymentId);
    const gate = Promise.withResolvers<void>();
    const read = vi.fn();
    const owner = new TeamRuntimeOwner(null);
    const credentials = {
      teamRuntime: () => owner,
      authorizationHeader: async () => {
        read();
        if (stage === "credential") await gate.promise;
        return "Bearer outgoing";
      },
    };
    const request = vi.fn(async () => {
      if (stage === "response") await gate.promise;
      return Response.json({});
    });
    const network = { request, openWebSocket: () => socket() };
    const transport =
      surface === "desktop"
        ? desktopHostTransport({ catalog, credentials, network })
        : new SharedHostTransport({
            catalog,
            credentials,
            network,
            localRuntime: { current: async () => null },
          });
    try {
      const pending = transport.exchange(
        { headers: {}, method: "GET", path: "/v1/bootstrap" },
        async (r) => r.text(),
      );
      const rejected = expect(pending).rejects.toMatchObject({ code: "deployment-changed" });
      await vi.waitFor(
        () => expect(stage === "credential" ? read : request).toHaveBeenCalledOnce(),
        { timeout: 1000 },
      );
      owner.retire();
      gate.resolve();
      await rejected;
      expect(request).toHaveBeenCalledTimes(stage === "credential" ? 0 : 1);
    } finally {
      gate.resolve();
      transport.closeAllSockets();
      if (transport instanceof DesktopHostTransport) transport.dispose();
    }
  });

  it.each([false, true])(
    "isolates personal transports during team invalidation (team: %s)",
    async (withTeam) => {
      const personal = deployment("Home", "https://home.example", "personal");
      const manual = deployment("Work", "https://work.example", "personal");
      const team = deployment("Team", "https://team.example");
      const catalog = catalogStore(
        [personal, manual, ...(withTeam ? [team] : [])],
        personal.authority.document.deploymentId,
      );
      const gate = Promise.withResolvers<Response>();
      const started: HostNetworkRequest[] = [];
      const closes = new Map<DeploymentId, ReturnType<typeof vi.fn>>();
      const owner = new TeamRuntimeOwner(null);
      const transport = desktopHostTransport({
        catalog,
        credentials: { teamRuntime: () => owner, authorizationHeader: async () => null },
        network: {
          request: async (input) => {
            started.push(input);
            return gate.promise.then((response) => response.clone());
          },
          openWebSocket: (input) => {
            const close = vi.fn();
            closes.set(input.deploymentId, close);
            return { ...socket(), close };
          },
        },
      });
      try {
        await transport.openWebSocket(
          1,
          { expectedDeploymentId: personal.authority.document.deploymentId, path: "/v1/realtime" },
          () => {},
        );
        if (withTeam)
          await transport.openWebSocket(
            2,
            { expectedDeploymentId: team.authority.document.deploymentId, path: "/v1/realtime" },
            () => {},
          );
        const request = (id: DeploymentId) =>
          send(transport, id, "/v1/rpc/attention.get", { method: "POST", body: "{}" });
        const selected = expect(
          request(personal.authority.document.deploymentId),
        ).resolves.toBeDefined();
        const summary = expect(
          request(manual.authority.document.deploymentId),
        ).resolves.toBeDefined();
        void selected.catch(() => {});
        void summary.catch(() => {});
        const teamRequest = withTeam ? request(team.authority.document.deploymentId) : null;
        const rejected = teamRequest
          ? expect(teamRequest).rejects.toMatchObject({ code: "deployment-changed" })
          : null;
        await vi.waitFor(() => expect(started).toHaveLength(withTeam ? 3 : 2), { timeout: 1000 });
        owner.retire();
        expect(closes.get(personal.authority.document.deploymentId)).not.toHaveBeenCalled();
        if (withTeam)
          expect(closes.get(team.authority.document.deploymentId)).toHaveBeenCalledOnce();
        gate.resolve(Response.json({ ok: true, data: {} }));
        await selected;
        await summary;
        await rejected;
      } finally {
        gate.resolve(Response.json({}));
        transport.dispose();
      }
    },
  );

  it("records an issued enrollment before the renderer can read it, using the request's exact Deployment", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const id = selected.authority.document.deploymentId;
    const order: string[] = [];
    const observeCommand = vi.fn(async () => {
      order.push("observed");
    });
    const issued = {
      type: "runner.enrollment.createLocal",
      enrollmentId: "enrollment-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      token: "t".repeat(64),
    };
    let accepted = true;
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], id),
      observeCommand,
      network: {
        openWebSocket: () => socket(),
        request: async () =>
          Response.json(
            accepted
              ? { ok: true, data: issued }
              : { ok: false, error: { code: "forbidden", message: "refused" } },
          ),
      },
    });
    const command = {
      type: "runner.enrollment.createLocal",
      allowedModules: ["shell"],
      name: "Mac",
      idempotencyKey: "enroll-this-mac",
    };
    const dispatch = () =>
      send(transport, id, "/v1/rpc/commands.dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }).then((response) => {
        order.push("renderer");
        return response;
      });
    await expect(dispatch()).resolves.toMatchObject({ status: 200 });
    expect(observeCommand).toHaveBeenCalledExactlyOnceWith(id, command, issued);
    expect(order).toEqual(["observed", "renderer"]);
    accepted = false;
    await dispatch();
    expect(observeCommand).toHaveBeenCalledOnce();
    transport.dispose();
  });

  it("refuses a request whose session changed while main was still finding its Deployment", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
    const id = selected.authority.document.deploymentId;
    const store = catalogStore([selected], id);
    const looking = Promise.withResolvers<void>();
    const found = Promise.withResolvers<void>();
    let hold = true;
    const request = vi.fn(async () => Response.json({ ok: true, data: {} }));
    const transport = desktopHostTransport({
      catalog: {
        ...store,
        load: async () => {
          if (hold) {
            hold = false;
            looking.resolve();
            await found.promise;
          }
          return store.load();
        },
      },
      network: { openWebSocket: () => socket(), request },
    });
    try {
      const pending = send(transport, id, "/v1/rpc/bootstrap.get");
      await looking.promise;
      // Signed out and in again: the same Host and route, another session.
      transport.closeDeploymentConnections(id);
      found.resolve();
      await expect(pending).rejects.toMatchObject({ code: "deployment-changed" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      found.resolve();
      transport.dispose();
    }
  });

  it("refuses a personal write whose selection left and came back while main was finding it", async () => {
    const home = deployment("Home", "https://home.connect.opensteer.test", "personal");
    const work = deployment("Work", "https://work.connect.opensteer.test", "personal");
    const homeId = home.authority.document.deploymentId;
    const store = catalogStore([home, work], homeId);
    const looking = Promise.withResolvers<void>();
    const found = Promise.withResolvers<void>();
    let hold = false;
    const request = vi.fn(async () => Response.json({ ok: true, data: {} }));
    const transport = desktopHostTransport({
      catalog: {
        ...store,
        load: async () => {
          if (hold) {
            hold = false;
            looking.resolve();
            await found.promise;
          }
          return store.load();
        },
      },
      network: { openWebSocket: () => socket(), request },
    });
    try {
      await transport.current();
      hold = true;
      const pending = send(transport, homeId, "/v1/rpc/commands.dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"type":"thread.create"}',
      });
      await looking.promise;
      await transport.select({ deploymentId: work.authority.document.deploymentId });
      await transport.select({ deploymentId: homeId });
      found.resolve();
      await expect(pending).rejects.toMatchObject({ code: "deployment-changed" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      found.resolve();
      transport.dispose();
    }
  });

  it("reads a team's bootstrap as strict UTF-8, refusing a byte a lenient decode would repair", async () => {
    const team = deployment("Team", "https://team.example");
    const id = team.authority.document.deploymentId;
    const transport = desktopHostTransport({
      catalog: catalogStore([team], id),
      network: {
        openWebSocket: () => socket(),
        request: async () =>
          new Response(
            Uint8Array.from([
              ...new TextEncoder().encode(
                '{"ok":false,"error":{"code":"conflict","retryable":false,"message":"Ada',
              ),
              0xff,
              ...new TextEncoder().encode('"}}'),
            ]),
          ),
      },
    });
    try {
      await expect(transport.bootstrapTeam(id)).rejects.toBeInstanceOf(TypeError);
    } finally {
      transport.dispose();
    }
  });

  it("holds an upload to its attachment through a token refresh, not a selection that left and came back", async () => {
    const home = deployment("Home", "https://home.connect.opensteer.test", "personal");
    const work = deployment("Work", "https://work.connect.opensteer.test", "personal");
    const team = deployment("Team", "https://team.example");
    const owner = new TeamRuntimeOwner(null);
    let token = "Bearer first";
    const request = vi.fn(async (_input: HostNetworkRequest) => Response.json({}));
    const transport = desktopHostTransport({
      catalog: catalogStore([home, work, team], home.authority.document.deploymentId),
      credentials: { teamRuntime: () => owner, authorizationHeader: async () => token },
      network: { openWebSocket: () => socket(), request },
    });
    // An upload main is reading, finished only when told.
    const paused = (deploymentId: DeploymentId, path: string) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const reading = Promise.withResolvers<void>();
      const body = new ReadableStream<Uint8Array>(
        {
          start: (stream) => {
            controller = stream;
          },
          pull: () => reading.resolve(),
        },
        { highWaterMark: 0 },
      );
      const response = forwardHostRoute(
        Object.assign(
          new Request(`app://opensteer/host/${deploymentId}${path}`, {
            body,
            duplex: "half",
            headers: {
              "content-type": "application/octet-stream",
              [desktopHostRequestIdHeader]: crypto.randomUUID(),
            },
            method: "POST",
          } as RequestInit),
          { initiatorOrigin: "app://opensteer" },
        ),
        transport,
      );
      return {
        reading: reading.promise,
        finish: () => {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
          return response;
        },
      };
    };
    try {
      const homeId = home.authority.document.deploymentId;
      const away = paused(homeId, "/v1/rpc/attachment.upload");
      await away.reading;
      await transport.select({ deploymentId: work.authority.document.deploymentId });
      await transport.select({ deploymentId: homeId });
      const returned = await away.finish();
      expect(returned.headers.get(desktopHostTransportErrorHeader)).toBe("deployment-changed");
      expect(request).not.toHaveBeenCalled();

      const teamId = team.authority.document.deploymentId;
      const refreshed = paused(teamId, "/v1/team/files/upload/channel_1");
      await refreshed.reading;
      token = "Bearer second";
      // Another read meanwhile resolves the team's attachment again with the new token.
      await send(transport, teamId, "/v1/rpc/team.bootstrap.get", { method: "POST", body: "{}" });
      const sent = await refreshed.finish();
      expect(sent.status).toBe(200);
      expect(request.mock.calls.at(-1)![0]).toMatchObject({ authorization: "Bearer second" });
    } finally {
      transport.dispose();
    }
  });

  it("refuses a buffered command whose session changed on the same route while main prepared it", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
    const id = selected.authority.document.deploymentId;
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const request = vi.fn(async () => Response.json({ ok: true, data: {} }));
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], id),
      network: { openWebSocket: () => socket(), request },
      withPreparedEnrollment: async (_deploymentId, _command, operation) => {
        preparing.resolve();
        await prepared.promise;
        return operation();
      },
    });
    try {
      const pending = send(transport, id, "/v1/rpc/commands.dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "runner.enrollment.createLocal",
          allowedModules: ["shell"],
          name: "Mac",
          idempotencyKey: "enroll-this-mac",
        }),
      });
      await preparing.promise;
      // Signed in again: the same Host and route, another session.
      transport.closeDeploymentConnections(id);
      prepared.resolve();
      await expect(pending).rejects.toMatchObject({ code: "deployment-changed" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      prepared.resolve();
      transport.dispose();
    }
  });

  it("notifies session loss before a renderer can recover the closed realtime socket", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
    let networkEvents: HostNetworkSocketEvents | undefined;
    const order: string[] = [];
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      sessions: {
        recoverUnauthorized: async () => "blocked",
        sessionEnded: () => {
          order.push("lifecycle");
        },
      },
      network: {
        request: async () => Response.json({}),
        openWebSocket: (_input, events) => {
          networkEvents = events;
          return socket();
        },
      },
    });
    await transport.openWebSocket(
      7,
      { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
      (event) => {
        if (event.type === "close") order.push("renderer");
      },
    );
    networkEvents?.close(4003, "Session ended");
    expect(order).toEqual(["lifecycle", "renderer"]);
    transport.dispose();
  });

  it.each([false, true])(
    "bounds silence while streaming a slow desktop response; stall: %s",
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
        const response = hostFetch(
          transport,
          selected.authority.document.deploymentId,
        )(`${routeOrigin}/v1/rpc/auth.config`);
        await vi.advanceTimersByTimeAsync(0);
        const pending = response.then((value) => value.text());
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
          await expect(pending).resolves.toBe("   ");
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
        {
          expectedDeploymentId: selected.authority.document.deploymentId,
          path: `/v1/browser-sessions/${sessionId}/connect`,
        },
        vi.fn(),
      );
      const second = await transport.openWebSocket(
        7,
        {
          expectedDeploymentId: selected.authority.document.deploymentId,
          path: `/v1/browser-sessions/${sessionId}/connect?mode=watch`,
        },
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
        expectedDeploymentId: selected.authority.document.deploymentId,
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
      const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
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
      const { connectionId } = await transport.openWebSocket(
        7,
        { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
        (event) => received.push(event),
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
      const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
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
      const { connectionId } = await transport.openWebSocket(
        7,
        { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
        received,
      );
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
    await expect(
      transport.openWebSocket(
        7,
        { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
        received,
      ),
    ).rejects.toThrow("Network unavailable");
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
    const { connectionId } = await transport.openWebSocket(
      7,
      { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
      received,
    );
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
    await transport.openWebSocket(
      7,
      { expectedDeploymentId: selected.authority.document.deploymentId, path },
      received,
    );
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
    const first = await transport.openWebSocket(
      7,
      { expectedDeploymentId: selected.authority.document.deploymentId, path },
      vi.fn(),
    );
    const second = await transport.openWebSocket(
      7,
      { expectedDeploymentId: selected.authority.document.deploymentId, path },
      vi.fn(),
    );
    await transport.openWebSocket(
      8,
      {
        expectedDeploymentId: selected.authority.document.deploymentId,
        path: `${path}?mode=watch`,
      },
      vi.fn(),
    );
    const snapshot = JSON.stringify({
      access: "read-write",
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

  it("logs only sanitized anomalous bootstrap summaries, once per minute", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const log = vi.fn();
    const request = vi.fn(async () => new Response("{}"));
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      log,
      network: { openWebSocket: () => socket(), request },
    });
    const summary = JSON.stringify({ windowMs: 3000, triggers: { load: 6 }, starts: { load: 6 } });
    const read = (bootstrapDiagnostics?: string) =>
      send(
        transport,
        selected.authority.document.deploymentId,
        "/v1/rpc/bootstrap.get?input=%7B%7D",
        {
          headers: bootstrapDiagnostics
            ? { [bootstrapDiagnosticHeader]: bootstrapDiagnostics }
            : {},
        },
      );
    await read();
    await read(
      JSON.stringify({ windowMs: 1, triggers: {}, starts: { load: 6 }, url: "PRIVATE-VALUE" }),
    );
    expect(log).not.toHaveBeenCalled();
    await read(summary);
    await read(summary);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "host.bootstrap.loop",
      expect.objectContaining({ triggers: '{"load":6}', starts: '{"load":6}' }),
    );
    expect(request).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE-VALUE");
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
    const response = await send(
      transport,
      first.authority.document.deploymentId,
      "/v1/workspaces?source=desktop",
      {
        headers: {
          accept: "application/json",
          authorization: "Bearer renderer",
          cookie: "session=renderer",
          "idempotency-key": "workspace:test",
        },
        method: "POST",
      },
    );
    expect(response).toMatchObject({ body: '{"ok":true}', status: 200 });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: "Bearer main-process-only",
      canonicalOrigin: first.authority.document.canonicalOrigin,
      deploymentId: first.authority.document.deploymentId,
      url: `${first.authority.document.canonicalOrigin}/v1/workspaces?source=desktop`,
      request: { headers: { accept: "application/json", idempotencyKey: "workspace:test" } },
    });
    expect(JSON.stringify(requests[0]!.request.headers)).not.toContain("renderer");
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
    await get(transport, "/v1/bootstrap");
    expect(requests.at(-1)?.url).toBe(`${directOrigin}/v1/bootstrap`);
    await expect(transport.integrationAuthorizationOrigin()).resolves.toBe(
      canonical.authority.document.canonicalOrigin,
    );

    await transport.setRoute({
      deploymentId: selected.authority.document.deploymentId,
      origin: null,
    });
    await get(transport, "/v1/bootstrap");
    expect(requests.at(-1)?.url).toBe(
      `${canonical.authority.document.canonicalOrigin}/v1/bootstrap`,
    );
  });

  it("opens a remote Personal route's sign-in on that route, not another computer's loopback", async () => {
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
        subscribe: () => () => undefined,
        load: async () => ({
          deployments: [selected],
          revision: 1,
          schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
          selectedDeploymentId: selected.authority.document.deploymentId,
          updatedAt: "2026-08-11T10:00:00.000Z",
        }),
      } as never,
      network: {
        openWebSocket: vi.fn(() => socket()),
        request: vi.fn(async () => new Response("{}")),
      },
    });

    await expect(transport.integrationAuthorizationOrigin()).resolves.toBe(
      "https://personal.connect.opensteer.test",
    );
  });

  it("resolves a local Runner target from its verified catalog route independently of selection", async () => {
    const canonical = deployment("Cloud", "https://cloud.opensteer.test", "personal");
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

    await expect(get(transport, "/v1/bootstrap")).rejects.toThrow("Select an Opensteer deployment");
    await expect(send(transport, createId("deployment"), "/v1/bootstrap")).rejects.toMatchObject({
      code: "deployment-changed",
    });
  });

  it.each(["/v1/realtime", "/v1/computer-use/sessions/cus_display/display"])(
    "binds %s sockets to one renderer and closes them when Deployment selection changes",
    async (path) => {
      const first = deployment("Home", "https://home.connect.opensteer.test", "personal");
      const second = deployment("Cloud", "https://cloud.opensteer.test", "personal");
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
      const opened = await transport.openWebSocket(
        7,
        { expectedDeploymentId: first.authority.document.deploymentId, path },
        (event) => received.push(event),
      );
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

  it.each([false, true])(
    "publishes the place list while its selected Personal route is unavailable; signed: %s",
    async (retainSignedRoute) => {
      const base = deployment("Studio Mac", "http://127.0.0.1:4310");
      const keys = testHostAuthorityKeys();
      const authority = signTestDiscoveryEnvelope(
        {
          ...base.authority.document,
          deploymentShape: { kind: "personal" },
        },
        keys,
      );
      const routeOrigin = "https://studio.connect.opensteer.test";
      const signedRoute = signTestPersonalAccessRoute(
        {
          authority: authority.document,
          documentVersion: 2,
          purpose: "opensteer-personal-access-route",
          route: { generation: 1, kind: "connect", origin: routeOrigin },
        },
        keys,
      );
      const live = DeploymentConnectionSchema.parse({
        ...base,
        authority,
        endpoints: [{ kind: "direct", origin: routeOrigin, verifiedAt: base.updatedAt }],
        kind: "personal",
        personalAccessRoute: signedRoute,
        preferredEndpointOrigin: routeOrigin,
        reachability: "routed",
      });
      const unavailable = DeploymentConnectionSchema.parse({
        ...live,
        endpoints: base.endpoints,
        personalAccessRoute: retainSignedRoute ? signedRoute : null,
        preferredEndpointOrigin: null,
      });
      const other = deployment("Other computer", "https://other.opensteer.test");
      const selectedId = authority.document.deploymentId;
      const catalog = catalogStore([unavailable, other], selectedId);
      const networkSocket = socket();
      const request = vi.fn(async () => new Response("{}"));
      const openWebSocket = vi.fn(() => networkSocket);
      const transport = desktopHostTransport({
        catalog,
        network: { openWebSocket, request },
      });
      const selection = {
        deployments: [
          { access: null, id: selectedId, name: "Studio Mac" },
          { id: other.authority.document.deploymentId, name: "Other computer" },
        ],
        selectedDeploymentId: selectedId,
      };

      await expect(transport.selection()).resolves.toMatchObject(selection);
      await expect(get(transport, "/v1/bootstrap")).rejects.toThrow("no live remote access route");
      expect(request).not.toHaveBeenCalled();
      expect(openWebSocket).not.toHaveBeenCalled();

      catalog.replace([live, other], selectedId);
      await transport.selection();
      await transport.openWebSocket(
        7,
        { expectedDeploymentId: selectedId, path: "/v1/realtime" },
        vi.fn(),
      );
      expect(transport.currentKey()).not.toBeNull();

      catalog.replace([unavailable, other], selectedId);
      await expect(transport.selection()).resolves.toMatchObject(selection);
      expect(transport.currentKey()).toBeNull();
      expect(networkSocket.close).toHaveBeenCalledExactlyOnceWith(4_001, "Deployment changed");
      await transport.selection();
      await expect(get(transport, "/v1/bootstrap")).rejects.toThrow("no live remote access route");
      expect(networkSocket.close).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalled();

      catalog.replace([live, other], selectedId);
      await expect(transport.selection()).resolves.toMatchObject({
        deployments: [
          expect.objectContaining({ access: "connect", id: selectedId }),
          expect.anything(),
        ],
        selectedDeploymentId: selectedId,
      });
      await get(transport, "/v1/bootstrap");
      expect(request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ url: `${routeOrigin}/v1/bootstrap` }),
      );
    },
  );

  it("preserves credential failures when refreshing the place list", async () => {
    const selected = deployment("Home", "https://home.opensteer.test");
    const failure = new Error("Host credential store is unavailable");
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      credentials: {
        authorizationHeader: async () => {
          throw failure;
        },
      },
      network: { openWebSocket: () => socket(), request: async () => new Response("{}") },
    });

    await expect(transport.selection()).rejects.toBe(failure);
  });

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
    await transport.openWebSocket(
      7,
      { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
      vi.fn(),
    );

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
    await transport.openWebSocket(
      7,
      { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
      vi.fn(),
    );
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
        deploymentShape: { kind: "personal" },
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

    await transport.openWebSocket(
      7,
      { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
      (event) => received.push(event),
    );
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
      send(fixture.transport, fixture.id, "/v1/bootstrap"),
      send(fixture.transport, fixture.id, "/v1/workspaces"),
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
      const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
      let requests = 0;
      const bodies: string[] = [];
      const recoverUnauthorized = vi.fn(
        () => new Promise<"recovered">((resolve) => setTimeout(() => resolve("recovered"), 25_000)),
      );
      const transport = desktopHostTransport({
        catalog: catalogStore([selected], selected.authority.document.deploymentId),
        network: {
          openWebSocket: () => socket(),
          request: async (input) => {
            if (input.request.body instanceof Uint8Array) bodies.push(input.request.body.join(","));
            return ++requests === 1
              ? new Response('{"error":"unauthorized"}', { status: 401 })
              : new Response('{"ok":true}');
          },
        },
        sessions: { recoverUnauthorized },
      });
      const pending = send(transport, selected.authority.document.deploymentId, "/v1/uploads", {
        body: new Uint8Array([0xff, 0x00, 0xfe]),
        method: "POST",
      });
      const outcome = pending.catch((error: unknown) => error);
      await vi.waitFor(() => expect(recoverUnauthorized).toHaveBeenCalledOnce(), {
        timeout: 1_000,
      });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await outcome).toMatchObject({ body: '{"ok":true}', status: 200 });
      expect(recoverUnauthorized).toHaveBeenCalledTimes(1);
      // Main read the body before the refusal, so the replay carries the same bytes.
      expect(bodies).toEqual(["255,0,254", "255,0,254"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a refused Host response untouched instead of retrying it", async () => {
    const fixture = cloudFixture({ redemptionStatus: 403 });

    await expect(send(fixture.transport, fixture.id, "/v1/bootstrap")).resolves.toMatchObject({
      body: '{"error":"unauthorized"}',
      status: 401,
    });
    await expect(send(fixture.transport, fixture.id, "/v1/bootstrap")).resolves.toMatchObject({
      status: 401,
    });

    expect(fixture.recoverUnauthorized).toHaveBeenCalledTimes(2);
    expect(fixture.hostRequests).toEqual(["/v1/bootstrap", "/v1/bootstrap"]);
  });

  it("does not treat an ambiguous WebSocket failure as authentication evidence", async () => {
    const selected = DeploymentConnectionSchema.parse({
      ...deployment("Cloud", "https://cloud.opensteer.test"),
      kind: "team",
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

    await transport.openWebSocket(
      3,
      { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
      () => undefined,
    );
    events!.close(1_006, "");
    expect(recoverUnauthorized).not.toHaveBeenCalled();

    const owned = await transport.openWebSocket(
      3,
      { expectedDeploymentId: selected.authority.document.deploymentId, path: "/v1/realtime" },
      () => undefined,
    );
    transport.closeWebSocket(3, { connectionId: owned.connectionId });
    events!.close(1_000, "");
    expect(recoverUnauthorized).not.toHaveBeenCalled();
  });

  it("never spends an Account grant for a Deployment that owns its authorization", async () => {
    const fixture = cloudFixture({ kind: "team" });

    await expect(get(fixture.transport, "/v1/bootstrap")).resolves.toMatchObject({ status: 401 });

    expect(fixture.recoverUnauthorized).toHaveBeenCalledOnce();
    expect(fixture.hostRequests).toEqual(["/v1/bootstrap"]);
  });
});

function cloudFixture(
  options: {
    readonly kind?: "personal" | "team";
    readonly redemptionStatus?: number;
  } = {},
) {
  const canonicalOrigin = "https://cloud.opensteer.test";
  const selected = DeploymentConnectionSchema.parse({
    ...deployment("Cloud", canonicalOrigin, options.kind ?? "personal"),
  });
  const hostRequests: string[] = [];
  let sessionActive = false;
  const recoverUnauthorized = vi.fn(async () => {
    if (options.kind === "team") return "unsupported" as const;
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
  return {
    hostRequests,
    id: selected.authority.document.deploymentId,
    recoverUnauthorized,
    selected,
    transport,
  };
}

const routeOrigin = "https://renderer.invalid";

/**
 * Main's Host route as the bundled app's frame reaches it. Electron builds the
 * handler a fresh Request with the same bytes and headers but never the
 * caller's signal, while the caller's own fetch still rejects on its abort.
 */
function routeFetch(
  transport: DesktopHostTransport,
  initiatorOrigin = "app://opensteer",
): typeof globalThis.fetch {
  return async (input, init) => {
    const caller = new Request(input, init);
    const request = Object.assign(
      new Request(caller.url, {
        body: caller.body ? await caller.arrayBuffer() : null,
        headers: caller.headers,
        method: caller.method,
      }),
      { initiatorOrigin },
    );
    const aborted = Promise.withResolvers<never>();
    caller.signal.addEventListener("abort", () => aborted.reject(caller.signal.reason), {
      once: true,
    });
    caller.signal.throwIfAborted();
    return Promise.race([forwardHostRoute(request, transport), aborted.promise]);
  };
}

/** The renderer's preload bridge, as main's handler answers it. */
function cancelBridge(transport: DesktopHostTransport) {
  return {
    cancelHostRequest: async (input: { readonly requestId: string }) =>
      transport.cancelRequest(structuredClone(input)),
  };
}

/** The renderer's own adapter over that route, pinned to one Deployment. */
function hostFetch(transport: DesktopHostTransport, deploymentId: DeploymentId) {
  return createDesktopHostFetch(
    cancelBridge(transport),
    routeOrigin,
    deploymentId,
    routeFetch(transport),
  );
}

async function send(
  transport: DesktopHostTransport,
  deploymentId: DeploymentId,
  path: string,
  init: RequestInit = {},
) {
  const response = await hostFetch(transport, deploymentId)(`${routeOrigin}${path}`, init);
  return { body: await response.text(), headers: response.headers, status: response.status };
}

/** The shared transport alone, for routing and recovery rules that do not depend on the route. */
function get(transport: SharedHostTransport, path: string) {
  return transport.exchange({ headers: {}, method: "GET", path }, async (response) => ({
    body: await response.text(),
    status: response.status,
  }));
}

function deployment(name: string, canonicalOrigin: string, kind: "personal" | "team" = "team") {
  const now = "2026-08-11T10:00:00.000Z";
  return DeploymentConnectionSchema.parse({
    authority: testDiscoveryEnvelope({
      canonicalOrigin,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance") as HostInstanceId,
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        kind,
      },
    }),
    bootstrapMethods: ["password"],
    createdAt: now,
    endpoints: [{ kind: "canonical", origin: canonicalOrigin, verifiedAt: now }],
    kind,
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
  const listeners = new Set<() => void>();
  let catalog = DeploymentCatalogSchema.parse({
    deployments,
    revision: deployments.length ? 1 : 0,
    schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
    selectedDeploymentId,
    updatedAt: deployments.length ? "2026-08-11T10:00:00.000Z" : null,
  });
  return {
    load: async () => catalog,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace: (
      nextDeployments: DeploymentCatalog["deployments"],
      nextSelectedDeploymentId: DeploymentId | null,
    ) => {
      catalog = DeploymentCatalogSchema.parse({
        deployments: nextDeployments,
        revision: catalog.revision + 1,
        schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
        selectedDeploymentId: nextSelectedDeploymentId,
        updatedAt: "2026-08-11T10:02:00.000Z",
      });
      for (const listener of listeners) listener();
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
  readonly observeCommand?: ConstructorParameters<typeof DesktopHostTransport>[0]["observeCommand"];
  readonly withPreparedEnrollment?: ConstructorParameters<
    typeof DesktopHostTransport
  >[0]["withPreparedEnrollment"];
}): DesktopHostTransport {
  const localRuntime = options.localRuntime ?? { current: async () => null };
  return new DesktopHostTransport({
    catalog: options.catalog,
    ...(options.observeCommand ? { observeCommand: options.observeCommand } : {}),
    ...(options.withPreparedEnrollment
      ? { withPreparedEnrollment: options.withPreparedEnrollment }
      : {}),
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

it("keeps a passkey request's origin, options and client data in main", async () => {
  const selected = deployment("Example", "https://deployment.example.test");
  let events: HostNetworkSocketEvents | undefined;
  const transport = desktopHostTransport({
    catalog: catalogStore([selected], selected.authority.document.deploymentId),
    network: {
      openWebSocket: (_input, value) => {
        events = value;
        return socket();
      },
      request: async () => new Response("{}"),
    },
  });
  const sessionId = "bsn_00000000-0000-4000-8000-000000000001";
  const requestId = "00000000-0000-4000-8000-000000000003";
  const main: unknown[] = [];
  const renderer: unknown[] = [];
  const unsubscribe = transport.observeBrowserControl((event) => {
    if (event.type === "message") main.push(event.message);
  });
  try {
    await transport.openWebSocket(
      7,
      {
        expectedDeploymentId: selected.authority.document.deploymentId,
        path: `/v1/browser-sessions/${sessionId}/connect?passkeys=native`,
      },
      (event) => {
        if (event.type === "text") renderer.push(JSON.parse(event.data));
      },
    );
    events!.message(
      JSON.stringify({
        type: "browser.snapshot",
        access: "read-write",
        dialog: null,
        sessionId,
        state: "ready",
        surfaces: [
          { id: "tab", active: true, title: "Example", url: "https://login.example.test" },
        ],
        passkeys: "native",
        passkeyConsumerToken: requestId,
      }),
    );
    const request = {
      type: "browser.passkey.request",
      requestId,
      ceremonyId: requestId,
      surfaceId: "tab",
      documentId: "document",
      op: "get",
      origin: "https://login.example.test",
      rpId: "example.test",
      options: {
        challenge: "AQID",
        allowCredentials: [],
        userVerification: "preferred",
        extensions: {},
      },
      clientDataJSON: "AQID",
      cause: { person: requestId },
      deadline: Date.now() + 10_000,
    };
    events!.message(JSON.stringify(request));
    expect(main.at(-1)).toMatchObject({ type: "browser.passkey.request", requestId });
    // The renderer learns only that this request's offer ended; main presents it.
    expect(renderer.at(-1)).toEqual({ type: "browser.passkey.withdrawn", requestId });
  } finally {
    unsubscribe();
    transport.closeAllSockets();
  }
});

it("holds passkey messages in main before renderer delivery and binds native input to the admitted surface", async () => {
  const selected = deployment("Example", "https://deployment.example.test");
  let events: HostNetworkSocketEvents | undefined;
  const wire = socket();
  const send = vi.spyOn(wire, "send");
  const transport = desktopHostTransport({
    catalog: catalogStore([selected], selected.authority.document.deploymentId),
    network: {
      openWebSocket: (_input, value) => {
        events = value;
        return wire;
      },
      request: async () => new Response("{}"),
    },
  });
  const trace: string[] = [];
  const sessionId = "bsn_00000000-0000-4000-8000-000000000001";
  const token = "00000000-0000-4000-8000-000000000002";
  const unsubscribe = transport.observeBrowserControl((event) => {
    if (event.type === "message") trace.push("main");
  });
  try {
    const { connectionId } = await transport.openWebSocket(
      7,
      {
        expectedDeploymentId: selected.authority.document.deploymentId,
        path: `/v1/browser-sessions/${sessionId}/connect?passkeys=native`,
      },
      (event) => {
        if (event.type === "text") trace.push("renderer");
      },
    );
    events!.message(
      JSON.stringify({
        type: "browser.snapshot",
        access: "read-write",
        dialog: null,
        sessionId,
        state: "ready",
        surfaces: [
          { id: "tab", active: true, title: "Example", url: "https://login.example.test" },
        ],
        passkeys: "native",
        passkeyConsumerToken: token,
        consumerToken: token,
      }),
    );
    expect(trace).toEqual(["main", "renderer"]);
    expect(transport.passkeyConsumerToken(7, connectionId, "tab")).toBeNull();
    expect(transport.viewerConsumerToken(7, connectionId, "tab")).toBeNull();
    transport.sendWebSocket(7, {
      connectionId,
      type: "text",
      data: JSON.stringify({ type: "stream.subscribe", surfaceId: "tab" }),
    });
    expect(transport.passkeyConsumerToken(7, connectionId, "tab")).toBe(token);
    expect(transport.passkeyConsumerToken(8, connectionId, "tab")).toBeNull();
    expect(transport.passkeyConsumerToken(7, connectionId, "other")).toBeNull();
    expect(transport.viewerConsumerToken(7, connectionId, "tab")).toBe(token);
    expect(transport.viewerConsumerToken(8, connectionId, "tab")).toBeNull();
    expect(transport.viewerConsumerToken(7, connectionId, "other")).toBeNull();
    const claim = { type: "passkey.claim" as const, requestId: token };
    expect(() =>
      transport.sendWebSocket(7, { connectionId, type: "text", data: JSON.stringify(claim) }),
    ).toThrow("desktop main");
    transport.sendBrowserControl(7, connectionId, claim);
    expect(send).toHaveBeenLastCalledWith(JSON.stringify(claim));
    transport.sendWebSocket(7, {
      connectionId,
      type: "text",
      data: JSON.stringify({ type: "stream.unsubscribe", surfaceId: "tab" }),
    });
    expect(transport.passkeyConsumerToken(7, connectionId, "tab")).toBeNull();
  } finally {
    unsubscribe();
    transport.closeAllSockets();
  }
});

it("streams an app POST and SSE through the selected route without credentials or replay, keeping cancellation until body end", async () => {
  const selected = deployment("Home", "https://home.connect.opensteer.test");
  const abort = new AbortController();
  let received!: HostNetworkRequest;
  let chunks!: ReadableStreamDefaultController<Uint8Array>;
  const recoverUnauthorized = vi.fn();
  const transport = desktopHostTransport({
    catalog: catalogStore([selected], selected.authority.document.deploymentId),
    sessions: { recoverUnauthorized } as unknown as HostSessionRecovery,
    network: {
      openWebSocket: () => socket(),
      request: async (input) => {
        received = input;
        return new Response(
          new ReadableStream({
            start(controller) {
              chunks = controller;
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  });
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"x":1}'));
      c.close();
    },
  });
  const response = await transport.streamApp({
    path: `/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/api/`,
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    signal: abort.signal,
  });
  expect(received.authorization).toBeNull();
  expect(received.request.credentials).toBe("omit");
  expect(received.request.redirect).toBe("manual");
  expect(received.request.body).toBe(body);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
  expect(received.signal.aborted).toBe(false);
  const next = reader.read();
  abort.abort();
  await expect(next).rejects.toThrow();
  expect(received.signal.aborted).toBe(true);
  expect(recoverUnauthorized).not.toHaveBeenCalled();
  void chunks;
});

it("does not replay a streamed app POST on 401 and fences an open response when the selected Host changes", async () => {
  const first = deployment("First", "https://first.connect.opensteer.test");
  const second = deployment("Second", "https://second.connect.opensteer.test");
  const catalog = catalogStore([first, second], first.authority.document.deploymentId);
  const recoverUnauthorized = vi.fn();
  let refuse = true;
  let requestSignal!: AbortSignal;
  const networkRequest = vi.fn(async (input: HostNetworkRequest) => {
    requestSignal = input.signal;
    return refuse
      ? new Response("Unauthorized", { status: 401 })
      : new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: first\n\n"));
            },
          }),
        );
  });
  const transport = desktopHostTransport({
    catalog,
    sessions: { recoverUnauthorized } as unknown as HostSessionRecovery,
    network: { openWebSocket: () => socket(), request: networkRequest },
  });
  const path = `/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/api/`;
  const denied = await transport.streamApp({
    path,
    method: "POST",
    headers: {},
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    }),
  });
  expect(denied.status).toBe(401);
  expect(await denied.text()).toBe("Unauthorized");
  expect(networkRequest).toHaveBeenCalledTimes(1);
  expect(recoverUnauthorized).not.toHaveBeenCalled();
  refuse = false;
  const response = await transport.streamApp({ path, method: "GET", headers: {} });
  const reader = response.body!.getReader();
  await reader.read();
  const next = reader.read();
  const rejected = expect(next).rejects.toMatchObject({ code: "deployment-changed" });
  await catalog.select(second.authority.document.deploymentId);
  await transport.selection();
  await rejected;
  expect(requestSignal.aborted).toBe(true);
});

it("keeps idle app SSE open beyond the ordinary response-stall deadline", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  try {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    let requestSignal!: AbortSignal;
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      network: {
        openWebSocket: () => socket(),
        request: async (input) => {
          requestSignal = input.signal;
          return new Response(
            new ReadableStream({
              start(c) {
                upstream = c;
              },
            }),
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        },
      },
    });
    const response = await transport.streamApp({
      path: `/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/events`,
      method: "GET",
      headers: {},
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const first = reader.read();
    void first.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestSignal.aborted).toBe(false);
    upstream.enqueue(new TextEncoder().encode("data: awake\n\n"));
    expect(new TextDecoder().decode((await first).value)).toBe("data: awake\n\n");
    const next = reader.read();
    abort.abort();
    await expect(next).rejects.toThrow();
    expect(requestSignal.aborted).toBe(true);
  } finally {
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("bounds app streams independently so a full app pool leaves ordinary Host requests available", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const responses: Response[] = [];
  try {
    const selected = deployment("Home", "https://home.connect.opensteer.test");
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], selected.authority.document.deploymentId),
      network: {
        openWebSocket: () => socket(),
        request: async (input) =>
          input.request.path.startsWith("/v1/apps/")
            ? new Response(new ReadableStream<Uint8Array>(), {
                headers: { "content-type": "text/event-stream" },
              })
            : new Response("ordinary response"),
      },
    });
    const appRequest = {
      path: `/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/events`,
      method: "GET",
      headers: {},
      signal: abort.signal,
    };
    for (let index = 0; index < 32; index++) responses.push(await transport.streamApp(appRequest));
    expect(
      await send(transport, selected.authority.document.deploymentId, "/v1/rpc/auth.config"),
    ).toMatchObject({ status: 200, body: "ordinary response" });
    await expect(transport.streamApp(appRequest)).rejects.toThrow(/app.*limit/i);

    await vi.advanceTimersByTimeAsync(60_000);
  } finally {
    abort.abort();
    await Promise.all(responses.map((response) => response.body?.cancel().catch(() => undefined)));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("refuses a return proof when main selects B before processing renderer A's request", async () => {
  const first = deployment("A", "https://a.example.test", "personal");
  const second = deployment("B", "https://b.example.test");
  const deploymentId = first.authority.document.deploymentId;
  const catalog = catalogStore([first, second], deploymentId);
  const request = vi.fn(async () => new Response("{}"));
  const transport = desktopHostTransport({
    catalog,
    network: { request, openWebSocket: () => socket() },
  });
  await transport.current();
  const fetch = createDesktopHostFetch(
    cancelBridge(transport),
    first.authority.document.canonicalOrigin,
    deploymentId,
    routeFetch(transport),
  );
  await catalog.select(second.authority.document.deploymentId);
  try {
    await expect(
      fetch(new URL("/v1/rpc/commands.dispatch", first.authority.document.canonicalOrigin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "integration.authorization.return",
          returnProof: "r".repeat(43),
        }),
      }),
    ).rejects.toMatchObject({ code: "deployment-changed" });
    expect(request).not.toHaveBeenCalled();
    await catalog.select(deploymentId);
    await expect(
      fetch(new URL("/v1/rpc/commands.dispatch", first.authority.document.canonicalOrigin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "integration.authorization.return",
          returnProof: "r".repeat(43),
        }),
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deploymentId }));
  } finally {
    transport.closeAllSockets();
  }
});

describe("Desktop Host route", () => {
  it("delivers a file's exact bytes and content headers, and uploads exact bytes", async () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
    const id = selected.authority.document.deploymentId;
    // Not valid UTF-8 and larger than any IPC chunk: a text path would refuse or alter it.
    const image = Uint8Array.from(
      { length: 512 * 1_024 + 7 },
      (_, index) => (index * 37 + 0x80) & 255,
    );
    image.set([0xef, 0xbb, 0xbf], 0);
    const requests: HostNetworkRequest[] = [];
    const uploads: Uint8Array[] = [];
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], id),
      network: {
        openWebSocket: () => socket(),
        request: async (input) => {
          requests.push(input);
          if (input.request.path.startsWith("/v1/rpc/attachment.upload")) {
            uploads.push(input.request.body as Uint8Array);
            return Response.json({ ok: false, error: { code: "conflict", message: "seen" } });
          }
          return new Response(image, {
            headers: {
              "content-type": "image/png",
              etag: '"rev-1"',
              "last-modified": "Tue, 17 Nov 2026 10:00:00 GMT",
              "set-cookie": "host-session=secret; HttpOnly",
              "x-opensteer-file-size": String(image.byteLength),
            },
          });
        },
      },
    });
    const rpc = createHttpHostApiClient({
      baseUrl: new URL(routeOrigin),
      fetch: hostFetch(transport, id),
      onAuthenticationRequired: () => undefined,
    });
    try {
      const file = await rpc["file.content"]({
        threadId: null,
        resource: { kind: "home", key: "Pictures/screenshot.png", revision: "rev-1" },
      });
      expect(file.ok, file.ok ? "" : file.error.message).toBe(true);
      if (!file.ok) return;
      expect(Buffer.from(file.data.bytes).equals(image)).toBe(true);
      expect(file.data.metadata).toMatchObject({
        contentType: "image/png",
        etag: '"rev-1"',
        modifiedAt: "2026-11-17T10:00:00.000Z",
        sizeBytes: image.byteLength,
      });
      const raw = await hostFetch(transport, id)(`${routeOrigin}/v1/rpc/file.content?input=%7B%7D`);
      expect(raw.headers.get("set-cookie")).toBeNull();
      expect(raw.headers.get("content-security-policy")).toContain("sandbox");
      await raw.body?.cancel();

      await rpc["attachment.upload"](
        { attachmentId: createId("attachment") },
        { body: new Blob([image]) },
      );
      expect(uploads).toHaveLength(1);
      expect(Buffer.from(uploads[0]!).equals(image)).toBe(true);
      expect(requests.at(-1)!.request.headers.contentType).toBe("application/octet-stream");
    } finally {
      transport.dispose();
    }
  });

  it.each(["before headers", "mid-body"] as const)(
    "aborts the Host request when the renderer cancels %s",
    async (stage) => {
      const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
      const id = selected.authority.document.deploymentId;
      const headers = Promise.withResolvers<Response>();
      let upstream: AbortSignal | undefined;
      const transport = desktopHostTransport({
        catalog: catalogStore([selected], id),
        network: {
          openWebSocket: () => socket(),
          request: async (input) => {
            upstream = input.signal;
            return headers.promise;
          },
        },
      });
      try {
        const controller = new AbortController();
        const pending = hostFetch(transport, id)(
          `${routeOrigin}/v1/rpc/file.content?input=%7B%7D`,
          {
            signal: controller.signal,
          },
        );
        await vi.waitFor(() => expect(upstream).toBeDefined(), { timeout: 1_000 });
        if (stage === "before headers") {
          controller.abort(new Error("Viewer closed"));
          await expect(pending).rejects.toThrow("Viewer closed");
        } else {
          headers.resolve(new Response(new ReadableStream<Uint8Array>({ start: () => undefined })));
          await (await pending).body!.cancel();
        }
        await vi.waitFor(() => expect(upstream!.aborted).toBe(true), { timeout: 1_000 });
      } finally {
        headers.resolve(new Response(null));
        transport.dispose();
      }
    },
  );
});

describe("Desktop Host route admission", () => {
  const fixture = () => {
    const selected = deployment("Home", "https://home.connect.opensteer.test", "personal");
    const id = selected.authority.document.deploymentId;
    const gate = Promise.withResolvers<void>();
    const request = vi.fn(async (_input: HostNetworkRequest) => {
      await gate.promise;
      return Response.json({ ok: true, data: {} });
    });
    const transport = desktopHostTransport({
      catalog: catalogStore([selected], id),
      network: { openWebSocket: () => socket(), request },
    });
    const route = (path: string, init: RequestInit = {}, requestId: string = crypto.randomUUID()) =>
      forwardHostRoute(
        Object.assign(
          new Request(`app://opensteer/host/${id}${path}`, {
            ...init,
            headers: { ...init.headers, [desktopHostRequestIdHeader]: requestId },
          }),
          { initiatorOrigin: "app://opensteer" },
        ),
        transport,
      );
    return { gate, id, request, route, transport };
  };
  /** A body as Electron builds one from a Blob: its bytes arriving as one chunk. */
  const electronBody = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  const upload = (bytes: Uint8Array | ReadableStream<Uint8Array>) =>
    ({
      body: bytes,
      duplex: "half",
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
    }) as RequestInit;

  it("refuses a request its renderer already cancelled, or one it can't cancel, before sending it", async () => {
    const { gate, request, route, transport } = fixture();
    gate.resolve();
    try {
      const requestId = crypto.randomUUID();
      // The cancel overtook its request on the way to main.
      transport.cancelRequest({ requestId });
      const cancelled = await route("/v1/rpc/bootstrap.get", {}, requestId);
      expect(cancelled.headers.get(desktopHostTransportErrorHeader)).toBe("cancelled");
      expect((await route("/v1/rpc/bootstrap.get", {}, "not-an-id")).status).toBe(400);
      expect(request).not.toHaveBeenCalled();
    } finally {
      transport.dispose();
    }
  });

  it("bounds each body by its route's Host limit and refuses an oversized one as the Host would", async () => {
    const { gate, request, route, transport } = fixture();
    gate.resolve();
    try {
      const tooLarge = await route("/v1/rpc/commands.dispatch", {
        body: "x".repeat(1_024 * 1_024 + 1),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({
        ok: false,
        error: { code: "bad_request", retryable: false },
      });
      // An attachment larger than any JSON body is within its own route's limit, and the
      // bytes Electron handed over are the replayable body itself, not a copy of them.
      const bytes = new Uint8Array(2 * 1_024 * 1_024);
      const uploaded = await route(
        `/v1/rpc/attachment.upload?input=${encodeURIComponent('{"attachmentId":"a"}')}`,
        upload(electronBody(bytes)),
      );
      expect(uploaded.status).toBe(200);
      await uploaded.body?.cancel();
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]![0].request.body).toBe(bytes);
    } finally {
      transport.dispose();
    }
  });

  it("refuses a request over this client's own limit as busy, never as an unreachable Host", async () => {
    const { gate, request, route, transport } = fixture();
    try {
      const held = Array.from({ length: 32 }, () => route("/v1/rpc/bootstrap.get"));
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(32), { timeout: 1_000 });
      const refused = await route("/v1/rpc/bootstrap.get");
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({
        ok: false,
        error: { code: "resource_exhausted", retryable: true },
      });
      expect(request).toHaveBeenCalledTimes(32);
      gate.resolve();
      for (const response of await Promise.all(held)) expect(response.status).toBe(200);
    } finally {
      gate.resolve();
      transport.dispose();
    }
  });

  it("starts a queued upload's wait for its answer only once it is sent, and bounds it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { id, request, transport } = fixture();
    try {
      // The bundled app's own client, as desktop-app.tsx makes it, over the real adapter.
      const rpc = createHttpHostApiClient({
        baseUrl: new URL(routeOrigin),
        fetch: hostFetch(transport, id),
        onAuthenticationRequired: () => undefined,
        pacedUploads: true,
      });
      const settled: unknown[] = [];
      const sent = Array.from({ length: desktopHostUploadConcurrency + 1 }, (_, index) =>
        rpc["attachment.upload"](
          { attachmentId: createId("attachment") },
          { body: new Blob(["bytes"]) },
        ).then((result) => {
          settled[index] = result;
          return result;
        }),
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(desktopHostUploadConcurrency), {
        timeout: 1_000,
      });
      // Well past what a 5-byte upload's own clock would allow: the queued one is still waiting.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      for (const result of await Promise.all(sent.slice(0, desktopHostUploadConcurrency)))
        expect(result).toMatchObject({ ok: false, error: { reason: "transport-timed-out" } });
      await vi.waitFor(
        () => expect(request).toHaveBeenCalledTimes(desktopHostUploadConcurrency + 1),
        { timeout: 1_000 },
      );
      expect(settled[desktopHostUploadConcurrency]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await sent.at(-1)).toMatchObject({
        ok: false,
        error: { reason: "transport-timed-out" },
      });
    } finally {
      vi.useRealTimers();
      transport.dispose();
    }
  });

  it("ends a forwarded request when its page goes, the transport is disposed, or its body stalls", async () => {
    const { request, route, transport } = fixture();
    try {
      const abandoned = route("/v1/rpc/bootstrap.get");
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce(), { timeout: 1_000 });
      transport.cancelForwardedRequests();
      expect((await abandoned).headers.get(desktopHostTransportErrorHeader)).toBe("cancelled");
      expect(request.mock.calls[0]![0].signal.aborted).toBe(true);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stalled = route("/v1/rpc/attachment.upload", upload(new ReadableStream()));
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await stalled).headers.get(desktopHostTransportErrorHeader)).toBe("timed-out");
      vi.useRealTimers();

      const disposed = route("/v1/rpc/bootstrap.get");
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2), { timeout: 1_000 });
      transport.dispose();
      expect((await disposed).headers.get(desktopHostTransportErrorHeader)).toBe("cancelled");
      expect(request.mock.calls[1]![0].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      transport.dispose();
    }
  });
});

describe("joined team routing", () => {
  it("pins RPC, sockets and file bytes to each team while Personal selection changes", async () => {
    const personal = deployment("Personal", "http://127.0.0.1:4310", "personal");
    const other = deployment("Other Personal", "http://127.0.0.1:4311", "personal");
    const teams = [
      deployment("Acme", "https://acme.example"),
      deployment("Family", "https://family.example"),
    ];
    const catalog = catalogStore(
      [personal, other, ...teams],
      personal.authority.document.deploymentId,
    );
    const requests: HostNetworkRequest[] = [];
    const sockets: {
      input: Omit<HostNetworkRequest, "request" | "signal">;
      network: ReturnType<typeof socket>;
    }[] = [];
    const transport = desktopHostTransport({
      catalog,
      credentials: {
        authorizationHeader: async (connection) =>
          `Bearer credential-${connection.authority.document.deploymentId}`,
      },
      network: {
        request: async (input) => {
          requests.push(input);
          return new Response(
            input.request.body instanceof Uint8Array ? input.request.body : "team-file",
          );
        },
        openWebSocket: (input) => {
          const network = socket();
          sockets.push({ input, network });
          return network;
        },
      },
    });
    try {
      for (const team of teams) {
        const expectedDeploymentId = team.authority.document.deploymentId;
        const origin = team.authority.document.canonicalOrigin;
        const fetch = hostFetch(transport, expectedDeploymentId);
        const version = { [teamApiVersionHeader]: "999" };
        await fetch(`${routeOrigin}/v1/rpc/team.bootstrap`, { headers: version });
        await transport.openWebSocket(7, { expectedDeploymentId, path: "/v1/realtime" }, vi.fn());
        const download = await fetch(`${routeOrigin}/v1/team/files/file_1/original`, {
          headers: version,
        });
        expect(await download.text()).toBe("team-file");
        const metadata = '{"filename":"example.txt"}';
        const upload = await fetch(`${routeOrigin}/v1/team/files/upload/channel_1`, {
          body: new Blob(["uploaded-file"]),
          headers: {
            ...version,
            "content-type": "application/octet-stream",
            "x-opensteer-team-upload": metadata,
          },
          method: "POST",
        });
        expect(upload.status).toBe(200);
        expect(await upload.text()).toBe("uploaded-file");
        const routed = requests.filter((input) => input.deploymentId === expectedDeploymentId);
        expect(routed).toHaveLength(3);
        for (const input of routed) {
          expect(input.url).toBe(origin + input.request.path);
          expect(input.authorization).toBe(`Bearer credential-${expectedDeploymentId}`);
          expect(input.request.headers).toMatchObject({
            additional: { [teamApiVersionHeader]: String(teamApiVersion) },
          });
          expect(input.request.headers.apiVersion).toBeUndefined();
        }
        expect(routed[2]!.request.headers.additional).toMatchObject({
          "x-opensteer-team-upload": metadata,
        });
        // A team Host fetches a partner's file before it answers; other reads keep the usual wait.
        expect(routed.map(({ request }) => request.timeoutMs)).toEqual([
          undefined,
          120_000,
          120_000,
        ]);
        expect(sockets.at(-1)!.input).toMatchObject({
          deploymentId: expectedDeploymentId,
          authorization: `Bearer credential-${expectedDeploymentId}`,
          url: `${origin.replace("https:", "wss:")}/v1/realtime?opensteer_api_version=${teamApiVersion}`,
          headers: { [teamApiVersionHeader]: String(teamApiVersion) },
        });
      }
      await transport.select({ deploymentId: other.authority.document.deploymentId });
      expect(sockets.every(({ network }) => network.close.mock.calls.length === 0)).toBe(true);
      await send(transport, other.authority.document.deploymentId, "/v1/rpc/bootstrap.get");
      expect(requests.at(-1)!.deploymentId).toBe(other.authority.document.deploymentId);
      for (const team of teams)
        await send(transport, team.authority.document.deploymentId, "/v1/rpc/team.bootstrap");
      expect(sockets.every(({ network }) => network.close.mock.calls.length === 0)).toBe(true);
    } finally {
      transport.dispose();
    }
    expect(sockets.every(({ network }) => network.close.mock.calls.length === 1)).toBe(true);
  });

  it("reads only pinned summary RPCs from another personal computer without selecting it or opening a socket", async () => {
    const first = deployment("Home", "https://home.example.test", "personal");
    const second = deployment("Work", "https://work.example.test", "personal");
    const catalog = catalogStore([first, second], first.authority.document.deploymentId);
    const requested: string[] = [];
    const network = {
      request: vi.fn(async ({ url }: HostNetworkRequest) => {
        requested.push(String(url));
        return Response.json({
          ok: true,
          data: new URL(url).pathname.endsWith("attention.get")
            ? { needsYou: 3, unread: true }
            : { links: [] },
        });
      }),
      openWebSocket: vi.fn(() => socket()),
    };
    const transport = desktopHostTransport({ catalog, network });
    try {
      const expectedDeploymentId = second.authority.document.deploymentId;
      await expect(
        readComputerFacts(
          cancelBridge(transport),
          {
            id: expectedDeploymentId,
            canonicalOrigin: second.authority.document.canonicalOrigin,
          } as DeploymentAccessDeployment,
          routeFetch(transport),
        ),
      ).resolves.toEqual({ homeName: null, needsYou: 3, unread: true, teams: [] });
      expect(network.request.mock.calls.map(([request]) => request.request.method)).toEqual([
        "POST",
        "POST",
      ]);
      expect(requested).toEqual([
        "https://work.example.test/v1/rpc/attention.get",
        "https://work.example.test/v1/rpc/teams.links.list",
      ]);
      expect((await catalog.load()).selectedDeploymentId).toBe(
        first.authority.document.deploymentId,
      );
      expect(network.openWebSocket).not.toHaveBeenCalled();
      await expect(
        send(transport, expectedDeploymentId, "/v1/rpc/tasks.list"),
      ).rejects.toMatchObject({ code: "deployment-changed" });
      await expect(
        send(transport, expectedDeploymentId, "/v1/rpc/attention.get"),
      ).rejects.toMatchObject({ code: "deployment-changed" });
      expect(network.request).toHaveBeenCalledTimes(2);
    } finally {
      transport.dispose();
    }
  });

  it("refuses missing team pins and Personal deployment mismatches before opening any network traffic", async () => {
    const first = deployment("Personal A", "http://127.0.0.1:4310", "personal");
    const second = deployment("Personal B", "http://127.0.0.1:4311", "personal");
    const network = {
      request: vi.fn(async () => new Response("{}")),
      openWebSocket: vi.fn(() => socket()),
    };
    const transport = desktopHostTransport({
      catalog: catalogStore([first, second], first.authority.document.deploymentId),
      network,
    });
    try {
      for (const expectedDeploymentId of [
        createId("deployment"),
        second.authority.document.deploymentId,
      ]) {
        await expect(
          send(transport, expectedDeploymentId, "/v1/rpc/bootstrap.get"),
        ).rejects.toMatchObject({ code: "deployment-changed" });
        await expect(
          transport.openWebSocket(7, { expectedDeploymentId, path: "/v1/realtime" }, vi.fn()),
        ).rejects.toMatchObject({ code: "deployment-changed" });
      }
      expect(network.request).not.toHaveBeenCalled();
      expect(network.openWebSocket).not.toHaveBeenCalled();
    } finally {
      transport.dispose();
    }
  });
});

it("refuses a pinned Personal socket if selection changes during the final credential resolution", async () => {
  const first = deployment("Personal A", "http://127.0.0.1:4310", "personal");
  const second = deployment("Personal B", "http://127.0.0.1:4311", "personal");
  const catalog = catalogStore([first, second], first.authority.document.deploymentId);
  let reads = 0;
  const openWebSocket = vi.fn(() => socket());
  const transport = desktopHostTransport({
    catalog,
    network: { request: async () => new Response("{}"), openWebSocket },
    credentials: {
      authorizationHeader: async () => {
        if (++reads === 1) await catalog.select(second.authority.document.deploymentId);
        return "Bearer fixture";
      },
    },
  });
  try {
    await expect(
      transport.openWebSocket(
        7,
        { expectedDeploymentId: first.authority.document.deploymentId, path: "/v1/realtime" },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "deployment-changed" });
    expect(openWebSocket).not.toHaveBeenCalled();
  } finally {
    transport.dispose();
  }
});

it("closes only the removed team's live sockets after its catalog attachment disappears", async () => {
  const personal = deployment("Personal", "http://127.0.0.1:4310", "personal");
  const first = deployment("Acme", "https://acme.example");
  const second = deployment("Family", "https://family.example");
  const catalog = catalogStore([personal, first, second], personal.authority.document.deploymentId);
  const sockets = new Map<string, ReturnType<typeof socket>>();
  const transport = desktopHostTransport({
    catalog,
    network: {
      request: async () => new Response("{}"),
      openWebSocket: (input) => {
        const network = socket();
        sockets.set(input.deploymentId, network);
        return network;
      },
    },
  });
  try {
    for (const team of [first, second])
      await transport.openWebSocket(
        7,
        { expectedDeploymentId: team.authority.document.deploymentId, path: "/v1/realtime" },
        vi.fn(),
      );
    catalog.replace([personal, second], personal.authority.document.deploymentId);
    await vi.waitFor(
      () => expect(sockets.get(first.authority.document.deploymentId)!.close).toHaveBeenCalled(),
      { timeout: 1_000 },
    );
    expect(sockets.get(second.authority.document.deploymentId)!.close).not.toHaveBeenCalled();
  } finally {
    transport.dispose();
  }
});
