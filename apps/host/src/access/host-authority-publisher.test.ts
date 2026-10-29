import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostAuthorityPublisher } from "./host-authority-publisher.js";

describe("HostAuthorityPublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles ready only once the Account has accepted the identity", async () => {
    const publish = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("control plane unreachable"))
      .mockResolvedValue(undefined);
    const publisher = new HostAuthorityPublisher({ baseDelayMs: 1_000, onError: vi.fn(), publish });
    let ready = false;
    void publisher.ready().then(() => {
      ready = true;
    });

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(ready).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(ready).toBe(true);

    await publisher.close();
  });

  it("retries with exponential backoff until the Account accepts the identity", async () => {
    const onError = vi.fn();
    const publish = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("control plane unreachable"))
      .mockRejectedValueOnce(new Error("control plane unreachable"))
      .mockResolvedValue(undefined);
    const publisher = new HostAuthorityPublisher({ baseDelayMs: 5_000, onError, publish });

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);

    await publisher.close();
  });

  it("caps the retry delay", async () => {
    const publish = vi.fn(async () => {
      throw new Error("control plane unreachable");
    });
    const publisher = new HostAuthorityPublisher({
      baseDelayMs: 1_000,
      maximumDelayMs: 4_000,
      onError: vi.fn(),
      publish,
    });

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    // 1s, 2s, 4s, then the cap holds every later delay at 4s.
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(publish).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(publish).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(publish).toHaveBeenCalledTimes(6);

    await publisher.close();
  });

  it("stops retrying once closed", async () => {
    const publish = vi.fn(async () => {
      throw new Error("control plane unreachable");
    });
    const publisher = new HostAuthorityPublisher({ baseDelayMs: 5_000, onError: vi.fn(), publish });

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(1);

    await publisher.close();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("redacts the Host credential out of reported failures", async () => {
    const onError = vi.fn();
    const publisher = new HostAuthorityPublisher({
      baseDelayMs: 5_000,
      onError,
      publish: async () => {
        throw new Error(`rejected Bearer osc_${"a".repeat(43)} for osc_${"b".repeat(43)}`);
      },
    });

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    const reported: unknown = onError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    const message = reported instanceof Error ? reported.message : "";
    expect(message).toBe("rejected Bearer [redacted] for [redacted]");
    expect(message).not.toMatch(/osc_/u);

    await publisher.close();
  });
});
