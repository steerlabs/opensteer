import net from "node:net";
import { startEchoTestServer } from "@opensteer/shared/test-support/tcpServer";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import {
  Direction,
  RequestLines,
  startShapingProxy,
  type RequestLine,
} from "./proxy.test-support.js";

it("parses fragmented persistent requests without retaining query values, headers or body lookalikes", () => {
  const lines: Omit<RequestLine, "atMs" | "connection">[] = [];
  const parser = new RequestLines((line) => lines.push(line));
  const body = "GET /body-secret HTTP/1.1\r\n\r\n";
  const requests = `POST /v1/rpc/commands.dispatch?input=secret HTTP/1.1\r\nAuthorization: secret\r\nContent-Length: ${body.length}\r\n\r\n${body}GET /v1/realtime?credential=secret HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nGET /frame-secret HTTP/1.1\r\n\r\n`;
  for (const byte of Buffer.from(requests)) parser.accept(Buffer.from([byte]));
  expect(lines).toEqual([
    { method: "POST", path: "/v1/rpc/commands.dispatch", upgrade: false },
    { method: "GET", path: "/v1/realtime", upgrade: true },
  ]);
  expect(JSON.stringify(lines)).not.toContain("secret");
});

it("delivers ordered bytes through both shaped directions and accounts for each connection", async ({
  onTestFinished,
}) => {
  const target = await startEchoTestServer();
  let proxy: Awaited<ReturnType<typeof startShapingProxy>> | undefined;
  const clients: net.Socket[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const client of clients) client.destroy();
      try {
        await proxy?.close();
      } finally {
        await target.close();
      }
    })());
  onTestFinished(close);
  try {
    proxy = await startShapingProxy(new URL(`http://127.0.0.1:${target.port}`), {
      latencyUpMs: 2,
      latencyDownMs: 3,
      upBps: 10_000_000,
      downBps: 10_000_000,
      stall: { everyChunks: 2, delayMs: 1 },
    });
    const payload = Buffer.from(
      `POST /bench?token=secret HTTP/1.1\r\nContent-Length: 100000\r\n\r\n${"x".repeat(100000)}`,
    );
    for (let index = 0; index < 2; index++) {
      const socket = net.connect(Number(new URL(proxy.origin).port), "127.0.0.1");
      clients.push(socket);
      socket.on("error", () => undefined);
      await once(socket, "connect");
      const received: Buffer[] = [];
      const complete = new Promise<Buffer>((resolve) =>
        socket.on("data", (chunk: Buffer) => {
          received.push(chunk);
          if (received.reduce((sum, part) => sum + part.length, 0) === payload.length)
            resolve(Buffer.concat(received));
        }),
      );
      socket.write(payload);
      expect(await complete).toEqual(payload);
    }
    expect(proxy.connections).toHaveLength(2);
    for (const record of proxy.connections)
      expect(record).toMatchObject({ bytesUp: payload.length, bytesDown: payload.length });
    expect(proxy.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/bench" },
      { method: "POST", path: "/bench" },
    ]);
    const closed = clients.map((socket) => once(socket, "close"));
    proxy.dropConnections();
    await Promise.all(closed);
  } finally {
    await close();
  }
});

it("shares bandwidth across sockets, pipelines propagation, stalls deterministically and cancels queued delivery", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const direction = new Direction(8_000, 100, { everyChunks: 2, delayMs: 50 });
  try {
    const received: { atMs: number; value: string }[] = [];
    const source = () => ({ destroyed: false, pause: vi.fn(), resume: vi.fn() });
    const first = source(),
      second = source();
    const target = {
      destroyed: false,
      write: (chunk: Buffer) => {
        received.push({ atMs: performance.now(), value: chunk.toString()[0]! });
        return true;
      },
    } as unknown as net.Socket;
    direction.send(
      first as unknown as net.Socket,
      target,
      Buffer.alloc(1_000, "a"),
      () => undefined,
    );
    direction.send(
      second as unknown as net.Socket,
      target,
      Buffer.alloc(1_000, "b"),
      () => undefined,
    );
    vi.advanceTimersByTime(2_150);
    expect(received).toEqual([
      { atMs: 1_100, value: "a" },
      { atMs: 2_150, value: "b" },
    ]);
    expect(first.pause).not.toHaveBeenCalled();
    expect(second.pause).not.toHaveBeenCalled();
    direction.send(
      first as unknown as net.Socket,
      target,
      Buffer.alloc(1_000, "c"),
      () => undefined,
    );
    direction.close();
    vi.advanceTimersByTime(10_000);
    expect(received).toHaveLength(2);
  } finally {
    direction.close();
    vi.useRealTimers();
  }
});

it("preserves TCP order when propagation timers become ready out of order", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // performance.now can advance within one poll batch while libuv's timer base
  // stays fixed: the later chunk then has a shorter relative propagation wait.
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(2);
  const direction = new Direction(8_000, 100, undefined);
  try {
    const received: string[] = [];
    const source = { destroyed: false, pause: vi.fn(), resume: vi.fn() } as unknown as net.Socket;
    const target = {
      destroyed: false,
      write: (chunk: Buffer) => {
        received.push(chunk.toString()[0]!);
        return true;
      },
    } as unknown as net.Socket;
    direction.send(source, target, Buffer.alloc(1_000, "a"), () => undefined);
    direction.send(source, target, Buffer.from("b"), () => undefined);
    vi.advanceTimersByTime(1_100);
    expect(received).toEqual(["a", "b"]);
  } finally {
    direction.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
