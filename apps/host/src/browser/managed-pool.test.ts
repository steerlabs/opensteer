import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import { PoolRelayRefused } from "@opensteer/shared/poolRelay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import { RelayBrowserPoolRuntimeChannel } from "./managed-pool.js";

type Transport = ConstructorParameters<typeof RelayBrowserPoolRuntimeChannel>[0];

it("opens no tunnel once its signal fired while it waited to try again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const opened = vi.fn(async () => {
      throw new PoolRelayRefused("unavailable", "The runtime is starting.");
    });
    const channel = new RelayBrowserPoolRuntimeChannel({ open: opened } as unknown as Transport);
    const abort = new AbortController();
    const reading = channel.poolState(abort.signal);
    void reading.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toHaveBeenCalledTimes(1);
    // The step ends while the channel waits before its next try.
    abort.abort(new Error("The step ended."));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(reading).rejects.toThrow();
    expect(opened).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("gives up a runtime control whose answer never comes, within its bound", async () => {
  // A tunnel that takes the request and never answers it.
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const channel = new RelayBrowserPoolRuntimeChannel(
    { open: async () => ({ socket, bridgeToken: "token" }) } as unknown as Transport,
    undefined,
    { controlTimeoutMs: 200 },
  );
  const started = Date.now();
  await expect(
    channel.controlPool({ kind: "retire" } as never, new Uint8Array(64)),
  ).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("reuses one keep-alive tunnel across a wake and never retries a failed control POST", async () => {
  let requests = 0;
  let dropNextPost = false;
  const server = createHttpServer((req, res) => {
    requests++;
    if (dropNextPost && req.method === "POST") {
      req.socket.destroy();
      return;
    }
    const body = JSON.stringify({ state: { phase: "running" } });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      connection: "keep-alive",
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const sockets: ReturnType<typeof createConnection>[] = [];
  let opens = 0;
  const transport = {
    open: async () => {
      opens++;
      const socket = createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      // Mirror `openPoolRelay`'s `readLine`, which leaves the tunnel paused for the next reader.
      socket.pause();
      sockets.push(socket);
      return { socket, bridgeToken: "wake-token" };
    },
  } as unknown as Transport;
  try {
    const channel = new RelayBrowserPoolRuntimeChannel(transport);
    const endWake = channel.beginWake();
    try {
      expect(await channel.poolState()).toEqual({ phase: "running" });
      expect(await channel.controlPool({ kind: "adopt" } as never, new Uint8Array(64))).toEqual({
        phase: "running",
      });
      expect(await channel.controlPool({ kind: "complete" } as never, new Uint8Array(64))).toEqual({
        phase: "running",
      });
      expect(opens).toBe(1);
      expect(requests).toBe(3);

      // Rule 4: a control POST whose reused tunnel drops mid-flight is never retried.
      dropNextPost = true;
      await expect(
        channel.controlPool({ kind: "complete" } as never, new Uint8Array(64)),
      ).rejects.toThrow();
      expect(opens).toBe(1);
      expect(requests).toBe(4);
    } finally {
      endWake();
    }
    expect(sockets.every((s) => s.destroyed)).toBe(true);
  } finally {
    server.close();
  }
});

it("answers a recovery state read on a fresh tunnel while a control POST stalls, without crashing", async () => {
  const stalledResponses: { destroy: () => void }[] = [];
  let postSeen!: () => void;
  const postArrived = new Promise<void>((resolve) => {
    postSeen = resolve;
  });
  const server = createHttpServer((req, res) => {
    if (req.method === "POST") {
      stalledResponses.push(req.socket);
      postSeen();
      return;
    }
    const body = JSON.stringify({ state: { phase: "running" } });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      connection: "close",
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const sockets: ReturnType<typeof createConnection>[] = [];
  let opens = 0;
  const transport = {
    open: async () => {
      opens++;
      const socket = createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.pause();
      sockets.push(socket);
      return { socket, bridgeToken: "wake-token" };
    },
  } as unknown as Transport;
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  try {
    const channel = new RelayBrowserPoolRuntimeChannel(transport, undefined, {
      controlTimeoutMs: 250,
    });
    const endWake = channel.beginWake();
    try {
      const stalledPost = channel.controlPool({ kind: "adopt" } as never, new Uint8Array(64));
      await withTimeout(postArrived, 2_000, {
        timeoutError: () => new Error("stalled POST did not reach the test server"),
      });
      // Recovery state read arrives while the control POST is still open on the kept tunnel:
      // it must answer on its own fresh tunnel within its own bound instead of queuing behind POST.
      expect(await channel.poolState(AbortSignal.timeout(1_000))).toEqual({ phase: "running" });
      expect(opens).toBe(2);
      await expect(stalledPost).rejects.toThrow();
    } finally {
      endWake();
    }
    expect(uncaught).toEqual([]);
    expect(unhandled).toEqual([]);
    expect(sockets.every((s) => s.destroyed)).toBe(true);
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
    for (const socket of stalledResponses) socket.destroy();
    server.close();
  }
});

it("settles cleanly without uncaught errors when a wake ends while a control request is outstanding", async () => {
  const stalledSockets: { destroy: () => void }[] = [];
  let postSeen!: () => void;
  const postArrived = new Promise<void>((resolve) => {
    postSeen = resolve;
  });
  const server = createHttpServer((req, _res) => {
    stalledSockets.push(req.socket);
    if (req.method === "POST") postSeen();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const sockets: ReturnType<typeof createConnection>[] = [];
  const transport = {
    open: async () => {
      const socket = createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.pause();
      sockets.push(socket);
      return { socket, bridgeToken: "wake-token" };
    },
  } as unknown as Transport;
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  try {
    const channel = new RelayBrowserPoolRuntimeChannel(transport, undefined, {
      controlTimeoutMs: 5_000,
    });
    const endWake = channel.beginWake();
    const stalledPost = channel.controlPool({ kind: "complete" } as never, new Uint8Array(64));
    await withTimeout(postArrived, 2_000, {
      timeoutError: () => new Error("stalled POST did not reach the test server"),
    });
    const stalledRead = channel.poolState(AbortSignal.timeout(500));
    const started = Date.now();
    endWake();
    await expect(stalledPost).rejects.toThrow();
    await expect(stalledRead).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(uncaught).toEqual([]);
    expect(unhandled).toEqual([]);
    expect(sockets.every((s) => s.destroyed)).toBe(true);
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
    for (const socket of stalledSockets) socket.destroy();
    server.close();
  }
});
