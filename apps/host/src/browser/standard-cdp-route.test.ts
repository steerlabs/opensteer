import websocket from "@fastify/websocket";
import { createId } from "@opensteer/core";
import { createBrowserSessionId } from "@opensteer/protocol";
import {
  standardCdpMaxPending,
  standardCdpMessageMaxBytes,
} from "@opensteer/protocol/standard-cdp";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { get } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { installPersonalVersionGate } from "../server/host-api-registration.js";
import { installHostHttpBoundary } from "../server/host-http-boundary.js";
import { BrowserCdpConnectionEnded } from "./browser-service.js";
import { registerStandardCdpRoute, standardCdpRecheckMs } from "./standard-cdp-route.js";
import {
  StandardCdpTickets,
  standardCdpConnectPrefix,
  type StandardCdpPoolReservation,
  type StandardCdpTicketClaims,
} from "./standard-cdp-tickets.js";

const claims: StandardCdpTicketClaims = {
  authority: { agentBindingId: `run:${createId("run")}`, ownerId: createId("user") },
  browserSessionId: createBrowserSessionId(),
  mode: "session",
  facts: {
    profileId: null,
    profileBindingId: null,
    runtimeId: "runtime",
    placementKey: "device",
    grantRevision: 7,
    agentConnectionId: "external",
  },
};

function pooledTicket() {
  return {
    target: {
      runnerId: createId("runner"),
      runtimeId: "pool-runtime",
      slotId: "slot",
      instanceId: "pool-instance",
      term: 1,
      epoch: 1,
    },
    release: vi.fn(),
  } satisfies StandardCdpPoolReservation;
}

it("stores only a digest, binds the full claims and admits exactly one concurrent consume", async () => {
  const storage = new Map<string, { claims: StandardCdpTicketClaims; expiresAt: number }>();
  let now = 42_000;
  const tickets = new StandardCdpTickets(() => now, storage);
  const ticket = tickets.issue({
    ...claims,
    authority: { ...claims.authority, environmentId: createId("environment") },
  });
  expect(Buffer.from(ticket, "base64url")).toHaveLength(32);
  expect([...storage.entries()]).toEqual([
    [createHash("sha256").update(ticket).digest("hex"), { claims, expiresAt: 102_000 }],
  ]);
  expect(JSON.stringify([...storage])).not.toContain(ticket);
  const attempts = await Promise.all(
    [1, 2].map(async () => {
      await Promise.resolve();
      return tickets.consume(ticket);
    }),
  );
  expect(attempts).toEqual([claims, undefined]);
  const expiring = tickets.issue({ ...claims, ttl: 100 });
  now += 100;
  expect(tickets.consume(expiring)).toBeUndefined();
  expect(() => tickets.issue({ ...claims, ttl: 300_001 })).toThrow("five minutes");
  const revoked = tickets.issue(claims);
  tickets.revoke(claims.authority.agentBindingId);
  expect(tickets.consume(revoked)).toBeUndefined();
});

it("releases an unconsumed pooled CDP ticket on expiry and on a binding cut", async () => {
  vi.useFakeTimers();
  const tickets = new StandardCdpTickets();
  const expired = pooledTicket();
  const revoked = pooledTicket();
  const expiration = tickets.issue({ ...claims, ttl: 20 }, expired);
  const cut = tickets.issue(claims, revoked);
  await vi.advanceTimersByTimeAsync(20);
  expect(tickets.consumeForUpgrade(expiration)).toBeUndefined();
  expect(expired.release).toHaveBeenCalledOnce();
  tickets.revoke(claims.authority.agentBindingId);
  expect(tickets.consumeForUpgrade(cut)).toBeUndefined();
  expect(revoked.release).toHaveBeenCalledOnce();
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const tickets = new StandardCdpTickets();
  const runtime = new AbortController();
  const received = Promise.withResolvers<Buffer>();
  const admitted = Promise.withResolvers<void>();
  const send = vi.fn(async (frame: Buffer) => received.resolve(frame));
  const reauthorize = vi.fn(async () => {});
  let read: ((frame: Buffer) => void) | undefined;
  const attach = vi.fn(
    async (
      _claims: StandardCdpTicketClaims,
      signal: AbortSignal,
      _admission?: AbortSignal,
      _pool?: StandardCdpPoolReservation,
    ) => {
      admitted.resolve();
      signal.addEventListener("abort", () => runtime.abort(), { once: true });
      return {
        signal: runtime.signal,
        mode: "session" as const,
        settled: runtime.signal.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) =>
              runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
            ),
        reauthorize,
        send,
        onFrame: (listener: (frame: Buffer) => void) => {
          read = listener;
        },
        close: () => runtime.abort(),
      };
    },
  );
  const app = Fastify();
  installPersonalVersionGate(app);
  installHostHttpBoundary(app);
  await app.register(websocket, { options: { maxPayload: standardCdpMessageMaxBytes } });
  registerStandardCdpRoute(app, { standardCdpTickets: tickets, attachStandardCdpForAgent: attach });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const sockets: WebSocket[] = [];
  cleanup.push(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
  });
  const connect = async (token = tickets.issue(claims)) => {
    const socket = new WebSocket(
      `${address.replace(/^http/u, "ws")}${standardCdpConnectPrefix}${token}`,
      { headers: { origin: "https://other.invalid", cookie: "ambient=ignored" } },
    );
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  };
  return {
    address,
    app,
    connect,
    tickets,
    attach,
    send,
    reauthorize,
    runtime,
    received,
    admitted,
    emit: (frame: Buffer) => read?.(frame),
  };
}

