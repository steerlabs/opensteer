import { connect, createServer as createTcpServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integrationAuthorizationAppReturnBase } from "@opensteer/integration-core";
import {
  IntegrationAuthorizationLoopback,
  integrationAuthorizationLoopbackBodyLimit,
} from "./integration-authorization-loopback.js";

const attemptId = "ioa_00000000-0000-4000-8000-000000000001";
const deploymentId = "dep_00000000-0000-4000-8000-000000000001";
const proof = "P".repeat(43);
const form = `deployment_id=${deploymentId}&attempt_id=${attemptId}&return=${proof}`;
const appReturn = `${integrationAuthorizationAppReturnBase("desktop")}?${form}`;

const open: IntegrationAuthorizationLoopback[] = [];
const squatters: Server[] = [];
const sockets: Socket[] = [];
/** Other checkouts run this suite on the same computer, so tests use ports the system hands out. */
let free: readonly [number, number] = [0, 0];

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No port was assigned.");
  return address.port;
}

beforeEach(async () => {
  free = [await freePort(), await freePort()];
});

function loopback(
  input: {
    accept?: (url: string) => boolean;
    active?: () => boolean;
    pendingUntil?: () => number | null;
    now?: () => number;
    deadlines?: { readonly headers: number; readonly request: number; readonly socket: number };
    ports?: readonly number[];
  } = {},
) {
  const accept = vi.fn(input.accept ?? (() => true));
  const instance = new IntegrationAuthorizationLoopback({
    accept,
    pendingUntil: input.pendingUntil ?? (() => Date.now() + 60_000),
    sessionActive: input.active ?? (() => true),
    ...(input.now ? { now: input.now } : {}),
    ...(input.deadlines ? { deadlines: input.deadlines } : {}),
    ports: input.ports ?? free,
  });
  open.push(instance);
  return { accept, instance };
}

interface Reply {
  readonly status: number;
  readonly headers: string;
  readonly body: string;
}

function raw(port: number, request: string): Promise<Reply> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    sockets.push(socket);
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      const [head = "", ...body] = data.split("\r\n\r\n");
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/u.exec(head)?.[1] ?? 0),
        headers: head.toLowerCase(),
        body: body.join("\r\n\r\n"),
      });
    });
    socket.write(request);
  });
}

function post(
  port: number,
  overrides: {
    body?: string;
    contentType?: string | null;
    host?: string;
    method?: string;
    path?: string;
  } = {},
): Promise<Reply> {
  const body = overrides.body ?? form;
  const contentType = overrides.contentType;
  const headers = [
    `${overrides.method ?? "POST"} ${overrides.path ?? "/oauth/integration-callback"} HTTP/1.1`,
    `Host: ${overrides.host ?? `127.0.0.1:${port}`}`,
    ...(contentType === null
      ? []
      : [`Content-Type: ${contentType ?? "application/x-www-form-urlencoded"}`]),
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: keep-alive",
  ];
  return raw(port, `${headers.join("\r\n")}\r\n\r\n${body}`);
}

/** Resolves when the server has closed this socket, within a deadline well inside the test's. */
function closedWithin(socket: Socket, milliseconds: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`${what} was never closed`)), milliseconds);
    socket.once("close", () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

function connected(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => resolve(socket));
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.once("error", reject);
  });
}

async function refused(port: number): Promise<boolean> {
  return connected(port).then(
    (socket) => {
      socket.destroy();
      return false;
    },
    () => true,
  );
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const instance of open.splice(0)) await instance.close();
  for (const server of squatters.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.useRealTimers();
});

describe("IntegrationAuthorizationLoopback binding", () => {
  it("binds the reserved block by default", async () => {
    const instance = new IntegrationAuthorizationLoopback({
      accept: () => false,
      pendingUntil: () => null,
      sessionActive: () => true,
    });
    open.push(instance);
    const port = await instance.prepare();
    expect(port).toBeGreaterThanOrEqual(48_200);
    expect(port).toBeLessThanOrEqual(48_215);
  });

  it("listens only on 127.0.0.1 and reuses one server", async () => {
    const { instance } = loopback();
    const port = await instance.prepare();
    expect(port).toBe(free[0]);
    expect(await instance.prepare()).toBe(port);
    expect(await Promise.all([instance.prepare(), instance.prepare()])).toEqual([port, port]);
  });

  it("takes the next port when one is in use, and offers none when all are", async () => {
    const squatter = createTcpServer();
    squatters.push(squatter);
    await new Promise<void>((resolve) => squatter.listen(free[0], "127.0.0.1", () => resolve()));
    const { instance } = loopback();
    expect(await instance.prepare()).toBe(free[1]);
    await instance.close();
    const { instance: blocked } = loopback({ ports: [free[0]] });
    expect(await blocked.prepare()).toBeNull();
  });
});

