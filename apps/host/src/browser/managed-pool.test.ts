import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import { PoolRelayRefused } from "@opensteer/shared/poolRelay";
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
