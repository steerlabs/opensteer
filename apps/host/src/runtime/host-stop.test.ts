import { processStopTimeoutMs } from "@opensteer/shared/processControl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostStopper, stopHost, stopHostOnAuthorityLoss } from "./host-stop.js";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

function fixture(close: () => Promise<void>) {
  const log = { error: vi.fn(), fatal: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const exit = vi.fn();
  const runtime = { app: { log }, close, closingStep: () => "HTTP server" };
  const host = runtime as unknown as Parameters<typeof stopHost>[0];
  return {
    exit,
    log,
    stop: () => stopHost(host, "SIGTERM", exit),
    lose: () => stopHostOnAuthorityLoss(host, new Error("session ended"), exit),
  };
}

it("exits once closed, so a leftover handle cannot hold the process until it is killed", async () => {
  const { exit, stop } = fixture(() => Promise.resolve());
  await stop();
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("names the stuck step before the supervisor's kill", async () => {
  const { exit, log, stop } = fixture(() => new Promise(() => undefined));
  void stop();
  await vi.advanceTimersByTimeAsync(processStopTimeoutMs - 1);
  expect(log.warn).toHaveBeenCalledWith(
    { step: "HTTP server" },
    "Opensteer Host still shutting down",
  );
  expect(exit).not.toHaveBeenCalled();
});

it("reports a failed close and exits non-zero", async () => {
  const failure = new Error("database refused");
  const { exit, log, stop } = fixture(() => Promise.reject(failure));
  await stop();
  expect(log.error).toHaveBeenCalledWith(
    { err: failure, step: "HTTP server" },
    "Opensteer Host did not close cleanly",
  );
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});

it("exits non-zero after losing the Deployment lock, even when it closes cleanly", async () => {
  const { exit, lose } = fixture(() => Promise.resolve());
  await lose();
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not let a close step hung on the lost database keep an unfenced Host alive", async () => {
  const { exit, lose } = fixture(() => new Promise(() => undefined));
  void lose();
  await vi.advanceTimersByTimeAsync(processStopTimeoutMs);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});

it("still exits non-zero when the lock is lost during a shutdown that hangs", async () => {
  const { exit, log } = fixture(() => new Promise(() => undefined));
  const runtime = {
    app: { log },
    close: () => new Promise<void>(() => undefined),
    closingStep: () => "HTTP server",
  };
  const stopper = hostStopper(runtime as unknown as Parameters<typeof stopHost>[0], exit);
  stopper.signal("SIGTERM");
  stopper.authorityLost(new Error("session ended"));
  await vi.advanceTimersByTimeAsync(processStopTimeoutMs);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(log.fatal).toHaveBeenCalledOnce();
});

it("fails the exit when the lock is lost during a shutdown that then finishes", async () => {
  let finish!: () => void;
  const { exit, log } = fixture(() => Promise.resolve());
  const runtime = {
    app: { log },
    close: () => new Promise<void>((resolve) => (finish = resolve)),
    closingStep: () => "HTTP server",
  };
  const stopper = hostStopper(runtime as unknown as Parameters<typeof stopHost>[0], exit);
  stopper.signal("SIGTERM");
  stopper.authorityLost(new Error("session ended"));
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});