it("transfers the same pooled reservation into the upgrade and keeps it during pending attach cleanup", async () => {
  const f = await fixture();
  const hold = pooledTicket();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  f.attach.mockImplementationOnce(async (_claims, signal, _admission, reserve) => {
    expect(reserve).toBe(hold);
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    entered.resolve();
    try {
      await finish.promise;
      signal.throwIfAborted();
      throw new Error("Expected the upgrading client to close.");
    } finally {
      reserve!.release();
      released.resolve();
    }
  });
  const ticket = f.tickets.issue(claims, hold);
  const socket = await f.connect(ticket);
  try {
    await entered.promise;
    socket.send('{"id":1,"method":"Browser.getVersion"}');
    await expect(f.connect(ticket)).rejects.toThrow("Unexpected server response: 401");
    const closed = once(socket, "close");
    socket.close();
    await Promise.all([closed, cancelled.promise]);
    expect(hold.release).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await released.promise;
  }
  expect(hold.release).toHaveBeenCalledOnce();
});

it("releases a pooled reservation when the WebSocket upgrade fails", async () => {
  const f = await fixture();
  const hold = pooledTicket();
  const ticket = f.tickets.issue(claims, hold);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = get(
      new URL(`${standardCdpConnectPrefix}${ticket}`, f.address),
      {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "invalid-key",
          "sec-websocket-version": "13",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
  });
  expect(status).toBe(400);
  await vi.waitFor(() => expect(hold.release).toHaveBeenCalledOnce());
  expect(f.attach).not.toHaveBeenCalled();
});

it("releases the pooled reservation on upgrade capacity refusal", async () => {
  const f = await fixture();
  for (let n = 0; n < 4; n++) await f.connect();
  const hold = pooledTicket();
  const socket = await f.connect(f.tickets.issue(claims, hold));
  expect((await once(socket, "close"))[0]).toBe(1013);
  expect(hold.release).toHaveBeenCalledOnce();
  expect(f.attach).toHaveBeenCalledTimes(4);
});

it("relays original text and refuses replay even with ambient credentials", async () => {
  const f = await fixture();
  const ticket = f.tickets.issue(claims);
  const socket = await f.connect(ticket);
  const command = '{ "id": 41, "method":"Browser.getVersion" }';
  socket.send(command);
  expect(String(await f.received.promise)).toBe(command);
  expect(f.attach.mock.calls[0]?.[0]).toEqual(claims);
  const answer = once(socket, "message");
  const response = '{ "id":41, "result":{ "empty": true } }';
  f.emit(Buffer.from(response));
  expect(String((await answer)[0])).toBe(response);
  await expect(f.connect(ticket)).rejects.toThrow("Unexpected server response: 401");
  const responseHttp = await f.app.inject({
    method: "GET",
    url: `${standardCdpConnectPrefix}${ticket}`,
  });
  expect(responseHttp.statusCode).toBe(426);
  expect(responseHttp.body).not.toContain(ticket);
});