describe("IntegrationAuthorizationLoopback requests", () => {
  it("rebuilds the strict app return from the form and sends it to the existing path", async () => {
    const { accept, instance } = loopback();
    const port = (await instance.prepare())!;
    const reply = await post(port);
    expect(reply.status).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(appReturn);
    expect(reply.body).toContain("Continue in Opensteer");
    expect(reply.body).not.toContain(proof);
    expect(reply.body).not.toContain(attemptId);
  });

  it("answers an unknown attempt the same as anything else it refuses", async () => {
    const { accept, instance } = loopback({ accept: () => false });
    const port = (await instance.prepare())!;
    const unknown = await post(port);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(unknown.status).toBe(404);
    expect(unknown.body).not.toContain(proof);
    expect((await post(port, { path: "/elsewhere" })).body).toBe(unknown.body);
  });

  it.each([
    ["a rebinding Host", (port: number) => ({ host: `evil.example:${port}` })],
    ["localhost", (port: number) => ({ host: `localhost:${port}` })],
    ["another port", (port: number) => ({ host: `127.0.0.1:${port + 1}` })],
    ["a wrong path", () => ({ path: "/oauth/integration-callback/x" })],
    ["a query on the path", () => ({ path: `/oauth/integration-callback?return=${proof}` })],
    ["GET", () => ({ method: "GET", body: "" })],
    ["HEAD", () => ({ method: "HEAD", body: "" })],
    ["OPTIONS", () => ({ method: "OPTIONS", body: "" })],
    ["PUT", () => ({ method: "PUT" })],
    ["another content type", () => ({ contentType: "text/plain" })],
    ["no content type", () => ({ contentType: null })],
    ["a body without a proof", () => ({ body: `deployment_id=d&attempt_id=a` })],
  ] as const)("never reaches accept for %s", async (_label, overrides) => {
    const { accept, instance } = loopback();
    const port = (await instance.prepare())!;
    const reply = await post(port, overrides(port));
    expect(accept).not.toHaveBeenCalled();
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain(proof);
  });

  it("drops an oversized body without reading the rest of it", async () => {
    const { accept, instance } = loopback();
    const port = (await instance.prepare())!;
    const reply = await post(port, {
      body: `${form}&x=${"x".repeat(integrationAuthorizationLoopbackBodyLimit)}`,
    });
    expect(accept).not.toHaveBeenCalled();
    expect(reply.status).toBe(0);
  });

  it("refuses a chunked body it cannot bound in advance", async () => {
    const { accept, instance } = loopback();
    const port = (await instance.prepare())!;
    const reply = await raw(
      port,
      `POST /oauth/integration-callback HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/x-www-form-urlencoded\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`,
    );
    expect(reply.status).toBe(404);
    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses over-long headers and a second request on the same socket", async () => {
    const { accept, instance } = loopback();
    const port = (await instance.prepare())!;
    const long = await raw(
      port,
      `POST /oauth/integration-callback HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Pad: ${"p".repeat(32_000)}\r\n\r\n`,
    );
    expect(long.status === 431 || long.status === 0).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    const request = `POST /oauth/integration-callback HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${form.length}\r\n\r\n${form}`;
    await raw(port, `${request}${request}`);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("sends no reflected input and a closed-down response on both outcomes", async () => {
    const { instance } = loopback({ accept: (url) => url.length < 0 });
    const port = (await instance.prepare())!;
    for (const reply of [await post(port), await post(port, { path: "/<script>alert(1)</script>" })]) {
      expect(reply.headers).toContain("referrer-policy: no-referrer");
      expect(reply.headers).toContain("cache-control: no-store");
      expect(reply.headers).toContain("connection: close");
      expect(reply.headers).toContain("content-security-policy: default-src 'none'");
      expect(reply.body).not.toContain("alert(1)");
      expect(reply.body).not.toMatch(/\b(?:src|href)="/u);
      expect(reply.body).not.toContain("<link");
    }
  });
});

describe("IntegrationAuthorizationLoopback deadlines", () => {
  const deadlines = { headers: 200, request: 400, socket: 300 };

  it("destroys a socket that never sends anything", async () => {
    const { instance } = loopback({ deadlines });
    const socket = await connected((await instance.prepare())!);
    await closedWithin(socket, 2_000, "An idle socket");
  });

  it("holds a socket to its own idle deadline, shorter than the request's", async () => {
    const { instance } = loopback({ deadlines: { headers: 5_000, request: 5_000, socket: 100 } });
    const socket = await connected((await instance.prepare())!);
    await closedWithin(socket, 1_000, "An idle socket");
  });

  it("destroys a socket that drips its headers", async () => {
    const { accept, instance } = loopback({ deadlines });
    const port = (await instance.prepare())!;
    const socket = await connected(port);
    socket.write("POST /oauth/integration-callback HTTP/1.1\r\n");
    const drip = setInterval(() => socket.write("X-Drip: 1\r\n"), 50);
    try {
      await closedWithin(socket, 2_000, "A slow-header socket");
    } finally {
      clearInterval(drip);
    }
    expect(accept).not.toHaveBeenCalled();
  });

  it("destroys a socket that never finishes its body", async () => {
    const { accept, instance } = loopback({ deadlines });
    const port = (await instance.prepare())!;
    const socket = await connected(port);
    socket.write(
      `POST /oauth/integration-callback HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 200\r\n\r\nabc`,
    );
    await closedWithin(socket, 2_000, "A slow-body socket");
    expect(accept).not.toHaveBeenCalled();
  });

  it("drops connections past the cap", async () => {
    const { instance } = loopback();
    const port = (await instance.prepare())!;
    const held = await Promise.all(Array.from({ length: 8 }, () => connected(port)));
    const over = await connected(port);
    await closedWithin(over, 2_000, "A connection over the cap");
    expect(held.every((socket) => !socket.destroyed)).toBe(true);
  });
});

describe("IntegrationAuthorizationLoopback login session", () => {
  it("refuses to prepare while another login session is at the console", async () => {
    const { instance } = loopback({ active: () => false });
    expect(await instance.prepare()).toBeNull();
  });

  it("closes the listener and a request in progress when the session resigns", async () => {
    const { accept, instance } = loopback();
    const port = (await instance.prepare())!;
    const socket = await connected(port);
    socket.write("POST /oauth/integration-callback HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    await vi.waitFor(() => expect(socket.bytesWritten).toBeGreaterThan(0), { timeout: 500 });
    const closed = closedWithin(socket, 500, "A request in progress");
    await instance.sessionChanged(false);
    await closed;
    expect(await refused(port)).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });

  it("gives up a port it finished binding after the session resigned", async () => {
    const active = vi.fn(() => true).mockReturnValueOnce(true).mockReturnValue(false);
    const { instance } = loopback({ active });
    expect(await instance.prepare()).toBeNull();
    expect(await refused(free[0])).toBe(true);
  });

  it("never accepts a request that is already in flight once the session has gone", async () => {
    let active = true;
    const { accept, instance } = loopback({ active: () => active });
    const port = (await instance.prepare())!;
    active = false;
    const reply = await post(port);
    expect(accept).not.toHaveBeenCalled();
    expect(reply.status).toBe(404);
  });

  it("recovers the same port for pending attempts when the session returns", async () => {
    let active = true;
    const { accept, instance } = loopback({ active: () => active });
    const port = (await instance.prepare())!;
    active = false;
    await instance.sessionChanged(false);
    active = true;
    await instance.sessionChanged(true);
    expect((await post(port)).status).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("leaves pending attempts to a fresh retry when the port was taken meanwhile", async () => {
    let active = true;
    const { accept, instance } = loopback({ active: () => active });
    const port = (await instance.prepare())!;
    active = false;
    await instance.sessionChanged(false);
    const squatter = createTcpServer();
    squatters.push(squatter);
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", () => resolve()));
    active = true;
    await instance.sessionChanged(true);
    expect(accept).not.toHaveBeenCalled();
    expect(await instance.prepare()).not.toBe(port);
  });

  it("stays closed when the session returns with nothing pending", async () => {
    let active = true;
    let pending: number | null = Date.now() + 60_000;
    const { instance } = loopback({ active: () => active, pendingUntil: () => pending });
    const port = (await instance.prepare())!;
    active = false;
    await instance.sessionChanged(false);
    pending = null;
    active = true;
    await instance.sessionChanged(true);
    expect(await refused(port)).toBe(true);
  });
});

describe("IntegrationAuthorizationLoopback lifetime", () => {
  it("closes after the grace when preparation never registers an attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { instance } = loopback({ pendingUntil: () => null });
    const port = (await instance.prepare())!;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await refused(port)).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await refused(port)).toBe(true);
  });

  it("keeps a registered attempt's listener past the grace and closes it at expiry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const expiry = Date.now() + 10 * 60_000;
    const { accept, instance } = loopback({
      pendingUntil: () => (Date.now() < expiry ? expiry : null),
    });
    const port = (await instance.prepare())!;
    instance.registered();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect((await post(port)).status).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await refused(port)).toBe(true);
  });

  it("closes as soon as the last attempt ends, without waiting out a spent grace", async () => {
    let pending: number | null = Date.now() + 60_000;
    const { instance } = loopback({ pendingUntil: () => pending });
    const port = (await instance.prepare())!;
    instance.registered();
    pending = null;
    instance.sync();
    expect(await refused(port)).toBe(true);
  });

  it("stays open for a second preparation that has not registered yet", async () => {
    let pending: number | null = Date.now() + 60_000;
    const { instance } = loopback({ pendingUntil: () => pending });
    const port = (await instance.prepare())!;
    await instance.prepare();
    instance.registered();
    pending = null;
    instance.sync();
    expect(await refused(port)).toBe(false);
  });
});
