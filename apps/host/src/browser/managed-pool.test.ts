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