it("delivers an admission refusal on the first CDP request before closing", async () => {
  const f = await fixture();
  f.attach.mockRejectedValueOnce(
    new BrowserCdpConnectionEnded("This task does not have access to that browser tab."),
  );
  const socket = await f.connect();
  const message = once(socket, "message");
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  expect(JSON.parse(String((await message)[0]))).toEqual({
    id: 1,
    error: { code: -32000, message: "This task does not have access to that browser tab." },
  });
  expect((await closed)[0]).toBe(1008);
});

it.each([
  { count: standardCdpMaxPending + 1, byteSize: 0 },
  { count: 3, byteSize: 6 * 1024 * 1024 },
])("bounds requests on a slow runtime ($count messages)", async ({ count, byteSize }) => {
  const f = await fixture();
  const handedOff = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.send.mockImplementation(async () => {
    handedOff.resolve();
    await gate.promise;
  });
  const socket = await f.connect();
  const closed = once(socket, "close");
  const expression = "x".repeat(byteSize);
  const command = (id: number) =>
    JSON.stringify({ id, method: "Runtime.evaluate", params: { expression } });
  socket.send(command(0));
  await handedOff.promise;
  for (let id = 1; id < count; id++) socket.send(command(id));
  expect((await closed)[0]).toBe(1013);
  gate.resolve();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.runtime.signal.aborted).toBe(true);
});

it("bounds output waiting for an authority check or a slow client", async () => {
  const f = await fixture();
  const socket = await f.connect();
  socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  await f.received.promise;
  const gate = Promise.withResolvers<void>();
  f.reauthorize.mockReturnValue(gate.promise);
  const closed = once(socket, "close");
  const frame = Buffer.from(
    JSON.stringify({ method: "Test.notice", params: { content: "x".repeat(6 * 1024 * 1024) } }),
  );
  for (let index = 0; index < 3; index++) f.emit(frame);
  expect((await closed)[0]).toBe(1013);
  gate.resolve();
});

it("caps queued writes to a client that stops reading", async () => {
  const f = await fixture();
  const socket = await f.connect();
  socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  await f.received.promise;
  const closed = once(socket, "close");
  const ended = Promise.withResolvers<void>();
  f.runtime.signal.addEventListener("abort", () => ended.resolve(), { once: true });
  socket.pause();
  const frame = Buffer.from(
    JSON.stringify({
      method: "Test.notice",
      params: { content: "x".repeat(6 * 1024 * 1024) },
    }),
  );
  for (let index = 0; index < 3; index++) f.emit(frame);
  await ended.promise;
  socket.resume();
  expect((await closed)[0]).toBe(1013);
});

it("refuses a wire message above eight MiB before runtime handoff", async () => {
  const f = await fixture();
  const socket = await f.connect();
  const closed = once(socket, "close");
  socket.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "x".repeat(standardCdpMessageMaxBytes) },
    }),
  );
  expect((await closed)[0]).toBe(1009);
  expect(f.send).not.toHaveBeenCalled();
});

it.each(["runtime", "client", "idle recheck", "event recheck", "expiry"] as const)(
  "ends on %s",
  async (reason) => {
    const f = await fixture();
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const ticket = f.tickets.issue({
      ...claims,
      authority: { ...claims.authority, expiresAt: Date.now() + 20_000 },
    });
    const socket = await f.connect(ticket);
    socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await f.received.promise;
    const closed = once(socket, "close");
    const ended = Promise.withResolvers<void>();
    f.runtime.signal.addEventListener("abort", () => ended.resolve(), { once: true });
    if (reason === "client") socket.close(1000);
    else if (reason === "runtime") f.runtime.abort();
    else if (reason === "expiry") await vi.advanceTimersByTimeAsync(20_000);
    else {
      f.reauthorize.mockRejectedValue(new Error("ended"));
      if (reason === "idle recheck") await vi.advanceTimersByTimeAsync(standardCdpRecheckMs);
      else f.emit(Buffer.from('{ "method": "Runtime.bindingCalled" }'));
    }
    expect((await closed)[0]).toBe(reason === "client" || reason === "runtime" ? 1000 : 1008);
    await ended.promise;
    expect(f.runtime.signal.aborted).toBe(true);
  },
);

it("ends within one authority window even if the store stops responding", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const socket = await f.connect();
  socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  await f.received.promise;
  f.reauthorize.mockReturnValue(new Promise<void>(() => {}));
  const closed = once(socket, "close");
  await vi.advanceTimersByTimeAsync(standardCdpRecheckMs - 1);
  expect(f.runtime.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await closed)[0]).toBe(1008);
  expect(f.runtime.signal.aborted).toBe(true);
});

it("aborts stalled admission while another websocket can attach", async () => {
  const f = await fixture();
  const initial = Promise.withResolvers<AbortSignal>();
  f.attach.mockImplementationOnce(async (_claims, _signal, admission) => {
    if (!admission) throw new Error("Missing admission deadline.");
    initial.resolve(admission);
    return new Promise<never>(() => {});
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const stalled = await f.connect();
  const admission = await initial.promise;
  const refusal = once(stalled, "message");
  const closed = once(stalled, "close");
  stalled.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  const other = await f.connect();
  other.send(JSON.stringify({ id: 2, method: "Browser.getVersion" }));
  await f.received.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(admission.aborted).toBe(true);
  expect(JSON.parse(String((await refusal)[0]))).toEqual({
    id: 1,
    error: { code: -32000, message: "Browser attachment admission timed out." },
  });
  expect((await closed)[0]).toBe(1008);
  expect(other.readyState).toBe(WebSocket.OPEN);
});

it("caps live websocket attachments per binding and bounds a peer that ignores close", async () => {
  const f = await fixture();
  const sockets = await Promise.all([f.connect(), f.connect(), f.connect(), f.connect()]);
  const extra = await f.connect();
  expect((await once(extra, "close"))[0]).toBe(1013);
  expect(f.attach).toHaveBeenCalledTimes(4);
  const blocked = sockets[0]!;
  const closed = once(blocked, "close");
  const serverClosed = Promise.all(
    [...f.app.websocketServer.clients].map((socket) => once(socket, "close")),
  );
  blocked.pause();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  f.runtime.abort();
  await vi.advanceTimersByTimeAsync(1_000);
  await serverClosed;
  blocked.resume();
  expect((await closed)[0]).toBe(1000);
  await expect(f.connect()).resolves.toBeInstanceOf(WebSocket);
});

it("limits a connection's page auto-attach for a runtime of any version, and refuses a nested one", async () => {
  const f = await fixture();
  const socket = await f.connect();
  const replies: Record<string, unknown>[] = [];
  socket.on("message", (data) => replies.push(JSON.parse(String(data)) as Record<string, unknown>));
  socket.send(
    JSON.stringify({
      id: 7,
      method: "Target.sendMessageToTarget",
      params: {
        sessionId: "child",
        message: JSON.stringify({
          id: 1,
          method: "Target.setAutoAttach",
          params: { autoAttach: true, waitForDebuggerOnStart: true },
        }),
      },
      sessionId: "page",
    }),
  );
  socket.send(
    JSON.stringify({
      id: 8,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId: "page",
    }),
  );
  expect(JSON.parse(String(await f.received.promise))).toEqual({
    id: 8,
    method: "Target.setAutoAttach",
    params: {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }],
    },
    sessionId: "page",
  });
  expect(f.send).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(replies).toContainEqual({
      id: 7,
      sessionId: "page",
      error: {
        code: -32000,
        message:
          "A connected agent sends Target.setAutoAttach to the page itself, not inside Target.sendMessageToTarget.",
      },
    }),
  );
});

it("refuses a nested message that is not a JSON string of one command, for a connection and the person's own agent", async () => {
  const shapes = [
    ['{"id":1,"method":"Page.crash","params":{}}'],
    { id: 1, method: "Page.crash", params: {} },
    '{"id":1,"method":',
    '{"id":1,"method":["Page.crash"]}',
  ];
  for (const agentConnectionId of ["external", null]) {
    const f = await fixture();
    const socket = await f.connect(
      f.tickets.issue({ ...claims, facts: { ...claims.facts, agentConnectionId } }),
    );
    const replies: Record<string, unknown>[] = [];
    socket.on("message", (data) =>
      replies.push(JSON.parse(String(data)) as Record<string, unknown>),
    );
    for (const [index, message] of shapes.entries())
      socket.send(
        JSON.stringify({
          id: index + 1,
          method: "Target.sendMessageToTarget",
          params: { sessionId: "child", message },
          sessionId: "page",
        }),
      );
    await vi.waitFor(() => expect(replies).toHaveLength(shapes.length));
    expect(replies).toEqual(
      shapes.map((_, index) => ({
        id: index + 1,
        sessionId: "page",
        error: { code: -32000, message: "Invalid nested CDP message." },
      })),
    );
    expect(f.send, String(agentConnectionId)).not.toHaveBeenCalled();
  }
});
